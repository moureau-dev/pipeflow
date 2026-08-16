import { Agent, type AgentOptions } from "./agents/agent.ts";
import { Conversations } from "./conversations/conversations.ts";
import { MemoryPersistence } from "./persistence/adapters/memory/memory.ts";
import type { Persistence } from "./persistence/persistence.ts";
import type { LLM } from "./providers/llm/types.ts";
import type { STT } from "./providers/stt/types.ts";
import type { TTS } from "./providers/tts/types.ts";

export interface PipeflowOptions {
  apiKey?: string;
  llm?: LLM;
  stt?: STT;
  tts?: TTS;
  persistence?: Persistence;
}

/**
 * The Pipeflow entry point.
 *
 * ```ts
 * const pipeflow = new Pipeflow({ apiKey });
 * const agent = pipeflow.agent({ name: "Jarvis", context: "..." });
 * const conversation = await pipeflow.conversations.create({ agents: [agent] });
 * ```
 */
export class Pipeflow {
  readonly apiKey: string | undefined;
  readonly llm: LLM | undefined;
  readonly stt: STT | undefined;
  readonly tts: TTS | undefined;
  readonly conversations: Conversations;

  constructor(options: PipeflowOptions = {}) {
    this.apiKey = options.apiKey;
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
// Public API exports
// ---------------------------------------------------------------------------

export { Agent } from "./agents/agent.ts";
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
  Transcription,
  TranscriptEntry,
} from "./conversations/index.ts";
export type {
  AudioChunk,
  ConversationId,
  ConversationState,
  ConversationStatus,
  Generation,
  GenerationStatus,
  Participant,
  ParticipantInput,
  Turn,
  TurnId,
  TranscriptEntryInput,
  TranscriptSpeakerKind,
  UserId,
} from "./conversations/index.ts";

export { MemoryPersistence, SQLitePersistence } from "./persistence/index.ts";
export type {
  ConversationRecord,
  NewConversation,
  Persistence,
} from "./persistence/index.ts";

export { complete, streamText, DeepSeekLLM, DeepgramSTT, KokoroTTS } from "./providers/index.ts";
export type {
  LLM,
  LLMEvent,
  LLMMessage,
  LLMRole,
  LLMToolCall,
  LLMToolDefinition,
  LLMRequest,
  STT,
  STTOptions,
  STTSession,
  TTS,
  TTSRequest,
} from "./providers/index.ts";

export { MemoryTransport } from "./transport/index.ts";
export type { Message, Transport } from "./transport/index.ts";
