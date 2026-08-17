// Conversation stream benchmark: whole-reply delivery (before) vs StreamObject
// incremental delivery (after) on the same agent reply.
//
// Deterministic: a fake LLM streams a scripted reply over ~1 second, so the
// comparison measures semantic availability, not provider or network latency.
//
//   bun run benchmark:stream

import { Agent } from "../src/agents/agent";
import { Conversations } from "../src/conversations/conversations";
import { ConversationStream } from "../src/conversations/stream/conversation-stream";
import { MemoryPersistence } from "../src/persistence/adapters/memory/memory";
import type { LLM, LLMEvent, LLMRequest } from "../src/providers/llm/types";

const CHUNK_MS = 100;
const REPLY = [
  "The", " quick", " brown", " fox", " jumps", " over", " the", " lazy", " dog.",
] as const;

class SlowLLM implements LLM {
  async *stream(_request: LLMRequest): AsyncGenerator<LLMEvent> {
    for (const chunk of REPLY) {
      await Bun.sleep(CHUNK_MS);
      yield { type: "delta", content: chunk };
    }
    yield { type: "done" };
  }
  stop(): void {}
}

const api = new Conversations({ persistence: new MemoryPersistence() });
const conversation = await api.create({
  agents: [new Agent({ name: "Jarvis", context: "You answer briefly.", llm: new SlowLLM() })],
});

// Before: today's consumer waits for the whole reply (agent transcript event).
let resolveWhole: (t: number) => void = () => {};
const wholeReply = new Promise<number>((resolve) => {
  resolveWhole = resolve;
});
conversation.on("transcript", ({ entry }) => {
  if (entry.speakerKind === "agent") resolveWhole(performance.now());
});

// After: the semantic stream — first item, then the object.
let resolveObject: (t: number) => void = () => {};
const objectDone = new Promise<number>((resolve) => {
  resolveObject = resolve;
});
let firstItemAt = 0;
let itemCount = 0;
let firstItemText = "";
const replies = new ConversationStream(conversation);
replies.whenItem("text", (chunk, index) => {
  itemCount++;
  if (index === 0) {
    firstItemAt = performance.now();
    firstItemText = chunk as string;
  }
});
replies.whenObjectDone(() => resolveObject(performance.now()));

await conversation.start();
await conversation.participate({ userId: "alice" });
const t0 = performance.now();
conversation.send({ userId: "alice", text: "Tell me about the fox." });

const wholeAt = (await wholeReply) - t0;
const objectAt = (await objectDone) - t0;
const firstAt = firstItemAt - t0;

const saved = wholeAt - firstAt;
console.log("\nConversation stream — before vs after (same reply, fake LLM, deterministic):");
console.log("────────────────────────────────────────────────────────────────────────────");
console.log(`  reply: ${REPLY.join("")} (${itemCount} deltas × ${CHUNK_MS}ms)`);
console.log(`  TTF(whole reply)   ${wholeAt.toFixed(0).padStart(7)}ms   before: wait for the agent transcript`);
console.log(`  TTF(first item)    ${firstAt.toFixed(0).padStart(7)}ms   after:  whenItem fires on the first delta`);
console.log(`  TTF(object done)   ${objectAt.toFixed(0).padStart(7)}ms   after:  whenObjectDone`);
console.log(`\n  downstream work could start ${saved.toFixed(0)}ms earlier`);
console.log(`  (${(100 * (1 - firstAt / wholeAt)).toFixed(0)}% of the reply's generation time)`);
console.log(`  first item: ${JSON.stringify(firstItemText)}`);
