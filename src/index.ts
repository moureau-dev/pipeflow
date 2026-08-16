import { Agent, type AgentOptions } from "./agents/agent.ts";
import { Conversations } from "./conversations/conversations.ts";
import { MemoryPersistence } from "./persistence/adapters/memory/memory.ts";
import type { Persistence } from "./persistence/persistence.ts";
import type { LLM } from "./providers/llm/types.ts";
import type { STT } from "./providers/stt/types.ts";
import type { TTS } from "./providers/tts/types.ts";

export interface PipeflowOptions {
  llm?: LLM;
  stt?: STT;
  tts?: TTS;
  persistence?: Persistence;
}

/**
 * The Pipeflow entry point.
 *
 * ```ts
 * const pipeflow = new Pipeflow({ llm });
 * const agent = pipeflow.agent({ name: "Jarvis", context: "..." });
 * const conversation = await pipeflow.conversations.create({ agents: [agent] });
 * ```
 */
export class Pipeflow {
  readonly llm: LLM | undefined;
  readonly stt: STT | undefined;
  readonly tts: TTS | undefined;
  readonly conversations: Conversations;

  constructor(options: PipeflowOptions = {}) {
    this.llm = options.llm;
    this.stt = options.stt;
    this.tts = options.tts;
    const persistence = options.persistence ?? new MemoryPersistence();
    this.conversations = new Conversations(persistence);
  }

  /**
   * Create an agent. Agents inherit the Pipeflow instance's LLM provider so
   * `agent.run()` works out of the box.
   */
  agent(options: Omit<AgentOptions, "llm"> & { llm?: LLM }): Agent {
    return new Agent({ ...options, llm: options.llm ?? this.llm });
  }
}

// ---------------------------------------------------------------------------
// Core public API
// ---------------------------------------------------------------------------

export { Agent };
export type {
  AgentOptions,
  AgentRunRequest,
  AgentRunResult,
  ExecutedToolCall,
} from "./agents/agent.ts";
export { Tool, Tool as PipeflowTool } from "./agents/tools/tools.ts";
export type { ToolOptions } from "./agents/tools/tools.ts";

export {
  Conversation,
  Conversations,
  Orchestrator,
  Transcription,
  TranscriptEntry,
} from "./conversations/index.ts";
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
  OrchestratorOptions,
  Participant,
  ParticipantInput,
  ToolCall,
  ToolCallResult,
  TranscriptEntryInput,
  TranscriptSpeakerKind,
  Turn,
  TurnId,
  UserId,
} from "./conversations/index.ts";

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

export type { LLM, LLMMessage } from "./providers/llm/types.ts";
export type { STT } from "./providers/stt/types.ts";
export type { TTS } from "./providers/tts/types.ts";
export type { Persistence } from "./persistence/persistence.ts";
