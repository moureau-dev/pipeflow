import type {
  ConversationId,
  Generation,
  Participant,
  Turn,
  UserId,
} from "../../../conversations/types";
import type { TranscriptEntry } from "../../../conversations/transcription/transcription";
import type {
  ConversationRecord,
  NewConversation,
  Persistence,
} from "../../persistence";

/**
 * In-memory persistence adapter. Useful for tests and development: data is
 * lost when the process exits.
 */
export class MemoryPersistence implements Persistence {
  private readonly conversations = new Map<ConversationId, ConversationRecord>();
  private readonly participants = new Map<ConversationId, Map<UserId, Participant>>();
  private readonly transcript = new Map<ConversationId, TranscriptEntry[]>();
  private readonly turns = new Map<ConversationId, Turn[]>();
  private readonly generations = new Map<ConversationId, Generation[]>();

  async createConversation(input: NewConversation = {}): Promise<ConversationRecord> {
    const record: ConversationRecord = {
      id: input.id ?? crypto.randomUUID(),
      agentNames: [...(input.agentNames ?? [])],
      createdAt: input.createdAt ?? Date.now(),
      endedAt: null,
    };
    this.conversations.set(record.id, record);
    return copyConversation(record);
  }

  async getConversation(id: ConversationId): Promise<ConversationRecord | null> {
    const record = this.conversations.get(id);
    return record ? copyConversation(record) : null;
  }

  async listConversations(): Promise<ConversationRecord[]> {
    return [...this.conversations.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(copyConversation);
  }

  async finalizeConversation(
    id: ConversationId,
    endedAt = Date.now(),
  ): Promise<ConversationRecord | null> {
    const record = this.conversations.get(id);
    if (!record) return null;
    record.endedAt = endedAt;
    return copyConversation(record);
  }

  async deleteConversation(id: ConversationId): Promise<boolean> {
    const existed = this.conversations.delete(id);
    this.participants.delete(id);
    this.transcript.delete(id);
    this.turns.delete(id);
    this.generations.delete(id);
    return existed;
  }

  async addParticipant(
    conversationId: ConversationId,
    participant: Participant,
  ): Promise<void> {
    let map = this.participants.get(conversationId);
    if (!map) {
      map = new Map();
      this.participants.set(conversationId, map);
    }
    map.set(participant.userId, { ...participant, aliases: [...participant.aliases] });
  }

  async listParticipants(conversationId: ConversationId): Promise<Participant[]> {
    const map = this.participants.get(conversationId);
    if (!map) return [];
    return [...map.values()].map((p) => ({ ...p, aliases: [...p.aliases] }));
  }

  async appendTranscript(
    conversationId: ConversationId,
    entry: TranscriptEntry,
  ): Promise<void> {
    const list = this.transcript.get(conversationId) ?? [];
    const index = list.findIndex((e) => e.id === entry.id);
    if (index === -1) list.push(entry);
    else list[index] = entry;
    this.transcript.set(conversationId, list);
  }

  async listTranscript(conversationId: ConversationId): Promise<TranscriptEntry[]> {
    return [...(this.transcript.get(conversationId) ?? [])];
  }

  async appendTurn(conversationId: ConversationId, turn: Turn): Promise<void> {
    const list = this.turns.get(conversationId) ?? [];
    list.push({ ...turn });
    this.turns.set(conversationId, list);
  }

  async listTurns(conversationId: ConversationId): Promise<Turn[]> {
    return [...(this.turns.get(conversationId) ?? [])].map((turn) => ({ ...turn }));
  }

  async appendGeneration(
    conversationId: ConversationId,
    generation: Generation,
  ): Promise<void> {
    const list = this.generations.get(conversationId) ?? [];
    const index = list.findIndex((g) => g.id === generation.id);
    if (index === -1) list.push({ ...generation });
    else list[index] = { ...generation };
    this.generations.set(conversationId, list);
  }

  async listGenerations(conversationId: ConversationId): Promise<Generation[]> {
    return [...(this.generations.get(conversationId) ?? [])].map((generation) => ({
      ...generation,
    }));
  }
}

function copyConversation(record: ConversationRecord): ConversationRecord {
  return { ...record, agentNames: [...record.agentNames] };
}
