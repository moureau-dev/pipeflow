import type {
  LLM,
  LLMEvent,
  LLMRequest,
  LLMStreamTimingCallback,
  LLMUsageCallback,
} from "../../types";
import type { FetchLike } from "../../../shared";
import { openAICompatibleStream } from "../openai-compatible";

export interface DeepSeekOptions {
  apiKey: string;
  /** Defaults to `deepseek-chat`. */
  model?: string;
  /** Defaults to `https://api.deepseek.com`. */
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

/**
 * DeepSeek LLM adapter (OpenAI-compatible chat completions over SSE).
 */
export class DeepSeekLLM implements LLM {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly onTiming: LLMStreamTimingCallback | undefined;
  private readonly idleTimeoutMs: number;
  private readonly onUsage: LLMUsageCallback | undefined;
  private readonly streams = new Set<AbortController>();

  constructor(options: DeepSeekOptions) {
    if (!options.apiKey) {
      throw new Error("DeepSeekLLM requires an apiKey");
    }
    this.apiKey = options.apiKey;
    this.model = options.model ?? "deepseek-chat";
    this.baseUrl = (options.baseUrl ?? "https://api.deepseek.com").replace(/\/+$/, "");
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
    // Multiple generations can stream concurrently (e.g. delegated
    // sub-agents); each gets its own controller, and stop() aborts them all.
    const controller = new AbortController();
    this.streams.add(controller);

    try {
      yield* openAICompatibleStream({
        baseUrl: this.baseUrl,
        apiKey: this.apiKey,
        model: this.model,
        fetchImpl: this.fetchImpl,
        request,
        signal: controller.signal,
        // Reasoning models default to enabled thinking; disable it so the
        // adapter behaves uniformly on deepseek-chat.
        extraBody: { thinking: { type: "disabled" } },
        label: "DeepSeek",
        onTiming: this.onTiming,
        idleTimeoutMs: this.idleTimeoutMs,
        onUsage: this.onUsage,
      });
    } finally {
      this.streams.delete(controller);
    }
  }
}
