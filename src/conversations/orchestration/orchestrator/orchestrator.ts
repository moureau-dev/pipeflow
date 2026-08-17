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
import type { AudioChunk, Generation, Participant, ToolCallResult, Turn, UserId } from "../../types";
import {
  Coordination,
  CoordinationBudgetExceeded,
  CoordinationCancelled,
  CoordinationSuspension,
  type CoordinationOptions,
  type CoordinationRegistration,
  type CoordinationRuntime,
  type DelegatedTask,
  type DelegationResult,
  type PendingFrame,
} from "../coordination/coordination";
import { TextChunker } from "../text-chunker";

export interface OrchestratorOptions {
  conversation: Conversation;
  /**
   * The agents the orchestrator routes turns to. With more than one agent,
   * unaddressed turns run through the built-in `understand` coordination,
   * which can delegate to agents, ask the user, or answer directly. Omit
   * for transcription-only mode (audio in, turns and transcripts out — no
   * LLM or TTS required).
   */
  agents?: Agent[];
  /** Defaults to the first agent's LLM. */
  llm?: LLM;
  /** STT for voice turns. Omit for text-only conversations (`send()`). */
  stt?: STT;
  /** TTS for spoken output. Not required for text-only conversations. */
  tts?: TTS;
  /** Used to rehydrate conversation history on start. */
  persistence?: Persistence;
  /** How long to wait for the application to resolve a tool call. */
  toolTimeoutMs?: number;
  /** Safety bound on tool-call round trips per generation. */
  maxToolIterations?: number;
  /**
   * Additional coordinations the runtime can delegate to, registered by
   * name (the key is the coordination's name).
   */
  coordinations?: Record<string, CoordinationRegistration>;
  /** Safety bound on LLM reasoning steps per coordination execution. */
  maxCoordinationSteps?: number;
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

/** A coordination execution parked while waiting for the user to answer. */
interface PendingExecution {
  /** Execution stack, outermost frame first. */
  frames: PendingFrame[];
  question: string;
  /** Coordination step count so the budget survives the suspension. */
  stepCount: number;
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
 * A short context suffix appended automatically to every user turn, so the
 * model knows the time and who is speaking (and who else is in the
 * conversation) — e.g. "enhance the message I just sent" resolves to a real
 * user id. Applied once, when the turn enters history; every generation path
 * (direct, coordination, delegated) seeds from that history.
 */
export function formatTurnContext(
  participant: Participant,
  participants: readonly Participant[],
  date = new Date(),
): string {
  const describe = (p: Participant): string => {
    const displayName = p.aliases[0] ?? p.userId;
    const aliases = p.aliases.length > 0 ? ` (aliases: ${p.aliases.join(", ")})` : "";
    return `${displayName} with user id ${p.userId}${aliases}`;
  };
  const others = participants.filter((p) => p.userId !== participant.userId);
  const othersLine =
    others.length > 0
      ? ` The other participants are ${others.map(describe).join(", ")}.`
      : "";
  return `\n\nAdditional context: ${formatTimeContext(date)} The current user is ${describe(participant)}.${othersLine}`;
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
 * Like `pickAgent` but without the default: only returns an agent the turn
 * explicitly addresses by name or alias.
 */
function findAddressedAgent(agents: readonly Agent[], text: string): Agent | null {
  const normalized = text.toLowerCase();
  for (const agent of agents) {
    if (agent.name && normalized.includes(agent.name.toLowerCase())) return agent;
    for (const alias of agent.aliases) {
      if (normalized.includes(alias.toLowerCase())) return agent;
    }
  }
  return null;
}

/** The built-in coordinator: understands the request and decides what's next. */
function buildUnderstandPrompt(agents: readonly Agent[]): string {
  const roster = agents
    .map((agent) => {
      const aliases =
        agent.aliases.length > 0 ? ` (aliases: ${agent.aliases.join(", ")})` : "";
      return `- ${agent.name}${aliases}`;
    })
    .join("\n");
  return `You are the conversation coordinator.

Your job is to understand what the user is trying to accomplish and decide what
should happen next. You never perform domain work yourself.

The available agents are:
${roster}

Decide the best next step and take exactly one:
- delegate to one or more agents ("agents"), each with a self-contained prompt
  describing exactly what to do and any context they need;
- pass the work to another coordination ("coordination");
- ask the user for missing details ("clarify") when the request is ambiguous or
  missing critical information — batch every missing detail into the "missing"
  array in one call, never one question at a time. You may ask at most twice
  per request; after that, state reasonable assumptions and answer;
- answer directly ("complete") when you have everything you need.

When you delegate, briefly narrate what you are doing, wait for the results,
then compose a single concise spoken answer and complete. Do not narrate your
internal reasoning.`;
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
  private readonly stt: STT | undefined;
  private readonly tts: TTS | undefined;
  private readonly persistence: Persistence | undefined;
  private readonly toolTimeoutMs: number;
  private readonly maxToolIterations: number;
  private readonly maxCoordinationSteps: number;
  private readonly coordinations: Record<string, Coordination>;
  private readonly understand: Coordination | null;
  private readonly temperature: number | undefined;
  private readonly maxTokens: number | undefined;

  private started = false;
  private generating = false;
  private epoch = 0;
  private speechEpoch = 0;
  private coordinationEpoch = 0;
  private coordinationStepCount = 0;
  private coordinationRunId = "";
  private pendingExecution: PendingExecution | null = null;
  private readonly unsubscribers: (() => void)[] = [];
  private readonly sttSessions = new Map<UserId, SttSessionEntry>();
  private readonly history: LLMMessage[] = [];
  private readonly toolWaiters = new Map<string, (result: ToolCallResult) => void>();
  private generationChain: Promise<void> = Promise.resolve();
  private speechChain: Promise<void> = Promise.resolve();
  private readonly chunker = new TextChunker();
  private pendingTurns = 0;
  private pendingGenerations = 0;
  private audioSequence = 0;
  private turnSequence = 0;

  constructor(options: OrchestratorOptions) {
    const agents = options.agents ?? [];
    const llm = options.llm ?? agents[0]?.llm;
    if (agents.length > 0 && !llm) {
      throw new Error(
        "Orchestrator requires an LLM when agents are attached: " +
          "pass one explicitly or configure an agent with one",
      );
    }
    this.conversation = options.conversation;
    this.agents = agents;
    this.llm = llm;
    this.stt = options.stt;
    this.tts = options.tts;
    this.persistence = options.persistence;
    this.toolTimeoutMs = options.toolTimeoutMs ?? 30_000;
    this.maxToolIterations = options.maxToolIterations ?? 10;
    this.maxCoordinationSteps = options.maxCoordinationSteps ?? 20;
    this.temperature = options.temperature;
    this.maxTokens = options.maxTokens;

    // Coordinations are registered by name. The built-in `understand` runs
    // unaddressed turns: it decides whether to delegate to agents, ask the
    // user, or answer directly. Apps can override it by registering their
    // own "understand" key, and add their own (e.g. clarify, review).
    const registrations: Record<string, CoordinationRegistration> = {
      ...(options.coordinations ?? {}),
    };
    if (agents.length > 1 && !registrations.understand) {
      registrations.understand = { prompt: buildUnderstandPrompt(agents) };
    }
    const coordinations: Record<string, Coordination> = {};
    for (const [name, registration] of Object.entries(registrations)) {
      coordinations[name] = new Coordination(
        { name, ...registration },
        this.coordinationRuntime(),
      );
    }
    this.coordinations = coordinations;
    this.understand = this.coordinations["understand"] ?? null;
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
            content: this.historyMessage(entry.turn),
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
      this.conversation.on("text-in", ({ userId, text }) => this.onFinal(userId, text)),
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
    this.speechEpoch++;
    this.pendingExecution = null;
    this.stopLlms();
    this.tts?.stop();
    this.cancelToolWaiters("conversation stopped");
    this.chunker.clear();
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
    if (!this.stt) return; // text-only conversation
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

    if (this.pendingExecution) {
      // The participant is answering a pending question — this audio is the
      // answer, not an interruption. Stop the question's playback only; the
      // coordination stays parked and resumes on the final transcript.
      this.stopSpeech();
      return;
    }

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

  /**
   * The user-message form of a turn: display name, text, and the automatic
   * context suffix (time + speaker + roster) baked in at history time.
   */
  private historyMessage(turn: Turn): string {
    const participant = this.conversation.state.participants.get(turn.participantId);
    const participants = [...this.conversation.state.participants.values()];
    const context = participant
      ? formatTurnContext(participant, participants, new Date(turn.startedAt))
      : "";
    return `${turn.participantName}: ${turn.text}${context}`;
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
        content: this.historyMessage(turn),
      });
      if (this.agents.length === 0) return;

      if (this.pendingExecution) {
        // The user answered a pending coordination question: resume it with
        // this turn instead of starting a fresh generation.
        this.enqueueCoordinationRun(() => this.resumeExecution(turn));
        return;
      }

      if (this.agents.length === 1 || findAddressedAgent(this.agents, turn.text)) {
        // Single-agent conversations, and turns that explicitly address an
        // agent by name/alias, route straight to that agent.
        this.queueGeneration(turn);
        return;
      }

      // Otherwise the built-in `understand` coordination decides: delegate to
      // agents, ask the user, or answer directly.
      this.enqueueCoordinationRun(() => this.runDefaultCoordination(turn));
    } finally {
      this.pendingTurns--;
    }
  }

  private onInterrupt(): void {
    this.epoch++;
    this.speechEpoch++;
    this.pendingExecution = null;
    this.stopLlms();
    this.tts?.stop();
    this.cancelToolWaiters("interrupted");
    this.chunker.clear();
  }

  /** Stop the current TTS playback without cancelling the generation. */
  private stopSpeech(): void {
    this.speechEpoch++;
    this.chunker.clear();
    this.tts?.stop();
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
    if (!llm) return;
    this.generating = true;
    try {
      await this.runGeneration(this.epoch, turn, agent, llm);
    } finally {
      this.generating = false;
    }
  }

  private async runGeneration(
    epoch: number,
    turn: Turn,
    agent: Agent,
    llm: LLM,
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
          const results = await this.resolveToolCalls(toolCalls, epoch);
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
  ): Promise<ResolvedToolCall[]> {
    const resolutions = calls.map((call) => this.waitForToolResult(call.id, epoch));
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

  // -------------------------------------------------------------------------
  // Coordination runtime
  // -------------------------------------------------------------------------

  /**
   * The runtime the coordinations reason against. Binds the coordination
   * primitives (delegate to agents, ask the user, speech, budget, cancellation)
   * to the orchestrator's machinery without coupling `Coordination` to it.
   */
  private coordinationRuntime(): CoordinationRuntime {
    const orchestrator = this;
    return {
      // Getters: read the current state at call time (the coordinations are
      // built after the runtime object is created).
      get agents() {
        return orchestrator.agents;
      },
      get coordinations() {
        return Object.values(orchestrator.coordinations);
      },
      get llm() {
        return orchestrator.llm!;
      },
      get history() {
        return orchestrator.history;
      },
      delegateAgentTasks: (tasks) => this.delegateAgentTasks(tasks),
      askUser: (frame, question) => this.askUser(frame, question),
      onDelta: (delta) => this.feedDelta(delta),
      flushSpeech: () => this.flushSpeech(),
      speak: (sentence) => this.speak(sentence),
      isCancelled: () => this.epoch !== this.coordinationEpoch,
      checkBudget: () => this.checkCoordinationBudget(),
    };
  }

  /** Serialize coordination runs with agent generations (one track at a time). */
  private enqueueCoordinationRun(run: () => Promise<void>): void {
    this.pendingGenerations++;
    this.generationChain = this.generationChain.then(async () => {
      this.generating = true;
      try {
        await run();
      } finally {
        this.generating = false;
        this.pendingGenerations--;
      }
    });
  }

  /**
   * Run the built-in `understand` coordination on an unaddressed turn. A
   * streaming generation is opened for the conversation's default agent; the
   * coordination's final answer (or question) completes it.
   */
  private async runDefaultCoordination(turn: Turn): Promise<void> {
    const understand = this.understand;
    if (!understand || !this.llm) return;
    this.coordinationEpoch = this.epoch;
    this.coordinationStepCount = 0;
    this.coordinationRunId = crypto.randomUUID();
    await this.conversation.pushGeneration({
      id: this.coordinationRunId,
      conversationId: this.conversation.id,
      agentName: this.agents[0]!.name,
      text: "",
      status: "streaming",
      startedAt: Date.now(),
    });

    try {
      // The current turn is already in history, so no separate input message.
      const output = await understand.run();
      await this.finalizeCoordinationOutput(String(output));
    } catch (error) {
      if (error instanceof CoordinationSuspension) {
        await this.recordSuspension(error);
      } else if (error instanceof CoordinationCancelled) {
        // Discarded by an interrupt — nothing to finalize.
      } else {
        this.emitCoordinationError(error);
      }
    }
  }

  /**
   * Resume a parked coordination with the user's answer, propagating the
   * result back up the frame stack to the outermost coordination.
   */
  private async resumeExecution(turn: Turn): Promise<void> {
    const pending = this.pendingExecution;
    if (!pending) return;
    this.pendingExecution = null;
    this.coordinationEpoch = this.epoch;
    this.coordinationStepCount = pending.stepCount;
    this.coordinationRunId = crypto.randomUUID();
    await this.conversation.pushGeneration({
      id: this.coordinationRunId,
      conversationId: this.conversation.id,
      agentName: this.agents[0]!.name,
      text: "",
      status: "streaming",
      startedAt: Date.now(),
    });

    const frames = [...pending.frames]; // outermost first
    const innermost = frames.pop();
    if (!innermost) return;

    let result: unknown;
    try {
      result = await innermost.coordination.resume(innermost.state, turn.text);
    } catch (error) {
      if (error instanceof CoordinationSuspension) {
        error.frames.unshift(...frames);
        await this.recordSuspension(error);
      } else if (!(error instanceof CoordinationCancelled)) {
        this.emitCoordinationError(error);
      }
      return;
    }

    // Feed the result back into each remaining parent frame, innermost first.
    while (frames.length > 0) {
      const parent = frames.pop()!;
      const toolCallId = parent.state.pendingToolCallId ?? crypto.randomUUID();
      try {
        result = await parent.coordination.continueWith(parent.state, {
          role: "tool",
          toolCallId,
          name: "delegate",
          content: JSON.stringify(result),
        });
      } catch (error) {
        if (error instanceof CoordinationSuspension) {
          error.frames.unshift(...frames);
          await this.recordSuspension(error);
        } else if (!(error instanceof CoordinationCancelled)) {
          this.emitCoordinationError(error);
        }
        return;
      }
    }

    await this.finalizeCoordinationOutput(String(result));
  }

  /** Complete the current generation and record the coordination's answer. */
  private async finalizeCoordinationOutput(text: string): Promise<void> {
    this.flushSpeech();
    await this.speechChain;
    if (this.epoch !== this.coordinationEpoch) return;
    await this.conversation.completeGeneration(text);
    await this.conversation.pushTranscript({
      speaker: this.agents[0]!.name,
      speakerKind: "agent",
      text,
    });
    this.history.push({
      role: "assistant",
      name: this.agents[0]!.name,
      content: text,
    });
  }

  /** Park a suspended coordination: record the question and store the stack. */
  private async recordSuspension(suspension: CoordinationSuspension): Promise<void> {
    await this.conversation.completeGeneration(suspension.question);
    await this.conversation.pushTranscript({
      speaker: this.agents[0]!.name,
      speakerKind: "agent",
      text: suspension.question,
    });
    this.history.push({
      role: "assistant",
      name: this.agents[0]!.name,
      content: suspension.question,
    });
    this.pendingExecution = {
      frames: suspension.frames,
      question: suspension.question,
      stepCount: this.coordinationStepCount,
    };
  }

  /** Throw the suspension that parks a coordination waiting for the user. */
  private askUser(frame: PendingFrame, question: string): never {
    // Recording (transcript, history, generation) happens when the suspension
    // is caught at the top of the stack, where the full frame set is known.
    throw new CoordinationSuspension([frame], question);
  }

  /** Enforce the per-execution reasoning step budget. */
  private checkCoordinationBudget(): void {
    this.coordinationStepCount++;
    if (this.coordinationStepCount > this.maxCoordinationSteps) {
      throw new CoordinationBudgetExceeded(
        `exceeded ${this.maxCoordinationSteps} coordination steps`,
      );
    }
  }

  private emitCoordinationError(error: unknown): void {
    this.conversation.emit("error", {
      conversationId: this.conversation.id,
      error: error instanceof Error ? error : new Error(String(error)),
    });
    // Finalize the current coordination generation so an errored run does not
    // leave a dangling "streaming" record. The narration was streamed to
    // speech; the failure surfaces through the error event.
    if (this.epoch === this.coordinationEpoch) {
      void this.conversation.completeGeneration("");
    }
  }

  /** Run delegated agent tasks in parallel and surface their work. */
  private async delegateAgentTasks(tasks: DelegatedTask[]): Promise<DelegationResult[]> {
    const results = await Promise.all(
      tasks.map((task) =>
        this.runSubGeneration(this.coordinationEpoch, task, this.coordinationRunId),
      ),
    );

    if (this.epoch !== this.coordinationEpoch) {
      return results.map(({ agent, text, error }) => ({ agent, text, error }));
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
    return results;
  }

  /**
   * Execute one dispatched task as a sub-generation: the target agent's own
   * LLM, context, and tools, running text-only (no TTS). The final text is
   * returned so the coordinator can merge it into the spoken answer.
   */
  private async runSubGeneration(
    epoch: number,
    task: DelegatedTask,
    parentGenerationId: string,
  ): Promise<DelegationResult> {
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
              if (text.length === 0) this.conversation.noteTiming("firstToken", id);
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
  ): Promise<DelegationResult> {
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
    // First-token latency for the in-flight generation (agent or
    // coordination — both stream narration through here).
    this.conversation.noteTiming("firstToken");
    // The chunker turns the token stream into speakable chunks: strong
    // sentence boundaries flush immediately, long clauses flush at soft
    // boundaries, and nothing waits indefinitely for punctuation.
    for (const chunk of this.chunker.push(delta)) {
      this.speak(chunk);
    }
  }

  private flushSpeech(): void {
    const rest = this.chunker.flush();
    if (rest) this.speak(rest);
  }

  /** Synthesize a sentence and push the audio chunks out to the app. */
  private speak(sentence: string): void {
    const tts = this.tts;
    if (!tts) return;
    // Buffering boundary: the first sentence flushed to TTS.
    this.conversation.noteTiming("firstTtsText");
    const epoch = this.epoch;
    const speechEpoch = this.speechEpoch;
    this.speechChain = this.speechChain.then(async () => {
      if (!this.started || this.epoch !== epoch || this.speechEpoch !== speechEpoch) {
        return;
      }
      // The TTS provider was asked to synthesize.
      this.conversation.noteTiming("firstTtsRequest");
      try {
        let first = true;
        for await (const chunk of tts.stream({ text: sentence })) {
          if (
            !this.started ||
            this.epoch !== epoch ||
            this.speechEpoch !== speechEpoch
          ) {
            break;
          }
          if (first) {
            first = false;
            // The provider produced its first audio chunk.
            this.conversation.noteTiming("firstTtsAudio");
          }
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
