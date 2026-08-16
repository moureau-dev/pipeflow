import type {
  ConversationId,
  Generation,
  Participant,
  Turn,
  UserId,
} from "../conversations/types.ts";
import type { TranscriptEntry } from "../conversations/transcription/transcription.ts";

export interface ConversationRecord {
  id: ConversationId;
  agentNames: string[];
  createdAt: number;
  endedAt: number | null;
}

export interface NewConversation {
  id?: ConversationId;
  agentNames?: string[];
  createdAt?: number;
}

/**
 * Storage contract for the conversation domain.
 *
 * Persistence is provider-independent: memory and SQLite are the built-in
 * adapters, and other backends can implement the same interface.
 */
export interface Persistence {
  // Conversations -----------------------------------------------------------

  createConversation(input?: NewConversation): Promise<ConversationRecord>;
  getConversation(id: ConversationId): Promise<ConversationRecord | null>;
  listConversations(): Promise<ConversationRecord[]>;
  /** Mark a conversation as ended. Returns null if it does not exist. */
  finalizeConversation(
    id: ConversationId,
    endedAt?: number,
  ): Promise<ConversationRecord | null>;
  deleteConversation(id: ConversationId): Promise<boolean>;

  // Participants ------------------------------------------------------------

  addParticipant(
    conversationId: ConversationId,
    participant: Participant,
  ): Promise<void>;
  listParticipants(conversationId: ConversationId): Promise<Participant[]>;

  // Transcript --------------------------------------------------------------

  /** Upsert a transcript entry (entries are immutable in practice). */
  appendTranscript(
    conversationId: ConversationId,
    entry: TranscriptEntry,
  ): Promise<void>;
  listTranscript(conversationId: ConversationId): Promise<TranscriptEntry[]>;

  // Turns -------------------------------------------------------------------

  appendTurn(conversationId: ConversationId, turn: Turn): Promise<void>;
  listTurns(conversationId: ConversationId): Promise<Turn[]>;

  // Generations -------------------------------------------------------------

  /** Upsert a generation so status updates (e.g. completed) overwrite. */
  appendGeneration(
    conversationId: ConversationId,
    generation: Generation,
  ): Promise<void>;
  listGenerations(conversationId: ConversationId): Promise<Generation[]>;
}

// Re-exported for convenience in adapters and callers.
export type { ConversationId, UserId };
