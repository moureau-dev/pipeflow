import { Database } from "bun:sqlite";
import type {
  ConversationId,
  Generation,
  Participant,
  Turn,
  UserId,
} from "../../../conversations/types";
import { TranscriptEntry } from "../../../conversations/transcription/transcription";
import type {
  ConversationRecord,
  NewConversation,
  Persistence,
} from "../../persistence";

export interface SQLitePersistenceOptions {
  /** Database filename. Defaults to an in-memory database. */
  filename?: string;
}

interface ConversationRow {
  id: string;
  agent_names: string;
  created_at: number;
  ended_at: number | null;
}

interface ParticipantRow {
  conversation_id: string;
  user_id: string;
  aliases: string;
  joined_at: number;
}

interface TranscriptRow {
  id: string;
  conversation_id: string;
  speaker: string;
  speaker_kind: string;
  text: string;
  timestamp: number;
  sequence: number;
}

interface TurnRow {
  id: string;
  conversation_id: string;
  participant_id: string;
  participant_name: string;
  text: string;
  started_at: number;
  ended_at: number;
  sequence: number;
}

interface GenerationRow {
  id: string;
  conversation_id: string;
  agent_name: string;
  text: string;
  status: string;
  started_at: number;
  ended_at: number | null;
}

/**
 * SQLite-backed persistence adapter (via bun:sqlite).
 *
 * A lightweight persistent backend for local applications and early
 * deployments.
 */
export class SQLitePersistence implements Persistence {
  private readonly db: Database;

  constructor(options: SQLitePersistenceOptions = {}) {
    this.db = new Database(options.filename ?? ":memory:");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id          TEXT PRIMARY KEY,
        agent_names TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        ended_at    INTEGER
      );

      CREATE TABLE IF NOT EXISTS participants (
        conversation_id TEXT NOT NULL,
        user_id         TEXT NOT NULL,
        aliases         TEXT NOT NULL,
        joined_at       INTEGER NOT NULL,
        PRIMARY KEY (conversation_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS transcript (
        id            TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        speaker       TEXT NOT NULL,
        speaker_kind  TEXT NOT NULL,
        text          TEXT NOT NULL,
        timestamp     INTEGER NOT NULL,
        sequence      INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS turns (
        id               TEXT PRIMARY KEY,
        conversation_id  TEXT NOT NULL,
        participant_id   TEXT NOT NULL,
        participant_name TEXT NOT NULL,
        text             TEXT NOT NULL,
        started_at       INTEGER NOT NULL,
        ended_at         INTEGER NOT NULL,
        sequence         INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS generations (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        agent_name      TEXT NOT NULL,
        text            TEXT NOT NULL,
        status          TEXT NOT NULL,
        started_at      INTEGER NOT NULL,
        ended_at        INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_participants_conversation ON participants (conversation_id);
      CREATE INDEX IF NOT EXISTS idx_transcript_conversation ON transcript (conversation_id);
      CREATE INDEX IF NOT EXISTS idx_turns_conversation ON turns (conversation_id);
      CREATE INDEX IF NOT EXISTS idx_generations_conversation ON generations (conversation_id);
    `);
  }

  close(): void {
    this.db.close();
  }

  async createConversation(input: NewConversation = {}): Promise<ConversationRecord> {
    const record: ConversationRecord = {
      id: input.id ?? crypto.randomUUID(),
      agentNames: input.agentNames ?? [],
      createdAt: input.createdAt ?? Date.now(),
      endedAt: null,
    };
    this.db
      .query(
        `INSERT OR REPLACE INTO conversations (id, agent_names, created_at, ended_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(record.id, JSON.stringify(record.agentNames), record.createdAt, null);
    return { ...record };
  }

  async getConversation(id: ConversationId): Promise<ConversationRecord | null> {
    const row = this.db
      .query<ConversationRow, [string]>(`SELECT * FROM conversations WHERE id = ?`)
      .get(id);
    return row ? rowToConversation(row) : null;
  }

  async listConversations(): Promise<ConversationRecord[]> {
    const rows = this.db
      .query<ConversationRow, []>(`SELECT * FROM conversations ORDER BY created_at ASC`)
      .all();
    return rows.map(rowToConversation);
  }

  async finalizeConversation(
    id: ConversationId,
    endedAt = Date.now(),
  ): Promise<ConversationRecord | null> {
    const result = this.db
      .query<unknown, [number, string]>(`UPDATE conversations SET ended_at = ? WHERE id = ?`)
      .run(endedAt, id);
    if (result.changes === 0) return null;
    return this.getConversation(id);
  }

  async deleteConversation(id: ConversationId): Promise<boolean> {
    const conversation = this.db
      .query<ConversationRow, [string]>(`SELECT id FROM conversations WHERE id = ?`)
      .get(id);
    if (!conversation) return false;
    this.db.query(`DELETE FROM participants WHERE conversation_id = ?`).run(id);
    this.db.query(`DELETE FROM transcript WHERE conversation_id = ?`).run(id);
    this.db.query(`DELETE FROM turns WHERE conversation_id = ?`).run(id);
    this.db.query(`DELETE FROM generations WHERE conversation_id = ?`).run(id);
    this.db.query(`DELETE FROM conversations WHERE id = ?`).run(id);
    return true;
  }

  async addParticipant(
    conversationId: ConversationId,
    participant: Participant,
  ): Promise<void> {
    this.db
      .query(
        `INSERT OR REPLACE INTO participants (conversation_id, user_id, aliases, joined_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        conversationId,
        participant.userId,
        JSON.stringify(participant.aliases),
        participant.joinedAt,
      );
  }

  async listParticipants(conversationId: ConversationId): Promise<Participant[]> {
    const rows = this.db
      .query<ParticipantRow, [string]>(
        `SELECT * FROM participants WHERE conversation_id = ? ORDER BY joined_at ASC`,
      )
      .all(conversationId);
    return rows.map((row) => ({
      userId: row.user_id,
      aliases: JSON.parse(row.aliases) as string[],
      joinedAt: row.joined_at,
    }));
  }

  async appendTranscript(
    conversationId: ConversationId,
    entry: TranscriptEntry,
  ): Promise<void> {
    this.db
      .query(
        `INSERT OR REPLACE INTO transcript (id, conversation_id, speaker, speaker_kind, text, timestamp, sequence)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        conversationId,
        entry.speaker,
        entry.speakerKind,
        entry.text,
        entry.timestamp,
        entry.sequence,
      );
  }

  async listTranscript(conversationId: ConversationId): Promise<TranscriptEntry[]> {
    const rows = this.db
      .query<TranscriptRow, [string]>(
        `SELECT * FROM transcript WHERE conversation_id = ? ORDER BY sequence ASC`,
      )
      .all(conversationId);
    return rows.map((row) =>
      TranscriptEntry.fromPlain({
        id: row.id,
        conversationId: row.conversation_id,
        speaker: row.speaker,
        speakerKind: row.speaker_kind as TranscriptEntry["speakerKind"],
        text: row.text,
        timestamp: row.timestamp,
        sequence: row.sequence,
      }),
    );
  }

  async appendTurn(conversationId: ConversationId, turn: Turn): Promise<void> {
    this.db
      .query(
        `INSERT OR REPLACE INTO turns (id, conversation_id, participant_id, participant_name, text, started_at, ended_at, sequence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        turn.id,
        conversationId,
        turn.participantId,
        turn.participantName,
        turn.text,
        turn.startedAt,
        turn.endedAt,
        turn.sequence,
      );
  }

  async listTurns(conversationId: ConversationId): Promise<Turn[]> {
    const rows = this.db
      .query<TurnRow, [string]>(
        `SELECT * FROM turns WHERE conversation_id = ? ORDER BY sequence ASC`,
      )
      .all(conversationId);
    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      participantId: row.participant_id,
      participantName: row.participant_name,
      text: row.text,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      sequence: row.sequence,
    }));
  }

  async appendGeneration(
    conversationId: ConversationId,
    generation: Generation,
  ): Promise<void> {
    this.db
      .query(
        `INSERT OR REPLACE INTO generations (id, conversation_id, agent_name, text, status, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        generation.id,
        conversationId,
        generation.agentName,
        generation.text,
        generation.status,
        generation.startedAt,
        generation.endedAt ?? null,
      );
  }

  async listGenerations(conversationId: ConversationId): Promise<Generation[]> {
    const rows = this.db
      .query<GenerationRow, [string]>(
        `SELECT * FROM generations WHERE conversation_id = ? ORDER BY started_at ASC`,
      )
      .all(conversationId);
    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      agentName: row.agent_name,
      text: row.text,
      status: row.status as Generation["status"],
      startedAt: row.started_at,
      endedAt: row.ended_at ?? undefined,
    }));
  }
}

function rowToConversation(row: ConversationRow): ConversationRecord {
  return {
    id: row.id,
    agentNames: JSON.parse(row.agent_names) as string[],
    createdAt: row.created_at,
    endedAt: row.ended_at,
  };
}
