/**
 * Incremental JSON → StreamObject adapter.
 *
 * Consumes a JSON token stream (e.g. LLM output deltas) and emits StreamObject
 * field-completion events as soon as each schema field's value is complete —
 * without waiting for the rest of the object. This is the designed production
 * shape of the protocol: the model emits ordinary output, deterministic
 * software does the parsing, and consumers react at field boundaries.
 *
 * The wire encoding is irrelevant here; only the Event model matters.
 */

import type { Event, FieldDef, FieldType, FieldValue, ScalarValue, Schema } from "../reference/reference";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

interface ObjectCtx {
  kind: "object";
  path: string[];
  map: Record<string, JsonValue>;
  key: string | null; // the key currently awaiting its value
  phase: "key" | "colon" | "value";
}

interface ArrayCtx {
  kind: "array";
  path: string[];
  items: JsonValue[];
}

type ValueState =
  | { kind: "string"; path: string[]; raw: string; escaped: boolean }
  | { kind: "number"; path: string[]; raw: string }
  | { kind: "literal"; path: string[]; raw: string };

/** Minimal incremental JSON parser. Emits every completed value with its path. */
export class IncrementalJsonParser {
  private readonly stack: Array<ObjectCtx | ArrayCtx> = [];
  private value: ValueState | null = null;
  private started = false;
  private done = false;

  constructor(private readonly onValueDone: (path: string[], value: JsonValue) => void) {}

  push(chunk: string): void {
    for (let i = 0; i < chunk.length; i++) {
      this.pushChar(chunk[i]!);
    }
  }

  private pushChar(c: string): void {
    if (this.done) return;
    if (!this.started) {
      // Preamble (markdown fences, prose) is ignored until the object starts.
      if (c === "{") {
        this.started = true;
        this.stack.push({ kind: "object", path: [], map: {}, key: null, phase: "key" });
      }
      return;
    }
    let ch = c;
    for (;;) {
      if (this.value !== null) {
        if (this.feedValue(ch)) return;
        continue; // the value completed on ch as a terminator; reprocess it
      }
      this.dispatch(ch);
      return;
    }
  }

  private dispatch(c: string): void {
    if (isWhitespace(c)) return;
    const top = this.stack[this.stack.length - 1]!;
    if (top.kind === "object") {
      if (top.phase === "key") {
        if (c === '"') {
          this.value = { kind: "string", path: top.path, raw: "", escaped: false };
          return;
        }
        if (c === "}") {
          this.closeContainer(top);
          return;
        }
        if (c === ",") return; // tolerate trailing commas in model output
        throw new Error(
          `JSON: expected key or '}' at path [${top.path.join(".")}], got ${JSON.stringify(c)}`,
        );
      }
      if (top.phase === "colon") {
        if (c === ":") {
          top.phase = "value";
          return;
        }
        throw new Error(`JSON: expected ':' after key ${JSON.stringify(top.key)}`);
      }
      this.startValue(c, top, top.path.concat(top.key ?? "?"));
      return;
    }
    if (c === "]") {
      this.closeContainer(top);
      return;
    }
    if (c === ",") return; // tolerate trailing commas
    this.startValue(c, top, top.path.concat(String(top.items.length)));
  }

  private startValue(c: string, _top: ObjectCtx | ArrayCtx, path: string[]): void {
    if (c === '"') {
      this.value = { kind: "string", path, raw: "", escaped: false };
      return;
    }
    if (c === "{") {
      this.stack.push({ kind: "object", path, map: {}, key: null, phase: "key" });
      return;
    }
    if (c === "[") {
      this.stack.push({ kind: "array", path, items: [] });
      return;
    }
    if (c === "-" || isDigit(c)) {
      this.value = { kind: "number", path, raw: c };
      return;
    }
    if (c === "t" || c === "f" || c === "n") {
      this.value = { kind: "literal", path, raw: c };
      return;
    }
    throw new Error(`JSON: unexpected value start ${JSON.stringify(c)} at path [${path.join(".")}]`);
  }

  private feedValue(c: string): boolean {
    const v = this.value!;
    switch (v.kind) {
      case "string": {
        if (c === "\\") {
          v.raw += c;
          v.escaped = !v.escaped;
          return true;
        }
        if (c === '"' && !v.escaped) {
          this.value = null;
          this.completeValue(v.path, decodeJsonString(v.raw));
          return true;
        }
        v.raw += c;
        v.escaped = false;
        return true;
      }
      case "number": {
        if (isDigit(c) || c === "-" || c === "+" || c === "." || c === "e" || c === "E") {
          v.raw += c;
          return true;
        }
        const n = Number(v.raw);
        if (Number.isNaN(n)) throw new Error(`JSON: invalid number ${JSON.stringify(v.raw)}`);
        this.value = null;
        this.completeValue(v.path, n);
        return false; // reprocess the terminator
      }
      case "literal": {
        if (isTerminator(c) && isCompleteLiteral(v.raw)) {
          const value = v.raw === "true" ? true : v.raw === "false" ? false : null;
          this.value = null;
          this.completeValue(v.path, value);
          return false; // reprocess the terminator
        }
        const text = v.raw + c;
        if (isLiteralPrefix(text)) {
          v.raw = text;
          return true;
        }
        throw new Error(`JSON: invalid literal ${JSON.stringify(text)}`);
      }
    }
  }

  private completeValue(path: string[], value: JsonValue): void {
    const top = this.stack[this.stack.length - 1]!;
    if (top.kind === "object" && top.phase === "key") {
      // The completed string was an object key, not a value.
      if (typeof value !== "string") throw new Error("JSON: object key must be a string");
      top.key = value;
      top.phase = "colon";
      return;
    }
    this.onValueDone(path, value);
    if (top.kind === "object") {
      if (top.phase !== "value" || top.key === null) {
        throw new Error(`JSON: unexpected value position at path [${path.join(".")}]`);
      }
      top.map[top.key] = value;
      top.key = null;
      top.phase = "key";
    } else {
      top.items.push(value);
    }
  }

  private closeContainer(ctx: ObjectCtx | ArrayCtx): void {
    const value: JsonValue = ctx.kind === "object" ? ctx.map : ctx.items;
    const path = ctx.path;
    this.stack.pop();
    if (this.stack.length === 0) {
      this.done = true;
      this.onValueDone(path, value);
      return;
    }
    this.completeValue(path, value);
  }
}

/** Decode the raw content of a JSON string literal (escapes and \uXXXX). */
function decodeJsonString(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c !== "\\") {
      out += c;
      continue;
    }
    i++;
    const esc = raw[i];
    if (esc === undefined) throw new Error("JSON: unterminated escape");
    switch (esc) {
      case '"': out += '"'; break;
      case "\\": out += "\\"; break;
      case "/": out += "/"; break;
      case "b": out += "\b"; break;
      case "f": out += "\f"; break;
      case "n": out += "\n"; break;
      case "r": out += "\r"; break;
      case "t": out += "\t"; break;
      case "u": {
        const hex = raw.slice(i + 1, i + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error("JSON: invalid \\u escape");
        const code = parseInt(hex, 16);
        // Combine surrogate pairs (\uD83D\uDE00 → 😀).
        if (code >= 0xd800 && code <= 0xdbff) {
          const low = /^\\u([0-9a-fA-F]{4})/.exec(raw.slice(i + 5));
          const lowCode = low ? parseInt(low[1]!, 16) : -1;
          if (lowCode >= 0xdc00 && lowCode <= 0xdfff) {
            out += String.fromCharCode(code, lowCode);
            i += 10;
            break;
          }
        }
        out += String.fromCharCode(code);
        i += 4;
        break;
      }
      default:
        throw new Error(`JSON: invalid escape \\${esc}`);
    }
  }
  return out;
}

function isWhitespace(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r";
}

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

function isTerminator(c: string): boolean {
  return isWhitespace(c) || c === "," || c === "}" || c === "]";
}

function isCompleteLiteral(text: string): boolean {
  return text === "true" || text === "false" || text === "null";
}

function isLiteralPrefix(text: string): boolean {
  return (
    "true".startsWith(text) || "false".startsWith(text) || "null".startsWith(text)
  );
}

// ---------------------------------------------------------------------------
// Schema-aware adapter: JSON values → StreamObject field-completion events
// ---------------------------------------------------------------------------

export interface JsonAdapterCallbacks {
  onFieldDone?: (field: number, value: FieldValue) => void;
  /** Fires for each completed array element, before the array field completes. */
  onItemDone?: (field: number, index: number, value: ScalarValue) => void;
  /** Fires when the root object closes. */
  onObjectDone?: () => void;
}

/**
 * Feeds a JSON token stream into the reference Event model and emits a
 * completion hierarchy as soon as each piece is known:
 *
 *   VALUE_COMPLETE  → every parsed value (parser level, per path)
 *   ITEM_COMPLETE   → each array element of an array-typed schema field
 *   FIELD_COMPLETE  → a schema field's whole value (incl. a closed array)
 *   OBJECT_COMPLETE → the object closed
 *
 * The v0.1 wire decoder only exposes FIELD/OBJECT; item completion is a
 * semantic projection of array boundaries that every source already carries
 * (each JSON array element, each array append), not a wire record. Strictly
 * typed against the schema — a value that violates its field type throws.
 */
export class JsonToStreamObjectAdapter {
  private readonly fields: Array<{ def: FieldDef; pathKey: string }>;
  private readonly parser: IncrementalJsonParser;
  private readonly events: Event[] = [];
  private readonly onFieldDone: ((field: number, value: FieldValue) => void) | undefined;
  private readonly onItemDone: ((field: number, index: number, value: ScalarValue) => void) | undefined;
  private readonly onObjectDone: (() => void) | undefined;

  constructor(schema: Schema, callbacks: JsonAdapterCallbacks = {}) {
    this.fields = schema.map((def, field) => ({ def, pathKey: def.path.join(".") }));
    this.onFieldDone = callbacks.onFieldDone;
    this.onItemDone = callbacks.onItemDone;
    this.onObjectDone = callbacks.onObjectDone;
    this.parser = new IncrementalJsonParser((path, value) => this.handleValue(path, value));
  }

  push(chunk: string): void {
    this.parser.push(chunk);
  }

  getEvents(): Event[] {
    return this.events;
  }

  private handleValue(path: string[], value: JsonValue): void {
    const pathKey = path.join(".");
    if (pathKey === "") {
      // The root object closed.
      this.events.push({ kind: "object-complete" });
      this.onObjectDone?.();
      return;
    }
    const index = this.fields.findIndex((f) => f.pathKey === pathKey);
    if (index !== -1) {
      // Whole field value (a scalar, or the completed array).
      const fieldValue = coerceToField(this.fields[index]!.def, value);
      const event: Event = { kind: "field", field: index, value: fieldValue };
      this.events.push(event);
      this.onFieldDone?.(index, fieldValue);
      return;
    }
    // Array element: path = fieldPath + numeric segment, field is array mode.
    if (Array.isArray(value) || (typeof value === "object" && value !== null)) return;
    const itemField = this.matchArrayItem(path);
    if (itemField === -1) return;
    const def = this.fields[itemField]!.def;
    const item = coerceScalar(def.type, value, def.path.join("."));
    const itemIndex = Number(path[path.length - 1]);
    const itemEvent: Event = { kind: "item", field: itemField, index: itemIndex, value: item };
    this.events.push(itemEvent);
    this.onItemDone?.(itemField, itemIndex, item);
  }

  private matchArrayItem(path: string[]): number {
    if (path.length < 2) return -1;
    const last = path[path.length - 1]!;
    if (!/^\d+$/.test(last)) return -1;
    const parentKey = path.slice(0, -1).join(".");
    const index = this.fields.findIndex((f) => f.pathKey === parentKey);
    if (index === -1 || this.fields[index]!.def.mode !== "array") return -1;
    return index;
  }
}

function coerceToField(def: FieldDef, value: JsonValue): FieldValue {
  if (def.mode === "array") {
    if (!Array.isArray(value)) {
      throw new Error(`field ${def.path.join(".")}: expected array, got ${JSON.stringify(value)}`);
    }
    return value.map((item) => coerceScalar(def.type, item, def.path.join(".")));
  }
  return coerceScalar(def.type, value, def.path.join("."));
}

function coerceScalar(type: FieldType, value: JsonValue, label: string): ScalarValue {
  switch (type) {
    case "string":
      if (typeof value !== "string") {
        throw new Error(`field ${label}: expected string, got ${JSON.stringify(value)}`);
      }
      return value;
    case "integer":
      if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw new Error(`field ${label}: expected integer, got ${JSON.stringify(value)}`);
      }
      return value;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`field ${label}: expected number, got ${JSON.stringify(value)}`);
      }
      return value;
    case "boolean":
      if (typeof value !== "boolean") {
        throw new Error(`field ${label}: expected boolean, got ${JSON.stringify(value)}`);
      }
      return value;
  }
}
