import type { LLMEvent, LLMRequest } from "../types";
import type { FetchLike } from "../../shared";

interface DeltaToolCall {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface ChatCompletionChunk {
  choices?: Array<{
    delta?: { content?: string | null; tool_calls?: DeltaToolCall[] };
    finish_reason?: string | null;
  }>;
}

export interface OpenAICompatibleStreamParams {
  /** Provider base URL, e.g. `https://openrouter.ai/api/v1`. */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Injectable fetch implementation, mainly for tests. */
  fetchImpl: FetchLike;
  request: LLMRequest;
  signal: AbortSignal;
  /** Extra headers merged into the request (e.g. attribution headers). */
  extraHeaders?: Record<string, string>;
  /** Extra body fields merged after the standard ones. */
  extraBody?: Record<string, unknown>;
  /** Provider name used in error messages. */
  label: string;
}

/**
 * Stream a request through any OpenAI-compatible `/chat/completions`
 * endpoint, reassembling fragmented tool calls and normalizing the SSE
 * stream into `LLMEvent`s. Shared by the DeepSeek and OpenRouter adapters.
 */
export async function* openAICompatibleStream(
  params: OpenAICompatibleStreamParams,
): AsyncGenerator<LLMEvent> {
  const { baseUrl, apiKey, model, fetchImpl, request, signal, extraHeaders, extraBody, label } =
    params;

  const response = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      ...extraHeaders,
    },
    body: JSON.stringify({
      model,
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
      stream: true,
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      ...extraBody,
    }),
    signal,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${label} request failed (${response.status}): ${body}`);
  }
  if (!response.body) {
    throw new Error(`${label} returned an empty body`);
  }

  // Tool calls arrive fragmented across chunks and are reassembled by
  // index before being emitted once the stream signals `tool_calls`.
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();

  for await (const chunk of parseSSE(response.body, signal)) {
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
}

/**
 * Parse an SSE byte stream into JSON events. Supports both LF and CRLF
 * framing, ignores comments and malformed frames, and stops at `[DONE]`.
 * Aborts with an `AbortError` once the signal fires.
 */
async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<ChatCompletionChunk> {
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
          yield JSON.parse(data) as ChatCompletionChunk;
        } catch {
          // Ignore malformed frames.
        }
      }
    }
  }
}
