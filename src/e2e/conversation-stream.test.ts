import { describe, expect, test } from "bun:test";
import { Agent } from "../agents/agent";
import { Conversations } from "../conversations/conversations";
import { ConversationStream } from "../conversations/stream/conversation-stream";
import { MemoryPersistence } from "../persistence/adapters/memory/memory";
import { DeepSeekLLM } from "../providers/llm/adapters/deepseek/deepseek";
import { OpenRouterLLM } from "../providers/llm/adapters/openrouter/openrouter";
import type { LLM } from "../providers/llm/types";

// Live validation of the semantic seam against a real LLM: the conversation
// streams text fragments, ConversationStream turns them into completion
// events, and cancellation reaches the producer. Skipped without a key.
//
//   text-delta ──▶ ConversationStream ──▶ whenItem/when/whenObjectDone ──▶ consumer
//                                                       └── cancel() ──▶ interrupt ──▶ LLM stop

const apiKey = process.env.DEEPSEEK_API_KEY;
const openRouterKey = process.env.OPENROUTER_API_KEY;
const hasKey =
  (typeof apiKey === "string" && apiKey.length > 0) ||
  (typeof openRouterKey === "string" && openRouterKey.length > 0);

function e2e(name: string, fn: () => Promise<void>, timeoutMs = 90_000): void {
  if (hasKey) test(name, fn, timeoutMs);
  else test.skip(name, fn);
}

function makeLlm(): LLM {
  if (openRouterKey) {
    return new OpenRouterLLM({
      apiKey: openRouterKey,
      model: process.env.LLM_MODEL ?? "google/gemini-2.5-flash-lite",
    });
  }
  return new DeepSeekLLM({ apiKey: apiKey!, model: "deepseek-v4-flash" });
}

function modelLabel(): string {
  if (openRouterKey) return process.env.LLM_MODEL ?? "google/gemini-2.5-flash-lite (openrouter)";
  return "deepseek-v4-flash";
}

// Records the first occurrence of each semantic boundary relative to t0, so
// the live run doubles as a per-model TTF report (first fragment, generation
// complete, object done, transcript).
function makeMarks(t0: number): {
  marks: Record<string, number>;
  mark: (name: string) => void;
} {
  const marks: Record<string, number> = {};
  const mark = (name: string) => {
    if (!(name in marks)) marks[name] = Date.now() - t0;
  };
  return { marks, mark };
}

function printTimeline(label: string, marks: Record<string, number>, extra: string[]): void {
  console.log(`\n  model: ${modelLabel()} — ${label}`);
  for (const [name, at] of Object.entries(marks)) {
    console.log(`    ${name.padEnd(20)} @ ${at}ms`);
  }
  for (const line of extra) console.log(`    ${line}`);
}

async function makeConversation(): Promise<{
  conversation: Awaited<ReturnType<Conversations["create"]>>;
}> {
  const api = new Conversations({ persistence: new MemoryPersistence() });
  const conversation = await api.create({
    agents: [
      new Agent({
        name: "Jarvis",
        context: "You are a concise, helpful assistant.",
        llm: makeLlm(),
      }),
    ],
  });
  await conversation.start();
  await conversation.participate({ userId: "alice" });
  return { conversation };
}

describe("ConversationStream live (requires DEEPSEEK_API_KEY or OPENROUTER_API_KEY)", () => {
  e2e("streams a real reply: fragments in order, agent at the first fragment, exactly once", async () => {
    const { conversation } = await makeConversation();

    // Event ordering at the seam: text-delta before generation-complete,
    // transcript after both.
    const order: string[] = [];
    let agentTranscript = "";
    const { marks, mark } = makeMarks(Date.now());
    conversation.on("text-delta", () => {
      mark("text-delta");
      order.push("text-delta");
    });
    conversation.on("generation-complete", () => {
      mark("generation-complete");
      order.push("generation-complete");
    });
    conversation.on("transcript", ({ entry }) => {
      if (entry.speakerKind === "agent") {
        agentTranscript = entry.text;
        mark("transcript");
        order.push("transcript");
      }
    });

    const stream = new ConversationStream(conversation);
    const fragments: string[] = [];
    const objects: Record<string, unknown>[] = [];
    let agent: string | undefined;
    stream.when("agent", (value) => {
      agent = value as string;
      mark("agent");
      order.push("agent");
    });
    stream.whenItem("text", (fragment) => {
      fragments.push(fragment as string);
      mark("first-fragment");
      order.push("item");
    });
    stream.whenObjectDone((object) => {
      objects.push(object);
      mark("object-done");
      order.push("object");
    });

    conversation.send({
      userId: "alice",
      text: "In two or three short sentences, what is Pipeflow?",
    });

    const deadline = Date.now() + 60_000;
    while (objects.length === 0 && Date.now() < deadline) await Bun.sleep(25);
    expect(objects).toHaveLength(1);

    // 1. the first text fragment precedes generation completion;
    // 2. the agent is known when the first fragment arrives;
    // 5. the whole reply still lands as a transcript (no regression);
    // 6. exactly one object.
    expect(order.indexOf("text-delta")).toBeLessThan(order.indexOf("generation-complete"));
    expect(order.indexOf("agent")).toBeLessThan(order.indexOf("item"));
    expect(order.indexOf("generation-complete")).toBeLessThan(order.indexOf("object"));
    expect(order.indexOf("object")).toBeLessThan(order.indexOf("transcript"));
    expect(agent).toBe("Jarvis");
    expect(objects.length).toBe(1);
    expect(objects[0]).toMatchObject({ agent: "Jarvis" });

    // The fragments are the reply text, in order — they reconstruct the
    // generation exactly (invariant: fragments ≡ generation text).
    const joined = fragments.join("");
    expect(joined).toBe(agentTranscript);
    expect(joined.length).toBeGreaterThan(10);
    const lastTranscript = order.filter((o) => o === "transcript");
    expect(lastTranscript).toHaveLength(1);

    stream.dispose();
    await conversation.stop();

    // Per-key timing: when each semantic boundary became available, so the
    // whole-reply vs first-fragment overlap is visible per model.
    printTimeline("whole reply", marks, [
      `overlap (object-done − first-fragment): ${marks["object-done"]! - marks["first-fragment"]!}ms`,
      `fragments: ${fragments.length} (${joined.length} chars)`,
    ]);
  });

  e2e("cancel() interrupts the live generation at the first fragment", async () => {
    let attempt = 0;
    for (;;) {
      attempt++;
      const { conversation } = await makeConversation();
      const stream = new ConversationStream(conversation);
      let objects = 0;
      const { marks, mark } = makeMarks(Date.now());
      const fragments: string[] = [];
      stream.whenItem("text", (fragment) => {
        fragments.push(fragment as string);
        mark("first-fragment");
        if (objects === 0) stream.cancel(); // enough: abort the generation
      });
      stream.whenObjectDone(() => {
        objects++;
      });

      conversation.send({
        userId: "alice",
        text: "Write a short essay about the history of realtime voice computing.",
      });

      // 4. cancellation reaches the producer: interrupt() removes the current
      // generation (state.currentGeneration → null). Wait for the generation
      // to start streaming, then for it to disappear.
      const deadline = Date.now() + 60_000;
      let sawStreaming = false;
      let outcome: "cancelled" | "completed" | "timeout" = "timeout";
      while (Date.now() < deadline) {
        const generation = conversation.state.currentGeneration;
        if (generation !== null && generation.status === "streaming") sawStreaming = true;
        if (sawStreaming && generation === null) {
          mark("generation-gone");
          outcome = "cancelled";
          break;
        }
        if (generation !== null && generation.status === "completed") {
          outcome = "completed";
          break;
        }
        await Bun.sleep(20);
      }

      stream.dispose();
      await conversation.stop();

      if (outcome === "cancelled" && objects === 0) {
        expect(objects).toBe(0);
        // When the first fragment arrived (the cancel moment) and when the
        // producer actually stopped (generation disappeared).
        printTimeline("cancellation", marks, [
          `generation stopped ${marks["generation-gone"]! - marks["first-fragment"]!}ms after cancel`,
          `consumed before cancel: ${fragments.join("").length} chars`,
        ]);
        return;
      }
      // The reply may have finished before the first fragment's handler ran
      // (a very fast generation); retry the arm.
      if (attempt >= 3) {
        throw new Error(
          `cancel did not interrupt the generation (outcome: ${outcome}, objects: ${objects})`,
        );
      }
    }
  });
});
