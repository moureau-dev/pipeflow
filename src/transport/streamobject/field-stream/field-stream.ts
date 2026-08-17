/**
 * FieldStream — the semantic completion core shared by every source adapter.
 *
 * A FieldStream registers completion handlers (`when`/`whenItem`/`whenObjectDone`)
 * and dispatches completion events to them. It knows nothing about JSON, wire
 * records, SSE, or any particular producer: subclasses turn their source into
 * completion events via the protected emit helpers.
 *
 * Implementations:
 *   - StreamObject       — consumes an AsyncIterable of text chunks (JSON source)
 *   - ConversationStream — consumes conversation events (provider-native source)
 *
 * `when` means completion, not mutation: handlers never see chunks or source
 * format. Handlers are invoked synchronously at the completion boundary and
 * never block the producer; async handlers run concurrently and their
 * rejections are routed to onError. `cancel()` stops the stream (and invokes
 * the optional onCancel hook, e.g. to abort the producer's request).
 *
 * Performance note: this layer runs at completion frequency (a handful of
 * events per object), not token frequency. Dispatch is a plain array indexed
 * by field number; the Sets hold user-registered callbacks.
 *
 * Errors: delivered to onError handlers when registered; otherwise the
 * subclass decides (StreamObject rejects start(); callers of `fail()` get the
 * throw).
 */

import type { Event, FieldValue, ScalarValue, Schema } from "../reference/reference";
import { materializeObject } from "../reference/reference";

export type FieldHandler = (value: FieldValue) => void;
export type ItemHandler = (value: ScalarValue, index: number) => void;
export type ObjectDoneHandler = (object: Record<string, unknown>) => void;
export type ErrorHandler = (error: Error) => void;

export interface FieldStreamOptions {
  /** Invoked by cancel() — e.g. to abort the producer's request. */
  onCancel?: () => void;
}

export abstract class FieldStream {
  protected readonly schema: Schema;
  private readonly fieldHandlers: Array<Set<FieldHandler> | undefined>;
  private readonly itemHandlers: Array<Set<ItemHandler> | undefined>;
  private readonly objectHandlers = new Set<ObjectDoneHandler>();
  private readonly errorHandlers = new Set<ErrorHandler>();
  private readonly onCancel: (() => void) | undefined;
  protected cancelled = false;
  private objectDone = false;

  constructor(schema: Schema, options: FieldStreamOptions = {}) {
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

  /** Emit a completed field value (subclasses call this at the completion boundary). */
  protected emitField(field: number, value: FieldValue): void {
    const handlers = this.fieldHandlers[field];
    if (handlers === undefined) return;
    for (const handler of handlers) this.fire(handler, [value]);
  }

  /** True once the object has completed (or been cancelled). */
  protected get objectCompleted(): boolean {
    return this.objectDone;
  }

  /** Emit a completed array item. */
  protected emitItem(field: number, index: number, value: ScalarValue): void {
    const handlers = this.itemHandlers[field];
    if (handlers === undefined) return;
    for (const handler of handlers) this.fire(handler, [value, index]);
  }

  /** Complete the object from an event list (materializes and fires whenObjectDone once). */
  protected emitObject(events: Event[]): void {
    if (this.objectDone) return;
    this.objectDone = true;
    const object = materializeObject(this.schema, events);
    for (const handler of this.objectHandlers) this.fire(handler, [object]);
  }

  /** Route a source/adapter failure to onError, or rethrow when unhandled. */
  protected fail(error: unknown): void {
    this.dispatchError(toError(error));
  }

  protected resolveIndex(field: string | string[]): number {
    const key = Array.isArray(field) ? field.join(".") : field;
    const index = this.schema.findIndex((def) => def.path.join(".") === key);
    if (index === -1) {
      throw new TypeError(`unknown field path: "${key}"`);
    }
    return index;
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
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
