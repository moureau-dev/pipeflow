import { Agent, type AgentOptions } from "../agents/agent";
import { Conversations } from "../conversations/conversations";
import { MemoryPersistence } from "../persistence/adapters/memory/memory";
import type { Persistence } from "../persistence/persistence";
import type { LLM } from "../providers/llm/types";
import type { STT } from "../providers/stt/types";
import type { TTS } from "../providers/tts/types";
import type { Logger } from "../logger/types";
import { ConsoleLogger } from "../logger/console";

export interface PipeflowOptions {
  llm?: LLM;
  stt?: STT;
  tts?: TTS;
  persistence?: Persistence;
  /**
   * Default for created conversations: auto-execute the agents' tools
   * (default `true`), feeding each tool's result back into the model loop.
   * Set `false` to resolve tool calls from your own backend via
   * `resolveToolCall()`. Override per conversation in
   * `pipeflow.conversations.create()`.
   */
  autoExecuteTools?: boolean;
  /**
   * Logger instance. Defaults to a no-op logger. Set to
   * `new ConsoleLogger("pipeflow")` for console output.
   */
  logger?: Logger;
  /**
   * Enable console logging. Shorthand for `logger: new ConsoleLogger(label)`.
   */
  verbose?: boolean;
  /**
   * Label used when `verbose` is true. Defaults to "pipeflow".
   */
  logLabel?: string;
}

/**
 * The Pipeflow entry point.
 *
 * ```ts
 * const pipeflow = new Pipeflow({ llm });
 * const agent = pipeflow.agent({ name: "Jarvis", context: "..." });
 * const conversation = await pipeflow.conversations.create({ agents: [agent] });
 * ```
 */
export class Pipeflow {
  readonly llm: LLM | undefined;
  readonly stt: STT | undefined;
  readonly tts: TTS | undefined;
  readonly conversations: Conversations;
  readonly logger: Logger;

  constructor(options: PipeflowOptions = {}) {
    this.llm = options.llm;
    this.stt = options.stt;
    this.tts = options.tts;
    this.logger = resolveLogger(options);
    const persistence = options.persistence ?? new MemoryPersistence();
    this.conversations = new Conversations({
      persistence,
      stt: options.stt,
      tts: options.tts,
      autoExecuteTools: options.autoExecuteTools,
      logger: this.logger,
    });
  }

  /**
   * Create an agent. Agents inherit the Pipeflow instance's LLM provider so
   * `agent.run()` works out of the box.
   */
  agent(options: Omit<AgentOptions, "llm"> & { llm?: LLM }): Agent {
    return new Agent({ ...options, llm: options.llm ?? this.llm });
  }
}

function resolveLogger(options: PipeflowOptions): Logger {
  if (options.logger) return options.logger;
  if (options.verbose) return new ConsoleLogger(options.logLabel ?? "pipeflow");
  return { info() {}, warn() {}, error() {}, debug() {} } as Logger;
}
