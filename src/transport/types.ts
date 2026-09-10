import type {
  AudioChunk,
  ConversationId,
  Turn,
  UserId,
} from "../conversations/types";
import type { TranscriptEntry } from "../conversations/transcription/transcription";

/**
 * Messages exchanged between Pipeflow and the application over a Transport.
 */
export type Message =
  | {
      type: "audio-in";
      conversationId: ConversationId;
      userId: UserId;
      audio: AudioChunk;
    }
  | {
      type: "audio-out";
      conversationId: ConversationId;
      audio: AudioChunk;
    }
  | {
      type: "transcript";
      conversationId: ConversationId;
      entry: TranscriptEntry;
    }
  | {
      type: "turn";
      conversationId: ConversationId;
      turn: Turn;
    }
  | { type: "interrupt"; conversationId: ConversationId }
  | { type: "start"; conversationId: ConversationId }
  | { type: "stop"; conversationId: ConversationId };

export interface Transport {
  /**
   * Send a message to the peer connected to this transport.
   * Throws if the transport has been closed.
   */
  send(message: Message): void;

  /**
   * Close the transport and disconnect from the peer.
   * Closing one end of a connection closes the other end as well.
   */
  close(): Promise<void>;

  /**
   * Register a listener for incoming messages. Returns an unsubscribe
   * function.
   */
  onMessage(listener: (message: Message) => void): () => void;
}

// ---------------------------------------------------------------------------
// Server transport abstraction (Bun-agnostic)
// ---------------------------------------------------------------------------

/**
 * A single connected client managed by a `ServerAdapter`.
 */
export interface ServerClient {
  /** Send a text message (JSON). */
  send(data: string): void;
  /** Send a binary message (audio). */
  sendBinary(data: Uint8Array): void;
  /** Close the connection. */
  close(): void;
  /** Register a message handler. Returns an unsubscribe function. */
  onMessage(listener: (data: string | Uint8Array) => void): () => void;
  /** Register a close handler. Returns an unsubscribe function. */
  onClose(listener: () => void): () => void;
}

/**
 * Pluggable server transport that abstracts the runtime (Bun, Node ws,
 * socket.io, etc.) from the Pipeflow conversation bridge.
 *
 * Implement this interface to bring your own server:
 *
 * ```ts
 * class MyNodeWsAdapter implements ServerAdapter {
 *   // wrap require("ws").Server or socket.io here
 * }
 * ```
 */
export interface ServerAdapter {
  /** Start accepting connections. */
  start(): Promise<void>;
  /** Stop the server and disconnect all clients. */
  stop(): Promise<void>;
  /**
   * Register a handler for new client connections. Returns an unsubscribe
   * function.
   */
  onConnection(listener: (client: ServerClient) => void): () => void;
}
