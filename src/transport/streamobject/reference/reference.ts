/**
 * StreamObject Protocol v0.1 — reference implementation (the executable spec).
 *
 * Deliberately boring: no arena, no pooling, no typed-array chunk chains.
 * Its purpose is to pin down semantics so the optimized receiver can be
 * validated against it instead of inventing behavior.
 *
 * Layering:
 *   records --(encodeText)--> text --(fragment)--> chunks
 *   chunks --(ReferenceDecoder)--> events
 *   records --(Receiver / executeRecords)--> events   <- the oracle
 *
 * Contract (the property every decoder must satisfy):
 *   decode(fragment(encodeText(records)))  ===  executeRecords(records)
 *
 * See README.md (in this directory) for the normative spec this implements.
 */

export type Payload = string; // payload as a JS string (UTF-16 code units)

export type StreamRecord =
  | { kind: "append"; field: number; payload: Payload }
  | { kind: "complete"; field: number }
  | { kind: "object-complete" }
  | { kind: "object-abort" };

export type FieldType = "string" | "integer" | "number" | "boolean";

export interface FieldDef {
  path: string[];
  type: FieldType;
  mode?: "array";
  /** Required for array fields. */
  maxItems?: number;
  /** Scalar: cap on accumulated payload length. Array: cap per item. */
  maxLength?: number;
}

export type Schema = FieldDef[];

export type ScalarValue = string | number | boolean;
export type FieldValue = ScalarValue | ScalarValue[];

export type Event =
  | { kind: "field"; field: number; value: FieldValue }
  /** Adapter-observable item completion (arrays); not emitted by the v0.1 wire decoder. */
  | { kind: "item"; field: number; index: number; value: ScalarValue }
  | { kind: "object-complete" }
  | { kind: "object-abort" };

// ---- canonical typed payloads (spec §2.1) -----------------------------------

const INTEGER_RE = /^-?(0|[1-9][0-9]*)$/;
const NUMBER_RE = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;

export function parseIntegerPayload(s: string): number | null {
  if (!INTEGER_RE.test(s)) return null;
  if (s === "-0") return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

export function parseNumberPayload(s: string): number | null {
  if (!NUMBER_RE.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function parseBooleanPayload(s: string): boolean | null {
  if (s === "0") return false;
  if (s === "1") return true;
  return null;
}

function parseTyped(type: FieldType, s: string, field: number): ScalarValue {
  switch (type) {
    case "string":
      return s;
    case "integer": {
      const v = parseIntegerPayload(s);
      if (v === null) throw new Error(`field ${field}: invalid integer payload`);
      return v;
    }
    case "number": {
      const v = parseNumberPayload(s);
      if (v === null) throw new Error(`field ${field}: invalid number payload`);
      return v;
    }
    case "boolean": {
      const v = parseBooleanPayload(s);
      if (v === null) throw new Error(`field ${field}: invalid boolean payload`);
      return v;
    }
  }
}

// ---- semantic engine (shared by oracle and decoder) --------------------------

export class Receiver {
  private readonly schema: Schema;
  private readonly state: Uint8Array; // 0 unseen, 1 streaming, 2 done
  private readonly acc: Array<string | string[]>;
  private readonly events: Event[] = [];
  private readonly onEvent: ((event: Event) => void) | undefined;
  private ended = false;

  constructor(schema: Schema, onEvent?: (event: Event) => void) {
    this.schema = schema;
    this.onEvent = onEvent;
    this.state = new Uint8Array(schema.length);
    this.acc = new Array(schema.length);
  }

  append(field: number, payload: string): void {
    this.assertActive();
    this.assertField(field);
    if (this.state[field] === 2) {
      throw new Error(`field ${field}: append after completion`);
    }
    const def = this.schema[field]!;
    if (def.mode === "array") {
      const items = (this.acc[field] ??= []) as string[];
      const maxItems = def.maxItems as number;
      if (items.length >= maxItems) {
        throw new Error(`field ${field}: exceeds maxItems=${maxItems}`);
      }
      if (def.maxLength !== undefined && payload.length > def.maxLength) {
        throw new Error(`field ${field}: item exceeds maxLength=${def.maxLength}`);
      }
      items.push(payload);
    } else {
      const current = (this.acc[field] ??= "") as string;
      if (def.maxLength !== undefined && current.length + payload.length > def.maxLength) {
        throw new Error(`field ${field}: exceeds maxLength=${def.maxLength}`);
      }
      this.acc[field] = current + payload;
    }
    this.state[field] = 1;
  }

  complete(field: number): void {
    this.assertActive();
    this.assertField(field);
    if (this.state[field] === 2) {
      throw new Error(`field ${field}: completed twice`);
    }
    const def = this.schema[field]!;
    if (this.state[field] === 0) {
      if (def.type !== "string" && def.mode !== "array") {
        throw new Error(`field ${field}: cannot complete an empty ${def.type} field`);
      }
      this.state[field] = 2;
      this.emit({ kind: "field", field, value: def.mode === "array" ? [] : "" });
      return;
    }
    this.state[field] = 2;
    this.emit({
      kind: "field",
      field,
      value: materialize(this.schema, field, this.acc[field] as string | string[]),
    });
  }

  objectComplete(): void {
    this.assertActive();
    this.ended = true;
    this.emit({ kind: "object-complete" });
  }

  objectAbort(): void {
    this.assertActive();
    this.ended = true;
    this.emit({ kind: "object-abort" });
  }

  getEvents(): Event[] {
    return this.events;
  }

  get isEnded(): boolean {
    return this.ended;
  }

  private assertActive(): void {
    if (this.ended) throw new Error("object already ended");
  }

  private assertField(field: number): void {
    if (field < 0 || field >= this.schema.length) {
      throw new Error(`unknown field ${field}`);
    }
  }

  private emit(event: Event): void {
    this.events.push(event);
    this.onEvent?.(event);
  }
}

function materialize(schema: Schema, field: number, raw: string | string[]): FieldValue {
  const def = schema[field]!;
  if (def.mode === "array") {
    return (raw as string[]).map((item) => parseTyped(def.type, item, field));
  }
  return parseTyped(def.type, raw as string, field);
}

/** The oracle: execute logical records directly. */
export function executeRecords(schema: Schema, records: StreamRecord[]): Event[] {
  const receiver = new Receiver(schema);
  for (const record of records) {
    switch (record.kind) {
      case "append":
        receiver.append(record.field, record.payload);
        break;
      case "complete":
        receiver.complete(record.field);
        break;
      case "object-complete":
        receiver.objectComplete();
        break;
      case "object-abort":
        receiver.objectAbort();
        break;
    }
  }
  if (!receiver.isEnded) throw new Error("stream ended before object completion");
  return receiver.getEvents();
}

// ---- materialization ----------------------------------------------------------

export function materializeObject(schema: Schema, events: Event[]): Record<string, unknown> {
  const object: Record<string, unknown> = {};
  for (const event of events) {
    if (event.kind !== "field") continue;
    setPath(object, schema[event.field]!.path, event.value);
  }
  return object;
}

function setPath(object: Record<string, unknown>, path: string[], value: unknown): void {
  let target = object;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    if (typeof target[key] !== "object" || target[key] === null) {
      target[key] = {};
    }
    target = target[key] as Record<string, unknown>;
  }
  target[path[path.length - 1]!] = value;
}

// ---- reference text encoding (spec §8) ----------------------------------------

export function encodeText(records: StreamRecord[]): string {
  let out = "";
  for (const record of records) {
    switch (record.kind) {
      case "append":
        out += `${record.field}:${record.payload.length}:${record.payload};`;
        break;
      case "complete":
        out += `!${record.field};`;
        break;
      case "object-complete":
        out += "!;";
        break;
      case "object-abort":
        out += "~;";
        break;
    }
  }
  return out;
}

// ---- reference decoder ----------------------------------------------------------

/**
 * The contract every implementation (including the future arena-backed
 * receiver) must satisfy:
 *
 *   push(fragment(encodeText(records))) + end()  ===  executeRecords(schema, records)
 */
export interface Decoder {
  push(chunk: string): void;
  end(): Event[];
}

type ParserState = "header" | "field-id" | "length" | "payload" | "payload-end" | "control" | "abort";

export class ReferenceDecoder implements Decoder {
  private readonly receiver: Receiver;
  private state: ParserState = "header";
  private fieldId = "";
  private length = "";
  private payload = "";
  private remaining = 0;

  constructor(schema: Schema, onEvent?: (event: Event) => void) {
    this.receiver = new Receiver(schema, onEvent);
  }

  push(chunk: string): void {
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i]!;
      switch (this.state) {
        case "header":
          this.onHeader(c);
          break;
        case "field-id":
          this.onFieldId(c);
          break;
        case "length":
          this.onLength(c);
          break;
        case "payload":
          this.onPayload(c);
          break;
        case "payload-end":
          this.onPayloadEnd(c);
          break;
        case "control":
          this.onControl(c);
          break;
        case "abort":
          this.onAbort(c);
          break;
      }
    }
  }

  end(): Event[] {
    if (!this.receiver.isEnded) throw new Error("stream ended before object completion");
    return this.receiver.getEvents();
  }

  private onHeader(c: string): void {
    if (isDigit(c)) {
      this.reset();
      this.fieldId = c;
      this.state = "field-id";
      return;
    }
    if (c === "!") {
      this.reset();
      this.state = "control";
      return;
    }
    if (c === "~") {
      this.state = "abort";
      return;
    }
    throw new Error(`expected record start, got ${JSON.stringify(c)}`);
  }

  private onFieldId(c: string): void {
    if (isDigit(c)) {
      this.fieldId += c;
      return;
    }
    if (c === ":") {
      this.state = "length";
      return;
    }
    throw new Error(`expected ':' after field id, got ${JSON.stringify(c)}`);
  }

  private onLength(c: string): void {
    if (isDigit(c)) {
      this.length += c;
      return;
    }
    if (c === ":") {
      if (this.length === "") throw new Error("empty payload length");
      this.remaining = Number(this.length);
      this.payload = "";
      this.state = this.remaining === 0 ? "payload-end" : "payload";
      return;
    }
    throw new Error(`expected ':' after length, got ${JSON.stringify(c)}`);
  }

  private onPayload(c: string): void {
    this.payload += c;
    if (--this.remaining === 0) this.state = "payload-end";
  }

  private onPayloadEnd(c: string): void {
    if (c !== ";") throw new Error(`expected ';' after payload, got ${JSON.stringify(c)}`);
    this.receiver.append(Number(this.fieldId), this.payload);
    this.state = "header";
  }

  private onControl(c: string): void {
    if (isDigit(c)) {
      this.fieldId += c;
      return;
    }
    if (c === ";") {
      if (this.fieldId === "") this.receiver.objectComplete();
      else this.receiver.complete(Number(this.fieldId));
      this.state = "header";
      return;
    }
    throw new Error(`expected field id or ';' after '!', got ${JSON.stringify(c)}`);
  }

  private onAbort(c: string): void {
    if (c !== ";") throw new Error(`expected ';' after '~', got ${JSON.stringify(c)}`);
    this.receiver.objectAbort();
    this.state = "header";
  }

  private reset(): void {
    this.fieldId = "";
    this.length = "";
    this.payload = "";
    this.remaining = 0;
  }
}

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

/** Decode a sequence of transport chunks into events. */
export function decode(chunks: string[], schema: Schema): Event[] {
  const decoder = new ReferenceDecoder(schema);
  for (const chunk of chunks) decoder.push(chunk);
  return decoder.end();
}

// ---- test utilities: rng, fragmentation, generators ----------------------------

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function fragment(text: string, rng: Rng): string[] {
  const cuts: number[] = [];
  for (let i = 1; i < text.length; i++) {
    if (rng() < 0.3) cuts.push(i);
  }
  const chunks: string[] = [];
  let prev = 0;
  for (const cut of cuts) {
    chunks.push(text.slice(prev, cut));
    prev = cut;
  }
  chunks.push(text.slice(prev));
  return chunks;
}

/** Every single-cut fragmentation of a message. */
export function allSingleCuts(text: string): string[][] {
  const out: string[][] = [];
  for (let i = 1; i < text.length; i++) {
    out.push([text.slice(0, i), text.slice(i)]);
  }
  return out;
}

/** Every composition into 1..n chunks — 2^(n-1) cases. Only for small messages. */
export function allCompositions(text: string): string[][] {
  const out: string[][] = [];
  for (let mask = 0; mask < 1 << (text.length - 1); mask++) {
    const chunks: string[] = [];
    let prev = 0;
    for (let i = 1; i < text.length; i++) {
      if (mask & (1 << (i - 1))) {
        chunks.push(text.slice(prev, i));
        prev = i;
      }
    }
    chunks.push(text.slice(prev));
    out.push(chunks);
  }
  return out;
}

// ---- random valid stream generators ----------------------------------------------

const TYPES: FieldType[] = ["string", "integer", "number", "boolean"];
const ALPHABET = "abZ09;:!~ é😀"; // protocol punctuation inside payloads + astral chars

export function randomSchema(rng: Rng): Schema {
  const count = 1 + Math.floor(rng() * 4);
  const schema: Schema = [];
  for (let i = 0; i < count; i++) {
    const type = TYPES[Math.floor(rng() * TYPES.length)]!;
    const isArray = rng() < 0.4;
    schema.push({
      path: [`f${i}`],
      type,
      ...(isArray ? { mode: "array" as const, maxItems: 1 + Math.floor(rng() * 4) } : {}),
      ...(rng() < 0.8 ? { maxLength: 1 + Math.floor(rng() * 16) } : {}),
    });
  }
  return schema;
}

function randomString(rng: Rng, cap: number): string {
  let s = "";
  while (s.length < cap && rng() < 0.85) {
    s += ALPHABET[Math.floor(rng() * ALPHABET.length)]!;
  }
  return s;
}

function randomTyped(rng: Rng, type: FieldType, cap: number): string {
  switch (type) {
    case "string":
      return rng() < 0.15 ? "" : randomString(rng, cap);
    case "integer":
      return String(Math.floor(rng() * 2000) - 1000);
    case "number": {
      const r = rng();
      if (r < 0.4) return String(Math.floor(rng() * 2000) - 1000);
      if (r < 0.7) return String(Math.round((rng() * 2000 - 1000) * 100) / 100);
      return String((rng() * 2 - 1) * 1e10);
    }
    case "boolean":
      return rng() < 0.5 ? "0" : "1";
  }
}

/** A payload that satisfies the type and (when set) the length cap. */
function payloadFor(rng: Rng, type: FieldType, cap: number | undefined): string {
  const limit = cap ?? 12;
  for (let i = 0; i < 100; i++) {
    const p = randomTyped(rng, type, limit);
    if (p.length <= limit) return p;
  }
  return type === "string" ? "" : "0";
}

function splitFragments(s: string, count: number): string[] {
  if (s.length === 0) return [];
  const chunks: string[] = [];
  let prev = 0;
  for (let i = 1; i < count; i++) {
    const cut = Math.floor((i * s.length) / count);
    chunks.push(s.slice(prev, cut));
    prev = cut;
  }
  chunks.push(s.slice(prev));
  return chunks.filter((c) => c.length > 0);
}

/** Records for one field: appends (one item each for arrays), maybe a completion. */
export function fieldRecords(rng: Rng, schema: Schema, field: number): StreamRecord[] {
  const def = schema[field]!;
  const records: StreamRecord[] = [];

  if (def.mode === "array") {
    const maxItems = def.maxItems as number;
    const count = Math.floor(rng() * (maxItems + 1));
    for (let i = 0; i < count; i++) {
      records.push({ kind: "append", field, payload: payloadFor(rng, def.type, def.maxLength) });
    }
    if (rng() < 0.8) records.push({ kind: "complete", field });
    return records;
  }

  // scalar: generate the final payload, then fragment it across appends
  const total = payloadFor(rng, def.type, def.maxLength);
  const fragments = splitFragments(total, 1 + Math.floor(rng() * 4));
  for (const fragment of fragments) {
    records.push({ kind: "append", field, payload: fragment });
  }

  const canCompleteEmpty = def.type === "string";
  const hasContent = records.length > 0;
  if (hasContent ? rng() < 0.85 : canCompleteEmpty && rng() < 0.5) {
    records.push({ kind: "complete", field });
  }
  return records;
}

/** A valid record sequence for the schema, randomly scheduled. */
export function generateValidRecords(rng: Rng, schema: Schema): StreamRecord[] {
  const queues = schema.map((_, field) => ({
    field,
    records: fieldRecords(rng, schema, field),
    pos: 0,
  }));
  const out: StreamRecord[] = [];
  let remaining = queues.reduce((n, q) => n + q.records.length, 0);

  while (remaining > 0) {
    let queue = queues[Math.floor(rng() * queues.length)]!;
    while (queue.pos >= queue.records.length) {
      queue = queues[(queue.field + 1) % queues.length]!;
    }
    out.push(queue.records[queue.pos]!);
    queue.pos++;
    remaining--;
  }

  out.push(rng() < 0.1 ? { kind: "object-abort" } : { kind: "object-complete" });
  return out;
}
