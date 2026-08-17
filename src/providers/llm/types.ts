export type LLMRole = "system" | "user" | "assistant" | "tool";

export interface LLMToolCall {
  id: string;
  name: string;
  /** JSON-encoded arguments for the tool. */
  arguments: string;
}

export interface LLMMessage {
  role: LLMRole;
  content: string;
  /** Tool name, for `tool` role messages. */
  name?: string;
  /** Tool call id this message answers, for `tool` role messages. */
  toolCallId?: string;
  /** Tool calls announced by the assistant, for `assistant` role messages. */
  toolCalls?: LLMToolCall[];
}

export interface LLMToolDefinition {
  name: string;
  description: string;
  /** JSON schema describing the tool arguments. */
  parameters: Record<string, unknown>;
}

export interface LLMRequest {
  messages: LLMMessage[];
  tools?: LLMToolDefinition[];
  temperature?: number;
  maxTokens?: number;
}

/**
 * Moments in the provider round trip that separate application delay from
 * network/queue delay from model latency. The callback is invoked
 * synchronously at each point, so `performance.now()` taken inside it is the
 * event time.
 *
 * - `request-start` — immediately before the HTTP request is issued.
 * - `headers` — the response headers arrived (2xx).
 * - `first-chunk` — the first SSE chunk was parsed.
 */
export type LLMStreamTimingPoint = "request-start" | "headers" | "first-chunk";

export type LLMStreamTimingCallback = (point: LLMStreamTimingPoint) => void;

/** Token usage reported by the provider (when it includes usage in the stream). */
export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
}

export type LLMUsageCallback = (usage: LLMUsage) => void;

export type LLMEvent =
  | { type: "delta"; content: string }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  | { type: "done" }
  | { type: "error"; error: Error };

/**
 * Vendor-independent language model interface.
 *
 * `stream()` produces deltas as they arrive plus optional tool calls, and
 * terminates with `done`. Transport-level failures (network, HTTP status)
 * are thrown from the generator rather than emitted.
 */
export interface LLM {
  stream(request: LLMRequest): AsyncGenerator<LLMEvent>;
  /** Cancel the currently in-flight generation, if any. */
  stop(): void;
}
