import { describe, expect, test } from "bun:test";
import { Conversation } from "../../../conversation/conversation";
import { MemoryPersistence } from "../../../../persistence/adapters/memory/memory";
import { ToolCallManager } from "./tools";
import type { ToolCall } from "../../../types";

function makeConversation(): Conversation {
  return new Conversation({ id: "conv-1", persistence: new MemoryPersistence() });
}

function makeManager(conversation: Conversation, timeoutMs = 10_000): {
  manager: ToolCallManager;
  conversation: Conversation;
} {
  const manager = new ToolCallManager(conversation, timeoutMs);
  conversation.on("tool-call-result", ({ result }) => manager.handleResult(result));
  return { manager, conversation };
}

describe("ToolCallManager", () => {
  test("resolves calls through the application", async () => {
    const conversation = makeConversation();
    const { manager } = makeManager(conversation);
    const emitted: ToolCall[] = [];
    conversation.on("tool-call", ({ call }) => emitted.push(call));

    const pending = manager.resolveCalls([
      { id: "call-1", name: "get_weather", arguments: '{"city":"paris"}' },
      { id: "call-2", name: "get_weather", arguments: "not json" },
    ]);
    expect(emitted).toHaveLength(2);
    expect(emitted[0]!.arguments).toEqual({ city: "paris" });
    expect(emitted[1]!.arguments).toBe("not json");

    conversation.resolveToolCall({ id: "call-1", result: "sunny" });
    conversation.resolveToolCall({ id: "call-2", error: "API down" });
    const results = await pending;
    expect(results).toEqual([
      { id: "call-1", name: "get_weather", result: "sunny", error: undefined },
      { id: "call-2", name: "get_weather", result: undefined, error: "API down" },
    ]);
  });

  test("times out calls the application never resolves", async () => {
    const conversation = makeConversation();
    const { manager } = makeManager(conversation, 5);

    const results = await manager.resolveCalls([
      { id: "call-1", name: "get_weather", arguments: "{}" },
    ]);
    expect(results[0]!.error).toMatch(/timed out/);
  });

  test("cancelAll force-resolves pending calls", async () => {
    const conversation = makeConversation();
    const { manager } = makeManager(conversation);

    const pending = manager.resolveCalls([
      { id: "call-1", name: "get_weather", arguments: "{}" },
    ]);
    manager.cancelAll("interrupted");
    const results = await pending;
    expect(results[0]).toEqual({
      id: "call-1",
      name: "get_weather",
      result: undefined,
      error: "interrupted",
    });
  });

  test("a stale result is dropped without error", () => {
    const conversation = makeConversation();
    const { manager } = makeManager(conversation);
    expect(() => manager.handleResult({ id: "ghost", result: 1 })).not.toThrow();
  });
});
