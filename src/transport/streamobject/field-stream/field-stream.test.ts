import { describe, expect, test } from "bun:test";
import { FieldStream } from "./field-stream";
import type { Event, FieldValue, ScalarValue, Schema } from "../reference/reference";

const SCHEMA: Schema = [
  { path: ["summary"], type: "string" },
  { path: ["queries"], type: "string", mode: "array", maxItems: 8 },
];

/** Test double exposing the protected emit helpers. */
class TestStream extends FieldStream {
  begin(): void {
    this.beginObject();
  }
  field(value: FieldValue): void {
    this.emitField(0, value);
  }
  item(index: number, value: ScalarValue): void {
    this.emitItem(1, index, value);
  }
  complete(): void {
    const events: Event[] = [
      { kind: "field", field: 0, value: "done" },
      { kind: "field", field: 1, value: ["a"] },
      { kind: "object-complete" },
    ];
    this.emitObject(events);
  }
  abort(): void {
    this.cancelObject();
  }
  error(error: unknown): void {
    this.fail(error);
  }
  get completed(): boolean {
    return this.objectCompleted;
  }
}

describe("FieldStream contract", () => {
  test("exactly one terminal event per object", () => {
    const stream = new TestStream(SCHEMA);
    let objects = 0;
    stream.whenObjectDone(() => {
      objects++;
    });
    stream.begin();
    stream.complete();
    stream.complete(); // second terminal: ignored
    expect(objects).toBe(1);
    expect(stream.completed).toBe(true);
  });

  test("terminal objects emit no further field/item events", () => {
    const stream = new TestStream(SCHEMA);
    const items: string[] = [];
    stream.whenItem("queries", (value) => items.push(value as string));
    stream.begin();
    stream.item(0, "a");
    stream.complete();
    stream.item(1, "late"); // dropped: the object is done
    stream.field("late"); // dropped
    expect(items).toEqual(["a"]);
  });

  test("cancel and fail terminate without a completion event; late emissions are dropped", () => {
    for (const terminal of ["cancel", "fail"] as const) {
      const stream = new TestStream(SCHEMA);
      const items: string[] = [];
      let objects = 0;
      stream.onError(() => {}); // fail() delivers here instead of throwing
      stream.whenItem("queries", (value) => items.push(value as string));
      stream.whenObjectDone(() => {
        objects++;
      });
      stream.begin();
      stream.item(0, "a");
      if (terminal === "cancel") stream.abort();
      else stream.error(new Error("boom"));
      stream.complete(); // ignored after a terminal state
      stream.item(1, "late"); // ignored
      expect(items).toEqual(["a"]);
      expect(objects).toBe(0);
    }
  });

  test("cancel() is idempotent and is not an error", () => {
    const stream = new TestStream(SCHEMA);
    const errors: Error[] = [];
    stream.onError((error) => errors.push(error));
    stream.begin();
    stream.cancel();
    stream.cancel();
    stream.cancel();
    expect(errors).toHaveLength(0); // cancellation is not an error
    expect(stream.completed).toBe(false);
  });

  test("beginObject() reuses the stream for subsequent object lifecycles", () => {
    const stream = new TestStream(SCHEMA);
    const objects: string[] = [];
    stream.whenObjectDone((object) => objects.push((object as { summary: string }).summary));
    stream.begin();
    stream.complete();
    stream.begin();
    stream.complete();
    expect(objects).toEqual(["done", "done"]);
  });

  test("a cancelled object does not poison the next one", () => {
    const stream = new TestStream(SCHEMA);
    const items: string[] = [];
    stream.whenItem("queries", (value) => items.push(value as string));
    stream.begin();
    stream.item(0, "a");
    stream.abort();
    stream.begin();
    stream.item(0, "b");
    expect(items).toEqual(["a", "b"]);
  });
});
