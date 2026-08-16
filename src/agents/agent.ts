import { Tool } from "./tools/tools";
import type {
  LLM,
  LLMMessage,
  LLMToolCall,
  LLMToolDefinition,
} from "../providers/llm/types";

export interface AgentOptions {
  name: string;
  /** Names a participant might use to address this agent. */
  aliases?: string[];
  context?: string;
  tools?: Tool<never, unknown>[];
  /** LLM provider used by `run()`. Injected by `Pipeflow.agent()`. */
  llm?: LLM;
}

export interface AgentRunRequest {
  prompt: string;
  /** Prior messages to continue from, e.g. a previous `run()` result. */
  history?: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Safety bound on the number of tool-call round trips. */
  maxToolIterations?: number;
}

export interface ExecutedToolCall {
  id: string;
  name: string;
  /** Parsed arguments, or the raw JSON string if parsing failed. */
  arguments: unknown;
  /** The tool result, or `{ error }` when the tool failed or is unknown. */
  result: unknown;
}

export interface AgentRunResult {
  /** The assistant's final text response. */
  text: string;
  /** The full message history including the response and tool results. */
  messages: LLMMessage[];
  /** Every tool call executed during the run, in order. */
  toolCalls: ExecutedToolCall[];
}

/**
 * An AI persona: a name, a system context, and a set of tools.
 *
 * An agent can participate in conversations or be invoked independently
 * with `run()`.
 */
export class Agent {
  readonly name: string;
  readonly aliases: string[];
  readonly context: string;
  private readonly toolRegistry = new Map<string, Tool<never, unknown>>();
  /** LLM provider used by `run()` and the orchestrator. */
  readonly llm: LLM | undefined;

  constructor(options: AgentOptions) {
    const name = options.name.trim();
    if (!name) {
      throw new Error("Agent requires a non-empty name");
    }
    this.name = name;
    this.aliases = [...(options.aliases ?? [])];
    this.context = options.context?.trim() ?? "";
    this.llm = options.llm;
    for (const tool of options.tools ?? []) {
      this.addTool(tool);
    }
  }

  get tools(): Tool<never, unknown>[] {
    return [...this.toolRegistry.values()];
  }

  addTool(tool: Tool<never, unknown>): void {
    if (this.toolRegistry.has(tool.name)) {
      throw new Error(`Agent already has a tool named "${tool.name}"`);
    }
    this.toolRegistry.set(tool.name, tool);
  }

  hasTool(name: string): boolean {
    return this.toolRegistry.has(name);
  }

  getTool(name: string): Tool<never, unknown> | undefined {
    return this.toolRegistry.get(name);
  }

  /**
   * Run the agent against the LLM, executing any requested tools and
   * feeding their results back until the model responds without a tool
   * call.
   */
  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    if (!this.llm) {
      throw new Error(
        `Agent "${this.name}" has no LLM provider configured. ` +
          "Pass an LLM when constructing the agent or the Pipeflow instance.",
      );
    }

    const messages: LLMMessage[] = [];
    if (this.context) {
      messages.push({ role: "system", content: this.context });
    }
    if (request.history) {
      messages.push(...request.history);
    }
    messages.push({ role: "user", content: request.prompt });

    const definitions: LLMToolDefinition[] = this.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? { type: "object", properties: {} },
    }));

    const executed: ExecutedToolCall[] = [];
    const maxIterations = request.maxToolIterations ?? 10;

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const { text, toolCalls } = await this.streamOnce({
        llm: this.llm,
        messages,
        definitions,
        temperature: request.temperature,
        maxTokens: request.maxTokens,
      });

      if (toolCalls.length === 0) {
        return { text, messages, toolCalls: executed };
      }

      messages.push({ role: "assistant", content: text, toolCalls });
      for (const call of toolCalls) {
        const executedCall = await this.executeToolCall(call);
        executed.push(executedCall);
        messages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: JSON.stringify(executedCall.result),
        });
      }
    }

    throw new Error(
      `Agent "${this.name}" exceeded ${maxIterations} tool iterations`,
    );
  }

  private async streamOnce(options: {
    llm: LLM;
    messages: LLMMessage[];
    definitions: LLMToolDefinition[];
    temperature?: number;
    maxTokens?: number;
  }): Promise<{ text: string; toolCalls: LLMToolCall[] }> {
    const { llm, messages, definitions, temperature, maxTokens } = options;
    let text = "";
    const toolCalls: LLMToolCall[] = [];

    for await (const event of llm.stream({
      messages,
      tools: definitions,
      temperature,
      maxTokens,
    })) {
      switch (event.type) {
        case "delta":
          text += event.content;
          break;
        case "tool_call":
          toolCalls.push({ id: event.id, name: event.name, arguments: event.arguments });
          break;
        case "done":
          return { text, toolCalls };
        case "error":
          throw event.error;
      }
    }

    return { text, toolCalls };
  }

  private async executeToolCall(call: LLMToolCall): Promise<ExecutedToolCall> {
    const tool = this.toolRegistry.get(call.name);

    let args: unknown;
    try {
      args = JSON.parse(call.arguments);
    } catch {
      args = call.arguments;
    }

    if (!tool) {
      return {
        id: call.id,
        name: call.name,
        arguments: args,
        result: { error: `Unknown tool "${call.name}"` },
      };
    }

    try {
      const result = await tool.execute(args as never);
      return { id: call.id, name: call.name, arguments: args, result };
    } catch (error) {
      return {
        id: call.id,
        name: call.name,
        arguments: args,
        result: { error: error instanceof Error ? error.message : String(error) },
      };
    }
  }
}
