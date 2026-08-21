import type { Agent } from "../../../agents/agent";
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
  /**
   * Bounds how much conversation history each LLM request carries (default
   * `{ maxTurns: 5, maxChars: 4000 }` — provider TTFT grows with input size,
   * and a bounded window keeps requests in the fast regime). Pass `false` to
   * always send the full history.
   */
  historyWindow?: HistoryWindow | false;
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
  private readonly maxToolIterations: number;
  private readonly historyWindow: HistoryWindow | false;
  private readonly temperature: number | undefined;
  private readonly maxTokens: number | undefined;

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

    this.history = new ConversationHistory();
    this.speech = new SpeechPipeline({
      tts: this.tts,
      conversation: this.conversation,
      isCurrent: (epoch) => this.started && epoch === this.epoch,
    });
    this.tools = new ToolCallManager(this.conversation, options.toolTimeoutMs ?? 30_000);
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

    if (this.persistence) {
      const [turns, generations] = await Promise.all([
        this.persistence.listTurns(this.conversation.id),
        this.persistence.listGenerations(this.conversation.id),
      ]);
      this.history.rehydrate(turns, generations, this.conversation);
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
    this.epoch++;
    this.coordination.cancel();
    this.stopLlms();
    this.speech.stop();
    this.tools.cancelAll("conversation stopped");
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
      if (this.agents.length === 0) return;

      if (this.coordination.hasPending()) {
        // The user answered a pending coordination question: resume it with
        // this turn instead of starting a fresh generation.
        this.enqueueCoordinationRun(() => this.coordination.resume(turn));
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
      this.enqueueCoordinationRun(() => this.coordination.runDefault(turn));
    } finally {
      this.pendingTurns--;
    }
  }

  private onInterrupt(): void {
    this.epoch++;
    this.coordination.cancel();
    this.stopLlms();
    this.speech.stop();
    this.tools.cancelAll("interrupted");
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
    messages.push(...this.history.windowed(this.historyWindow));

    const outcome = await this.generation.run({
      agentName: agent.name,
      llm,
      messages,
      tools: definitions,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      maxToolIterations: this.maxToolIterations,
      isCurrent: () => this.epoch === epoch,
      onDelta: (delta) => this.speech.feed(delta, epoch),
      resolveToolCalls: (calls) => this.tools.resolveCalls(calls),
    });

    // A stale run (interrupt/stop) is discarded entirely — the conversation
    // already marked the generation cancelled.
    if (this.epoch !== epoch) return;
    if (outcome.status === "interrupted") return;

    if (outcome.status === "error") {
      this.conversation.emit("error", {
        conversationId: this.conversation.id,
        error: outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error)),
      });
      // Finalize whatever was generated so the conversation state stays
      // consistent even though the provider failed.
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
  }

  // -------------------------------------------------------------------------
  // Coordination (serialized with agent generations: one track at a time)
  // -------------------------------------------------------------------------

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
}
