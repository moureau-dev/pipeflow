import type {
  LLM,
  LLMEvent,
  LLMRequest,
  LLMStreamTimingCallback,
  LLMUsageCallback,
} from "../../types";
import type { FetchLike } from "../../../shared";
import { openAICompatibleStream } from "../openai-compatible";

export interface OpenRouterOptions {
  apiKey: string;
  /**
   * Any model hosted on OpenRouter, e.g. `anthropic/claude-sonnet-4`.
   * Defaults to `openrouter/auto`, which routes the request to the best
   * available model for its shape.
   */
  model?: string;
  /** Defaults to `https://openrouter.ai/api/v1`. */
  baseUrl?: string;
  /**
   * The site that credits the app on OpenRouter's leaderboard via
   * `HTTP-Referer`. Defaults to `https://moureau.dev`.
   */
  appUrl?: string;
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
 * OpenRouter LLM adapter (OpenAI-compatible chat completions over SSE).
 *
 * OpenRouter is a gateway: one API key and one wire format for hundreds of
 * models from different vendors, so this adapter is a thin wrapper around
 * the shared OpenAI-compatible streaming engine.
 */
export class OpenRouterLLM implements LLM {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly appUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly onTiming: LLMStreamTimingCallback | undefined;
  private readonly idleTimeoutMs: number;
  private readonly onUsage: LLMUsageCallback | undefined;
  private readonly streams = new Set<AbortController>();

  constructor(options: OpenRouterOptions) {
    if (!options.apiKey) {
      throw new Error("OpenRouterLLM requires an apiKey");
    }
    this.apiKey = options.apiKey;
    this.model = options.model ?? "openrouter/auto";
    this.baseUrl = (options.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/+$/, "");
    this.appUrl = options.appUrl ?? "https://moureau.dev";
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
      // OpenRouter credits app usage on its leaderboard from HTTP-Referer
      // (defaulting to moureau.dev) and X-Title (always `pipeflow`).
      yield* openAICompatibleStream({
        baseUrl: this.baseUrl,
        apiKey: this.apiKey,
        model: this.model,
        fetchImpl: this.fetchImpl,
        request,
        signal: controller.signal,
        extraHeaders: {
          "http-referer": this.appUrl,
          "x-title": "pipeflow",
        },
        label: "OpenRouter",
        onTiming: this.onTiming,
        idleTimeoutMs: this.idleTimeoutMs,
        onUsage: this.onUsage,
      });
    } finally {
      this.streams.delete(controller);
    }
  }
}
