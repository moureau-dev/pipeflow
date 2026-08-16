import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistenceContractTests } from "../../contract-tests";
import { TranscriptEntry } from "../../../conversations/transcription/transcription";
import { SQLitePersistence } from "./sqlite";

persistenceContractTests(() => new SQLitePersistence());

describe("SQLitePersistence", () => {
  test("uses an isolated in-memory database per instance", async () => {
    const a = new SQLitePersistence();
    const b = new SQLitePersistence();

    const record = await a.createConversation();
    expect(await a.getConversation(record.id)).not.toBeNull();
    expect(await b.listConversations()).toEqual([]);

    a.close();
    b.close();
  });

  test("schema creation is idempotent", () => {
    const db = new SQLitePersistence();
    expect(() => new SQLitePersistence()).not.toThrow();
    db.close();
  });

  test("persists data across instances backed by the same file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pipeflow-test-"));
    const filename = join(dir, "conversations.db");

    try {
      const first = new SQLitePersistence({ filename });
      const conversation = await first.createConversation({ agentNames: ["Jarvis"] });
      await first.addParticipant(conversation.id, {
        userId: "alice",
        aliases: ["al"],
        joinedAt: 1000,
      });
      await first.appendTranscript(
        conversation.id,
        new TranscriptEntry({
          conversationId: conversation.id,
          speaker: "alice",
          speakerKind: "participant",
          text: "hello from session one",
          timestamp: 2000,
          sequence: 0,
        }),
      );
      first.close();

      const second = new SQLitePersistence({ filename });
      const fetched = await second.getConversation(conversation.id);
      expect(fetched?.agentNames).toEqual(["Jarvis"]);
      expect(await second.listParticipants(conversation.id)).toEqual([
        { userId: "alice", aliases: ["al"], joinedAt: 1000 },
      ]);
      const entries = await second.listTranscript(conversation.id);
      expect(entries[0]?.toString()).toBe("alice: hello from session one");
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("addParticipant replaces an existing participant with the same user id", async () => {
    const persistence = new SQLitePersistence();
    const conversation = await persistence.createConversation();
    await persistence.addParticipant(conversation.id, {
      userId: "alice",
      aliases: ["old"],
      joinedAt: 1,
    });
    await persistence.addParticipant(conversation.id, {
      userId: "alice",
      aliases: ["new"],
      joinedAt: 2,
    });

    const listed = await persistence.listParticipants(conversation.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.aliases).toEqual(["new"]);
    persistence.close();
  });

  test("querying a closed database throws", async () => {
    const persistence = new SQLitePersistence();
    persistence.close();
    expect(persistence.listConversations()).rejects.toThrow();
  });
});
