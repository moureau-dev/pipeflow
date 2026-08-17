/**
 * ConversationStream — the conversation's semantic reply stream.
 *
 * Turns a Conversation's event stream (LLM text deltas + generation
 * completion) into FieldStream completion events: consumers act on partial
 * reply text without waiting for the reply to finish.
 *
 *   const replies = new ConversationStream(conversation);
 *   replies.whenItem("text", (chunk, i) => render(chunk));   // per LLM delta
 *   replies.when("agent", (agent) => showSpeaker(agent));    // at first delta
 *   replies.whenObjectDone((reply) => finalize(reply));      // generation done
 *
 * One semantic object per top-level generation (agent or coordination
 * reply). The `text` field is an array: one item per LLM delta. Interruptions
 * and provider errors end the object without completing it — items already
 * delivered remain valid partial state.
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
    super(REPLY_SCHEMA);
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
    this.active = null; // delivered items remain valid partial state
  }
}
