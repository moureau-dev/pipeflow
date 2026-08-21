import { describe, expect, test } from "bun:test";
import { Agent } from "../../../../agents/agent";
import { Conversation } from "../../../conversation/conversation";
import { MemoryPersistence } from "../../../../persistence/adapters/memory/memory";
import { ConversationHistory } from "../history/history";
import { GenerationRunner } from "../generation/generation";
import { SpeechPipeline } from "../speech/speech";
import { ToolCallManager } from "../tools/tools";
import { CoordinationRunner } from "./coordination-runner";
import type { LLM, LLMEvent } from "../../../../providers/llm/types";
import type { Turn } from "../../../types";

type Script = () => AsyncGenerator<LLMEvent, void, unknown>;

class FakeLLM implements LLM {
  constructor(private readonly script: Script) {}
  async *stream(): AsyncGenerator<LLMEvent> {
    yield* this.script();
  }
  stop(): void {}
}

interface Harness {
  runner: CoordinationRunner;
  conversation: Conversation;
  persistence: MemoryPersistence;
}

async function makeHarness(options: {
  script?: Script;
  agents?: Agent[];
  registrations?: Record<string, { prompt?: string; llm?: FakeLLM }>;
}): Promise<Harness> {
  const persistence = new MemoryPersistence();
  const conversation = new Conversation({ id: "conv-1", persistence });
  const sharedLlm = new FakeLLM(options.script ?? (async function* () {}));
  const agents =
    options.agents ??
    [
      new Agent({ name: "Jarvis", llm: sharedLlm }),
      new Agent({ name: "Helper", llm: new FakeLLM(async function* () {}) }),
    ];

  const runner = new CoordinationRunner({
    conversation,
    agents: () => agents,
    llm: () => sharedLlm,
    history: new ConversationHistory(),
    historyWindow: false,
    speech: new SpeechPipeline({ tts: undefined, conversation, isCurrent: () => true }),
    generation: new GenerationRunner(),
    tools: new ToolCallManager(conversation, 10_000),
    maxCoordinationSteps: 20,
    maxToolIterations: 10,
    currentEpoch: () => 0,
    isCurrent: () => true,
  });
  runner.register(options.registrations ?? {}, agents);
  await conversation.start();
  return { runner, conversation, persistence };
}

function turn(text: string): Turn {
  return {
    id: crypto.randomUUID(),
    conversationId: "conv-1",
    participantId: "alice",
    participantName: "al",
    text,
    sequence: 0,
    startedAt: Date.now(),
    endedAt: Date.now(),
  };
}

describe("CoordinationRunner", () => {
  test("builds the built-in understand for a multi-agent roster", async () => {
    const { runner } = await makeHarness({});
    expect(runner.understand).not.toBeNull();
    expect(runner.coordinations["understand"] ?? null).toBe(runner.understand);
  });

  test("an explicitly registered understand wins", async () => {
    const { runner } = await makeHarness({
      registrations: { understand: { prompt: "custom coordinator" } },
    });
    expect(runner.understand?.prompt).toBe("custom coordinator");
  });

  test("a single-agent roster gets no understand", async () => {
    const { runner } = await makeHarness({
      agents: [new Agent({ name: "Jarvis", llm: new FakeLLM(async function* () {}) })],
    });
    expect(runner.understand).toBeNull();
  });

  test("resume with nothing parked is a no-op", async () => {
    const { runner, persistence } = await makeHarness({});
    await runner.resume(turn("hello"));
    expect(await persistence.listGenerations("conv-1")).toHaveLength(0);
  });

  test("runDefault with no shared LLM is a no-op", async () => {
    const persistence = new MemoryPersistence();
    const conversation = new Conversation({ id: "conv-1", persistence });
    const runner = new CoordinationRunner({
      conversation,
      agents: () => [new Agent({ name: "Jarvis" })],
      llm: () => undefined,
      history: new ConversationHistory(),
      historyWindow: false,
      speech: new SpeechPipeline({ tts: undefined, conversation, isCurrent: () => true }),
      generation: new GenerationRunner(),
      tools: new ToolCallManager(conversation, 10_000),
      maxCoordinationSteps: 20,
      maxToolIterations: 10,
      currentEpoch: () => 0,
      isCurrent: () => true,
    });
    runner.register({}, [new Agent({ name: "Jarvis" })]);
    await conversation.start();
    await runner.runDefault(turn("hi"));
    expect(await persistence.listGenerations("conv-1")).toHaveLength(0);
  });

  test("a user question parks the execution until resumed or cancelled", async () => {
    const { runner, persistence } = await makeHarness({
      script: async function* () {
        yield { type: "delta", content: "Let me check." };
        yield {
          type: "tool_call",
          id: "t1",
          name: "delegate",
          arguments: JSON.stringify({ action: "user", question: "Which city?" }),
        };
        yield { type: "done" };
      },
    });

    await runner.runDefault(turn("book a flight"));
    expect(runner.hasPending()).toBe(true);

    // The question completes the coordination generation.
    const [generation] = await persistence.listGenerations("conv-1");
    expect(generation?.status).toBe("completed");
    expect(generation?.text).toBe("Which city?");

    runner.cancel();
    expect(runner.hasPending()).toBe(false);
  });
});
