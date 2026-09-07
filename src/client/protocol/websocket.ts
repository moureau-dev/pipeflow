/**
 * WebSocket-backed implementation of the `Protocol` contract.
 *
 * The URL, auth token, and subprotocols are passed through to the underlying
 * `WebSocket`. The token is resolved lazily on each `connect()` and appended
 * to the URL as a `token` query parameter so the server can authenticate the
 * upgrade (WebSocket has no `Authorization` header mechanism).
 *
 * ```ts
 * const protocol = new WebSocketProtocol({
 *   url: "wss://api.example.com/conversations/abc",
 *   token: () => localStorage.getItem("jwt"),
 * });
 * ```
 */
import type {
  Protocol,
  ProtocolListener,
  ProtocolMessage,
  ProtocolStatus,
  StatusListener,
} from "../protocol";
import { isJsonSerializable } from "../json";

/**
 * Resolves the connection token. Called on every `connect()` so the caller
 * can rotate credentials without rebuilding the client. The resolved value
 * is appended to the URL as `?token=…` (overwriting any existing value).
 */
export type TokenProvider = () => string | null | Promise<string | null>;

export interface WebSocketProtocolOptions {
  /** Fully-qualified WebSocket URL, e.g. `wss://api.example.com/conversations/abc`. */
  url: string;
  /** Optional token resolver; the resolved value is appended as `?token=…`. */
  token?: TokenProvider;
  /** Subprotocols passed to the WebSocket constructor. */
  protocols?: string | string[];
  /**
   * Inject a custom WebSocket constructor (for tests, polyfills, or tracing).
   * Defaults to the global `WebSocket`.
   */
  socketFactory?: (url: string, protocols?: string | string[]) => WebSocket;
}

export class WebSocketProtocol implements Protocol {
  readonly url: string;
  private readonly token?: TokenProvider;
  private readonly protocols?: string | string[];
  private readonly socketFactory: NonNullable<
    WebSocketProtocolOptions["socketFactory"]
  >;

  private socket: WebSocket | null = null;
  private _status: ProtocolStatus = "idle";
  private readonly messageListeners = new Set<ProtocolListener>();
  private readonly statusListeners = new Set<StatusListener>();

  constructor(options: WebSocketProtocolOptions) {
    this.url = options.url;
    this.token = options.token;
    this.protocols = options.protocols;
    this.socketFactory =
      options.socketFactory ??
      ((url, protocols) => new WebSocket(url, protocols));
  }

  get status(): ProtocolStatus {
    return this._status;
  }

  async connect(): Promise<void> {
    if (this._status === "open" || this._status === "connecting") return;
    if (this.socket) this.teardownSocket(this.socket);
    this.setStatus("connecting");

    // Construct the socket synchronously so callers (and tests) can interact
    // with it before the promise resolves. For async token providers, the
    // construction must be deferred: call `connect()` with a sync token
    // provider or pre-resolve the token.
    const syncToken = this.token ? await this.token() : null;
    const url = syncToken ? withToken(this.url, syncToken) : this.url;

    const socket = this.socketFactory(url, this.protocols);
    this.socket = socket;

    return new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        this.setStatus("open");
        resolve();
      };
      const onError = () => {
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        this.setStatus("closed");
        reject(new Error(`Failed to connect to ${this.url}`));
      };
      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onError);
      socket.addEventListener("message", this.handleMessage);
      socket.addEventListener("close", this.handleClose);
    });
  }

  async close(): Promise<void> {
    const socket = this.socket;
    if (!socket || this._status === "closed" || this._status === "idle") return;
    this.setStatus("closing");

    await new Promise<void>((resolve) => {
      const done = () => {
        socket.removeEventListener("close", done);
        resolve();
      };
      socket.addEventListener("close", done);
      // readyState 0 (CONNECTING) cannot be closed gracefully; drop it.
      if (socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      } else if (socket.readyState === WebSocket.OPEN) {
        socket.close(1000, "client closing");
      } else {
        resolve();
      }
    });

    this.teardownSocket(socket);
    this.setStatus("closed");
  }

  send(message: ProtocolMessage): void {
    if (this._status !== "open" || !this.socket) {
      throw new Error(`Cannot send on a ${this._status} protocol`);
    }
    if (!isJsonSerializable(message.payload)) {
      throw new Error("ProtocolMessage.payload must be JSON-serializable");
    }
    this.socket.send(JSON.stringify(message));
  }

  onMessage(listener: ProtocolListener): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  private readonly handleMessage = (event: MessageEvent): void => {
    const raw = typeof event.data === "string" ? event.data : "";
    if (!raw) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isProtocolMessage(parsed)) return;
    for (const listener of [...this.messageListeners]) {
      try {
        listener(parsed);
      } catch {
        // A faulty listener must not prevent delivery to others.
      }
    }
  };

  private readonly handleClose = (): void => {
    if (this._status !== "closed") this.setStatus("closed");
    if (this.socket) this.teardownSocket(this.socket);
  };

  private teardownSocket(socket: WebSocket): void {
    socket.removeEventListener("message", this.handleMessage);
    socket.removeEventListener("close", this.handleClose);
    this.socket = null;
  }

  private setStatus(next: ProtocolStatus): void {
    if (this._status === next) return;
    this._status = next;
    for (const listener of [...this.statusListeners]) {
      try {
        listener(next);
      } catch {
        // ignore
      }
    }
  }
}

function isProtocolMessage(value: unknown): value is ProtocolMessage {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.type === "string";
}

/** Append or replace `?token=…` on a URL. */
function withToken(url: string, token: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("token", token);
    return parsed.toString();
  } catch {
    // Fall back to a literal concat for relative or malformed URLs (tests).
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}token=${encodeURIComponent(token)}`;
  }
}