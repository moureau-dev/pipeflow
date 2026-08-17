import { describe, expect, test } from "bun:test";
import { Agent } from "../../../agents/agent";
import type {
  LLM,
  LLMEvent,
  LLMRequest,
  LLMMessage,
} from "../../../providers/llm/types";
import {
  Coordination,
  CoordinationBudgetExceeded,
  CoordinationCancelled,
  CoordinationSuspension,
  delegateToolDefinition,
  parseDelegateAction,
  type CoordinationOptions,
  type CoordinationRuntime,
  type DelegatedTask,
  type DelegationResult,
  type PendingFrame,
} from "./coordination";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type LLMScript = (request: LLMRequest) => AsyncIterable<LLMEvent>;

function respond(text: string): LLMScript {
  return async function* () {
    yield { type: "delta", content: text };
    yield { type: "done" };
  };
}

class FakeLLM implements LLM {
  readonly requests: LLMRequest[] = [];
  constructor(private readonly script: LLMScript) {}
  async *stream(request: LLMRequest): AsyncGenerator<LLMEvent> {
    this.requests.push(request);
    yield* this.script(request);
  }
  stop(): void {}
}

class MockRuntime implements CoordinationRuntime {
  agents: Agent[] = [];
  coordinations: Coordination[] = [];
  llm: LLM = new FakeLLM(respond("ok"));
  history: LLMMessage[] = [];
  readonly delegatedTasks: DelegatedTask[][] = [];
  readonly spoken: string[] = [];
  readonly deltas: string[] = [];
  cancelled = false;
  checkBudget: () => void = () => {};
  delegateResults: (tasks: DelegatedTask[]) => DelegationResult[] = (tasks) =>
    tasks.map((task) => ({ agent: task.agent, text: `result for ${task.agent}` }));

  delegateAgentTasks(tasks: DelegatedTask[]): Promise<DelegationResult[]> {
    this.delegatedTasks.push(tasks);
    return Promise.resolve(this.delegateResults(tasks));
  }

  askUser(frame: PendingFrame, question: string): Promise<never> {
    throw new CoordinationSuspension([frame], question);
  }

  onDelta(delta: string): void {
    this.deltas.push(delta);
  }
  flushSpeech(): void {}
  speak(sentence: string): void {
    this.spoken.push(sentence);
  }
  isCancelled(): boolean {
    return this.cancelled;
  }
}

function makeCoordination(
  runtime: MockRuntime,
  options: Omit<CoordinationOptions, "name"> = {},
): Coordination {
  return new Coordination({ name: "understand", ...options }, runtime);
}

/** Run and capture the CoordinationSuspension (or fail). */
async function captureSuspension(
  run: Promise<unknown>,
): Promise<CoordinationSuspension> {
  try {
    await run;
  } catch (error) {
    if (error instanceof CoordinationSuspension) return error;
    throw error;
  }
  throw new Error("expected a CoordinationSuspension");
}

// ---------------------------------------------------------------------------
// Delegate tool contract
// ---------------------------------------------------------------------------

describe("delegate tool contract", () => {
  const runtime = new MockRuntime();
  const travel = new Agent({ name: "Travel Agent", aliases: ["travel"] });
  const helper = new Agent({ name: "Helper" });
  const resolve = new Coordination({ name: "resolve", prompt: "p" }, runtime);

  test("generates a flattened parameters schema with roster enums", () => {
    const definition = delegateToolDefinition([travel, helper], [resolve]);
    const params = definition.parameters as {
      type: string;
      properties: Record<string, any>;
      required: string[];
    };
    expect(definition.name).toBe("delegate");
    expect(params.type).toBe("object");
    expect(params.required).toEqual(["action"]);
    expect(params.properties.action.enum).toEqual([
      "agents",
      "coordination",
      "clarify",
      "user",
      "complete",
    ]);
    expect(params.properties.tasks.items.properties.agent.enum).toEqual([
      "Travel Agent",
      "travel",
      "Helper",
    ]);
    expect(params.properties.coordination.enum).toEqual(["resolve"]);
    expect("$schema" in params).toBe(false);
  });

  test("falls back to plain strings when there are no targets", () => {
    const definition = delegateToolDefinition([], []);
    const properties = (definition.parameters as any).properties;
    expect(properties.tasks.items.properties.agent.enum).toBeUndefined();
    expect(properties.coordination.enum).toBeUndefined();
  });

  test("parses every valid delegate action", () => {
    const agents = [travel, helper];
    const coordinations = [resolve];
    expect(
      parseDelegateAction(
        JSON.stringify({
          action: "agents",
          tasks: [{ agent: "Travel Agent", prompt: "Find flights." }],
        }),
        agents,
        coordinations,
      ),
    ).toEqual({
      action: "agents",
      tasks: [{ agent: "Travel Agent", prompt: "Find flights." }],
    });
    expect(
      parseDelegateAction(
        JSON.stringify({
          action: "coordination",
          coordination: "resolve",
          input: { prompt: "Details." },
        }),
        agents,
        coordinations,
      ),
    ).toEqual({
      action: "coordination",
      coordination: "resolve",
      input: { prompt: "Details." },
    });
    // Input is optional for coordination delegation.
    expect(
      parseDelegateAction(
        JSON.stringify({ action: "coordination", coordination: "resolve" }),
        agents,
        coordinations,
      ),
    ).toEqual({ action: "coordination", coordination: "resolve" });
    // Strings are trimmed.
    expect(
      parseDelegateAction(
        JSON.stringify({ action: "user", question: "  Which city?  " }),
        agents,
        coordinations,
      ),
    ).toEqual({ action: "user", question: "Which city?" });
    // Clarify batches the missing details; entries are trimmed.
    expect(
      parseDelegateAction(
        JSON.stringify({
          action: "clarify",
          missing: [" departure ", "destination", "date"],
        }),
        agents,
        coordinations,
      ),
    ).toEqual({ action: "clarify", missing: ["departure", "destination", "date"] });
    expect(
      parseDelegateAction(
        JSON.stringify({ action: "complete", output: "Done." }),
        agents,
        coordinations,
      ),
    ).toEqual({ action: "complete", output: "Done." });
  });

  test("rejects malformed delegate arguments with actionable errors", () => {
    const agents = [travel, helper];
    const invalid = [
      "{not json",
      JSON.stringify({ action: "nope" }),
      JSON.stringify({ action: "agents", tasks: [] }),
      JSON.stringify({ action: "agents", tasks: [{ agent: "Travel Agent" }] }),
      JSON.stringify({ action: "agents", tasks: [{ prompt: "No agent." }] }),
      JSON.stringify({ action: "agents", tasks: [{ agent: "Ghost", prompt: "x" }] }),
      JSON.stringify({ action: "user", question: "   " }),
      JSON.stringify({ action: "complete", output: "" }),
      JSON.stringify({ action: "coordination" }),
    ];
    for (const raw of invalid) {
      expect(() => parseDelegateAction(raw, agents, [])).toThrow(/delegate/);
    }
    // The unknown agent reports the roster expectation.
    expect(() =>
      parseDelegateAction(
        JSON.stringify({ action: "agents", tasks: [{ agent: "Ghost", prompt: "x" }] }),
        agents,
        [],
      ),
    ).toThrow(/invalid delegate arguments/);
  });
});

// ---------------------------------------------------------------------------
// Coordination loop
// ---------------------------------------------------------------------------

describe("Coordination", () => {
  test("answers directly when the LLM produces no tool call", async () => {
    const runtime = new MockRuntime();
    const llm = new FakeLLM(respond("It is sunny."));
    const coordination = makeCoordination(runtime, {
      prompt: "You coordinate.",
      llm,
    });

    const output = await coordination.run("What's the weather?");

    expect(output).toBe("It is sunny.");
    expect(runtime.deltas.join("")).toBe("It is sunny.");
    expect(runtime.delegatedTasks).toHaveLength(0);
    // The LLM saw the coordination's system prompt, the shared history, and
    // the user input, with the delegate tool available.
    expect(llm.requests[0]!.messages[0]).toEqual({
      role: "system",
      name: "understand",
      content: "You coordinate.",
    });
    expect(llm.requests[0]!.messages.at(-1)).toEqual({
      role: "user",
      content: "What's the weather?",
    });
    expect(llm.requests[0]!.tools?.[0]?.name).toBe("delegate");
  });

  test("seeds the shared history and skips the input message when none is given", async () => {
    const runtime = new MockRuntime();
    runtime.history = [{ role: "user", content: "al: earlier turn" }];
    const llm = new FakeLLM(respond("ok"));
    const coordination = makeCoordination(runtime, { llm });

    await coordination.run();

    expect(llm.requests[0]!.messages).toEqual([
      { role: "user", content: "al: earlier turn" },
    ]);
  });

  test("delegates to agents and feeds their results back into the loop", async () => {
    const runtime = new MockRuntime();
    const llm = new FakeLLM(async function* (request) {
      if (request.messages.at(-1)?.role === "tool") {
        yield { type: "delta", content: "Final answer." };
        yield { type: "done" };
        return;
      }
      yield { type: "delta", content: "Let me check. " };
      yield {
        type: "tool_call",
        id: "call_1",
        name: "delegate",
        arguments: JSON.stringify({
          action: "agents",
          tasks: [{ agent: "Travel Agent", prompt: "Find flights." }],
        }),
      };
      yield { type: "done" };
    });
    const coordination = makeCoordination(runtime, { llm });

    const output = await coordination.run("Book a flight.");

    expect(output).toBe("Let me check. Final answer.");
    expect(runtime.delegatedTasks).toEqual([
      [{ agent: "Travel Agent", prompt: "Find flights." }],
    ]);
    // The delegation result came back as the tool message.
    expect(llm.requests[1]!.messages.at(-1)).toEqual({
      role: "tool",
      toolCallId: "call_1",
      name: "delegate",
      content: JSON.stringify([
        { agent: "Travel Agent", text: "result for Travel Agent" },
      ]),
    });
  });

  test("asks the user, suspends with a resumable frame, and resumes with the answer", async () => {
    let calls = 0;
    const runtime = new MockRuntime();
    const llm = new FakeLLM(async function* () {
      const n = calls++;
      if (n === 0) {
        yield { type: "delta", content: "Which city? " };
        yield {
          type: "tool_call",
          id: "call_1",
          name: "delegate",
          arguments: JSON.stringify({ action: "user", question: "Which city?" }),
        };
        yield { type: "done" };
        return;
      }
      yield { type: "delta", content: "Flying to Paris. " };
      yield { type: "done" };
    });
    const coordination = makeCoordination(runtime, { llm });

    const suspension = await captureSuspension(coordination.run("Book a flight."));

    expect(suspension.question).toBe("Which city?");
    expect(suspension.frames).toHaveLength(1);
    expect(suspension.frames[0]!.coordination).toBe(coordination);

    // The user's answer resumes the same state; the pre-suspension narration
    // was already recorded as the question, so only the new narration counts.
    const state = suspension.frames[0]!.state;
    const output = await coordination.resume(state, "Paris.");

    expect(output).toBe("Flying to Paris.");
    // The parked state carries a tool response for the delegate call (providers
    // reject unanswered assistant tool_calls), then the user's answer.
    expect(llm.requests[1]!.messages.at(-1)).toEqual({
      role: "user",
      content: "Paris.",
    });
    expect(llm.requests[1]!.messages.at(-2)).toEqual({
      role: "tool",
      toolCallId: "call_1",
      name: "delegate",
      content: JSON.stringify({ action: "user", question: "Which city?" }),
    });
    expect(llm.requests[1]!.messages.at(-3)).toMatchObject({
      role: "assistant",
      toolCalls: [{ id: "call_1", name: "delegate" }],
    });
  });

  test("clarify suspends with a rendered batched question and speaks it", async () => {
    const runtime = new MockRuntime();
    const llm = new FakeLLM(async function* () {
      yield {
        type: "tool_call",
        id: "call_c",
        name: "delegate",
        arguments: JSON.stringify({
          action: "clarify",
          missing: ["departure city", "destination", "date", "number of passengers"],
        }),
      };
      yield { type: "done" };
    });
    const coordination = makeCoordination(runtime, { llm });

    const suspension = await captureSuspension(coordination.run("Book a flight."));

    // The framework renders the question from the missing list (one batched
    // round-trip, not one question per missing detail) and speaks it.
    expect(suspension.question).toBe(
      "Before I continue, could you tell me: departure city, destination, date, and number of passengers?",
    );
    expect(runtime.spoken).toContain(suspension.question);
    // The parked state carries the structured clarify tool response.
    expect(suspension.frames[0]!.state.messages.at(-1)).toEqual({
      role: "tool",
      toolCallId: "call_c",
      name: "delegate",
      content: JSON.stringify({
        action: "clarify",
        missing: ["departure city", "destination", "date", "number of passengers"],
      }),
    });
  });

  test("clarify rounds are capped deterministically, then the coordination completes with assumptions", async () => {
    let calls = 0;
    const runtime = new MockRuntime();
    const llm = new FakeLLM(async function* () {
      const n = calls++;
      if (n === 0 || n === 1) {
        yield {
          type: "tool_call",
          id: `call_${n}`,
          name: "delegate",
          arguments: JSON.stringify({ action: "clarify", missing: ["the date"] }),
        };
        yield { type: "done" };
        return;
      }
      yield { type: "delta", content: "I'll assume tomorrow. " };
      yield {
        type: "tool_call",
        id: "call_done",
        name: "delegate",
        arguments: JSON.stringify({ action: "complete", output: "Booked for tomorrow." }),
      };
      yield { type: "done" };
    });
    // Cap at one round: the first clarify suspends, the second is refused.
    const coordination = makeCoordination(runtime, { llm, maxQuestionRounds: 1 });

    const suspension = await captureSuspension(coordination.run("Book a flight."));
    const state = suspension.frames[0]!.state;
    const output = await coordination.resume(state, "Friday.");

    expect(output).toBe("I'll assume tomorrow. Booked for tomorrow.");
    // Only one suspension happened — the second clarify call was answered with
    // a budget error tool message instead of parking again.
    const secondToolMessage = llm.requests[2]!.messages
      .filter((m) => m.role === "tool" && m.name === "delegate")
      .at(-1);
    expect(JSON.parse(secondToolMessage?.content ?? "{}")).toMatchObject({
      error: expect.stringContaining("question budget exceeded"),
    });
    expect(llm.requests.length).toBe(3); // clarify, resume, complete
  });

  test("open-ended user questions count against the same question-round budget", async () => {
    let calls = 0;
    const runtime = new MockRuntime();
    const llm = new FakeLLM(async function* () {
      const n = calls++;
      if (n === 0 || n === 1) {
        yield {
          type: "tool_call",
          id: `call_${n}`,
          name: "delegate",
          arguments: JSON.stringify({ action: "user", question: "Which city?" }),
        };
        yield { type: "done" };
        return;
      }
      yield {
        type: "tool_call",
        id: "call_done",
        name: "delegate",
        arguments: JSON.stringify({ action: "complete", output: "Paris." }),
      };
      yield { type: "done" };
    });
    const coordination = makeCoordination(runtime, { llm, maxQuestionRounds: 1 });

    const suspension = await captureSuspension(coordination.run("Book a flight."));
    const state = suspension.frames[0]!.state;
    const output = await coordination.resume(state, "London.");

    expect(output).toBe("Paris.");
    // The second user question was refused with a budget error, not parked.
    const lastToolMessage = llm.requests[2]!.messages
      .filter((m) => m.role === "tool" && m.name === "delegate")
      .at(-1);
    expect(JSON.parse(lastToolMessage?.content ?? "{}")).toMatchObject({
      error: expect.stringContaining("question budget exceeded"),
    });
    expect(llm.requests.length).toBe(3); // question, resume, complete
  });

  test("delegates to a registered coordination and merges its output", async () => {
    const runtime = new MockRuntime();
    const subLlm = new FakeLLM(respond("Sub result."));
    const sub = new Coordination(
      { name: "resolve", prompt: "You resolve.", llm: subLlm },
      runtime,
    );
    runtime.coordinations = [sub];

    const llm = new FakeLLM(async function* (request) {
      if (request.messages.at(-1)?.role === "tool") {
        yield { type: "delta", content: "Merged answer. " };
        yield { type: "done" };
        return;
      }
      yield {
        type: "tool_call",
        id: "call_1",
        name: "delegate",
        arguments: JSON.stringify({
          action: "coordination",
          coordination: "resolve",
          input: { prompt: "Details." },
        }),
      };
      yield { type: "done" };
    });
    const coordination = makeCoordination(runtime, { llm });

    const output = await coordination.run("Plan it.");

    expect(output).toBe("Merged answer.");
    // The sub-coordination ran with its own prompt and JSON-serialized input.
    expect(subLlm.requests).toHaveLength(1);
    expect(subLlm.requests[0]!.messages[0]).toEqual({
      role: "system",
      name: "resolve",
      content: "You resolve.",
    });
    expect(subLlm.requests[0]!.messages.at(-1)).toEqual({
      role: "user",
      content: JSON.stringify({ prompt: "Details." }),
    });
    // Its output came back as the parent's tool message.
    expect(llm.requests[1]!.messages.at(-1)).toEqual({
      role: "tool",
      toolCallId: "call_1",
      name: "delegate",
      content: JSON.stringify("Sub result."),
    });
  });

  test("a nested suspension carries the whole frame stack and resumes both frames", async () => {
    const runtime = new MockRuntime();
    let subCalls = 0;
    const subLlm = new FakeLLM(async function* () {
      const n = subCalls++;
      if (n === 0) {
        yield {
          type: "tool_call",
          id: "call_u",
          name: "delegate",
          arguments: JSON.stringify({ action: "user", question: "Which city?" }),
        };
        yield { type: "done" };
        return;
      }
      yield { type: "delta", content: "Paris flight found. " };
      yield { type: "done" };
    });
    const sub = new Coordination(
      { name: "resolve", prompt: "You resolve.", llm: subLlm },
      runtime,
    );
    runtime.coordinations = [sub];

    let parentCalls = 0;
    const parentLlm = new FakeLLM(async function* (request) {
      const n = parentCalls++;
      if (n === 0) {
        yield {
          type: "tool_call",
          id: "call_1",
          name: "delegate",
          arguments: JSON.stringify({
            action: "coordination",
            coordination: "resolve",
            input: { prompt: "Find flights." },
          }),
        };
        yield { type: "done" };
        return;
      }
      yield { type: "delta", content: "Final: done. " };
      yield { type: "done" };
    });
    const coordination = makeCoordination(runtime, {
      prompt: "You coordinate.",
      llm: parentLlm,
    });

    const suspension = await captureSuspension(coordination.run("Book my flight."));

    // Outermost first: understand → resolve.
    expect(suspension.frames.map((frame) => frame.coordination.name)).toEqual([
      "understand",
      "resolve",
    ]);

    // Resume the innermost frame with the user's answer.
    const innermost = suspension.frames.at(-1)!;
    const subOutput = await sub.resume(innermost.state, "Paris.");
    expect(subOutput).toBe("Paris flight found.");

    // Propagate the result back into the parent frame.
    const parentFrame = suspension.frames[0]!;
    const finalOutput = await coordination.continueWith(parentFrame.state, {
      role: "tool",
      toolCallId: parentFrame.state.pendingToolCallId ?? "call_1",
      name: "delegate",
      content: JSON.stringify(subOutput),
    });
    expect(finalOutput).toBe("Final: done.");
  });

  test("a sub-coordination's budget failure is reported as a tool error, not a crash", async () => {
    const runtime = new MockRuntime();
    let budgetCalls = 0;
    runtime.checkBudget = () => {
      budgetCalls++;
      if (budgetCalls > 3) {
        throw new CoordinationBudgetExceeded("exceeded 3 steps");
      }
    };
    const subLlm = new FakeLLM(async function* (request) {
      if (request.messages.at(-1)?.role === "tool") {
        yield { type: "delta", content: "Done." };
        yield { type: "done" };
        return;
      }
      yield {
        type: "tool_call",
        id: "call_s",
        name: "delegate",
        arguments: JSON.stringify({
          action: "coordination",
          coordination: "resolve",
          input: {},
        }),
      };
      yield { type: "done" };
    });
    const sub = new Coordination(
      { name: "resolve", prompt: "p", llm: subLlm },
      runtime,
    );
    runtime.coordinations = [sub];

    // Self-delegation keeps spending steps; the budget cuts it off and the
    // error bubbles up instead of hanging forever.
    await expect(sub.run("go")).rejects.toBeInstanceOf(CoordinationBudgetExceeded);
    expect(budgetCalls).toBeGreaterThan(3);
  });

  test("cancellation aborts the run before the LLM streams", async () => {
    const runtime = new MockRuntime();
    runtime.cancelled = true;
    const llm = new FakeLLM(respond("never used"));
    const coordination = makeCoordination(runtime, { llm });

    await expect(coordination.run("hello")).rejects.toBeInstanceOf(
      CoordinationCancelled,
    );
    expect(llm.requests).toHaveLength(0);
  });

  test("maxDurationMs aborts slow runs", async () => {
    const runtime = new MockRuntime();
    const llm = new FakeLLM(async function* () {
      await Bun.sleep(50);
      yield { type: "delta", content: "late" };
      yield { type: "done" };
    });
    const coordination = makeCoordination(runtime, { llm, maxDurationMs: 5 });

    await expect(coordination.run("hello")).rejects.toBeInstanceOf(
      CoordinationBudgetExceeded,
    );
  });

  test("the complete action speaks its output and returns narration plus output", async () => {
    const runtime = new MockRuntime();
    const llm = new FakeLLM(async function* () {
      yield { type: "delta", content: "Here it is. " };
      yield {
        type: "tool_call",
        id: "c1",
        name: "delegate",
        arguments: JSON.stringify({ action: "complete", output: "The answer." }),
      };
      yield { type: "done" };
    });
    const coordination = makeCoordination(runtime, { llm });

    const output = await coordination.run("What?");

    expect(output).toBe("Here it is. The answer.");
    expect(runtime.spoken).toEqual(["The answer."]);
  });

  test("an unknown coordination is reported as a tool error the LLM can recover from", async () => {
    const runtime = new MockRuntime();
    const llm = new FakeLLM(async function* (request) {
      if (request.messages.at(-1)?.role === "tool") {
        yield { type: "delta", content: "Let me handle it myself. " };
        yield { type: "done" };
        return;
      }
      yield {
        type: "tool_call",
        id: "call_1",
        name: "delegate",
        arguments: JSON.stringify({
          action: "coordination",
          coordination: "ghost",
          input: {},
        }),
      };
      yield { type: "done" };
    });
    const coordination = makeCoordination(runtime, { llm });

    const output = await coordination.run("Do it.");

    expect(output).toBe("Let me handle it myself.");
    expect(llm.requests[1]!.messages.at(-1)).toMatchObject({
      role: "tool",
      content: JSON.stringify({ error: 'Unknown coordination "ghost"' }),
    });
  });
});
