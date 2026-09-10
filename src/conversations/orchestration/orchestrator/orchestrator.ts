import type { Agent } from "../../../agents/agent";
import type { Tool } from "../../../agents/tools/tools";
import type { Conversation } from "../../conversation/conversation";
import type { Persistence } from "../../../persistence/persistence";
import type {
  LLM,
  LLMMessage,
  LLMToolDefinition,
} from "../../../providers/llm/types";
import type { STT, STTSession } from "../../../providers/stt/types";
import type { TTS } from "../../../providers/tts/types";
import type { AudioChunk, Turn, UserId } from "../../types";
import type { CoordinationRegistration } from "../coordination/coordination";
import { ConversationHistory, type HistoryWindow } from "./history/history";
import { findAddressedAgent, pickAgent } from "./routing/routing";
import { GenerationRunner } from "./generation/generation";
import { SpeechPipeline } from "./speech/speech";
import { ToolCallManager } from "./tools/tools";
import { CoordinationRunner } from "./coordination-runner/coordination-runner";
import type { Logger } from "../../../logger/types";

/**
 * Extra attempts after a transient provider failure that produced no output.
 * Kept tiny: each attempt is a fresh LLM request (latency + cost), and the
 * failure is usually a one-off upstream abort.
 */
const MAX_TRANSIENT_GENERATION_RETRIES = 1;

/**
 * True for provider failures worth one silent retry: mid-stream aborts (the
 * Bedrock-via-OpenRouter failure nova models show as "provider aborted the
 * stream"), idle timeouts, and HTTP 429/5xx. Real failures (400, auth, bad
 * requests) are not retried.
 */
function isTransientProviderError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /aborted the stream|timed out|idle timeout|\b(429|50[0-9])\b/i.test(error.message);
}

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
  /** How long to wait for a tool call to resolve (auto-executed or app-managed). */
  toolTimeoutMs?: number;
  /** Safety bound on tool-call round trips per generation. */
  maxToolIterations?: number;
  /**
   * Execute the agents' tools automatically (default `true`), feeding each
   * tool's result — or a caught error — back into the model loop, like
   * `Agent.run()` does. Set `false` for the application-managed contract:
   * listen for `tool-call` events and resolve each call yourself with
   * `conversation.resolveToolCall()`. The `tool-call` event fires in both
   * modes, so apps can observe every call.
   */
  autoExecuteTools?: boolean;
  /**
   * Additional coordinations the runtime can delegate to, registered by
   * name (the key is the coordination's name).
   */
  coordinations?: Record<string, CoordinationRegistration>;
  /** Safety bound on LLM reasoning steps per coordination execution. */
  maxCoordinationSteps?: number;
  temperature?: number;
  maxTokens?: number;
  /**
   * When true, a multi-agent coordination that answers directly without
   * planning is retried once. Defaults to false.
   */
  retryDirectAnswer?: boolean;
  /**
   * How much conversation history each LLM request carries (default
   * `{ maxTurns: 5, maxChars: 4000 }` — provider TTFT grows with input size,
   * and a bounded window keeps requests in the fast regime). Pass `false` to
   * always send the full history.
   */
  historyWindow?: HistoryWindow | false;
  /**
   * How many TTS synthesis requests may be in flight at once (default 2).
   * More lets the sentences of a multi-sentence reply synthesize in parallel
   * (kills the gaps between them) at the cost of provider concurrency — some
   * free TTS variants rate-limit concurrent requests. Passed through to the
   * speech pipeline; see `SpeechPipelineOptions.maxConcurrentRequests`.
   */
  maxConcurrentTtsRequests?: number;
  logger?: Logger;
}

interface SttSessionEntry {
  session: STTSession;
  turnStartedAt: number | null;
}

/**
 * The realtime conversation state machine and multi-agent coordinator.
 *
 * Wires the conversation to the providers and routes each turn to an agent.
 * The heavy machinery lives in focused collaborators — history, routing,
 * generation, speech, tools, and coordination — so this class owns only the
 * lifecycle and event wiring:
 *
 * ```text
 * audio-in ──► STT ──► turn ──► coordinator ──► agent ──► LLM ──► TTS ──► audio-out
 *                                    │
 *                                    └─► tool-call ──► tool runs ──► resume
 * ```
 *
 * Deltas stream to TTS immediately (so the agent can narrate while a tool
 * runs), tool calls pause the generation while the tool executes — the
 * framework runs the agent's own tools by default, or the application
 * resolves them when `autoExecuteTools` is off — and interruptions cancel
 * the current generation, discarding any stale tool results or audio via a
 * generation epoch.
 */
export class Orchestrator {
  private readonly conversation: Conversation;
  private readonly agents: Agent[];
  private readonly llm: LLM | undefined;
  private readonly stt: STT | undefined;
  private readonly tts: TTS | undefined;
  private readonly persistence: Persistence | undefined;
  private readonly maxToolIterations: number;
  private readonly historyWindow: HistoryWindow | false;
  private readonly temperature: number | undefined;
  private readonly maxTokens: number | undefined;
  private readonly logger: Logger;

  private readonly history: ConversationHistory;
  private readonly speech: SpeechPipeline;
  private readonly tools: ToolCallManager;
  private readonly generation: GenerationRunner;
  private readonly coordination: CoordinationRunner;

  private started = false;
  private generating = false;
  private epoch = 0;
  private generationChain: Promise<void> = Promise.resolve();
  private readonly unsubscribers: (() => void)[] = [];
  private readonly sttSessions = new Map<UserId, SttSessionEntry>();
  private pendingTurns = 0;
  private pendingGenerations = 0;
  private turnSequence = 0;
  private idleResolve: (() => void) | null = null;
  private currentAbortController?: AbortController;

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
    this.maxToolIterations = options.maxToolIterations ?? 10;
    this.historyWindow = options.historyWindow ?? { maxTurns: 5, maxChars: 4_000 };
    this.temperature = options.temperature;
    this.maxTokens = options.maxTokens;
    this.logger = options.logger ?? { info() {}, warn() {}, error() {}, debug() {} } as Logger;

    this.history = new ConversationHistory();
    this.speech = new SpeechPipeline({
      tts: this.tts,
      conversation: this.conversation,
      isCurrent: (epoch) => this.started && epoch === this.epoch,
      ...(options.maxConcurrentTtsRequests !== undefined
        ? { maxConcurrentRequests: options.maxConcurrentTtsRequests }
        : {}),
    });
    const toolRegistry = new Map<string, Tool<never, unknown>>();
    for (const agent of agents) {
      for (const tool of agent.tools) toolRegistry.set(tool.name, tool);
    }
    this.tools = new ToolCallManager(this.conversation, options.toolTimeoutMs ?? 30_000, {
      tools: toolRegistry,
      autoExecute: options.autoExecuteTools ?? true,
    });
    this.generation = new GenerationRunner();
    this.coordination = new CoordinationRunner({
      conversation: this.conversation,
      agents: () => this.agents,
      llm: () => this.llm,
      history: this.history,
      historyWindow: this.historyWindow,
      speech: this.speech,
      generation: this.generation,
      tools: this.tools,
      maxCoordinationSteps: options.maxCoordinationSteps ?? 20,
      maxToolIterations: this.maxToolIterations,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      currentEpoch: () => this.epoch,
      isCurrent: (epoch) => this.started && epoch === this.epoch,
      currentSignal: () => this.currentAbortController?.signal,
      retryDirectAnswer: options.retryDirectAnswer,
      logger: this.logger,
    });
    this.coordination.register(options.coordinations ?? {}, agents);
  }

  /**
   * Attach to the conversation: rehydrate history from persistence and
   * subscribe to conversation events.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.logger.info("orchestrator started", { conversationId: this.conversation.id });

    if (this.persistence) {
      const [turns, generations] = await Promise.all([
        this.persistence.listTurns(this.conversation.id),
        this.persistence.listGenerations(this.conversation.id),
      ]);
      this.history.rehydrate(turns, generations, this.conversation);
      this.logger.debug("history rehydrated", {
        conversationId: this.conversation.id,
        turns: turns.length,
        generations: generations.length,
      });
    }

    this.unsubscribers.push(
      this.conversation.on("stop", () => void this.stop()),
      this.conversation.on("audio-in", (payload) => this.onAudioIn(payload)),
      this.conversation.on("text-in", ({ userId, text }) => this.onFinal(userId, text)),
      this.conversation.on("interrupt", () => this.onInterrupt()),
      this.conversation.on("tool-call-result", ({ result }) => this.tools.handleResult(result)),
    );
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.logger.info("orchestrator stopping", { conversationId: this.conversation.id });
    this.epoch++;
    this.currentAbortController?.abort();
    this.currentAbortController = undefined;
    this.coordination.cancel();
    this.speech.stop();
    this.tools.cancelAll("conversation stopped");
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
    const sessions = [...this.sttSessions.values()];
    this.sttSessions.clear();
    for (const { session } of sessions) {
      await session.end().catch((err) => {
        this.logger.error("failed to end STT session", { error: String(err) });
      });
    }
    this.checkIdle();
  }

  /**
   * Resolve once every queued and in-flight turn and generation has
   * finished processing. Uses event notifications instead of polling.
   */
  async whenIdle(): Promise<void> {
    if (this.pendingTurns === 0 && this.pendingGenerations === 0 && !this.generating) return;
    await Promise.resolve();
    if (this.pendingTurns === 0 && this.pendingGenerations === 0 && !this.generating) return;
    return new Promise((resolve) => {
      this.idleResolve = resolve;
    });
  }

  private checkIdle(): void {
    if (this.pendingTurns === 0 && this.pendingGenerations === 0 && !this.generating) {
      if (this.idleResolve) {
        const resolve = this.idleResolve;
        this.idleResolve = null;
        resolve();
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

    if (this.coordination.hasPending()) {
      // The participant is answering a pending question — this audio is the
      // answer, not an interruption. Stop the question's playback only; the
      // coordination stays parked and resumes on the final transcript.
      this.speech.stop();
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

  private async processTurn(turn: Turn): Promise<void> {
    try {
      await this.conversation.pushTurn(turn);
      await this.conversation.pushTranscript({
        speaker: turn.participantName,
        speakerKind: "participant",
        text: turn.text,
      });
      this.history.addUserTurn(turn, this.conversation);
      this.logger.debug("turn processed", {
        conversationId: this.conversation.id,
        participant: turn.participantName,
        text: turn.text.slice(0, 100),
      });
      if (this.agents.length === 0) return;

      if (this.coordination.hasPending()) {
        this.enqueueCoordinationRun(() => this.coordination.resume(turn));
        return;
      }

      if (this.agents.length === 1 || findAddressedAgent(this.agents, turn.text)) {
        this.queueGeneration(turn);
        return;
      }

      this.enqueueCoordinationRun(() => this.coordination.runDefault(turn));
    } finally {
      this.pendingTurns--;
      this.checkIdle();
    }
  }

  private onInterrupt(): void {
    this.epoch++;
    this.currentAbortController?.abort();
    this.currentAbortController = undefined;
    this.coordination.cancel();
    this.speech.stop();
    this.tools.cancelAll("interrupted");
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
        this.pendingGenerations--;
        this.checkIdle();
        return;
      }
      try {
        await this.generate(turn);
      } finally {
        this.pendingGenerations--;
        this.checkIdle();
      }
    });
  }

  private async generate(turn: Turn): Promise<void> {
    if (this.agents.length === 0) return;
    const agent = pickAgent(this.agents, turn.text);
    if (!agent) return;
    const llm = agent.llm ?? this.llm;
    if (!llm) return;
    this.generating = true;
    this.logger.info("generation started", {
      conversationId: this.conversation.id,
      agent: agent.name,
      turnId: turn.id,
    });
    try {
      await this.runGeneration(this.epoch, turn, agent, llm);
    } finally {
      this.generating = false;
      this.checkIdle();
    }
  }

  private async runGeneration(
    epoch: number,
    turn: Turn,
    agent: Agent,
    llm: LLM,
  ): Promise<void> {
    this.currentAbortController = new AbortController();
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
    messages.push(...this.history.windowed(this.historyWindow));

    let outcome: Awaited<ReturnType<GenerationRunner["run"]>>;
    for (let attempt = 0; ; attempt++) {
      outcome = await this.generation.run({
        agentName: agent.name,
        llm,
        messages,
        tools: definitions,
        temperature: this.temperature,
        maxTokens: this.maxTokens,
        maxToolIterations: this.maxToolIterations,
        isCurrent: () => this.epoch === epoch,
        signal: this.currentAbortController?.signal,
        agentNames: this.agents.length > 1,
        onDelta: (delta) => this.speech.feed(delta, epoch),
        resolveToolCalls: (calls) => this.tools.resolveCalls(calls),
      });
      if (this.epoch !== epoch) return;
      const retryable =
        attempt < MAX_TRANSIENT_GENERATION_RETRIES &&
        outcome.status === "error" &&
        outcome.text.length === 0 &&
        (outcome.toolRounds ?? 0) === 0 &&
        isTransientProviderError(outcome.error);
      if (!retryable) break;
      this.logger.warn("retrying transient provider error", {
        attempt: attempt + 1,
        error: String(outcome.error),
      });
    }

    if (this.epoch !== epoch) return;
    if (outcome.status === "interrupted") {
      this.logger.info("generation interrupted", { agent: agent.name });
      return;
    }

    if (outcome.status === "error") {
      this.logger.error("generation failed", { agent: agent.name, error: String(outcome.error) });
      this.conversation.emit("error", {
        conversationId: this.conversation.id,
        error: outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error)),
      });
      await this.conversation.completeGeneration(outcome.text);
      if (outcome.text) {
        await this.conversation.pushTranscript({
          speaker: agent.name,
          speakerKind: "agent",
          text: outcome.text,
        });
        this.history.addAssistant(agent.name, outcome.text);
      }
      return;
    }

    this.speech.flush(epoch);
    await this.speech.waitForIdle();
    if (this.epoch !== epoch) return;

    await this.conversation.completeGeneration(outcome.text);
    await this.conversation.pushTranscript({
      speaker: agent.name,
      speakerKind: "agent",
      text: outcome.text,
    });
    this.history.addAssistant(agent.name, outcome.text);
    this.logger.info("generation completed", {
      agent: agent.name,
      chars: outcome.text.length,
    });
  }

  // -------------------------------------------------------------------------
  // Coordination (serialized with agent generations: one track at a time)
  // -------------------------------------------------------------------------

  private enqueueCoordinationRun(run: () => Promise<void>): void {
    this.pendingGenerations++;
    this.generationChain = this.generationChain.then(async () => {
      this.generating = true;
      this.currentAbortController = new AbortController();
      try {
        await run();
      } finally {
        this.generating = false;
        this.pendingGenerations--;
        this.checkIdle();
      }
    });
  }
}
