// Real-LLM latency benchmark. Requires DEEPSEEK_API_KEY (loaded from .env).
// Runs the single-agent voice pipeline N times against the real model and
// reports p50/p95 per latency hop. STT/TTS are faked: this measures
// orchestration + LLM, not real TTS/transport.
//
//   bun run benchmark          # 10 runs
//   BENCH_RUNS=5 bun run benchmark

import { Agent } from "../src/agents/agent";
import { Conversations } from "../src/conversations/conversations";
import { MemoryPersistence } from "../src/persistence/adapters/memory/memory";
import { DeepSeekLLM } from "../src/providers/llm/adapters/deepseek/deepseek";
import type { STT, STTOptions, STTSession } from "../src/providers/stt/types";
import type { TTS, TTSRequest } from "../src/providers/tts/types";
import type { GenerationTiming } from "../src/conversations/types";

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  console.error("DEEPSEEK_API_KEY is required (add it to .env)");
  process.exit(1);
}
// Narrowed copy: closures only see the declared type, not the guard above.
const key: string = apiKey;

const RUNS = Number(process.env.BENCH_RUNS ?? 10);
const MODEL = "deepseek-v4-flash";
// Multi-sentence on purpose: it exercises the streaming chunker (soft
// boundaries and length flushes) rather than one long buffered sentence.
const PROMPT =
  "In two or three short sentences, what is Pipeflow? Keep each sentence brief.";

// ---------------------------------------------------------------------------
// Fakes (kept local: the e2e fakes are test-only and not exported)
// ---------------------------------------------------------------------------

class FakeSTT implements STT {
  readonly sessions: FakeSTTSession[] = [];
  start(_options: STTOptions = {}): FakeSTTSession {
    const session = new FakeSTTSession();
    this.sessions.push(session);
    return session;
  }
  cancel(): void {}
}

class FakeSTTSession implements STTSession {
  private readonly listeners: Record<
    "partial" | "final" | "error",
    Set<(...args: any[]) => void>
  > = { partial: new Set(), final: new Set(), error: new Set() };

  write(_audio: Uint8Array): void {}
  async end(): Promise<void> {}

  on(event: "partial", listener: (transcript: string) => void): void;
  on(event: "final", listener: (transcript: string) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "partial" | "final" | "error", listener: (...args: any[]) => void): void {
    this.listeners[event].add(listener);
  }

  emitFinal(text: string): void {
    for (const listener of this.listeners.final) listener(text);
  }
}

class FakeTTS implements TTS {
  async *stream(request: TTSRequest): AsyncGenerator<Uint8Array> {
    yield new TextEncoder().encode(request.text);
  }
  stop(): void {}
}

// ---------------------------------------------------------------------------
// Benchmark
// ---------------------------------------------------------------------------

const samples = new Map<string, number[]>();

function record(name: string, value: number | undefined, base: number): void {
  if (value === undefined) return;
  const list = samples.get(name) ?? [];
  list.push(value - base);
  samples.set(name, list);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)));
  return sorted[index]!;
}

function format(value: number): string {
  return Number.isFinite(value) ? `${Math.round(value)}ms` : "—";
}

async function runOnce(): Promise<void> {
  const stt = new FakeSTT();
  const tts = new FakeTTS();
  const persistence = new MemoryPersistence();
  const api = new Conversations({ persistence, stt, tts });
  const llm = new DeepSeekLLM({ apiKey: key, model: MODEL });

  const conversation = await api.create({
    agents: [
      new Agent({
        name: "Jarvis",
        context: "You are a concise, helpful assistant.",
        llm,
      }),
    ],
  });
  await conversation.start();
  await conversation.participate({ userId: "alice", aliases: ["al"] });

  conversation.listen({ userId: "alice", audio: new Uint8Array([1]) });
  stt.sessions[0]!.emitFinal(PROMPT);

  // Wait for the generation to complete (bounded).
  const deadline = Date.now() + 120_000;
  let timing: GenerationTiming | undefined;
  let startedAt = 0;
  for (;;) {
    const generations = (await persistence.listGenerations(conversation.id)).filter(
      (g) => g.kind !== "sub",
    );
    const generation = generations.at(-1);
    if (generation?.status === "completed") {
      timing = generation.timing;
      startedAt = generation.startedAt;
      break;
    }
    if (Date.now() > deadline) throw new Error("benchmark run timed out");
    await Bun.sleep(50);
  }

  const [turn] = await persistence.listTurns(conversation.id);
  const base = turn?.startedAt ?? 0;
  record("Generation start", startedAt || undefined, base);
  record("LLM first token", timing?.firstTokenAt, base);
  record("First TTS text", timing?.firstTtsTextAt, base);
  record("First audio", timing?.firstAudioAt, base);
  record("Completion", timing?.completedAt, base);
}

console.log(`benchmark: ${RUNS} runs, model ${MODEL}, TTS: fake`);
for (let i = 0; i < RUNS; i++) {
  process.stdout.write(`  run ${i + 1}/${RUNS}…`);
  await runOnce();
  console.log(" done");
}

console.log(`\nPipeflow latency (${RUNS} runs, model ${MODEL})`);
console.log("──────────────────────────────────────────────");
console.log(`${"".padEnd(18)} ${"p50".padStart(10)} ${"p95".padStart(10)}`);
const headline = ["LLM first token", "First TTS text", "First audio", "Completion"] as const;
for (const name of headline) {
  const values = (samples.get(name) ?? []).sort((a, b) => a - b);
  const p50 = format(percentile(values, 0.5));
  const p95 = format(percentile(values, 0.95));
  console.log(`${name.padEnd(18)} ${p50.padStart(10)} ${p95.padStart(10)}`);
}

const startValues = (samples.get("Generation start") ?? []).sort((a, b) => a - b);
const overhead = format(percentile(startValues, 0.5));
console.log(
  `\nPipeflow orchestration overhead: ${overhead} at p50 (turn → generation start).`,
);
console.log("All times relative to the turn boundary.");
