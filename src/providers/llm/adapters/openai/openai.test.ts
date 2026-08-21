import { describe, expect, test } from "bun:test";
import { OpenAILLM } from "./openai";
import type { LLMRequest } from "../../types";

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

describe("OpenAILLM", () => {
  test("requires an api key", () => {
    expect(() => new OpenAILLM({ apiKey: "" })).toThrow(/apiKey/);
  });

  test("streams deltas from SSE frames in order", async () => {
    const llm = new OpenAILLM({
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

  test("sends auth and the default model", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const llm = new OpenAILLM({
      apiKey: "secret",
      fetch: async (url, init) => {
        capturedUrl = String(url);
        capturedInit = init;
        return sseResponse(sseFrame(deltaChunk("ok"), "stop"));
      },
    });

    for await (const _ of llm.stream(basicRequest)) {
      // consume
    }

    expect(capturedUrl).toBe("https://api.openai.com/v1/chat/completions");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer secret");
    const body = JSON.parse(String(capturedInit?.body));
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.stream).toBe(true);
  });

  test("reassembles fragmented tool calls into single events", async () => {
    const toolFrame = (index: number, id?: string, name?: string, args?: string): string =>
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index,
                  ...(id ? { id } : {}),
                  function: { ...(name ? { name } : {}), ...(args ? { arguments: args } : {}) },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });

    const llm = new OpenAILLM({
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
    for await (const event of llm.stream({
      messages: [{ role: "user", content: "weather?" }],
      tools: [
        {
          name: "get_weather",
          description: "Weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      ],
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "tool_call", id: "call_1", name: "get_weather", arguments: '{"city":"paris"}' },
      { type: "done" },
    ]);
  });
});
