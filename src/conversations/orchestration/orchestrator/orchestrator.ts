import type { Agent } from "../../../agents/agent";
import type { Conversation } from "../../conversation/conversation";
import type { Persistence } from "../../../persistence/persistence";
import type {
  LLM,
  LLMMessage,
  LLMToolCall,
  LLMToolDefinition,
} from "../../../providers/llm/types";
import type { STT, STTSession } from "../../../providers/stt/types";
import type { TTS } from "../../../providers/tts/types";
import type { AudioChunk, Generation, ToolCallResult, Turn, UserId } from "../../types";

export interface OrchestratorOptions {
  conversation: Conversation;
  /**
   * The agents the coordinator routes turns to. The first agent is the
   * default (used when no agent is addressed by name or alias). Omit for
   * transcription-only mode (audio in, turns and transcripts out — no LLM
   * or TTS required).
   */
  agents?: Agent[];
  /** Defaults to the first agent's LLM. */
  llm?: LLM;
  stt: STT;
  /** Required when agents are attached. */
  tts?: TTS;
  /** Used to rehydrate conversation history on start. */
  persistence?: Persistence;
  /** How long to wait for the application to resolve a tool call. */
  toolTimeoutMs?: number;
  /** Safety bound on tool-call round trips per generation. */
  maxToolIterations?: number;
  temperature?: number;
  maxTokens?: number;
}

interface SttSessionEntry {
  session: STTSession;
  turnStartedAt: number | null;
}

interface ResolvedToolCall {
  id: string;
  name: string;
  result?: unknown;
  error?: string;
}

/** One task in a coordinator `dispatch` tool call. */
interface DispatchTask {
  agent: string;
  prompt: string;
}

/** The outcome of one dispatched sub-generation. */
interface SubGenerationResult {
  agent: string;
  text: string;
  error?: string;
}

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

/**
 * A human-readable "now" stamp appended to dispatched prompts so
 * time-sensitive tasks (flights, meetings, deadlines) have temporal context.
 */
export function formatTimeContext(date = new Date()): string {
  const day = date.getDate();
  const month = MONTHS[date.getMonth()]!;
  const year = date.getFullYear();
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `Now it is ${day} ${month} ${year}, ${hours}:${minutes}.`;
}

/**
 * Pick the agent that should handle a turn.
 *
 * The first agent whose name or alias appears in the turn text wins;
 * otherwise the first agent in the roster is the default. Matching is
 * case-insensitive substring matching, so "ask the technical specialist"
 * addresses an agent named "Technical Specialist" (or aliased "tech").
 */
export function pickAgent(agents: readonly Agent[], text: string): Agent | null {
  if (agents.length === 0) return null;
  const normalized = text.toLowerCase();
  for (const agent of agents) {
    if (agent.name && normalized.includes(agent.name.toLowerCase())) return agent;
    for (const alias of agent.aliases) {
      if (normalized.includes(alias.toLowerCase())) return agent;
    }
  }
  return agents[0]!;
}

/**
 * The tool definition that lets the coordinator decompose a request into
 * subtasks for the other agents. Names and aliases are offered as an enum so
 * the LLM picks a real roster member.
 */
function dispatchToolDefinition(agents: readonly Agent[]): LLMToolDefinition {
  const coordinator = agents[0];
  const targets = agents
    .filter((agent) => agent !== coordinator)
    .map((agent) => [agent.name, ...agent.aliases])
    .flat();
  return {
    name: "dispatch",
    description:
      "Decompose the user's request into subtasks and assign each to another agent. " +
      "The named agent executes its task with its own tools and context, and the results are " +
      "returned to you to compose the final answer. Use this when a request spans multiple " +
      "domains and several agents should work on it together.",
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          description: "Subtasks, each handled by one agent.",
          items: {
            type: "object",
            properties: {
              agent: {
                type: "string",
                description: "Agent name or alias from the roster.",
                enum: targets,
              },
              prompt: {
                type: "string",
                description: "Self-contained instruction for that agent.",
              },
            },
            required: ["agent", "prompt"],
          },
        },
      },
      required: ["tasks"],
    },
  };
}

function parseDispatchArguments(argumentsJson: string): DispatchTask[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    throw new Error("dispatch arguments must be valid JSON");
  }
  const tasks = (parsed as { tasks?: unknown } | null)?.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error('dispatch requires a non-empty "tasks" array');
  }
  return tasks.map((task, index) => {
    const record = (task ?? {}) as { agent?: unknown; prompt?: unknown };
    if (typeof record.agent !== "string" || record.agent.trim() === "") {
      throw new Error(`dispatch task ${index + 1} requires an agent name`);
    }
    if (typeof record.prompt !== "string" || record.prompt.trim() === "") {
      throw new Error(`dispatch task ${index + 1} requires a prompt`);
    }
    return { agent: record.agent.trim(), prompt: record.prompt.trim() };
  });
}

/**
 * The realtime conversation state machine and multi-agent coordinator.
 *
 * Wires the conversation to the providers and routes each turn to an agent:
 *
 * ```text
 * audio-in ──► STT ──► turn ──► coordinator ──► agent ──► LLM ──► TTS ──► audio-out
 *                                    │
 *                                    └─► tool-call ──► app resolves ──► resume
 * ```
 *
 * Deltas stream to TTS immediately (so the agent can narrate while a tool
 * runs), tool calls pause the generation until the application resolves
 * them, and interruptions cancel the current generation — discarding any
 * stale tool results or audio via a generation epoch.
 */
export class Orchestrator {
  private readonly conversation: Conversation;
  private readonly agents: Agent[];
  private readonly llm: LLM | undefined;
  private readonly stt: STT;
  private readonly tts: TTS | undefined;
  private readonly persistence: Persistence | undefined;
  private readonly toolTimeoutMs: number;
  private readonly maxToolIterations: number;
  private readonly temperature: number | undefined;
  private readonly maxTokens: number | undefined;

  private started = false;
  private generating = false;
  private epoch = 0;
  private readonly unsubscribers: (() => void)[] = [];
  private readonly sttSessions = new Map<UserId, SttSessionEntry>();
  private readonly history: LLMMessage[] = [];
  private readonly toolWaiters = new Map<string, (result: ToolCallResult) => void>();
  private generationChain: Promise<void> = Promise.resolve();
  private speechChain: Promise<void> = Promise.resolve();
  private speechBuffer = "";
  private pendingTurns = 0;
  private pendingGenerations = 0;
  private audioSequence = 0;
  private turnSequence = 0;

  constructor(options: OrchestratorOptions) {
    const agents = options.agents ?? [];
    const llm = options.llm ?? agents[0]?.llm;
    if (!options.stt) {
      throw new Error("Orchestrator requires an STT provider");
    }
    if (agents.length > 0 && !llm) {
      throw new Error(
        "Orchestrator requires an LLM when agents are attached: " +
          "pass one explicitly or configure an agent with one",
      );
    }
    if (agents.length > 0 && !options.tts) {
      throw new Error("Orchestrator requires a TTS provider when agents are attached");
    }
    this.conversation = options.conversation;
    this.agents = agents;
    this.llm = llm;
    this.stt = options.stt;
    this.tts = options.tts;
    this.persistence = options.persistence;
    this.toolTimeoutMs = options.toolTimeoutMs ?? 30_000;
    this.maxToolIterations = options.maxToolIterations ?? 10;
    this.temperature = options.temperature;
    this.maxTokens = options.maxTokens;
  }

  /**
   * Attach to the conversation: rehydrate history from persistence and
   * subscribe to conversation events.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    if (this.persistence) {
      const [turns, generations] = await Promise.all([
        this.persistence.listTurns(this.conversation.id),
        this.persistence.listGenerations(this.conversation.id),
      ]);
      const entries: Array<
        | { at: number; kind: "turn"; turn: Turn }
        | { at: number; kind: "generation"; agentName: string; text: string }
      > = [
        ...turns.map((turn) => ({ at: turn.startedAt, kind: "turn" as const, turn })),
        ...generations
          // Sub-generations are summarized inside the coordinator's own
          // answer, so only top-level responses rehydrate into history.
          .filter(
            (generation) =>
              generation.status === "completed" && generation.kind !== "sub",
          )
          .map((generation) => ({
            at: generation.startedAt,
            kind: "generation" as const,
            agentName: generation.agentName,
            text: generation.text,
          })),
      ].sort((a, b) => a.at - b.at);

      for (const entry of entries) {
        if (entry.kind === "turn") {
          this.history.push({
            role: "user",
            content: `${entry.turn.participantName}: ${entry.turn.text}`,
          });
        } else {
          this.history.push({
            role: "assistant",
            name: entry.agentName,
            content: entry.text,
          });
        }
      }
    }

    this.unsubscribers.push(
      this.conversation.on("stop", () => void this.stop()),
      this.conversation.on("audio-in", (payload) => this.onAudioIn(payload)),
      this.conversation.on("interrupt", () => this.onInterrupt()),
      this.conversation.on("tool-call-result", (payload) =>
        this.onToolCallResult(payload.result),
      ),
    );
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.epoch++;
    this.stopLlms();
    this.tts?.stop();
    this.cancelToolWaiters("conversation stopped");
    this.speechBuffer = "";
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
    const sessions = [...this.sttSessions.values()];
    this.sttSessions.clear();
    for (const { session } of sessions) {
      await session.end().catch(() => {});
    }
  }

  /**
   * Resolve once every queued and in-flight turn and generation has
   * finished processing. Useful for tests and graceful shutdown.
   */
  async whenIdle(): Promise<void> {
    for (;;) {
      while (
        this.pendingTurns > 0 ||
        this.pendingGenerations > 0 ||
        this.generating
      ) {
        await Bun.sleep(1);
      }
      // Give work scheduled in the same microtask turn a chance to register.
      await Promise.resolve();
      if (
        this.pendingTurns === 0 &&
        this.pendingGenerations === 0 &&
        !this.generating
      ) {
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Conversation event handlers
  // -------------------------------------------------------------------------

  private onAudioIn(payload: { userId: UserId; audio: AudioChunk }): void {
    let entry = this.sttSessions.get(payload.userId);
    if (!entry) {
      const session = this.stt.start({});
      session.on("partial", (text) => this.onPartial(payload.userId, text));
      session.on("final", (text) => this.onFinal(payload.userId, text));
      session.on("error", (error) => this.onProviderError(error));
      entry = { session, turnStartedAt: null };
      this.sttSessions.set(payload.userId, entry);
    }

    if (entry.turnStartedAt === null) {
      entry.turnStartedAt = Date.now();
    }
    entry.session.write(payload.audio.data);

    // Barge-in: a participant speaks while the agent is responding (or about
    // to). The interrupting audio is already queued to STT above.
    if (this.pendingGenerations > 0) {
      this.conversation.interrupt();
    }
  }

  private onPartial(userId: UserId, text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.conversation.emit("partial-transcript", {
      conversationId: this.conversation.id,
      userId,
      text: trimmed,
    });
  }

  private onFinal(userId: UserId, text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const participant = this.conversation.state.participants.get(userId);
    if (!participant) return;

    const entry = this.sttSessions.get(userId);
    const startedAt = entry?.turnStartedAt ?? Date.now();
    if (entry) entry.turnStartedAt = null;

    const turn: Turn = {
      id: crypto.randomUUID(),
      conversationId: this.conversation.id,
      participantId: userId,
      participantName: participant.aliases[0] ?? userId,
      text: trimmed,
      sequence: this.turnSequence++,
      startedAt,
      endedAt: Date.now(),
    };

    // Track synchronously so `whenIdle()` can observe in-flight work.
    this.pendingTurns++;
    void this.processTurn(turn);
  }

  private async processTurn(turn: Turn): Promise<void> {
    try {
      await this.conversation.pushTurn(turn);
      await this.conversation.pushTranscript({
        speaker: turn.participantName,
        speakerKind: "participant",
        text: turn.text,
      });
      this.history.push({
        role: "user",
        content: `${turn.participantName}: ${turn.text}`,
      });
      if (this.agents.length > 0) {
        this.queueGeneration(turn);
      }
    } finally {
      this.pendingTurns--;
    }
  }

  private onInterrupt(): void {
    this.epoch++;
    this.stopLlms();
    this.tts?.stop();
    this.cancelToolWaiters("interrupted");
    this.speechBuffer = "";
  }

  /** Cancel every LLM in play: the shared one and each agent's own. */
  private stopLlms(): void {
    const seen = new Set<LLM>();
    if (this.llm) seen.add(this.llm);
    for (const agent of this.agents) {
      if (agent.llm) seen.add(agent.llm);
    }
    for (const llm of seen) llm.stop();
  }

  private onToolCallResult(result: ToolCallResult): void {
    const resolve = this.toolWaiters.get(result.id);
    if (!resolve) return; // stale, timed out, or already resolved
    this.toolWaiters.delete(result.id);
    resolve(result);
  }

  private onProviderError(error: Error): void {
    this.conversation.emit("error", { conversationId: this.conversation.id, error });
  }

  // -------------------------------------------------------------------------
  // Generation
  // -------------------------------------------------------------------------

  private queueGeneration(turn: Turn): void {
    this.pendingGenerations++;
    const epoch = this.epoch;
    this.generationChain = this.generationChain.then(async () => {
      if (this.epoch !== epoch) {
        // Superseded by an interruption while queued.
        this.pendingGenerations--;
        return;
      }
      try {
        await this.generate(turn);
      } finally {
        this.pendingGenerations--;
      }
    });
  }

  private async generate(turn: Turn): Promise<void> {
    if (this.agents.length === 0) return;
    // The coordinator routes this turn to an agent by name/alias, falling
    // back to the first agent in the roster.
    const agent = pickAgent(this.agents, turn.text);
    if (!agent) return;
    // Prefer the routed agent's own LLM so agents with different providers
    // keep their intelligence; fall back to the shared LLM.
    const llm = agent.llm ?? this.llm;
    const tts = this.tts;
    if (!llm || !tts) return;
    this.generating = true;
    try {
      await this.runGeneration(this.epoch, turn, agent, llm, tts);
    } finally {
      this.generating = false;
    }
  }

  private async runGeneration(
    epoch: number,
    turn: Turn,
    agent: Agent,
    llm: LLM,
    tts: TTS,
  ): Promise<void> {
    const generationId = crypto.randomUUID();
    await this.conversation.pushGeneration({
      id: generationId,
      conversationId: this.conversation.id,
      agentName: agent.name,
      text: "",
      status: "streaming",
      startedAt: Date.now(),
    });

    const definitions: LLMToolDefinition[] = agent.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? { type: "object", properties: {} },
    }));
    // The coordinator (first agent in the roster) can decompose a request
    // across the other agents: dispatched tasks run as sub-generations and
    // their results come back here as the tool result.
    if (this.agents.length > 1 && agent === this.agents[0]) {
      definitions.push(dispatchToolDefinition(this.agents));
    }

    const messages: LLMMessage[] = [];
    if (agent.context) {
      messages.push({ role: "system", name: agent.name, content: agent.context });
    }
    messages.push(...this.history);

    let text = "";

    try {
      for (let iteration = 0; iteration < this.maxToolIterations; iteration++) {
        if (this.epoch !== epoch) return;

        const toolCalls: LLMToolCall[] = [];
        let done = false;

        for await (const event of llm.stream({
          messages,
          tools: definitions,
          temperature: this.temperature,
          maxTokens: this.maxTokens,
        })) {
          if (this.epoch !== epoch) return;
          switch (event.type) {
            case "delta":
              text += event.content;
              this.feedDelta(event.content);
              break;
            case "tool_call":
              toolCalls.push({ id: event.id, name: event.name, arguments: event.arguments });
              break;
            case "error":
              throw event.error;
            case "done":
              done = true;
          }
        }

        if (this.epoch !== epoch) return;

        if (toolCalls.length > 0) {
          // Pause the response: let the narration finish, hand the calls to
          // the application (dispatch calls run sub-generations internally),
          // and resume once they are resolved.
          this.flushSpeech();
          messages.push({ role: "assistant", name: agent.name, content: text, toolCalls });
          const results = await this.resolveToolCalls(toolCalls, epoch, generationId);
          if (this.epoch !== epoch) return;
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

      if (this.epoch !== epoch) return;

      this.flushSpeech();
      await this.speechChain;

      if (this.epoch !== epoch) return;

      await this.conversation.completeGeneration(text);
      await this.conversation.pushTranscript({
        speaker: agent.name,
        speakerKind: "agent",
        text,
      });
      this.history.push({ role: "assistant", name: agent.name, content: text });
    } catch (error) {
      if (this.epoch !== epoch) return; // interrupted — discard everything
      this.conversation.emit("error", {
        conversationId: this.conversation.id,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      // Finalize whatever was generated so the conversation state stays
      // consistent even though the provider failed.
      await this.conversation.completeGeneration(text);
      if (text) {
        await this.conversation.pushTranscript({
          speaker: agent.name,
          speakerKind: "agent",
          text,
        });
        this.history.push({ role: "assistant", name: agent.name, content: text });
      }
    }
  }

  private async resolveToolCalls(
    calls: LLMToolCall[],
    epoch: number,
    parentGenerationId?: string,
  ): Promise<ResolvedToolCall[]> {
    const resolutions = calls.map((call) => {
      // Dispatch is Pipeflow-owned: the coordinator's sub-generations run
      // here instead of being handed to the application.
      if (call.name === "dispatch" && parentGenerationId !== undefined) {
        return this.runDispatch(call, epoch, parentGenerationId);
      }
      return this.waitForToolResult(call.id, epoch);
    });
    for (const call of calls) {
      if (call.name === "dispatch") continue; // never surfaced to the app
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

  // -------------------------------------------------------------------------
  // Dispatch (coordinator → sub-agents)
  // -------------------------------------------------------------------------

  /**
   * Run a coordinator `dispatch` call: parse the tasks, execute each as a
   * sub-generation (in parallel), surface their outputs in the transcript,
   * and return the aggregated results as the tool result for the coordinator
   * to compose the final answer.
   */
  private async runDispatch(
    call: LLMToolCall,
    epoch: number,
    parentGenerationId: string,
  ): Promise<ResolvedToolCall> {
    let tasks: DispatchTask[];
    try {
      tasks = parseDispatchArguments(call.arguments);
    } catch (error) {
      return {
        id: call.id,
        name: "dispatch",
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const results = await Promise.all(
      tasks.map((task) => this.runSubGeneration(epoch, task, parentGenerationId)),
    );

    if (this.epoch !== epoch) {
      return { id: call.id, name: "dispatch", error: "interrupted" };
    }

    // Surface each specialist's work in the transcript, in task order.
    for (const result of results) {
      if (result.text && !result.error) {
        await this.conversation.pushTranscript({
          speaker: result.agent,
          speakerKind: "agent",
          text: result.text,
        });
      }
    }

    return {
      id: call.id,
      name: "dispatch",
      result: results.map(({ agent, text, error }) => ({ agent, text, error })),
    };
  }

  /**
   * Execute one dispatched task as a sub-generation: the target agent's own
   * LLM, context, and tools, running text-only (no TTS). The final text is
   * returned so the coordinator can merge it into the spoken answer.
   */
  private async runSubGeneration(
    epoch: number,
    task: DispatchTask,
    parentGenerationId: string,
  ): Promise<SubGenerationResult> {
    const agent = this.findAgent(task.agent);
    if (!agent) {
      return { agent: task.agent, text: "", error: `Unknown agent "${task.agent}"` };
    }
    const llm = agent.llm ?? this.llm;
    if (!llm) {
      return {
        agent: agent.name,
        text: "",
        error: `Agent "${agent.name}" has no LLM configured`,
      };
    }

    const id = crypto.randomUUID();
    const generation: Generation = {
      id,
      conversationId: this.conversation.id,
      agentName: agent.name,
      text: "",
      status: "streaming",
      startedAt: Date.now(),
      kind: "sub",
      parentGenerationId,
    };
    await this.conversation.pushSubGeneration(generation);

    const definitions: LLMToolDefinition[] = agent.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? { type: "object", properties: {} },
    }));

    const messages: LLMMessage[] = [];
    if (agent.context) {
      messages.push({ role: "system", name: agent.name, content: agent.context });
    }
    messages.push(...this.history);
    // The prompt carries a time stamp so time-sensitive tasks (flights,
    // meetings, deadlines) don't reason about a stale "now".
    messages.push({ role: "user", content: `${task.prompt}\n\n${formatTimeContext()}` });

    let text = "";

    try {
      for (let iteration = 0; iteration < this.maxToolIterations; iteration++) {
        if (this.epoch !== epoch) return this.cancelSubGeneration(id, agent.name);

        const toolCalls: LLMToolCall[] = [];
        let done = false;

        for await (const event of llm.stream({
          messages,
          tools: definitions,
          temperature: this.temperature,
          maxTokens: this.maxTokens,
        })) {
          if (this.epoch !== epoch) return this.cancelSubGeneration(id, agent.name);
          switch (event.type) {
            case "delta":
              text += event.content;
              break;
            case "tool_call":
              toolCalls.push({
                id: event.id,
                name: event.name,
                arguments: event.arguments,
              });
              break;
            case "error":
              throw event.error;
            case "done":
              done = true;
          }
        }

        if (this.epoch !== epoch) return this.cancelSubGeneration(id, agent.name);

        if (toolCalls.length > 0) {
          messages.push({ role: "assistant", name: agent.name, content: text, toolCalls });
          const results = await this.resolveToolCalls(toolCalls, epoch);
          if (this.epoch !== epoch) return this.cancelSubGeneration(id, agent.name);
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

      if (this.epoch !== epoch) return this.cancelSubGeneration(id, agent.name);

      await this.conversation.completeSubGeneration(id, text);
      return { agent: agent.name, text };
    } catch (error) {
      if (this.epoch !== epoch) return this.cancelSubGeneration(id, agent.name);
      // Finalize the partial output so the persisted state stays consistent;
      // the error travels back so the coordinator can recover gracefully.
      await this.conversation.completeSubGeneration(id, text);
      this.conversation.emit("error", {
        conversationId: this.conversation.id,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return {
        agent: agent.name,
        text,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async cancelSubGeneration(
    id: string,
    agentName: string,
  ): Promise<SubGenerationResult> {
    await this.conversation.cancelSubGeneration(id);
    return { agent: agentName, text: "", error: "interrupted" };
  }

  /** Resolve a task's agent by exact name or alias. */
  private findAgent(nameOrAlias: string): Agent | null {
    const normalized = nameOrAlias.trim().toLowerCase();
    for (const agent of this.agents) {
      if (agent.name.toLowerCase() === normalized) return agent;
      for (const alias of agent.aliases) {
        if (alias.toLowerCase() === normalized) return agent;
      }
    }
    return null;
  }

  private waitForToolResult(id: string, _epoch: number): Promise<ToolCallResult> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.toolWaiters.delete(id);
        resolve({ id, error: `Tool call "${id}" timed out` });
      }, this.toolTimeoutMs);
      this.toolWaiters.set(id, (result) => {
        clearTimeout(timeout);
        resolve(result);
      });
    });
  }

  private cancelToolWaiters(reason: string): void {
    for (const [id, resolve] of [...this.toolWaiters]) {
      this.toolWaiters.delete(id);
      resolve({ id, error: reason });
    }
  }

  // -------------------------------------------------------------------------
  // Speech (LLM deltas → sentence buffering → TTS → audio-out)
  // -------------------------------------------------------------------------

  private feedDelta(delta: string): void {
    this.speechBuffer += delta;
    // Flush every complete sentence so multi-sentence deltas (and deltas
    // that span several sentences) are spoken as separate TTS requests.
    for (;;) {
      let boundary = -1;
      for (let i = 0; i < this.speechBuffer.length; i++) {
        const ch = this.speechBuffer[i];
        if (ch === "." || ch === "!" || ch === "?" || ch === "\n") {
          boundary = i;
          break;
        }
      }
      if (boundary < 0) break;
      const sentence = this.speechBuffer.slice(0, boundary + 1).trim();
      this.speechBuffer = this.speechBuffer.slice(boundary + 1);
      if (sentence) this.speak(sentence);
    }
  }

  private flushSpeech(): void {
    const rest = this.speechBuffer.trim();
    this.speechBuffer = "";
    if (rest) this.speak(rest);
  }

  /** Synthesize a sentence and push the audio chunks out to the app. */
  private speak(sentence: string): void {
    const tts = this.tts;
    if (!tts) return;
    const epoch = this.epoch;
    this.speechChain = this.speechChain.then(async () => {
      if (!this.started || this.epoch !== epoch) return;
      try {
        for await (const chunk of tts.stream({ text: sentence })) {
          if (!this.started || this.epoch !== epoch) break;
          this.conversation.pushAudio({
            data: chunk,
            timestamp: Date.now(),
            sequence: this.audioSequence++,
          });
        }
      } catch (error) {
        if (this.epoch !== epoch) return; // interrupted
        this.conversation.emit("error", {
          conversationId: this.conversation.id,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    });
  }
}
