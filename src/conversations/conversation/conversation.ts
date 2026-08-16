import type { Agent } from "../../agents/agent";
import type { Persistence } from "../../persistence/persistence";
import { Orchestrator } from "../orchestration/orchestrator/orchestrator";
import type { STT } from "../../providers/stt/types";
import type { TTS } from "../../providers/tts/types";
import type {
  AudioChunk,
  ConversationId,
  ConversationState,
  ConversationStatus,
  Generation,
  GenerationTiming,
  Participant,
  ParticipantInput,
  Turn,
  UserId,
} from "../types";
import { createConversationState } from "../types";
import {
  Transcription,
  type TranscriptEntry,
  type TranscriptEntryInput,
} from "../transcription/transcription";
import type { ToolCall, ToolCallResult } from "../types";

/** Ensure a generation carries a timing record, initialized from its start. */
function initTiming(generation: Generation): GenerationTiming {
  return (generation.timing ??= { startedAt: generation.startedAt });
}

/** Timing points a generation can record, keyed by the stream event. */
type TimingPoint = "firstToken" | "firstTtsText" | "firstTtsRequest" | "firstTtsAudio";

const timingField: Record<TimingPoint, keyof GenerationTiming> = {
  firstToken: "firstTokenAt",
  firstTtsText: "firstTtsTextAt",
  firstTtsRequest: "firstTtsRequestAt",
  firstTtsAudio: "firstTtsAudioAt",
};

export interface ConversationOptions {
  id: ConversationId;
  agents?: Agent[];
  persistence?: Persistence;
  /**
   * STT provider used to attach realtime processing automatically on
   * `start()`.
   */
  stt?: STT;
  tts?: TTS;
}

export interface ConversationEvents {
  start: { conversationId: ConversationId };
  stop: { conversationId: ConversationId };
  participant: { conversationId: ConversationId; participant: Participant };
  /** Raw audio fed in via `listen()`. Consumed by the orchestrator. */
  "audio-in": { conversationId: ConversationId; userId: UserId; audio: AudioChunk };
  /** Generated audio to be played by the application. */
  audio: { conversationId: ConversationId; audio: AudioChunk };
  turn: { conversationId: ConversationId; turn: Turn };
  transcript: { conversationId: ConversationId; entry: TranscriptEntry };
  generation: { conversationId: ConversationId; generation: Generation };
  /** Live STT partials, for captions and fast UX. Not persisted. */
  "partial-transcript": {
    conversationId: ConversationId;
    userId: UserId;
    text: string;
  };
  /** The model requested a tool call. Resolve it with `resolveToolCall()`. */
  "tool-call": { conversationId: ConversationId; call: ToolCall };
  /** A pending tool call was resolved by the application. */
  "tool-call-result": { conversationId: ConversationId; result: ToolCallResult };
  interrupt: { conversationId: ConversationId };
  /** A provider failure (STT, LLM, or TTS). */
  error: { conversationId: ConversationId; error: Error };
  state: { conversationId: ConversationId; state: ConversationState };
}

/**
 * The public realtime conversation API.
 *
 * A `Conversation` is a runtime handle to a persistent conversation:
 * lifecycle (`start`/`stop`), participants, audio intake (`listen`), and
 * events. When an STT provider is configured, `start()` automatically
 * attaches the orchestrator, which runs the STT/LLM/TTS pipeline and pushes
 * generated audio, turns, transcripts, and tool calls back through
 * conversation events.
 */
export class Conversation {
  readonly id: ConversationId;
  readonly agents: readonly Agent[];
  readonly transcription: Transcription;
  readonly state: ConversationState;
  private readonly persistence: Persistence | undefined;
  private readonly stt: STT | undefined;
  private readonly tts: TTS | undefined;
  private readonly listeners = new Map<
    keyof ConversationEvents,
    Set<(payload: never) => void>
  >();
  private readonly pendingToolCallsById = new Map<string, ToolCall>();
  private readonly subGenerations = new Map<string, Generation>();
  private nextAudioSequence = 0;

  constructor(options: ConversationOptions) {
    this.id = options.id;
    this.agents = options.agents ?? [];
    this.persistence = options.persistence;
    this.stt = options.stt;
    this.tts = options.tts;
    this.transcription = new Transcription(this.id);
    this.state = createConversationState();
  }

  get status(): ConversationStatus {
    return this.state.status;
  }

  get participants(): Participant[] {
    return [...this.state.participants.values()];
  }

  /**
   * Move the conversation into the started state. When an STT provider is
   * configured, this also attaches the orchestrator that runs the realtime
   * pipeline.
   */
  async start(): Promise<void> {
    if (this.state.status === "stopped") {
      throw new Error(`Conversation "${this.id}" has already been stopped`);
    }
    if (this.state.status === "started") return;

    // Validate the realtime configuration before mutating any state.
    const orchestrator = this.buildRealtime();

    this.state.status = "started";
    this.emit("start", { conversationId: this.id });
    this.emitState();

    await orchestrator?.start();
  }

  async stop(): Promise<void> {
    if (this.state.status === "stopped") return;
    this.state.status = "stopped";
    this.pendingToolCallsById.clear();
    const cancelled = this.cancelCurrentGeneration();
    if (cancelled) {
      await this.persistence?.appendGeneration(this.id, cancelled);
    }
    for (const sub of [...this.subGenerations.values()]) {
      if (sub.status === "streaming") {
        sub.status = "cancelled";
        sub.endedAt = Date.now();
        await this.persistence?.appendGeneration(this.id, sub);
      }
    }
    await this.persistence?.finalizeConversation(this.id, Date.now());
    this.emit("stop", { conversationId: this.id });
    this.emitState();
  }

  async participate(
    input: ParticipantInput | ParticipantInput[],
  ): Promise<Participant[]> {
    if (this.state.status === "stopped") {
      throw new Error(`Conversation "${this.id}" has already been stopped`);
    }

    const inputs = Array.isArray(input) ? input : [input];

    // Validate the whole batch before mutating any state.
    const seen = new Set<UserId>();
    for (const item of inputs) {
      if (seen.has(item.userId)) {
        throw new Error(`Duplicate participant "${item.userId}" in batch`);
      }
      seen.add(item.userId);
      if (this.state.participants.has(item.userId)) {
        throw new Error(`Participant "${item.userId}" already exists`);
      }
    }

    const added: Participant[] = [];
    for (const item of inputs) {
      const participant: Participant = {
        userId: item.userId,
        aliases: [...(item.aliases ?? [])],
        joinedAt: Date.now(),
      };
      this.state.participants.set(participant.userId, participant);
      await this.persistence?.addParticipant(this.id, participant);
      added.push(participant);
      this.emit("participant", { conversationId: this.id, participant });
    }
    this.emitState();
    return added;
  }

  /**
   * Send an audio packet. Intentionally synchronous: it means "send this
   * packet", not "wait for this utterance to finish".
   */
  listen(input: { userId: UserId; audio: Uint8Array }): void {
    if (this.state.status !== "started") {
      throw new Error(`Conversation "${this.id}" is not started`);
    }
    if (!this.state.participants.has(input.userId)) {
      throw new Error(`Unknown participant "${input.userId}"`);
    }
    const chunk: AudioChunk = {
      data: input.audio,
      timestamp: Date.now(),
      sequence: this.nextAudioSequence++,
    };
    this.emit("audio-in", { conversationId: this.id, userId: input.userId, audio: chunk });
  }

  /**
   * Stop the currently active generation and prevent any further generated
   * audio from reaching the conversation. The orchestrator cancels the LLM
   * and TTS streams, force-resolves pending tool calls, and discards queued
   * audio; the next participant turn starts fresh. Interrupt responsiveness
   * is a tested invariant — audio stops within ~100ms of this call.
   */
  interrupt(): void {
    const cancelled = this.cancelCurrentGeneration();
    // Persist asynchronously: interruption must stay synchronous for the
    // realtime path.
    if (cancelled) {
      void this.persistence?.appendGeneration(this.id, cancelled).catch(() => {});
    }
    this.emit("interrupt", { conversationId: this.id });
    this.emitState();
  }

  on<K extends keyof ConversationEvents>(
    event: K,
    listener: (payload: ConversationEvents[K]) => void,
  ): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as (payload: never) => void);
    return () => {
      set!.delete(listener as (payload: never) => void);
    };
  }

  /**
   * Emit an event. Primarily used by the orchestrator to push output
   * (audio, turns, transcripts) into the conversation.
   */
  emit<K extends keyof ConversationEvents>(
    event: K,
    payload: ConversationEvents[K],
  ): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      listener(payload as never);
    }
  }

  // -------------------------------------------------------------------------
  // Orchestrator-facing output
  // -------------------------------------------------------------------------

  /** Push a chunk of generated audio to the application. */
  pushAudio(audio: AudioChunk): void {
    // Record when the first synthesized chunk reached the application for the
    // in-flight generation (speech-to-delivery latency).
    const generation = this.state.currentGeneration;
    if (generation && generation.status === "streaming") {
      const timing = initTiming(generation);
      if (timing.firstAudioAt === undefined) {
        timing.firstAudioAt = Date.now();
        void this.persistence?.appendGeneration(this.id, generation).catch(() => {});
        this.emitState();
      }
    }
    this.emit("audio", { conversationId: this.id, audio });
  }

  /** Push a completed participant turn into the conversation. */
  async pushTurn(turn: Turn): Promise<void> {
    this.state.currentTurn = turn;
    this.emit("turn", { conversationId: this.id, turn });
    await this.persistence?.appendTurn(this.id, turn);
    this.emitState();
  }

  /** Append a transcript entry and notify listeners. */
  async pushTranscript(
    input: Omit<TranscriptEntryInput, "conversationId">,
  ): Promise<TranscriptEntry> {
    const entry = this.transcription.append({ ...input });
    this.state.transcriptCount++;
    this.emit("transcript", { conversationId: this.id, entry });
    await this.persistence?.appendTranscript(this.id, entry);
    this.emitState();
    return entry;
  }

  /** Push an agent generation into the conversation. */
  async pushGeneration(generation: Generation): Promise<void> {
    initTiming(generation);
    this.state.currentGeneration = generation;
    this.emit("generation", { conversationId: this.id, generation });
    await this.persistence?.appendGeneration(this.id, generation);
    this.emitState();
  }

  /**
   * Record a timing point on a generation. Without an id this targets the
   * current generation; with one, a dispatched sub-generation. Each point is
   * recorded at most once.
   */
  noteTiming(point: TimingPoint, generationId?: string): void {
    const generation = generationId
      ? this.subGenerations.get(generationId)
      : this.state.currentGeneration;
    if (!generation || generation.status !== "streaming") return;
    const timing = initTiming(generation);
    const field = timingField[point];
    if (timing[field] !== undefined) return;
    timing[field] = Date.now();
    void this.persistence?.appendGeneration(this.id, generation).catch(() => {});
    this.emitState();
  }

  // -------------------------------------------------------------------------
  // Orchestrator-facing tool calls
  // -------------------------------------------------------------------------

  /** Tool calls requested by the model that are awaiting resolution. */
  get pendingToolCalls(): ToolCall[] {
    return [...this.pendingToolCallsById.values()];
  }

  /**
   * Track and emit a tool call requested by the model. The application
   * listens for `tool-call` events, executes the tool in its own backend,
   * and reports back through `resolveToolCall()`.
   */
  requestToolCall(call: ToolCall): void {
    this.pendingToolCallsById.set(call.id, call);
    this.emit("tool-call", { conversationId: this.id, call });
    this.emitState();
  }

  /** Resolve a pending tool call with a result or an error. */
  resolveToolCall(result: ToolCallResult): void {
    if (!this.pendingToolCallsById.has(result.id)) {
      throw new Error(`No pending tool call "${result.id}"`);
    }
    this.pendingToolCallsById.delete(result.id);
    this.emit("tool-call-result", { conversationId: this.id, result });
    this.emitState();
  }

  /** Mark the current generation as completed, recording its final text. */
  async completeGeneration(text?: string): Promise<void> {
    const generation = this.state.currentGeneration;
    if (generation && generation.status === "streaming") {
      if (text !== undefined) generation.text = text;
      generation.status = "completed";
      generation.endedAt = Date.now();
      initTiming(generation).completedAt = Date.now();
      await this.persistence?.appendGeneration(this.id, generation);
      this.emitState();
    }
  }

  // -------------------------------------------------------------------------
  // Dispatched sub-generations
  // -------------------------------------------------------------------------

  /**
   * Push a sub-generation: a task the coordinator dispatched to another
   * agent. Unlike `pushGeneration`, it does not become the conversation's
   * current generation, so parallel tasks don't clobber the coordinator's
   * own in-flight generation.
   */
  async pushSubGeneration(generation: Generation): Promise<void> {
    initTiming(generation);
    this.subGenerations.set(generation.id, generation);
    this.emit("generation", { conversationId: this.id, generation });
    await this.persistence?.appendGeneration(this.id, generation);
    this.emitState();
  }

  /** Mark a dispatched sub-generation as completed with its final text. */
  async completeSubGeneration(id: string, text?: string): Promise<void> {
    const generation = this.subGenerations.get(id);
    if (!generation || generation.status !== "streaming") return;
    if (text !== undefined) generation.text = text;
    generation.status = "completed";
    generation.endedAt = Date.now();
    initTiming(generation).completedAt = Date.now();
    await this.persistence?.appendGeneration(this.id, generation);
    this.emitState();
  }

  /** Mark a dispatched sub-generation as cancelled (e.g. barge-in). */
  async cancelSubGeneration(id: string): Promise<void> {
    const generation = this.subGenerations.get(id);
    if (!generation || generation.status !== "streaming") return;
    generation.status = "cancelled";
    generation.endedAt = Date.now();
    await this.persistence?.appendGeneration(this.id, generation);
    this.emitState();
  }

  /** The live in-memory transcript. */
  transcript(): TranscriptEntry[] {
    return this.transcription.list();
  }

  private cancelCurrentGeneration(): Generation | null {
    const generation = this.state.currentGeneration;
    if (generation && generation.status === "streaming") {
      generation.status = "cancelled";
      generation.endedAt = Date.now();
    }
    this.state.currentGeneration = null;
    return generation ?? null;
  }

  private buildRealtime(): Orchestrator | null {
    if (!this.stt) return null;
    const common = {
      conversation: this,
      stt: this.stt,
      persistence: this.persistence,
    };
    // With agents the orchestrator coordinates the roster, routing each turn
    // to an agent by name/alias. Without agents it runs transcription-only.
    return this.agents.length > 0
      ? new Orchestrator({ ...common, agents: [...this.agents], tts: this.tts })
      : new Orchestrator(common);
  }

  private emitState(): void {
    this.emit("state", { conversationId: this.id, state: this.state });
  }
}
