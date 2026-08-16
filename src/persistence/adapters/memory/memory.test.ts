import { describe, expect, test } from "bun:test";
import { persistenceContractTests } from "../../contract-tests";
import { MemoryPersistence } from "./memory";

persistenceContractTests(() => new MemoryPersistence());

describe("MemoryPersistence", () => {
  test("each instance starts empty and is isolated", async () => {
    const a = new MemoryPersistence();
    const b = new MemoryPersistence();

    const record = await a.createConversation();
    expect(await a.getConversation(record.id)).not.toBeNull();
    expect(await b.listConversations()).toEqual([]);
  });

  test("stored data is not aliased to caller-owned objects", async () => {
    const persistence = new MemoryPersistence();
    const record = await persistence.createConversation({
      id: "conv-1",
      agentNames: ["Jarvis"],
    });

    record.agentNames.push("mutated");
    const fetched = await persistence.getConversation("conv-1");
    expect(fetched?.agentNames).toEqual(["Jarvis"]);

    const participant = { userId: "alice", aliases: ["al"], joinedAt: 1 };
    await persistence.addParticipant("conv-1", participant);
    participant.aliases.push("mutated");

    const listed = await persistence.listParticipants("conv-1");
    expect(listed[0]?.aliases).toEqual(["al"]);
  });
});
