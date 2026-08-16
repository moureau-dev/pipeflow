import { describe, expect, test } from "bun:test";
import { Agent } from "./agent.ts";
import { Tool } from "./tools/tools.ts";
import type { LLM, LLMEvent, LLMRequest } from "../providers/llm/types.ts";

class FakeLLM implements LLM {
  readonly requests: LLMRequest[] = [];

  constructor(
    private readonly eventsFor: (request: LLMRequest) => LLMEvent[],
  ) {}

  async *stream(request: LLMRequest): AsyncGenerator<LLMEvent> {
    this.requests.push(request);
    for (const event of this.eventsFor(request)) {
      yield event;
    }
  }

  stop(): void {}
}

function done(): LLMEvent[] {
  return [{ type: "done" }];
}

const getWeather = new Tool<{ city: string }, string>({
  name: "get_weather",
  description: "Get the weather for a city.",
  execute: async ({ city }) => `sunny in ${city}`,
});

describe("Agent", () => {
  test("requires a non-empty name", () => {
    expect(() => new Agent({ name: "  " })).toThrow(/non-empty name/);
    expect(() => new Agent({ name: "" })).toThrow(/non-empty name/);
  });

  test("stores name, trimmed context, and tools", () => {
    const agent = new Agent({
      name: "Jarvis",
      context: "  You are helpful.  ",
      tools: [getWeather],
    });

    expect(agent.name).toBe("Jarvis");
    expect(agent.context).toBe("You are helpful.");
    expect(agent.tools).toEqual([getWeather]);
  });

  test("run without an LLM provider throws a helpful error", async () => {
    const agent = new Agent({ name: "Jarvis" });
    await expect(agent.run({ prompt: "hi" })).rejects.toThrow(
      /no LLM provider/,
    );
  });

  test("run collects streamed deltas into text", async () => {
    const llm = new FakeLLM(() => [
      { type: "delta", content: "Hello" },
      { type: "delta", content: " world" },
      ...done(),
    ]);
    const agent = new Agent({
      name: "Jarvis",
      context: "Be concise.",
      llm,
    });

    const result = await agent.run({ prompt: "Explain neural networks." });

    expect(result.text).toBe("Hello world");
    expect(result.toolCalls).toEqual([]);

    // The request carries system context, then the user prompt.
    const [request] = llm.requests;
    expect(request!.messages).toEqual([
      { role: "system", content: "Be concise." },
      { role: "user", content: "Explain neural networks." },
    ]);
    // result.messages is the same conversation, consumable as history.
    expect(result.messages).toEqual(request!.messages);
  });

  test("history is inserted between the system context and the prompt", async () => {
    const llm = new FakeLLM(() => done());
    const agent = new Agent({
      name: "Jarvis",
      context: "Be concise.",
      llm,
    });

    await agent.run({
      prompt: "continue",
      history: [
        { role: "assistant", content: "previous answer" },
        { role: "user", content: "previous question" },
      ],
    });

    expect(llm.requests[0]!.messages).toEqual([
      { role: "system", content: "Be concise." },
      { role: "assistant", content: "previous answer" },
      { role: "user", content: "previous question" },
      { role: "user", content: "continue" },
    ]);
  });

  test("passes temperature and maxTokens through to the LLM", async () => {
    const llm = new FakeLLM(() => done());
    const agent = new Agent({ name: "Jarvis", llm });

    await agent.run({ prompt: "hi", temperature: 0.2, maxTokens: 100 });

    expect(llm.requests[0]!.temperature).toBe(0.2);
    expect(llm.requests[0]!.maxTokens).toBe(100);
  });

  test("executes a requested tool and feeds the result back", async () => {
    const llm = new FakeLLM((request) => {
      const last = request.messages.at(-1);
      // Once the tool result is in the conversation, answer normally.
      if (last?.role === "tool") {
        return [
          { type: "delta", content: "It is " },
          { type: "delta", content: "sunny in Paris." },
          ...done(),
        ];
      }
      return [
        {
          type: "tool_call",
          id: "call_1",
          name: "get_weather",
          arguments: '{"city":"Paris"}',
        },
        ...done(),
      ];
    });

    const agent = new Agent({ name: "Jarvis", llm, tools: [getWeather] });
    const result = await agent.run({ prompt: "What is the weather in Paris?" });

    expect(result.text).toBe("It is sunny in Paris.");
    expect(result.toolCalls).toEqual([
      {
        id: "call_1",
        name: "get_weather",
        arguments: { city: "Paris" },
        result: "sunny in Paris",
      },
    ]);

    // Two LLM round trips happened.
    expect(llm.requests).toHaveLength(2);
    // The second request includes the assistant tool call + tool result.
    const second = llm.requests[1]!.messages;
    expect(second.at(-2)).toEqual({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_1", name: "get_weather", arguments: '{"city":"Paris"}' }],
    });
    expect(second.at(-1)).toEqual({
      role: "tool",
      toolCallId: "call_1",
      name: "get_weather",
      content: '"sunny in Paris"',
    });
  });

  test("an unknown tool yields an error result without crashing", async () => {
    const llm = new FakeLLM((request) => {
      if (request.messages.at(-1)?.role === "tool") {
        return [{ type: "delta", content: "ok" }, ...done()];
      }
      return [
        { type: "tool_call", id: "call_x", name: "does_not_exist", arguments: "{}" },
        ...done(),
      ];
    });

    const agent = new Agent({ name: "Jarvis", llm });
    const result = await agent.run({ prompt: "hi" });

    expect(result.text).toBe("ok");
    expect(result.toolCalls[0]?.result).toEqual({ error: 'Unknown tool "does_not_exist"' });
  });

  test("a throwing tool surfaces as an error result and the loop continues", async () => {
    const flaky = new Tool({
      name: "flaky",
      description: "Sometimes fails.",
      execute: () => {
        throw new Error("downstream exploded");
      },
    });
    const llm = new FakeLLM((request) => {
      if (request.messages.at(-1)?.role === "tool") {
        return [{ type: "delta", content: "handled" }, ...done()];
      }
      return [{ type: "tool_call", id: "call_1", name: "flaky", arguments: "{}" }, ...done()];
    });

    const agent = new Agent({ name: "Jarvis", llm, tools: [flaky] });
    const result = await agent.run({ prompt: "hi" });

    expect(result.text).toBe("handled");
    expect(result.toolCalls[0]?.result).toEqual({ error: "downstream exploded" });
    // The error was still delivered to the model as a tool result.
    expect(llm.requests[1]!.messages.at(-1)?.content).toBe('{"error":"downstream exploded"}');
  });

  test("malformed tool arguments are passed through as the raw string", async () => {
    const llm = new FakeLLM((request) => {
      if (request.messages.at(-1)?.role === "tool") {
        return [{ type: "delta", content: "ok" }, ...done()];
      }
      return [
        { type: "tool_call", id: "call_1", name: "get_weather", arguments: "{not json" },
        ...done(),
      ];
    });

    const agent = new Agent({ name: "Jarvis", llm, tools: [getWeather] });
    const result = await agent.run({ prompt: "hi" });

    expect(result.toolCalls[0]?.arguments).toBe("{not json");
  });

  test("aborts when the model keeps requesting tools", async () => {
    const llm = new FakeLLM(() => [
      { type: "tool_call", id: "call_1", name: "get_weather", arguments: "{}" },
      ...done(),
    ]);

    const agent = new Agent({
      name: "Jarvis",
      llm,
      tools: [getWeather],
    });

    await expect(
      agent.run({ prompt: "hi", maxToolIterations: 2 }),
    ).rejects.toThrow(/exceeded 2 tool iterations/);
    // The loop ran exactly 2 times before giving up.
    expect(llm.requests).toHaveLength(2);
  });

  test("propagates LLM errors", async () => {
    const llm = new FakeLLM(() => [{ type: "error", error: new Error("provider down") }]);
    const agent = new Agent({ name: "Jarvis", llm });
    await expect(agent.run({ prompt: "hi" })).rejects.toThrow("provider down");
  });

  test("addTool rejects duplicates", () => {
    const agent = new Agent({ name: "Jarvis" });
    agent.addTool(getWeather);
    expect(agent.hasTool("get_weather")).toBe(true);
    expect(agent.getTool("get_weather")).toBe(getWeather);
    expect(() => agent.addTool(getWeather)).toThrow(/already has a tool/);

    const sameName = new Tool({
      name: "get_weather",
      description: "A different tool with the same name.",
      execute: () => "rainy",
    });
    expect(() => agent.addTool(sameName)).toThrow(/already has a tool/);
  });

  test("run results can be chained as history", async () => {
    const llm = new FakeLLM(() => [
      { type: "delta", content: "first answer" },
      ...done(),
    ]);
    const agent = new Agent({ name: "Jarvis", llm });

    const first = await agent.run({ prompt: "q1" });
    const second = await agent.run({ prompt: "q2", history: first.messages });

    expect(second.text).toBe("first answer");
    // The second conversation continues from the first.
    expect(llm.requests[1]!.messages).toEqual([
      ...first.messages,
      { role: "user", content: "q2" },
    ]);
  });
});
