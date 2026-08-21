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
      onDelta,
      resolveToolCalls,
    } = request;

    let text = "";

    try {
      for (let iteration = 0; iteration < maxToolIterations; iteration++) {
        if (!isCurrent()) return { text, status: "interrupted" };

        const toolCalls: LLMToolCall[] = [];
        let done = false;

        for await (const event of llm.stream({ messages, tools, temperature, maxTokens })) {
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
      return { text, status: "error", error };
    }
  }
}
