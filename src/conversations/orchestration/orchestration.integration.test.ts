// Coordination integration: the full chain from a turn through the built-in
// `understand` coordination — delegation to specialists, suspension/resume,
// budgets, and rehydration — exercised through the real Conversation +
// Orchestrator + CoordinationRunner wiring.

import { describe, expect, test } from "bun:test";
import { Agent } from "../../agents/agent";
import { Tool } from "../../agents/tools/tools";
import { Conversation } from "../conversation/conversation";
import { MemoryPersistence } from "../../persistence/adapters/memory/memory";
import { ConversationStream } from "../stream/conversation-stream";
import { Orchestrator } from "./orchestrator/orchestrator";
import { buildClarifyPrompt } from "./coordination/coordination";
import {
  FakeLLM,
  FakeSTT,
  FakeTTS,
  respond,
  setupRoster,
  speak,
  waitFor,
  type LLMScript,
} from "./test-harness";

describe("coordination", () => {
  function understandThatDelegates(tasks: unknown[]): LLMScript {
    return async function* (request) {
      if (request.messages.at(-1)?.role === "tool") {
        yield { type: "delta", content: "I found a 3pm flight and your calendar is free." };
        yield { type: "done" };
        return;
      }
      yield { type: "delta", content: "Let me check both. " };
      yield {
        type: "tool_call",
        id: "call_1",
        name: "delegate",
        arguments: JSON.stringify({ action: "agents", tasks }),
      };
      yield { type: "done" };
    };
  }

  test("decomposes a turn across specialist agents and merges the results", async () => {
    const harness = await setupRoster({
      coordinatorScript: understandThatDelegates([
        { agent: "Travel Agent", prompt: "Find flights Paris to London tomorrow morning." },
        { agent: "Calendar Agent", prompt: "Check meetings on Tuesday afternoon." },
      ]),
      scripts: {
        "Travel Agent": respond("Flight at 3pm."),
        "Calendar Agent": respond("Free Tuesday afternoon."),
      },
    });

    await speak(harness, "alice", "Book a flight and check my calendar.");

    // Each specialist ran on its own LLM with its own context, and the
    // dispatched prompt carries a time stamp for temporal context.
    const travel = harness.llms.get("Travel Agent")!;
    const calendar = harness.llms.get("Calendar Agent")!;
    expect(travel.requests).toHaveLength(1);
    expect(calendar.requests).toHaveLength(1);
    const travelPrompt = travel.requests[0]!.messages.at(-1)!;
    expect(travelPrompt.role).toBe("user");
    expect(travelPrompt.content).toContain("Find flights Paris to London tomorrow morning.");
    // The dispatched prompt carries a time stamp for temporal context.
    expect(travelPrompt.content).toMatch(/Now it is \d{1,2} [a-z]{3} \d{4}, \d{2}:\d{2}\.$/);
    expect(travel.requests[0]!.messages[0]).toEqual({
      role: "system",
      name: "Travel Agent",
      content: "You are Travel Agent.",
    });

    // The coordinator resumed with both specialist outputs as the tool
    // result and composed the final answer.
    expect(harness.llm.requests).toHaveLength(2);
    expect(harness.llm.requests[1]!.messages.at(-1)).toEqual({
      role: "tool",
      toolCallId: "call_1",
      name: "delegate",
      content: JSON.stringify([
        { agent: "Travel Agent", text: "Flight at 3pm." },
        { agent: "Calendar Agent", text: "Free Tuesday afternoon." },
      ]),
    });

    // Sub-generations are persisted, attributed, and linked to the
    // coordinator generation that dispatched them.
    const generations = await harness.persistence.listGenerations("conv-1");
    const coordinatorGen = generations.find((g) => g.agentName === "Jarvis")!;
    const subGens = generations.filter((g) => g.kind === "sub");
    expect(subGens).toHaveLength(2);
    expect(subGens.map((g) => [g.agentName, g.text, g.status])).toEqual([
      ["Travel Agent", "Flight at 3pm.", "completed"],
      ["Calendar Agent", "Free Tuesday afternoon.", "completed"],
    ]);
    for (const sub of subGens) {
      expect(sub.parentGenerationId).toBe(coordinatorGen.id);
    }
    expect(coordinatorGen.status).toBe("completed");
    // The generation accumulates the narration and the merged answer.
    expect(coordinatorGen.text).toBe(
      "Let me check both. I found a 3pm flight and your calendar is free.",
    );

    // Transcript: user turn, each specialist's work, then the merged answer.
    const transcript = await harness.persistence.listTranscript("conv-1");
    expect(transcript.map((e) => e.toString())).toEqual([
      "al: Book a flight and check my calendar.",
      "Travel Agent: Flight at 3pm.",
      "Calendar Agent: Free Tuesday afternoon.",
      "Jarvis: Let me check both. I found a 3pm flight and your calendar is free.",
    ]);

    // The coordinator narrated while the specialists worked, then spoke
    // the merged answer. Specialists are text-only.
    expect(harness.tts.requests.map((r) => r.text)).toEqual([
      "Let me check both.",
      "I found a 3pm flight and your calendar is free.",
    ]);
  });

  test("delegated specialists do not terminate the top-level reply stream", async () => {
    const harness = await setupRoster({
      coordinatorScript: understandThatDelegates([
        { agent: "Travel Agent", prompt: "Find flights." },
      ]),
      scripts: { "Travel Agent": respond("Flight at 3pm.") },
    });

    const stream = new ConversationStream(harness.conversation);
    const objects: Record<string, unknown>[] = [];
    const fragments: string[] = [];
    stream.whenItem("text", (fragment) => fragments.push(fragment as string));
    stream.whenObjectDone((object) => objects.push(object));

    await speak(harness, "alice", "Book a flight.");

    // One top-level object spanning the delegation: narration before the
    // tool call and the merged answer after. The specialist's own
    // transcript (an agent-kind transcript) must not terminate it — only
    // the coordinator's generation completion does.
    expect(objects).toHaveLength(1);
    expect(objects[0]).toEqual({
      agent: "Jarvis",
      text: ["Let me check both. ", "I found a 3pm flight and your calendar is free."],
    });
    expect(fragments).toEqual([
      "Let me check both. ",
      "I found a 3pm flight and your calendar is free.",
    ]);
    stream.dispose();
  });

  test("runs dispatched specialists in parallel", async () => {
    const reached: string[] = [];
    const waitForBoth = async () => {
      for (let i = 0; i < 2000; i++) {
        if (reached.length >= 2) return;
        await Bun.sleep(1);
      }
      throw new Error("specialists did not run in parallel");
    };

    const harness = await setupRoster({
      coordinatorScript: understandThatDelegates([
        { agent: "Travel Agent", prompt: "Find flights." },
        { agent: "Calendar Agent", prompt: "Check meetings." },
      ]),
      scripts: {
        "Travel Agent": async function* () {
          reached.push("travel");
          await waitForBoth();
          yield { type: "delta", content: "Flight at 3pm." };
          yield { type: "done" };
        },
        "Calendar Agent": async function* () {
          reached.push("calendar");
          await waitForBoth();
          yield { type: "delta", content: "Calendar is free." };
          yield { type: "done" };
        },
      },
    });

    // If the tasks ran serially, the first specialist would wait forever
    // for the second and the test would time out.
    await speak(harness, "alice", "Plan my trip.");

    expect(reached.sort()).toEqual(["calendar", "travel"]);
    expect(harness.llms.get("Travel Agent")!.requests).toHaveLength(1);
    expect(harness.llms.get("Calendar Agent")!.requests).toHaveLength(1);
    expect(harness.llm.requests[1]!.messages.at(-1)?.role).toBe("tool");
  });

  test("records timing on text-only sub-generations", async () => {
    const harness = await setupRoster({
      coordinatorScript: understandThatDelegates([
        { agent: "Travel Agent", prompt: "Find flights." },
      ]),
      scripts: { "Travel Agent": respond("Flight at 3pm.") },
    });

    await speak(harness, "alice", "Book a flight.");

    const sub = (await harness.persistence.listGenerations("conv-1")).find(
      (g) => g.kind === "sub",
    )!;
    expect(sub.timing?.firstTokenAt).toBeDefined();
    expect(sub.timing?.completedAt).toBeDefined();
    // Sub-agents are text-only: no TTS text, request, or audio is ever
    // recorded for them.
    expect(sub.timing?.firstTtsTextAt).toBeUndefined();
    expect(sub.timing?.firstTtsRequestAt).toBeUndefined();
    expect(sub.timing?.firstAudioAt).toBeUndefined();
  });

  test("auto-executes dispatched specialists' tools", async () => {
    let scheduleRuns = 0;
    const getSchedule = new Tool({
      name: "get_schedule",
      description: "Get the day's schedule.",
      execute: async () => {
        scheduleRuns++;
        return "free Tuesday afternoon";
      },
    });

    const harness = await setupRoster({
      coordinatorScript: understandThatDelegates([
        { agent: "Calendar Agent", prompt: "Check Tuesday afternoon." },
      ]),
      scripts: {
        "Calendar Agent": async function* (request) {
          if (request.messages.at(-1)?.role === "tool") {
            yield { type: "delta", content: "Tuesday afternoon is free." };
            yield { type: "done" };
            return;
          }
          yield {
            type: "tool_call",
            id: "call_c1",
            name: "get_schedule",
            arguments: "{}",
          };
          yield { type: "done" };
        },
      },
      tools: { "Calendar Agent": [getSchedule] },
    });

    // Visibility only: no app handler resolves the call — the framework
    // runs the specialist's tool and feeds its result back.
    const toolCalls: string[] = [];
    harness.conversation.on("tool-call", (payload) => {
      toolCalls.push(payload.call.name);
    });

    await speak(harness, "alice", "Check my Tuesday.");

    // The specialist's tool was surfaced for visibility and auto-executed
    // exactly once by the framework.
    expect(toolCalls).toEqual(["get_schedule"]);
    expect(scheduleRuns).toBe(1);
    const calendar = harness.llms.get("Calendar Agent")!;
    expect(calendar.requests).toHaveLength(2);
    expect(calendar.requests[1]!.messages.at(-1)).toEqual({
      role: "tool",
      toolCallId: "call_c1",
      name: "get_schedule",
      content: '"free Tuesday afternoon"',
    });

    // The coordinator merged the specialist's findings.
    expect(harness.llm.requests[1]!.messages.at(-1)).toMatchObject({
      role: "tool",
      name: "delegate",
    });
    expect(
      JSON.parse(
        (harness.llm.requests[1]!.messages.at(-1) as { content: string }).content,
      ),
    ).toEqual([{ agent: "Calendar Agent", text: "Tuesday afternoon is free." }]);
  });

  test("a delegate to an unknown agent reports an error the coordinator can recover from", async () => {
    const harness = await setupRoster({
      coordinatorScript: async function* (request) {
        if (request.messages.at(-1)?.role === "tool") {
          yield { type: "delta", content: "I could not reach that service." };
          yield { type: "done" };
          return;
        }
        yield {
          type: "tool_call",
          id: "call_1",
          name: "delegate",
          arguments: JSON.stringify({
            action: "agents",
            tasks: [{ agent: "Ghost Agent", prompt: "Do the thing." }],
          }),
        };
        yield { type: "done" };
      },
      scripts: {},
    });

    await speak(harness, "alice", "Do the thing.");

    const delegateResult = harness.llm.requests[1]!.messages.at(-1) as {
      content: string;
    };
    // The strict roster enum rejects the unknown agent, and the
    // coordination recovers from the reported error.
    expect(JSON.parse(delegateResult.content)).toEqual({
      error: expect.stringContaining("invalid delegate arguments") as unknown,
    });
    expect(harness.llm.requests[1]!.messages.at(-1)).toMatchObject({
      role: "tool",
      name: "delegate",
    });

    // No sub-generation was created, and the coordinator still completed.
    const generations = await harness.persistence.listGenerations("conv-1");
    expect(generations.filter((g) => g.kind === "sub")).toHaveLength(0);
    expect(generations[0]?.status).toBe("completed");
    expect(generations[0]?.text).toBe("I could not reach that service.");
  });

  test("malformed delegate arguments surface the parse error instead of crashing", async () => {
    const harness = await setupRoster({
      coordinatorScript: async function* (request) {
        if (request.messages.at(-1)?.role === "tool") {
          yield { type: "delta", content: "Let me rephrase that." };
          yield { type: "done" };
          return;
        }
        yield {
          type: "tool_call",
          id: "call_1",
          name: "delegate",
          arguments: "{not json",
        };
        yield { type: "done" };
      },
      scripts: {},
    });

    await speak(harness, "alice", "Do the thing.");

    const delegateResult = harness.llm.requests[1]!.messages.at(-1) as {
      content: string;
    };
    expect(JSON.parse(delegateResult.content)).toEqual({
      error: "delegate arguments must be valid JSON",
    });
    expect(harness.llm.requests[1]!.messages.at(-1)).toMatchObject({
      role: "tool",
      name: "delegate",
    });
  });

  test("interrupt cancels in-flight sub-generations", async () => {
    let travelCalls = 0;
    const harness = await setupRoster({
      coordinatorScript: understandThatDelegates([
        { agent: "Travel Agent", prompt: "Find flights." },
      ]),
      scripts: {
        "Travel Agent": async function* (_request, signal) {
          const n = travelCalls++;
          if (n === 0) {
            yield { type: "delta", content: "Looking up flights..." };
            while (!signal.aborted) await Bun.sleep(2);
            throw new DOMException("The operation was aborted.", "AbortError");
          }
          yield { type: "delta", content: "Flight at 5pm." };
          yield { type: "done" };
        },
      },
    });

    harness.conversation.listen({ userId: "alice", audio: new Uint8Array([1]) });
    harness.stt.sessions[0]!.emitFinal("Book me a flight.");
    await waitFor(() => harness.llms.get("Travel Agent")!.requests.length === 1);

    harness.conversation.interrupt();
    await harness.orchestrator.whenIdle();

    // The coordinator generation and the in-flight sub-generation were
    // both cancelled, not completed.
    const generations = await harness.persistence.listGenerations("conv-1");
    const coordinatorGen = generations.find((g) => g.agentName === "Jarvis")!;
    const subGen = generations.find((g) => g.kind === "sub")!;
    expect(coordinatorGen.status).toBe("cancelled");
    expect(subGen.status).toBe("cancelled");
    expect(subGen.parentGenerationId).toBe(coordinatorGen.id);

    // A fresh turn works after the interrupt: the coordinator re-dispatches
    // and a new sub-generation completes.
    harness.stt.sessions[0]!.emitFinal("Actually, book it for tomorrow.");
    await harness.orchestrator.whenIdle();
    const travel = harness.llms.get("Travel Agent")!;
    expect(travel.requests).toHaveLength(2);
    const after = await harness.persistence.listGenerations("conv-1");
    const subGens = after.filter((g) => g.kind === "sub");
    expect(subGens).toHaveLength(2);
    expect(subGens[1]?.status).toBe("completed");
    expect(subGens[1]?.text).toBe("Flight at 5pm.");
  });

  test("asks the user a clarifying question, suspends, and resumes with the answer", async () => {
    let calls = 0;
    const harness = await setupRoster({
      coordinatorScript: async function* () {
        const n = calls++;
        if (n === 0) {
          yield { type: "delta", content: "Which airport would you like to fly from? " };
          yield {
            type: "tool_call",
            id: "call_1",
            name: "delegate",
            arguments: JSON.stringify({
              action: "user",
              question: "Which airport would you like to fly from?",
            }),
          };
          yield { type: "done" };
          return;
        }
        yield { type: "delta", content: "Booking your flight from CDG. " };
        yield { type: "done" };
      },
      scripts: {},
    });

    await speak(harness, "alice", "Book me a flight.");

    // The question was spoken, recorded, and the execution parked.
    const transcript = await harness.persistence.listTranscript("conv-1");
    expect(transcript.map((e) => e.toString())).toEqual([
      "al: Book me a flight.",
      "Jarvis: Which airport would you like to fly from?",
    ]);
    expect(harness.tts.requests.map((r) => r.text)).toEqual([
      "Which airport would you like to fly from?",
    ]);

    // The user's answer resumes the same coordination instead of starting a
    // fresh generation, and the final answer is recorded.
    await speak(harness, "alice", "CDG.");

    const finalTranscript = await harness.persistence.listTranscript("conv-1");
    expect(finalTranscript.map((e) => e.toString())).toEqual([
      "al: Book me a flight.",
      "Jarvis: Which airport would you like to fly from?",
      "al: CDG.",
      "Jarvis: Booking your flight from CDG.",
    ]);
    const generations = await harness.persistence.listGenerations("conv-1");
    expect(generations.map((g) => [g.agentName, g.text, g.status])).toEqual([
      ["Jarvis", "Which airport would you like to fly from?", "completed"],
      ["Jarvis", "Booking your flight from CDG.", "completed"],
    ]);
  });

  test("speech while waiting for an answer resumes the coordination instead of interrupting it", async () => {
    let calls = 0;
    const harness = await setupRoster({
      coordinatorScript: async function* () {
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
        yield { type: "delta", content: "Flying to London. " };
        yield { type: "done" };
      },
      scripts: {},
    });

    await speak(harness, "alice", "Book a flight.");

    // The participant starts speaking while the question is pending. This
    // is the answer, not a barge-in: nothing is interrupted.
    harness.conversation.listen({ userId: "alice", audio: new Uint8Array([2, 2]) });
    harness.stt.sessions[0]!.emitFinal("London.");
    await harness.orchestrator.whenIdle();

    const generations = await harness.persistence.listGenerations("conv-1");
    // The question generation completed; the resumed answer completed.
    // Nothing was cancelled.
    expect(generations.map((g) => g.status)).toEqual(["completed", "completed"]);
    expect(generations.at(-1)?.text).toBe("Flying to London.");
    expect(generations.filter((g) => g.status === "cancelled")).toHaveLength(0);
  });

  test("a text turn resumes a pending coordination question", async () => {
    let calls = 0;
    const harness = await setupRoster({
      coordinatorScript: async function* () {
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
        yield { type: "delta", content: "Flying to London. " };
        yield { type: "done" };
      },
      scripts: {},
    });

    await speak(harness, "alice", "Book a flight.");

    // The answer arrives as a text turn (send) instead of speech: the
    // parked coordination resumes, nothing is interrupted.
    harness.conversation.send({ userId: "alice", text: "London." });
    await harness.orchestrator.whenIdle();

    const generations = await harness.persistence.listGenerations("conv-1");
    expect(generations.map((g) => [g.text, g.status])).toEqual([
      ["Which city?", "completed"],
      ["Flying to London.", "completed"],
    ]);
    expect(generations.filter((g) => g.status === "cancelled")).toHaveLength(0);
    const transcript = await harness.persistence.listTranscript("conv-1");
    expect(transcript.map((e) => e.toString())).toEqual([
      "al: Book a flight.",
      "Jarvis: Which city?",
      "al: London.",
      "Jarvis: Flying to London.",
    ]);
  });

  test("delegates to a registered coordination and merges its output", async () => {
    const resolveLlm = new FakeLLM(respond("The flight departs at 3pm."));
    const harness = await setupRoster({
      coordinatorScript: async function* (request) {
        if (request.messages.at(-1)?.role === "tool") {
          yield { type: "delta", content: "Your flight is confirmed." };
          yield { type: "done" };
          return;
        }
        yield {
          type: "tool_call",
          id: "call_1",
          name: "delegate",
          arguments: JSON.stringify({
            action: "coordination",
            coordination: "resolve-details",
            input: { prompt: "Find the flight details." },
          }),
        };
        yield { type: "done" };
      },
      scripts: {},
      coordinations: {
        "resolve-details": { prompt: "You resolve details.", llm: resolveLlm },
      },
    });

    await speak(harness, "alice", "Book my flight.");

    // The nested coordination asked the question; the whole stack parked.
    // The sub-coordination ran on its own LLM with its own prompt and input.
    expect(resolveLlm.requests).toHaveLength(1);
    expect(resolveLlm.requests[0]!.messages[0]).toEqual({
      role: "system",
      name: "resolve-details",
      content: "You resolve details.",
    });
    expect(resolveLlm.requests[0]!.messages.at(-1)).toEqual({
      role: "user",
      content: JSON.stringify({ prompt: "Find the flight details." }),
    });

    // Its output came back as the delegate tool result, and the understand
    // coordination merged it into the final answer.
    expect(harness.llm.requests).toHaveLength(2);
    expect(harness.llm.requests[1]!.messages.at(-1)).toEqual({
      role: "tool",
      toolCallId: "call_1",
      name: "delegate",
      content: JSON.stringify("The flight departs at 3pm."),
    });
    const transcript = await harness.persistence.listTranscript("conv-1");
    expect(transcript.at(-1)?.toString()).toBe("Jarvis: Your flight is confirmed.");
  });

  test("a suspension inside a nested coordination resumes both frames", async () => {
    let resolveCalls = 0;
    const resolveLlm = new FakeLLM(async function* () {
      const n = resolveCalls++;
      if (n === 0) {
        yield { type: "delta", content: "Which city? " };
        yield {
          type: "tool_call",
          id: "call_u1",
          name: "delegate",
          arguments: JSON.stringify({ action: "user", question: "Which city?" }),
        };
        yield { type: "done" };
        return;
      }
      yield { type: "delta", content: "CDG flight found." };
      yield { type: "done" };
    });
    const harness = await setupRoster({
      coordinatorScript: async function* (request) {
        if (request.messages.at(-1)?.role === "tool") {
          yield { type: "delta", content: "Final: flight at 3pm." };
          yield { type: "done" };
          return;
        }
        yield {
          type: "tool_call",
          id: "call_1",
          name: "delegate",
          arguments: JSON.stringify({
            action: "coordination",
            coordination: "resolve-details",
            input: { prompt: "Find flights." },
          }),
        };
        yield { type: "done" };
      },
      scripts: {},
      coordinations: {
        "resolve-details": { prompt: "You resolve details.", llm: resolveLlm },
      },
    });

    await speak(harness, "alice", "Book my flight.");

    // The nested coordination asked the question; the whole stack parked.
    const transcript = await harness.persistence.listTranscript("conv-1");
    expect(transcript.map((e) => e.toString())).toEqual([
      "al: Book my flight.",
      "Jarvis: Which city?",
    ]);
    expect(resolveLlm.requests).toHaveLength(1);
    expect(harness.llm.requests).toHaveLength(1);

    // The answer resumes the innermost frame; its output propagates back
    // through the parent frame to the final merged answer.
    await speak(harness, "alice", "Paris.");

    expect(resolveLlm.requests).toHaveLength(2);
    expect(harness.llm.requests).toHaveLength(2);
    const finalTranscript = await harness.persistence.listTranscript("conv-1");
    expect(finalTranscript.map((e) => e.toString())).toEqual([
      "al: Book my flight.",
      "Jarvis: Which city?",
      "al: Paris.",
      "Jarvis: Final: flight at 3pm.",
    ]);
    const generations = await harness.persistence.listGenerations("conv-1");
    expect(generations.map((g) => [g.agentName, g.text, g.status])).toEqual([
      ["Jarvis", "Which city?", "completed"],
      ["Jarvis", "Final: flight at 3pm.", "completed"],
    ]);
  });

  test("clarify acquires missing information through questions and reassessment", async () => {
    let clarifyCalls = 0;
    const clarifyLlm = new FakeLLM(async function* () {
      const n = clarifyCalls++;
      if (n === 0) {
        // Asks exactly ONE question first.
        yield {
          type: "tool_call",
          id: "call_q",
          name: "delegate",
          arguments: JSON.stringify({
            action: "user",
            question: "Which city are you flying to?",
          }),
        };
        yield { type: "done" };
        return;
      }
      // The answer arrived: reassess and complete with the clear request.
      yield {
        type: "tool_call",
        id: "call_c",
        name: "delegate",
        arguments: JSON.stringify({
          action: "complete",
          output: "Book a flight to London.",
        }),
      };
      yield { type: "done" };
    });
    const harness = await setupRoster({
      coordinatorScript: async function* (request) {
        if (request.messages.at(-1)?.role === "tool") {
          yield { type: "delta", content: "Booking your flight to London. " };
          yield { type: "done" };
          return;
        }
        yield {
          type: "tool_call",
          id: "call_1",
          name: "delegate",
          arguments: JSON.stringify({
            action: "coordination",
            coordination: "clarify",
            input: "Book me a flight.",
          }),
        };
        yield { type: "done" };
      },
      scripts: {},
      coordinations: {
        clarify: { prompt: buildClarifyPrompt(), llm: clarifyLlm },
      },
    });

    await speak(harness, "alice", "Book me a flight.");

    // clarify asked its question; the whole stack (understand → clarify)
    // parked, and the question is the recorded generation.
    const transcript = await harness.persistence.listTranscript("conv-1");
    expect(transcript.map((e) => e.toString())).toEqual([
      "al: Book me a flight.",
      "Jarvis: Which city are you flying to?",
    ]);
    expect(clarifyLlm.requests).toHaveLength(1);
    expect(harness.llm.requests).toHaveLength(1);

    // The answer resumes the innermost frame: clarify reassesses, completes
    // with the clarified request, and the parent merges it.
    await speak(harness, "alice", "London.");

    expect(clarifyLlm.requests).toHaveLength(2);
    expect(harness.llm.requests).toHaveLength(2);
    const finalTranscript = await harness.persistence.listTranscript("conv-1");
    expect(finalTranscript.map((e) => e.toString())).toEqual([
      "al: Book me a flight.",
      "Jarvis: Which city are you flying to?",
      "al: London.",
      "Jarvis: Booking your flight to London.",
    ]);
    const generations = await harness.persistence.listGenerations("conv-1");
    expect(generations.map((g) => [g.agentName, g.text, g.status])).toEqual([
      ["Jarvis", "Which city are you flying to?", "completed"],
      ["Jarvis", "Booking your flight to London.", "completed"],
    ]);
  });

  test("the step budget guards runaway delegation", async () => {
    const harness = await setupRoster({
      coordinatorScript: async function* (request) {
        if (request.messages.at(-1)?.role === "tool") {
          yield { type: "delta", content: "Done." };
          yield { type: "done" };
          return;
        }
        yield {
          type: "tool_call",
          id: "call_1",
          name: "delegate",
          arguments: JSON.stringify({
            action: "coordination",
            coordination: "understand",
            input: { prompt: "Again." },
          }),
        };
        yield { type: "done" };
      },
      scripts: {},
      maxCoordinationSteps: 3,
    });
    const errors: Error[] = [];
    harness.conversation.on("error", (payload) => errors.push(payload.error));

    await speak(harness, "alice", "Loop me.");

    // The self-delegation loop was cut off by the budget, surfaced as an
    // error instead of hanging forever.
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.message).toMatch(/coordination steps/);
  });

  test("completes directly with a structured answer", async () => {
    const harness = await setupRoster({
      coordinatorScript: async function* () {
        yield { type: "delta", content: "Here is the answer. " };
        yield {
          type: "tool_call",
          id: "call_1",
          name: "delegate",
          arguments: JSON.stringify({
            action: "complete",
            output: "The weather is sunny.",
          }),
        };
        yield { type: "done" };
      },
      scripts: {},
    });

    await speak(harness, "alice", "What is the weather?");

    // The narration plus the complete output form the final answer.
    const generations = await harness.persistence.listGenerations("conv-1");
    expect(generations[0]?.text).toBe("Here is the answer. The weather is sunny.");
    expect(harness.tts.requests.map((r) => r.text)).toEqual([
      "Here is the answer.",
      "The weather is sunny.",
    ]);
  });

  test("rehydrates history without sub-generations", async () => {
    const persistence = new MemoryPersistence();
    const conversation = new Conversation({ id: "conv-1", persistence });
    await conversation.pushTurn({
      id: "turn-1",
      conversationId: "conv-1",
      participantId: "alice",
      participantName: "alice",
      text: "Hello from before.",
      sequence: 0,
      startedAt: 1,
      endedAt: 2,
    });
    await conversation.pushTranscript({
      speaker: "alice",
      speakerKind: "participant",
      text: "Hello from before.",
    });
    // A completed coordinator response plus the sub-generation it
    // dispatched. Only the coordinator response should rehydrate.
    await conversation.pushGeneration({
      id: "gen-1",
      conversationId: "conv-1",
      agentName: "Jarvis",
      text: "Summary answer.",
      status: "completed",
      startedAt: 3,
      endedAt: 4,
    });
    await conversation.pushSubGeneration({
      id: "gen-2",
      conversationId: "conv-1",
      agentName: "Calendar Agent",
      text: "Free.",
      status: "completed",
      startedAt: 5,
      endedAt: 6,
      kind: "sub",
      parentGenerationId: "gen-1",
    });

    const llm = new FakeLLM(respond("Welcome back!"));
    const stt = new FakeSTT();
    const agent = new Agent({ name: "Jarvis", context: "Be concise.", llm });
    const orchestrator = new Orchestrator({
      conversation,
      agents: [agent],
      llm,
      stt,
      tts: new FakeTTS((text) => [new TextEncoder().encode(text)]),
      persistence,
    });
    conversation.start();
    await conversation.participate({ userId: "alice" });
    await orchestrator.start();

    conversation.listen({ userId: "alice", audio: new Uint8Array([1]) });
    stt.sessions[0]!.emitFinal("Can you continue?");
    await orchestrator.whenIdle();

    // The sub-generation's text is not in history — the coordinator's own
    // summary stands in for it.
    expect(llm.requests[0]!.messages).toEqual([
      { role: "system", name: "Jarvis", content: "Be concise." },
      {
        role: "user",
        content: expect.stringMatching(
          /^alice: Hello from before\.\n\nAdditional context: Now it is \d{1,2} [a-z]{3} \d{4}, \d{2}:\d{2}\. The current user is alice with user id alice\.$/,
        ),
      },
      { role: "assistant", name: "Jarvis", content: "Summary answer." },
      {
        role: "user",
        content: expect.stringMatching(
          /^alice: Can you continue\?\n\nAdditional context: Now it is \d{1,2} [a-z]{3} \d{4}, \d{2}:\d{2}\. The current user is alice with user id alice\.$/,
        ),
      },
    ]);
  });
});
