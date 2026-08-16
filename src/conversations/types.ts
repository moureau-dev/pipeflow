export interface ConversationState {
  participants: Map<UserId, Participant>;
  floor: UserId | null;

  currentTurn: Turn | null;
  currentGeneration: Generation | null;

  // transcription: ...;
  // output: ...;
};

export interface AudioChunk {
  data: Uint8Array;
  timestamp: number;
  sequence: number;
};
