import { describe, expect, test } from "bun:test";
import { ClaudeLLM } from "./claude";
import type { LLMRequest, LLMUsage } from "../../types";

function sseResponse(...frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** Anthropic frames carry an `event:` type plus a `data:` JSON payload. */
function claudeFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const basicRequest: LLMRequest = { messages: [{ role: "user", content: "hi" }] };

function textStream(...texts: string[]): Response {
  const frames = [
    claudeFrame("message_start", {
      type: "message_start",
      message: { usage: { input_tokens: 12, output_tokens: 0 } },
    }),
    claudeFrame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    ...texts.map((text, i) =>
      claudeFrame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      }),
    ),
    claudeFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
    claudeFrame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 5 },
    }),
    claudeFrame("message_stop", { type: "message_stop" }),
  ];
  return sseResponse(...frames);
}

describe("ClaudeLLM", () => {
  test("requires an api key", () => {
    expect(() => new ClaudeLLM({ apiKey: "" })).toThrow(/apiKey/);
  });

  test("streams text deltas and reports usage", async () => {
    let usage: LLMUsage | undefined;
    const llm = new ClaudeLLM({
      apiKey: "test-key",
      onUsage: (u) => {
        usage = u;
      },
      fetch: async () => textStream("Hello", " world"),
    });

    const events = [];
    for await (const event of llm.stream(basicRequest)) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "delta", content: "Hello" },
      { type: "delta", content: " world" },
      { type: "done" },
    ]);
    expect(usage).toEqual({ promptTokens: 12, completionTokens: 5 });
  });

  test("sends auth, version header, max_tokens, and the wire mapping", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const llm = new ClaudeLLM({
      apiKey: "secret",
      fetch: async (url, init) => {
        capturedUrl = String(url);
        capturedInit = init;
        return textStream("ok");
      },
    });

    for await (const _ of llm.stream({
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "Let me check.",
          toolCalls: [
            { id: "call_1", name: "get_weather", arguments: '{"city":"Paris"}' },
          ],
        },
        { role: "tool", toolCallId: "call_1", name: "get_weather", content: "sunny" },
      ],
      tools: [
        {
          name: "get_weather",
          description: "Weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      ],
      maxTokens: 64,
    })) {
      // consume
    }

    expect(capturedUrl).toBe("https://api.anthropic.com/v1/messages");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("secret");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(String(capturedInit?.body)) as {
      model: string;
      max_tokens: number;
      system: string;
      messages: Array<{ role: string; content: unknown }>;
      tools: Array<{ name: string; input_schema: unknown }>;
    };
    expect(body.model).toBe("claude-sonnet-4-5");
    expect(body.max_tokens).toBe(64);
    expect(body.system).toBe("You are helpful.");
    expect(body.messages).toEqual([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Paris" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: "sunny" }],
      },
    ]);
    expect(body.tools[0]).toMatchObject({ name: "get_weather", input_schema: { type: "object" } });
  });

  test("reassembles tool_use input_json deltas into tool_call events", async () => {
    const llm = new ClaudeLLM({
      apiKey: "test-key",
      fetch: async () =>
        sseResponse(
          claudeFrame("message_start", {
            type: "message_start",
            message: { usage: { input_tokens: 20, output_tokens: 0 } },
          }),
          claudeFrame("content_block_start", {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} },
          }),
          claudeFrame("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '{"city":' },
          }),
          claudeFrame("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '"Paris"}' },
          }),
          claudeFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
          claudeFrame("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "tool_use" },
            usage: { output_tokens: 9 },
          }),
          claudeFrame("message_stop", { type: "message_stop" }),
        ),
    });

    const events = [];
    for await (const event of llm.stream(basicRequest)) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "tool_call", id: "toolu_1", name: "get_weather", arguments: '{"city":"Paris"}' },
      { type: "done" },
    ]);
  });

  test("surfaces a streamed error event", async () => {
    const llm = new ClaudeLLM({
      apiKey: "test-key",
      fetch: async () =>
        sseResponse(
          claudeFrame("error", {
            type: "error",
            error: { type: "overloaded_error", message: "Overloaded" },
          }),
        ),
    });

    const events = [];
    for await (const event of llm.stream(basicRequest)) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "error" });
    expect((events[0] as { error: Error }).error.message).toMatch(/Overloaded/);
    expect(events[1]).toEqual({ type: "done" });
  });

  test("throws on non-ok responses", async () => {
    const llm = new ClaudeLLM({
      apiKey: "test-key",
      fetch: async () => new Response("nope", { status: 401 }),
    });

    await expect(async () => {
      for await (const _ of llm.stream(basicRequest)) {
        // consume
      }
    }).toThrow(/Claude request failed \(401\)/);
  });
});
