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

/**
 * Latency instrumentation for a generation: when it started, when the first
 * LLM token and the first synthesized audio chunk arrived, and when it
 * finished. Times are epoch milliseconds; all are optional except `startedAt`.
 */
export interface GenerationTiming {
  startedAt: number;
  /** First LLM delta of this generation (first-token latency). */
  firstTokenAt?: number;
  /** First TTS audio chunk delivered to the application (speech latency). */
  firstAudioAt?: number;
  completedAt?: number;
}

export interface Generation {
  id: string;
  conversationId: ConversationId;
  agentName: string;
  text: string;
  status: GenerationStatus;
  startedAt: number;
  endedAt?: number;
  /**
   * "sub" marks a task dispatched to another agent by the coordinator.
   * Regular agent replies omit this field.
   */
  kind?: "sub";
  /** For sub-generations: the id of the coordinator generation that dispatched them. */
  parentGenerationId?: string;
  /** Latency instrumentation, recorded as the generation streams. */
  timing?: GenerationTiming;
}

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed arguments, or the raw JSON string if parsing failed. */
  arguments: unknown;
}

export type ToolCallResult =
  | { id: string; result: unknown }
  | { id: string; error: string };

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
