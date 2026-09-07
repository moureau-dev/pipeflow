import type { TTS, TTSRequest } from "../../types";
import type { FetchLike } from "../../../shared";

export interface OpenRouterTTSOptions {
  apiKey: string;
  /** Defaults to `https://openrouter.ai/api/v1`. */
  baseUrl?: string;
  /**
   * TTS model. Defaults to the free `fish-audio/s2.1-pro-free:free` variant —
   * fast, per-character priced. Pass `fish-audio/s2.1-pro` for the paid tier
   * (no free-variant rate limits). Note the free variant is intermittently
   * unavailable on OpenRouter (404 "No endpoints found").
   */
  model?: string;
  /**
   * Default voice, sent when the request carries none. Set it for a
   * consistent voice: the default fish model accepts exactly `"alloy"` and
   * rejects other names, and omitting `voice` lets the free variant vary the
   * voice per request. Models like OpenAI TTS require a voice. Voice support
   * varies by model and provider.
   */
  voice?: string;
  /**
   * Output format used when the request doesn't specify one. `"pcm"` (the
   * default) is the lowest-latency realtime format, but its sample rate is
   * provider-defined and opaque — clients must know it. `"mp3"` is
   * self-describing: decoders read the real rate from the stream.
   */
  format?: "pcm" | "mp3";
  /** Size of the audio chunks yielded from the response stream. Default 8192. */
  chunkSize?: number;
  /**
   * Abort a synthesis that delivers no audio bytes for this long (default
   * 15000ms). A provider connection that goes silent — or never responds —
   * would otherwise wedge the speech pipeline forever, since the pipeline
   * holds one synthesis slot and its delivery chain until the stream ends.
   * Any byte resets the clock; a genuinely slow synthesis just needs a
   * response within this window.
   */
  idleTimeoutMs?: number;
  /** Injectable fetch, mainly for tests. */
  fetch?: FetchLike;
}

/**
 * OpenRouter TTS adapter (`POST /api/v1/audio/speech`, OpenAI-compatible).
 *
 * The endpoint returns raw audio bytes (not JSON) in `mp3` or `pcm` format.
 * The adapter re-chunks the response stream so audio can be played as it
 * arrives; `stop()` aborts the in-flight synthesis. `pcm` is the default
 * output (OpenRouter's own recommendation for realtime pipelines).
 */
export class OpenRouterTTS implements TTS {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly voice: string;
  private readonly format: "pcm" | "mp3";
  private readonly chunkSize: number;
  private readonly idleTimeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly streams = new Set<AbortController>();

  constructor(options: OpenRouterTTSOptions) {
    if (!options.apiKey) {
      throw new Error("OpenRouterTTS requires an apiKey");
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/+$/, "");
    this.model = options.model ?? "fish-audio/s2.1-pro-free:free";
    this.voice = options.voice ?? "";
    this.format = options.format ?? "pcm";
    this.chunkSize = options.chunkSize ?? 8192;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 15_000;
    this.fetchImpl = options.fetch ?? fetch;
  }

  stop(): void {
    // Abort every in-flight synthesis. Streams are tracked individually so
    // concurrent requests (the speech pipeline pre-starts the next sentence
    // while the current one is still streaming) do not cancel each other.
    for (const controller of this.streams) controller.abort();
  }

  async *stream(request: TTSRequest): AsyncGenerator<Uint8Array> {
    if (!request.text) {
      throw new Error("OpenRouterTTS requires request.text");
    }

    const controller = new AbortController();
    this.streams.add(controller);
    // Every await is bounded by an idle clock: a request that never responds,
    // or a connection that goes silent mid-stream, aborts with a clear error
    // instead of holding the speech pipeline's synthesis slot and delivery
    // chain open forever (the reply would otherwise wait for the next input).
    let timedOut = false;

    try {
      const body: Record<string, unknown> = {
        model: this.model,
        input: request.text,
        // Voice is only sent when configured: fish-audio (the default model)
        // rejects an explicit voice with a 400, while models like OpenAI TTS
        // require one.
        ...(request.voice ?? this.voice ? { voice: request.voice ?? this.voice } : {}),
        // OpenRouter supports mp3 and pcm only; anything else (or
        // unspecified) maps to pcm, the lower-latency realtime format.
        response_format: (request.format ?? this.format) === "mp3" ? "mp3" : "pcm",
      };
      if (request.speed !== undefined) body.speed = request.speed;

      const response = await withTimeout(
        this.fetchImpl(`${this.baseUrl}/audio/speech`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        }),
        this.idleTimeoutMs,
        () => {
          timedOut = true;
          controller.abort();
        },
      );

      if (!response.ok) {
        // Non-200 responses carry a JSON error body, not audio.
        const detail = await response.text().catch(() => "");
        throw new Error(
          `OpenRouter TTS failed (${response.status})${detail ? `: ${detail}` : ""}`,
        );
      }
      if (!response.body) {
        throw new Error("OpenRouter returned an empty body");
      }

      const reader = response.body.getReader();
      let buffer = new Uint8Array(0);
      while (true) {
        if (controller.signal.aborted) {
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        const { done, value } = await withTimeout(
          reader.read(),
          this.idleTimeoutMs,
          () => {
            timedOut = true;
            controller.abort();
          },
        );
        if (done) break;
        buffer = yield* sliceChunks(concat(buffer, value), this.chunkSize);
      }
      if (buffer.length > 0) {
        yield buffer;
      }
    } catch (error) {
      // Translate the watchdog's abort into a clear failure. Real aborts
      // (`stop()`, interrupts) keep their AbortError so callers can tell the
      // difference.
      if (timedOut) {
        throw new Error(`OpenRouter TTS produced no audio for ${this.idleTimeoutMs}ms`);
      }
      throw error;
    } finally {
      this.streams.delete(controller);
    }
  }
}

/**
 * Race `promise` against a timeout: reject after `ms` and fire `onTimeout`
 * (which should abort the underlying request) so a hanging operation is
 * released rather than left pending forever.
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => clearTimeout(timer);
    timer = setTimeout(() => {
      cleanup();
      onTimeout();
      reject(new Error(`timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function concat(
  a: Uint8Array<ArrayBufferLike>,
  b: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/**
 * Yield up to `chunkSize` bytes from `audio`, returning the remainder for
 * the caller to keep buffering. Providers deliver arbitrary chunk
 * boundaries, so audio is re-sliced into uniform pieces.
 */
function* sliceChunks(
  audio: Uint8Array<ArrayBuffer>,
  chunkSize: number,
): Generator<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>, undefined> {
  let buffer = audio;
  while (buffer.length >= chunkSize) {
    yield buffer.slice(0, chunkSize);
    buffer = buffer.slice(chunkSize);
  }
  return buffer;
}
