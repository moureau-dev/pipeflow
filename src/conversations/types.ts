/**
 * Core domain types shared across Pipeflow modules.
 */

// ---------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------

export type ConversationId = string;
export type UserId = string;
export type TurnId = string;

// ---------------------------------------------------------------------------
// Participants
// ---------------------------------------------------------------------------

export interface ParticipantInput {
  userId: UserId;
  aliases?: string[];
}

export interface Participant {
  userId: UserId;
  aliases: string[];
  joinedAt: number;
}

// ---------------------------------------------------------------------------
// Turns & generations
// ---------------------------------------------------------------------------

export interface Turn {
  id: TurnId;
  conversationId: ConversationId;
  participantId: UserId;
  participantName: string;
  text: string;
  sequence: number;
  startedAt: number;
  endedAt: number;
}

export type GenerationStatus = "streaming" | "completed" | "cancelled";

export interface Generation {
  id: string;
  conversationId: ConversationId;
  agentName: string;
  text: string;
  status: GenerationStatus;
  startedAt: number;
  endedAt?: number;
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

export interface AudioChunk {
  data: Uint8Array;
  timestamp: number;
  sequence: number;
}

// ---------------------------------------------------------------------------
// Conversation state
// ---------------------------------------------------------------------------

export type ConversationStatus = "created" | "started" | "stopped";

export interface ConversationState {
  status: ConversationStatus;
  participants: Map<UserId, Participant>;
  floor: UserId | null;
  currentTurn: Turn | null;
  currentGeneration: Generation | null;
  transcriptCount: number;
}

export function createConversationState(
  status: ConversationStatus = "created",
): ConversationState {
  return {
    status,
    participants: new Map(),
    floor: null,
    currentTurn: null,
    currentGeneration: null,
    transcriptCount: 0,
  };
}
