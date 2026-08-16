import { describe, expect, test } from "bun:test";
import { Agent } from "../../../agents/agent.ts";
import { Tool } from "../../../agents/tools/tools.ts";
import { Conversation } from "../../conversation/conversation.ts";
import { MemoryPersistence } from "../../../persistence/adapters/memory/memory.ts";
import { Orchestrator } from "./orchestrator.ts";
import type { AudioChunk, ToolCall, UserId } from "../../types.ts";
import type {
  LLM,
  LLMEvent,
  LLMRequest,
} from "../../../providers/llm/types.ts";
import type { STT, STTOptions, STTSession } from "../../../providers/stt/types.ts";
import type { TTS, TTSRequest } from "../../../providers/tts/types.ts";

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

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  conversation: Conversation;
  orchestrator: Orchestrator;
  llm: FakeLLM;
  stt: FakeSTT;
  tts: FakeTTS;
  persistence: MemoryPersistence;
}

function setup(options: {
  script: LLMScript;
  ttsChunks?: (text: string) => Uint8Array[];
  tools?: Tool<never, unknown>[];
  toolTimeoutMs?: number;
  context?: string;
}): Promise<Harness> {
  return (async () => {
    const persistence = new MemoryPersistence();
    const conversation = new Conversation({ id: "conv-1", persistence });
    const llm = new FakeLLM(options.script);
    const stt = new FakeSTT();
    const tts = new FakeTTS(
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
      agent,
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
      () => new Orchestrator({ conversation, agent, stt, tts }),
    ).toThrow(/requires an LLM/);
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

    // LLM saw the system context and the user turn.
    expect(harness.llm.requests[0]!.messages).toEqual([
      { role: "system", content: "Be concise." },
      { role: "user", content: "al: Hello there." },
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
    // answer can reference it.
    expect(harness.llm.requests[1]!.messages).toEqual([
      { role: "system", content: "Be concise." },
      { role: "user", content: "al: What is the weather?" },
      { role: "assistant", content: "Which city?" },
      { role: "user", content: "al: In London." },
    ]);
    expect(harness.tts.requests.map((r) => r.text)).toEqual([
      "Which city?",
      "It is sunny in London!",
    ]);
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
      agent,
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
      { role: "system", content: "Be concise." },
      { role: "user", content: "alice: Hello from before." },
      { role: "user", content: "alice: Can you continue?" },
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
