import { describe, expect, test } from "bun:test";
import { Conversation } from "./conversation.ts";
import { MemoryPersistence } from "../../persistence/adapters/memory/memory.ts";
import type { Generation, Turn } from "../types.ts";

function makeConversation(
  options: { withPersistence?: boolean } = {},
): { conversation: Conversation; persistence: MemoryPersistence } {
  const persistence = options.withPersistence === false ? undefined : new MemoryPersistence();
  const conversation = new Conversation({ id: "conv-1", persistence });
  return { conversation, persistence: persistence! };
}

describe("Conversation", () => {
  test("starts in created status with no participants", () => {
    const { conversation } = makeConversation();
    expect(conversation.id).toBe("conv-1");
    expect(conversation.status).toBe("created");
    expect(conversation.participants).toEqual([]);
  });

  test("start moves the conversation to started and emits start", () => {
    const { conversation } = makeConversation();
    const events: string[] = [];
    conversation.on("start", () => events.push("start"));

    conversation.start();

    expect(conversation.status).toBe("started");
    expect(events).toEqual(["start"]);
  });

  test("start is idempotent", () => {
    const { conversation } = makeConversation();
    const events: string[] = [];
    conversation.on("start", () => events.push("start"));

    conversation.start();
    conversation.start();

    expect(events).toEqual(["start"]);
  });

  test("start after stop throws", async () => {
    const { conversation } = makeConversation();
    conversation.start();
    await conversation.stop();
    expect(() => conversation.start()).toThrow(/already been stopped/);
  });

  test("stop finalizes the conversation and emits stop", async () => {
    const { conversation, persistence } = makeConversation();
    const events: string[] = [];
    conversation.on("stop", () => events.push("stop"));

    conversation.start();
    await conversation.stop();

    expect(conversation.status).toBe("stopped");
    expect(events).toEqual(["stop"]);
    const record = await persistence.getConversation("conv-1");
    expect(record?.endedAt).not.toBeNull();
  });

  test("stop is idempotent and only finalizes once", async () => {
    const { conversation, persistence } = makeConversation();
    const events: string[] = [];
    conversation.on("stop", () => events.push("stop"));

    conversation.start();
    await conversation.stop();
    await conversation.stop();

    expect(events).toEqual(["stop"]);
    const record = await persistence.getConversation("conv-1");
    const firstEnd = record?.endedAt;
    expect(firstEnd).not.toBeNull();
  });

  test("participate adds a single participant and persists it", async () => {
    const { conversation, persistence } = makeConversation();
    const events: { userId: string }[] = [];
    conversation.on("participant", (payload) => events.push({ userId: payload.participant.userId }));

    const added = await conversation.participate({ userId: "alice", aliases: ["al"] });

    expect(added).toEqual([
      { userId: "alice", aliases: ["al"], joinedAt: expect.any(Number) },
    ]);
    expect(conversation.participants.map((p) => p.userId)).toEqual(["alice"]);
    expect(events).toEqual([{ userId: "alice" }]);

    const persisted = await persistence.listParticipants("conv-1");
    expect(persisted.map((p) => p.userId)).toEqual(["alice"]);
  });

  test("participate accepts a batch", async () => {
    const { conversation } = makeConversation();
    const added = await conversation.participate([
      { userId: "alice" },
      { userId: "bob", aliases: ["robert"] },
    ]);

    expect(added.map((p) => p.userId)).toEqual(["alice", "bob"]);
    expect(conversation.participants).toHaveLength(2);
    expect(conversation.participants[1]?.aliases).toEqual(["robert"]);
  });

  test("participate rejects duplicate user ids", async () => {
    const { conversation } = makeConversation();
    await conversation.participate({ userId: "alice" });
    await expect(conversation.participate({ userId: "alice" })).rejects.toThrow(
      /already exists/,
    );
  });

  test("a batch with a duplicate is rejected atomically", async () => {
    const { conversation } = makeConversation();
    await conversation.participate({ userId: "alice" });

    await expect(
      conversation.participate([{ userId: "bob" }, { userId: "alice" }]),
    ).rejects.toThrow(/already exists/);

    // Bob was not added.
    expect(conversation.participants.map((p) => p.userId)).toEqual(["alice"]);
  });

  test("a batch with an internal duplicate is rejected", async () => {
    const { conversation } = makeConversation();
    await expect(
      conversation.participate([{ userId: "alice" }, { userId: "alice" }]),
    ).rejects.toThrow(/Duplicate participant/);
    expect(conversation.participants).toEqual([]);
  });

  test("participate after stop throws", async () => {
    const { conversation } = makeConversation();
    conversation.start();
    await conversation.stop();
    await expect(conversation.participate({ userId: "alice" })).rejects.toThrow(
      /already been stopped/,
    );
  });

  test("listen requires a started conversation", () => {
    const { conversation } = makeConversation();
    expect(() =>
      conversation.listen({ userId: "alice", audio: new Uint8Array([1]) }),
    ).toThrow(/not started/);
  });

  test("listen requires a known participant", () => {
    const { conversation } = makeConversation();
    conversation.start();
    expect(() =>
      conversation.listen({ userId: "alice", audio: new Uint8Array([1]) }),
    ).toThrow(/Unknown participant "alice"/);
  });

  test("listen emits audio-in with increasing sequence numbers", async () => {
    const { conversation } = makeConversation();
    conversation.start();
    await conversation.participate({ userId: "alice" });

    const chunks: { userId: string; data: Uint8Array; sequence: number }[] = [];
    conversation.on("audio-in", (payload) =>
      chunks.push({
        userId: payload.userId,
        data: payload.audio.data,
        sequence: payload.audio.sequence,
      }),
    );

    conversation.listen({ userId: "alice", audio: new Uint8Array([1, 2]) });
    conversation.listen({ userId: "alice", audio: new Uint8Array([3]) });

    expect(chunks.map((c) => [c.userId, [...c.data], c.sequence])).toEqual([
      ["alice", [1, 2], 0],
      ["alice", [3], 1],
    ]);
  });

  test("listen after stop throws", async () => {
    const { conversation } = makeConversation();
    conversation.start();
    await conversation.participate({ userId: "alice" });
    await conversation.stop();
    expect(() =>
      conversation.listen({ userId: "alice", audio: new Uint8Array([1]) }),
    ).toThrow(/not started/);
  });

  test("interrupt cancels the current generation and emits interrupt", async () => {
    const { conversation, persistence } = makeConversation();
    const events: string[] = [];
    conversation.on("interrupt", () => events.push("interrupt"));

    const generation: Generation = {
      id: "gen-1",
      conversationId: "conv-1",
      agentName: "Jarvis",
      text: "streaming...",
      status: "streaming",
      startedAt: 1,
    };
    await conversation.pushGeneration(generation);

    conversation.interrupt();

    expect(events).toEqual(["interrupt"]);
    expect(conversation.state.currentGeneration).toBeNull();
    expect(generation.status).toBe("cancelled");
    expect(generation.endedAt).toBeDefined();

    // Cancellation is persisted.
    const persisted = await persistence.listGenerations("conv-1");
    expect(persisted[0]?.status).toBe("cancelled");
  });

  test("interrupt with no active generation is a no-op", () => {
    const { conversation } = makeConversation();
    expect(() => conversation.interrupt()).not.toThrow();
  });

  test("pushAudio emits audio events to listeners", () => {
    const { conversation } = makeConversation();
    const received: { sequence: number; data: Uint8Array }[] = [];
    conversation.on("audio", (payload) =>
      received.push({ sequence: payload.audio.sequence, data: payload.audio.data }),
    );

    conversation.pushAudio({
      data: new Uint8Array([9]),
      timestamp: 1,
      sequence: 0,
    });

    expect(received).toHaveLength(1);
    expect([...received[0]!.data]).toEqual([9]);
  });

  test("pushTurn updates state, emits, and persists", async () => {
    const { conversation, persistence } = makeConversation();
    const turn: Turn = {
      id: "turn-1",
      conversationId: "conv-1",
      participantId: "alice",
      participantName: "alice",
      text: "Hello",
      sequence: 0,
      startedAt: 1,
      endedAt: 2,
    };

    const events: Turn[] = [];
    conversation.on("turn", (payload) => events.push(payload.turn));

    await conversation.pushTurn(turn);

    expect(events).toEqual([turn]);
    expect(conversation.state.currentTurn).toBe(turn);
    const persisted = await persistence.listTurns("conv-1");
    expect(persisted).toEqual([turn]);
  });

  test("pushTranscript appends, emits, and persists", async () => {
    const { conversation, persistence } = makeConversation();
    const events: { speaker: string; text: string }[] = [];
    conversation.on("transcript", (payload) =>
      events.push({ speaker: payload.entry.speaker, text: payload.entry.text }),
    );

    const entry = await conversation.pushTranscript({
      speaker: "alice",
      speakerKind: "participant",
      text: "Hello there",
    });

    expect(events).toEqual([{ speaker: "alice", text: "Hello there" }]);
    expect(conversation.state.transcriptCount).toBe(1);
    expect(conversation.transcript()).toEqual([entry]);

    const persisted = await persistence.listTranscript("conv-1");
    expect(persisted[0]?.toString()).toBe("alice: Hello there");
  });

  test("pushGeneration sets the current generation and persists", async () => {
    const { conversation, persistence } = makeConversation();
    const generation: Generation = {
      id: "gen-1",
      conversationId: "conv-1",
      agentName: "Jarvis",
      text: "",
      status: "streaming",
      startedAt: 1,
    };

    const events: string[] = [];
    conversation.on("generation", () => events.push("generation"));

    await conversation.pushGeneration(generation);

    expect(events).toEqual(["generation"]);
    expect(conversation.state.currentGeneration).toBe(generation);
    const persisted = await persistence.listGenerations("conv-1");
    expect(persisted[0]?.status).toBe("streaming");
  });

  test("completeGeneration marks the streaming generation completed", async () => {
    const { conversation, persistence } = makeConversation();
    await conversation.pushGeneration({
      id: "gen-1",
      conversationId: "conv-1",
      agentName: "Jarvis",
      text: "answer",
      status: "streaming",
      startedAt: 1,
    });

    await conversation.completeGeneration();

    expect(conversation.state.currentGeneration?.status).toBe("completed");
    expect(conversation.state.currentGeneration?.endedAt).toBeDefined();
    const persisted = await persistence.listGenerations("conv-1");
    expect(persisted[0]?.status).toBe("completed");
  });

  test("completeGeneration without a streaming generation is a no-op", async () => {
    const { conversation } = makeConversation();
    await expect(conversation.completeGeneration()).resolves.toBeUndefined();
  });

  test("unsubscribe stops event delivery", async () => {
    const { conversation } = makeConversation();
    let count = 0;
    const unsubscribe = conversation.on("start", () => count++);

    conversation.start();
    unsubscribe();
    expect(() => conversation.start()).not.toThrow();

    // start is idempotent, so simulate another event: participant.
    await conversation.participate({ userId: "alice" });
    expect(count).toBe(1);
  });

  test("multiple listeners receive the same event", () => {
    const { conversation } = makeConversation();
    let first = 0;
    let second = 0;
    conversation.on("start", () => first++);
    conversation.on("start", () => second++);

    conversation.start();

    expect(first).toBe(1);
    expect(second).toBe(1);
  });

  test("state events fire on lifecycle changes", async () => {
    const { conversation } = makeConversation();
    const statuses: string[] = [];
    conversation.on("state", (payload) => statuses.push(payload.state.status));

    conversation.start();
    await conversation.stop();

    expect(statuses).toEqual(["started", "stopped"]);
  });
});
