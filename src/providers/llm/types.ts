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
