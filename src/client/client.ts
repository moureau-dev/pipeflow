/**
 * Pipeflow client SDK: talk to a Pipeflow server from a browser or Node.
 */
import type {
  AudioChunk,
  ConversationId,
  Generation,
  ToolCall,
  ToolCallResult,
  Turn,
  UserId,
} from "../conversations/types";
import type { TranscriptEntry } from "../conversations/transcription/transcription";
import type {
  Protocol,
  ProtocolMessage,
  ProtocolStatus,
} from "./protocol";

/** Track constraints used when opening the mic. */
export interface CaptureConstraints {
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
}

/** Optional mic auto-attach on `connect()`. */
export interface AudioInputOptions {
  /** Auto-attach `getUserMedia` and stream mic audio into the connection. */
  input?: boolean;
  /**
   * Gate or rewrite captured audio before it hits the wire: return a chunk
   * to send it, or `null` to drop it (a VAD gate). May be async. Chunks are
   * sent as the hook resolves and their `sequence` marks capture order, so
   * the server can reorder them before STT. Applies only to captured
   * audio; manual `sendAudio()` calls go out untouched.
   */
  transform?: (chunk: AudioChunk) => AudioChunk | null | Promise<AudioChunk | null>;
  /**
   * Mic track constraints. Each defaults to `true`. Echo cancellation is the
   * one that matters: without it the mic re-captures the agent's own reply.
   */
  constraints?: CaptureConstraints;
}

export interface ReconnectOptions {
  /** Maximum reconnect attempts after an unexpected close. `0` disables it. */
  maxAttempts?: number;
  /** Initial backoff in ms; doubled each attempt up to `maxBackoffMs`. */
  initialBackoffMs?: number;
  /** Backoff cap in ms. */
  maxBackoffMs?: number;
}

export interface PipeflowClientOptions {
  /** The wire protocol. */
  protocol: Protocol;
  /** Audio capture options. */
  audio?: AudioInputOptions;
  /** Auto-reconnect on unexpected close. */
  reconnect?: ReconnectOptions;
  /** Default user id for `sendText()` / `sendAudio()` when not provided. */
  userId?: UserId;
}

/**
 * Payloads emitted by `PipeflowClient` events, mirroring `ConversationEvents`
 * for the events that travel the wire.
 */
export interface PipeflowClientEventMap {
  start: { conversationId: ConversationId };
  stop: { conversationId: ConversationId };
  "audio-in": { conversationId: ConversationId; userId: UserId; audio: AudioChunk };
  audio: { conversationId: ConversationId; audio: AudioChunk };
  "partial-transcript": { conversationId: ConversationId; userId: UserId; text: string };
  turn: { conversationId: ConversationId; turn: Turn };
  transcript: { conversationId: ConversationId; entry: TranscriptEntry };
  generation: { conversationId: ConversationId; generation: Generation };
  "generation-complete": { conversationId: ConversationId; generation: Generation };
  "tool-call": { conversationId: ConversationId; call: ToolCall };
  "tool-call-result": { conversationId: ConversationId; result: ToolCallResult };
  interrupt: { conversationId: ConversationId };
  error: { conversationId?: ConversationId; error: Error };
  state: { conversationId: ConversationId; state: unknown };
}

export type PipeflowClientEvent = keyof PipeflowClientEventMap;

export type Listener<E extends PipeflowClientEvent> = (
  event: PipeflowClientEventMap[E],
) => void;

/** The minimal browser surface mic capture needs; missing globals make it a no-op in Node. */
interface MicCapture {
  getUserMedia?: (constraints: {
    audio: boolean | CaptureConstraints;
  }) => Promise<MediaStreamLike>;
}
interface MediaStreamLike {
  getTracks(): Array<{ stop(): void }>;
}
interface MediaRecorderLike {
  state: string;
  start(timeslice: number): void;
  stop(): void;
  addEventListener(type: "dataavailable", listener: (event: { data: { size: number; arrayBuffer(): Promise<ArrayBuffer> } }) => void): void;
}
interface BrowserGlobals {
  navigator?: { mediaDevices?: MicCapture };
  MediaRecorder?: new (stream: MediaStreamLike) => MediaRecorderLike;
}

/**
 * Typed client for a Pipeflow server: `connect()`, then events flow while
 * you send text and audio, then `disconnect()`.
 *
 * ```ts
 * const client = new PipeflowClient({
 *   protocol: new WebSocketProtocol({ url: "wss://…/conversations/abc" }),
 *   audio: { input: true },
 * });
 * client.on("turn", (e) => console.log(e.turn.text));
 * await client.connect();
 * ```
 *
 * Mic capture is opt-in via `audio.input`. Playback is the caller's job:
 * wire the `audio` event into your own `AudioContext` or `<audio>` queue,
 * or override `playAudio()`.
 */
export class PipeflowClient {
  private readonly protocol: Protocol;
  private readonly audio: AudioInputOptions;
  private readonly reconnect: Required<ReconnectOptions>;
  private readonly defaultUserId: UserId;

  private readonly listeners = new Map<PipeflowClientEvent, Set<Listener<PipeflowClientEvent>>>();
  private mediaStream: MediaStreamLike | null = null;
  private mediaRecorder: MediaRecorderLike | null = null;
  private startMicPromise: Promise<void> | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;
  private nextSequence = 0;

  constructor(options: PipeflowClientOptions) {
    this.protocol = options.protocol;
    this.audio = options.audio ?? {};
    this.reconnect = {
      maxAttempts: options.reconnect?.maxAttempts ?? 0,
      initialBackoffMs: options.reconnect?.initialBackoffMs ?? 500,
      maxBackoffMs: options.reconnect?.maxBackoffMs ?? 10_000,
    };
    this.defaultUserId = options.userId ?? "anonymous";

    this.protocol.onMessage((m) => this.handleMessage(m));
    this.protocol.onStatus((s) => this.handleStatus(s));
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  /**
   * Open the connection and, if `audio.input` is set, attach the mic.
   * Subsequent calls are no-ops while the connection is open.
   */
  async connect(): Promise<void> {
    this.closedByUser = false;
    await this.protocol.connect();
    if (this.audio.input) await this.startMic();
  }

  /** Close the connection, release the mic, and disable reconnect. */
  async disconnect(): Promise<void> {
    this.closedByUser = true;
    this.clearReconnect();
    this.stopMic();
    await this.protocol.close();
  }

  // ---------------------------------------------------------------------
  // Outbound: text + audio + tool resolution
  // ---------------------------------------------------------------------

  /**
   * Send a finalized text turn. Equivalent to `conversation.send({ userId, text })`.
   */
  sendText(text: string, options: { userId?: UserId } = {}): void {
    this.send({
      type: "text-in",
      payload: {
        userId: options.userId ?? this.defaultUserId,
        text,
      },
    });
  }

  /**
   * Send a raw audio chunk. `listen()` on the server is synchronous; call
   * this for every chunk as it arrives. The chunk's `sequence` marks
   * capture order for the server's reorder buffer.
   */
  sendAudio(audio: AudioChunk, options: { userId?: UserId } = {}): void {
    this.send({
      type: "audio-in",
      payload: {
        userId: options.userId ?? this.defaultUserId,
        audio,
        sequence: audio.sequence ?? this.nextSequence++,
      },
    });
  }

  /** Request an interrupt on the server. */
  interrupt(options: { conversationId?: ConversationId } = {}): void {
    this.send({
      type: "interrupt",
      payload: { conversationId: options.conversationId ?? null },
    });
  }

  /** Resolve a tool call when `autoExecuteTools` is off on the server. */
  resolveToolCall(
    result: ToolCallResult,
    options: { conversationId?: ConversationId } = {},
  ): void {
    this.send({
      type: "tool-result",
      payload: {
        conversationId: options.conversationId ?? null,
        result,
      },
    });
  }

  /**
   * No-op playback hook. Override it, or listen to `audio` directly.
   */
  playAudio(_audio: AudioChunk): void {}

  // ---------------------------------------------------------------------
  // Event subscription
  // ---------------------------------------------------------------------

  /** Subscribe to an event. Returns an unsubscribe function. */
  on<E extends PipeflowClientEvent>(event: E, listener: Listener<E>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<PipeflowClientEvent>);
    return () => {
      set!.delete(listener as Listener<PipeflowClientEvent>);
    };
  }

  /** Remove a previously added listener. */
  off<E extends PipeflowClientEvent>(event: E, listener: Listener<E>): void {
    this.listeners.get(event)?.delete(listener as Listener<PipeflowClientEvent>);
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private send(message: ProtocolMessage): void {
    try {
      this.protocol.send(message);
    } catch (err) {
      this.emit("error", {
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  private handleMessage(message: ProtocolMessage): void {
    switch (message.type) {
      case "start":
      case "stop":
      case "interrupt":
      case "turn":
      case "transcript":
      case "partial-transcript":
      case "audio":
      case "audio-in":
      case "generation":
      case "generation-complete":
      case "tool-call":
      case "tool-call-result":
      case "state": {
        this.emit(message.type, message.payload as never);
        return;
      }
      case "error": {
        const payload = message.payload as { message?: string; conversationId?: ConversationId };
        this.emit("error", {
          conversationId: payload?.conversationId,
          error: new Error(payload?.message ?? "Server error"),
        });
        return;
      }
      default:
        // Unknown message types are ignored to stay forward-compatible.
        return;
    }
  }

  private handleStatus(status: ProtocolStatus): void {
    if (status === "open") {
      this.reconnectAttempts = 0;
      return;
    }
    if (status === "closed" && !this.closedByUser) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnect.maxAttempts <= 0) return;
    if (this.reconnectAttempts >= this.reconnect.maxAttempts) {
      this.emit("error", {
        error: new Error("PipeflowClient: reconnect attempts exhausted"),
      });
      return;
    }
    const attempt = this.reconnectAttempts++;
    const delay = Math.min(
      this.reconnect.initialBackoffMs * 2 ** attempt,
      this.reconnect.maxBackoffMs,
    );
    this.reconnectTimer = setTimeout(() => {
      this.protocol
        .connect()
        .catch((err: unknown) => {
          this.emit("error", {
            error: err instanceof Error ? err : new Error(String(err)),
          });
          this.scheduleReconnect();
        });
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
  }

  /** Attach the mic once, even under concurrent `connect()` calls. */
  private startMic(): Promise<void> {
    if (this.mediaStream) return Promise.resolve();
    this.startMicPromise ??= this.openMic().finally(() => {
      this.startMicPromise = null;
    });
    return this.startMicPromise;
  }

  private async openMic(): Promise<void> {
    const globals = globalThis as unknown as BrowserGlobals;
    if (!globals.navigator?.mediaDevices?.getUserMedia) return;
    if (this.mediaStream) return;
    const Recorder = globals.MediaRecorder;
    if (!Recorder) return;
    try {
      const constraints: CaptureConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        ...this.audio.constraints,
      };
      this.mediaStream = await globals.navigator.mediaDevices.getUserMedia({
        audio: constraints,
      });
      this.mediaRecorder = new Recorder(this.mediaStream);
      this.mediaRecorder.addEventListener("dataavailable", (event) => {
        if (event.data.size === 0) return;
        event.data.arrayBuffer().then(async (buffer) => {
          // Assigned before the transform: the sequence marks capture
          // order even when async hooks resolve out of order.
          const chunk: AudioChunk = {
            data: new Uint8Array(buffer),
            timestamp: Date.now(),
            sequence: this.nextSequence++,
          };
          let out: AudioChunk | null;
          try {
            out = this.audio.transform ? await this.audio.transform(chunk) : chunk;
          } catch (err) {
            this.emit("error", {
              error: err instanceof Error ? err : new Error(String(err)),
            });
            return;
          }
          if (!out) return; // gated, e.g. by a VAD
          this.sendAudio({ ...out, sequence: out.sequence ?? chunk.sequence });
        });
      });
      this.mediaRecorder.start(250);
    } catch (err) {
      this.emit("error", {
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  private stopMic(): void {
    if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
      try {
        this.mediaRecorder.stop();
      } catch {
        // ignore
      }
    }
    this.mediaRecorder = null;
    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) track.stop();
      this.mediaStream = null;
    }
  }

  private emit<E extends PipeflowClientEvent>(
    event: E,
    payload: PipeflowClientEventMap[E],
  ): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        (listener as Listener<E>)(payload);
      } catch {
        // A faulty listener must not prevent delivery to others.
      }
    }
  }
}