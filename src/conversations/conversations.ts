import type { Agent } from "../agents/agent";
import type { Persistence } from "../persistence/persistence";
import type { STT } from "../providers/stt/types";
import type { TTS } from "../providers/tts/types";
import type { ConversationId } from "./types";
import type { TranscriptEntry } from "./transcription/transcription";
import { Conversation } from "./conversation/conversation";
import type { Logger } from "../logger/types";

export interface CreateConversationOptions {
  agents?: Agent[];
  /**
   * Execute the agents' tools automatically (default `true`). Set `false`
   * for this conversation to resolve tool calls from your own backend via
   * `resolveToolCall()`. Overrides the `Conversations`-level default.
   */
  autoExecuteTools?: boolean;
  /**
   * TTS synthesis concurrency (default 2). More in-flight requests let a
   * multi-sentence reply synthesize in parallel, removing the gaps between
   * sentences, at the cost of provider concurrency — some free TTS variants
   * rate-limit concurrent requests.
   */
  maxConcurrentTtsRequests?: number;
  /**
   * Hold window (ms) for out-of-order audio (default 100). See
   * `ConversationOptions.audioReorderMs`.
   */
  audioReorderMs?: number;
}

export interface ConversationsOptions {
  persistence: Persistence;
  /** Passed to conversations so `start()` can attach realtime processing. */
  stt?: STT;
  tts?: TTS;
  /**
   * Default for created conversations: auto-execute the agents' tools
   * (default `true`). See `CreateConversationOptions.autoExecuteTools`.
   */
  autoExecuteTools?: boolean;
  logger?: Logger;
}

/**
 * The conversations API surface of a Pipeflow instance: create persistent
 * conversations and retrieve their transcripts.
 */
export class Conversations {
  private readonly persistence: Persistence;
  private readonly stt: STT | undefined;
  private readonly tts: TTS | undefined;
  private readonly autoExecuteTools: boolean;
  private readonly logger: Logger;

  constructor(options: ConversationsOptions) {
    this.persistence = options.persistence;
    this.stt = options.stt;
    this.tts = options.tts;
    this.autoExecuteTools = options.autoExecuteTools ?? true;
    this.logger = options.logger ?? { info() {}, warn() {}, error() {}, debug() {} } as Logger;
  }

  /** Create a persistent conversation. Realtime execution is separate. */
  async create(options: CreateConversationOptions = {}): Promise<Conversation> {
    const record = await this.persistence.createConversation({
      agentNames: (options.agents ?? []).map((agent) => agent.name),
    });
    this.logger.info("conversation created", { conversationId: record.id });
    return new Conversation({
      id: record.id,
      agents: options.agents,
      persistence: this.persistence,
      stt: this.stt,
      tts: this.tts,
      autoExecuteTools: options.autoExecuteTools ?? this.autoExecuteTools,
      logger: this.logger,
      ...(options.maxConcurrentTtsRequests !== undefined
        ? { maxConcurrentTtsRequests: options.maxConcurrentTtsRequests }
        : {}),
      ...(options.audioReorderMs !== undefined
        ? { audioReorderMs: options.audioReorderMs }
        : {}),
    });
  }

  /** Retrieve the persisted transcript of a conversation. */
  async transcript(id: ConversationId): Promise<TranscriptEntry[]> {
    await this.requireConversation(id);
    return this.persistence.listTranscript(id);
  }

  /** Rehydrate a runtime handle for an existing conversation. */
  async get(id: ConversationId): Promise<Conversation | null> {
    const record = await this.persistence.getConversation(id);
    if (!record) return null;
    return new Conversation({ id: record.id, persistence: this.persistence });
  }

  private async requireConversation(id: ConversationId): Promise<void> {
    const record = await this.persistence.getConversation(id);
    if (!record) {
      throw new Error(`Conversation "${id}" not found`);
    }
  }
}
