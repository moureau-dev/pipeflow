import { describe, expect, test } from "bun:test";
import { StreamObject } from "./stream-object";
import type { Schema } from "../reference/reference";

const SCHEMA: Schema = [
  { path: ["summary"], type: "string" },
  { path: ["sentiment"], type: "string" },
  { path: ["searchQueries"], type: "string", mode: "array", maxItems: 8 },
  { path: ["confidence"], type: "integer" },
];

const OBJECT = {
  summary: "The fox jumps.",
  sentiment: "neutral",
  searchQueries: ["query one", "query two"],
  confidence: 90,
};

function chunks(text: string, size = 1): AsyncIterable<string> {
  return (async function* () {
    for (let i = 0; i < text.length; i += size) {
      yield text.slice(i, i + size);
    }
  })();
}

describe("StreamObject", () => {
  test("handlers fire at completion boundaries in order", async () => {
    const order: string[] = [];
    const stream = new StreamObject(chunks(JSON.stringify(OBJECT)), SCHEMA);

    stream.when("summary", (value) => {
      expect(value).toBe("The fox jumps.");
      order.push("summary");
    });
    stream.whenItem("searchQueries", (value, index) => {
      order.push(`item:${index}`);
    });
    stream.when("searchQueries", (value) => {
      expect(value).toEqual(["query one", "query two"]);
      order.push("searchQueries");
    });
    stream.whenObjectDone((object) => {
      expect(object).toEqual(OBJECT);
      order.push("object");
    });

    await stream.start();
    expect(order).toEqual(["summary", "item:0", "item:1", "searchQueries", "object"]);
  });

  test("paths accept dotted strings and arrays", async () => {
    let byString: unknown;
    let byArray: unknown;
    const stream = new StreamObject(chunks(JSON.stringify(OBJECT)), SCHEMA);
    stream.when("summary", (v) => {
      byString = v;
    });
    stream.when(["confidence"], (v) => {
      byArray = v;
    });
    await stream.start();
    expect(byString).toBe("The fox jumps.");
    expect(byArray).toBe(90);
  });

  test("unknown paths and non-array whenItem throw at registration", () => {
    expect(() => new StreamObject(chunks("{}"), SCHEMA).when("nope", () => {})).toThrow(
      /unknown field path/,
    );
    expect(() => new StreamObject(chunks("{}"), SCHEMA).whenItem("summary", () => {})).toThrow(
      /is not an array/,
    );
  });

  test("cancel() from a when handler stops the producer mid-stream", async () => {
    const text = JSON.stringify(OBJECT);
    let yielded = 0;
    let cancelled = false;
    const source = (async function* () {
      for (const c of text) {
        yielded++;
        yield c;
      }
    })();

    const stream = new StreamObject(source, SCHEMA, {
      onCancel: () => {
        cancelled = true;
      },
    });
    let objectDone = false;
    stream.when("summary", () => stream.cancel());
    stream.whenObjectDone(() => {
      objectDone = true;
    });

    await stream.start(); // resolves: cancellation is not an error
    expect(cancelled).toBe(true);
    expect(objectDone).toBe(false);
    expect(yielded).toBeLessThan(text.length);
  });

  test("an async when handler can cancel after downstream work", async () => {
    let cancelled = false;
    const stream = new StreamObject(chunks(JSON.stringify(OBJECT)), SCHEMA, {
      onCancel: () => {
        cancelled = true;
      },
    });
    let resolveResult: (value: string) => void = () => {};
    const handlerDone = new Promise<string>((resolve) => {
      resolveResult = resolve;
    });
    stream.when("summary", async (summary) => {
      await new Promise((resolve) => setTimeout(resolve, 0)); // downstream work
      const result = `routed on ${summary}`;
      stream.cancel();
      resolveResult(result);
    });
    await stream.start();
    expect(await handlerDone).toBe("routed on The fox jumps.");
    expect(cancelled).toBe(true);
  });

  test("multiple handlers per path fire; start() is single-shot", async () => {
    const seen: number[] = [];
    const stream = new StreamObject(chunks(JSON.stringify(OBJECT)), SCHEMA);
    stream.when("confidence", () => seen.push(1));
    stream.when("confidence", () => seen.push(2));
    await stream.start();
    expect(seen).toEqual([1, 2]);
    await expect(stream.start()).rejects.toThrow(/already started/);
  });

  test("malformed input rejects start() when no error handler is registered", async () => {
    const stream = new StreamObject(chunks('{"summary": bad}'), SCHEMA);
    await expect(stream.start()).rejects.toThrow();
  });

  test("onError receives parse errors", async () => {
    const errors: Error[] = [];
    const stream = new StreamObject(chunks('{"summary": bad}'), SCHEMA);
    stream.onError((error) => errors.push(error));
    await stream.start(); // resolves; the error was delivered to the handler
    expect(errors.length).toBe(1);
  });

  test("source ending without the object rejects", async () => {
    const stream = new StreamObject(chunks('{"summary":"x"'), SCHEMA);
    await expect(stream.start()).rejects.toThrow(/object completion/);
  });
});
