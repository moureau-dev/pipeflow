import type { ConversationId } from "../types.ts";

export type TranscriptSpeakerKind = "participant" | "agent";

export interface TranscriptEntryInput {
  conversationId: ConversationId;
  speaker: string;
  speakerKind: TranscriptSpeakerKind;
  text: string;
  timestamp?: number;
  sequence?: number;
  id?: string;
}

/**
 * A single line of a conversation transcript.
 *
 * `toString()` renders the entry as `speaker: text` so transcript arrays can
 * be joined directly into a readable dump.
 */
export class TranscriptEntry {
  readonly id: string;
  readonly conversationId: ConversationId;
  readonly speaker: string;
  readonly speakerKind: TranscriptSpeakerKind;
  readonly text: string;
  readonly timestamp: number;
  readonly sequence: number;

  constructor(input: TranscriptEntryInput) {
    this.id = input.id ?? crypto.randomUUID();
    this.conversationId = input.conversationId;
    this.speaker = input.speaker;
    this.speakerKind = input.speakerKind;
    this.text = input.text;
    this.timestamp = input.timestamp ?? Date.now();
    this.sequence = input.sequence ?? 0;
  }

  /** Rebuild an entry from plain (e.g. persisted) data. */
  static fromPlain(plain: TranscriptEntry): TranscriptEntry {
    return new TranscriptEntry({ ...plain });
  }

  toString(): string {
    return `${this.speaker}: ${this.text}`;
  }
}

/**
 * In-memory transcript state for a single conversation.
 *
 * Entries are appended in order and assigned monotonically increasing
 * sequence numbers. The orchestrator appends entries as speech is finalized
 * and generations complete; persistence mirrors these entries.
 */
export class Transcription {
  private readonly conversationId: ConversationId;
  private readonly entries: TranscriptEntry[] = [];
  private readonly ids = new Set<string>();
  private nextSequence = 0;

  constructor(conversationId: ConversationId) {
    this.conversationId = conversationId;
  }

  get length(): number {
    return this.entries.length;
  }

  get isEmpty(): boolean {
    return this.entries.length === 0;
  }

  /** Append a participant speech entry. */
  appendSpeech(speaker: string, text: string, timestamp = Date.now()): TranscriptEntry {
    return this.append({ speaker, speakerKind: "participant", text, timestamp });
  }

  /** Append an agent generation entry. */
  appendGeneration(agentName: string, text: string, timestamp = Date.now()): TranscriptEntry {
    return this.append({ speaker: agentName, speakerKind: "agent", text, timestamp });
  }

  append(
    input: Omit<TranscriptEntryInput, "conversationId" | "sequence" | "id"> & {
      id?: string;
      sequence?: number;
    },
  ): TranscriptEntry {
    const entry = new TranscriptEntry({
      ...input,
      conversationId: this.conversationId,
      sequence: input.sequence ?? this.nextSequence,
    });
    if (this.ids.has(entry.id)) {
      throw new Error(`Transcript entry "${entry.id}" already exists`);
    }
    this.ids.add(entry.id);
    this.entries.push(entry);
    this.nextSequence = entry.sequence + 1;
    return entry;
  }

  list(): TranscriptEntry[] {
    return [...this.entries];
  }

  get(id: string): TranscriptEntry | null {
    return this.entries.find((entry) => entry.id === id) ?? null;
  }

  getBySequence(sequence: number): TranscriptEntry | null {
    return this.entries.find((entry) => entry.sequence === sequence) ?? null;
  }

  last(): TranscriptEntry | null {
    return this.entries.at(-1) ?? null;
  }

  clear(): void {
    this.entries.length = 0;
    this.ids.clear();
    this.nextSequence = 0;
  }
}
