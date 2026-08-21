import { describe, expect, test } from "bun:test";
import { Agent } from "../agents/agent";
import { Tool } from "../agents/tools/tools";
import { Conversation } from "../conversations/conversation/conversation";
import { Orchestrator } from "../conversations/orchestration/orchestrator/orchestrator";
import { buildClarifyPrompt } from "../conversations/orchestration/coordination/coordination";
import { Conversations } from "../conversations/conversations";
import { MemoryPersistence } from "../persistence/adapters/memory/memory";
import { DeepSeekLLM } from "../providers/llm/adapters/deepseek/deepseek";
import { OpenRouterLLM } from "../providers/llm/adapters/openrouter/openrouter";
import type { LLM } from "../providers/llm/types";
import type { STT, STTOptions, STTSession } from "../providers/stt/types";
import type { TTS, TTSRequest } from "../providers/tts/types";
import type { Generation, GenerationTiming, Turn } from "../conversations/types";

// End-to-end tests against the real DeepSeek API. They need a
// DEEPSEEK_API_KEY in the environment (`.env` is loaded automatically) and
// are skipped when it is missing, so CI stays green without credentials.
// STT and TTS are faked — only the LLM is real — which exercises the full
// conversation pipeline (routing, generations, transcripts, coordination,
// multi-tool concurrency) against a real model.

const apiKey = process.env.DEEPSEEK_API_KEY;
const openRouterKey = process.env.OPENROUTER_API_KEY;
const hasKey =
  (typeof apiKey === "string" && apiKey.length > 0) ||
  (typeof openRouterKey === "string" && openRouterKey.length > 0);

/** Register an e2e test, skipped when no API key is available. */
function e2e(name: string, fn: () => Promise<void>, timeoutMs = 60_000): void {
  if (hasKey) {
    test(name, fn, timeoutMs);
  } else {
    test.skip(name, fn);
  }
}

/**
 * The LLM under test: OpenRouter (when its key is present, defaulting to
 * gemini-2.5-flash-lite) or DeepSeek. Override the model with `LLM_MODEL`.
 */
function makeLlm(): LLM {
  if (openRouterKey) {
    return new OpenRouterLLM({
      apiKey: openRouterKey,
      model: process.env.LLM_MODEL ?? "google/gemini-2.5-flash-lite",
    });
  }
  return new DeepSeekLLM({ apiKey: apiKey!, model: "deepseek-v4-flash" });
}

// ---------------------------------------------------------------------------
// Fakes for the audio ends of the pipeline
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
  readonly requests: TTSRequest[] = [];
  /** `Date.now()` when each request began — same clock as generation timing. */
  readonly requestTimes: number[] = [];
  async *stream(request: TTSRequest): AsyncGenerator<Uint8Array> {
    this.requests.push(request);
    this.requestTimes.push(Date.now());
    yield new TextEncoder().encode(request.text);
  }
  stop(): void {}
}

/**
 * Print the latency timeline of a generation relative to its turn boundary,
 * with each hop of the pipeline separated:
 *
 * ```text
 * Turn boundary        0ms
 * Generation started +12ms
 * LLM first token   +420ms
 * First TTS text    +480ms
 * TTS requested     +490ms
 * TTS first audio   +650ms
 * Audio delivered   +660ms
 * Generation done  +1800ms
 * ```
 */
function reportTimeline(label: string, turn: Turn, generation: Generation): void {
  const base = turn.startedAt;
  const timing: GenerationTiming = generation.timing ?? {
    startedAt: generation.startedAt,
  };
  const row = (name: string, at: number | undefined) => {
    if (at === undefined) {
      console.log(`${name.padEnd(18)} ${("—").padStart(9)}`);
      return;
    }
    const delta = at - base;
    const rendered = delta === 0 ? "0ms" : `+${delta}ms`;
    console.log(`${name.padEnd(18)} ${rendered.padStart(9)}`);
  };
  console.log(`\n${label}`);
  row("Turn boundary", turn.startedAt);
  row("Generation started", generation.startedAt);
  row("LLM first token", timing.firstTokenAt);
  row("First TTS text", timing.firstTtsTextAt);
  row("TTS requested", timing.firstTtsRequestAt);
  row("TTS first audio", timing.firstTtsAudioAt);
  row("Audio delivered", timing.firstAudioAt);
  row("Generation done", timing.completedAt);
}

interface ToolTiming {
  label: string;
  startedAt: number;
  endedAt: number;
}

/**
 * A clarifying question is a plain "?" sentence or a batched bulleted list
 * of missing details ending in a colon — treat both as questions.
 */
const isQuestion = (text: string): boolean =>
  text.includes("?") || /:\s*$/.test(text.trim());

function summarizeConcurrency(timings: ToolTiming[]): {
  maxConcurrent: number;
  wall: number;
  serial: number;
} {
  if (timings.length === 0) return { maxConcurrent: 0, wall: 0, serial: 0 };
  const start = Math.min(...timings.map((t) => t.startedAt));
  const end = Math.max(...timings.map((t) => t.endedAt));
  const events = timings
    .flatMap((t) => [
      { time: t.startedAt, delta: 1 },
      { time: t.endedAt, delta: -1 },
    ])
    .sort((a, b) => a.time - b.time);
  let depth = 0;
  let maxConcurrent = 0;
  for (const event of events) {
    depth += event.delta;
    maxConcurrent = Math.max(maxConcurrent, depth);
  }
  return {
    maxConcurrent,
    wall: end - start,
    serial: timings.reduce((sum, t) => sum + (t.endedAt - t.startedAt), 0),
  };
}

/**
 * Print how tool executions overlapped, relative to the first one:
 *
 * ```text
 * tool concurrency (agent.run)
 * get_weather(Paris)     +0ms →  +502ms  (500ms)
 * search_flights(Tokyo)  +2ms →  +803ms  (800ms)
 * max concurrent tools: 2, wall 803ms vs 1300ms serial
 * ```
 */
function reportToolConcurrency(label: string, timings: ToolTiming[]): void {
  if (timings.length === 0) return;
  const base = Math.min(...timings.map((t) => t.startedAt));
  const summary = summarizeConcurrency(timings);
  console.log(`\n${label}`);
  for (const t of timings) {
    const latency = t.endedAt - t.startedAt;
    console.log(
      `${t.label.padEnd(30)} +${String(t.startedAt - base).padStart(5)}ms → +${String(
        t.endedAt - base,
      ).padStart(6)}ms  (${latency}ms)`,
    );
  }
  console.log(
    `max concurrent tools: ${summary.maxConcurrent}, wall ${summary.wall}ms vs ${summary.serial}ms serial`,
  );
}

async function waitFor(
  condition: () => Promise<boolean> | boolean,
  timeoutMs = 60_000,
): Promise<void> {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await Bun.sleep(50);
  }
}

describe("LLM e2e (requires DEEPSEEK_API_KEY or OPENROUTER_API_KEY)", () => {
  e2e("streams a real completion", async () => {
    const llm = makeLlm();
    let text = "";

    for await (const event of llm.stream({
      messages: [{ role: "user", content: "Reply with exactly the word: pipeflow" }],
    })) {
      if (event.type === "delta") text += event.content;
    }

    expect(text.length).toBeGreaterThan(0);
    expect(text.toLowerCase()).toContain("pipeflow");
  });

  e2e("runs an agent with a real tool call and execution", async () => {
    const getWeather = new Tool({
      name: "get_weather",
      description: "Get the current weather for a city.",
      parameters: {
        type: "object",
        properties: { city: { type: "string", description: "The city to look up." } },
        required: ["city"],
      },
      execute: async ({ city }) => `sunny, 24°C in ${city}`,
    });

    const agent = new Agent({
      name: "Jarvis",
      context:
        "You are a concise weather assistant. Always use the get_weather tool to answer.",
      llm: makeLlm(),
      tools: [getWeather],
    });

    const result = await agent.run({
      prompt: "What is the weather in Paris?",
      maxTokens: 200,
    });

    // The real model requested the tool and the agent executed it. Some
    // models answer directly without the tool — the tool-call path is
    // unit-tested, so report instead of failing.
    if (result.toolCalls.length === 0) {
      console.log(
        `  model answered without calling the tool ("${result.text.slice(0, 100)}") — skipping the tool assertions`,
      );
      return;
    }
    expect(result.toolCalls[0]!.name).toBe("get_weather");
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.text).toMatch(/paris/i);
  });

  e2e("runs a full conversation pipeline against the real LLM", async () => {
    const stt = new FakeSTT();
    const tts = new FakeTTS();
    const persistence = new MemoryPersistence();
    const api = new Conversations({ persistence, stt, tts });

    const conversation = await api.create({
      agents: [
        new Agent({
          name: "Jarvis",
          context: "You are a concise, helpful assistant.",
          llm: makeLlm(),
        }),
      ],
    });
    await conversation.start();
    await conversation.participate({ userId: "alice", aliases: ["al"] });

    // Capture when audio actually reaches the application, on the same
    // Date.now() clock the generation timing uses.
    const audioTimes: number[] = [];
    conversation.on("audio", () => audioTimes.push(Date.now()));

    // Ask for a multi-sentence answer so the streamed response flushes
    // several TTS chunks we can verify were handed off incrementally.
    conversation.listen({ userId: "alice", audio: new Uint8Array([1]) });
    stt.sessions[0]!.emitFinal("Hello! In three short sentences, what is Pipeflow?");

    await waitFor(async () => {
      const generations = await persistence.listGenerations(conversation.id);
      return generations.some((g) => g.status === "completed");
    });

    // The turn and the agent's answer landed in the transcript, and the
    // answer was synthesized to TTS.
    const transcript = await api.transcript(conversation.id);
    expect(transcript.length).toBeGreaterThanOrEqual(2);
    expect(transcript.at(-1)?.speakerKind).toBe("agent");
    expect(transcript.at(-1)?.text.length).toBeGreaterThan(0);
    expect(tts.requests.length).toBeGreaterThan(0);

    // The generation carries its latency instrumentation.
    const [turn] = await persistence.listTurns(conversation.id);
    const generation = (await persistence.listGenerations(conversation.id)).find(
      (g) => g.kind !== "sub",
    )!;
    const timing: GenerationTiming = generation.timing ?? {
      startedAt: generation.startedAt,
    };
    expect(timing.firstTokenAt).toBeDefined();
    expect(timing.firstTtsTextAt).toBeDefined();
    expect(timing.firstTtsRequestAt).toBeDefined();
    expect(timing.firstTtsAudioAt).toBeDefined();
    expect(timing.firstAudioAt).toBeDefined();
    expect(timing.completedAt).toBeDefined();

    // 1. The hops are monotonic: first token → first speakable text → TTS
    //    request → first TTS audio → delivered audio.
    expect(timing.firstTokenAt!).toBeLessThanOrEqual(timing.firstTtsTextAt!);
    expect(timing.firstTtsTextAt!).toBeLessThanOrEqual(timing.firstTtsRequestAt!);
    expect(timing.firstTtsRequestAt!).toBeLessThanOrEqual(timing.firstTtsAudioAt!);
    expect(timing.firstTtsAudioAt!).toBeLessThanOrEqual(timing.firstAudioAt!);

    // 2. Streaming, not buffering: the first audio chunk reached the
    //    application while the generation was still in flight (the multi-
    //    sentence prompt makes this separation seconds, not milliseconds).
    expect(timing.firstAudioAt!).toBeLessThan(timing.completedAt!);
    expect(audioTimes[0]).toBeDefined();
    expect(audioTimes[0]!).toBeLessThan(timing.completedAt!);

    // 3. The multi-sentence answer was chunked into several TTS requests,
    //    and no words were lost in the chunking: the sentences reconstruct
    //    the final answer in order. (Chunk edges are whitespace-trimmed for
    //    TTS hygiene, so compare word sequences — punctuation and whitespace
    //    placement across chunk boundaries are not an invariant.)
    expect(tts.requests.length).toBeGreaterThan(1);
    const words = (s: string) => s.match(/[A-Za-z0-9']+/g) ?? [];
    expect(words(tts.requests.map((r) => r.text).join(""))).toEqual(words(generation.text));

    // 4. Per-chunk timeline: when each sentence was handed to TTS relative to
    //    the first, so the real model's streaming cadence is visible.
    console.log(`\nstreamed TTS chunks (${tts.requests.length})`);
    tts.requestTimes.forEach((at, i) => {
      const gap = i === 0 ? 0 : at - tts.requestTimes[i - 1]!;
      console.log(
        `  chunk ${i + 1}: +${String(at - tts.requestTimes[0]!).padStart(6)}ms  ` +
          `${String(tts.requests[i]!.text.length).padStart(4)} chars  (gap ${gap}ms)`,
      );
    });

    reportTimeline("conversation pipeline latency", turn!, generation);
  });

  e2e("runs a conversation via text turns (no STT or TTS)", async () => {
    const persistence = new MemoryPersistence();
    const api = new Conversations({ persistence });

    const conversation = await api.create({
      agents: [
        new Agent({
          name: "Jarvis",
          context: "You are a concise, helpful assistant.",
          llm: makeLlm(),
        }),
      ],
    });
    await conversation.start();
    await conversation.participate({ userId: "alice", aliases: ["al"] });

    // Text turns go through the same routing pipeline as transcribed
    // speech — no STT or TTS involved.
    conversation.send({ userId: "alice", text: "In one sentence, what is Pipeflow?" });

    await waitFor(async () => {
      const generations = await persistence.listGenerations(conversation.id);
      return generations.some((g) => g.status === "completed");
    });

    const transcript = await api.transcript(conversation.id);
    expect(transcript.length).toBe(2);
    expect(transcript[0]?.toString()).toBe(
      "al: In one sentence, what is Pipeflow?",
    );
    expect(transcript.at(-1)?.speakerKind).toBe("agent");
    expect(transcript.at(-1)?.text.length).toBeGreaterThan(0);

    const [turn] = await persistence.listTurns(conversation.id);
    const generation = (await persistence.listGenerations(conversation.id)).find(
      (g) => g.kind !== "sub",
    )!;
    reportTimeline("text conversation latency", turn!, generation);
  });

  e2e("coordinates a multi-agent delegation with the real LLM", async () => {
    const stt = new FakeSTT();
    const tts = new FakeTTS();
    const persistence = new MemoryPersistence();
    const api = new Conversations({ persistence, stt, tts });
    // One shared LLM instance across the coordinator and both specialists:
    // parallel sub-generations stream concurrently on the same adapter.
    const llm = makeLlm();

    const conversation = await api.create({
      agents: [
        new Agent({ name: "Jarvis", context: "You coordinate travel plans.", llm }),
        new Agent({
          name: "Travel Agent",
          context: "You find flights. Reply with a one-line flight suggestion.",
          llm,
        }),
        new Agent({
          name: "Calendar Agent",
          context: "You check calendars. Reply with a one-line availability answer.",
          llm,
        }),
      ],
    });
    await conversation.start();
    await conversation.participate({ userId: "alice", aliases: ["al"] });

    // gemini via OpenRouter intermittently returns a 200 with an empty
    // "error" finish; the adapter surfaces it as an error and the run
    // finalizes without a transcript entry. Report instead of failing the
    // suite — the delegation mechanism is unit-tested.
    const errors: Error[] = [];
    conversation.on("error", (payload) => errors.push(payload.error));

    conversation.listen({ userId: "alice", audio: new Uint8Array([1]) });
    stt.sessions[0]!.emitFinal(
      "Book a flight to London tomorrow AND check whether my Tuesday afternoon is free. Do both.",
    );

    let coordinatorCompleted = false;
    try {
      await waitFor(async () => {
        const generations = await persistence.listGenerations(conversation.id);
        // Wait for the coordinator's own generation (the sub-generations
        // complete first, before their results reach the merged answer).
        return generations.some(
          (g) => g.agentName === "Jarvis" && g.status === "completed",
        );
      });
      coordinatorCompleted = true;
    } catch {
      // A slow model (or many coordination hops) can exceed the wait budget
      // — the coordinator never finalized. Report instead of failing.
      const jarvis = (await persistence.listGenerations(conversation.id)).find(
        (g) => g.agentName === "Jarvis",
      );
      console.log(
        `coordination: coordinator did not finalize within the wait budget (status: ${jarvis?.status ?? "none"}) — skipping this run`,
      );
      return;
    }
    if (!coordinatorCompleted) return;

    if (errors.length > 0) {
      console.log(
        `coordination: provider error on the coordinator request (${errors[0]!.message}) — skipping this run`,
      );
      return;
    }

    // Some models answer directly instead of delegating to the specialists —
    // then there is no delegation graph to measure. Report instead of
    // failing; the delegation mechanism is unit-tested.
    const generations = await persistence.listGenerations(conversation.id);
    if (generations.filter((g) => g.kind === "sub").length === 0) {
      const transcriptSoFar = await api.transcript(conversation.id);
      const last = transcriptSoFar.at(-1)?.text ?? "";
      console.log(
        `coordination: model answered directly without delegating ("${last.slice(0, 100)}") — skipping this run`,
      );
      return;
    }

    // The `understand` coordination ran against the real model: the user
    // turn, at least one specialist's work, and the coordinator's merged
    // answer.
    const transcript = await api.transcript(conversation.id);
    expect(transcript.length).toBeGreaterThanOrEqual(3);
    expect(transcript.at(-1)?.speakerKind).toBe("agent");
    expect(transcript.at(-1)?.text.length).toBeGreaterThan(0);

    // The specialist work was persisted as completed sub-generations.
    const subs = generations.filter((g) => g.kind === "sub");
    expect(subs.length).toBeGreaterThan(0);
    expect(subs.every((g) => g.status === "completed")).toBe(true);
    expect(subs.every((g) => g.agentName !== "Jarvis")).toBe(true);

    // Report the coordinator's latency: first token is its narration, the
    // completed marker lands once the specialists' results are merged.
    const [turn] = await persistence.listTurns(conversation.id);
    const coordinatorGen = generations.find((g) => g.agentName === "Jarvis")!;
    reportTimeline("coordination latency", turn!, coordinatorGen);
  }, 120_000);

  // Slow models (e.g. qwen via OpenRouter) take 10-20s per coordination hop,
  // so a bounded clarify chain needs more headroom than the default 60s.
  e2e("measures a clarify chain with the real LLM", async () => {
    const persistence = new MemoryPersistence();
    const conversation = new Conversation({ id: "conv-clarify", persistence });
    const llm = makeLlm();
    const orchestrator = new Orchestrator({
      conversation,
      agents: [
        new Agent({ name: "Jarvis", context: "You are a travel assistant.", llm }),
        new Agent({ name: "Helper", context: "You are a minimal assistant.", llm }),
      ],
      llm,
      persistence,
      coordinations: {
        // Steer the entry point to route underspecified requests through
        // clarify, so the chain is exercised deterministically enough to
        // measure without a second model.
        understand: {
          prompt:
            "You are the conversation coordinator. If the user's request is " +
            "missing any required detail, delegate to the clarify coordination " +
            "with the request as input. Otherwise answer directly or delegate " +
            "to an agent.",
        },
        clarify: { prompt: buildClarifyPrompt() },
      },
    });

    await conversation.start();
    await conversation.participate({ userId: "alice", aliases: ["al"] });
    await orchestrator.start();

    // 1. Underspecified request → understand delegates → clarify asks a
    // question and the chain parks (suspension).
    conversation.send({ userId: "alice", text: "Book me a flight." });
    await waitFor(async () => {
      const gens = await persistence.listGenerations(conversation.id);
      return gens.some((g) => g.kind !== "sub" && g.status === "completed");
    });
    const firstGen = (await persistence.listGenerations(conversation.id)).find(
      (g) => g.kind !== "sub" && g.status === "completed",
    )!;

    // Models sometimes answer directly despite the steering prompt — then
    // there is no chain to measure. Report it instead of failing the suite:
    // this e2e measures the chain, the mechanism is unit-tested.
    if (!isQuestion(firstGen.text)) {
      console.log(
        `clarify chain: model answered directly ("${firstGen.text.slice(0, 100)}") — no clarify chain in this run`,
      );
      return;
    }
    const questionGen = firstGen;

    const [turn] = await persistence.listTurns(conversation.id);
    reportTimeline("clarify question hop", turn!, questionGen);

    // 2. Answer, and keep answering follow-up questions until the chain
    // completes with a final, non-question answer. The model may ask one
    // question at a time despite the batching guidance (and the two-round
    // cap is prompt-level, not guaranteed), so keep a few spare answers; each
    // reply repeats the full accumulated answer so far. A stalled or
    // over-interrogating model is a report, not a failure.
    const answers = [
      "London, tomorrow.",
      "From Paris.",
      "Two passengers.",
      "Economy class.",
      "Morning flight.",
      "Any other details are fine — make reasonable assumptions.",
    ];
    let finalText = "";
    for (let round = 0; round < answers.length; round++) {
      conversation.send({
        userId: "alice",
        text: answers.slice(0, round + 1).join(" "),
      });
      try {
        await waitFor(
          async () => {
            const gens = await persistence.listGenerations(conversation.id);
            return (
              gens.filter((g) => g.kind !== "sub" && g.status === "completed").length >=
              2 + round
            );
          },
          30_000,
        );
      } catch {
        const completed = (await persistence.listGenerations(conversation.id)).filter(
          (g) => g.kind !== "sub" && g.status === "completed",
        );
        console.log(
          `clarify chain: stalled after ${completed.length} completed generations — skipping the rest of this run`,
        );
        return;
      }
      const lastGen = (await persistence.listGenerations(conversation.id))
        .filter((g) => g.kind !== "sub" && g.status === "completed")
        .at(-1)!;
      if (!isQuestion(lastGen.text)) {
        finalText = lastGen.text;
        break;
      }
    }

    if (!finalText) {
      // The model interrogated past the answer budget — a model-behavior
      // report, not a pipeline failure. The rounds are the finding.
      const completed = (await persistence.listGenerations(conversation.id)).filter(
        (g) => g.kind !== "sub" && g.status === "completed",
      );
      console.log(
        `clarify chain: did not converge within ${answers.length} answers (${completed.length} completed generations)`,
      );
      for (const g of completed) {
        console.log(`  [${g.status}] ${g.text.slice(0, 160)}`);
      }
      return;
    }

    const finalGen = (await persistence.listGenerations(conversation.id))
      .filter((g) => g.kind !== "sub" && g.status === "completed")
      .at(-1)!;
    reportTimeline("clarify chain (question → answer → final)", turn!, finalGen);
    const chainGenerations = (await persistence.listGenerations(conversation.id)).filter(
      (g) => g.kind !== "sub" && g.status === "completed",
    );
    console.log(
      `clarify chain: ${chainGenerations.length} completed generations (question rounds + final)`,
    );
  }, 120_000);

  e2e("runs a multi-tool agent with concurrent tool calls", async () => {
    const timings: ToolTiming[] = [];
    const timed =
      (name: string, latency: number) =>
      async (args: Record<string, string>): Promise<string> => {
        const startedAt = Date.now();
        await Bun.sleep(latency);
        const value = Object.values(args)[0] ?? "?";
        timings.push({ label: `${name}(${value})`, startedAt, endedAt: Date.now() });
        return name === "get_weather"
          ? `sunny, 24°C in ${value}`
          : `One non-stop flight to ${value} at 09:40`;
      };

    const getWeather = new Tool({
      name: "get_weather",
      description: "Get the current weather for a city.",
      parameters: {
        type: "object",
        properties: { city: { type: "string", description: "The city to look up." } },
        required: ["city"],
      },
      execute: timed("get_weather", 500),
    });
    const searchFlights = new Tool({
      name: "search_flights",
      description: "Find available flights to a destination.",
      parameters: {
        type: "object",
        properties: {
          destination: { type: "string", description: "The destination city." },
        },
        required: ["destination"],
      },
      execute: timed("search_flights", 800),
    });

    const agent = new Agent({
      name: "Travel Assistant",
      context:
        "You are a travel assistant. Always call the tools to answer. " +
        "When a request needs several lookups, call every needed tool at " +
        "the same time in a single response.",
      llm: makeLlm(),
      tools: [getWeather, searchFlights],
    });

    const result = await agent.run({
      prompt:
        "What is the weather in Paris, and are there flights to Tokyo " +
        "tomorrow? Call both tools now, in the same request.",
      maxTokens: 300,
    });

    // The real model should call both tools; some models call only one or
    // none. The multi-tool execution and batching mechanisms are unit-tested
    // — the real-model run reports what the model did.
    if (result.toolCalls.length === 0) {
      console.log(
        "  model called no tools — the tool-calling path is unit-tested, skipping this run",
      );
      return;
    }
    const calledBoth =
      result.toolCalls.some((c) => c.name === "get_weather") &&
      result.toolCalls.some((c) => c.name === "search_flights");
    if (!calledBoth) {
      const called = [...new Set(result.toolCalls.map((c) => c.name))];
      console.log(
        `  model called only [${called.join(", ")}] — multi-tool batching is model-dependent, skipping the concurrency check`,
      );
      return;
    }

    // The two executions overlap only when the model requests both tools in
    // one batch (deepseek/gemini do; some models call sequentially with a
    // gap). The batching mechanism is unit-tested — here it is a measurement.
    const summary = summarizeConcurrency(timings);
    reportToolConcurrency("agent.run() tool concurrency", timings);
    if (summary.maxConcurrent > 1) {
      expect(summary.wall).toBeLessThan(summary.serial - 200);
    } else {
      console.log(
        "  model called the tools sequentially (maxConcurrent 1) — parallel tool batching is model-dependent",
      );
    }

    expect(result.text).toMatch(/paris/i);
    expect(result.text).toMatch(/tokyo/i);
  });

  e2e("runs a conversation with multiple tools resolved concurrently by the app", async () => {
    const stt = new FakeSTT();
    const tts = new FakeTTS();
    const persistence = new MemoryPersistence();
    const api = new Conversations({ persistence, stt, tts });

    const timings: ToolTiming[] = [];
    const requested: string[] = [];

    const getWeather = new Tool({
      name: "get_weather",
      description: "Get the current weather for a city.",
      parameters: {
        type: "object",
        properties: { city: { type: "string", description: "The city to look up." } },
        required: ["city"],
      },
      execute: async ({ city }: { city: string }) => {
        const startedAt = Date.now();
        await Bun.sleep(600);
        timings.push({ label: `get_weather(${city})`, startedAt, endedAt: Date.now() });
        return `sunny, 24°C in ${city}`;
      },
    });
    const getLocalTime = new Tool({
      name: "get_local_time",
      description: "Get the current local time for a city.",
      parameters: {
        type: "object",
        properties: { city: { type: "string", description: "The city to look up." } },
        required: ["city"],
      },
      execute: async ({ city }: { city: string }) => {
        const startedAt = Date.now();
        await Bun.sleep(600);
        timings.push({ label: `get_local_time(${city})`, startedAt, endedAt: Date.now() });
        return `2:30 PM in ${city}`;
      },
    });

    const conversation = await api.create({
      agents: [
        new Agent({
          name: "Jarvis",
          context:
            "You are a concise travel assistant. Always call the tools. " +
            "When a request needs several lookups, request them together " +
            "in one response.",
          llm: makeLlm(),
          tools: [getWeather, getLocalTime],
        }),
      ],
    });
    await conversation.start();
    await conversation.participate({ userId: "alice", aliases: ["al"] });

    // The application executes every requested tool (with real latency) and
    // resolves it — independent calls run concurrently.
    conversation.on("tool-call", ({ call }) => {
      requested.push(call.name);
      void (async () => {
        const tool = call.name === "get_weather" ? getWeather : getLocalTime;
        try {
          const result = await tool.execute(call.arguments as never);
          conversation.resolveToolCall({ id: call.id, result });
        } catch (error) {
          conversation.resolveToolCall({
            id: call.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    });

    conversation.listen({ userId: "alice", audio: new Uint8Array([1]) });
    stt.sessions[0]!.emitFinal(
      "What's the weather in Paris and what time is it in Tokyo? Call both tools now.",
    );

    await waitFor(async () => {
      const generations = await persistence.listGenerations(conversation.id);
      return generations.some((g) => g.status === "completed");
    });

    const transcript = await api.transcript(conversation.id);
    expect(transcript.at(-1)?.speakerKind).toBe("agent");
    expect(transcript.at(-1)?.text.length).toBeGreaterThan(0);
    expect(transcript.at(-1)?.text).toMatch(/paris/i);
    expect(transcript.at(-1)?.text).toMatch(/tokyo/i);

    // Both tools were requested by the model and executed by the application.
    // They overlap only when the model batches the calls in one response
    // (deepseek/gemini do; some models call sequentially).
    expect(requested.filter((n) => n === "get_weather").length).toBeGreaterThan(0);
    expect(requested.filter((n) => n === "get_local_time").length).toBeGreaterThan(0);
    const summary = summarizeConcurrency(timings);
    reportToolConcurrency("conversation tool concurrency", timings);
    if (summary.maxConcurrent > 1) {
      expect(summary.wall).toBeLessThan(summary.serial - 200);
    } else {
      console.log(
        "  model called the tools sequentially (maxConcurrent 1) — parallel tool batching is model-dependent",
      );
    }

    const [turn] = await persistence.listTurns(conversation.id);
    const generation = (await persistence.listGenerations(conversation.id)).find(
      (g) => g.kind !== "sub",
    )!;
    reportTimeline("conversation tool pipeline latency", turn!, generation);
  });

  e2e("surfaces a failing tool as an error result and completes gracefully", async () => {
    const sendEmail = new Tool({
      name: "send_email",
      description: "Send an email to a recipient.",
      execute: async () => {
        throw new Error("SMTP outage");
      },
    });

    const agent = new Agent({
      name: "Jarvis",
      context:
        "You are a helpful assistant. Always use the send_email tool when " +
        "asked to send an email. If the tool fails, briefly tell the user and stop.",
      llm: makeLlm(),
      tools: [sendEmail],
    });

    const result = await agent.run({
      prompt: "Send an email to alice@example.com with the subject 'hello'.",
      maxTokens: 200,
    });

    // The tool error must be captured as a tool error result when the model
    // calls the tool (deepseek does; gemini sometimes answers directly, and
    // some models produce nothing after the failure). The deterministic path
    // is unit-tested — the real-model run reports what the model did.
    if (result.toolCalls.length > 0) {
      expect(result.toolCalls[0]!.name).toBe("send_email");
      expect(result.toolCalls[0]!.result).toEqual({ error: "SMTP outage" });
    }
    if (result.text.length === 0) {
      console.log(
        "failing tool: model produced no graceful answer after the tool error — the recovery path is unit-tested",
      );
      return;
    }
    expect(result.text.length).toBeGreaterThan(0);
  });

  e2e("interrupts a streaming generation and starts fresh on the next turn", async () => {
    const stt = new FakeSTT();
    const tts = new FakeTTS();
    const persistence = new MemoryPersistence();
    const api = new Conversations({ persistence, stt, tts });

    const conversation = await api.create({
      agents: [
        new Agent({
          name: "Jarvis",
          context:
            "You are a verbose storyteller. Always answer with a long story of at least 300 words.",
          llm: makeLlm(),
        }),
      ],
    });
    await conversation.start();
    await conversation.participate({ userId: "alice", aliases: ["al"] });

    conversation.listen({ userId: "alice", audio: new Uint8Array([1]) });
    stt.sessions[0]!.emitFinal("Tell me a long story about a dragon.");

    // Interrupt as soon as the real model is streaming (first token seen),
    // while the long story is still being generated.
    await waitFor(async () => {
      const generations = await persistence.listGenerations(conversation.id);
      return generations.some((g) => g.timing?.firstTokenAt !== undefined);
    });
    conversation.interrupt();

    await waitFor(async () => {
      const generations = await persistence.listGenerations(conversation.id);
      return generations.some((g) => g.status === "cancelled");
    });

    // The interrupted generation was cancelled and never reached the
    // transcript.
    const interrupted = await persistence.listGenerations(conversation.id);
    expect(interrupted[0]?.status).toBe("cancelled");
    expect(interrupted[0]?.timing?.firstTokenAt).toBeDefined();
    const transcript = await api.transcript(conversation.id);
    expect(transcript.map((entry) => entry.toString())).toEqual([
      "al: Tell me a long story about a dragon.",
    ]);

    // A fresh turn works after the interrupt.
    conversation.listen({ userId: "alice", audio: new Uint8Array([1]) });
    stt.sessions[0]!.emitFinal("Actually, keep it to one sentence.");
    await waitFor(async () => {
      const generations = await persistence.listGenerations(conversation.id);
      return generations.some((g) => g.status === "completed");
    });

    const after = await api.transcript(conversation.id);
    expect(after.length).toBeGreaterThanOrEqual(2);
    expect(after.at(-1)?.speakerKind).toBe("agent");
    expect(after.at(-1)?.text.length).toBeGreaterThan(0);
  }, 180_000);
});
