import { describe, expect, test } from "bun:test";
import type { Generation, Participant, Turn } from "../conversations/types.ts";
import { TranscriptEntry } from "../conversations/transcription/transcription.ts";
import type { Persistence } from "./persistence.ts";

/**
 * A shared test suite that every Persistence adapter must pass.
 * Adapters call `persistenceContractTests(() => new Adapter())` from their
 * own test file, which guarantees consistent behavior across backends.
 */
export function persistenceContractTests(create: () => Persistence): void {
  const participant = (userId: string, aliases: string[] = []): Participant => ({
    userId,
    aliases,
    joinedAt: Date.now(),
  });

  const entry = (
    conversationId: string,
    speaker: string,
    text: string,
    sequence: number,
  ): TranscriptEntry =>
    new TranscriptEntry({
      conversationId,
      speaker,
      speakerKind: "participant",
      text,
      timestamp: Date.now(),
      sequence,
    });

  const turn = (
    conversationId: string,
    participantId: string,
    text: string,
    sequence: number,
  ): Turn => ({
    id: crypto.randomUUID(),
    conversationId,
    participantId,
    participantName: participantId,
    text,
    sequence,
    startedAt: Date.now(),
    endedAt: Date.now() + 100,
  });

  const generation = (
    conversationId: string,
    text: string,
    status: Generation["status"] = "completed",
  ): Generation => ({
    id: crypto.randomUUID(),
    conversationId,
    agentName: "Jarvis",
    text,
    status,
    startedAt: Date.now(),
    endedAt: status === "streaming" ? undefined : Date.now(),
  });

  describe("conversation lifecycle", () => {
    test("create returns a persisted record with defaults", async () => {
      const persistence = create();
      const record = await persistence.createConversation({ agentNames: ["Jarvis"] });

      expect(record.id).toBeTruthy();
      expect(record.agentNames).toEqual(["Jarvis"]);
      expect(record.endedAt).toBeNull();
      expect(record.createdAt).toBeGreaterThan(0);

      const fetched = await persistence.getConversation(record.id);
      expect(fetched).toEqual(record);
    });

    test("create honors an explicit id", async () => {
      const persistence = create();
      const record = await persistence.createConversation({ id: "conv-abc" });
      expect(record.id).toBe("conv-abc");
    });

    test("getConversation returns null for unknown ids", async () => {
      const persistence = create();
      expect(await persistence.getConversation("missing")).toBeNull();
    });

    test("listConversations returns conversations in creation order", async () => {
      const persistence = create();
      const a = await persistence.createConversation({ agentNames: ["a"] });
      const b = await persistence.createConversation({ agentNames: ["b"] });

      const listed = await persistence.listConversations();
      expect(listed.map((c) => c.id)).toEqual([a.id, b.id]);
    });

    test("finalizeConversation stamps endedAt", async () => {
      const persistence = create();
      const record = await persistence.createConversation();
      const endedAt = 123456;

      const finalized = await persistence.finalizeConversation(record.id, endedAt);
      expect(finalized?.endedAt).toBe(endedAt);

      const fetched = await persistence.getConversation(record.id);
      expect(fetched?.endedAt).toBe(endedAt);
    });

    test("finalizeConversation returns null for unknown conversations", async () => {
      const persistence = create();
      expect(await persistence.finalizeConversation("missing")).toBeNull();
    });

    test("deleteConversation removes the conversation and its data", async () => {
      const persistence = create();
      const record = await persistence.createConversation();
      await persistence.addParticipant(record.id, participant("alice"));

      expect(await persistence.deleteConversation(record.id)).toBe(true);
      expect(await persistence.getConversation(record.id)).toBeNull();
      expect(await persistence.listParticipants(record.id)).toEqual([]);
      expect(await persistence.deleteConversation(record.id)).toBe(false);
    });
  });

  describe("participants", () => {
    test("round-trips participants with aliases in order", async () => {
      const persistence = create();
      const record = await persistence.createConversation();
      await persistence.addParticipant(record.id, participant("alice", ["al", "ally"]));
      await persistence.addParticipant(record.id, participant("bob"));

      const listed = await persistence.listParticipants(record.id);
      expect(listed.map((p) => p.userId)).toEqual(["alice", "bob"]);
      expect(listed[0]?.aliases).toEqual(["al", "ally"]);
    });

    test("participants are isolated between conversations", async () => {
      const persistence = create();
      const a = await persistence.createConversation();
      const b = await persistence.createConversation();
      await persistence.addParticipant(a.id, participant("alice"));

      expect(await persistence.listParticipants(a.id)).toHaveLength(1);
      expect(await persistence.listParticipants(b.id)).toEqual([]);
    });
  });

  describe("transcript", () => {
    test("round-trips entries in sequence order", async () => {
      const persistence = create();
      const record = await persistence.createConversation();
      await persistence.appendTranscript(record.id, entry(record.id, "alice", "hello", 0));
      await persistence.appendTranscript(record.id, entry(record.id, "Jarvis", "hi", 1));

      const listed = await persistence.listTranscript(record.id);
      expect(listed.map((e) => [e.speaker, e.text, e.sequence])).toEqual([
        ["alice", "hello", 0],
        ["Jarvis", "hi", 1],
      ]);
    });

    test("rehydrated entries support toString", async () => {
      const persistence = create();
      const record = await persistence.createConversation();
      await persistence.appendTranscript(record.id, entry(record.id, "alice", "hello", 0));

      const listed = await persistence.listTranscript(record.id);
      expect(listed[0]?.toString()).toBe("alice: hello");
    });

    test("upserting an entry with the same id replaces it", async () => {
      const persistence = create();
      const record = await persistence.createConversation();
      const original = entry(record.id, "alice", "hello", 0);
      await persistence.appendTranscript(record.id, original);

      const updated = new TranscriptEntry({ ...original, text: "hello again" });
      await persistence.appendTranscript(record.id, updated);

      const listed = await persistence.listTranscript(record.id);
      expect(listed).toHaveLength(1);
      expect(listed[0]?.text).toBe("hello again");
    });
  });

  describe("turns", () => {
    test("round-trips turns in order", async () => {
      const persistence = create();
      const record = await persistence.createConversation();
      await persistence.appendTurn(record.id, turn(record.id, "alice", "first", 0));
      await persistence.appendTurn(record.id, turn(record.id, "bob", "second", 1));

      const listed = await persistence.listTurns(record.id);
      expect(listed.map((t) => [t.participantId, t.text, t.sequence])).toEqual([
        ["alice", "first", 0],
        ["bob", "second", 1],
      ]);
    });
  });

  describe("generations", () => {
    test("round-trips generations with status", async () => {
      const persistence = create();
      const record = await persistence.createConversation();
      await persistence.appendGeneration(record.id, generation(record.id, "hi", "completed"));

      const listed = await persistence.listGenerations(record.id);
      expect(listed).toHaveLength(1);
      expect(listed[0]?.agentName).toBe("Jarvis");
      expect(listed[0]?.status).toBe("completed");
    });

    test("upserting a generation updates status in place", async () => {
      const persistence = create();
      const record = await persistence.createConversation();
      const streaming = generation(record.id, "", "streaming");
      await persistence.appendGeneration(record.id, streaming);

      const completed: Generation = {
        ...streaming,
        status: "completed",
        text: "final answer",
        endedAt: Date.now(),
      };
      await persistence.appendGeneration(record.id, completed);

      const listed = await persistence.listGenerations(record.id);
      expect(listed).toHaveLength(1);
      expect(listed[0]?.status).toBe("completed");
      expect(listed[0]?.text).toBe("final answer");
      expect(listed[0]?.endedAt).toBeDefined();
    });
  });
}
