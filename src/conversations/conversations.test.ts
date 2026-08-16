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
  async *stream(request: LLMRequest): AsyncGenerator<LLMEvent> {
    this.requests.push(request);
    yield { type: "delta", content: "Got it!" };
    yield { type: "done" };
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

  test("start() rejects conversations with multiple agents", async () => {
    const stt = new FakeSTT();
    const tts = new FakeTTS();
    const api = conversations({ stt, tts });
    const conversation = await api.create({
      agents: [
        new Agent({ name: "Jarvis", llm: new FakeLLM() }),
        new Agent({ name: "Analyst", llm: new FakeLLM() }),
      ],
    });
    await conversation.participate({ userId: "alice" });

    await expect(conversation.start()).rejects.toThrow(/Multi-agent conversations are not supported/);
    // Rejection happens before any state is mutated.
    expect(conversation.status).toBe("created");
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

    // The orchestrator ran the pipeline: the LLM saw the turn, TTS spoke,
    // and both the turn and the generation are persisted.
    expect(llm.requests[0]!.messages).toEqual([
      { role: "system", content: "Be concise." },
      { role: "user", content: "al: Hello there." },
    ]);
    expect(tts.requests.map((request) => request.text)).toEqual(["Got it!"]);

    const transcript = await api.transcript(conversation.id);
    expect(transcript.map((entry) => entry.toString())).toEqual([
      "al: Hello there.",
      "Jarvis: Got it!",
    ]);
  });
});
