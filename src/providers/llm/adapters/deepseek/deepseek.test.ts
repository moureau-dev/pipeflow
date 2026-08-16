import { describe, expect, test } from "bun:test";
import { DeepSeekLLM } from "./deepseek.ts";
import type { LLMRequest } from "../../types.ts";

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

function sseFrame(...lines: string[]): string {
  return lines.map((line) => `data: ${line}`).join("\n") + "\n\n";
}

function deltaChunk(content: string, finishReason?: string | null): string {
  return JSON.stringify({
    choices: [{ delta: { content }, finish_reason: finishReason ?? null }],
  });
}

const basicRequest: LLMRequest = { messages: [{ role: "user", content: "hi" }] };

describe("DeepSeekLLM", () => {
  test("requires an api key", () => {
    expect(() => new DeepSeekLLM({ apiKey: "" })).toThrow(/apiKey/);
  });

  test("streams deltas from SSE frames in order", async () => {
    const llm = new DeepSeekLLM({
      apiKey: "test-key",
      fetch: async () =>
        sseResponse(
          sseFrame(deltaChunk("Hello")),
          sseFrame(deltaChunk(" world")),
          sseFrame(deltaChunk(""), "stop"),
        ),
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
  });

  test("sends the request with auth and stream flags", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const llm = new DeepSeekLLM({
      apiKey: "secret",
      fetch: async (url, init) => {
        capturedUrl = String(url);
        capturedInit = init;
        return sseResponse(sseFrame(deltaChunk("ok"), "stop"));
      },
    });

    for await (const _ of llm.stream({
      messages: [{ role: "user", content: "hello" }],
      temperature: 0.5,
      maxTokens: 42,
    })) {
      // consume
    }

    expect(capturedUrl).toBe("https://api.deepseek.com/chat/completions");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer secret");
    const body = JSON.parse(String(capturedInit?.body));
    expect(body.model).toBe("deepseek-chat");
    expect(body.stream).toBe(true);
    expect(body.temperature).toBe(0.5);
    expect(body.max_tokens).toBe(42);
    expect(body.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  test("sends tool definitions in the OpenAI function format", async () => {
    let capturedInit: RequestInit | undefined;
    const llm = new DeepSeekLLM({
      apiKey: "secret",
      fetch: async (_url, init) => {
        capturedInit = init;
        return sseResponse(sseFrame(deltaChunk(""), "stop"));
      },
    });

    for await (const _ of llm.stream({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "get_weather", description: "Weather", parameters: {} }],
    })) {
      // consume
    }

    const body = JSON.parse(String(capturedInit?.body));
    expect(body.tools).toEqual([
      { type: "function", function: { name: "get_weather", description: "Weather", parameters: {} } },
    ]);
  });

  test("reassembles fragmented tool calls into single events", async () => {
    const toolFrame = (index: number, id?: string, name?: string, args?: string) =>
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index,
                  ...(id ? { id } : {}),
                  function: { name, arguments: args },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });

    const llm = new DeepSeekLLM({
      apiKey: "test-key",
      fetch: async () =>
        sseResponse(
          sseFrame(toolFrame(0, "call_1", "get_weather", "")),
          sseFrame(toolFrame(0, undefined, undefined, '{"city":')),
          sseFrame(toolFrame(0, undefined, undefined, '"paris"}')),
          sseFrame(JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })),
        ),
    });

    const events = [];
    for await (const event of llm.stream(basicRequest)) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: "tool_call",
        id: "call_1",
        name: "get_weather",
        arguments: '{"city":"paris"}',
      },
      { type: "done" },
    ]);
  });

  test("supports multiple tool calls in one response", async () => {
    const llm = new DeepSeekLLM({
      apiKey: "test-key",
      fetch: async () =>
        sseResponse(
          sseFrame(
            JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      { index: 0, id: "call_a", function: { name: "tool_a", arguments: "{}" } },
                      { index: 1, id: "call_b", function: { name: "tool_b", arguments: "{}" } },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            }),
          ),
        ),
    });

    const events = [];
    for await (const event of llm.stream(basicRequest)) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "tool_call", id: "call_a", name: "tool_a", arguments: "{}" },
      { type: "tool_call", id: "call_b", name: "tool_b", arguments: "{}" },
      { type: "done" },
    ]);
  });

  test("handles CRLF framing", async () => {
    const llm = new DeepSeekLLM({
      apiKey: "test-key",
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${deltaChunk("crlf ok")}\r\n\r\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\r\n\r\n`,
                ),
              );
              controller.close();
            },
          }),
          { status: 200 },
        ),
    });

    const events = [];
    for await (const event of llm.stream(basicRequest)) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: "delta", content: "crlf ok" },
      { type: "done" },
    ]);
  });

  test("ignores frames split across network chunks", async () => {
    const encoder = new TextEncoder();
    const payload = sseFrame(deltaChunk("split"), deltaChunk(""), "stop");
    // Deliver one byte per enqueue to force many partial frames.
    const bytes = encoder.encode(payload);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) {
          controller.enqueue(new Uint8Array([byte]));
        }
        controller.close();
      },
    });

    const llm = new DeepSeekLLM({
      apiKey: "test-key",
      fetch: async () => new Response(stream, { status: 200 }),
    });

    const events = [];
    for await (const event of llm.stream(basicRequest)) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: "delta", content: "split" },
      { type: "done" },
    ]);
  });

  test("stops after [DONE] even without a finish reason", async () => {
    const llm = new DeepSeekLLM({
      apiKey: "test-key",
      fetch: async () =>
        sseResponse(
          sseFrame(deltaChunk("before done")),
          "data: [DONE]\n\n",
          sseFrame(deltaChunk("should never arrive")),
        ),
    });

    const events = [];
    for await (const event of llm.stream(basicRequest)) {
      events.push(event);
    }
    expect(events).toEqual([{ type: "delta", content: "before done" }, { type: "done" }]);
  });

  test("throws on non-ok responses with the status and body", async () => {
    const llm = new DeepSeekLLM({
      apiKey: "test-key",
      fetch: async () =>
        new Response(JSON.stringify({ error: "invalid api key" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    });

    await expect(async () => {
      for await (const _ of llm.stream(basicRequest)) {
        // consume
      }
    }).toThrow(/DeepSeek request failed \(401\)/);
  });

  test("stop aborts an in-flight stream", async () => {
    const encoder = new TextEncoder();
    // The body never closes: the stream hangs after the first frame.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sseFrame(deltaChunk("first"))));
      },
    });

    const llm = new DeepSeekLLM({
      apiKey: "test-key",
      fetch: async () => new Response(stream, { status: 200 }),
    });

    const generator = llm.stream(basicRequest);
    const first = await generator.next();
    expect(first.value).toEqual({ type: "delta", content: "first" });

    llm.stop();
    await expect(generator.next()).rejects.toThrow("aborted");
  });

  test("stop is a no-op when nothing is streaming", () => {
    const llm = new DeepSeekLLM({ apiKey: "test-key" });
    expect(() => llm.stop()).not.toThrow();
  });

  test("a second stream cancels the first", async () => {
    const encoder = new TextEncoder();
    // Every fetch call gets a fresh never-ending stream.
    const hangingStream = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(sseFrame(deltaChunk("stale"))));
        },
      });

    const llm = new DeepSeekLLM({
      apiKey: "test-key",
      fetch: async () => new Response(hangingStream(), { status: 200 }),
    });

    const first = llm.stream(basicRequest);
    await first.next();

    // Starting a new stream aborts the previous one.
    const second = llm.stream(basicRequest);
    await second.next();
    await expect(first.next()).rejects.toThrow("aborted");
  });
});
