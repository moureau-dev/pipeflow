import type {
  LLM,
  LLMEvent,
  LLMMessage,
  LLMRequest,
  LLMStreamTimingCallback,
  LLMUsageCallback,
} from "../../types";
import type { FetchLike } from "../../../shared";

export interface ClaudeOptions {
  apiKey: string;
  /** Defaults to `claude-sonnet-4-5`. */
  model?: string;
  /** Defaults to `https://api.anthropic.com/v1`. */
  baseUrl?: string;
  /** Injectable fetch implementation, mainly for tests. */
  fetch?: FetchLike;
  /** Provider-timeline hook: request-start / headers / first-chunk. */
  onTiming?: LLMStreamTimingCallback;
  /**
   * Abort a stream that delivers no data for this long (default 8000ms) —
   * protects against provider connections that go silent after the model
   * already produced its output. Raise it for providers with slow TTFT.
   */
  idleTimeoutMs?: number;
  /** Called with the provider-reported token usage (when included). */
  onUsage?: LLMUsageCallback;
}

/** An SSE frame: the `event:` type plus the parsed `data:` payload. */
interface ClaudeEvent {
  event: string;
  data: Record<string, unknown>;
}

/**
 * Claude LLM adapter (Anthropic Messages API over SSE).
 *
 * The wire format differs from the OpenAI-compatible adapters: tools are
 * `input_schema` blocks, tool calls arrive as `tool_use` content blocks with
 * `input_json_delta` fragments (reassembled here into `tool_call` events),
 * tool results are `tool_result` blocks inside user messages, and `max_tokens`
 * is required. There is no `response_format`, so `toolMode` is not supported —
 * tool calling is always native.
 */
export class ClaudeLLM implements LLM {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly onTiming: LLMStreamTimingCallback | undefined;
  private readonly idleTimeoutMs: number;
  private readonly onUsage: LLMUsageCallback | undefined;
  private readonly streams = new Set<AbortController>();

  constructor(options: ClaudeOptions) {
    if (!options.apiKey) {
      throw new Error("ClaudeLLM requires an apiKey");
    }
    this.apiKey = options.apiKey;
    this.model = options.model ?? "claude-sonnet-4-5";
    this.baseUrl = (options.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
    this.onTiming = options.onTiming;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 8_000;
    this.onUsage = options.onUsage;
  }

  /** Cancel every in-flight stream (parallel sub-generations included). */
  stop(): void {
    for (const controller of this.streams) controller.abort();
  }

  async *stream(request: LLMRequest): AsyncGenerator<LLMEvent> {
    const controller = new AbortController();
    this.streams.add(controller);

    try {
      const { system, wire } = mapMessages(request.messages);

      this.onTiming?.("request-start");
      const response = await this.fetchImpl(`${this.baseUrl}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.model,
          // Required by the Anthropic API.
          max_tokens: request.maxTokens ?? 4096,
          ...(system.length > 0 ? { system } : {}),
          messages: wire,
          ...(request.tools && request.tools.length > 0
            ? {
                tools: request.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  input_schema: tool.parameters ?? { type: "object", properties: {} },
                })),
              }
            : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Claude request failed (${response.status}): ${body}`);
      }
      if (!response.body) {
        throw new Error("Claude returned an empty body");
      }
      this.onTiming?.("headers");

      // Tool_use blocks can interleave and complete in any order; keyed by
      // block index. Arguments arrive as `input_json_delta` fragments.
      const toolBlocks = new Map<
        number,
        { id: string; name: string; json: string }
      >();
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      let finished = false;

      for await (const frame of readClaudeSSE(
        response.body,
        controller.signal,
        this.onTiming,
        this.idleTimeoutMs,
      )) {
        switch (frame.event) {
          case "message_start": {
            const usage = frame.data.message as { usage?: { input_tokens?: number } };
            inputTokens = usage?.usage?.input_tokens;
            break;
          }
          case "content_block_start": {
            const block = frame.data.content_block as {
              type: string;
              id?: string;
              name?: string;
            };
            if (block.type === "tool_use" && block.id && block.name) {
              toolBlocks.set(frame.data.index as number, {
                id: block.id,
                name: block.name,
                json: "",
              });
            }
            break;
          }
          case "content_block_delta": {
            const delta = frame.data.delta as { type: string; text?: string; partial_json?: string };
            if (delta.type === "text_delta" && delta.text) {
              yield { type: "delta", content: delta.text };
            } else if (delta.type === "input_json_delta" && delta.partial_json) {
              const block = toolBlocks.get(frame.data.index as number);
              if (block) block.json += delta.partial_json;
            }
            break;
          }
          case "content_block_stop": {
            const block = toolBlocks.get(frame.data.index as number);
            if (block) {
              let args = "{}";
              if (block.json.length > 0) {
                try {
                  args = block.json;
                  JSON.parse(args); // validate before handing off
                } catch {
                  args = "{}";
                }
              }
              yield {
                type: "tool_call",
                id: block.id,
                name: block.name,
                arguments: args,
              };
              toolBlocks.delete(frame.data.index as number);
            }
            break;
          }
          case "message_delta": {
            const usage = frame.data.usage as { output_tokens?: number };
            if (usage?.output_tokens !== undefined) outputTokens = usage.output_tokens;
            break;
          }
          case "message_stop":
            if (inputTokens !== undefined || outputTokens !== undefined) {
              this.onUsage?.({
                promptTokens: inputTokens ?? 0,
                completionTokens: outputTokens ?? 0,
              });
            }
            finished = true;
            break;
          case "error": {
            const error = frame.data.error as { message?: string } | undefined;
            yield {
              type: "error",
              error: new Error(
                `Claude stream error: ${error?.message ?? JSON.stringify(frame.data)}`,
              ),
            };
            finished = true;
            break;
          }
        }
        if (finished) break;
      }
    } finally {
      this.streams.delete(controller);
    }

    yield { type: "done" };
  }
}

/** Anthropic messages: leading system messages become `system`; the rest map to wire roles. */
function mapMessages(messages: LLMMessage[]): { system: string; wire: unknown[] } {
  const system: string[] = [];
  const wire: unknown[] = [];
  for (const message of messages) {
    switch (message.role) {
      case "system":
        system.push(message.content);
        break;
      case "user":
        wire.push({ role: "user", content: message.content });
        break;
      case "assistant": {
        const blocks: unknown[] = [];
        if (message.content) blocks.push({ type: "text", text: message.content });
        for (const call of message.toolCalls ?? []) {
          let input: unknown = {};
          try {
            input = JSON.parse(call.arguments);
          } catch {
            input = {};
          }
          blocks.push({ type: "tool_use", id: call.id, name: call.name, input });
        }
        wire.push({ role: "assistant", content: blocks });
        break;
      }
      case "tool":
        wire.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: message.toolCallId,
              content: message.content,
            },
          ],
        });
        break;
    }
  }
  return { system: system.join("\n\n"), wire };
}

/**
 * Parse the Anthropic SSE stream into `{ event, data }` frames. Unlike the
 * OpenAI-compatible streamer, the `event:` line matters — it distinguishes
 * text deltas from tool-argument deltas. Bounded by the idle timeout.
 */
async function* readClaudeSSE(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onTiming: LLMStreamTimingCallback | undefined,
  idleTimeoutMs: number,
): AsyncGenerator<ClaudeEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let firstEvent = false;

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
        void reader.cancel().catch(() => {});
        reject(
          new Error(
            `Claude stream idle for ${idleTimeoutMs}ms — no data received; aborting the stalled stream`,
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
      if (!firstEvent) {
        firstEvent = true;
        onTiming?.("first-chunk");
      }
      let event = "";
      const dataLines: string[] = [];
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length === 0) continue;
      try {
        yield { event, data: JSON.parse(dataLines.join("\n")) as Record<string, unknown> };
      } catch {
        // Ignore malformed frames.
      }
    }
  }
}
