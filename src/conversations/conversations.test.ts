import { describe, expect, test } from "bun:test";
import { Conversations } from "./conversations";
import { MemoryPersistence } from "../persistence/adapters/memory/memory";
import { Conversation } from "./conversation/conversation";
import { Agent } from "../agents/agent";
import { Tool } from "../agents/tools/tools";
import type { LLM, LLMEvent, LLMRequest } from "../providers/llm/types";
import type { STT, STTOptions, STTSession } from "../providers/stt/types";
import type { TTS, TTSRequest } from "../providers/tts/types";

function conversations(
  options: Partial<{ stt: STT; tts: TTS }> = {},
): Conversations {
  return new Conversations({ persistence: new MemoryPersistence(), ...options });
}

// ---------------------------------------------------------------------------
// Minimal fakes for the auto-wiring tests
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

class FakeLLM implements LLM {
  readonly requests: LLMRequest[] = [];
  constructor(
    private readonly script?: (request: LLMRequest) => AsyncIterable<LLMEvent>,
  ) {}

  async *stream(request: LLMRequest): AsyncGenerator<LLMEvent> {
    this.requests.push(request);
    if (this.script) {
      yield* this.script(request);
    } else {
      yield { type: "delta", content: "Got it!" };
      yield { type: "done" };
    }
  }
  stop(): void {}
}

class FakeTTS implements TTS {
  readonly requests: TTSRequest[] = [];
  async *stream(request: TTSRequest): AsyncGenerator<Uint8Array> {
    this.requests.push(request);
    yield new TextEncoder().encode(request.text);
  }
  stop(): void {}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function waitFor(
  condition: () => Promise<boolean> | boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await Bun.sleep(2);
  }
}

describe("Conversations", () => {
  test("create persists a conversation and returns a runtime handle", async () => {
    const api = conversations();
    const conversation = await api.create();

    expect(conversation).toBeInstanceOf(Conversation);
    expect(conversation.id).toBeTruthy();
    expect(conversation.status).toBe("created");
  });

  test("create records agent names", async () => {
    const persistence = new MemoryPersistence();
    const api = new Conversations({ persistence });

    const jarvis = new Agent({ name: "Jarvis" });
    const conversation = await api.create({ agents: [jarvis] });

    const record = await persistence.getConversation(conversation.id);
    expect(record?.agentNames).toEqual(["Jarvis"]);
  });

  test("create without agents records an empty agent list", async () => {
    const persistence = new MemoryPersistence();
    const api = new Conversations({ persistence });
    const conversation = await api.create();
    expect((await persistence.getConversation(conversation.id))?.agentNames).toEqual([]);
  });

  test("each conversation gets a unique id", async () => {
    const api = conversations();
    const a = await api.create();
    const b = await api.create();
    expect(a.id).not.toBe(b.id);
  });

  test("get returns a handle for existing conversations and null otherwise", async () => {
    const api = conversations();
    const created = await api.create();

    const fetched = await api.get(created.id);
    expect(fetched?.id).toBe(created.id);

    expect(await api.get("missing")).toBeNull();
  });

  test("transcript returns persisted entries for a conversation", async () => {
    const api = conversations();
    const conversation = await api.create();

    await conversation.pushTranscript({
      speaker: "alice",
      speakerKind: "participant",
      text: "Hello",
    });
    await conversation.pushTranscript({
      speaker: "Jarvis",
      speakerKind: "agent",
      text: "Hi!",
    });

    const transcript = await api.transcript(conversation.id);
    expect(transcript.map((entry) => entry.toString())).toEqual([
      "alice: Hello",
      "Jarvis: Hi!",
    ]);
  });

  test("transcript joins into a readable dump", async () => {
    const api = conversations();
    const conversation = await api.create();
    await conversation.pushTranscript({
      speaker: "alice",
      speakerKind: "participant",
      text: "one",
    });
    await conversation.pushTranscript({
      speaker: "bob",
      speakerKind: "participant",
      text: "two",
    });

    const transcript = await api.transcript(conversation.id);
    expect(transcript.join("\n")).toBe("alice: one\nbob: two");
  });

  test("transcript returns an empty list for a conversation without entries", async () => {
    const api = conversations();
    const conversation = await api.create();
    expect(await api.transcript(conversation.id)).toEqual([]);
  });

  test("transcript throws for unknown conversations", async () => {
    const api = conversations();
    await expect(api.transcript("missing")).rejects.toThrow(
      /Conversation "missing" not found/,
    );
  });

  test("conversations are isolated from each other", async () => {
    const api = conversations();
    const a = await api.create();
    const b = await api.create();

    await a.pushTranscript({
      speaker: "alice",
      speakerKind: "participant",
      text: "only in a",
    });

    expect(await api.transcript(a.id)).toHaveLength(1);
    expect(await api.transcript(b.id)).toEqual([]);
  });

  test("a full lifecycle works end to end", async () => {
    const persistence = new MemoryPersistence();
    const api = new Conversations({ persistence });
    const conversation = await api.create();

    await conversation.start();
    await conversation.participate([
      { userId: "alice" },
      { userId: "bob", aliases: ["robert"] },
    ]);

    const audioIn: string[] = [];
    conversation.on("audio-in", (payload) =>
      audioIn.push(`${payload.userId}:${payload.audio.sequence}`),
    );
    conversation.listen({ userId: "alice", audio: new Uint8Array([1]) });
    conversation.listen({ userId: "alice", audio: new Uint8Array([2]) });

    await conversation.pushTranscript({
      speaker: "alice",
      speakerKind: "participant",
      text: "hello",
    });

    await conversation.stop();

    expect(audioIn).toEqual(["alice:0", "alice:1"]);
    expect(await api.transcript(conversation.id)).toHaveLength(1);
    const record = await persistence.getConversation(conversation.id);
    expect(record?.endedAt).not.toBeNull();
  });

  test("start() routes turns to the addressed agent in a multi-agent conversation", async () => {
    const stt = new FakeSTT();
    const tts = new FakeTTS();
    const receptionistLlm = new FakeLLM();
    const specialistLlm = new FakeLLM();
    const api = conversations({ stt, tts });
    const conversation = await api.create({
      agents: [
        new Agent({ name: "Receptionist", context: "You greet people.", llm: receptionistLlm }),
        new Agent({
          name: "Technical Specialist",
          aliases: ["tech"],
          context: "You solve problems.",
          llm: specialistLlm,
        }),
      ],
    });
    await conversation.participate({ userId: "alice", aliases: ["al"] });
    await conversation.start();

    conversation.listen({ userId: "alice", audio: new Uint8Array([1]) });
    stt.sessions[0]!.emitFinal("Ask the technical specialist to fix it.");
    await waitFor(() => specialistLlm.requests.length >= 1);
    await waitFor(async () => (await api.transcript(conversation.id)).length >= 2);

    // Only the addressed agent's LLM was invoked, with its own context.
    expect(receptionistLlm.requests).toHaveLength(0);
    expect(specialistLlm.requests[0]!.messages).toEqual([
      { role: "system", name: "Technical Specialist", content: "You solve problems." },
      {
        role: "user",
        content: expect.stringMatching(
          /^al: Ask the technical specialist to fix it\.\n\nAdditional context: Now it is \d{1,2} [a-z]{3} \d{4}, \d{2}:\d{2}\. The current user is al with user id alice \(aliases: al\)\.$/,
        ),
      },
    ]);

    const transcript = await api.transcript(conversation.id);
    expect(transcript.map((entry) => entry.toString())).toEqual([
      "al: Ask the technical specialist to fix it.",
      "Technical Specialist: Got it!",
    ]);
  });

  test("start() decomposes a turn across agents through the public API", async () => {
    const stt = new FakeSTT();
    const tts = new FakeTTS();
    const coordinatorLlm = new FakeLLM(async function* (request) {
      const last = request.messages.at(-1)!;
      if (last.role === "user" && String(last.content).includes("results to compose")) {
        yield { type: "delta", content: "Done: flight found and calendar checked." };
        yield { type: "done" };
        return;
      }
      if (last.role === "tool") {
        yield { type: "delta", content: "Done: flight found and calendar checked." };
        yield { type: "done" };
        return;
      }
      yield {
        type: "tool_call",
        id: "call_1",
        name: "delegate",
        arguments: JSON.stringify({
          action: "plan",
          steps: [{ id: "s1", agent: "Calendar Agent", prompt: "Check Tuesday afternoon." }],
          composition: "Compose a concise answer from the specialist's results.",
        }),
      };
      yield { type: "done" };
    });
    const calendarLlm = new FakeLLM();
    const api = conversations({ stt, tts });
    const conversation = await api.create({
      agents: [
        new Agent({ name: "Jarvis", context: "You coordinate.", llm: coordinatorLlm }),
        new Agent({
          name: "Calendar Agent",
          context: "You check calendars.",
          llm: calendarLlm,
        }),
      ],
    });
    await conversation.participate({ userId: "alice", aliases: ["al"] });
    await conversation.start();

    conversation.listen({ userId: "alice", audio: new Uint8Array([1]) });
    stt.sessions[0]!.emitFinal("Book a flight and check my calendar.");
    await waitFor(() => calendarLlm.requests.length >= 1);
    await waitFor(async () => (await api.transcript(conversation.id)).length >= 3);

    // The coordinator planned, the specialist ran on its own LLM, and
    // both turns and the merged answer landed in the transcript.
    expect(coordinatorLlm.requests).toHaveLength(2);
    expect(calendarLlm.requests).toHaveLength(1);
    expect(String(calendarLlm.requests[0]!.messages.at(-1)?.content)).toContain(
      "Check Tuesday afternoon.",
    );
    expect(String(calendarLlm.requests[0]!.messages.at(-1)?.content)).toMatch(
      /Now it is \d{1,2} [a-z]{3} \d{4}, \d{2}:\d{2}\.$/,
    );

    const transcript = await api.transcript(conversation.id);
    expect(transcript.map((entry) => entry.toString())).toEqual([
      "al: Book a flight and check my calendar.",
      "Calendar Agent: Got it!",
      "Jarvis: Done: flight found and calendar checked.",
    ]);
  });

  test("start() attaches realtime processing in transcription-only mode", async () => {
    const stt = new FakeSTT();
    const api = conversations({ stt });
    const conversation = await api.create();
    await conversation.participate({ userId: "alice", aliases: ["al"] });

    await conversation.start();

    conversation.listen({ userId: "alice", audio: new Uint8Array([1]) });
    stt.sessions[0]!.emitFinal("Hello from the meeting.");
    await waitFor(async () => (await api.transcript(conversation.id)).length >= 1);

    const turns = await api.transcript(conversation.id);
    expect(turns.map((entry) => entry.toString())).toEqual([
      "al: Hello from the meeting.",
    ]);
  });

  test("start() attaches the full voice pipeline when an agent is present", async () => {
    const stt = new FakeSTT();
    const tts = new FakeTTS();
    const llm = new FakeLLM();
    const getWeather = new Tool({
      name: "get_weather",
      description: "Weather.",
      execute: () => "sunny",
    });
    const jarvis = new Agent({ name: "Jarvis", context: "Be concise.", llm, tools: [getWeather] });

    const api = conversations({ stt, tts });
    const conversation = await api.create({ agents: [jarvis] });
    await conversation.participate({ userId: "alice", aliases: ["al"] });
    await conversation.start();

    conversation.listen({ userId: "alice", audio: new Uint8Array([1]) });
    stt.sessions[0]!.emitFinal("Hello there.");
    await waitFor(() => llm.requests.length >= 1);
    await waitFor(async () => (await api.transcript(conversation.id)).length >= 2);

    // The orchestrator ran the pipeline: the LLM saw the turn (with its
    // automatic context suffix), TTS spoke, and both the turn and the
    // generation are persisted. Single-agent conversations omit the redundant
    // per-agent `name` fields.
    expect(llm.requests[0]!.messages).toEqual([
      { role: "system", content: "Be concise." },
      {
        role: "user",
        content: expect.stringMatching(
          /^al: Hello there\.\n\nAdditional context: Now it is \d{1,2} [a-z]{3} \d{4}, \d{2}:\d{2}\. The current user is al with user id alice \(aliases: al\)\.$/,
        ),
      },
    ]);
    expect(tts.requests.map((request) => request.text)).toEqual(["Got it!"]);

    const transcript = await api.transcript(conversation.id);
    expect(transcript.map((entry) => entry.toString())).toEqual([
      "al: Hello there.",
      "Jarvis: Got it!",
    ]);
  });

  // -------------------------------------------------------------------------
  // Option plumbing: coordinations / retryDirectAnswer / restored roster.
  // Regression guard for the gap where conversations.create() silently dropped
  // these, so orchestrator-level coordinations were unreachable from the API.
  // -------------------------------------------------------------------------

  test("create forwards coordinations to the orchestrator", async () => {
    const persistence = new MemoryPersistence();
    const api = new Conversations({ persistence });

    const coordinationLlm = new FakeLLM(async function* () {
      yield { type: "delta", content: "The flight departs at 3pm." };
      yield { type: "done" };
    });
    const coordinatorLlm = new FakeLLM(async function* (request) {
      if (request.messages.at(-1)?.role === "tool") {
        yield { type: "delta", content: "All set." };
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
    });

    const coordinator = new Agent({ name: "Jarvis", llm: coordinatorLlm });
    const helper = new Agent({ name: "Helper", llm: new FakeLLM() });
    const conversation = await api.create({
      agents: [coordinator, helper],
      coordinations: {
        "resolve-details": { prompt: "You resolve details.", llm: coordinationLlm },
      },
    });

    await conversation.start();
    await conversation.participate({ userId: "alice" });
    conversation.send({ userId: "alice", text: "Book my flight." });

    // The delegation only resolves if the registration reached the orchestrator.
    await waitFor(() => coordinationLlm.requests.length >= 1);
    expect(coordinationLlm.requests[0]!.messages[0]).toEqual({
      role: "system",
      name: "resolve-details",
      content: "You resolve details.",
    });
  });

  test("create forwards retryDirectAnswer to the orchestrator", async () => {
    const persistence = new MemoryPersistence();
    const api = new Conversations({ persistence });

    // Answers directly (never delegates), so the multi-agent safety net is the
    // only thing that can produce a second coordinator call.
    const coordinatorLlm = new FakeLLM(async function* () {
      yield { type: "delta", content: "Direct answer." };
      yield { type: "done" };
    });
    const coordinator = new Agent({ name: "Jarvis", llm: coordinatorLlm });
    const helper = new Agent({ name: "Helper", llm: new FakeLLM() });
    const conversation = await api.create({
      agents: [coordinator, helper],
      retryDirectAnswer: true,
    });

    await conversation.start();
    await conversation.participate({ userId: "alice" });
    conversation.send({ userId: "alice", text: "Hello." });

    await waitFor(() => coordinatorLlm.requests.length >= 2);
    expect(coordinatorLlm.requests.length).toBe(2);
  });

  test("get rehydrates the agent roster when options are passed", async () => {
    const persistence = new MemoryPersistence();
    const api = new Conversations({ persistence });
    const jarvis = new Agent({ name: "Jarvis" });
    const created = await api.create({ agents: [jarvis] });

    // Without options a restored handle has no roster (cannot route a turn)...
    expect((await api.get(created.id))?.agents).toHaveLength(0);
    // ...and with them the roster comes back.
    const restored = await api.get(created.id, { agents: [jarvis] });
    expect(restored?.agents).toHaveLength(1);
  });

  test("get inherits instance STT/TTS when restoring a conversation", async () => {
    const persistence = new MemoryPersistence();
    const stt = new FakeSTT();
    const tts = new FakeTTS();
    const llm = new FakeLLM();
    const jarvis = new Agent({ name: "Jarvis", context: "Be concise.", llm });
    const api = new Conversations({ persistence, stt, tts });
    const created = await api.create({ agents: [jarvis] });

    const restored = (await api.get(created.id, { agents: [jarvis] }))!;
    await restored.participate({ userId: "alice", aliases: ["al"] });
    await restored.start();

    restored.listen({ userId: "alice", audio: new Uint8Array([1]) });
    expect(stt.sessions).toHaveLength(1);
    stt.sessions[0]!.emitFinal("Hello there.");
    await waitFor(() => llm.requests.length >= 1);
    await waitFor(async () => (await api.transcript(created.id)).length >= 2);

    // Audio reached the instance STT and the reply was synthesized by the
    // instance TTS. Neither provider is persisted.
    expect(tts.requests.map((request) => request.text)).toEqual(["Got it!"]);
  });

  test("get inherits the instance autoExecuteTools setting", async () => {
    const persistence = new MemoryPersistence();
    const executed: string[] = [];
    const getWeather = new Tool<{ city: string }, string>({
      name: "get_weather",
      description: "Get the weather for a city.",
      execute: ({ city }) => {
        executed.push(city);
        return `sunny in ${city}`;
      },
    });
    const llm = new FakeLLM(async function* (request) {
      if (request.messages.at(-1)?.role === "tool") {
        yield { type: "delta", content: "It is sunny in Paris." };
        yield { type: "done" };
        return;
      }
      yield { type: "delta", content: "Let me check. " };
      yield {
        type: "tool_call",
        id: "call_1",
        name: "get_weather",
        arguments: '{"city":"Paris"}',
      };
      yield { type: "done" };
    });
    const jarvis = new Agent({ name: "Jarvis", llm, tools: [getWeather] });

    // App-managed tools: the orchestrator surfaces the call and waits instead
    // of running it. A restored handle must not flip this back to auto-execute.
    const api = new Conversations({ persistence, autoExecuteTools: false });
    const created = await api.create({ agents: [jarvis] });

    const restored = (await api.get(created.id, { agents: [jarvis] }))!;
    const toolCalls: string[] = [];
    restored.on("tool-call", (payload) => toolCalls.push(payload.call.name));
    await restored.participate({ userId: "alice" });
    await restored.start();
    restored.send({ userId: "alice", text: "What is the weather in Paris?" });

    await waitFor(() => toolCalls.length >= 1);
    // An auto-executing orchestrator would have run the tool by now.
    await Bun.sleep(25);
    expect(toolCalls).toEqual(["get_weather"]);
    expect(executed).toEqual([]);
    expect(llm.requests).toHaveLength(1);
  });
});
