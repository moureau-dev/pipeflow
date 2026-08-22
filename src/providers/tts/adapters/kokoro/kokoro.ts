import type { TTS, TTSRequest } from "../../types";
import type { FetchLike } from "../../../shared";

export interface KokoroOptions {
  /**
   * Base URL of a Kokoro TTS server exposing the OpenAI-compatible
   * `/v1/audio/speech` endpoint. Defaults to a local kokoro-fastapi server.
   * For Together AI use `https://api.together.ai`.
   */
  baseUrl?: string;
  /** Default voice, e.g. `af_heart`. */
  voice?: string;
  /**
   * Model name. Defaults to `kokoro` (local kokoro-fastapi); Together AI
   * serves the model as `hexgrad/Kokoro-82M`.
   */
  model?: string;
  apiKey?: string;
  /** Size of the audio chunks yielded from the response stream. */
  chunkSize?: number;
  /**
   * Ask the server for progressive (streaming) synthesis. Local
   * kokoro-fastapi streams by default; hosted endpoints such as Together AI
   * require this flag. Together AI responds with server-sent events carrying
   * base64-encoded audio deltas (pcm_s16le, 24 kHz for Kokoro) terminated by
   * `data: [DONE]`; the adapter decodes them into raw audio chunks. wav/mp3
   * formats are not streamable.
   */
  stream?: boolean;
  /** Injectable fetch implementation, mainly for tests. */
  fetch?: FetchLike;
}

/**
 * Kokoro TTS adapter. Consumes a Kokoro server's OpenAI-compatible speech
 * endpoint (local kokoro-fastapi or a hosted service such as Together AI)
 * and re-chunks the returned audio so it can be played as it arrives.
 */
export class KokoroTTS implements TTS {
  private readonly baseUrl: string;
  private readonly voice: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly chunkSize: number;
  private readonly streaming: boolean;
  private readonly fetchImpl: FetchLike;
  private readonly streams = new Set<AbortController>();

  constructor(options: KokoroOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://localhost:8880").replace(/\/+$/, "");
    this.voice = options.voice ?? "af_heart";
    this.model = options.model ?? "kokoro";
    this.apiKey = options.apiKey;
    this.chunkSize = options.chunkSize ?? 8192;
    this.streaming = options.stream ?? false;
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
      throw new Error("KokoroTTS requires request.text");
    }

    const controller = new AbortController();
    this.streams.add(controller);

    try {
      const body: Record<string, unknown> = {
        model: this.model,
        input: request.text,
        voice: request.voice ?? this.voice,
        speed: request.speed,
      };
      if (this.streaming) {
        // Streaming synthesis: hosted endpoints (Together AI) only accept
        // raw audio; `pcm` requests map to it. wav/mp3 pass through and are
        // rejected server-side when not streamable.
        body.stream = true;
        body.response_format =
          request.format === undefined || request.format === "pcm"
            ? "raw"
            : request.format;
      } else if (request.format !== undefined) {
        body.response_format = request.format;
      }

      const response = await this.fetchImpl(`${this.baseUrl}/v1/audio/speech`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
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
      const isSse = (response.headers.get("content-type") ?? "").includes(
        "text/event-stream",
      );
      let audioBuffer: Uint8Array<ArrayBuffer> = new Uint8Array(0);

      if (isSse) {
        // Together AI streams server-sent events with base64-encoded audio
        // deltas; the stream ends with `data: [DONE]`.
        let textBuffer = "";
        let doneEvent = false;
        while (!doneEvent) {
          if (controller.signal.aborted) {
            throw new DOMException("The operation was aborted.", "AbortError");
          }
          const { done, value } = await reader.read();
          if (done) break;
          textBuffer += new TextDecoder().decode(value);
          const events = textBuffer.split("\n\n");
          textBuffer = events.pop() ?? "";
          for (const event of events) {
            for (const line of event.split("\n")) {
              if (!line.startsWith("data:")) continue;
              const data = line.slice(5).trim();
              if (data === "[DONE]") {
                doneEvent = true;
                break;
              }
              try {
                const parsed = JSON.parse(data) as {
                  type?: string;
                  delta?: string;
                };
                if (
                  parsed.type === "conversation.item.audio_output.delta" &&
                  typeof parsed.delta === "string"
                ) {
                  audioBuffer = yield* sliceChunks(
                    concat(audioBuffer, base64ToBytes(parsed.delta)),
                    this.chunkSize,
                  );
                }
              } catch {
                // Ignore malformed events.
              }
            }
          }
        }
      } else {
        while (true) {
          if (controller.signal.aborted) {
            throw new DOMException("The operation was aborted.", "AbortError");
          }
          const { done, value } = await reader.read();
          if (done) break;
          audioBuffer = yield* sliceChunks(concat(audioBuffer, value), this.chunkSize);
        }
      }

      if (audioBuffer.length > 0) {
        yield audioBuffer;
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

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}
