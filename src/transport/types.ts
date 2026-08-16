import type {
  AudioChunk,
  ConversationId,
  Turn,
  UserId,
} from "../conversations/types.ts";
import type { TranscriptEntry } from "../conversations/transcription/transcription.ts";

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
