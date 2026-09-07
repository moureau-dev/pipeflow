/**
 * Minimal JSON value guard for outbound messages.
 *
 * Kept narrow on purpose: server payloads carry domain types (turns,
 * transcripts, audio chunks) that aren't structurally typed as JSON values,
 * so the wire uses `unknown`. Outbound payloads, however, must serialize;
 * this guard catches values that JSON.stringify would silently drop
 * (functions, `undefined`, `bigint`).
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export function isJsonSerializable(value: unknown): boolean {
  if (value === null) return true;
  const type = typeof value;
  if (type === "string" || type === "boolean") return true;
  if (type === "number") return Number.isFinite(value as number);
  if (Array.isArray(value)) return value.every(isJsonSerializable);
  if (type === "object") {
    const record = value as Record<string, unknown>;
    return Object.values(record).every(isJsonSerializable);
  }
  return false;
}