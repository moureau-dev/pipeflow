import { describe, expect, test } from "bun:test";
import { Conversation } from "../../../conversation/conversation";
import { MemoryPersistence } from "../../../../persistence/adapters/memory/memory";
import {
  ConversationHistory,
  formatTurnContext,
  windowHistory,
} from "./history";
import type { Generation, Turn } from "../../../types";
import type { LLMMessage } from "../../../../providers/llm/types";

describe("formatTurnContext", () => {
  test("appends time, speaker, and roster", () => {
    const date = new Date(2026, 7, 16, 14, 30); // 16 aug 2026, 14:30
    expect(
      formatTurnContext(
        { userId: "alice", aliases: ["al"], joinedAt: 0 },
        [{ userId: "alice", aliases: ["al"], joinedAt: 0 }],
        date,
      ),
    ).toBe(
      "\n\nAdditional context: Now it is 16 aug 2026, 14:30. " +
        "The current user is al with user id alice (aliases: al).",
    );
    expect(
      formatTurnContext(
        { userId: "alice", aliases: ["al"], joinedAt: 0 },
        [
          { userId: "alice", aliases: ["al"], joinedAt: 0 },
          { userId: "bob", aliases: ["robert", "rob"], joinedAt: 0 },
        ],
        date,
      ),
    ).toBe(
      "\n\nAdditional context: Now it is 16 aug 2026, 14:30. " +
        "The current user is al with user id alice (aliases: al). " +
        "The other participants are robert with user id bob (aliases: robert, rob).",
    );
  });
});

describe("windowHistory", () => {
  const turn = (n: number) => `User turn number ${n}.`;
  const reply = (n: number) => `Assistant reply ${n}.`;

  /** user/assistant turns 1..n, oldest first. */
  const historyOf = (n: number): LLMMessage[] => {
    const messages: LLMMessage[] = [];
    for (let i = 1; i <= n; i++) {
      messages.push({ role: "user", content: turn(i) });
      messages.push({ role: "assistant", content: reply(i) });
    }
    return messages;
  };

  test("keeps everything when there are fewer user turns than the window", () => {
    const history = historyOf(3);
    expect(windowHistory(history, { maxTurns: 5, maxChars: 10_000 })).toEqual(history);
  });

  test("keeps only the most recent user turns (plus their replies)", () => {
    const windowed = windowHistory(historyOf(7), { maxTurns: 3, maxChars: 10_000 });
    expect(windowed.map((m) => m.content)).toEqual([
      turn(5),
      reply(5),
      turn(6),
      reply(6),
      turn(7),
      reply(7),
    ]);
  });

  test("the character bound drops oldest whole messages but never the current turn", () => {
    // Every turn is ~25 chars; a 90-char bound fits about 3 turns.
    const windowed = windowHistory(historyOf(7), { maxTurns: 5, maxChars: 90 });
    expect(windowed.map((m) => m.content)).toEqual([
      turn(6),
      reply(6),
      turn(7),
      reply(7),
    ]);
    // The current turn (the last user message) always survives.
    expect(windowed.at(-1)!.content).toBe(reply(7));
  });

  test("an empty history stays empty", () => {
    expect(windowHistory([], { maxTurns: 5, maxChars: 4_000 })).toEqual([]);
  });
});

describe("ConversationHistory", () => {
  async function makeConversation(): Promise<Conversation> {
    const conversation = new Conversation({
      id: "conv-1",
      persistence: new MemoryPersistence(),
    });
    await conversation.start();
    await conversation.participate({ userId: "alice", aliases: ["al"] });
    return conversation;
  }

  function makeTurn(text: string, startedAt: number): Turn {
    return {
      id: crypto.randomUUID(),
      conversationId: "conv-1",
      participantId: "alice",
      participantName: "al",
      text,
      sequence: 0,
      startedAt,
      endedAt: startedAt + 50,
    };
  }

  test("addUserTurn and addAssistant build the prompt log", async () => {
    const conversation = await makeConversation();
    const history = new ConversationHistory();
    history.addUserTurn(makeTurn("Hello", 100), conversation);
    history.addAssistant("Jarvis", "Hi!");
    expect(history.all[0]!.role).toBe("user");
    expect(history.all[0]!.content).toContain("Hello");
    // The context suffix (time + speaker) is baked in at history time.
    expect(history.all[0]!.content).toContain("al with user id alice");
    expect(history.all[1]).toEqual({ role: "assistant", name: "Jarvis", content: "Hi!" });
  });

  test("rehydrate merges turns and completed top-level generations in order", async () => {
    const conversation = await makeConversation();
    const history = new ConversationHistory();
    const turns: Turn[] = [
      makeTurn("First", 100),
      makeTurn("Second", 300),
    ];
    const generations: Generation[] = [
      {
        id: "g1",
        conversationId: "conv-1",
        agentName: "Jarvis",
        text: "First reply",
        status: "completed",
        startedAt: 200,
        endedAt: 250,
      },
      {
        id: "g2",
        conversationId: "conv-1",
        agentName: "Helper",
        text: "Sub work",
        status: "completed",
        startedAt: 220,
        endedAt: 240,
        kind: "sub",
      },
      {
        id: "g3",
        conversationId: "conv-1",
        agentName: "Jarvis",
        text: "Partial",
        status: "cancelled",
        startedAt: 400,
        endedAt: 410,
      },
    ];
    history.rehydrate(turns, generations, conversation);

    expect(history.all.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(history.all[1]).toEqual({
      role: "assistant",
      name: "Jarvis",
      content: "First reply",
    });
    // Sub-generations and non-completed generations never rehydrate.
    expect(JSON.stringify(history.all)).not.toContain("Sub work");
    expect(JSON.stringify(history.all)).not.toContain("Partial");
  });

  test("windowed applies the window; false returns everything", async () => {
    const conversation = await makeConversation();
    const history = new ConversationHistory();
    for (let i = 1; i <= 7; i++) {
      history.addUserTurn(makeTurn(`Turn ${i}`, i * 100), conversation);
      history.addAssistant("Jarvis", `Reply ${i}`);
    }

    const windowed = history.windowed({ maxTurns: 3, maxChars: 10_000 });
    expect(windowed).toHaveLength(6); // 3 user turns + 3 replies
    expect(windowed.map((m) => m.content)).toContain("Reply 7");
    expect(windowed.map((m) => m.content)).not.toContain("Turn 1");

    expect(history.windowed(false)).toHaveLength(14);
  });
});
