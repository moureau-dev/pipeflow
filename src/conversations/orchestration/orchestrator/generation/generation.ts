import type {
  LLM,
  LLMToolCall,
  LLMToolDefinition,
  LLMMessage,
} from "../../../../providers/llm/types";
import type { ResolvedToolCall } from "../tools/tools";

export interface GenerationRequest {
  /** Display name stamped on assistant tool-call messages. */
  agentName: string;
  llm: LLM;
  /**
   * The conversation messages; the loop appends the assistant tool-call
   * message and the resolved tool results onto this array.
   */
  messages: LLMMessage[];
  tools: LLMToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  /** Safety bound on tool-call round trips per generation. */
  maxToolIterations: number;
  /** False once the run is stale (interrupt/stop); aborts the loop. */
  isCurrent(): boolean;
  /**
   * Whether outgoing messages keep per-agent `name` fields on system and
   * assistant messages. Multi-agent conversations need them so the model can
   * tell which agent said what in the shared history. Single-agent
   * conversations drop them: with one agent the names carry no information,
   * and some providers render a message `name` as a role header ("Scout:")
   * that weaker models imitate — every reply then starts by speaking the
   * agent's name. Default true.
   */
  agentNames?: boolean;
  /** Streamed text; `textBefore` is the running text prior to this delta. */
  onDelta?(delta: string, textBefore: string): void;
  /** Hand tool calls to the application and resolve their results. */
  resolveToolCalls(calls: LLMToolCall[]): Promise<ResolvedToolCall[]>;
}

export type GenerationStatus = "done" | "interrupted" | "error";

export interface GenerationOutcome {
  /** Everything the model produced (or produced before failing). */
  text: string;
  status: GenerationStatus;
  /** The provider error, when `status` is "error". */
  error?: unknown;
  /**
   * How many tool rounds were resolved before the run ended (only present
   * when at least one). Lets callers retry a no-output failure safely:
   * re-running a generation whose tools already executed would repeat their
   * side effects.
   */
  toolRounds?: number;
}

/**
 * Owns the LLM tool loop shared by top-level generations and delegated
 * sub-generations: stream deltas, collect tool calls, resolve them through
 * the application, and repeat up to `maxToolIterations`.
 *
 * It is deliberately ignorant of the conversation lifecycle — persistence,
 * transcripts, speech, and history are the caller's concern, decided from
 * the returned `GenerationOutcome`.
 */
export class GenerationRunner {
  async run(request: GenerationRequest): Promise<GenerationOutcome> {
    const {
      agentName,
      llm,
      messages,
      tools,
      temperature,
      maxTokens,
      maxToolIterations,
      isCurrent,
      agentNames = true,
      onDelta,
      resolveToolCalls,
    } = request;

    let text = "";
    let toolRounds = 0;

    try {
      for (let iteration = 0; iteration < maxToolIterations; iteration++) {
        if (!isCurrent()) return { text, status: "interrupted" };

        const toolCalls: LLMToolCall[] = [];
        let done = false;

        // Single-agent conversations don't need per-agent `name` fields (see
        // GenerationRequest.agentNames): strip them before every call, since
        // the tool loop appends fresh messages between iterations. Never
        // mutate the caller's array.
        const wireMessages = agentNames ? messages : withoutAgentNames(messages);

        for await (const event of llm.stream({ messages: wireMessages, tools, temperature, maxTokens })) {
          if (!isCurrent()) return { text, status: "interrupted" };
          switch (event.type) {
            case "delta": {
              const before = text;
              text += event.content;
              if (event.content.length > 0) onDelta?.(event.content, before);
              break;
            }
            case "tool_call":
              toolCalls.push({ id: event.id, name: event.name, arguments: event.arguments });
              break;
            case "error":
              throw event.error;
            case "done":
              done = true;
          }
        }

        if (!isCurrent()) return { text, status: "interrupted" };

        if (toolCalls.length > 0) {
          toolRounds++;
          // Pause the response: hand the calls to the application, then
          // resume once they are resolved.
          messages.push({ role: "assistant", name: agentName, content: text, toolCalls });
          const results = await resolveToolCalls(toolCalls);
          if (!isCurrent()) return { text, status: "interrupted" };
          for (const result of results) {
            messages.push({
              role: "tool",
              toolCallId: result.id,
              name: result.name,
              content: JSON.stringify(
                result.error !== undefined ? { error: result.error } : result.result,
              ),
            });
          }
          continue;
        }

        if (done) break;
      }

      return { text, status: "done" };
    } catch (error) {
      return {
        text,
        status: "error",
        error,
        ...(toolRounds > 0 ? { toolRounds } : {}),
      };
    }
  }
}

/**
 * Clone the messages with per-agent `name` fields removed from system and
 * assistant messages. Tool messages keep their `name` (the wire format
 * requires it on `role: "tool"`), and user messages never carry one.
 */
function withoutAgentNames(messages: LLMMessage[]): LLMMessage[] {
  let hasNames = false;
  for (const message of messages) {
    if (message.name && (message.role === "system" || message.role === "assistant")) {
      hasNames = true;
      break;
    }
  }
  if (!hasNames) return messages;
  return messages.map((message) =>
    message.name && (message.role === "system" || message.role === "assistant")
      ? { ...message, name: undefined }
      : message,
  );
}
