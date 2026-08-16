import type { LLM, LLMEvent, LLMRequest } from "../../types";
import type { FetchLike } from "../../../shared";

export interface DeepSeekOptions {
  apiKey: string;
  /** Defaults to `deepseek-chat`. */
  model?: string;
  /** Defaults to `https://api.deepseek.com`. */
  baseUrl?: string;
  /** Injectable fetch implementation, mainly for tests. */
  fetch?: FetchLike;
}

interface DeepSeekDeltaToolCall {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface DeepSeekChunk {
  choices?: Array<{
    delta?: { content?: string | null; tool_calls?: DeepSeekDeltaToolCall[] };
    finish_reason?: string | null;
  }>;
}

/**
 * DeepSeek LLM adapter (OpenAI-compatible chat completions over SSE).
 */
export class DeepSeekLLM implements LLM {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly streams = new Set<AbortController>();

  constructor(options: DeepSeekOptions) {
    if (!options.apiKey) {
      throw new Error("DeepSeekLLM requires an apiKey");
    }
    this.apiKey = options.apiKey;
    this.model = options.model ?? "deepseek-chat";
    this.baseUrl = (options.baseUrl ?? "https://api.deepseek.com").replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** Cancel every in-flight stream (parallel sub-generations included). */
  stop(): void {
    for (const controller of this.streams) controller.abort();
  }

  async *stream(request: LLMRequest): AsyncGenerator<LLMEvent> {
    // Multiple generations can stream concurrently (e.g. delegated
    // sub-agents); each gets its own controller, and stop() aborts them all.
    const controller = new AbortController();
    this.streams.add(controller);

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          // LLMMessage uses camelCase; the wire format is snake_case.
          messages: request.messages.map((message) => {
            const wire: Record<string, unknown> = {
              role: message.role,
              content: message.content,
            };
            if (message.name) wire.name = message.name;
            if (message.toolCallId) wire.tool_call_id = message.toolCallId;
            if (message.toolCalls) {
              wire.tool_calls = message.toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: call.arguments },
              }));
            }
            return wire;
          }),
          ...(request.tools && request.tools.length > 0
            ? { tools: request.tools.map((tool) => ({ type: "function", function: tool })) }
            : {}),
          // Reasoning models default to enabled thinking; disable it so the
          // adapter behaves uniformly on deepseek-chat.
          thinking: { type: "disabled" },
          stream: true,
          temperature: request.temperature,
          max_tokens: request.maxTokens,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`DeepSeek request failed (${response.status}): ${body}`);
      }
      if (!response.body) {
        throw new Error("DeepSeek returned an empty body");
      }

      // Tool calls arrive fragmented across chunks and are reassembled by
      // index before being emitted once the stream signals `tool_calls`.
      const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();

      for await (const chunk of parseSSE(response.body, controller.signal)) {
        const choice = chunk.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta;
        if (delta?.content) {
          yield { type: "delta", content: delta.content };
        }

        for (const tc of delta?.tool_calls ?? []) {
          const index = tc.index ?? 0;
          const accumulated = toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
          if (tc.id) accumulated.id = tc.id;
          if (tc.function?.name) accumulated.name += tc.function.name;
          if (tc.function?.arguments) accumulated.arguments += tc.function.arguments;
          toolCalls.set(index, accumulated);
        }

        if (choice.finish_reason === "tool_calls") {
          for (const call of toolCalls.values()) {
            yield {
              type: "tool_call",
              id: call.id,
              name: call.name,
              arguments: call.arguments,
            };
          }
          break;
        }
        if (choice.finish_reason === "stop") {
          break;
        }
      }

      yield { type: "done" };
    } finally {
      this.streams.delete(controller);
    }
  }
}

/**
 * Parse an SSE byte stream into JSON events. Supports both LF and CRLF
 * framing, ignores comments and malformed frames, and stops at `[DONE]`.
 * Aborts with an `AbortError` once the signal fires.
 */
async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<DeepSeekChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    if (signal.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      for (const line of frame.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          yield JSON.parse(data) as DeepSeekChunk;
        } catch {
          // Ignore malformed frames.
        }
      }
    }
  }
}
