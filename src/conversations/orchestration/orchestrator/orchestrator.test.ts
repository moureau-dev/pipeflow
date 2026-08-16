import { describe, expect, test } from "bun:test";
import { Agent } from "../../../agents/agent";
import { Tool } from "../../../agents/tools/tools";
import { Conversation } from "../../conversation/conversation";
import { MemoryPersistence } from "../../../persistence/adapters/memory/memory";
import {
  Orchestrator,
  pickAgent,
  formatTimeContext,
  formatTurnContext,
} from "./orchestrator";
import type { AudioChunk, ToolCall, UserId } from "../../types";
import type {
  LLM,
  LLMEvent,
  LLMRequest,
} from "../../../providers/llm/types";
import type { STT, STTOptions, STTSession } from "../../../providers/stt/types";
import type { TTS, TTSRequest } from "../../../providers/tts/types";

// ---------------------------------------------------------------------------
// Fake providers
// ---------------------------------------------------------------------------

type LLMScript = (request: LLMRequest, signal: AbortSignal) => AsyncIterable<LLMEvent>;

class FakeLLM implements LLM {
  readonly requests: LLMRequest[] = [];
  readonly stopCalls: number[] = [];
  private readonly controllers = new Set<AbortController>();

  constructor(private readonly script: LLMScript) {}

  async *stream(request: LLMRequest): AsyncGenerator<LLMEvent> {
    const controller = new AbortController();
    this.controllers.add(controller);
    this.requests.push(request);
    try {
      for await (const event of this.script(request, controller.signal)) {
        if (controller.signal.aborted) {
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        yield event;
      }
    } finally {
      this.controllers.delete(controller);
    }
  }

  stop(): void {
    this.stopCalls.push(Date.now());
    for (const controller of this.controllers) controller.abort();
  }
}

class FakeSTT implements STT {
  readonly sessions: FakeSTTSession[] = [];
  readonly startOptions: STTOptions[] = [];

  start(options: STTOptions = {}): FakeSTTSession {
    const session = new FakeSTTSession();
    this.sessions.push(session);
    this.startOptions.push(options);
    return session;
  }

  cancel(): void {}
}

type FakeSessionEvent = "partial" | "final" | "error";

class FakeSTTSession implements STTSession {
  readonly written: Uint8Array[] = [];
  ended = 0;
  private readonly listeners: Record<
    FakeSessionEvent,
    Set<(...args: any[]) => void>
  > = {
    partial: new Set(),
    final: new Set(),
    error: new Set(),
  };

  write(audio: Uint8Array): void {
    this.written.push(audio);
  }

  async end(): Promise<void> {
    this.ended++;
  }

  on(event: "partial", listener: (transcript: string) => void): void;
  on(event: "final", listener: (transcript: string) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: FakeSessionEvent, listener: (...args: any[]) => void): void {
    this.listeners[event].add(listener);
  }

  emitPartial(text: string): void {
    for (const listener of this.listeners.partial) listener(text);
  }

  emitFinal(text: string): void {
    for (const listener of this.listeners.final) listener(text);
  }

  emitError(error: Error): void {
    for (const listener of this.listeners.error) listener(error);
  }
}

class FakeTTS implements TTS {
  readonly requests: TTSRequest[] = [];
  private readonly controllers = new Set<AbortController>();

  constructor(private readonly chunksFor: (text: string) => Uint8Array[]) {}

  async *stream(request: TTSRequest): AsyncGenerator<Uint8Array> {
    this.requests.push(request);
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      for (const chunk of this.chunksFor(request.text)) {
        if (controller.signal.aborted) {
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        yield chunk;
      }
    } finally {
      this.controllers.delete(controller);
    }
  }

  stop(): void {
    for (const controller of this.controllers) controller.abort();
  }
}

/**
 * A TTS that streams one chunk at a time with a delay, so audio is still
 * mid-flight when an interrupt arrives.
 */
class SlowTTS implements TTS {
  readonly requests: TTSRequest[] = [];
  private readonly controllers = new Set<AbortController>();

  constructor(
    private readonly chunksFor: (text: string) => Uint8Array[],
    private readonly delayMs = 20,
  ) {}

  async *stream(request: TTSRequest): AsyncGenerator<Uint8Array> {
    this.requests.push(request);
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      for (const chunk of this.chunksFor(request.text)) {
        await Bun.sleep(this.delayMs);
        if (controller.signal.aborted) {
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        yield chunk;
      }
    } finally {
      this.controllers.delete(controller);
    }
  }

  stop(): void {
    for (const controller of this.controllers) controller.abort();
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type TtsHarness = FakeTTS | SlowTTS;

interface Harness {
  conversation: Conversation;
  orchestrator: Orchestrator;
  llm: FakeLLM;
  stt: FakeSTT;
  tts: TtsHarness;
  persistence: MemoryPersistence;
}

function setup(options: {
  script: LLMScript;
  ttsChunks?: (text: string) => Uint8Array[];
  tts?: TtsHarness;
  tools?: Tool<never, unknown>[];
  toolTimeoutMs?: number;
  context?: string;
}): Promise<Harness> {
  return (async () => {
    const persistence = new MemoryPersistence();
    const conversation = new Conversation({ id: "conv-1", persistence });
    const llm = new FakeLLM(options.script);
    const stt = new FakeSTT();
    const tts =
      options.tts ??
      new FakeTTS(
        options.ttsChunks ?? ((text) => [new TextEncoder().encode(text)]),
      );
    const agent = new Agent({
      name: "Jarvis",
      context: options.context ?? "Be concise.",
      llm,
      tools: options.tools,
    });
    const orchestrator = new Orchestrator({
      conversation,
      agents: [agent],
      llm,
      stt,
      tts,
      persistence,
      toolTimeoutMs: options.toolTimeoutMs ?? 30_000,
    });

    conversation.start();
    await conversation.participate({ userId: "alice", aliases: ["al"] });
    await orchestrator.start();

    return { conversation, orchestrator, llm, stt, tts, persistence };
  })();
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await Bun.sleep(2);
  }
}

async function speak(harness: Harness, userId: string, text: string): Promise<void> {
  harness.conversation.listen({ userId, audio: new Uint8Array([1]) });
  harness.stt.sessions.at(-1)!.emitFinal(text);
  await harness.orchestrator.whenIdle();
}

function respond(text: string): LLMScript {
  return async function* () {
    yield { type: "delta", content: text };
    yield { type: "done" };
  };
}

test("formatTurnContext appends time, speaker, and roster", () => {
  const date = new Date(2026, 7, 16, 14, 30); // 16 aug 2026, 14:30
  expect(
    formatTurnContext(
      { userId: "alice", aliases: ["al"], joinedAt: 0 },
      [{ userId: "alice", aliases: ["al"], joinedAt: 0 }],
      date,
    ),
  ).toBe(
    "\n\nAdditional context: Now it is 16 aug 2026, 14:30. " +
      "The current user is al with user id alice (aliases: al).",
  );
  expect(
    formatTurnContext(
      { userId: "alice", aliases: ["al"], joinedAt: 0 },
      [
        { userId: "alice", aliases: ["al"], joinedAt: 0 },
        { userId: "bob", aliases: ["robert", "rob"], joinedAt: 0 },
      ],
      date,
    ),
  ).toBe(
    "\n\nAdditional context: Now it is 16 aug 2026, 14:30. " +
      "The current user is al with user id alice (aliases: al). " +
      "The other participants are robert with user id bob (aliases: robert, rob).",
  );
});

// ---------------------------------------------------------------------------
// Multi-agent roster harness (coordinator + named specialists)
// ---------------------------------------------------------------------------

type RosterHarness = Harness & { llms: Map<string, FakeLLM> };

function setupRoster(options: {
  coordinatorScript: LLMScript;
  scripts: Record<string, LLMScript>;
  tools?: Record<string, Tool<never, unknown>[]>;
  coordinations?: Array<{ name: string; prompt: string; llm: FakeLLM }>;
  maxCoordinationSteps?: number;
}): Promise<RosterHarness> {
  return (async () => {
    const persistence = new MemoryPersistence();
    const conversation = new Conversation({ id: "conv-1", persistence });
    const stt = new FakeSTT();
    const tts = new FakeTTS((text) => [new TextEncoder().encode(text)]);

    const coordinatorLlm = new FakeLLM(options.coordinatorScript);
    const llms = new Map<string, FakeLLM>([["Jarvis", coordinatorLlm]]);
    const agents: Agent[] = [
      new Agent({ name: "Jarvis", context: "Be concise.", llm: coordinatorLlm }),
    ];
    for (const [name, script] of Object.entries(options.scripts)) {
      const llm = new FakeLLM(script);
      llms.set(name, llm);
      agents.push(
        new Agent({
          name,
          context: `You are ${name}.`,
          llm,
          tools: options.tools?.[name],
        }),
      );
    }
    // The built-in `understand` coordination only activates with a roster of
    // more than one agent, so guarantee one for tests that only exercise the
    // coordination itself.
    if (agents.length === 1) {
      const helperLlm = new FakeLLM(respond("ok"));
      llms.set("Helper", helperLlm);
      agents.push(new Agent({ name: "Helper", context: "You help.", llm: helperLlm }));
    }
    for (const coordination of options.coordinations ?? []) {
      llms.set(coordination.name, coordination.llm);
    }

    const orchestrator = new Orchestrator({
      conversation,
      agents,
      llm: coordinatorLlm,
      coordinations: (options.coordinations ?? []).map((coordination) => ({
        name: coordination.name,
        prompt: coordination.prompt,
        llm: coordination.llm,
      })),
      maxCoordinationSteps: options.maxCoordinationSteps,
      stt,
      tts,
      persistence,
    });

    conversation.start();
    await conversation.participate({ userId: "alice", aliases: ["al"] });
    await orchestrator.start();

    return { conversation, orchestrator, llm: coordinatorLlm, stt, tts, persistence, llms };
  })();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Orchestrator", () => {
  test("requires an LLM", () => {
    const conversation = new Conversation({ id: "conv-1" });
    const agent = new Agent({ name: "Jarvis" });
    const stt = new FakeSTT();
    const tts = new FakeTTS(() => []);
    expect(
      () => new Orchestrator({ conversation, agents: [agent], stt, tts }),
    ).toThrow(/requires an LLM/);
  });

  test("agents attach without STT or TTS (text-only conversations)", () => {
    const conversation = new Conversation({ id: "conv-1" });
    const agent = new Agent({ name: "Jarvis", llm: new FakeLLM(respond("ok")) });
    expect(() => new Orchestrator({ conversation, agents: [agent] })).not.toThrow();
  });

  test("transcription-only mode works without an agent", async () => {
    const persistence = new MemoryPersistence();
    const conversation = new Conversation({ id: "conv-1", persistence });
    const stt = new FakeSTT();
    const orchestrator = new Orchestrator({ conversation, stt, persistence });

    conversation.start();
    await conversation.participate({ userId: "alice", aliases: ["al"] });
    await orchestrator.start();

    conversation.listen({ userId: "alice", audio: new Uint8Array([1]) });
    stt.sessions[0]!.emitPartial("hello");
    stt.sessions[0]!.emitFinal("Hello from the meeting.");
    await orchestrator.whenIdle();

    // Turns and transcript are recorded — no generation is produced.
    const turns = await persistence.listTurns("conv-1");
    expect(turns.map((t) => [t.participantName, t.text])).toEqual([
      ["al", "Hello from the meeting."],
    ]);
    const transcript = await persistence.listTranscript("conv-1");
    expect(transcript.map((e) => e.toString())).toEqual([
      "al: Hello from the meeting.",
    ]);
    expect(await persistence.listGenerations("conv-1")).toEqual([]);
  });

  test("routes a text turn from send() without STT or TTS", async () => {
    const persistence = new MemoryPersistence();
    const conversation = new Conversation({
      id: "conv-1",
      persistence,
      agents: [
        new Agent({
          name: "Jarvis",
          llm: new FakeLLM(respond("Hello, text world!")),
        }),
      ],
    });

    // With agents present, start() attaches the orchestrator on its own.
    await conversation.start();
    await conversation.participate({ userId: "alice", aliases: ["al"] });

    // A text turn goes through the same pipeline as a transcribed one:
    // turn, transcript, and generation, with no STT or TTS involved.
    conversation.send({ userId: "alice", text: "Hello?" });
    const deadline = Date.now() + 2000;
    for (;;) {
      const generations = await persistence.listGenerations("conv-1");
      if (generations.some((g) => g.status === "completed")) break;
      if (Date.now() > deadline) throw new Error("generation did not complete");
      await Bun.sleep(5);
    }

    const turns = await persistence.listTurns("conv-1");
    expect(turns.map((t) => [t.participantName, t.text])).toEqual([["al", "Hello?"]]);
    const transcript = await persistence.listTranscript("conv-1");
    expect(transcript.map((e) => e.toString())).toEqual([
      "al: Hello?",
      "Jarvis: Hello, text world!",
    ]);
    const generations = await persistence.listGenerations("conv-1");
    expect(generations.map((g) => [g.agentName, g.text, g.status])).toEqual([
      ["Jarvis", "Hello, text world!", "completed"],
    ]);
  });

  test("stamps the other participants into the turn context", async () => {
    const persistence = new MemoryPersistence();
    const llm = new FakeLLM(respond("ok"));
    const conversation = new Conversation({
      id: "conv-1",
      persistence,
      agents: [new Agent({ name: "Jarvis", llm })],
    });
    await conversation.start();
    await conversation.participate([
      { userId: "alice", aliases: ["al"] },
      { userId: "bob", aliases: ["robert", "rob"] },
    ]);

    // "enhance the message Bob sent" — the model must know who Bob is even
    // though he has never spoken.
    conversation.send({ userId: "alice", text: "Enhance the message Bob sent." });
    const deadline = Date.now() + 2000;
    for (;;) {
      const done = await persistence.listGenerations("conv-1");
      if (done.some((g) => g.status === "completed")) break;
      if (Date.now() > deadline) throw new Error("generation did not complete");
      await Bun.sleep(5);
    }

    expect(llm.requests[0]!.messages.at(-1)).toEqual({
      role: "user",
      content: expect.stringMatching(
        /^al: Enhance the message Bob sent\.\n\nAdditional context: Now it is \d{1,2} [a-z]{3} \d{4}, \d{2}:\d{2}\. The current user is al with user id alice \(aliases: al\)\. The other participants are robert with user id bob \(aliases: robert, rob\)\.$/,
      ),
    });
  });

  test("routes audio to an STT session and streams the full pipeline", async () => {
    const harness = await setup({
      script: async function* () {
        yield { type: "delta", content: "Hello there! " };
        yield { type: "delta", content: "How can I help?" };
        yield { type: "done" };
      },
    });
    const audioOut: AudioChunk[] = [];
    harness.conversation.on("audio", (payload) => audioOut.push(payload.audio));

    harness.conversation.listen({ userId: "alice", audio: new Uint8Array([9, 9]) });
    const session = harness.stt.sessions[0]!;
    expect([...session.written[0]!]).toEqual([9, 9]);

    session.emitFinal("Hello there.");
    await harness.orchestrator.whenIdle();

    // Turn persisted.
    const turns = await harness.persistence.listTurns("conv-1");
    expect(turns.map((t) => [t.participantName, t.text])).toEqual([
      ["al", "Hello there."],
    ]);

    // LLM saw the system context and the user turn with its automatic
    // context suffix (time + speaker).
    expect(harness.llm.requests[0]!.messages).toEqual([
      { role: "system", name: "Jarvis", content: "Be concise." },
      {
        role: "user",
        content: expect.stringMatching(
          /^al: Hello there\.\n\nAdditional context: Now it is \d{1,2} [a-z]{3} \d{4}, \d{2}:\d{2}\. The current user is al with user id alice \(aliases: al\)\.$/,
        ),
      },
    ]);

    // Deltas were buffered into sentences and synthesized in order.
    expect(harness.tts.requests.map((r) => r.text)).toEqual([
      "Hello there!",
      "How can I help?",
    ]);

    // Every synthesized chunk reached the app as audio-out.
    const bytes = audioOut.flatMap((chunk) => [...chunk.data]);
    expect(bytes).toEqual([
      ...new TextEncoder().encode("Hello there!"),
      ...new TextEncoder().encode("How can I help?"),
    ]);

    // Transcript: participant turn + agent generation.
    const transcript = await harness.persistence.listTranscript("conv-1");
    expect(transcript.map((e) => e.toString())).toEqual([
      "al: Hello there.",
      "Jarvis: Hello there! How can I help?",
    ]);

    // Generation completed with the full text.
    const generations = await harness.persistence.listGenerations("conv-1");
    expect(generations[0]?.status).toBe("completed");
    expect(generations[0]?.text).toBe("Hello there! How can I help?");
  });

  test("buffers multi-sentence deltas into separate TTS requests", async () => {
    const harness = await setup({
      script: respond("It is sunny. Very sunny indeed!"),
    });

    await speak(harness, "alice", "What is the weather?");

    expect(harness.tts.requests.map((r) => r.text)).toEqual([
      "It is sunny.",
      "Very sunny indeed!",
    ]);
  });

  test("records latency timing on generations", async () => {
    const harness = await setup({ script: respond("Hello there!") });

    await speak(harness, "alice", "Hi.");

    const [generation] = await harness.persistence.listGenerations("conv-1");
    const timing = generation!.timing!;
    expect(timing.startedAt).toBeDefined();
    expect(timing.firstTokenAt).toBeDefined();
    expect(timing.firstTtsTextAt).toBeDefined();
    expect(timing.firstTtsRequestAt).toBeDefined();
    expect(timing.firstTtsAudioAt).toBeDefined();
    expect(timing.firstAudioAt).toBeDefined();
    expect(timing.completedAt).toBeDefined();
    // The latency chain is ordered: start → token → buffered text → TTS
    // request → provider audio → delivered → done.
    expect(timing.startedAt).toBeLessThanOrEqual(timing.firstTokenAt!);
    expect(timing.firstTokenAt!).toBeLessThanOrEqual(timing.firstTtsTextAt!);
    expect(timing.firstTtsTextAt!).toBeLessThanOrEqual(timing.firstTtsRequestAt!);
    expect(timing.firstTtsRequestAt!).toBeLessThanOrEqual(timing.firstTtsAudioAt!);
    expect(timing.firstTtsAudioAt!).toBeLessThanOrEqual(timing.firstAudioAt!);
    expect(timing.firstAudioAt!).toBeLessThanOrEqual(timing.completedAt!);
  });

  test("interrupt stops in-flight TTS audio from reaching the app", async () => {
    const slowTts = new SlowTTS(
      (text) => text.split(" ").map((word) => new TextEncoder().encode(word + " ")),
    );
    const harness = await setup({
      script: respond(
        "The dragon flew over the mountains and then it landed on the castle.",
      ),
      tts: slowTts,
    });
    const delivered: number[] = [];
    let lastAudioAt = 0;
    harness.conversation.on("audio", (payload) => {
      delivered.push(payload.audio.sequence);
      lastAudioAt = Date.now();
    });

    harness.conversation.listen({ userId: "alice", audio: new Uint8Array([1]) });
    harness.stt.sessions[0]!.emitFinal("Tell me about the dragon.");
    // Wait until audio is actually streaming to the application.
    await waitFor(() => delivered.length > 0);

    // Interrupt while many chunks are still queued in the slow TTS stream.
    const interruptAt = Date.now();
    harness.conversation.interrupt();
    await harness.orchestrator.whenIdle();
    await Bun.sleep(60); // let the in-flight speech chain settle

    // The remaining synthesized chunks never reached the application, and
    // the last one stopped quickly: interrupt responsiveness is a first-
    // class invariant, not an optimization.
    const deliveredAtInterrupt = delivered.length;
    await Bun.sleep(100);
    expect(delivered.length).toBe(deliveredAtInterrupt);
    expect(lastAudioAt - interruptAt).toBeLessThan(100);
  });

  test("emits partial transcripts for live captions", async () => {
    const harness = await setup({ script: respond("Ok!") });
    const partials: { userId: UserId; text: string }[] = [];
    harness.conversation.on("partial-transcript", (payload) =>
      partials.push({ userId: payload.userId, text: payload.text }),
    );

    harness.conversation.listen({ userId: "alice", audio: new Uint8Array([1]) });
    const session = harness.stt.sessions[0]!;
    session.emitPartial("hello ");
    session.emitPartial("hello world");
    await harness.orchestrator.whenIdle();

    expect(partials).toEqual([
      { userId: "alice", text: "hello" },
      { userId: "alice", text: "hello world" },
    ]);
  });

  test("pauses for a tool call, emits it to the app, and resumes with the result", async () => {
    const getWeather = new Tool<{ city: string }, string>({
      name: "get_weather",
      description: "Get the weather for a city.",
      execute: async ({ city }) => `sunny in ${city}`,
    });

    const harness = await setup({
      tools: [getWeather],
      script: async function* (request) {
        if (request.messages.at(-1)?.role === "tool") {
          yield { type: "delta", content: "It is sunny in Paris!" };
          yield { type: "done" };
          return;
        }
        yield { type: "delta", content: "Let me check the weather for you. " };
        yield {
          type: "tool_call",
          id: "call_1",
          name: "get_weather",
          arguments: '{"city":"Paris"}',
        };
        yield { type: "done" };
      },
    });

    const toolCalls: ToolCall[] = [];
    harness.conversation.on("tool-call", (payload) => {
      toolCalls.push(payload.call);
      // The application executes the tool in its own backend.
      harness.conversation.resolveToolCall({
        id: payload.call.id,
        result: `sunny in ${(payload.call.arguments as { city: string }).city}`,
      });
    });

    await speak(harness, "alice", "What is the weather in Paris?");

    // The tool call was surfaced with parsed arguments.
    expect(toolCalls).toEqual([
      { id: "call_1", name: "get_weather", arguments: { city: "Paris" } },
    ]);

    // Two LLM round trips; the second carries the tool result.
    expect(harness.llm.requests).toHaveLength(2);
    expect(harness.llm.requests[1]!.messages.at(-1)).toEqual({
      role: "tool",
      toolCallId: "call_1",
      name: "get_weather",
      content: '"sunny in Paris"',
    });

    // The narration was spoken, then the final answer.
    expect(harness.tts.requests.map((r) => r.text)).toEqual([
      "Let me check the weather for you.",
      "It is sunny in Paris!",
    ]);

    const transcript = await harness.persistence.listTranscript("conv-1");
    expect(transcript.at(-1)?.toString()).toBe(
      "Jarvis: Let me check the weather for you. It is sunny in Paris!",
    );
  });

  test("times out tool calls the application never resolves", async () => {
    const harness = await setup({
      toolTimeoutMs: 20,
      tools: [
        new Tool({
          name: "get_weather",
          description: "Weather.",
          execute: () => "sunny",
        }),
      ],
      script: async function* (request) {
        if (request.messages.at(-1)?.role === "tool") {
          yield { type: "delta", content: "Let me try something else." };
          yield { type: "done" };
          return;
        }
        yield { type: "tool_call", id: "call_1", name: "get_weather", arguments: "{}" };
        yield { type: "done" };
      },
    });

    // No listener resolves the tool call — it must time out gracefully.
    await speak(harness, "alice", "What is the weather?");

    const second = harness.llm.requests[1]!.messages.at(-1);
    expect(second?.role).toBe("tool");
    expect(String((second as { content: string }).content)).toContain("timed out");
    expect(harness.llm.requests[1]!.messages.at(-2)).toMatchObject({
      role: "assistant",
      toolCalls: [{ id: "call_1", name: "get_weather" }],
    });
  });

  test("interrupt cancels the generation and discards it from the transcript", async () => {
    let calls = 0;
    const harness = await setup({
      script: async function* (_request, signal) {
        const n = calls++;
        if (n === 0) {
          yield { type: "delta", content: "Let me look that up." };
          while (!signal.aborted) {
            await Bun.sleep(2);
          }
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        yield { type: "delta", content: "Second answer!" };
        yield { type: "done" };
      },
    });

    harness.conversation.listen({ userId: "alice", audio: new Uint8Array([1]) });
    const session = harness.stt.sessions[0]!;
    session.emitFinal("First question?");
    await waitFor(() => harness.llm.requests.length === 1);

    harness.conversation.interrupt();
    await harness.orchestrator.whenIdle();

    // The interrupted generation is marked cancelled, not completed.
    const generations = await harness.persistence.listGenerations("conv-1");
    expect(generations[0]?.status).toBe("cancelled");

    // A fresh turn works after the interrupt.
    session.emitFinal("Second question?");
    await harness.orchestrator.whenIdle();
    expect(harness.llm.requests).toHaveLength(2);

    // The cancelled narration never made it into the transcript.
    const transcript = await harness.persistence.listTranscript("conv-1");
    expect(transcript.map((e) => e.toString())).toEqual([
      "al: First question?",
      "al: Second question?",
      "Jarvis: Second answer!",
    ]);
  });

  test("barge-in: audio during a generation interrupts it automatically", async () => {
    let calls = 0;
    const harness = await setup({
      script: async function* (_request, signal) {
        const n = calls++;
        if (n === 0) {
          yield { type: "delta", content: "Let me look that up." };
          while (!signal.aborted) {
            await Bun.sleep(2);
          }
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        yield { type: "delta", content: "New answer!" };
        yield { type: "done" };
      },
    });

    harness.conversation.listen({ userId: "alice", audio: new Uint8Array([1]) });
    const session = harness.stt.sessions[0]!;
    session.emitFinal("First question?");
    await waitFor(() => harness.llm.requests.length === 1);

    // The participant starts speaking while the agent is responding.
    harness.conversation.listen({ userId: "alice", audio: new Uint8Array([2, 2]) });

    // The agent's generation was interrupted.
    const generations = await harness.persistence.listGenerations("conv-1");
    expect(generations[0]?.status).toBe("cancelled");

    // The barge-in audio was still written to STT.
    expect(session.written.length).toBeGreaterThanOrEqual(2);

    session.emitFinal("Actually, never mind.");
    await harness.orchestrator.whenIdle();

    expect(harness.llm.requests).toHaveLength(2);
    const transcript = await harness.persistence.listTranscript("conv-1");
    expect(transcript.at(-1)?.toString()).toBe("Jarvis: New answer!");
  });

  test("multi-turn history supports clarification follow-ups", async () => {
    let calls = 0;
    const harness = await setup({
      script: async function* () {
        const n = calls++;
        yield {
          type: "delta",
          content: n === 0 ? "Which city?" : "It is sunny in London!",
        };
        yield { type: "done" };
      },
    });

    await speak(harness, "alice", "What is the weather?");
    await speak(harness, "alice", "In London.");

    // The second request carries the whole exchange so the follow-up
    // answer can reference it; each turn carries its own context suffix.
    expect(harness.llm.requests[1]!.messages).toEqual([
      { role: "system", name: "Jarvis", content: "Be concise." },
      {
        role: "user",
        content: expect.stringMatching(
          /^al: What is the weather\?\n\nAdditional context: Now it is \d{1,2} [a-z]{3} \d{4}, \d{2}:\d{2}\. The current user is al with user id alice \(aliases: al\)\.$/,
        ),
      },
      { role: "assistant", name: "Jarvis", content: "Which city?" },
      {
        role: "user",
        content: expect.stringMatching(
          /^al: In London\.\n\nAdditional context: Now it is \d{1,2} [a-z]{3} \d{4}, \d{2}:\d{2}\. The current user is al with user id alice \(aliases: al\)\.$/,
        ),
      },
    ]);
    expect(harness.tts.requests.map((r) => r.text)).toEqual([
      "Which city?",
      "It is sunny in London!",
    ]);
  });

  test("routes each turn to the addressed agent and uses its own LLM", async () => {
    const persistence = new MemoryPersistence();
    const conversation = new Conversation({ id: "conv-1", persistence });
    const receptionistLlm = new FakeLLM(respond("How can I help?"));
    const specialistLlm = new FakeLLM(respond("Let me look into that."));
    const stt = new FakeSTT();
    const tts = new FakeTTS((text) => [new TextEncoder().encode(text)]);
    const receptionist = new Agent({
      name: "Receptionist",
      context: "You greet people.",
      llm: receptionistLlm,
    });
    const specialist = new Agent({
      name: "Technical Specialist",
      aliases: ["tech"],
      context: "You solve technical problems.",
      llm: specialistLlm,
    });
    const orchestrator = new Orchestrator({
      conversation,
      agents: [receptionist, specialist],
      stt,
      tts,
      persistence,
    });

    conversation.start();
    await conversation.participate({ userId: "alice", aliases: ["al"] });
    await orchestrator.start();

    // An unaddressed turn runs through the built-in `understand` coordination
    // (on the shared LLM), which answers directly here.
    conversation.listen({ userId: "alice", audio: new Uint8Array([1]) });
    stt.sessions[0]!.emitFinal("Hello there.");
    await orchestrator.whenIdle();

    expect(receptionistLlm.requests).toHaveLength(1);
    expect(specialistLlm.requests).toHaveLength(0);
    // Understand's system prompt lists the roster and routes the turn.
    const understandMessages = receptionistLlm.requests[0]!.messages;
    expect(understandMessages[0]!.role).toBe("system");
    expect(String(understandMessages[0]!.content)).toContain("coordinator");
    expect(String(understandMessages[0]!.content)).toContain("Technical Specialist");
    expect(understandMessages.at(-1)).toEqual({
      role: "user",
      content: expect.stringMatching(
        /^al: Hello there\.\n\nAdditional context: Now it is \d{1,2} [a-z]{3} \d{4}, \d{2}:\d{2}\. The current user is al with user id alice \(aliases: al\)\.$/,
      ),
    });

    // An addressed turn goes straight to the specialist — and runs on the
    // specialist's own LLM rather than through the coordination.
    stt.sessions[0]!.emitFinal("Ask the technical specialist to fix it.");
    await orchestrator.whenIdle();

    expect(specialistLlm.requests).toHaveLength(1);
    expect(receptionistLlm.requests).toHaveLength(1);
    // The specialist gets its own system context plus the shared history,
    // with the coordination's reply attributed by name and each turn
    // carrying its automatic context suffix.
    expect(specialistLlm.requests[0]!.messages).toEqual([
      {
        role: "system",
        name: "Technical Specialist",
        content: "You solve technical problems.",
      },
      {
        role: "user",
        content: expect.stringMatching(
          /^al: Hello there\.\n\nAdditional context: Now it is \d{1,2} [a-z]{3} \d{4}, \d{2}:\d{2}\. The current user is al with user id alice \(aliases: al\)\.$/,
        ),
      },
      {
        role: "assistant",
        name: "Receptionist",
        content: "How can I help?",
      },
      {
        role: "user",
        content: expect.stringMatching(
          /^al: Ask the technical specialist to fix it\.\n\nAdditional context: Now it is \d{1,2} [a-z]{3} \d{4}, \d{2}:\d{2}\. The current user is al with user id alice \(aliases: al\)\.$/,
        ),
      },
    ]);

    // Each generation is attributed to the agent that spoke.
    const generations = await persistence.listGenerations("conv-1");
    expect(generations.map((g) => g.agentName)).toEqual([
      "Receptionist",
      "Technical Specialist",
    ]);
    const transcript = await persistence.listTranscript("conv-1");
    expect(transcript.map((e) => e.toString())).toEqual([
      "al: Hello there.",
      "Receptionist: How can I help?",
      "al: Ask the technical specialist to fix it.",
      "Technical Specialist: Let me look into that.",
    ]);
  });

  test("routes to an agent by alias", async () => {
    const persistence = new MemoryPersistence();
    const conversation = new Conversation({ id: "conv-1", persistence });
    const receptionistLlm = new FakeLLM(respond("ok"));
    const specialistLlm = new FakeLLM(respond("on it"));
    const stt = new FakeSTT();
    const orchestrator = new Orchestrator({
      conversation,
      agents: [
        new Agent({ name: "Receptionist", llm: receptionistLlm }),
        new Agent({ name: "Technical Specialist", aliases: ["tech"], llm: specialistLlm }),
      ],
      stt,
      tts: new FakeTTS((text) => [new TextEncoder().encode(text)]),
      persistence,
    });

    conversation.start();
    await conversation.participate({ userId: "alice" });
    await orchestrator.start();

    conversation.listen({ userId: "alice", audio: new Uint8Array([1]) });
    stt.sessions[0]!.emitFinal("can you help me, tech?");
    await orchestrator.whenIdle();

    expect(specialistLlm.requests).toHaveLength(1);
    expect(receptionistLlm.requests).toHaveLength(0);
  });

  describe("pickAgent", () => {
    const receptionist = new Agent({ name: "Receptionist" });
    const specialist = new Agent({
      name: "Technical Specialist",
      aliases: ["tech", "support"],
    });
    const roster = [receptionist, specialist];

    test("matches by name, then alias, then defaults to the first agent", () => {
      expect(pickAgent(roster, "ask the technical specialist about X")).toBe(
        specialist,
      );
      expect(pickAgent(roster, "talk to tech please")).toBe(specialist);
      expect(pickAgent(roster, "hi there")).toBe(receptionist);
      expect(pickAgent(roster, "")).toBe(receptionist);
    });

    test("matching is case-insensitive", () => {
      expect(pickAgent(roster, "TECHNICAL SPECIALIST!")).toBe(specialist);
      expect(pickAgent(roster, "Hi, Tech")).toBe(specialist);
      expect(pickAgent(roster, "RECEPTIONIST?")).toBe(receptionist);
    });

    test("returns null for an empty roster", () => {
      expect(pickAgent([], "anything")).toBeNull();
    });
  });

  describe("coordination", () => {
    function understandThatDelegates(tasks: unknown[]): LLMScript {
      return async function* (request) {
        if (request.messages.at(-1)?.role === "tool") {
          yield { type: "delta", content: "I found a 3pm flight and your calendar is free." };
          yield { type: "done" };
          return;
        }
        yield { type: "delta", content: "Let me check both. " };
        yield {
          type: "tool_call",
          id: "call_1",
          name: "delegate",
          arguments: JSON.stringify({ action: "agents", tasks }),
        };
        yield { type: "done" };
      };
    }

    test("decomposes a turn across specialist agents and merges the results", async () => {
      const harness = await setupRoster({
        coordinatorScript: understandThatDelegates([
          { agent: "Travel Agent", prompt: "Find flights Paris to London tomorrow morning." },
          { agent: "Calendar Agent", prompt: "Check meetings on Tuesday afternoon." },
        ]),
        scripts: {
          "Travel Agent": respond("Flight at 3pm."),
          "Calendar Agent": respond("Free Tuesday afternoon."),
        },
      });

      await speak(harness, "alice", "Book a flight and check my calendar.");

      // Each specialist ran on its own LLM with its own context, and the
      // dispatched prompt carries a time stamp for temporal context.
      const travel = harness.llms.get("Travel Agent")!;
      const calendar = harness.llms.get("Calendar Agent")!;
      expect(travel.requests).toHaveLength(1);
      expect(calendar.requests).toHaveLength(1);
      const travelPrompt = travel.requests[0]!.messages.at(-1)!;
      expect(travelPrompt.role).toBe("user");
      expect(travelPrompt.content).toContain("Find flights Paris to London tomorrow morning.");
      // The dispatched prompt carries a time stamp for temporal context.
      expect(travelPrompt.content).toMatch(/Now it is \d{1,2} [a-z]{3} \d{4}, \d{2}:\d{2}\.$/);
      expect(travel.requests[0]!.messages[0]).toEqual({
        role: "system",
        name: "Travel Agent",
        content: "You are Travel Agent.",
      });

      // The coordinator resumed with both specialist outputs as the tool
      // result and composed the final answer.
      expect(harness.llm.requests).toHaveLength(2);
      expect(harness.llm.requests[1]!.messages.at(-1)).toEqual({
        role: "tool",
        toolCallId: "call_1",
        name: "delegate",
        content: JSON.stringify([
          { agent: "Travel Agent", text: "Flight at 3pm." },
          { agent: "Calendar Agent", text: "Free Tuesday afternoon." },
        ]),
      });

      // Sub-generations are persisted, attributed, and linked to the
      // coordinator generation that dispatched them.
      const generations = await harness.persistence.listGenerations("conv-1");
      const coordinatorGen = generations.find((g) => g.agentName === "Jarvis")!;
      const subGens = generations.filter((g) => g.kind === "sub");
      expect(subGens).toHaveLength(2);
      expect(subGens.map((g) => [g.agentName, g.text, g.status])).toEqual([
        ["Travel Agent", "Flight at 3pm.", "completed"],
        ["Calendar Agent", "Free Tuesday afternoon.", "completed"],
      ]);
      for (const sub of subGens) {
        expect(sub.parentGenerationId).toBe(coordinatorGen.id);
      }
      expect(coordinatorGen.status).toBe("completed");
      // The generation accumulates the narration and the merged answer.
      expect(coordinatorGen.text).toBe(
        "Let me check both. I found a 3pm flight and your calendar is free.",
      );

      // Transcript: user turn, each specialist's work, then the merged answer.
      const transcript = await harness.persistence.listTranscript("conv-1");
      expect(transcript.map((e) => e.toString())).toEqual([
        "al: Book a flight and check my calendar.",
        "Travel Agent: Flight at 3pm.",
        "Calendar Agent: Free Tuesday afternoon.",
        "Jarvis: Let me check both. I found a 3pm flight and your calendar is free.",
      ]);

      // The coordinator narrated while the specialists worked, then spoke
      // the merged answer. Specialists are text-only.
      expect(harness.tts.requests.map((r) => r.text)).toEqual([
        "Let me check both.",
        "I found a 3pm flight and your calendar is free.",
      ]);
    });

    test("runs dispatched specialists in parallel", async () => {
      const reached: string[] = [];
      const waitForBoth = async () => {
        for (let i = 0; i < 2000; i++) {
          if (reached.length >= 2) return;
          await Bun.sleep(1);
        }
        throw new Error("specialists did not run in parallel");
      };

      const harness = await setupRoster({
        coordinatorScript: understandThatDelegates([
          { agent: "Travel Agent", prompt: "Find flights." },
          { agent: "Calendar Agent", prompt: "Check meetings." },
        ]),
        scripts: {
          "Travel Agent": async function* () {
            reached.push("travel");
            await waitForBoth();
            yield { type: "delta", content: "Flight at 3pm." };
            yield { type: "done" };
          },
          "Calendar Agent": async function* () {
            reached.push("calendar");
            await waitForBoth();
            yield { type: "delta", content: "Calendar is free." };
            yield { type: "done" };
          },
        },
      });

      // If the tasks ran serially, the first specialist would wait forever
      // for the second and the test would time out.
      await speak(harness, "alice", "Plan my trip.");

      expect(reached.sort()).toEqual(["calendar", "travel"]);
      expect(harness.llms.get("Travel Agent")!.requests).toHaveLength(1);
      expect(harness.llms.get("Calendar Agent")!.requests).toHaveLength(1);
      expect(harness.llm.requests[1]!.messages.at(-1)?.role).toBe("tool");
    });

    test("records timing on text-only sub-generations", async () => {
      const harness = await setupRoster({
        coordinatorScript: understandThatDelegates([
          { agent: "Travel Agent", prompt: "Find flights." },
        ]),
        scripts: { "Travel Agent": respond("Flight at 3pm.") },
      });

      await speak(harness, "alice", "Book a flight.");

      const sub = (await harness.persistence.listGenerations("conv-1")).find(
        (g) => g.kind === "sub",
      )!;
      expect(sub.timing?.firstTokenAt).toBeDefined();
      expect(sub.timing?.completedAt).toBeDefined();
      // Sub-agents are text-only: no TTS text, request, or audio is ever
      // recorded for them.
      expect(sub.timing?.firstTtsTextAt).toBeUndefined();
      expect(sub.timing?.firstTtsRequestAt).toBeUndefined();
      expect(sub.timing?.firstAudioAt).toBeUndefined();
    });

    test("dispatched specialists keep their own tools running in the app backend", async () => {
      const getSchedule = new Tool({
        name: "get_schedule",
        description: "Get the day's schedule.",
        execute: async () => "free Tuesday afternoon",
      });

      const harness = await setupRoster({
        coordinatorScript: understandThatDelegates([
          { agent: "Calendar Agent", prompt: "Check Tuesday afternoon." },
        ]),
        scripts: {
          "Calendar Agent": async function* (request) {
            if (request.messages.at(-1)?.role === "tool") {
              yield { type: "delta", content: "Tuesday afternoon is free." };
              yield { type: "done" };
              return;
            }
            yield {
              type: "tool_call",
              id: "call_c1",
              name: "get_schedule",
              arguments: "{}",
            };
            yield { type: "done" };
          },
        },
        tools: { "Calendar Agent": [getSchedule] },
      });

      const toolCalls: string[] = [];
      harness.conversation.on("tool-call", (payload) => {
        toolCalls.push(payload.call.name);
        if (payload.call.name === "get_schedule") {
          harness.conversation.resolveToolCall({
            id: payload.call.id,
            result: "free Tuesday afternoon",
          });
        }
      });

      await speak(harness, "alice", "Check my Tuesday.");

      // The specialist's tool was surfaced to the application, executed
      // there, and its result fed back into the specialist's LLM loop.
      expect(toolCalls).toEqual(["get_schedule"]);
      const calendar = harness.llms.get("Calendar Agent")!;
      expect(calendar.requests).toHaveLength(2);
      expect(calendar.requests[1]!.messages.at(-1)).toEqual({
        role: "tool",
        toolCallId: "call_c1",
        name: "get_schedule",
        content: '"free Tuesday afternoon"',
      });

      // The coordinator merged the specialist's findings.
      expect(harness.llm.requests[1]!.messages.at(-1)).toMatchObject({
        role: "tool",
        name: "delegate",
      });
      expect(
        JSON.parse(
          (harness.llm.requests[1]!.messages.at(-1) as { content: string }).content,
        ),
      ).toEqual([{ agent: "Calendar Agent", text: "Tuesday afternoon is free." }]);
    });

    test("a delegate to an unknown agent reports an error the coordinator can recover from", async () => {
      const harness = await setupRoster({
        coordinatorScript: async function* (request) {
          if (request.messages.at(-1)?.role === "tool") {
            yield { type: "delta", content: "I could not reach that service." };
            yield { type: "done" };
            return;
          }
          yield {
            type: "tool_call",
            id: "call_1",
            name: "delegate",
            arguments: JSON.stringify({
              action: "agents",
              tasks: [{ agent: "Ghost Agent", prompt: "Do the thing." }],
            }),
          };
          yield { type: "done" };
        },
        scripts: {},
      });

      await speak(harness, "alice", "Do the thing.");

      const delegateResult = harness.llm.requests[1]!.messages.at(-1) as {
        content: string;
      };
      // The strict roster enum rejects the unknown agent, and the
      // coordination recovers from the reported error.
      expect(JSON.parse(delegateResult.content)).toEqual({
        error: expect.stringContaining("invalid delegate arguments") as unknown,
      });
      expect(harness.llm.requests[1]!.messages.at(-1)).toMatchObject({
        role: "tool",
        name: "delegate",
      });

      // No sub-generation was created, and the coordinator still completed.
      const generations = await harness.persistence.listGenerations("conv-1");
      expect(generations.filter((g) => g.kind === "sub")).toHaveLength(0);
      expect(generations[0]?.status).toBe("completed");
      expect(generations[0]?.text).toBe("I could not reach that service.");
    });

    test("malformed delegate arguments surface the parse error instead of crashing", async () => {
      const harness = await setupRoster({
        coordinatorScript: async function* (request) {
          if (request.messages.at(-1)?.role === "tool") {
            yield { type: "delta", content: "Let me rephrase that." };
            yield { type: "done" };
            return;
          }
          yield {
            type: "tool_call",
            id: "call_1",
            name: "delegate",
            arguments: "{not json",
          };
          yield { type: "done" };
        },
        scripts: {},
      });

      await speak(harness, "alice", "Do the thing.");

      const delegateResult = harness.llm.requests[1]!.messages.at(-1) as {
        content: string;
      };
      expect(JSON.parse(delegateResult.content)).toEqual({
        error: "delegate arguments must be valid JSON",
      });
      expect(harness.llm.requests[1]!.messages.at(-1)).toMatchObject({
        role: "tool",
        name: "delegate",
      });
    });

    test("interrupt cancels in-flight sub-generations", async () => {
      let travelCalls = 0;
      const harness = await setupRoster({
        coordinatorScript: understandThatDelegates([
          { agent: "Travel Agent", prompt: "Find flights." },
        ]),
        scripts: {
          "Travel Agent": async function* (_request, signal) {
            const n = travelCalls++;
            if (n === 0) {
              yield { type: "delta", content: "Looking up flights..." };
              while (!signal.aborted) await Bun.sleep(2);
              throw new DOMException("The operation was aborted.", "AbortError");
            }
            yield { type: "delta", content: "Flight at 5pm." };
            yield { type: "done" };
          },
        },
      });

      harness.conversation.listen({ userId: "alice", audio: new Uint8Array([1]) });
      harness.stt.sessions[0]!.emitFinal("Book me a flight.");
      await waitFor(() => harness.llms.get("Travel Agent")!.requests.length === 1);

      harness.conversation.interrupt();
      await harness.orchestrator.whenIdle();

      // The coordinator generation and the in-flight sub-generation were
      // both cancelled, not completed.
      const generations = await harness.persistence.listGenerations("conv-1");
      const coordinatorGen = generations.find((g) => g.agentName === "Jarvis")!;
      const subGen = generations.find((g) => g.kind === "sub")!;
      expect(coordinatorGen.status).toBe("cancelled");
      expect(subGen.status).toBe("cancelled");
      expect(subGen.parentGenerationId).toBe(coordinatorGen.id);

      // A fresh turn works after the interrupt: the coordinator re-dispatches
      // and a new sub-generation completes.
      harness.stt.sessions[0]!.emitFinal("Actually, book it for tomorrow.");
      await harness.orchestrator.whenIdle();
      const travel = harness.llms.get("Travel Agent")!;
      expect(travel.requests).toHaveLength(2);
      const after = await harness.persistence.listGenerations("conv-1");
      const subGens = after.filter((g) => g.kind === "sub");
      expect(subGens).toHaveLength(2);
      expect(subGens[1]?.status).toBe("completed");
      expect(subGens[1]?.text).toBe("Flight at 5pm.");
    });

    test("asks the user a clarifying question, suspends, and resumes with the answer", async () => {
      let calls = 0;
      const harness = await setupRoster({
        coordinatorScript: async function* () {
          const n = calls++;
          if (n === 0) {
            yield { type: "delta", content: "Which airport would you like to fly from? " };
            yield {
              type: "tool_call",
              id: "call_1",
              name: "delegate",
              arguments: JSON.stringify({
                action: "user",
                question: "Which airport would you like to fly from?",
              }),
            };
            yield { type: "done" };
            return;
          }
          yield { type: "delta", content: "Booking your flight from CDG. " };
          yield { type: "done" };
        },
        scripts: {},
      });

      await speak(harness, "alice", "Book me a flight.");

      // The question was spoken, recorded, and the execution parked.
      const transcript = await harness.persistence.listTranscript("conv-1");
      expect(transcript.map((e) => e.toString())).toEqual([
        "al: Book me a flight.",
        "Jarvis: Which airport would you like to fly from?",
      ]);
      expect(harness.tts.requests.map((r) => r.text)).toEqual([
        "Which airport would you like to fly from?",
      ]);

      // The user's answer resumes the same coordination instead of starting a
      // fresh generation, and the final answer is recorded.
      await speak(harness, "alice", "CDG.");

      const finalTranscript = await harness.persistence.listTranscript("conv-1");
      expect(finalTranscript.map((e) => e.toString())).toEqual([
        "al: Book me a flight.",
        "Jarvis: Which airport would you like to fly from?",
        "al: CDG.",
        "Jarvis: Booking your flight from CDG.",
      ]);
      const generations = await harness.persistence.listGenerations("conv-1");
      expect(generations.map((g) => [g.agentName, g.text, g.status])).toEqual([
        ["Jarvis", "Which airport would you like to fly from?", "completed"],
        ["Jarvis", "Booking your flight from CDG.", "completed"],
      ]);
    });

    test("speech while waiting for an answer resumes the coordination instead of interrupting it", async () => {
      let calls = 0;
      const harness = await setupRoster({
        coordinatorScript: async function* () {
          const n = calls++;
          if (n === 0) {
            yield { type: "delta", content: "Which city? " };
            yield {
              type: "tool_call",
              id: "call_1",
              name: "delegate",
              arguments: JSON.stringify({ action: "user", question: "Which city?" }),
            };
            yield { type: "done" };
            return;
          }
          yield { type: "delta", content: "Flying to London. " };
          yield { type: "done" };
        },
        scripts: {},
      });

      await speak(harness, "alice", "Book a flight.");

      // The participant starts speaking while the question is pending. This
      // is the answer, not a barge-in: nothing is interrupted.
      harness.conversation.listen({ userId: "alice", audio: new Uint8Array([2, 2]) });
      harness.stt.sessions[0]!.emitFinal("London.");
      await harness.orchestrator.whenIdle();

      const generations = await harness.persistence.listGenerations("conv-1");
      // The question generation completed; the resumed answer completed.
      // Nothing was cancelled.
      expect(generations.map((g) => g.status)).toEqual(["completed", "completed"]);
      expect(generations.at(-1)?.text).toBe("Flying to London.");
      expect(generations.filter((g) => g.status === "cancelled")).toHaveLength(0);
    });

    test("a text turn resumes a pending coordination question", async () => {
      let calls = 0;
      const harness = await setupRoster({
        coordinatorScript: async function* () {
          const n = calls++;
          if (n === 0) {
            yield { type: "delta", content: "Which city? " };
            yield {
              type: "tool_call",
              id: "call_1",
              name: "delegate",
              arguments: JSON.stringify({ action: "user", question: "Which city?" }),
            };
            yield { type: "done" };
            return;
          }
          yield { type: "delta", content: "Flying to London. " };
          yield { type: "done" };
        },
        scripts: {},
      });

      await speak(harness, "alice", "Book a flight.");

      // The answer arrives as a text turn (send) instead of speech: the
      // parked coordination resumes, nothing is interrupted.
      harness.conversation.send({ userId: "alice", text: "London." });
      await harness.orchestrator.whenIdle();

      const generations = await harness.persistence.listGenerations("conv-1");
      expect(generations.map((g) => [g.text, g.status])).toEqual([
        ["Which city?", "completed"],
        ["Flying to London.", "completed"],
      ]);
      expect(generations.filter((g) => g.status === "cancelled")).toHaveLength(0);
      const transcript = await harness.persistence.listTranscript("conv-1");
      expect(transcript.map((e) => e.toString())).toEqual([
        "al: Book a flight.",
        "Jarvis: Which city?",
        "al: London.",
        "Jarvis: Flying to London.",
      ]);
    });

    test("delegates to a registered coordination and merges its output", async () => {
      const resolveLlm = new FakeLLM(respond("The flight departs at 3pm."));
      const harness = await setupRoster({
        coordinatorScript: async function* (request) {
          if (request.messages.at(-1)?.role === "tool") {
            yield { type: "delta", content: "Your flight is confirmed." };
            yield { type: "done" };
            return;
          }
          yield {
            type: "tool_call",
            id: "call_1",
            name: "delegate",
            arguments: JSON.stringify({
              action: "coordination",
              coordination: "resolve-details",
              input: { prompt: "Find the flight details." },
            }),
          };
          yield { type: "done" };
        },
        scripts: {},
        coordinations: [
          { name: "resolve-details", prompt: "You resolve details.", llm: resolveLlm },
        ],
      });

      await speak(harness, "alice", "Plan my trip.");

      // The sub-coordination ran on its own LLM with its own prompt and input.
      expect(resolveLlm.requests).toHaveLength(1);
      expect(resolveLlm.requests[0]!.messages[0]).toEqual({
        role: "system",
        name: "resolve-details",
        content: "You resolve details.",
      });
      expect(resolveLlm.requests[0]!.messages.at(-1)).toEqual({
        role: "user",
        content: JSON.stringify({ prompt: "Find the flight details." }),
      });

      // Its output came back as the delegate tool result, and the understand
      // coordination merged it into the final answer.
      expect(harness.llm.requests).toHaveLength(2);
      expect(harness.llm.requests[1]!.messages.at(-1)).toEqual({
        role: "tool",
        toolCallId: "call_1",
        name: "delegate",
        content: JSON.stringify("The flight departs at 3pm."),
      });
      const transcript = await harness.persistence.listTranscript("conv-1");
      expect(transcript.at(-1)?.toString()).toBe("Jarvis: Your flight is confirmed.");
    });

    test("a suspension inside a nested coordination resumes both frames", async () => {
      let resolveCalls = 0;
      const resolveLlm = new FakeLLM(async function* () {
        const n = resolveCalls++;
        if (n === 0) {
          yield { type: "delta", content: "Which city? " };
          yield {
            type: "tool_call",
            id: "call_u1",
            name: "delegate",
            arguments: JSON.stringify({ action: "user", question: "Which city?" }),
          };
          yield { type: "done" };
          return;
        }
        yield { type: "delta", content: "CDG flight found." };
        yield { type: "done" };
      });
      const harness = await setupRoster({
        coordinatorScript: async function* (request) {
          if (request.messages.at(-1)?.role === "tool") {
            yield { type: "delta", content: "Final: flight at 3pm." };
            yield { type: "done" };
            return;
          }
          yield {
            type: "tool_call",
            id: "call_1",
            name: "delegate",
            arguments: JSON.stringify({
              action: "coordination",
              coordination: "resolve-details",
              input: { prompt: "Find flights." },
            }),
          };
          yield { type: "done" };
        },
        scripts: {},
        coordinations: [
          { name: "resolve-details", prompt: "You resolve details.", llm: resolveLlm },
        ],
      });

      await speak(harness, "alice", "Book my flight.");

      // The nested coordination asked the question; the whole stack parked.
      const transcript = await harness.persistence.listTranscript("conv-1");
      expect(transcript.map((e) => e.toString())).toEqual([
        "al: Book my flight.",
        "Jarvis: Which city?",
      ]);
      expect(resolveLlm.requests).toHaveLength(1);
      expect(harness.llm.requests).toHaveLength(1);

      // The answer resumes the innermost frame; its output propagates back
      // through the parent frame to the final merged answer.
      await speak(harness, "alice", "Paris.");

      expect(resolveLlm.requests).toHaveLength(2);
      expect(harness.llm.requests).toHaveLength(2);
      const finalTranscript = await harness.persistence.listTranscript("conv-1");
      expect(finalTranscript.map((e) => e.toString())).toEqual([
        "al: Book my flight.",
        "Jarvis: Which city?",
        "al: Paris.",
        "Jarvis: Final: flight at 3pm.",
      ]);
      const generations = await harness.persistence.listGenerations("conv-1");
      expect(generations.map((g) => [g.agentName, g.text, g.status])).toEqual([
        ["Jarvis", "Which city?", "completed"],
        ["Jarvis", "Final: flight at 3pm.", "completed"],
      ]);
    });

    test("the step budget guards runaway delegation", async () => {
      const harness = await setupRoster({
        coordinatorScript: async function* (request) {
          if (request.messages.at(-1)?.role === "tool") {
            yield { type: "delta", content: "Done." };
            yield { type: "done" };
            return;
          }
          yield {
            type: "tool_call",
            id: "call_1",
            name: "delegate",
            arguments: JSON.stringify({
              action: "coordination",
              coordination: "understand",
              input: { prompt: "Again." },
            }),
          };
          yield { type: "done" };
        },
        scripts: {},
        maxCoordinationSteps: 3,
      });
      const errors: Error[] = [];
      harness.conversation.on("error", (payload) => errors.push(payload.error));

      await speak(harness, "alice", "Loop me.");

      // The self-delegation loop was cut off by the budget, surfaced as an
      // error instead of hanging forever.
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]?.message).toMatch(/coordination steps/);
    });

    test("completes directly with a structured answer", async () => {
      const harness = await setupRoster({
        coordinatorScript: async function* () {
          yield { type: "delta", content: "Here is the answer. " };
          yield {
            type: "tool_call",
            id: "call_1",
            name: "delegate",
            arguments: JSON.stringify({
              action: "complete",
              output: "The weather is sunny.",
            }),
          };
          yield { type: "done" };
        },
        scripts: {},
      });

      await speak(harness, "alice", "What is the weather?");

      // The narration plus the complete output form the final answer.
      const generations = await harness.persistence.listGenerations("conv-1");
      expect(generations[0]?.text).toBe("Here is the answer. The weather is sunny.");
      expect(harness.tts.requests.map((r) => r.text)).toEqual([
        "Here is the answer.",
        "The weather is sunny.",
      ]);
    });

    test("rehydrates history without sub-generations", async () => {
      const persistence = new MemoryPersistence();
      const conversation = new Conversation({ id: "conv-1", persistence });
      await conversation.pushTurn({
        id: "turn-1",
        conversationId: "conv-1",
        participantId: "alice",
        participantName: "alice",
        text: "Hello from before.",
        sequence: 0,
        startedAt: 1,
        endedAt: 2,
      });
      await conversation.pushTranscript({
        speaker: "alice",
        speakerKind: "participant",
        text: "Hello from before.",
      });
      // A completed coordinator response plus the sub-generation it
      // dispatched. Only the coordinator response should rehydrate.
      await conversation.pushGeneration({
        id: "gen-1",
        conversationId: "conv-1",
        agentName: "Jarvis",
        text: "Summary answer.",
        status: "completed",
        startedAt: 3,
        endedAt: 4,
      });
      await conversation.pushSubGeneration({
        id: "gen-2",
        conversationId: "conv-1",
        agentName: "Calendar Agent",
        text: "Free.",
        status: "completed",
        startedAt: 5,
        endedAt: 6,
        kind: "sub",
        parentGenerationId: "gen-1",
      });

      const llm = new FakeLLM(respond("Welcome back!"));
      const stt = new FakeSTT();
      const agent = new Agent({ name: "Jarvis", context: "Be concise.", llm });
      const orchestrator = new Orchestrator({
        conversation,
        agents: [agent],
        llm,
        stt,
        tts: new FakeTTS((text) => [new TextEncoder().encode(text)]),
        persistence,
      });
      conversation.start();
      await conversation.participate({ userId: "alice" });
      await orchestrator.start();

      conversation.listen({ userId: "alice", audio: new Uint8Array([1]) });
      stt.sessions[0]!.emitFinal("Can you continue?");
      await orchestrator.whenIdle();

      // The sub-generation's text is not in history — the coordinator's own
      // summary stands in for it.
      expect(llm.requests[0]!.messages).toEqual([
        { role: "system", name: "Jarvis", content: "Be concise." },
        {
          role: "user",
          content: expect.stringMatching(
            /^alice: Hello from before\.\n\nAdditional context: Now it is \d{1,2} [a-z]{3} \d{4}, \d{2}:\d{2}\. The current user is alice with user id alice\.$/,
          ),
        },
        { role: "assistant", name: "Jarvis", content: "Summary answer." },
        {
          role: "user",
          content: expect.stringMatching(
            /^alice: Can you continue\?\n\nAdditional context: Now it is \d{1,2} [a-z]{3} \d{4}, \d{2}:\d{2}\. The current user is alice with user id alice\.$/,
          ),
        },
      ]);
    });
  });

  test("rehydrates history from persistence on start", async () => {
    const persistence = new MemoryPersistence();
    const conversation = new Conversation({ id: "conv-1", persistence });
    await conversation.pushTurn({
      id: "turn-1",
      conversationId: "conv-1",
      participantId: "alice",
      participantName: "alice",
      text: "Hello from before.",
      sequence: 0,
      startedAt: 1,
      endedAt: 2,
    });
    await conversation.pushTranscript({
      speaker: "alice",
      speakerKind: "participant",
      text: "Hello from before.",
    });

    const llm = new FakeLLM(respond("Welcome back!"));
    const stt = new FakeSTT();
    const agent = new Agent({ name: "Jarvis", context: "Be concise.", llm });
    const orchestrator = new Orchestrator({
      conversation,
      agents: [agent],
      llm,
      stt,
      tts: new FakeTTS((text) => [new TextEncoder().encode(text)]),
      persistence,
    });
    conversation.start();
    await conversation.participate({ userId: "alice" });
    await orchestrator.start();

    conversation.listen({ userId: "alice", audio: new Uint8Array([1]) });
    stt.sessions[0]!.emitFinal("Can you continue?");
    await orchestrator.whenIdle();

    expect(llm.requests[0]!.messages).toEqual([
      { role: "system", name: "Jarvis", content: "Be concise." },
      {
        role: "user",
        content: expect.stringMatching(
          /^alice: Hello from before\.\n\nAdditional context: Now it is \d{1,2} [a-z]{3} \d{4}, \d{2}:\d{2}\. The current user is alice with user id alice\.$/,
        ),
      },
      {
        role: "user",
        content: expect.stringMatching(
          /^alice: Can you continue\?\n\nAdditional context: Now it is \d{1,2} [a-z]{3} \d{4}, \d{2}:\d{2}\. The current user is alice with user id alice\.$/,
        ),
      },
    ]);
  });

  test("an LLM failure emits an error event and finalizes the partial generation", async () => {
    const harness = await setup({
      script: async function* () {
        yield { type: "delta", content: "Partial answer" };
        throw new Error("provider down");
      },
    });
    const errors: Error[] = [];
    harness.conversation.on("error", (payload) => errors.push(payload.error));

    await speak(harness, "alice", "Hello?");

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe("provider down");

    // The partial generation was still finalized so state stays consistent.
    const generations = await harness.persistence.listGenerations("conv-1");
    expect(generations[0]?.status).toBe("completed");
    expect(generations[0]?.text).toBe("Partial answer");
  });

  test("an STT failure emits an error event", async () => {
    const harness = await setup({ script: respond("Ok!") });
    const errors: Error[] = [];
    harness.conversation.on("error", (payload) => errors.push(payload.error));

    harness.conversation.listen({ userId: "alice", audio: new Uint8Array([1]) });
    harness.stt.sessions[0]!.emitError(new Error("stt exploded"));

    expect(errors.map((e) => e.message)).toEqual(["stt exploded"]);
  });

  test("gives each participant its own STT session", async () => {
    const harness = await setup({ script: respond("Ok!") });
    await harness.conversation.participate({ userId: "bob", aliases: ["rob"] });

    harness.conversation.listen({ userId: "alice", audio: new Uint8Array([1]) });
    harness.conversation.listen({ userId: "bob", audio: new Uint8Array([2]) });

    expect(harness.stt.sessions).toHaveLength(2);
    expect([...harness.stt.sessions[0]!.written[0]!]).toEqual([1]);
    expect([...harness.stt.sessions[1]!.written[0]!]).toEqual([2]);
  });

  test("stop ends STT sessions and unsubscribes from the conversation", async () => {
    const harness = await setup({ script: respond("Ok!") });

    harness.conversation.listen({ userId: "alice", audio: new Uint8Array([1]) });
    const session = harness.stt.sessions[0]!;

    await harness.orchestrator.stop();

    expect(session.ended).toBe(1);

    // Audio after stop is no longer routed to STT.
    harness.conversation.listen({ userId: "alice", audio: new Uint8Array([2]) });
    expect(session.written).toHaveLength(1);
  });

  test("stopping the conversation stops the orchestrator", async () => {
    const harness = await setup({ script: respond("Ok!") });

    harness.conversation.listen({ userId: "alice", audio: new Uint8Array([1]) });
    const session = harness.stt.sessions[0]!;

    await harness.conversation.stop();

    expect(session.ended).toBe(1);
    expect(harness.llm.stopCalls.length).toBeGreaterThan(0);
  });
});
