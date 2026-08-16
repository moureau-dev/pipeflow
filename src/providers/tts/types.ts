export interface TTS {
  stream(request: TTSRequest): AsyncIterable<Uint8Array>;
  stop(): void;
}
