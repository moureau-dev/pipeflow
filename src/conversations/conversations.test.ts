import { describe, expect, test } from "bun:test";
import { Conversations } from "./conversations";
import { MemoryPersistence } from "../persistence/adapters/memory/memory";
import { Conversation } from "./conversation/conversation";
import { Agent } from "../agents/agent";

describe("Conversations", () => {
  test("create persists a conversation and returns a runtime handle", async () => {
    const conversations = new Conversations(new MemoryPersistence());
    const conversation = await conversations.create();

    expect(conversation).toBeInstanceOf(Conversation);
    expect(conversation.id).toBeTruthy();
    expect(conversation.status).toBe("created");
  });

  test("create records agent names", async () => {
    const persistence = new MemoryPersistence();
    const conversations = new Conversations(persistence);

    const jarvis = new Agent({ name: "Jarvis" });
    const conversation = await conversations.create({ agents: [jarvis] });

    const record = await persistence.getConversation(conversation.id);
    expect(record?.agentNames).toEqual(["Jarvis"]);
  });

  test("create without agents records an empty agent list", async () => {
    const persistence = new MemoryPersistence();
    const conversations = new Conversations(persistence);
    const conversation = await conversations.create();
    expect((await persistence.getConversation(conversation.id))?.agentNames).toEqual([]);
  });

  test("each conversation gets a unique id", async () => {
    const conversations = new Conversations(new MemoryPersistence());
    const a = await conversations.create();
    const b = await conversations.create();
    expect(a.id).not.toBe(b.id);
  });

  test("get returns a handle for existing conversations and null otherwise", async () => {
    const conversations = new Conversations(new MemoryPersistence());
    const created = await conversations.create();

    const fetched = await conversations.get(created.id);
    expect(fetched?.id).toBe(created.id);

    expect(await conversations.get("missing")).toBeNull();
  });

  test("transcript returns persisted entries for a conversation", async () => {
    const conversations = new Conversations(new MemoryPersistence());
    const conversation = await conversations.create();

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

    const transcript = await conversations.transcript(conversation.id);
    expect(transcript.map((entry) => entry.toString())).toEqual([
      "alice: Hello",
      "Jarvis: Hi!",
    ]);
  });

  test("transcript joins into a readable dump", async () => {
    const conversations = new Conversations(new MemoryPersistence());
    const conversation = await conversations.create();
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

    const transcript = await conversations.transcript(conversation.id);
    expect(transcript.join("\n")).toBe("alice: one\nbob: two");
  });

  test("transcript returns an empty list for a conversation without entries", async () => {
    const conversations = new Conversations(new MemoryPersistence());
    const conversation = await conversations.create();
    expect(await conversations.transcript(conversation.id)).toEqual([]);
  });

  test("transcript throws for unknown conversations", async () => {
    const conversations = new Conversations(new MemoryPersistence());
    await expect(conversations.transcript("missing")).rejects.toThrow(
      /Conversation "missing" not found/,
    );
  });

  test("conversations are isolated from each other", async () => {
    const conversations = new Conversations(new MemoryPersistence());
    const a = await conversations.create();
    const b = await conversations.create();

    await a.pushTranscript({
      speaker: "alice",
      speakerKind: "participant",
      text: "only in a",
    });

    expect(await conversations.transcript(a.id)).toHaveLength(1);
    expect(await conversations.transcript(b.id)).toEqual([]);
  });

  test("a full lifecycle works end to end", async () => {
    const persistence = new MemoryPersistence();
    const conversations = new Conversations(persistence);
    const conversation = await conversations.create();

    conversation.start();
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
    expect(await conversations.transcript(conversation.id)).toHaveLength(1);
    const record = await persistence.getConversation(conversation.id);
    expect(record?.endedAt).not.toBeNull();
  });
});
