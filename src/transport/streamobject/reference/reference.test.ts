import { describe, expect, test } from "bun:test";
import {
  allCompositions,
  allSingleCuts,
  decode,
  encodeText,
  executeRecords,
  fieldRecords,
  fragment,
  generateValidRecords,
  materializeObject,
  mulberry32,
  randomSchema,
  ReferenceDecoder,
  type Event,
  type Rng,
  type Schema,
  type StreamRecord,
} from "./reference";

const append = (field: number, payload: string): StreamRecord => ({ kind: "append", field, payload });
const complete = (field: number): StreamRecord => ({ kind: "complete", field });
const objectComplete = (): StreamRecord => ({ kind: "object-complete" });
const objectAbort = (): StreamRecord => ({ kind: "object-abort" });

function decodeText(schema: Schema, text: string): Event[] {
  return decode([text], schema);
}

const FIXED_SCHEMA: Schema = [
  { path: ["name"], type: "string", maxLength: 16 },
  { path: ["age"], type: "integer", maxLength: 24 },
  { path: ["projects"], type: "string", mode: "array", maxItems: 4, maxLength: 8 },
  { path: ["ok"], type: "boolean" },
];

describe("canonical example (spec §8)", () => {
  const records: StreamRecord[] = [
    append(0, "Al"),
    append(1, "27"),
    append(2, "Apollo"),
    append(0, "ex"),
    complete(1),
    complete(0),
    append(2, "Orion"),
    complete(2),
    objectComplete(),
  ];

  test("oracle materializes the documented object", () => {
    const events = executeRecords(FIXED_SCHEMA, records);
    expect(materializeObject(FIXED_SCHEMA, events)).toEqual({
      name: "Alex",
      age: 27,
      projects: ["Apollo", "Orion"],
    });
  });

  test("events arrive in completion order, not schema order", () => {
    const events = executeRecords(FIXED_SCHEMA, records);
    expect(events).toEqual([
      { kind: "field", field: 1, value: 27 },
      { kind: "field", field: 0, value: "Alex" },
      { kind: "field", field: 2, value: ["Apollo", "Orion"] },
      { kind: "object-complete" },
    ]);
  });

  test("decode(encode(records)) === execute(records), every single cut + char-at-a-time", () => {
    const expected = executeRecords(FIXED_SCHEMA, records);
    const text = encodeText(records);
    for (const chunks of allSingleCuts(text)) {
      expect(decode(chunks, FIXED_SCHEMA)).toEqual(expected);
    }
    expect(decode([text], FIXED_SCHEMA)).toEqual(expected);
    expect(decode(text.split(""), FIXED_SCHEMA)).toEqual(expected);
  });
});

describe("transport fragmentation is semantically invisible (spec §1.2)", () => {
  const cases: Array<{ schema: Schema; records: StreamRecord[] }> = [
    { schema: [{ path: ["a"], type: "string" }], records: [append(0, "a"), complete(0), objectComplete()] },
    { schema: [{ path: ["a"], type: "string" }], records: [append(0, ""), complete(0), objectComplete()] },
    { schema: [{ path: ["a"], type: "string" }], records: [complete(0), objectComplete()] },
    { schema: [{ path: ["a"], type: "string" }], records: [objectComplete()] },
    { schema: [{ path: ["a"], type: "string", maxLength: 8 }], records: [append(0, "😀"), complete(0), objectComplete()] },
    { schema: [{ path: ["a"], type: "integer" }], records: [append(0, "27"), complete(0), objectComplete()] },
  ];

  for (const { schema, records } of cases) {
    const text = encodeText(records);
    if (text.length <= 12) {
      test(`all ${2 ** (text.length - 1)} compositions of ${JSON.stringify(text)}`, () => {
        const expected = executeRecords(schema, records);
        for (const chunks of allCompositions(text)) {
          expect(decode(chunks, schema)).toEqual(expected);
        }
      });
    }
  }
});

describe("random property: decoded wire ≡ oracle", () => {
  for (const seed of [1, 7, 42, 1337, 20260817]) {
    test(`seed ${seed}`, () => {
      const rng = mulberry32(seed);
      for (let iter = 0; iter < 250; iter++) {
        const schema = randomSchema(rng);
        const records = generateValidRecords(rng, schema);
        const expected = executeRecords(schema, records);
        const text = encodeText(records);

        expect(decode([text], schema)).toEqual(expected);
        expect(decode(fragment(text, rng), schema)).toEqual(expected);
        expect(decode(text.split(""), schema)).toEqual(expected);
        for (const chunks of allSingleCuts(text)) {
          expect(decode(chunks, schema)).toEqual(expected);
        }

        const last = expected[expected.length - 1]!;
        if (last.kind === "object-complete") {
          expect(materializeObject(schema, decode(fragment(text, rng), schema))).toEqual(
            materializeObject(schema, expected),
          );
        }
      }
    });
  }
});

describe("materialized object is independent of field scheduling", () => {
  test("random interleavings of the same per-field content agree", () => {
    const rng = mulberry32(99);
    for (let iter = 0; iter < 150; iter++) {
      const schema = randomSchema(rng);
      const perField = schema.map((_, field) => fieldRecords(rng, schema, field));

      const materializeWith = (content: StreamRecord[][]): Record<string, unknown> => {
        const records: StreamRecord[] = [...content.flat(), objectComplete()];
        return materializeObject(schema, executeRecords(schema, records));
      };

      const expected = materializeWith(perField);
      for (let k = 0; k < 4; k++) {
        expect(materializeWith(shuffleContent(rng, perField))).toEqual(expected);
      }
    }
  });
});

function shuffleContent(rng: Rng, perField: StreamRecord[][]): StreamRecord[][] {
  const copy = perField.map((r) => [...r]);
  const out: StreamRecord[][] = copy.map(() => []);
  const cursor = new Array(copy.length).fill(0);
  let remaining = copy.reduce((n, r) => n + r.length, 0);
  while (remaining > 0) {
    let field = Math.floor(rng() * copy.length);
    while (cursor[field]! >= copy[field]!.length) {
      field = (field + 1) % copy.length;
    }
    out[field]!.push(copy[field]![cursor[field]!]!);
    cursor[field] = cursor[field]! + 1;
    remaining--;
  }
  return out;
}

describe("protocol errors (spec §3, §6, §2.1)", () => {
  const schema: Schema = [
    { path: ["name"], type: "string", maxLength: 4 },
    { path: ["age"], type: "integer", maxLength: 24 },
    { path: ["projects"], type: "string", mode: "array", maxItems: 2, maxLength: 5 },
    { path: ["ok"], type: "boolean" },
    { path: ["score"], type: "number", maxLength: 24 },
  ];

  test("append after completion", () => {
    expect(() => decodeText(schema, "0:1:a;!0;0:1:b;!;")).toThrow();
  });

  test("duplicate completion", () => {
    expect(() => decodeText(schema, "0:1:a;!0;!0;!;")).toThrow();
  });

  test("unknown field", () => {
    expect(() => decodeText(schema, "9:1:a;!;")).toThrow();
    expect(() => decodeText(schema, "!9;!;")).toThrow();
  });

  test("maxLength exceeded (scalar, accumulated)", () => {
    expect(() => decodeText(schema, "0:3:abc;0:2:de;!0;!;")).toThrow();
  });

  test("maxLength exceeded (array, per-item)", () => {
    expect(() => decodeText(schema, "2:6:abcdef;!2;!;")).toThrow();
  });

  test("maxItems exceeded", () => {
    expect(() => decodeText(schema, "2:1:a;2:1:b;2:1:c;!2;!;")).toThrow();
  });

  test("integer lexical strictness", () => {
    expect(() => decodeText(schema, "1:2:01;!1;!;")).toThrow(); // leading zero
    expect(() => decodeText(schema, "1:2:-0;!1;!;")).toThrow(); // -0
    expect(() => decodeText(schema, "1:3:1e3;!1;!;")).toThrow(); // exponent
    expect(() => decodeText(schema, "1:4:0x10;!1;!;")).toThrow(); // hex
    expect(() => decodeText(schema, "1:16:9007199254740993;!1;!;")).toThrow(); // > MAX_SAFE_INTEGER
  });

  test("number lexical strictness", () => {
    expect(() => decodeText(schema, "4:2:01;!4;!;")).toThrow(); // leading zero
    expect(decodeText(schema, "4:3:1.5;!4;!;")).toEqual([
      { kind: "field", field: 4, value: 1.5 },
      { kind: "object-complete" },
    ]);
    expect(decodeText(schema, "4:4:1e-3;!4;!;")).toEqual([
      { kind: "field", field: 4, value: 0.001 },
      { kind: "object-complete" },
    ]);
  });

  test("boolean lexical strictness", () => {
    expect(() => decodeText(schema, "3:4:true;!3;!;")).toThrow();
  });

  test("valid typed payloads", () => {
    expect(decodeText(schema, "1:2:27;!1;!;")).toEqual([
      { kind: "field", field: 1, value: 27 },
      { kind: "object-complete" },
    ]);
    expect(decodeText(schema, "3:1:1;!3;!;")).toEqual([
      { kind: "field", field: 3, value: true },
      { kind: "object-complete" },
    ]);
  });

  test("complete an unseen typed scalar", () => {
    expect(() => decodeText(schema, "!1;!;")).toThrow();
    expect(() => decodeText(schema, "!3;!;")).toThrow();
  });

  test("empty string and empty array complete", () => {
    expect(decodeText(schema, "0:0:;!0;!;")).toEqual([
      { kind: "field", field: 0, value: "" },
      { kind: "object-complete" },
    ]);
    expect(decodeText(schema, "!2;!;")).toEqual([
      { kind: "field", field: 2, value: [] },
      { kind: "object-complete" },
    ]);
    expect(decodeText(schema, "!0;!;")).toEqual([
      { kind: "field", field: 0, value: "" },
      { kind: "object-complete" },
    ]);
  });

  test("object completion with absent fields", () => {
    const events = decodeText(schema, "!;");
    expect(events).toEqual([{ kind: "object-complete" }]);
    expect(materializeObject(schema, events)).toEqual({});
  });

  test("object abort", () => {
    expect(decodeText(schema, "~;")).toEqual([{ kind: "object-abort" }]);
    // An appended-but-uncompleted field emits nothing: only FIELD_COMPLETE
    // exposes partial state, and the abort discards the object.
    expect(decodeText(schema, "0:1:a;~;")).toEqual([{ kind: "object-abort" }]);
    // A field completed before the abort is valid partial state.
    expect(decodeText(schema, "0:1:a;!0;~;")).toEqual([
      { kind: "field", field: 0, value: "a" },
      { kind: "object-abort" },
    ]);
  });

  test("stream ended before object completion", () => {
    const d = new ReferenceDecoder(schema);
    d.push("0:1:a;");
    expect(() => d.end()).toThrow();
  });

  test("malformed grammar", () => {
    expect(() => decodeText(schema, "0:1a;")).toThrow();
    expect(() => decodeText(schema, "0::;")).toThrow();
    expect(() => decodeText(schema, "x;")).toThrow();
  });

  test("surrogate pair split across appends reassembles", () => {
    expect(decodeText(schema, "0:1:\uD83D;0:1:\uDE00;!0;!;")).toEqual([
      { kind: "field", field: 0, value: "😀" },
      { kind: "object-complete" },
    ]);
  });

  test("very long string round-trips through fragmentation", () => {
    const longSchema: Schema = [{ path: ["s"], type: "string" }];
    const records: StreamRecord[] = [append(0, "x".repeat(100_000)), complete(0), objectComplete()];
    const expected = executeRecords(longSchema, records);
    expect(decode(fragment(encodeText(records), mulberry32(5)), longSchema)).toEqual(expected);
  });
});
