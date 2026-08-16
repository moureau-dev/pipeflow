import { describe, expect, test } from "bun:test";
import {
  Agent,
  Conversation,
  Conversations,
  DeepSeekLLM,
  DeepgramSTT,
  KokoroTTS,
  MemoryPersistence,
  MemoryTransport,
  Pipeflow,
  PipeflowTool,
  SQLitePersistence,
  Tool,
  Transcription,
  TranscriptEntry,
} from "./index.ts";
import type { LLM, LLMEvent, LLMRequest } from "./index.ts";

class FakeLLM implements LLM {
  readonly requests: LLMRequest[] = [];
  constructor(
    private readonly eventsFor: (request: LLMRequest) => LLMEvent[],
  ) {}
  async *stream(request: LLMRequest): AsyncGenerator<LLMEvent> {
    this.requests.push(request);
    for (const event of this.eventsFor(request)) yield event;
  }
  stop(): void {}
}

describe("Pipeflow", () => {
  test("defaults to an in-memory persistence", async () => {
    const pipeflow = new Pipeflow();
    const conversation = await pipeflow.conversations.create();
    expect(conversation.id).toBeTruthy();
  });

  test("exposes the configured providers and api key", () => {
    const llm = new FakeLLM(() => [{ type: "done" }]);
    const pipeflow = new Pipeflow({ apiKey: "secret", llm });
    expect(pipeflow.apiKey).toBe("secret");
    expect(pipeflow.llm).toBe(llm);
    expect(pipeflow.stt).toBeUndefined();
    expect(pipeflow.tts).toBeUndefined();
  });

  test("agent() creates agents bound to the instance LLM", async () => {
    const llm = new FakeLLM(() => [
      { type: "delta", content: "hello" },
      { type: "done" },
    ]);
    const pipeflow = new Pipeflow({ llm });

    const agent = pipeflow.agent({ name: "Jarvis", context: "Be concise." });
    expect(agent).toBeInstanceOf(Agent);

    const result = await agent.run({ prompt: "Say hi" });
    expect(result.text).toBe("hello");
  });

  test("agent() without a configured LLM fails at run time with a clear error", async () => {
    const pipeflow = new Pipeflow();
    const agent = pipeflow.agent({ name: "Jarvis" });
    await expect(agent.run({ prompt: "hi" })).rejects.toThrow(/no LLM provider/);
  });

  test("agent() can override the LLM for a specific agent", async () => {
    const instanceLlm = new FakeLLM(() => [{ type: "delta", content: "instance" }, { type: "done" }]);
    const agentLlm = new FakeLLM(() => [{ type: "delta", content: "override" }, { type: "done" }]);
    const pipeflow = new Pipeflow({ llm: instanceLlm });

    const agent = pipeflow.agent({ name: "Jarvis", llm: agentLlm });
    const result = await agent.run({ prompt: "hi" });

    expect(result.text).toBe("override");
    expect(instanceLlm.requests).toHaveLength(0);
  });

  test("an end-to-end session works through the public API", async () => {
    const pipeflow = new Pipeflow();

    const agent = pipeflow.agent({
      name: "Jarvis",
      context: "You are helpful.",
    });

    const conversation = await pipeflow.conversations.create({ agents: [agent] });
    expect(conversation).toBeInstanceOf(Conversation);

    conversation.start();
    await conversation.participate([
      { userId: "alice" },
      { userId: "bob", aliases: ["robert"] },
    ]);

    const played: number[][] = [];
    conversation.on("audio", (payload) => played.push([...payload.audio.data]));

    conversation.listen({ userId: "alice", audio: new Uint8Array([1, 2]) });
    conversation.pushAudio({ data: new Uint8Array([7, 8]), timestamp: 1, sequence: 0 });

    await conversation.pushTranscript({
      speaker: "alice",
      speakerKind: "participant",
      text: "Hello Jarvis",
    });

    await conversation.stop();

    expect(played).toEqual([[7, 8]]);
    const transcript = await pipeflow.conversations.transcript(conversation.id);
    expect(transcript.join("\n")).toBe("alice: Hello Jarvis");
  });

  test("accepts custom persistence (SQLite)", async () => {
    const pipeflow = new Pipeflow({ persistence: new SQLitePersistence() });
    const conversation = await pipeflow.conversations.create();
    expect(conversation.id).toBeTruthy();
  });
});

describe("public exports", () => {
  test("PipeflowTool is an alias of Tool", () => {
    const tool = new PipeflowTool({
      name: "get_weather",
      description: "Weather",
      execute: () => "sunny",
    });
    expect(tool).toBeInstanceOf(Tool);
  });

  test("core classes are exported", () => {
    expect(typeof Agent).toBe("function");
    expect(typeof Conversation).toBe("function");
    expect(typeof Conversations).toBe("function");
    expect(typeof Transcription).toBe("function");
    expect(typeof TranscriptEntry).toBe("function");
    expect(typeof Tool).toBe("function");
  });

  test("provider adapters are exported", () => {
    expect(DeepSeekLLM.name).toBe("DeepSeekLLM");
    expect(DeepgramSTT.name).toBe("DeepgramSTT");
    expect(KokoroTTS.name).toBe("KokoroTTS");
    expect(MemoryPersistence.name).toBe("MemoryPersistence");
    expect(SQLitePersistence.name).toBe("SQLitePersistence");
    expect(MemoryTransport.name).toBe("MemoryTransport");
  });
});
