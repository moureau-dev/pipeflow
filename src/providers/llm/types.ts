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

/**
 * How tool calls are encoded on the wire.
 *
 * - `native` (default) — the provider's tool-calling contract: `tools` in
 *   the request, `tool_calls` in the stream.
 * - `envelope` — no `tools`; `response_format` forces the model to emit a
 *   JSON envelope (`{ answer?, calls: [{ name, arguments }] }`) that the
 *   adapter translates back into `tool_call` events. For models whose
 *   endpoints support structured outputs but not native tool calling.
 * - `prompted` — no `tools`; the same envelope is requested by appending an
 *   instruction to the last user message. The universal fallback: works on
 *   any chat model, at the cost of extraction/repair and higher token use.
 */
export type ToolMode = "native" | "envelope" | "prompted";

export interface LLMRequest {
  messages: LLMMessage[];
  tools?: LLMToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  /** How tools are encoded on the wire. Default `native`. */
  toolMode?: ToolMode;
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
  | {
      type: "delta";
      content: string;
      /**
       * Reasoning/thinking tokens, when the provider streams them separately
       * from content (OpenRouter `reasoning`, DeepSeek `reasoning_content`).
       * Omitted when the model does not emit reasoning.
       */
      reasoning?: string;
    }
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
