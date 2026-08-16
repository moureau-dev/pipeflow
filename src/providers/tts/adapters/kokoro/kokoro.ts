import type { TTS, TTSRequest } from "../../types.ts";
import type { FetchLike } from "../../../shared.ts";

export interface KokoroOptions {
  /**
   * Base URL of a Kokoro TTS server exposing the OpenAI-compatible
   * `/v1/audio/speech` endpoint. Defaults to a local kokoro-fastapi server.
   */
  baseUrl?: string;
  /** Default voice, e.g. `af_heart`. */
  voice?: string;
  model?: string;
  apiKey?: string;
  /** Size of the audio chunks yielded from the response stream. */
  chunkSize?: number;
  /** Injectable fetch implementation, mainly for tests. */
  fetch?: FetchLike;
}

/**
 * Kokoro TTS adapter. Consumes a Kokoro server's OpenAI-compatible speech
 * endpoint and re-chunks the returned audio so it can be played as it
 * arrives.
 */
export class KokoroTTS implements TTS {
  private readonly baseUrl: string;
  private readonly voice: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly chunkSize: number;
  private readonly fetchImpl: FetchLike;
  private abort: AbortController | null = null;

  constructor(options: KokoroOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://localhost:8880").replace(/\/+$/, "");
    this.voice = options.voice ?? "af_heart";
    this.model = options.model ?? "kokoro";
    this.apiKey = options.apiKey;
    this.chunkSize = options.chunkSize ?? 8192;
    this.fetchImpl = options.fetch ?? fetch;
  }

  stop(): void {
    this.abort?.abort();
  }

  async *stream(request: TTSRequest): AsyncGenerator<Uint8Array> {
    if (!request.text) {
      throw new Error("KokoroTTS requires request.text");
    }

    this.abort?.abort();
    const controller = new AbortController();
    this.abort = controller;

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/audio/speech`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          input: request.text,
          voice: request.voice ?? this.voice,
          response_format: request.format,
          speed: request.speed,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Kokoro request failed (${response.status}): ${body}`);
      }
      if (!response.body) {
        throw new Error("Kokoro returned an empty body");
      }

      const reader = response.body.getReader();
      let buffer: Uint8Array<ArrayBuffer> = new Uint8Array(0);

      while (true) {
        if (controller.signal.aborted) {
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        const { done, value } = await reader.read();
        if (done) break;
        buffer = concat(buffer, value);
        while (buffer.length >= this.chunkSize) {
          yield buffer.slice(0, this.chunkSize);
          buffer = buffer.slice(this.chunkSize);
        }
      }

      if (buffer.length > 0) {
        yield buffer;
      }
    } finally {
      if (this.abort === controller) {
        this.abort = null;
      }
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
