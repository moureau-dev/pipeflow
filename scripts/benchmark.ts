// Real-LLM latency benchmark. Requires DEEPSEEK_API_KEY (loaded from .env).
// Runs the single-agent voice pipeline N times against the real model and
// reports p50/p95 per latency hop. STT is faked; TTS is faked unless
// KOKORO_URL points at a Kokoro server, in which case the real synthesis
// path — including inter-chunk audio gaps — is measured.
//
//   bun run benchmark                                        # 10 runs, fake TTS
//   BENCH_RUNS=5 bun run benchmark                           # fewer runs
//   KOKORO_URL=http://localhost:8880 bun run benchmark       # local kokoro-fastapi
//   KOKORO_URL=https://api.together.ai \
//     KOKORO_API_KEY=$TOGETHER_API_KEY \
//     KOKORO_MODEL=hexgrad/Kokoro-82M bun run benchmark      # Together AI

import { Agent } from "../src/agents/agent";
import { Conversations } from "../src/conversations/conversations";
import { MemoryPersistence } from "../src/persistence/adapters/memory/memory";
import { DeepSeekLLM } from "../src/providers/llm/adapters/deepseek/deepseek";
import { KokoroTTS } from "../src/providers/tts/adapters/kokoro/kokoro";
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

// When set, the benchmark uses the real Kokoro adapter against this server;
// otherwise TTS is faked (synthetic, single-chunk) and the TTS hop is
// orchestration-only. KOKORO_API_KEY authenticates hosted endpoints
// (Together AI); KOKORO_MODEL defaults to `kokoro` (local kokoro-fastapi)
// but must be `hexgrad/Kokoro-82M` on Together AI.
const KOKORO_URL = process.env.KOKORO_URL;
const KOKORO_API_KEY = process.env.KOKORO_API_KEY;
const KOKORO_MODEL = process.env.KOKORO_MODEL;

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
// Inter-chunk audio gaps, accumulated across runs. Only meaningful with real
// TTS: the fake yields a single chunk per sentence.
const gapSamples: number[] = [];
let totalChunks = 0;

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
  const tts: TTS = KOKORO_URL
    ? new KokoroTTS({
        baseUrl: KOKORO_URL,
        apiKey: KOKORO_API_KEY,
        model: KOKORO_MODEL,
        // The benchmark measures the realtime path: progressive synthesis.
        stream: true,
      })
    : new FakeTTS();
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

  // Timestamp every delivered audio chunk: the first marks the delivery hop,
  // the rest feed the audio-continuity (inter-chunk gap) metric.
  const audioEvents: number[] = [];
  conversation.on("audio", () => audioEvents.push(Date.now()));

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
  record("First speechable text", timing?.firstTtsTextAt, base);
  record("TTS request", timing?.firstTtsRequestAt, base);
  record("TTS first audio", timing?.firstTtsAudioAt, base);
  record("First audio delivered", timing?.firstAudioAt, base);
  record("Last audio delivered", audioEvents.at(-1), base);
  record("Completion", timing?.completedAt, base);

  if (KOKORO_URL && audioEvents.length > 1) {
    totalChunks += audioEvents.length;
    for (let i = 1; i < audioEvents.length; i++) {
      gapSamples.push(audioEvents[i]! - audioEvents[i - 1]!);
    }
  }
}

const ttsLabel = KOKORO_URL
  ? `kokoro (${KOKORO_URL}${KOKORO_MODEL ? `, ${KOKORO_MODEL}` : ""})`
  : "fake";
console.log(`benchmark: ${RUNS} runs, model ${MODEL}, TTS: ${ttsLabel}`);
for (let i = 0; i < RUNS; i++) {
  process.stdout.write(`  run ${i + 1}/${RUNS}…`);
  await runOnce();
  console.log(" done");
}

console.log(`\nPipeflow latency (${RUNS} runs, model ${MODEL}, TTS: ${ttsLabel})`);
console.log("──────────────────────────────────────────────────────────");
console.log(`${"".padEnd(22)} ${"p50".padStart(10)} ${"p95".padStart(10)}`);
const headline = [
  "LLM first token",
  "First speechable text",
  "TTS request",
  "TTS first audio",
  "First audio delivered",
  "Last audio delivered",
  "Completion",
] as const;
for (const name of headline) {
  const values = (samples.get(name) ?? []).sort((a, b) => a - b);
  const p50 = format(percentile(values, 0.5));
  const p95 = format(percentile(values, 0.95));
  console.log(`${name.padEnd(22)} ${p50.padStart(10)} ${p95.padStart(10)}`);
}

const startValues = (samples.get("Generation start") ?? []).sort((a, b) => a - b);
const overhead = format(percentile(startValues, 0.5));
console.log(
  `\nPipeflow orchestration overhead: ${overhead} at p50 (turn → generation start).`,
);

if (KOKORO_URL && gapSamples.length > 0) {
  const sorted = [...gapSamples].sort((a, b) => a - b);
  const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  console.log(
    `\nAudio continuity: ${totalChunks} chunks, avg gap ${format(avg)}, ` +
      `p50 ${format(percentile(sorted, 0.5))}, ` +
      `p95 ${format(percentile(sorted, 0.95))}, max ${format(sorted.at(-1)!)}`,
  );
  console.log("Small, stable gaps mean smooth playback; a 100ms+ outlier is audible.");
}
console.log("All times relative to the turn boundary.");
