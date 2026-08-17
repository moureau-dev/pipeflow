import { describe, expect, test } from "bun:test";
import type { LLM, LLMEvent, LLMRequest } from "../../providers/llm/types";
import { JsonToStreamObjectAdapter } from "./json-adapter/json-adapter";
import type { Schema } from "./reference/reference";

// Deterministic synthetic replays. No network, no LLM, no wall-clock timing:
// completion positions are measured in characters consumed, so the parser's
// contribution to "time-to-field" is separated from LLM generation, provider
// buffering, and transport chunking. The load-bearing claim: completion
// positions are identical no matter how the transport fragments the stream —
// the "the model produced the remainder in the same SSE chunk" explanation
// cannot account for the measured early availability.

function replay(text: string, schema: Schema, chunkSize: number): Map<string, number> {
  const positions = new Map<string, number>();
  let consumed = 0;
  const adapter = new JsonToStreamObjectAdapter(schema, {
    onFieldDone: (field) => positions.set(`field:${field}`, consumed),
    onItemDone: (field, index) => positions.set(`item:${field}:${index}`, consumed),
  });
  for (let i = 0; i < text.length; i += chunkSize) {
    const chunk = text.slice(i, i + chunkSize);
    for (const c of chunk) {
      consumed++;
      adapter.push(c);
    }
  }
  return positions;
}

const RECORDED_SCHEMA: Schema = [
  { path: ["summary"], type: "string" },
  { path: ["sentiment"], type: "string" },
  { path: ["topics"], type: "string", mode: "array", maxItems: 8 },
  { path: ["confidence"], type: "integer" },
];

const RECORDED =
  '{"summary":"The quick brown fox jumps over the lazy dog.",' +
  '"sentiment":"neutral","topics":["animals","action","description"],"confidence":95}';

describe("deterministic synthetic replay", () => {
  test("completion positions are independent of transport chunk size", () => {
    const baselines = new Map<number, Record<string, number>>();
    for (const chunkSize of [1, 5, 20, 100, RECORDED.length]) {
      baselines.set(chunkSize, Object.fromEntries(replay(RECORDED, RECORDED_SCHEMA, chunkSize)));
    }
    const reference = baselines.get(1)!;
    for (const [size, positions] of baselines) {
      expect(positions).toEqual(reference);
    }
  });

  test("semantic availability precedes whole-object availability", () => {
    const positions = Object.fromEntries(replay(RECORDED, RECORDED_SCHEMA, 1));
    const total = RECORDED.length;
    // The summary field is complete well before the object is.
    expect(positions["field:0"]!).toBeLessThan(total);
    expect(positions["field:0"]!).toBeLessThan(positions["field:2"]!);
    expect(positions["field:2"]!).toBeLessThan(total);
    // Array elements complete in order, each before the array field.
    expect(positions["item:2:0"]!).toBeLessThan(positions["item:2:1"]!);
    expect(positions["item:2:1"]!).toBeLessThan(positions["item:2:2"]!);
    expect(positions["item:2:2"]!).toBeLessThan(positions["field:2"]!);
    // The summary's closing quote defines its completion (self-validating).
    const summaryStart = RECORDED.indexOf("The quick brown fox jumps over the lazy dog.");
    expect(positions["field:0"]).toBe(summaryStart + 45);
  });

  test("a work-queue object lets the first query launch early", () => {
    const schema: Schema = [{ path: ["searchQueries"], type: "string", mode: "array", maxItems: 8 }];
    const text = JSON.stringify({
      searchQueries: [
        "OpenAI realtime API",
        "WebSocket streaming protocols",
        "incremental JSON parsing",
        "LLM agent architectures",
      ],
    });
    const positions = Object.fromEntries(replay(text, schema, 1));
    const total = text.length;
    // Query #1 is complete inside the first third of the stream: launch it
    // while the model is still generating the remaining queries.
    expect(positions["item:0:0"]!).toBeLessThan(total * 0.35);
    for (let i = 1; i < 4; i++) {
      expect(positions[`item:0:${i}`]!).toBeGreaterThan(positions[`item:0:${i - 1}`]!);
      expect(positions[`item:0:${i}`]!).toBeLessThan(total);
    }
    expect(positions["field:0"]!).toBeGreaterThan(positions["item:0:3"]!);
    expect(positions["field:0"]!).toBeLessThan(total);
  });
});

// ---------------------------------------------------------------------------
// Consumer-driven cancellation: the consumer stops the producer at the first
// field boundary and the producer's remaining output is never consumed.
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A producer that emits one character at a time, slowly, until stopped. */
class SlowProducer implements LLM {
  readonly text = '{"summary":"hello world","sentiment":"neutral","confidence":50}';
  yielded = 0;
  private controller: AbortController | null = null;

  stop(): void {
    this.controller?.abort();
  }

  async *stream(_request: LLMRequest): AsyncGenerator<LLMEvent> {
    const controller = new AbortController();
    this.controller = controller;
    try {
      for (const c of this.text) {
        await sleep(1);
        if (controller.signal.aborted) {
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        this.yielded++;
        yield { type: "delta", content: c };
      }
      yield { type: "done" };
    } finally {
      this.controller = null;
    }
  }
}

describe("consumer-driven cancellation", () => {
  test("the producer is stopped at the first field boundary; the tail is never consumed", async () => {
    const producer = new SlowProducer();
    const adapter = new JsonToStreamObjectAdapter(RECORDED_SCHEMA);
    let canceled = false;

    try {
      for await (const event of producer.stream({ messages: [] })) {
        if (event.type !== "delta") continue;
        adapter.push(event.content);
        const fields = adapter.getEvents().filter((e) => e.kind === "field");
        if (!canceled && fields.length > 0) {
          canceled = true;
          // Enough information: the summary is complete. Cancel the producer.
          expect(fields[0]).toEqual({ kind: "field", field: 0, value: "hello world" });
          producer.stop();
        }
      }
    } catch {
      // The abort surfaces as AbortError from the generator.
    }

    expect(canceled).toBe(true);
    expect(producer.yielded).toBeLessThan(producer.text.length);
    // Deterministic: stopped exactly at the summary's closing quote.
    const summaryEnd = producer.text.indexOf("hello world") + "hello world".length + 1;
    expect(producer.yielded).toBe(summaryEnd);
  });
});
