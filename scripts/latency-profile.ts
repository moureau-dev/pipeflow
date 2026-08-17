// LLM latency profile: repeated runs of the same prompts, reporting
// p50/p90/p95 (p95 matters most for voice: an amazing 90% with a 3s tail
// feels inconsistent). Also probes whether the provider streams reasoning
// tokens before content — which would make "first delta" include hidden
// thinking time.
//
//   bun scripts/latency-profile.ts
//
// Uses OPENROUTER_API_KEY (default model google/gemini-2.5-flash-lite) when
// present, else DEEPSEEK_API_KEY. Overrides: LLM_MODEL, RUNS (default 20).

import { OpenRouterLLM } from "../src/providers/llm/adapters/openrouter/openrouter";
import { DeepSeekLLM } from "../src/providers/llm/adapters/deepseek/deepseek";
import { delegateToolDefinition } from "../src/conversations/orchestration/coordination/coordination";
import type {
  LLM,
  LLMRequest,
  LLMToolDefinition,
  LLMStreamTimingPoint,
} from "../src/providers/llm/types";

const openRouterKey = process.env.OPENROUTER_API_KEY;
const deepSeekKey = process.env.DEEPSEEK_API_KEY;
if (!openRouterKey && !deepSeekKey) {
  console.error("OPENROUTER_API_KEY or DEEPSEEK_API_KEY is required");
  process.exit(1);
}

const RUNS = Number(process.env.RUNS ?? 20);
const MODEL = process.env.LLM_MODEL ?? "google/gemini-2.5-flash-lite";
const LABEL = openRouterKey ? `openrouter/${MODEL}` : `deepseek/deepseek-v4-flash`;
const PROMPT =
  "Book me a flight from Paris to London tomorrow morning, and check whether Tuesday afternoon is free.";

function makeLlm(): LLM {
  const onTiming = (point: LLMStreamTimingPoint) => {
    if (currentRun !== null) currentRun[point] = performance.now() - currentRunStart;
  };
  if (openRouterKey) {
    return new OpenRouterLLM({ apiKey: openRouterKey, model: MODEL, onTiming });
  }
  return new DeepSeekLLM({ apiKey: deepSeekKey!, model: "deepseek-v4-flash", onTiming });
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const COORDINATOR_PROMPT = `You are the conversation coordinator. The available agents are:
- Travel Agent (aliases: travel)
- Calendar Agent (aliases: calendar)

Decide the best next step and take exactly one: delegate to one or more agents, pass the work to another coordination, ask the user a clarifying question when the request is ambiguous or missing critical information, or answer directly when you have everything you need.`;

const delegateTool: LLMToolDefinition = {
  name: "delegate",
  description: "Choose the next execution target.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["agents", "coordination", "user", "complete"],
      },
      tasks: {
        type: "array",
        items: {
          type: "object",
          properties: { agent: { type: "string" }, prompt: { type: "string" } },
        },
      },
      coordination: { type: "string" },
      question: { type: "string" },
      output: { type: "string" },
    },
    required: ["action"],
  },
};

const getWeather: LLMToolDefinition = {
  name: "get_weather",
  description: "Get the current weather for a city.",
  parameters: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
};

// The real delegate schema (roster-free) plus a conversation-shaped history,
// approximating what the e2e coordination path actually sends.
const REAL_DELEGATE = delegateToolDefinition([], []);
const HISTORY_TURNS: Array<{ role: "user" | "assistant"; content: string }> = [
  { role: "user", content: "Good morning! Can you help me plan a business trip?" },
  { role: "assistant", content: "Of course. Where are you traveling from, and what's the destination?" },
  { role: "user", content: "From Paris. I need to be in London for a client meeting." },
  { role: "assistant", content: "Got it — Paris to London. Do you have preferred dates or airlines?" },
  { role: "user", content: "No preference on airline, but I need to be there early in the day." },
  { role: "assistant", content: "I'll look for a morning arrival. Anything else, like a return flight?" },
  { role: "user", content: "Not yet — I also have a team sync I want to move. Can you check my calendar?" },
  { role: "assistant", content: "Happy to. Which day should I check, and who's in the meeting?" },
];
function realisticHistory(targetChars: number): Array<{ role: "user" | "assistant"; content: string }> {
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  let chars = COORDINATOR_PROMPT.length;
  let i = 0;
  while (chars < targetChars) {
    const turn = HISTORY_TURNS[i % HISTORY_TURNS.length]!;
    messages.push(turn);
    chars += turn.content.length;
    i++;
  }
  messages.push({ role: "user", content: PROMPT });
  return messages;
}

const scenarios: Array<{
  name: string;
  build: () => LLMRequest;
  diagnostics: () => string;
}> = [
  {
    name: "normal",
    build: () => ({
      messages: [
        { role: "system", content: "You are a concise, helpful assistant." },
        { role: "user", content: PROMPT },
      ],
    }),
    diagnostics: () => `2 messages, ${PROMPT.length} chars, no tools`,
  },
  {
    name: "coordination",
    build: () => ({
      messages: [
        { role: "system", content: COORDINATOR_PROMPT },
        { role: "user", content: PROMPT },
      ],
      tools: [delegateTool],
    }),
    diagnostics: () =>
      `2 messages, ${COORDINATOR_PROMPT.length + PROMPT.length} chars, 1 tool (delegate schema)`,
  },
  {
    name: "tool call",
    build: () => ({
      messages: [
        {
          role: "system",
          content:
            "You are a weather assistant. Always use the get_weather tool to answer, calling it once per city.",
        },
        { role: "user", content: "What is the weather in Paris and Tokyo?" },
      ],
      tools: [getWeather],
    }),
    diagnostics: () => "2 messages, ~180 chars, 1 tool (get_weather)",
  },
  {
    name: "coordination realistic",
    build: () => ({
      messages: [
        { role: "system", content: COORDINATOR_PROMPT },
        ...realisticHistory(8_000),
      ],
      tools: [REAL_DELEGATE],
    }),
    diagnostics: () =>
      `~8KB history, real delegate schema (${JSON.stringify(REAL_DELEGATE.parameters).length} bytes)`,
  },
];

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

interface Run {
  "request-start"?: number;
  headers?: number;
  "first-chunk"?: number;
  firstDelta?: number;
  toolCall?: number;
  done?: number;
}

// The in-flight run receives provider-timeline points from the adapter's
// `onTiming` hook (runs are sequential, so a single slot suffices).
let currentRun: Run | null = null;
let currentRunStart = 0;

async function runOnce(llm: LLM, request: LLMRequest): Promise<Run> {
  const start = performance.now();
  const run: Run = {};
  currentRun = run;
  currentRunStart = start;
  try {
    for await (const event of llm.stream(request)) {
      const at = performance.now() - start;
      if (event.type === "delta" && run.firstDelta === undefined) {
        run.firstDelta = at;
      } else if (event.type === "tool_call" && run.toolCall === undefined) {
        run.toolCall = at;
      } else if (event.type === "done") {
        run.done = at;
      }
    }
  } finally {
    currentRun = null;
  }
  return run;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)));
  return sorted[index]!;
}

function fmt(ms: number): string {
  return Number.isFinite(ms) ? `${Math.round(ms)}ms` : "—";
}

function report(
  label: string,
  values: (number | undefined)[],
  outliers: number[],
  outlierThresholdMs: number,
): void {
  const present = values.filter((v): v is number => v !== undefined).sort((a, b) => a - b);
  if (present.length === 0) {
    console.log(`${label.padEnd(12)} —`);
    return;
  }
  const row = `${fmt(percentile(present, 0.5)).padStart(8)} ${fmt(
    percentile(present, 0.9),
  ).padStart(8)} ${fmt(percentile(present, 0.95)).padStart(8)} ${fmt(
    present[0]!,
  ).padStart(8)} ${fmt(present.at(-1)!).padStart(8)}`;
  const flag =
    outliers.length > 0
      ? `  ⚠ runs ${outliers.join(", ")} exceeded ${outlierThresholdMs}ms`
      : "";
  console.log(`${label.padEnd(12)} ${row}${flag}`);
}

// ---------------------------------------------------------------------------
// Raw probe: does the provider stream reasoning tokens before content?
// ---------------------------------------------------------------------------

async function probeThinking(): Promise<void> {
  const apiKey = openRouterKey;
  const baseUrl = apiKey ? "https://openrouter.ai/api/v1" : "https://api.deepseek.com";
  if (!apiKey) return;
  const start = performance.now();
  let firstChunkAt: number | undefined;
  let firstReasoningAt: number | undefined;
  let firstContentAt: number | undefined;
  let reasoningChars = 0;
  let contentChars = 0;

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: PROMPT }],
      stream: true,
    }),
  });
  if (!response.ok || !response.body) {
    console.log(`\nprobe: request failed (${response.status})`);
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      for (const line of frame.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") break;
        try {
          const chunk = JSON.parse(data) as {
            choices?: Array<{ delta?: Record<string, unknown> }>;
          };
          const delta = chunk.choices?.[0]?.delta ?? {};
          if (firstChunkAt === undefined) firstChunkAt = performance.now() - start;
          const reasoning = (delta.reasoning ?? delta.reasoning_content) as string | undefined;
          if (typeof reasoning === "string" && reasoning.length > 0) {
            if (firstReasoningAt === undefined) firstReasoningAt = performance.now() - start;
            reasoningChars += reasoning.length;
          }
          const content = delta.content as string | undefined;
          if (typeof content === "string" && content.length > 0) {
            if (firstContentAt === undefined) firstContentAt = performance.now() - start;
            contentChars += content.length;
          }
        } catch {
          // ignore
        }
      }
    }
  }

  console.log(`\nthinking probe (${MODEL})`);
  console.log(`  first SSE chunk   ${firstChunkAt !== undefined ? `${Math.round(firstChunkAt)}ms` : "—"}`);
  console.log(`  first reasoning   ${firstReasoningAt !== undefined ? `${Math.round(firstReasoningAt)}ms (${reasoningChars} chars)` : "none"}`);
  console.log(`  first content     ${firstContentAt !== undefined ? `${Math.round(firstContentAt)}ms (${contentChars} chars)` : "—"}`);
  if (firstReasoningAt !== undefined && firstContentAt !== undefined) {
    console.log(
      `  → thinking before content: ~${Math.round(firstContentAt - firstReasoningAt)}ms of reasoning`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const llm = makeLlm();
console.log(`latency profile: ${RUNS} runs, ${LABEL}`);
for (const scenario of scenarios) {
  const request = scenario.build();
  console.log(`\n${scenario.name} — ${scenario.diagnostics()}`);
  console.log(`${'metric'.padEnd(12)} ${'p50'.padStart(8)} ${'p90'.padStart(8)} ${'p95'.padStart(8)} ${'min'.padStart(8)} ${'max'.padStart(8)}`);

  const deltas: (number | undefined)[] = [];
  const toolCalls: (number | undefined)[] = [];
  const dones: (number | undefined)[] = [];
  const reqStarts: (number | undefined)[] = [];
  const headers: (number | undefined)[] = [];
  const firstChunks: (number | undefined)[] = [];
  for (let i = 0; i < RUNS; i++) {
    const run = await runOnce(llm, request);
    deltas.push(run.firstDelta);
    toolCalls.push(run.toolCall);
    dones.push(run.done);
    reqStarts.push(run['request-start']);
    headers.push(run.headers);
    firstChunks.push(run['first-chunk']);
    process.stdout.write(`  run ${i + 1}/${RUNS}…`);
  }
  console.log();

  const deltaPresent = deltas.filter((v): v is number => v !== undefined);
  const threshold = 2 * percentile(deltaPresent, 0.5);
  const deltaOutliers = deltaPresent
    .map((v, i) => (v > threshold ? i + 1 : null))
    .filter((v): v is number => v !== null);

  report('first delta', deltas, deltaOutliers, Math.round(threshold));
  report('tool call', toolCalls, [], 0);
  report('done', dones, [], 0);

  // Provider timeline (medians): app delay → network/queue → model TTFT →
  // adapter processing. Splits "generation started" from "HTTP request" from
  // "first token" so application overhead can't hide inside model latency.
  const med = (values: (number | undefined)[]): number | undefined => {
    const present = values.filter((v): v is number => v !== undefined).sort((a, b) => a - b);
    return present.length > 0 ? present[Math.floor(present.length / 2)] : undefined;
  };
  const req = med(reqStarts) ?? 0;
  const hdr = med(headers);
  const chunk = med(firstChunks);
  const firstOut = med(deltas.length > 0 ? deltas : toolCalls);
  const done = med(dones);
  if (hdr !== undefined) {
    const row = (name: string, gap: number | undefined) =>
      console.log(`  ${name.padEnd(26)} ${gap === undefined ? '—'.padStart(9) : `${Math.round(gap)}ms`.padStart(9)}`);
    console.log('  provider timeline (medians):');
    row('app → request issued', req);
    row('request → headers', hdr - req);
    row('headers → first chunk', chunk !== undefined ? chunk - hdr : undefined);
    row('first chunk → first output', firstOut !== undefined && chunk !== undefined ? firstOut - chunk : undefined);
    row('first output → done', done !== undefined && firstOut !== undefined ? done - firstOut : undefined);
  }
}

await probeThinking();
console.log("\nDone.");
