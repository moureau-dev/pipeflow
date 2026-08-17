import { describe, expect, test } from "bun:test";
import { Agent } from "../../agents/agent";
import { MemoryPersistence } from "../../persistence/adapters/memory/memory";
import type { LLM, LLMEvent, LLMRequest } from "../../providers/llm/types";
import type { Generation } from "../types";
import { Conversation } from "../conversation/conversation";
import { Conversations } from "../conversations";
import { ConversationStream } from "./conversation-stream";

class FakeLLM implements LLM {
  async *stream(_request: LLMRequest): AsyncGenerator<LLMEvent> {
    for (const chunk of ["Hel", "lo", " world"]) yield { type: "delta", content: chunk };
    yield { type: "done" };
  }
  stop(): void {}
}

class TwoReplyLLM implements LLM {
  private replies = 0;
  async *stream(_request: LLMRequest): AsyncGenerator<LLMEvent> {
    if (this.replies++ === 0) {
      yield { type: "delta", content: "One" };
      yield { type: "delta", content: "Two" };
    } else {
      yield { type: "delta", content: "Three" };
    }
    yield { type: "done" };
  }
  stop(): void {}
}

function completedGeneration(conversationId: string): Generation {
  return {
    id: "g",
    conversationId,
    agentName: "Jarvis",
    text: "done",
    status: "completed",
    startedAt: 0,
    endedAt: 0,
  };
}

describe("ConversationStream", () => {
  test("streams a real reply incrementally through the orchestrator", async () => {
    const api = new Conversations({ persistence: new MemoryPersistence() });
    const conversation = await api.create({
      agents: [
        new Agent({ name: "Jarvis", context: "You answer briefly.", llm: new FakeLLM() }),
      ],
    });
    const stream = new ConversationStream(conversation);

    const order: string[] = [];
    const items: string[] = [];
    let agent: string | undefined;
    let objectDone: Record<string, unknown> | undefined;
    stream.when("agent", (value) => {
      agent = value as string;
      order.push("agent");
    });
    stream.whenItem("text", (chunk, index) => {
      items.push(chunk as string);
      order.push(`item:${index}`);
    });
    stream.whenObjectDone((object) => {
      objectDone = object;
      order.push("object");
    });

    await conversation.start();
    await conversation.participate({ userId: "alice" });
    conversation.send({ userId: "alice", text: "Hi" });

    const deadline = Date.now() + 5000;
    while (objectDone === undefined && Date.now() < deadline) {
      await Bun.sleep(10);
    }

    expect(objectDone).toEqual({ agent: "Jarvis", text: ["Hel", "lo", " world"] });
    expect(items).toEqual(["Hel", "lo", " world"]);
    expect(agent).toBe("Jarvis");
    expect(order).toEqual(["agent", "item:0", "item:1", "item:2", "object"]);

    stream.dispose();
    await conversation.stop();
  });

  test("an interrupt ends the object without completing it", async () => {
    const conversation = new Conversation({ id: "c" });
    const stream = new ConversationStream(conversation);
    const items: string[] = [];
    let objectDone = false;
    stream.whenItem("text", (chunk) => items.push(chunk as string));
    stream.whenObjectDone(() => {
      objectDone = true;
    });

    conversation.pushTextDelta("Hello");
    conversation.emit("interrupt", { conversationId: "c" });

    expect(items).toEqual(["Hello"]);
    expect(objectDone).toBe(false);
    stream.dispose();
  });

  test("a provider error aborts the object and routes to onError", async () => {
    const conversation = new Conversation({ id: "c" });
    const stream = new ConversationStream(conversation);
    const items: string[] = [];
    const errors: Error[] = [];
    let objectDone = false;
    stream.whenItem("text", (chunk) => items.push(chunk as string));
    stream.whenObjectDone(() => {
      objectDone = true;
    });
    stream.onError((error) => errors.push(error));

    conversation.pushTextDelta("par");
    conversation.emit("error", { conversationId: "c", error: new Error("llm failed") });

    expect(items).toEqual(["par"]);
    expect(errors).toHaveLength(1);
    expect(objectDone).toBe(false);
    stream.dispose();
  });

  test("each generation produces its own object, exactly once", async () => {
    const api = new Conversations({ persistence: new MemoryPersistence() });
    const conversation = await api.create({
      agents: [
        new Agent({ name: "Jarvis", context: "You answer briefly.", llm: new TwoReplyLLM() }),
      ],
    });
    const stream = new ConversationStream(conversation);
    const objects: Record<string, unknown>[] = [];
    const fragments: string[] = [];
    stream.whenItem("text", (fragment) => fragments.push(fragment as string));
    stream.whenObjectDone((object) => objects.push(object));

    await conversation.start();
    await conversation.participate({ userId: "alice" });

    conversation.send({ userId: "alice", text: "First" });
    let deadline = Date.now() + 5000;
    while (objects.length < 1 && Date.now() < deadline) await Bun.sleep(10);
    await Bun.sleep(50); // let the orchestrator settle between turns

    conversation.send({ userId: "alice", text: "Second" });
    deadline = Date.now() + 5000;
    while (objects.length < 2 && Date.now() < deadline) await Bun.sleep(10);

    expect(objects).toEqual([
      { agent: "Jarvis", text: ["One", "Two"] },
      { agent: "Jarvis", text: ["Three"] },
    ]);
    expect(fragments).toEqual(["One", "Two", "Three"]);
    stream.dispose();
    await conversation.stop();
  });

  test("generation-complete fires exactly once per object", async () => {
    const conversation = new Conversation({ id: "c" });
    const stream = new ConversationStream(conversation);
    const fragments: string[] = [];
    let objects = 0;
    stream.whenItem("text", (fragment) => fragments.push(fragment as string));
    stream.whenObjectDone(() => {
      objects++;
    });

    conversation.pushTextDelta("Hi");
    conversation.emit("generation-complete", {
      conversationId: "c",
      generation: completedGeneration("c"),
    });
    conversation.emit("generation-complete", {
      conversationId: "c",
      generation: completedGeneration("c"),
    });

    expect(objects).toBe(1);
    expect(fragments).toEqual(["Hi"]);
    stream.dispose();
  });

  test("cancel() is idempotent and interrupts the current generation", async () => {
    const conversation = new Conversation({ id: "c" });
    let interrupts = 0;
    conversation.on("interrupt", () => {
      interrupts++;
    });
    const stream = new ConversationStream(conversation);
    const fragments: string[] = [];
    let objects = 0;
    stream.whenItem("text", (fragment) => fragments.push(fragment as string));
    stream.whenObjectDone(() => {
      objects++;
    });

    conversation.pushTextDelta("Hel");
    stream.cancel();
    stream.cancel();

    expect(fragments).toEqual(["Hel"]);
    expect(objects).toBe(0); // cancelled: no completion event
    expect(interrupts).toBe(1); // idempotent: one interrupt reached the conversation
    stream.dispose();
  });

  test("after a cancel, the next generation still produces its own object", async () => {
    const api = new Conversations({ persistence: new MemoryPersistence() });
    const conversation = await api.create({
      agents: [
        new Agent({ name: "Jarvis", context: "You answer briefly.", llm: new TwoReplyLLM() }),
      ],
    });
    const stream = new ConversationStream(conversation);
    const fragments: string[] = [];
    const objects: Record<string, unknown>[] = [];
    let cancelled = false;
    stream.whenItem("text", (fragment) => {
      fragments.push(fragment as string);
      if (!cancelled) {
        cancelled = true;
        stream.cancel(); // abort generation #1 at its first fragment
      }
    });
    stream.whenObjectDone((object) => objects.push(object));

    await conversation.start();
    await conversation.participate({ userId: "alice" });

    conversation.send({ userId: "alice", text: "First" });
    let deadline = Date.now() + 5000;
    while (!cancelled && Date.now() < deadline) await Bun.sleep(5); // first fragment → cancel
    expect(cancelled).toBe(true);
    await Bun.sleep(20); // let the interrupted generation unwind

    conversation.send({ userId: "alice", text: "Second" });
    deadline = Date.now() + 5000;
    while (objects.length < 1 && Date.now() < deadline) await Bun.sleep(10);

    // Generation #2 is a fresh object: the interrupted #1 never completes.
    expect(objects).toEqual([{ agent: "Jarvis", text: ["Three"] }]);
    expect(fragments).toEqual(["One", "Three"]);
    stream.dispose();
    await conversation.stop();
  });

  test("dispose stops listening", async () => {
    const conversation = new Conversation({ id: "c" });
    const stream = new ConversationStream(conversation);
    const items: string[] = [];
    stream.whenItem("text", (chunk) => items.push(chunk as string));
    stream.dispose();

    conversation.pushTextDelta("late");
    expect(items).toEqual([]);
  });
});
