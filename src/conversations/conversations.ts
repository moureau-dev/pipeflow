import type { Agent } from "../agents/agent";
import type { Persistence } from "../persistence/persistence";
import type { STT } from "../providers/stt/types";
import type { TTS } from "../providers/tts/types";
import type { ConversationId } from "./types";
import type { TranscriptEntry } from "./transcription/transcription";
import { Conversation } from "./conversation/conversation";

export interface CreateConversationOptions {
  agents?: Agent[];
}

export interface ConversationsOptions {
  persistence: Persistence;
  /** Passed to conversations so `start()` can attach realtime processing. */
  stt?: STT;
  tts?: TTS;
}

/**
 * The conversations API surface of a Pipeflow instance: create persistent
 * conversations and retrieve their transcripts.
 */
export class Conversations {
  private readonly persistence: Persistence;
  private readonly stt: STT | undefined;
  private readonly tts: TTS | undefined;

  constructor(options: ConversationsOptions) {
    this.persistence = options.persistence;
    this.stt = options.stt;
    this.tts = options.tts;
  }

  /** Create a persistent conversation. Realtime execution is separate. */
  async create(options: CreateConversationOptions = {}): Promise<Conversation> {
    const record = await this.persistence.createConversation({
      agentNames: (options.agents ?? []).map((agent) => agent.name),
    });
    return new Conversation({
      id: record.id,
      agents: options.agents,
      persistence: this.persistence,
      stt: this.stt,
      tts: this.tts,
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
