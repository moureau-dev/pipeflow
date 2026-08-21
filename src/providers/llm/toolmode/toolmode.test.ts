import { describe, expect, test } from "bun:test";
import { ToolModeBenchmark } from "./toolmode";
import type { FetchLike } from "../../shared";

// The benchmark runs through the real adapter; the fetch is mocked so the
// suite needs no network. The mock serves the pricing registry plus SSE
// streams shaped per tool mode (detected from the request body).

const MODEL = "test/model";
const PRICING = { prompt: "0.000001", completion: "0.000003" };

const ENVELOPE_JSON = '{"calls":[{"name":"get_weather","arguments":{"city":"Paris"}}]}';
const USAGE_FRAME = JSON.stringify({
  choices: [],
  usage: { prompt_tokens: 860, completion_tokens: 114 },
});

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

/** Native tool-call stream: one tool_call delta, usage, then [DONE]. */
function nativeSse(): Response {
  return sseResponse(
    sseFrame(
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    ),
    sseFrame(USAGE_FRAME),
    "data: [DONE]\n\n",
  );
}

/** Envelope/prompted stream: content, stop, usage, then [DONE]. */
function contentSse(content: string): Response {
  return sseResponse(
    sseFrame(
      JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] }),
    ),
    sseFrame(
      JSON.stringify({ choices: [{ delta: { content: "" }, finish_reason: "stop" }] }),
    ),
    sseFrame(USAGE_FRAME),
    "data: [DONE]\n\n",
  );
}

function makeFetch(options: { envelopeContent?: string } = {}): {
  fetch: FetchLike;
  chatCalls: () => number;
} {
  let calls = 0;
  const fetchImpl: FetchLike = async (input, init) => {
    if (String(input).endsWith("/models")) {
      return new Response(
        JSON.stringify({ data: [{ id: MODEL, pricing: PRICING }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    calls++;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (body.response_format !== undefined) {
      return contentSse(options.envelopeContent ?? ENVELOPE_JSON);
    }
    if (body.tools !== undefined) {
      return nativeSse();
    }
    return contentSse(ENVELOPE_JSON); // prompted
  };
  return { fetch: fetchImpl, chatCalls: () => calls };
}

describe("ToolModeBenchmark", () => {
  test("benchmarks all three modes through the adapter with mocked SSE", async () => {
    const { fetch, chatCalls } = makeFetch();
    const bench = new ToolModeBenchmark({
      apiKey: "test-key",
      model: MODEL,
      runs: 2,
      fetch,
    });

    const result = await bench.run();

    expect(chatCalls()).toBe(6); // 3 modes × 2 runs
    expect(result.pricing).toEqual({ in: 0.000001, out: 0.000003 });
    for (const mode of ["native", "envelope", "prompted"] as const) {
      const entry = result.report[mode]!;
      expect(entry.toolCalls).toBe(2);
      expect(entry.errors).toBe(0);
      expect(entry.time).toBeDefined();
      expect(entry.time!.p50).toBeGreaterThanOrEqual(0);
      expect(entry.cost).toBeCloseTo(860 * 0.000001 + 114 * 0.000003, 10);
    }
    expect(result.fastest).not.toBeNull();
    expect(result.cheapest).not.toBeNull();
    expect(["native", "envelope", "prompted"]).toContain(result.fastest!);
  });

  test("a mode whose model returns prose reports an error and no timing", async () => {
    const { fetch } = makeFetch({
      envelopeContent: "To provide you with the current weather information...",
    });
    const bench = new ToolModeBenchmark({
      apiKey: "test-key",
      model: MODEL,
      runs: 2,
      fetch,
    });

    const result = await bench.run();

    const envelope = result.report.envelope!;
    expect(envelope.toolCalls).toBe(0);
    expect(envelope.time).toBeUndefined();
    expect(envelope.errors).toBe(2);
    expect(envelope.error).toContain("did not return a JSON envelope");
    // Broken modes are excluded from the recommendation.
    expect(result.fastest).not.toBe("envelope");
    expect(result.cheapest).not.toBe("envelope");
  });
});
