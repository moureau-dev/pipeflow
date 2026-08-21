import type { Conversation } from "../../../conversation/conversation";
import type { LLMToolCall } from "../../../../providers/llm/types";
import type { ToolCallResult } from "../../../types";

export interface ResolvedToolCall {
  id: string;
  name: string;
  result?: unknown;
  error?: string;
}

/**
 * Tracks tool calls handed to the application and resolves them once the
 * application reports back (or a timeout fires). Stale results — timed out,
 * already resolved, or superseded by an interrupt — are dropped.
 */
export class ToolCallManager {
  private readonly conversation: Conversation;
  private readonly timeoutMs: number;
  private readonly waiters = new Map<string, (result: ToolCallResult) => void>();

  constructor(conversation: Conversation, timeoutMs: number) {
    this.conversation = conversation;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Hand the calls to the application and resolve each one once it is
   * answered or times out. Returns them in call order, with either a result
   * or an error string.
   */
  async resolveCalls(calls: LLMToolCall[]): Promise<ResolvedToolCall[]> {
    const resolutions = calls.map((call) => this.wait(call.id));
    for (const call of calls) {
      let args: unknown;
      try {
        args = JSON.parse(call.arguments);
      } catch {
        args = call.arguments;
      }
      this.conversation.requestToolCall({
        id: call.id,
        name: call.name,
        arguments: args,
      });
    }

    const results = await Promise.all(resolutions);
    return results.map((result, index) => {
      const call = calls[index]!;
      return {
        id: result.id,
        name: call.name,
        result: "result" in result ? result.result : undefined,
        error: "error" in result ? result.error : undefined,
      };
    });
  }

  /** Resolve a waiter from a `tool-call-result` event; stale results drop. */
  handleResult(result: ToolCallResult): void {
    const resolve = this.waiters.get(result.id);
    if (!resolve) return;
    this.waiters.delete(result.id);
    resolve(result);
  }

  /** Force-resolve every pending call (interrupt, stop). */
  cancelAll(reason: string): void {
    for (const [id, resolve] of [...this.waiters]) {
      this.waiters.delete(id);
      resolve({ id, error: reason });
    }
  }

  private wait(id: string): Promise<ToolCallResult> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(id);
        resolve({ id, error: `Tool call "${id}" timed out` });
      }, this.timeoutMs);
      this.waiters.set(id, (result) => {
        clearTimeout(timeout);
        resolve(result);
      });
    });
  }
}
