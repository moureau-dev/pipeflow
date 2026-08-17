/**
 * StreamObject — the semantic consumer API.
 *
 * Turns any text-chunk source (LLM deltas, SSE payloads, wire records,
 * anything) into completion events: consumers act when the value they depend
 * on completes, without waiting for the enclosing object.
 *
 *   const stream = new StreamObject(source, schema);
 *   stream.when("summary", (summary) => { ... });            // field completion
 *   stream.whenItem("searchQueries", (query, i) => { ... }); // item completion
 *   stream.whenObjectDone((object) => { ... });              // whole object
 *   stream.onError((error) => { ... });                      // failures
 *   await stream.start();
 *
 * `when` means completion, not mutation: handlers never see chunks, JSON,
 * SSE, or the wire codec. Handlers are invoked synchronously at the
 * completion boundary and never block the source; async handlers run
 * concurrently and their rejections are routed to onError. `cancel()` stops
 * the source and invokes the optional onCancel hook (e.g. to abort the
 * producer's request).
 *
 * Performance note: this layer runs at completion frequency (a handful of
 * events per object), not token frequency. Dispatch is a plain array indexed
 * by field number; the Sets hold user-registered callbacks, which no amount
 * of typed-array work can replace. The per-token arena belongs to the wire
 * decoder beneath this API.
 *
 * Errors: delivered to onError handlers when registered; otherwise start()
 * rejects with the error. Cancelling the stream is not an error.
 */

import { JsonToStreamObjectAdapter } from "../json-adapter/json-adapter";
import {
  materializeObject,
  type Event,
  type FieldValue,
  type ScalarValue,
  type Schema,
} from "../reference/reference";

export type FieldHandler = (value: FieldValue) => void;
export type ItemHandler = (value: ScalarValue, index: number) => void;
export type ObjectDoneHandler = (object: Record<string, unknown>) => void;
export type ErrorHandler = (error: Error) => void;

export interface StreamObjectOptions {
  /** Invoked by cancel() — e.g. to abort the producer's request. */
  onCancel?: () => void;
}

export class StreamObject {
  private readonly schema: Schema;
  /** Indexed by field number; a Set of user callbacks per field. */
  private readonly fieldHandlers: Array<Set<FieldHandler> | undefined>;
  private readonly itemHandlers: Array<Set<ItemHandler> | undefined>;
  private readonly objectHandlers = new Set<ObjectDoneHandler>();
  private readonly errorHandlers = new Set<ErrorHandler>();
  private readonly onCancel: (() => void) | undefined;
  private started = false;
  private cancelled = false;
  private objectDone = false;

  constructor(
    private readonly source: AsyncIterable<string>,
    schema: Schema,
    options: StreamObjectOptions = {},
  ) {
    this.schema = schema;
    this.onCancel = options.onCancel;
    this.fieldHandlers = new Array(schema.length);
    this.itemHandlers = new Array(schema.length);
  }

  when(field: string | string[], handler: FieldHandler): this {
    const index = this.resolveIndex(field);
    (this.fieldHandlers[index] ??= new Set()).add(handler);
    return this;
  }

  whenItem(field: string | string[], handler: ItemHandler): this {
    const index = this.resolveIndex(field);
    const def = this.schema[index]!;
    if (def.mode !== "array") {
      throw new TypeError(`whenItem: field "${def.path.join(".")}" is not an array`);
    }
    (this.itemHandlers[index] ??= new Set()).add(handler);
    return this;
  }

  whenObjectDone(handler: ObjectDoneHandler): this {
    this.objectHandlers.add(handler);
    return this;
  }

  onError(handler: ErrorHandler): this {
    this.errorHandlers.add(handler);
    return this;
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.onCancel?.();
  }

  async start(): Promise<void> {
    if (this.started) throw new Error("StreamObject already started");
    this.started = true;

    const adapter = new JsonToStreamObjectAdapter(this.schema, {
      onFieldDone: (field, value) => this.dispatchField(field, value),
      onItemDone: (field, index, value) => this.dispatchItem(field, index, value),
      onObjectDone: () => this.dispatchObjectDone(adapter.getEvents()),
    });

    try {
      for await (const chunk of this.source) {
        if (this.cancelled) break;
        for (let i = 0; i < chunk.length; i++) {
          if (this.cancelled) break;
          adapter.push(chunk[i]!);
        }
      }
      if (!this.cancelled && !this.objectDone) {
        throw new Error("stream ended before object completion");
      }
    } catch (error) {
      if (this.cancelled) return; // intended cancellation (e.g. producer aborted)
      this.dispatchError(toError(error));
    }
  }

  private dispatchField(field: number, value: FieldValue): void {
    const handlers = this.fieldHandlers[field];
    if (handlers === undefined) return;
    for (const handler of handlers) this.fire(handler, [value]);
  }

  private dispatchItem(field: number, index: number, value: ScalarValue): void {
    const handlers = this.itemHandlers[field];
    if (handlers === undefined) return;
    for (const handler of handlers) this.fire(handler, [value, index]);
  }

  private dispatchObjectDone(events: Event[]): void {
    if (this.objectDone) return;
    this.objectDone = true;
    const object = materializeObject(this.schema, events);
    for (const handler of this.objectHandlers) this.fire(handler, [object]);
  }

  private fire<T extends unknown[]>(handler: (...args: T) => unknown, args: T): void {
    try {
      const result = handler(...args);
      if (result instanceof Promise) {
        void result.catch((error) => this.dispatchError(toError(error)));
      }
    } catch (error) {
      this.dispatchError(toError(error));
    }
  }

  private dispatchError(error: Error): void {
    if (this.errorHandlers.size === 0) throw error;
    for (const handler of this.errorHandlers) {
      try {
        handler(error);
      } catch {
        // a failing error handler is not re-dispatched
      }
    }
  }

  private resolveIndex(field: string | string[]): number {
    const key = Array.isArray(field) ? field.join(".") : field;
    const index = this.schema.findIndex((def) => def.path.join(".") === key);
    if (index === -1) {
      throw new TypeError(`unknown field path: "${key}"`);
    }
    return index;
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
