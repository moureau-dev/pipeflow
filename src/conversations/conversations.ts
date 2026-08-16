import type { Agent } from "../agents/agent.ts";
import type { Persistence } from "../../persistence/persistence.ts";
import type { ConversationId } from "./types.ts";
import type { TranscriptEntry } from "./transcription/transcription.ts";
import { Conversation } from "./conversation/conversation.ts";

export interface CreateConversationOptions {
  agents?: Agent[];
}

/**
 * The conversations API surface of a Pipeflow instance: create persistent
 * conversations and retrieve their transcripts.
 */
export class Conversations {
  constructor(private readonly persistence: Persistence) {}

  /** Create a persistent conversation. Realtime execution is separate. */
  async create(options: CreateConversationOptions = {}): Promise<Conversation> {
    const record = await this.persistence.createConversation({
      agentNames: (options.agents ?? []).map((agent) => agent.name),
    });
    return new Conversation({
      id: record.id,
      agents: options.agents,
      persistence: this.persistence,
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
