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
  /** Internal abort signal — used by the adapter's own stop(). */
  signal: AbortSignal;
  /**
   * External per-stream abort signal. When provided alongside the internal
   * signal, the stream aborts when EITHER fires. This allows per-conversation
   * interrupt without affecting other conversations sharing the same LLM.
   */
  externalSignal?: AbortSignal;
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
    "When the user's request requires a tool, respond with ONLY valid JSON matching this " +
    "schema, with no prose and no markdown fences:\n" +
    JSON.stringify(buildEnvelopeSchema(tools)) +
    '\nThe JSON must be either {"answer": "..."} or {"calls": [{"name": "...", "arguments": {...}}]}. ' +
    "When no tool is needed, respond in plain conversational text with no JSON."
  );
}

/**
 * True when the model's output looks like a (possibly broken) JSON envelope
 * attempt rather than plain prose — used to decide whether a parse failure is
 * a garbled tool call (error) or an envelope-ignoring model that simply
 * answered (speak the text).
 */
function looksLikeJsonAttempt(content: string): boolean {
  const trimmed = content.trim();
  return (
    trimmed.startsWith("{") || trimmed.startsWith("[") || /^```(?:json)?/i.test(trimmed)
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
 * Stream-partition inline `<thinking>…</thinking>` spans out of model content.
 * Reasoning-style models (DeepSeek-R1 and distills, Qwen3, …) emit their
 * chain of thought between visible tags whenever the serving layer has no
 * native reasoning channel, and some providers prompt tags even on models
 * without native thinking. The tags are reasoning — never reply text — so
 * they are streamed out as `reasoning` (the same surface a provider
 * `reasoning`/`reasoning_content` field uses) and the surrounding text alone
 * is content. Tags can split across any chunk boundary, so trailing
 * characters that could still form a tag are held back until the next chunk.
 */
function inlineThinking() {
  const OPEN = "<thinking>";
  const CLOSE = "</thinking>";
  let buffer = "";
  let inTag = false;

  /** How many trailing chars of `text` could still begin `token`. */
  const prefixTail = (text: string, token: string): number => {
    const max = Math.min(text.length, token.length - 1);
    for (let keep = max; keep >= 1; keep--) {
      if (token.startsWith(text.slice(-keep))) return keep;
    }
    return 0;
  };

  return {
    /** Feed one content chunk; returns the text and reasoning it releases. */
    push(chunk: string): { text: string; reasoning: string } {
      let text = "";
      let reasoning = "";
      buffer += chunk;
      for (;;) {
        if (inTag) {
          const close = buffer.indexOf(CLOSE);
          if (close !== -1) {
            reasoning += buffer.slice(0, close);
            buffer = buffer.slice(close + CLOSE.length);
            inTag = false;
            continue;
          }
          const keep = prefixTail(buffer, CLOSE);
          reasoning += buffer.slice(0, buffer.length - keep);
          buffer = buffer.slice(buffer.length - keep);
          return { text, reasoning };
        }
        const open = buffer.indexOf(OPEN);
        if (open !== -1) {
          text += buffer.slice(0, open);
          buffer = buffer.slice(open + OPEN.length);
          inTag = true;
          continue;
        }
        const keep = prefixTail(buffer, OPEN);
        text += buffer.slice(0, buffer.length - keep);
        buffer = buffer.slice(buffer.length - keep);
        return { text, reasoning };
      }
    },
    /** Release whatever is still buffered once the stream ends. */
    flush(): { text: string; reasoning: string } {
      let text = "";
      let reasoning = "";
      if (inTag) {
        // Unclosed thinking (truncated stream) is reasoning, not content.
        reasoning = buffer;
      } else if (buffer.length > 0 && !OPEN.startsWith(buffer)) {
        // A tail shorter than the tag was an aborted tag start, not content.
        text = buffer;
      }
      buffer = "";
      inTag = false;
      return { text, reasoning };
    },
  };
}

/**
 * System-level tool contract for `envelope`/`prompted` modes. The envelope
 * schema itself carries only tool names + argument shapes, so without this
 * the model never sees tool descriptions or the output rule up front — which
 * invites prose, native tool-call syntax, or waffling instead of the envelope.
 */
function buildToolContract(tools: LLMToolDefinition[]): string {
  const list = tools.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n");
  return (
    "You have access to the following tools. When the user's request requires one, " +
    "respond with ONLY the tool-call JSON envelope shown in the request — no prose, " +
    "no markdown, no tool-call syntax. When no tool is needed, reply conversationally " +
    "in plain text — no JSON at all.\n\nAvailable tools:\n" +
    list
  );
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
    externalSignal,
    extraHeaders,
    extraBody,
    label,
    onTiming,
    idleTimeoutMs,
    onUsage,
  } = params;

  onTiming?.("request-start");
  const wireSignal = externalSignal ? anySignal(signal, externalSignal) : signal;
  // Precedence: the per-request override wins, then the adapter default, then
  // native.
  const toolMode = request.toolMode ?? params.toolMode ?? "native";
  const usesEnvelope = toolMode !== "native" && (request.tools?.length ?? 0) > 0;
  // In envelope modes the tools are hidden from the provider, so the model
  // never sees their descriptions (or the output rule) unless we say so.
  // Insert the contract after the caller's system messages, where formatting
  // rules belong.
  const toolContract = usesEnvelope ? buildToolContract(request.tools!) : null;
  const contractAt = request.messages.findIndex((message) => message.role !== "system");
  const insertAt = contractAt === -1 ? request.messages.length : contractAt;
  const wireMessages: Record<string, unknown>[] = [];
  request.messages.forEach((message, index, all) => {
    if (index === insertAt && toolContract !== null) {
      wireMessages.push({ role: "system", content: toolContract });
    }
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
    wireMessages.push(wire);
  });
  if (insertAt === request.messages.length && toolContract !== null) {
    wireMessages.push({ role: "system", content: toolContract });
  }
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
      messages: wireMessages,
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
    signal: wireSignal,
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
  // Reasoning models sometimes stream their chain of thought as inline
  // `<thinking>` tags instead of a native reasoning field; strip them out of
  // content and surface them as `reasoning` (stateful across chunk splits).
  const thinking = inlineThinking();

  for await (const chunk of parseSSE(response.body, wireSignal, onTiming, idleTimeoutMs, label)) {
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
    // Strip inline `<thinking>` blocks out of the content (they are the
    // model's reasoning, not the reply); the stripped text rides on the same
    // `reasoning` surface as a provider reasoning field, which consumers can
    // measure or display but is never spoken or written into the reply.
    const partition = thinking.push(delta?.content ?? "");
    const providerReasoning = (delta?.reasoning ?? delta?.reasoning_content) ?? "";
    const reasoning = providerReasoning + partition.reasoning;
    if (usesEnvelope) {
      envelopeContent += partition.text;
    } else if (partition.text.length > 0 || reasoning.length > 0) {
      yield {
        type: "delta",
        content: partition.text,
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

  // Anything left in the thinking partitioner once the stream ends: unclosed
  // reasoning is dropped (never content), and an aborted tag start is dropped
  // too. Real trailing content is flushed here.
  const tail = thinking.flush();
  if (tail.text) {
    if (usesEnvelope) envelopeContent += tail.text;
    else yield { type: "delta", content: tail.text };
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
      if (envelope === undefined) {
        // Some providers drop the opening bytes of the stream (observed with
        // llama-4-scout via OpenRouter): the content starts mid-object but
        // closes cleanly. Prepend the brace and retry.
        try {
          envelope = JSON.parse(`{${envelopeContent}`);
        } catch {
          envelope = undefined;
        }
      }
    }
    if (envelope === undefined) {
      // Prompted mode has no endpoint guarantee (`envelope` mode's
      // response_format enforces JSON). Smaller chat models often ignore the
      // envelope instruction and reply in plain prose — that is still a valid
      // reply, so speak it as the model's `answer` instead of failing the
      // turn with a technical error. Only output that looks like a (broken)
      // JSON attempt keeps the loud error, so a truncated envelope is never
      // spoken as garbage.
      if (toolMode === "prompted" && !looksLikeJsonAttempt(envelopeContent)) {
        const answer = envelopeContent.trim();
        if (answer.length > 0) yield { type: "delta", content: answer };
      } else {
        yield {
          type: "error",
          error: new Error(
            `${label} ${toolMode} tool mode: model did not return a JSON envelope (${envelopeContent.slice(0, 120)})`,
          ),
        };
      }
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
 * Aborts with an `AbortError` once any of the signals fires.
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

/**
 * Combine multiple AbortSignals into one: the returned signal fires when
 * ANY of the source signals fire. Avoids allocating a controller when there
 * is only one signal.
 */
export function anySignal(...signals: AbortSignal[]): AbortSignal {
  if (signals.length === 1) return signals[0]!;
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}
