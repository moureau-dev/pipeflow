// ---------------------------------------------------------------------------
// Core public API
// ---------------------------------------------------------------------------

export { Pipeflow } from "./pipeflow";
export type { PipeflowOptions } from "./pipeflow";

export { Agent } from "./agents/agent";
export type {
  AgentOptions,
  AgentRunRequest,
  AgentRunResult,
  ExecutedToolCall,
} from "./agents/agent";
export { Tool, Tool as PipeflowTool } from "./agents/tools/tools";
export type { ToolOptions } from "./agents/tools/tools";

export {
  Conversation,
  Conversations,
  Transcription,
  TranscriptEntry,
} from "./conversations/index";
export type {
  AudioChunk,
  ConversationEvents,
  ConversationId,
  ConversationOptions,
  ConversationState,
  ConversationStatus,
  CreateConversationOptions,
  Generation,
  GenerationStatus,
  Participant,
  ParticipantInput,
  ToolCall,
  ToolCallResult,
  TranscriptEntryInput,
  TranscriptSpeakerKind,
  Turn,
  TurnId,
  UserId,
} from "./conversations/index";

// Realtime machinery (Orchestrator and friends) lives behind the
// `@moureau/pipeflow/conversations` subpath — it is implementation detail
// that `Conversation.start()` attaches automatically.

// ---------------------------------------------------------------------------
// Configuration interfaces.
//
// Provider and persistence *implementations* are intentionally not exported
// from the main entry — they are replaceable implementation detail. Import
// them from their module subpaths when needed:
//
//   import { DeepSeekLLM } from "pipeflow/providers";
//   import { SQLitePersistence } from "pipeflow/persistence";
//   import { MemoryTransport } from "pipeflow/transport";
// ---------------------------------------------------------------------------

export type { LLM, LLMMessage } from "./providers/llm/types";
export type { STT } from "./providers/stt/types";
export type { TTS } from "./providers/tts/types";
export type { Persistence } from "./persistence/persistence";
