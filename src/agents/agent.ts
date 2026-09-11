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
  /**
   * Static system context string, or a function that returns one (sync or
   * async) each time the agent is invoked. The function receives the
   * triggering prompt and any available conversation context.
   */
  context?: string | ContextFn;
  tools?: Tool<never, unknown>[];
  /** LLM provider used by `run()`. Injected by `Pipeflow.agent()`. */
  llm?: LLM;
}

export interface ContextParams {
  /** The user prompt or turn text that triggered the generation. */
  prompt: string;
  /** Conversation id when running inside a conversation. */
  conversationId?: string;
  /** Current participants when inside a conversation. */
  participants?: ReadonlyArray<{
    userId: string;
    aliases: readonly string[];
  }>;
  /** The turn that triggered this generation, when inside a conversation. */
  turn?: {
    id: string;
    participantId: string;
    participantName: string;
    text: string;
  };
  /** The conversation's scoped annotations. Always present; empty when standalone. */
  annotations: ReadonlyMap<string, string>;
}

export type ContextFn = (params: ContextParams) => string | Promise<string>;

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

export class Agent {
  readonly name: string;
  readonly aliases: string[];
  readonly context: string | ContextFn;
  private readonly toolRegistry = new Map<string, Tool<never, unknown>>();
  readonly llm: LLM | undefined;

  constructor(options: AgentOptions) {
    const name = options.name.trim();
    if (!name) {
      throw new Error("Agent requires a non-empty name");
    }
    this.name = name;
    this.aliases = [...(options.aliases ?? [])];
    this.context = typeof options.context === "string"
      ? options.context.trim()
      : options.context ?? "";
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
    const context = await this.resolveContext({
      prompt: request.prompt,
      annotations: new Map(),
    });
    if (context) {
      messages.push({ role: "system", content: context });
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
      const executedBatch = await Promise.all(
        toolCalls.map((call) => this.executeToolCall(call)),
      );
      for (const executedCall of executedBatch) {
        executed.push(executedCall);
        messages.push({
          role: "tool",
          toolCallId: executedCall.id,
          name: executedCall.name,
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

  /**
   * Resolve the agent's system context: return the static string or call the
   * function with the given params and return its result.
   */
  resolveContext(params: ContextParams): string | Promise<string> {
    return typeof this.context === "function"
      ? this.context(params)
      : this.context;
  }
}