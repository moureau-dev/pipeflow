import { describe, expect, test } from "bun:test";
import { Agent } from "../../agents/agent";
import { MemoryPersistence } from "../../persistence/adapters/memory/memory";
import type { LLM, LLMEvent, LLMRequest } from "../../providers/llm/types";
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
