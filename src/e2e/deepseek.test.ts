import { describe, expect, test } from "bun:test";
import { Agent } from "../agents/agent";
import { Tool } from "../agents/tools/tools";
import { Conversations } from "../conversations/conversations";
import { MemoryPersistence } from "../persistence/adapters/memory/memory";
import { DeepSeekLLM } from "../providers/llm/adapters/deepseek/deepseek";
import type { STT, STTOptions, STTSession } from "../providers/stt/types";
import type { TTS, TTSRequest } from "../providers/tts/types";
import type { Generation, GenerationTiming, Turn } from "../conversations/types";

// End-to-end tests against the real DeepSeek API. They need a
// DEEPSEEK_API_KEY in the environment (`.env` is loaded automatically) and
// are skipped when it is missing, so CI stays green without credentials.
// STT and TTS are faked — only the LLM is real — which exercises the full
// conversation pipeline (routing, generations, transcripts, coordination)
// against a real model.

const apiKey = process.env.DEEPSEEK_API_KEY;
const hasKey = typeof apiKey === "string" && apiKey.length > 0;

/** Register an e2e test, skipped when no API key is available. */
function e2e(name: string, fn: () => Promise<void>): void {
  if (hasKey) {
    test(name, fn, 60_000);
  } else {
    test.skip(name, fn);
  }
}

function makeLlm(): DeepSeekLLM {
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
  readonly requests: Array<TTSRequest & { firstChunkAt?: number }> = [];
  async *stream(request: TTSRequest): AsyncGenerator<Uint8Array> {
    const entry = { ...request, firstChunkAt: Date.now() };
    this.requests.push(entry);
    yield new TextEncoder().encode(request.text);
  }
  stop(): void {}
}

/**
 * Print the latency timeline of a generation relative to its turn boundary.
 *
 * ```text
 * Turn boundary       0ms
 * LLM first token   +280ms
 * TTS first chunk   +410ms
 * Audio delivered   +430ms
 * LLM completed    +1,240ms
 * ```
 */
function reportTimeline(
  label: string,
  turn: Turn,
  generation: Generation,
  ttsRequests: Array<{ firstChunkAt?: number }>,
): void {
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
  row("LLM first token", timing.firstTokenAt);
  row("TTS first chunk", ttsRequests[0]?.firstChunkAt);
  row("Audio delivered", timing.firstAudioAt);
  row("LLM completed", timing.completedAt);
}

async function waitFor(
  condition: () => Promise<boolean> | boolean,
  timeoutMs = 30_000,
): Promise<void> {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await Bun.sleep(50);
  }
}

describe("DeepSeek e2e (requires DEEPSEEK_API_KEY)", () => {
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

    // The real model requested the tool, the agent executed it, and the
    // final answer mentions the tool's result.
    expect(result.toolCalls.length).toBeGreaterThan(0);
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

    conversation.listen({ userId: "alice", audio: new Uint8Array([1]) });
    stt.sessions[0]!.emitFinal("Hello! In one sentence, what is Pipeflow?");

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
    expect(timing.firstAudioAt).toBeDefined();
    expect(timing.completedAt).toBeDefined();
    reportTimeline("conversation pipeline latency", turn!, generation, tts.requests);
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

    conversation.listen({ userId: "alice", audio: new Uint8Array([1]) });
    stt.sessions[0]!.emitFinal(
      "Book a flight to London tomorrow AND check whether my Tuesday afternoon is free. Do both.",
    );

    await waitFor(async () => {
      const generations = await persistence.listGenerations(conversation.id);
      // Wait for the coordinator's own generation (the sub-generations
      // complete first, before their results reach the merged answer).
      return generations.some(
        (g) => g.agentName === "Jarvis" && g.status === "completed",
      );
    });

    // The `understand` coordination ran against the real model: the user
    // turn, at least one specialist's work, and the coordinator's merged
    // answer.
    const transcript = await api.transcript(conversation.id);
    expect(transcript.length).toBeGreaterThanOrEqual(3);
    expect(transcript.at(-1)?.speakerKind).toBe("agent");
    expect(transcript.at(-1)?.text.length).toBeGreaterThan(0);

    // The specialist work was persisted as completed sub-generations.
    const generations = await persistence.listGenerations(conversation.id);
    const subs = generations.filter((g) => g.kind === "sub");
    expect(subs.length).toBeGreaterThan(0);
    expect(subs.every((g) => g.status === "completed")).toBe(true);
    expect(subs.every((g) => g.agentName !== "Jarvis")).toBe(true);

    // Report the coordinator's latency: first token is its narration, the
    // completed marker lands once the specialists' results are merged.
    const [turn] = await persistence.listTurns(conversation.id);
    const coordinatorGen = generations.find((g) => g.agentName === "Jarvis")!;
    reportTimeline("coordination latency", turn!, coordinatorGen, tts.requests);
  });
});
