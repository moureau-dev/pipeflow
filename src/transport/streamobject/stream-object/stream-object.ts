/**
 * StreamObject — consumes an AsyncIterable of text chunks through the
 * incremental JSON adapter and exposes the FieldStream completion API.
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
 * Errors: delivered to onError handlers when registered; otherwise start()
 * rejects with the error. Cancelling the stream is not an error.
 */

import { FieldStream, type FieldStreamOptions } from "../field-stream/field-stream";
import { JsonToStreamObjectAdapter } from "../json-adapter/json-adapter";
import type { Schema } from "../reference/reference";

export type {
  ErrorHandler,
  FieldHandler,
  FieldStreamOptions,
  ItemHandler,
  ObjectDoneHandler,
} from "../field-stream/field-stream";

export type StreamObjectOptions = FieldStreamOptions;

export class StreamObject extends FieldStream {
  private started = false;

  constructor(
    private readonly source: AsyncIterable<string>,
    schema: Schema,
    options: StreamObjectOptions = {},
  ) {
    super(schema, options);
  }

  async start(): Promise<void> {
    if (this.started) throw new Error("StreamObject already started");
    this.started = true;

    const adapter = new JsonToStreamObjectAdapter(this.schema, {
      onFieldDone: (field, value) => this.emitField(field, value),
      onItemDone: (field, index, value) => this.emitItem(field, index, value),
      onObjectDone: () => this.emitObject(adapter.getEvents()),
    });

    try {
      for await (const chunk of this.source) {
        if (this.cancelled) break;
        for (let i = 0; i < chunk.length; i++) {
          if (this.cancelled) break;
          adapter.push(chunk[i]!);
        }
      }
      if (!this.cancelled && !this.objectCompleted) {
        throw new Error("stream ended before object completion");
      }
    } catch (error) {
      if (this.cancelled) return; // intended cancellation (e.g. producer aborted)
      this.fail(error);
    }
  }
}
