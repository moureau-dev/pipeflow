import { describe, expect, test } from "bun:test";
import { JsonToStreamObjectAdapter } from "./json-adapter";
import { materializeObject, type Event, type Schema } from "../reference/reference";

const SCHEMA: Schema = [
  { path: ["summary"], type: "string" },
  { path: ["sentiment"], type: "string" },
  { path: ["topics"], type: "string", mode: "array", maxItems: 8 },
  { path: ["confidence"], type: "integer" },
];

const OBJECT = {
  summary: "The quick brown fox jumps over the lazy dog.",
  sentiment: "neutral",
  topics: ["fox", "dog", "quick"],
  confidence: 95,
};

function run(text: string): Event[] {
  const adapter = new JsonToStreamObjectAdapter(SCHEMA);
  adapter.push(text);
  return adapter.getEvents();
}

describe("JsonToStreamObjectAdapter", () => {
  test("parses an object into item/field events + object completion", () => {
    const events = run(JSON.stringify(OBJECT));
    expect(events).toEqual([
      { kind: "field", field: 0, value: OBJECT.summary },
      { kind: "field", field: 1, value: "neutral" },
      { kind: "item", field: 2, index: 0, value: "fox" },
      { kind: "item", field: 2, index: 1, value: "dog" },
      { kind: "item", field: 2, index: 2, value: "quick" },
      { kind: "field", field: 2, value: ["fox", "dog", "quick"] },
      { kind: "field", field: 3, value: 95 },
      { kind: "object-complete" },
    ]);
    expect(materializeObject(SCHEMA, events)).toEqual(OBJECT);
  });

  test("field events fire before the object completes (the whole point)", () => {
    const adapter = new JsonToStreamObjectAdapter(SCHEMA);
    for (const c of '{"summary":"The fox",') adapter.push(c);
    expect(adapter.getEvents()).toEqual([{ kind: "field", field: 0, value: "The fox" }]);
  });

  test("is fragmentation-agnostic: same events for any split point", () => {
    const text = JSON.stringify(OBJECT);
    const expected = run(text);
    for (let i = 1; i < text.length; i++) {
      const adapter = new JsonToStreamObjectAdapter(SCHEMA);
      adapter.push(text.slice(0, i));
      adapter.push(text.slice(i));
      expect(adapter.getEvents()).toEqual(expected);
    }
  });

  test("ignores whitespace and newlines", () => {
    const text =
      '{\n  "summary": "hi there",\n  "sentiment": "positive",\n' +
      '  "topics": ["a", "b"],\n  "confidence": 42\n}';
    const events = run(text);
    expect(events[events.length - 1]).toEqual({ kind: "object-complete" });
    expect(materializeObject(SCHEMA, events)).toEqual({
      summary: "hi there",
      sentiment: "positive",
      topics: ["a", "b"],
      confidence: 42,
    });
  });

  test("decodes string escapes", () => {
    const events = run('{"summary":"say \\"hi\\"\\nnext","sentiment":"neutral","topics":[],"confidence":1}');
    expect(events[0]).toEqual({ kind: "field", field: 0, value: 'say "hi"\nnext' });
  });

  test("decodes unicode escapes including surrogate pairs", () => {
    const events = run('{"summary":"\\uD83D\\uDE00 caf\\u00e9","sentiment":"neutral","topics":[],"confidence":1}');
    expect(events[0]).toEqual({ kind: "field", field: 0, value: "😀 café" });
  });

  test("parses negative, decimal and exponent numbers", () => {
    const schema: Schema = [{ path: ["n"], type: "number" }];
    const adapter = new JsonToStreamObjectAdapter(schema);
    adapter.push('{"n":-12.5e2}');
    expect(adapter.getEvents()).toEqual([
      { kind: "field", field: 0, value: -1250 },
      { kind: "object-complete" },
    ]);
  });

  test("tolerates markdown fences and trailing prose", () => {
    const fenced = run("```json\n" + JSON.stringify(OBJECT) + "\n```");
    expect(fenced[fenced.length - 1]).toEqual({ kind: "object-complete" });
    const trailed = run(JSON.stringify(OBJECT) + "\ntrailing prose");
    expect(trailed[trailed.length - 1]).toEqual({ kind: "object-complete" });
  });

  test("tolerates trailing commas", () => {
    const events = run('{"summary":"hi","topics":["a",],"confidence":3,}');
    expect(events[events.length - 1]).toEqual({ kind: "object-complete" });
  });

  test("array items complete before the array field (a work queue)", () => {
    const adapter = new JsonToStreamObjectAdapter(SCHEMA);
    for (const c of '{"topics":["alpha","beta"') adapter.push(c);
    expect(adapter.getEvents()).toEqual([
      { kind: "item", field: 2, index: 0, value: "alpha" },
      { kind: "item", field: 2, index: 1, value: "beta" },
    ]);
  });

  test("onItemDone callback fires per element with index", () => {
    const seen: Array<[number, number, unknown]> = [];
    const adapter = new JsonToStreamObjectAdapter(SCHEMA, {
      onItemDone: (field, index, value) => seen.push([field, index, value]),
    });
    adapter.push('{"topics":["a","b"]}');
    expect(seen).toEqual([
      [2, 0, "a"],
      [2, 1, "b"],
    ]);
  });

  test("nested schema paths complete independently", () => {
    const schema: Schema = [{ path: ["a", "b"], type: "string" }];
    const adapter = new JsonToStreamObjectAdapter(schema);
    for (const c of '{"a":{"b":"x"') adapter.push(c);
    expect(adapter.getEvents()).toEqual([{ kind: "field", field: 0, value: "x" }]);
  });

  test("schema-typed values throw on mismatch", () => {
    const schema: Schema = [{ path: ["confidence"], type: "integer" }];
    const adapter = new JsonToStreamObjectAdapter(schema);
    expect(() => adapter.push('{"confidence":95.5}')).toThrow();
    const stringField = new JsonToStreamObjectAdapter([{ path: ["s"], type: "string" }]);
    expect(() => stringField.push('{"s":42}')).toThrow();
  });

  test("malformed JSON throws", () => {
    expect(() => run('{"summary": "x" bad}')).toThrow();
    expect(() => run('{"summary": truX}')).toThrow();
  });

  test("onFieldDone callback fires with the field value", () => {
    const seen: Array<[number, unknown]> = [];
    const adapter = new JsonToStreamObjectAdapter(SCHEMA, {
      onFieldDone: (field, value) => seen.push([field, value]),
    });
    adapter.push('{"confidence":42}');
    expect(seen).toEqual([[3, 42]]);
  });
});
