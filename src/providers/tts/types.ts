export interface TTSRequest {
  text: string;
  voice?: string;
  speed?: number;
  format?: "wav" | "mp3" | "pcm";
}

/**
 * Vendor-independent text-to-speech interface.
 *
 * `stream()` produces audio chunks as they become available and throws on
 * transport-level failures. `stop()` cancels the in-flight synthesis.
 */
export interface TTS {
  stream(request: TTSRequest): AsyncIterable<Uint8Array>;
  stop(): void;
}
