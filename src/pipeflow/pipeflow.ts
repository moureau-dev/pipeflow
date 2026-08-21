import { Agent, type AgentOptions } from "../agents/agent";
import { Conversations } from "../conversations/conversations";
import { MemoryPersistence } from "../persistence/adapters/memory/memory";
import type { Persistence } from "../persistence/persistence";
import type { LLM } from "../providers/llm/types";
import type { STT } from "../providers/stt/types";
import type { TTS } from "../providers/tts/types";

export interface PipeflowOptions {
  llm?: LLM;
  stt?: STT;
  tts?: TTS;
  persistence?: Persistence;
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

  constructor(options: PipeflowOptions = {}) {
    this.llm = options.llm;
    this.stt = options.stt;
    this.tts = options.tts;
    const persistence = options.persistence ?? new MemoryPersistence();
    this.conversations = new Conversations({
      persistence,
      stt: options.stt,
      tts: options.tts,
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
