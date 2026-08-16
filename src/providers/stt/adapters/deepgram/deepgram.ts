import type { STT, STTOptions, STTSession } from "../../types";

/**
 * The minimal WebSocket surface used by the Deepgram adapter. Both the global
 * `WebSocket` (Bun) and test fakes satisfy this shape.
 */
export interface STTSocket {
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: string,
    listener: (event: { data?: unknown; error?: unknown }) => void,
  ): void;
}

export interface DeepgramOptions extends STTOptions {
  apiKey: string;
  /**
   * Overrides the listen endpoint. Defaults to `wss://api.deepgram.com/v2/listen`
   * for Flux models (`flux-*`) and `wss://api.deepgram.com/v1/listen` otherwise.
   */
  endpoint?: string;
  /** Injectable socket factory, mainly for tests. */
  createSocket?: (url: string) => STTSocket;
}

type DeepgramEvent = "partial" | "final" | "error" | "close";

/**
 * Deepgram streaming STT adapter (WebSocket).
 *
 * Audio written before the socket opens is queued and flushed on connect.
 * `end()` sends a `CloseStream` frame and resolves once the server closes
 * the socket.
 */
export class DeepgramSTT implements STT {
  private readonly options: DeepgramOptions;
  private readonly sessions = new Set<DeepgramSession>();

  constructor(options: DeepgramOptions) {
    if (!options.apiKey) {
      throw new Error("DeepgramSTT requires an apiKey");
    }
    this.options = options;
  }

  start(options: STTOptions = {}): STTSession {
    const merged: DeepgramOptions = { ...this.options, ...options };
    const url = buildListenUrl(merged);
    const createSocket = merged.createSocket ?? ((target: string) => new WebSocket(target) as unknown as STTSocket);
    const session = new DeepgramSession(createSocket(url));
    this.sessions.add(session);
    session.on("close", () => {
      this.sessions.delete(session);
    });
    return session;
  }

  cancel(): void {
    for (const session of [...this.sessions]) {
      session.abort();
    }
  }
}

export class DeepgramSession implements STTSession {
  private readonly socket: STTSocket;
  private readonly listeners = new Map<DeepgramEvent, Set<(...args: any[]) => void>>();
  private opened = false;
  private closed = false;
  private ended = false;
  private readonly pendingClose = { flag: false };
  private readonly queued: Uint8Array[] = [];
  private readonly endPromise: Promise<void>;
  private resolveEnd!: () => void;

  constructor(socket: STTSocket) {
    this.socket = socket;
    this.endPromise = new Promise((resolve) => {
      this.resolveEnd = resolve;
    });

    socket.addEventListener("open", () => {
      this.opened = true;
      for (const audio of this.queued) {
        this.socket.send(toArrayBuffer(audio));
      }
      this.queued.length = 0;
      if (this.pendingClose.flag) {
        this.sendCloseStream();
      }
    });

    socket.addEventListener("message", (event) => {
      const text = decodeMessage(event.data);
      if (text === null) return;
      try {
        this.handleResult(JSON.parse(text));
      } catch {
        // Ignore malformed frames.
      }
    });

    socket.addEventListener("error", () => {
      this.emit("error", new Error("Deepgram socket error"));
    });

    socket.addEventListener("close", () => {
      this.closed = true;
      this.resolveEnd();
      this.emit("close");
    });
  }

  write(audio: Uint8Array): void {
    if (this.closed) {
      throw new Error("Deepgram session is closed");
    }
    if (!this.opened) {
      this.queued.push(audio);
      return;
    }
    this.socket.send(toArrayBuffer(audio));
  }

  async end(): Promise<void> {
    if (this.closed) return;
    if (this.ended) return this.endPromise;
    this.ended = true;
    if (!this.opened) {
      this.pendingClose.flag = true;
      return this.endPromise;
    }
    this.sendCloseStream();
    return this.endPromise;
  }

  /** Force-close the session without waiting for the server. */
  abort(): void {
    if (this.closed) return;
    this.socket.close();
  }

  on(event: "partial", listener: (transcript: string) => void): void;
  on(event: "final", listener: (transcript: string) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: DeepgramEvent, listener: (...args: any[]) => void): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
  }

  private handleResult(message: Record<string, unknown>): void {
    if (message.type !== "Results") return;
    const alternatives = (message.channel as { alternatives?: { transcript?: string }[] })
      ?.alternatives;
    const text = alternatives?.[0]?.transcript ?? "";
    if (!text) return;
    if (message.is_final === true) {
      this.emit("final", text);
    } else {
      this.emit("partial", text);
    }
  }

  private sendCloseStream(): void {
    this.socket.send(JSON.stringify({ type: "CloseStream" }));
  }

  private emit(event: "partial", arg: string): void;
  private emit(event: "final", arg: string): void;
  private emit(event: "error", arg: Error): void;
  private emit(event: "close"): void;
  private emit(event: DeepgramEvent, ...args: any[]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      listener(...args);
    }
  }
}

function buildListenUrl(options: DeepgramOptions): string {
  const params = new URLSearchParams();
  const model = options.model ?? "flux-general-en";
  params.set("model", model);
  params.set("interim_results", (options.interimResults ?? true) ? "true" : "false");
  params.set("encoding", options.encoding ?? "linear16");
  params.set("sample_rate", String(options.sampleRate ?? 16000));
  params.set("punctuate", "true");
  if (options.language) params.set("language", options.language);
  params.set("token", options.apiKey);

  // Flux runs on the v2 listen endpoint; classic models (nova-*) use v1.
  const defaultEndpoint = model.startsWith("flux")
    ? "wss://api.deepgram.com/v2/listen"
    : "wss://api.deepgram.com/v1/listen";
  const base = (options.endpoint ?? defaultEndpoint).replace(/\/+$/, "");
  return `${base}?${params.toString()}`;
}

function toArrayBuffer(audio: Uint8Array): ArrayBuffer {
  // Copy so the view's backing buffer (possibly larger or shared) is not
  // sent over the socket.
  const copy = new Uint8Array(audio.byteLength);
  copy.set(audio);
  return copy.buffer;
}

function decodeMessage(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
  }
  return null;
}
