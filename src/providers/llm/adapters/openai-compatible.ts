import type {
  LLMEvent,
  LLMRequest,
  LLMStreamTimingCallback,
  LLMUsageCallback,
} from "../types";
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
  usage?: { prompt_tokens?: number; completion_tokens?: number };
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
  /** Optional provider-timeline hook (see `LLMStreamTimingPoint`). */
  onTiming?: LLMStreamTimingCallback;
  /**
   * Abort the stream if no data arrives for this long (default 8000ms).
   * Protects against providers whose connection goes silent after the model
   * has already produced its output (e.g. a tool call that is never followed
   * by a terminating frame).
   */
  idleTimeoutMs?: number;
  /**
   * Called with the provider-reported token usage when the stream includes
   * it (OpenRouter sends usage in the final chunk).
   */
  onUsage?: LLMUsageCallback;
}

/**
 * Stream a request through any OpenAI-compatible `/chat/completions`
 * endpoint, reassembling fragmented tool calls and normalizing the SSE
 * stream into `LLMEvent`s. Shared by the DeepSeek and OpenRouter adapters.
 */
export async function* openAICompatibleStream(
  params: OpenAICompatibleStreamParams,
): AsyncGenerator<LLMEvent> {
  const {
    baseUrl,
    apiKey,
    model,
    fetchImpl,
    request,
    signal,
    extraHeaders,
    extraBody,
    label,
    onTiming,
    idleTimeoutMs,
    onUsage,
  } = params;

  onTiming?.("request-start");
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
      // Ask the provider to include usage in the final chunk so token
      // accounting (and latency-vs-tokens curves) are possible.
      stream_options: { include_usage: true },
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
  onTiming?.("headers");

  // Tool calls arrive fragmented across chunks and are reassembled by
  // index before being emitted once the stream signals `tool_calls`.
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  // After the content finishes (finish_reason), keep reading briefly so the
  // provider-reported usage chunk — which arrives right after — is captured.
  let contentFinished = false;
  let finishAt = 0;
  let sawUsage = false;
  let toolCallsEmitted = false;

  for await (const chunk of parseSSE(response.body, signal, onTiming, idleTimeoutMs, label)) {
    const choice = chunk.choices?.[0];

    if (chunk.usage && (chunk.usage.prompt_tokens ?? 0) > 0) {
      sawUsage = true;
      finishAt = 0;
      onUsage?.({
        promptTokens: chunk.usage.prompt_tokens ?? 0,
        completionTokens: chunk.usage.completion_tokens ?? 0,
      });
    }
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

    if (choice.finish_reason === "tool_calls" && !toolCallsEmitted) {
      for (const call of toolCalls.values()) {
        yield {
          type: "tool_call",
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        };
      }
      toolCallsEmitted = true;
      contentFinished = true;
    } else if (choice.finish_reason === "stop") {
      contentFinished = true;
    } else if (choice.finish_reason === "error" || choice.finish_reason === "content_filter") {
      // Some providers (e.g. gemini models via OpenRouter) return HTTP 200
      // with an empty body and finish_reason "error"/"content_filter"
      // instead of a real failure. Surface it as an error event rather than
      // silently completing with an empty generation.
      yield {
        type: "error",
        error: new Error(
          `${label} stream finished with "${choice.finish_reason}"` +
            (toolCalls.size > 0 ? "" : " and produced no output"),
        ),
      };
      break;
    }

    if (contentFinished) {
      if (sawUsage) break; // usage captured — no need to wait for [DONE]
      if (finishAt === 0) finishAt = Date.now();
      // Grace for providers that send finish_reason but never [DONE] or
      // usage: proceed after a short wait instead of stalling the run.
      if (Date.now() - finishAt > 500) break;
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
  onTiming?: LLMStreamTimingCallback,
  idleTimeoutMs = 8_000,
  label = "LLM",
): AsyncGenerator<ChatCompletionChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let firstChunkEmitted = false;

  // `reader.read()` bounded by an idle timeout: if no bytes arrive within
  // `idleTimeoutMs`, cancel the connection and fail the stream. Only bytes
  // reset the timer — a connection that stays open but silent still trips it.
  const readWithTimeout = (): Promise<Awaited<ReturnType<typeof reader.read>>> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        cleanup();
        reject(new DOMException("The operation was aborted.", "AbortError"));
      };
      reader.read().then(
        (result) => {
          cleanup();
          resolve(result);
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
      timer = setTimeout(() => {
        cleanup();
        // Cancel the reader so the underlying connection is actually closed.
        void reader.cancel().catch(() => {});
        reject(
          new Error(
            `${label} stream idle for ${idleTimeoutMs}ms — no data received; aborting the stalled stream`,
          ),
        );
      }, idleTimeoutMs);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  };

  while (true) {
    if (signal.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    const { done, value } = await readWithTimeout();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      for (const line of frame.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        if (!firstChunkEmitted) {
          firstChunkEmitted = true;
          onTiming?.("first-chunk");
        }
        try {
          yield JSON.parse(data) as ChatCompletionChunk;
        } catch {
          // Ignore malformed frames.
        }
      }
    }
  }
}
