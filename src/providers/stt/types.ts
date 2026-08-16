export interface STTOptions {
  model?: string;
  language?: string;
  /** Whether interim (partial) transcripts are reported. */
  interimResults?: boolean;
  /** Audio encoding, e.g. `linear16`. */
  encoding?: string;
  /** Audio sample rate in Hz. */
  sampleRate?: number;
}

export interface STTSession {
  /** Feed an audio chunk into the recognizer. */
  write(audio: Uint8Array): void;
  /** Signal the end of the audio stream and wait for the session to close. */
  end(): Promise<void>;
  on(event: "partial", listener: (transcript: string) => void): void;
  on(event: "final", listener: (transcript: string) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
}

/**
 * Vendor-independent speech-to-text interface.
 *
 * `start()` opens a streaming session; audio is fed in with `write()` and
 * transcripts are reported via `partial`/`final` events.
 */
export interface STT {
  start(options?: STTOptions): STTSession;
  /** Cancel all active sessions. */
  cancel(): void;
}
