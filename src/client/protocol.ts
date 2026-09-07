/**
 * Wire-level contract between a `PipeflowClient` and a Pipeflow server.
 *
 * A `Protocol` is responsible only for transport: it opens a connection,
 * delivers `ProtocolMessage`s, and reports its status. The client sits on
 * top and turns those messages into typed events.
 *
 * Swap protocols to change the wire (WebSocket today; SSE, HTTP, or an
 * in-memory pair for tests tomorrow) without touching application code.
 */

/** Lifecycle status of a protocol connection. */
export type ProtocolStatus =
  | "idle"
  | "connecting"
  | "open"
  | "closing"
  | "closed";

/**
 * A message exchanged over a `Protocol`. Symmetric: both sides send and
 * receive. `payload` is intentionally `unknown`: payloads are JSON-shaped
 * server domain types (turns, transcripts, audio chunks, …) that the client
 * decodes against its event map at the boundary.
 */
export interface ProtocolMessage {
  type: string;
  payload: unknown;
}

export type ProtocolListener = (message: ProtocolMessage) => void;
export type StatusListener = (status: ProtocolStatus) => void;

/**
 * A bidirectional wire between a Pipeflow client and server.
 *
 * Implementations must be safe to subscribe to before `connect()`: messages
 * received before the listener is attached are buffered or dropped per the
 * implementation's policy, and a listener attached after `connect()` only sees
 * subsequent messages. This mirrors the WebSocket contract.
 */
export interface Protocol {
  /** Current lifecycle status. */
  readonly status: ProtocolStatus;

  /** Open the underlying connection. Idempotent: a second call is a no-op. */
  connect(): Promise<void>;

  /** Close the connection. Safe to call from any state. */
  close(): Promise<void>;

  /** Send a message. Throws if the connection is not `open`. */
  send(message: ProtocolMessage): void;

  /** Subscribe to incoming messages. Returns an unsubscribe function. */
  onMessage(listener: ProtocolListener): () => void;

  /** Subscribe to status transitions. Returns an unsubscribe function. */
  onStatus(listener: StatusListener): () => void;
}