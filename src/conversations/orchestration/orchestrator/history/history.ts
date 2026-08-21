import type { Conversation } from "../../../conversation/conversation";
import type { Generation, Participant, Turn } from "../../../types";
import type { LLMMessage } from "../../../../providers/llm/types";

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

/**
 * A human-readable "now" stamp appended to dispatched prompts so
 * time-sensitive tasks (flights, meetings, deadlines) have temporal context.
 */
export function formatTimeContext(date = new Date()): string {
  const day = date.getDate();
  const month = MONTHS[date.getMonth()]!;
  const year = date.getFullYear();
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `Now it is ${day} ${month} ${year}, ${hours}:${minutes}.`;
}

/**
 * A short context suffix appended automatically to every user turn, so the
 * model knows the time and who is speaking (and who else is in the
 * conversation) — e.g. "enhance the message I just sent" resolves to a real
 * user id. Applied once, when the turn enters history; every generation path
 * (direct, coordination, delegated) seeds from that history.
 */
export function formatTurnContext(
  participant: Participant,
  participants: readonly Participant[],
  date = new Date(),
): string {
  const describe = (p: Participant): string => {
    const displayName = p.aliases[0] ?? p.userId;
    const aliases = p.aliases.length > 0 ? ` (aliases: ${p.aliases.join(", ")})` : "";
    return `${displayName} with user id ${p.userId}${aliases}`;
  };
  const others = participants.filter((p) => p.userId !== participant.userId);
  const othersLine =
    others.length > 0
      ? ` The other participants are ${others.map(describe).join(", ")}.`
      : "";
  return `\n\nAdditional context: ${formatTimeContext(date)} The current user is ${describe(participant)}.${othersLine}`;
}

/** How much conversational history an LLM request may carry. */
export interface HistoryWindow {
  /** Keep at most this many user turns (the current turn is always kept). */
  maxTurns: number;
  /** Drop oldest whole messages until the window fits this many characters. */
  maxChars: number;
}

/**
 * Bounds conversation history for an LLM request: keep the most recent
 * `maxTurns` user turns (plus anything after them), then drop oldest whole
 * messages until the window fits `maxChars`. The current turn is the last
 * user message and always survives. Provider TTFT grows with input size, so
 * a bounded window keeps requests in the fast regime.
 */
export function windowHistory(
  history: LLMMessage[],
  { maxTurns, maxChars }: HistoryWindow,
): LLMMessage[] {
  if (history.length === 0) return history;

  let start = 0;
  let userSeen = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.role === "user") {
      userSeen++;
      if (userSeen === maxTurns) {
        start = i;
        break;
      }
    }
  }
  let windowed = start > 0 ? history.slice(start) : history;

  if (maxChars > 0) {
    while (
      windowed.length > 1 &&
      windowed.reduce((sum, message) => sum + message.content.length, 0) > maxChars
    ) {
      windowed = windowed.slice(1);
    }
  }
  return windowed;
}

/**
 * The conversation's LLM message log: every user turn and agent reply, plus
 * the turn-context formatting and windowing applied when a request is built.
 * The orchestrator's `Conversation` remains the source of truth for turns,
 * transcripts, and generations — this is the derived prompt log only.
 */
export class ConversationHistory {
  private readonly messages: LLMMessage[] = [];

  /**
   * The user-message form of a turn: display name, text, and the automatic
   * context suffix (time + speaker + roster) baked in at history time.
   */
  turnMessage(turn: Turn, conversation: Conversation): string {
    const participant = conversation.state.participants.get(turn.participantId);
    const participants = [...conversation.state.participants.values()];
    const context = participant
      ? formatTurnContext(participant, participants, new Date(turn.startedAt))
      : "";
    return `${turn.participantName}: ${turn.text}${context}`;
  }

  /** Append a participant turn as a user message. */
  addUserTurn(turn: Turn, conversation: Conversation): void {
    this.messages.push({ role: "user", content: this.turnMessage(turn, conversation) });
  }

  /** Append an agent reply as an assistant message. */
  addAssistant(agentName: string, text: string): void {
    this.messages.push({ role: "assistant", name: agentName, content: text });
  }

  /**
   * Rehydrate from persisted turns and completed top-level generations.
   * Sub-generations are summarized inside the coordinator's own answer, so
   * only top-level responses rehydrate into history.
   */
  rehydrate(
    turns: readonly Turn[],
    generations: readonly Generation[],
    conversation: Conversation,
  ): void {
    const entries: Array<
      | { at: number; kind: "turn"; turn: Turn }
      | { at: number; kind: "generation"; agentName: string; text: string }
    > = [
      ...turns.map((turn) => ({ at: turn.startedAt, kind: "turn" as const, turn })),
      ...generations
        .filter(
          (generation) =>
            generation.status === "completed" && generation.kind !== "sub",
        )
        .map((generation) => ({
          at: generation.startedAt,
          kind: "generation" as const,
          agentName: generation.agentName,
          text: generation.text,
        })),
    ].sort((a, b) => a.at - b.at);

    for (const entry of entries) {
      if (entry.kind === "turn") {
        this.addUserTurn(entry.turn, conversation);
      } else {
        this.addAssistant(entry.agentName, entry.text);
      }
    }
  }

  /** The full message log. */
  get all(): readonly LLMMessage[] {
    return this.messages;
  }

  /**
   * The message log bounded for an LLM request: the full log when `window`
   * is `false`, otherwise the bounded window.
   */
  windowed(window: HistoryWindow | false): LLMMessage[] {
    return window === false ? this.messages : windowHistory(this.messages, window);
  }
}
