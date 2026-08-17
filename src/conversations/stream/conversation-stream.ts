/**
 * ConversationStream — the conversation's semantic reply stream.
 *
 * Turns a Conversation's event stream (LLM text fragments + generation
 * completion) into FieldStream completion events: consumers act on partial
 * reply text without waiting for the reply to finish.
 *
 *   const replies = new ConversationStream(conversation);
 *   replies.whenItem("text", (fragment, i) => render(fragment));
 *   replies.when("agent", (agent) => showSpeaker(agent));
 *   replies.whenObjectDone((reply) => finalize(reply));
 *   replies.cancel(); // aborts the current generation (interrupts the LLM)
 *
 * One semantic object per top-level generation (agent or coordination
 * reply). The `text` field is an ordered sequence of completed text
 * fragments — semantically "the next fragment of the reply arrived", not
 * "whatever happened to be inside a provider SSE packet". Fragment sizes are
 * an implementation detail of the producer and may be coalesced later.
 *
 * Lifecycle per reply:
 *
 *   first fragment ──▶ STREAMING ──generation-complete──▶ DONE
 *                          ├──cancel()/interrupt──▶ CANCELLED
 *                          └──provider error──────▶ FAILED
 *
 * Each boundary fires at most once; no completion event fires after a
 * terminal state. Interruptions and errors leave already-delivered fragments
 * as valid partial state. Delegated sub-generation results do not terminate
 * the top-level reply — only the top-level generation's completion does.
 */
import { FieldStream } from "../../transport/streamobject/field-stream/field-stream";
import type {
  Event,
  Schema,
} from "../../transport/streamobject/reference/reference";
import type { Conversation } from "../conversation/conversation";

const REPLY_SCHEMA: Schema = [
  { path: ["agent"], type: "string", maxLength: 128 },
  { path: ["text"], type: "string", mode: "array", maxItems: 4096, maxLength: 4096 },
];

const AGENT_FIELD = 0;
const TEXT_FIELD = 1;

export class ConversationStream extends FieldStream {
  private readonly unsubscribers: Array<() => void>;
  private active: { agentName: string | undefined; items: string[] } | null = null;

  constructor(conversation: Conversation) {
    // cancel() interrupts the conversation, which stops the current
    // generation's LLM through the orchestrator. Idempotent.
    super(REPLY_SCHEMA, { onCancel: () => conversation.interrupt() });
    this.unsubscribers = [
      conversation.on("text-delta", ({ text, agentName }) => this.onDelta(text, agentName)),
      conversation.on("generation-complete", () => this.completeReply()),
      conversation.on("error", ({ error }) => this.fail(error)),
      conversation.on("interrupt", () => this.abortReply()),
    ];
  }

  /** Stop listening to the conversation. */
  dispose(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
  }

  private onDelta(text: string, agentName: string | undefined): void {
    if (this.active === null) {
      this.beginObject();
      this.active = { agentName, items: [] };
      if (agentName !== undefined) this.emitField(AGENT_FIELD, agentName);
    }
    const index = this.active.items.length;
    this.active.items.push(text);
    this.emitItem(TEXT_FIELD, index, text);
  }

  private completeReply(): void {
    const active = this.active;
    if (active === null) return;
    this.active = null;
    const events: Event[] = [];
    if (active.agentName !== undefined) {
      events.push({ kind: "field", field: AGENT_FIELD, value: active.agentName });
    }
    events.push({ kind: "field", field: TEXT_FIELD, value: active.items });
    events.push({ kind: "object-complete" });
    this.emitObject(events);
  }

  private abortReply(): void {
    this.active = null;
    this.cancelObject(); // delivered fragments remain valid partial state
  }
}
