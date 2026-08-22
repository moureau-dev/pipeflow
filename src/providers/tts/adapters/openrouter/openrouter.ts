import type { TTS, TTSRequest } from "../../types";
import type { FetchLike } from "../../../shared";

export interface OpenRouterTTSOptions {
  apiKey: string;
  /** Defaults to `https://openrouter.ai/api/v1`. */
  baseUrl?: string;
  /**
   * TTS model. Defaults to the free `fish-audio/s2.1-pro-free:free` variant —
   * fast, per-character priced. Pass `fish-audio/s2.1-pro` for the paid tier
   * (no free-variant rate limits).
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

      const response = await this.fetchImpl(`${this.baseUrl}/audio/speech`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

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
        const { done, value } = await reader.read();
        if (done) break;
        buffer = yield* sliceChunks(concat(buffer, value), this.chunkSize);
      }
      if (buffer.length > 0) {
        yield buffer;
      }
    } finally {
      this.streams.delete(controller);
    }
  }
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
