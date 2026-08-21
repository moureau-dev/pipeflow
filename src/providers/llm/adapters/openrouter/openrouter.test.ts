import { describe, expect, test } from "bun:test";
import { OpenRouterLLM } from "./openrouter";
import type { LLMRequest, LLMToolDefinition } from "../../types";

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

const weatherTool: LLMToolDefinition = {
  name: "get_weather",
  description: "Get the current weather for a city.",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
};

describe("OpenRouterLLM", () => {
  test("requires an api key", () => {
    expect(() => new OpenRouterLLM({ apiKey: "" })).toThrow(/apiKey/);
  });

  test("streams deltas from SSE frames in order", async () => {
    const llm = new OpenRouterLLM({
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

  test("surfaces reasoning deltas before content on thinking models", async () => {
    const llm = new OpenRouterLLM({
      apiKey: "test-key",
      fetch: async () =>
        sseResponse(
          sseFrame(
            JSON.stringify({ choices: [{ delta: { reasoning: "think. " }, finish_reason: null }] }),
          ),
          sseFrame(deltaChunk("answer")),
          sseFrame(deltaChunk(""), "stop"),
        ),
    });

    const events = [];
    for await (const event of llm.stream(basicRequest)) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "delta", content: "", reasoning: "think. " },
      { type: "delta", content: "answer" },
      { type: "done" },
    ]);
  });

  test("surfaces an empty 200 with finish_reason error/content_filter as an error event", async () => {
    // Providers such as gemini on OpenRouter occasionally return HTTP 200
    // with no output and finish_reason "error" — a silent empty completion
    // used to be emitted instead of surfacing the failure.
    for (const finishReason of ["error", "content_filter"]) {
      const llm = new OpenRouterLLM({
        apiKey: "test-key",
        fetch: async () =>
          sseResponse(
            sseFrame(
              JSON.stringify({
                choices: [{ delta: { content: "" }, finish_reason: finishReason }],
              }),
            ),
          ),
      });

      const events = [];
      for await (const event of llm.stream(basicRequest)) {
        events.push(event);
      }

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ type: "error" });
      expect(events[1]).toEqual({ type: "done" });
      expect((events[0] as { error: Error }).error.message).toMatch(
        new RegExp(`finished with "${finishReason}" and produced no output`),
      );
    }
  });

  test("sends the request with auth, default model, and stream flags", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const llm = new OpenRouterLLM({
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

    expect(capturedUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer secret");
    const body = JSON.parse(String(capturedInit?.body));
    expect(body.model).toBe("openrouter/auto");
    expect(body.stream).toBe(true);
    expect(body.temperature).toBe(0.5);
    expect(body.max_tokens).toBe(42);
    expect(body.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  test("envelope mode sends response_format instead of tools and emits tool_call events", async () => {
    let capturedInit: RequestInit | undefined;
    const llm = new OpenRouterLLM({
      apiKey: "test-key",
      fetch: async (_url, init) => {
        capturedInit = init;
        return sseResponse(
          sseFrame(
            JSON.stringify({
              choices: [
                {
                  delta: { content: '{"calls":[{"name":"get_weather","arguments":{"city":"Paris"}}]}' },
                  finish_reason: null,
                },
              ],
            }),
          ),
          sseFrame(deltaChunk(""), "stop"),
        );
      },
    });

    const events = [];
    for await (const event of llm.stream({
      messages: [{ role: "user", content: "weather in Paris?" }],
      tools: [weatherTool],
      toolMode: "envelope",
    })) {
      events.push(event);
    }

    const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
    expect(body.tools).toBeUndefined();
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "tool_envelope", strict: false, schema: expect.any(Object) },
    });
    expect(events).toEqual([
      {
        type: "tool_call",
        id: expect.any(String),
        name: "get_weather",
        arguments: '{"city":"Paris"}',
      },
      { type: "done" },
    ]);
  });

  test("envelope mode surfaces a direct answer as a delta", async () => {
    const llm = new OpenRouterLLM({
      apiKey: "test-key",
      fetch: async () =>
        sseResponse(
          sseFrame(
            JSON.stringify({
              choices: [{ delta: { content: '{"answer":"Sunny and warm."}' }, finish_reason: null }],
            }),
          ),
          sseFrame(deltaChunk(""), "stop"),
        ),
    });

    const events = [];
    for await (const event of llm.stream({
      messages: [{ role: "user", content: "hi" }],
      tools: [weatherTool],
      toolMode: "envelope",
    })) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: "delta", content: "Sunny and warm." },
      { type: "done" },
    ]);
  });

  test("prompted mode appends the envelope instruction and parses the reply", async () => {
    let capturedInit: RequestInit | undefined;
    const llm = new OpenRouterLLM({
      apiKey: "test-key",
      fetch: async (_url, init) => {
        capturedInit = init;
        return sseResponse(
          sseFrame(
            JSON.stringify({
              choices: [
                {
                  delta: { content: '{"calls":[{"name":"get_weather","arguments":{"city":"Rome"}}]}' },
                  finish_reason: null,
                },
              ],
            }),
          ),
          sseFrame(deltaChunk(""), "stop"),
        );
      },
    });

    const events = [];
    for await (const event of llm.stream({
      messages: [{ role: "user", content: "weather in Rome?" }],
      tools: [weatherTool],
      toolMode: "prompted",
    })) {
      events.push(event);
    }

    const body = JSON.parse(String(capturedInit?.body)) as {
      messages: Array<{ content: string }>;
      tools?: unknown;
      response_format?: unknown;
    };
    expect(body.tools).toBeUndefined();
    expect(body.response_format).toBeUndefined();
    const last = body.messages.at(-1)!.content;
    expect(last).toContain("Respond with ONLY valid JSON");
    expect(last).toContain("get_weather");
    expect(events).toEqual([
      {
        type: "tool_call",
        id: expect.any(String),
        name: "get_weather",
        arguments: '{"city":"Rome"}',
      },
      { type: "done" },
    ]);
  });

  test("envelope mode reports a non-JSON reply as an error event", async () => {
    const llm = new OpenRouterLLM({
      apiKey: "test-key",
      fetch: async () =>
        sseResponse(
          sseFrame(
            JSON.stringify({
              choices: [{ delta: { content: "I cannot do that" }, finish_reason: null }],
            }),
          ),
          sseFrame(deltaChunk(""), "stop"),
        ),
    });

    const events = [];
    for await (const event of llm.stream({
      messages: [{ role: "user", content: "hi" }],
      tools: [weatherTool],
      toolMode: "envelope",
    })) {
      events.push(event);
    }
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "error" });
    expect(events[1]).toEqual({ type: "done" });
  });

  test("sends attribution headers and a custom model when configured", async () => {
    let capturedInit: RequestInit | undefined;
    const llm = new OpenRouterLLM({
      apiKey: "secret",
      model: "anthropic/claude-sonnet-4",
      appUrl: "https://example.com",
      fetch: async (_url, init) => {
        capturedInit = init;
        return sseResponse(sseFrame(deltaChunk("ok"), "stop"));
      },
    });

    for await (const _ of llm.stream(basicRequest)) {
      // consume
    }

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["http-referer"]).toBe("https://example.com");
    // X-Title is always `pipeflow`, regardless of configuration.
    expect(headers["x-title"]).toBe("pipeflow");
    const body = JSON.parse(String(capturedInit?.body));
    expect(body.model).toBe("anthropic/claude-sonnet-4");
  });

  test("defaults attribution headers when not configured", async () => {
    let capturedInit: RequestInit | undefined;
    const llm = new OpenRouterLLM({
      apiKey: "secret",
      fetch: async (_url, init) => {
        capturedInit = init;
        return sseResponse(sseFrame(deltaChunk("ok"), "stop"));
      },
    });

    for await (const _ of llm.stream(basicRequest)) {
      // consume
    }

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["http-referer"]).toBe("https://moureau.dev");
    expect(headers["x-title"]).toBe("pipeflow");
  });

  test("sends tool definitions in the OpenAI function format", async () => {
    let capturedInit: RequestInit | undefined;
    const llm = new OpenRouterLLM({
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

    const llm = new OpenRouterLLM({
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
    const llm = new OpenRouterLLM({
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

  test("ignores comment lines OpenRouter emits between data frames", async () => {
    const llm = new OpenRouterLLM({
      apiKey: "test-key",
      fetch: async () =>
        sseResponse(
          ": OPENROUTER PROCESSING\n\n",
          sseFrame(deltaChunk("comment-free")),
          sseFrame(deltaChunk(""), "stop"),
        ),
    });

    const events = [];
    for await (const event of llm.stream(basicRequest)) {
      events.push(event);
    }
    expect(events).toEqual([{ type: "delta", content: "comment-free" }, { type: "done" }]);
  });

  test("stops after [DONE] even without a finish reason", async () => {
    const llm = new OpenRouterLLM({
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
    const llm = new OpenRouterLLM({
      apiKey: "test-key",
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: "Insufficient credits" } }), {
          status: 402,
          headers: { "content-type": "application/json" },
        }),
    });

    await expect(async () => {
      for await (const _ of llm.stream(basicRequest)) {
        // consume
      }
    }).toThrow(/OpenRouter request failed \(402\).*Insufficient credits/);
  });

  test("stop aborts an in-flight stream", async () => {
    const encoder = new TextEncoder();
    // The body never closes: the stream hangs after the first frame.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sseFrame(deltaChunk("first"))));
      },
    });

    const llm = new OpenRouterLLM({
      apiKey: "test-key",
      fetch: async () => new Response(stream, { status: 200 }),
    });

    const generator = llm.stream(basicRequest);
    const first = await generator.next();
    expect(first.value).toEqual({ type: "delta", content: "first" });

    llm.stop();
    await expect(generator.next()).rejects.toThrow("aborted");
  });

  test("emits tool calls once even when the provider repeats the finish_reason chunk", async () => {
    // gemini via OpenRouter sometimes sends finish_reason "tool_calls" on
    // several chunks; the tool call must not be re-emitted (the app would
    // otherwise double-resolve it).
    const toolFrame = JSON.stringify({
      choices: [
        {
          delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "get_weather", arguments: "{}" } }] },
          finish_reason: "tool_calls",
        },
      ],
    });
    const llm = new OpenRouterLLM({
      apiKey: "test-key",
      fetch: async () =>
        sseResponse(
          sseFrame(toolFrame),
          sseFrame(toolFrame), // duplicate finish chunk
          sseFrame(toolFrame), // and again
          "data: [DONE]\n\n",
        ),
    });

    const events = [];
    for await (const event of llm.stream(basicRequest)) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: "tool_call", id: "call_1", name: "get_weather", arguments: "{}" },
      { type: "done" },
    ]);
  });

  test("reports provider usage when the final chunk carries it", async () => {
    const usageFrame = JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 860, completion_tokens: 114 },
    });
    const usages: Array<{ promptTokens: number; completionTokens: number }> = [];
    const withCapture = new OpenRouterLLM({
      apiKey: "test-key",
      onUsage: (usage) => usages.push(usage),
      fetch: async () =>
        sseResponse(
          sseFrame(deltaChunk("ok")),
          sseFrame(deltaChunk(""), "stop"),
          sseFrame(usageFrame),
          "data: [DONE]\n\n",
        ),
    });

    const events = [];
    for await (const event of withCapture.stream(basicRequest)) {
      events.push(event);
    }
    expect(events).toEqual([{ type: "delta", content: "ok" }, { type: "done" }]);
    expect(usages).toEqual([{ promptTokens: 860, completionTokens: 114 }]);
  });

  test("aborts a stream that goes silent for idleTimeoutMs", async () => {
    const encoder = new TextEncoder();
    // Deliver one frame, then go silent forever — exactly the "output
    // delivered, stream never terminates" failure the watchdog guards.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sseFrame(deltaChunk("first"))));
      },
    });

    const llm = new OpenRouterLLM({
      apiKey: "test-key",
      idleTimeoutMs: 50,
      fetch: async () => new Response(stream, { status: 200 }),
    });

    const generator = llm.stream(basicRequest);
    const first = await generator.next();
    expect(first.value).toEqual({ type: "delta", content: "first" });

    await expect(generator.next()).rejects.toThrow(/idle for 50ms/);
  });

  test("stop is a no-op when nothing is streaming", () => {
    const llm = new OpenRouterLLM({ apiKey: "test-key" });
    expect(() => llm.stop()).not.toThrow();
  });

  test("normalizes a trailing baseUrl slash", async () => {
    let capturedUrl = "";
    const llm = new OpenRouterLLM({
      apiKey: "test-key",
      baseUrl: "https://openrouter.ai/api/v1/",
      fetch: async (url) => {
        capturedUrl = String(url);
        return sseResponse(sseFrame(deltaChunk("ok"), "stop"));
      },
    });

    for await (const _ of llm.stream(basicRequest)) {
      // consume
    }
    expect(capturedUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
  });
});
