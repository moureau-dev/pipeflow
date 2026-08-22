import { describe, expect, test } from "bun:test";
import { Conversation } from "../../../conversation/conversation";
import { MemoryPersistence } from "../../../../persistence/adapters/memory/memory";
import { Tool } from "../../../../agents/tools/tools";
import { ToolCallManager } from "./tools";
import type { ToolCall } from "../../../types";

function makeConversation(): Conversation {
  return new Conversation({ id: "conv-1", persistence: new MemoryPersistence() });
}

function makeManager(
  conversation: Conversation,
  timeoutMs = 10_000,
  options?: { autoExecute?: boolean; tools?: Tool<never, unknown>[] },
): {
  manager: ToolCallManager;
  conversation: Conversation;
} {
  const tools = new Map((options?.tools ?? []).map((tool) => [tool.name, tool]));
  const manager = new ToolCallManager(conversation, timeoutMs, {
    tools,
    autoExecute: options?.autoExecute ?? true,
  });
  conversation.on("tool-call-result", ({ result }) => manager.handleResult(result));
  return { manager, conversation };
}

const weather = new Tool<{ city: string }, string>({
  name: "get_weather",
  description: "Get the weather for a city.",
  execute: async ({ city }) => `sunny in ${city}`,
});

describe("ToolCallManager", () => {
  test("auto-executes registered tools and feeds the results back", async () => {
    const conversation = makeConversation();
    const { manager } = makeManager(conversation, 10_000, {
      tools: [weather],
    });
    const emitted: ToolCall[] = [];
    conversation.on("tool-call", ({ call }) => emitted.push(call));

    const results = await manager.resolveCalls([
      { id: "call-1", name: "get_weather", arguments: '{"city":"paris"}' },
    ]);

    // The call was still emitted for app visibility, with parsed arguments.
    expect(emitted).toEqual([
      { id: "call-1", name: "get_weather", arguments: { city: "paris" } },
    ]);
    // The framework executed the tool and fed its result back in order.
    expect(results).toEqual([
      { id: "call-1", name: "get_weather", result: "sunny in paris", error: undefined },
    ]);
    // The resolution also flowed through the conversation's event surface.
    expect(conversation.pendingToolCalls).toEqual([]);
  });

  test("surfaces a tool error as an error result instead of crashing", async () => {
    const conversation = makeConversation();
    const boom = new Tool({
      name: "boom",
      description: "Fails.",
      execute: () => {
        throw new Error("provider down");
      },
    });
    const { manager } = makeManager(conversation, 10_000, { tools: [boom] });

    const results = await manager.resolveCalls([
      { id: "call-1", name: "boom", arguments: "{}" },
    ]);
    expect(results[0]).toEqual({
      id: "call-1",
      name: "boom",
      result: undefined,
      error: "provider down",
    });
  });

  test("reports unknown tools as errors the model can recover from", async () => {
    const conversation = makeConversation();
    const { manager } = makeManager(conversation, 10_000);

    const results = await manager.resolveCalls([
      { id: "call-1", name: "ghost", arguments: "{}" },
    ]);
    expect(results[0]!.error).toBe('Unknown tool "ghost"');
  });

  test("does not run a tool the application already resolved in its handler", async () => {
    const conversation = makeConversation();
    let executions = 0;
    const counting = new Tool({
      name: "count",
      description: "Counts executions.",
      execute: () => {
        executions++;
        return "ran";
      },
    });
    const { manager } = makeManager(conversation, 10_000, { tools: [counting] });

    // The app resolves synchronously in the `tool-call` handler (the
    // app-managed path) — the framework must not run the tool twice.
    conversation.on("tool-call", ({ call }) =>
      conversation.resolveToolCall({ id: call.id, result: "from app" }),
    );

    const results = await manager.resolveCalls([
      { id: "call-1", name: "count", arguments: "{}" },
    ]);
    expect(results[0]).toEqual({
      id: "call-1",
      name: "count",
      result: "from app",
      error: undefined,
    });
    expect(executions).toBe(0);
  });

  test("resolves calls through the application when autoExecute is off", async () => {
    const conversation = makeConversation();
    const { manager } = makeManager(conversation, 10_000, {
      tools: [weather],
      autoExecute: false,
    });
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

  test("a hung auto-executed tool is bounded by the timeout", async () => {
    const conversation = makeConversation();
    const slow = new Tool({
      name: "slow",
      description: "Never resolves.",
      execute: () => new Promise(() => {}),
    });
    const { manager } = makeManager(conversation, 5, { tools: [slow] });

    const results = await manager.resolveCalls([
      { id: "call-1", name: "slow", arguments: "{}" },
    ]);
    expect(results[0]!.error).toMatch(/timed out/);
  });

  test("times out calls the application never resolves when autoExecute is off", async () => {
    const conversation = makeConversation();
    const { manager } = makeManager(conversation, 5, { autoExecute: false });

    const results = await manager.resolveCalls([
      { id: "call-1", name: "get_weather", arguments: "{}" },
    ]);
    expect(results[0]!.error).toMatch(/timed out/);
  });

  test("cancelAll force-resolves pending calls", async () => {
    const conversation = makeConversation();
    const { manager } = makeManager(conversation, 10_000, { autoExecute: false });

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
