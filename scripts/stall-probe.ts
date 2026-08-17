// Long-stall characterization: repeated coordination-style requests over raw
// SSE, capturing per-run request IDs, token usage, and response headers so a
// slow run can be attributed to the model vs the OpenRouter provider.
//
//   LLM_MODEL=amazon/nova-lite-v1 bun scripts/stall-probe.ts
//
// Overrides: LLM_MODEL, RUNS (default 20), STALL_MS (default 5000).

import { delegateToolDefinition } from "../src/conversations/orchestration/coordination/coordination";
import type { LLMToolDefinition } from "../src/providers/llm/types";

const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  console.error("OPENROUTER_API_KEY or DEEPSEEK_API_KEY is required");
  process.exit(1);
}

const RUNS = Number(process.env.RUNS ?? 20);
const STALL_MS = Number(process.env.STALL_MS ?? 5_000);
const MODEL = process.env.LLM_MODEL ?? "google/gemini-2.5-flash-lite";
const baseUrl = process.env.OPENROUTER_API_KEY
  ? "https://openrouter.ai/api/v1"
  : "https://api.deepseek.com";

const COORDINATOR_PROMPT =
  "You are the conversation coordinator. The available agents are: Travel Agent (aliases: travel), " +
  "Calendar Agent (aliases: calendar). Decide the best next step and take exactly one: delegate to one " +
  "or more agents, pass the work to another coordination, ask the user a clarifying question when the " +
  "request is ambiguous or missing critical information, or answer directly when you have everything you need.";
const USER_QUESTION =
  "Book me a flight from Paris to London tomorrow morning, and check whether Tuesday afternoon is free.";
const delegate: LLMToolDefinition = delegateToolDefinition([], []);

interface Run {
  firstChunk?: number;
  firstContent?: number;
  firstToolCall?: number;
  done?: number;
  promptTokens?: number;
  completionTokens?: number;
  requestId?: string;
  status: number;
  headers: Record<string, string>;
}

async function runOnce(): Promise<Run> {
  const start = performance.now();
  const run: Run = {
    status: 0,
    headers: {},
    firstChunk: undefined,
    firstContent: undefined,
    firstToolCall: undefined,
    done: undefined,
    promptTokens: undefined,
    completionTokens: undefined,
    requestId: undefined,
  };
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: COORDINATOR_PROMPT },
        { role: "user", content: USER_QUESTION },
      ],
      tools: [{ type: "function", function: delegate }],
      stream: true,
      // Ask the provider to include usage in the final chunk.
      stream_options: { include_usage: true },
    }),
  });
  run.status = response.status;
  run.requestId = response.headers.get("x-request-id") ?? undefined;
  for (const [name, value] of response.headers.entries()) {
    run.headers[name] = value;
  }
  if (!response.ok || !response.body) return run;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let toolCallSeen = false;
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
        if (data === "[DONE]") {
          run.done = performance.now() - start;
          break;
        }
        try {
          const chunk = JSON.parse(data) as {
            choices?: Array<{
              delta?: { content?: string | null; tool_calls?: unknown[] };
              finish_reason?: string | null;
            }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          if (run.firstChunk === undefined) run.firstChunk = performance.now() - start;
          const delta = chunk.choices?.[0]?.delta;
          if (typeof delta?.content === "string" && delta.content.length > 0 && run.firstContent === undefined) {
            run.firstContent = performance.now() - start;
          }
          if (delta?.tool_calls && delta.tool_calls.length > 0 && !toolCallSeen) {
            toolCallSeen = true;
            run.firstToolCall = performance.now() - start;
          }
          if (chunk.usage) {
            run.promptTokens = chunk.usage.prompt_tokens;
            run.completionTokens = chunk.usage.completion_tokens;
          }
        } catch {
          // ignore malformed frames
        }
      }
    }
  }
  return run;
}

const fmt = (ms: number | undefined) => (ms === undefined ? "—" : `${Math.round(ms)}ms`);
const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))]!;

console.log(`stall probe: ${RUNS} runs, ${MODEL} (stall > ${STALL_MS}ms)`);
const dones: number[] = [];
const stalls: Array<{ run: number; done: number; requestId: string | undefined }> = [];
for (let i = 0; i < RUNS; i++) {
  const run = await runOnce();
  if (run.done !== undefined) dones.push(run.done);
  const stalled = run.done !== undefined && run.done > STALL_MS;
  if (stalled) stalls.push({ run: i + 1, done: run.done!, requestId: run.requestId });
  console.log(
    `  run ${String(i + 1).padStart(2)}: chunk ${fmt(run.firstChunk).padStart(8)}  ` +
      `content ${fmt(run.firstContent).padStart(8)}  tool ${fmt(run.firstToolCall).padStart(8)}  ` +
      `done ${fmt(run.done).padStart(9)}  tokens ${run.promptTokens ?? "—"}/${run.completionTokens ?? "—"}  ` +
      `status ${run.status}${stalled ? "  ⚠ STALL" : ""}`,
  );
  if (stalled) {
    // The metadata that makes a stall attributable.
    console.log(`      req-id: ${run.requestId ?? "—"}`);
    const interesting = ["x-provider-name", "x-provider", "x-request-id", "cf-ray"];
    for (const name of interesting) {
      if (run.headers[name]) console.log(`      ${name}: ${run.headers[name]}`);
    }
  }
}

if (dones.length > 0) {
  const sorted = [...dones].sort((a, b) => a - b);
  console.log(
    `\ndone: p50 ${Math.round(percentile(sorted, 0.5))}ms  p90 ${Math.round(percentile(sorted, 0.9))}ms  ` +
      `p95 ${Math.round(percentile(sorted, 0.95))}ms  min ${Math.round(sorted[0]!)}ms  max ${Math.round(sorted.at(-1)!)}ms`,
  );
}
console.log(`stalls (>${STALL_MS}ms): ${stalls.length}/${RUNS}`);
for (const stall of stalls) {
  console.log(`  run ${stall.run}: ${Math.round(stall.done)}ms  req-id ${stall.requestId ?? "—"}`);
}
console.log("\nDone.");
