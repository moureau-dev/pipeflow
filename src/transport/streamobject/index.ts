// StreamObject — a schema-bound streaming semantic protocol.
//
// Turns a text-chunk source (LLM deltas, SSE, wire records, conversation
// events) into completion events: consumers act when the value they depend on
// completes, without waiting for the enclosing object. See README.md.
export { FieldStream } from "./field-stream/index";
export type {
  ErrorHandler,
  FieldHandler,
  FieldStreamOptions,
  ItemHandler,
  ObjectDoneHandler,
} from "./field-stream/index";
export { StreamObject } from "./stream-object/index";
export type { StreamObjectOptions } from "./stream-object/index";
export { IncrementalJsonParser, JsonToStreamObjectAdapter } from "./json-adapter/index";
export type { JsonAdapterCallbacks, JsonValue } from "./json-adapter/index";
export {
  ReferenceDecoder,
  Receiver,
  decode,
  encodeText,
  executeRecords,
  materializeObject,
  parseBooleanPayload,
  parseIntegerPayload,
  parseNumberPayload,
} from "./reference/index";
export type {
  Decoder,
  Event,
  FieldDef,
  FieldType,
  FieldValue,
  Payload,
  ScalarValue,
  Schema,
  StreamRecord,
} from "./reference/index";
