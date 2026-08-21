import type {
  LLMEvent,
  LLMRequest,
  LLMToolDefinition,
  LLMStreamTimingCallback,
  LLMUsageCallback,
  ToolMode,
} from "../types";
import type { FetchLike } from "../../shared";

interface DeltaToolCall {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface ChatCompletionChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: DeltaToolCall[];
      // OpenRouter normalizes reasoning tokens to `reasoning`; DeepSeek uses
      // `reasoning_content`. Both are surfaced on the delta event.
      reasoning?: string | null;
      reasoning_content?: string | null;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  /** Provider failure delivered as an SSE data chunk (no choices). */
  error?: { code?: number | string; message?: string };
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
   * Default tool encoding for requests that do not set `toolMode`
   * themselves (the request's `toolMode` wins when present). Useful for
   * models whose endpoints lack native tool calling.
   */
  toolMode?: ToolMode;
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
 * JSON schema for the `envelope`/`prompted` tool modes: the model answers
 * either directly (`answer`) or with a list of tool calls (`calls`). The
 * adapter turns the parsed envelope back into the standard `LLMEvent`
 * surface, so consumers never see the envelope format.
 *
 * The `arguments` of each call carry a per-tool `oneOf` of the tools' own
 * parameter schemas (index-aligned with the `name` enum), so the model sees
 * the same argument contract it would in native mode — without the native
 * tool-calling endpoint.
 */
function buildEnvelopeSchema(tools: LLMToolDefinition[]): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      answer: {
        type: "string",
        description: "Your spoken reply when no tool call is needed.",
      },
      calls: {
        type: "array",
        description: "The tool calls to execute, when the request needs tools.",
        items: {
          type: "object",
          properties: {
            name: {
              type: "string",
              enum: tools.map((tool) => tool.name),
            },
            arguments: {
              description: "The arguments for the named tool, per its schema.",
              oneOf: tools.map((tool) => tool.parameters ?? { type: "object" }),
            },
          },
          required: ["name", "arguments"],
          additionalProperties: false,
        },
      },
    },
  };
}

/** Instruction appended to the last user message in `prompted` mode. */
function promptedEnvelopeInstruction(tools: LLMToolDefinition[]): string {
  return (
    "Respond with ONLY valid JSON matching this schema, with no prose and no markdown fences:\n" +
    JSON.stringify(buildEnvelopeSchema(tools)) +
    '\nThe JSON must be either {"answer": "..."} or {"calls": [{"name": "...", "arguments": {...}}]}.'
  );
}

/**
 * Fallback extraction for prompted mode: strip markdown fences and keep the
 * outermost JSON object, rescuing models that wrap or preface the envelope
 * despite the instruction (the endpoint guarantees nothing without
 * `response_format`).
 */
function extractEnvelope(raw: string): string | null {
  const stripped = raw
    .replace(/```(?:json)?/gi, "")
    .replace(/^[^{]*/, "")
    .replace(/[^}]*$/, "");
  if (stripped.length === 0) return null;
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return stripped.slice(start, end + 1);
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
  // Precedence: the per-request override wins, then the adapter default, then
  // native.
  const toolMode = request.toolMode ?? params.toolMode ?? "native";
  const usesEnvelope = toolMode !== "native" && (request.tools?.length ?? 0) > 0;
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
      messages: request.messages.map((message, index, all) => {
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
        if (toolMode === "prompted" && usesEnvelope && index === all.length - 1) {
          // The only way to constrain output without provider support: ask
          // the model directly, and parse/validate the result ourselves.
          wire.content = `${message.content}\n\n${promptedEnvelopeInstruction(request.tools!)}`;
        }
        return wire;
      }),
      // Envelope modes hide the tools from the provider and encode them in a
      // schema the model must emit as JSON; native mode uses the provider's
      // own tool-calling contract.
      ...(!usesEnvelope && request.tools && request.tools.length > 0
        ? { tools: request.tools.map((tool) => ({ type: "function", function: tool })) }
        : {}),
      ...(usesEnvelope && toolMode === "envelope"
        ? {
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "tool_envelope",
                strict: false,
                schema: buildEnvelopeSchema(request.tools!),
              },
            },
          }
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
  // Envelope modes buffer the model's JSON and translate it into events at
  // the end of the stream (the JSON is not speech and cannot be acted on
  // until it is complete).
  let envelopeContent = "";

  for await (const chunk of parseSSE(response.body, signal, onTiming, idleTimeoutMs, label)) {
    const choice = chunk.choices?.[0];

    if (chunk.error) {
      // Some providers (e.g. Bedrock via OpenRouter) abort mid-stream and
      // deliver the failure as an SSE chunk with no choices. Surface it
      // instead of silently swallowing it into a confusing empty stream.
      yield {
        type: "error",
        error: new Error(
          `${label} provider aborted the stream: ${chunk.error.message ?? JSON.stringify(chunk.error)}`,
        ),
      };
      break;
    }

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
    const content = delta?.content ?? "";
    // Thinking models stream reasoning before content; emit it so consumers
    // can measure thinking time (and optionally surface it). Reasoning-only
    // chunks carry empty content.
    const reasoning = (delta?.reasoning ?? delta?.reasoning_content) ?? "";
    if (usesEnvelope) {
      envelopeContent += content;
    } else if (content.length > 0 || reasoning.length > 0) {
      yield {
        type: "delta",
        content,
        ...(reasoning.length > 0 ? { reasoning } : {}),
      };
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

  if (usesEnvelope) {
    let envelope:
      | { answer?: unknown; calls?: Array<{ name?: unknown; arguments?: unknown }> }
      | undefined;
    try {
      envelope = JSON.parse(envelopeContent);
    } catch {
      // Prompted mode has no endpoint guarantee: the model may wrap the JSON
      // in fences or preface it with prose. Retry with extraction before
      // failing the stream.
      const extracted = extractEnvelope(envelopeContent);
      if (extracted !== null) {
        try {
          envelope = JSON.parse(extracted);
        } catch {
          envelope = undefined;
        }
      }
    }
    if (envelope === undefined) {
      yield {
        type: "error",
        error: new Error(
          `${label} ${toolMode} tool mode: model did not return a JSON envelope (${envelopeContent.slice(0, 120)})`,
        ),
      };
    } else {
      if (typeof envelope.answer === "string" && envelope.answer.length > 0) {
        yield { type: "delta", content: envelope.answer };
      }
      for (const call of envelope.calls ?? []) {
        if (typeof call.name !== "string") continue;
        // Envelope mode has no provider-assigned call ids; synthesize them so
        // consumers can match results to calls (id uniqueness is the contract).
        yield {
          type: "tool_call",
          id: crypto.randomUUID(),
          name: call.name,
          arguments: JSON.stringify(call.arguments ?? {}),
        };
      }
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
