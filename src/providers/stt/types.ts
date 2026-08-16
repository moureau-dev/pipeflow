export interface STT {
  start(options: STTOptions): STTSession;
  cancel(): void;
}

export interface STTSession {
  write(audio: Uint8Array): void;
  end(): Promise<void>;
  on(event: "partial" | "final", listener: ...): void;
}
