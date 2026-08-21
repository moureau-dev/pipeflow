import { describe, expect, test } from "bun:test";
import { GenerationRunner } from "./generation";
import type { LLM, LLMEvent, LLMMessage } from "../../../../providers/llm/types";
import type { ResolvedToolCall } from "../tools/tools";

type Script = () => AsyncGenerator<LLMEvent, void, unknown>;

class FakeLLM implements LLM {
  constructor(private readonly script: Script) {}
  async *stream(): AsyncGenerator<LLMEvent> {
    yield* this.script();
  }
  stop(): void {}
}

const runner = new GenerationRunner();

interface RequestOverrides {
  llm?: LLM;
  messages?: LLMMessage[];
  maxToolIterations?: number;
  isCurrent?: () => boolean;
  onDelta?: (delta: string, textBefore: string) => void;
  resolveToolCalls?: (
    calls: { id: string; name: string; arguments: string }[],
  ) => Promise<ResolvedToolCall[]>;
}

function makeRequest(overrides: RequestOverrides = {}) {
  return {
    agentName: "Jarvis",
    llm: overrides.llm ?? new FakeLLM(async function* () {}),
    messages: overrides.messages ?? [],
    tools: [],
    maxToolIterations: overrides.maxToolIterations ?? 3,
    isCurrent: overrides.isCurrent ?? (() => true),
    onDelta: overrides.onDelta,
    resolveToolCalls:
      overrides.resolveToolCalls ??
      (async (calls) =>
        calls.map((call) => ({ id: call.id, name: call.name, result: "ok" }))),
  };
}

describe("GenerationRunner", () => {
  test("accumulates deltas and reports done", async () => {
    const deltas: Array<[string, string]> = [];
    const llm = new FakeLLM(async function* () {
      yield { type: "delta", content: "Hello " };
      yield { type: "delta", content: "world!" };
      yield { type: "done" };
    });
    const outcome = await runner.run(
      makeRequest({ llm, onDelta: (delta, before) => deltas.push([delta, before]) }),
    );
    expect(outcome).toEqual({ text: "Hello world!", status: "done" });
    // onDelta receives the delta and the running text before it.
    expect(deltas).toEqual([
      ["Hello ", ""],
      ["world!", "Hello "],
    ]);
  });

  test("resolves tool calls and continues the loop", async () => {
    const calls: Array<{ id: string; name: string; arguments: string }[]> = [];
    const messages: LLMMessage[] = [];
    const llm = new FakeLLM(async function* () {
      yield {
        type: "tool_call",
        id: "t1",
        name: "get_weather",
        arguments: '{"city":"paris"}',
      };
      yield { type: "done" };
    });
    const outcome = await runner.run(
      makeRequest({
        llm,
        messages,
        maxToolIterations: 1,
        resolveToolCalls: async (c) => {
          calls.push(c);
          return c.map((call) => ({ id: call.id, name: call.name, result: "sunny" }));
        },
      }),
    );
    expect(outcome.status).toBe("done");
    expect(calls).toHaveLength(1);
    // The assistant tool-call message and the tool result are appended.
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      name: "Jarvis",
      toolCalls: calls[0],
    });
    expect(messages[1]).toEqual({
      role: "tool",
      toolCallId: "t1",
      name: "get_weather",
      content: JSON.stringify("sunny"),
    });
  });

  test("interruption aborts the run without resolving tools", async () => {
    // The guard passes for the loop head and the first delta, then fails on
    // the tool-call event — the stream is stale mid-generation.
    let checks = 0;
    let resolved = 0;
    const llm = new FakeLLM(async function* () {
      yield { type: "delta", content: "partial" };
      yield { type: "tool_call", id: "t1", name: "get_weather", arguments: "{}" };
      yield { type: "done" };
    });
    const outcome = await runner.run(
      makeRequest({
        llm,
        isCurrent: () => checks++ < 2,
        resolveToolCalls: async () => {
          resolved++;
          return [];
        },
      }),
    );
    expect(outcome).toEqual({ text: "partial", status: "interrupted" });
    expect(resolved).toBe(0);
  });

  test("a provider error returns the partial text with error status", async () => {
    const llm = new FakeLLM(async function* () {
      yield { type: "delta", content: "Hello" };
      throw new Error("boom");
    });
    const outcome = await runner.run(makeRequest({ llm }));
    expect(outcome.status).toBe("error");
    expect(outcome.text).toBe("Hello");
    expect((outcome.error as Error).message).toBe("boom");
  });

  test("is bounded by maxToolIterations", async () => {
    // Each stream() round-trip yields a tool call; the loop must stop after
    // maxToolIterations resolutions even though the model keeps calling tools.
    const llm = new FakeLLM(async function* () {
      yield { type: "tool_call", id: "t1", name: "tool", arguments: "{}" };
    });
    let resolutions = 0;
    const outcome = await runner.run(
      makeRequest({
        llm,
        maxToolIterations: 2,
        resolveToolCalls: async (c) => {
          resolutions++;
          return c.map((call) => ({ id: call.id, name: call.name, result: "ok" }));
        },
      }),
    );
    expect(outcome.status).toBe("done");
    expect(resolutions).toBe(2);
  });
});
