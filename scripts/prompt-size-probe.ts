// Decomposes first-token latency by request size: does a large conversation
// history and/or the delegate tool schema explain the coordination path being
// much slower than a plain prompt (e2e saw 3569ms vs ~486ms)?
//
//   bun scripts/prompt-size-probe.ts
//
// Uses OPENROUTER_API_KEY (default google/gemini-2.5-flash-lite). Overrides:
// LLM_MODEL, RUNS_PER_CONFIG (default 5).

import { OpenRouterLLM } from "../src/providers/llm/adapters/openrouter/openrouter";
import { DeepSeekLLM } from "../src/providers/llm/adapters/deepseek/deepseek";
import { delegateToolDefinition } from "../src/conversations/orchestration/coordination/coordination";
import type { LLM, LLMRequest, LLMToolDefinition } from "../src/providers/llm/types";

const openRouterKey = process.env.OPENROUTER_API_KEY;
const deepSeekKey = process.env.DEEPSEEK_API_KEY;
if (!openRouterKey && !deepSeekKey) {
  console.error("OPENROUTER_API_KEY or DEEPSEEK_API_KEY is required");
  process.exit(1);
}

const RUNS = Number(process.env.RUNS_PER_CONFIG ?? 5);
const MODEL = process.env.LLM_MODEL ?? "google/gemini-2.5-flash-lite";

function makeLlm(): LLM {
  if (openRouterKey) {
    return new OpenRouterLLM({ apiKey: openRouterKey, model: MODEL });
  }
  return new DeepSeekLLM({ apiKey: deepSeekKey!, model: "deepseek-v4-flash" });
}

const COORDINATOR_PROMPT =
  "You are the conversation coordinator. The available agents are: Travel Agent (aliases: travel), " +
  "Calendar Agent (aliases: calendar). Decide the best next step and take exactly one: delegate to one " +
  "or more agents, pass the work to another coordination, ask the user a clarifying question when the " +
  "request is ambiguous or missing critical information, or answer directly when you have everything you need.";

const USER_QUESTION =
  "Book me a flight from Paris to London tomorrow morning, and check whether Tuesday afternoon is free.";

/** Realistic turns, cycled to reach `targetChars` of history before the final question. */
const TURNS: Array<{ role: "user" | "assistant"; content: string }> = [
  { role: "user", content: "Good morning! Can you help me plan a business trip?" },
  { role: "assistant", content: "Of course. Where are you traveling from, and what's the destination?" },
  { role: "user", content: "From Paris. I need to be in London for a client meeting." },
  { role: "assistant", content: "Got it — Paris to London. Do you have preferred dates or airlines?" },
  { role: "user", content: "No preference on airline, but I need to be there early in the day." },
  { role: "assistant", content: "I'll look for a morning arrival. Anything else, like a return flight?" },
  { role: "user", content: "Not yet — I also have a team sync I want to move. Can you check my calendar?" },
  { role: "assistant", content: "Happy to. Which day should I check, and who's in the meeting?" },
];

function history(targetChars: number): Array<{ role: "user" | "assistant"; content: string }> {
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  let chars = COORDINATOR_PROMPT.length;
  let i = 0;
  while (chars < targetChars) {
    const turn = TURNS[i % TURNS.length]!;
    messages.push(turn);
    chars += turn.content.length;
    i++;
  }
  messages.push({ role: "user", content: USER_QUESTION });
  return messages;
}

const delegate: LLMToolDefinition = delegateToolDefinition([], []);

const configs: Array<{ name: string; build: () => LLMRequest; note: string }> = [
  {
    name: "small plain",
    note: "~2KB history, no tools",
    build: () => ({ messages: [{ role: "system", content: COORDINATOR_PROMPT }, ...history(2_000)] }),
  },
  {
    name: "large plain",
    note: "~16KB history, no tools",
    build: () => ({ messages: [{ role: "system", content: COORDINATOR_PROMPT }, ...history(16_000)] }),
  },
  {
    name: "small + delegate",
    note: "~2KB history + real delegate schema",
    build: () => ({ messages: [{ role: "system", content: COORDINATOR_PROMPT }, ...history(2_000)], tools: [delegate] }),
  },
  {
    name: "large + delegate",
    note: "~16KB history + real delegate schema",
    build: () => ({ messages: [{ role: "system", content: COORDINATOR_PROMPT }, ...history(16_000)], tools: [delegate] }),
  },
];

async function runOnce(llm: LLM, request: LLMRequest): Promise<{
  firstResponse: number | undefined;
  done: number | undefined;
  contentChars: number;
  toolCalls: number;
}> {
  const start = performance.now();
  const out: { firstResponse?: number; done?: number } = {};
  let contentChars = 0;
  let toolCalls = 0;
  for await (const event of llm.stream(request)) {
    const at = performance.now() - start;
    if (event.type === "delta" && out.firstResponse === undefined) {
      out.firstResponse = at;
      contentChars += event.content.length;
    } else if (event.type === "delta") {
      contentChars += event.content.length;
    } else if (event.type === "tool_call" && out.firstResponse === undefined) {
      out.firstResponse = at;
      toolCalls++;
    } else if (event.type === "tool_call") {
      toolCalls++;
    } else if (event.type === "done") {
      out.done = at;
    }
  }
  return { firstResponse: out.firstResponse, done: out.done, contentChars, toolCalls };
}

const fmt = (ms: number | undefined) => (ms === undefined ? "—" : `${Math.round(ms)}ms`);

const llm = makeLlm();
console.log(`prompt-size probe: ${RUNS} runs/config, ${MODEL}\n`);

for (const config of configs) {
  console.log(`== ${config.name} (${config.note})`);
  for (let i = 0; i < RUNS; i++) {
    const run = await runOnce(llm, config.build());
    console.log(
      `  run ${i + 1}: first ${fmt(run.firstResponse).padStart(9)}  done ${fmt(run.done).padStart(9)}  ` +
        `content ${run.contentChars} chars, ${run.toolCalls} tool call(s)`,
    );
  }
}
console.log("\nDone.");
