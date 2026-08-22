import type { Conversation } from "../../../conversation/conversation";
import type { LLMToolCall } from "../../../../providers/llm/types";
import type { ToolCallResult } from "../../../types";
import type { Tool } from "../../../../agents/tools/tools";

export interface ResolvedToolCall {
  id: string;
  name: string;
  result?: unknown;
  error?: string;
}

export interface ToolCallManagerOptions {
  /**
   * The tools the framework can execute on the agent's behalf, keyed by
   * name. Built from the orchestrated agents' tool registries.
   */
  tools?: ReadonlyMap<string, Tool<never, unknown>>;
  /**
   * Execute tool calls automatically (default `true`), feeding each tool's
   * result — or a caught error — back into the model loop. Set `false` to
   * keep the application-managed contract: listen for `tool-call`, execute
   * the tool in your own backend, and report back with
   * `resolveToolCall()`. `tool-call` events are still emitted for
   * visibility in either mode.
   */
  autoExecute?: boolean;
}

/**
 * Resolves the tool calls a generation issues. By default it runs the
 * matching tool itself (the conversation agents' tools auto-execute, exactly
 * like `Agent.run()`); with `autoExecute: false` it hands the calls to the
 * application and resolves them once the application reports back (or a
 * timeout fires). Stale results — timed out, already resolved, or superseded
 * by an interrupt — are dropped.
 */
export class ToolCallManager {
  private readonly conversation: Conversation;
  private readonly timeoutMs: number;
  private readonly tools: ReadonlyMap<string, Tool<never, unknown>> | undefined;
  private readonly autoExecute: boolean;
  private readonly waiters = new Map<string, (result: ToolCallResult) => void>();

  constructor(
    conversation: Conversation,
    timeoutMs: number,
    options: ToolCallManagerOptions = {},
  ) {
    this.conversation = conversation;
    this.timeoutMs = timeoutMs;
    this.tools = options.tools;
    this.autoExecute = options.autoExecute ?? true;
  }

  /**
   * Resolve a batch of tool calls. In auto-execute mode each call's tool
   * runs on the agent's behalf (errors caught and returned to the model);
   * otherwise the application resolves them. Either way the calls are
   * emitted as `tool-call` events and resolved in call order, with either a
   * result or an error string.
   */
  async resolveCalls(calls: LLMToolCall[]): Promise<ResolvedToolCall[]> {
    const resolutions = calls.map((call) => this.wait(call.id));
    for (const call of calls) {
      const args = this.parseArguments(call.arguments);
      this.conversation.requestToolCall({
        id: call.id,
        name: call.name,
        arguments: args,
      });
      if (this.autoExecute) {
        // Run the tool on the agent's behalf. The waiter above still bounds
        // the round trip if the tool hangs.
        void this.runToolAndResolve(call, args);
      }
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

  /**
   * Execute one tool call and resolve it with the tool's result (or a
   * caught error). If the application already resolved the call in its
   * `tool-call` handler — the app-managed path — the tool is not run twice.
   */
  private async runToolAndResolve(call: LLMToolCall, args: unknown): Promise<void> {
    if (!this.isPending(call.id)) return;
    try {
      const tool = this.tools?.get(call.name);
      if (!tool) {
        this.resolveIfPending({
          id: call.id,
          error: `Unknown tool "${call.name}"`,
        });
        return;
      }
      const result = await tool.execute(args as never);
      this.resolveIfPending({ id: call.id, result });
    } catch (error) {
      this.resolveIfPending({
        id: call.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Resolve through the conversation only while the call is still pending. */
  private resolveIfPending(result: ToolCallResult): void {
    if (!this.isPending(result.id)) return;
    this.conversation.resolveToolCall(result);
  }

  private isPending(id: string): boolean {
    return this.conversation.pendingToolCalls.some((call) => call.id === id);
  }

  private parseArguments(argumentsJson: string): unknown {
    try {
      return JSON.parse(argumentsJson);
    } catch {
      return argumentsJson;
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
