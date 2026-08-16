import type { Agent } from "../../../agents/agent.ts";
import type { Conversation } from "../../conversation/conversation.ts";
import type { Persistence } from "../../../persistence/persistence.ts";
import type {
  LLM,
  LLMMessage,
  LLMToolCall,
  LLMToolDefinition,
} from "../../../providers/llm/types.ts";
import type { STT, STTSession } from "../../../providers/stt/types.ts";
import type { TTS } from "../../../providers/tts/types.ts";
import type { AudioChunk, ToolCallResult, Turn, UserId } from "../../types.ts";

export interface OrchestratorOptions {
  conversation: Conversation;
  agent: Agent;
  /** Defaults to the agent's LLM. */
  llm?: LLM;
  stt: STT;
  tts: TTS;
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

/**
 * The realtime conversation state machine.
 *
 * Wires the conversation to the providers:
 *
 * ```text
 * audio-in ──► STT ──► turn ──► LLM ──► TTS ──► audio-out
 *                              │
 *                              └─► tool-call ──► app resolves ──► resume
 * ```
 *
 * Deltas stream to TTS immediately (so the agent can narrate while a tool
 * runs), tool calls pause the generation until the application resolves
 * them, and interruptions cancel the current generation — discarding any
 * stale tool results or audio via a generation epoch.
 */
export class Orchestrator {
  private readonly conversation: Conversation;
  private readonly agent: Agent;
  private readonly llm: LLM;
  private readonly stt: STT;
  private readonly tts: TTS;
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
    const llm = options.llm ?? options.agent.llm;
    if (!llm) {
      throw new Error(
        "Orchestrator requires an LLM: pass one explicitly or configure the agent with one",
      );
    }
    this.conversation = options.conversation;
    this.agent = options.agent;
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
        | { at: number; kind: "generation"; text: string }
      > = [
        ...turns.map((turn) => ({ at: turn.startedAt, kind: "turn" as const, turn })),
        ...generations
          .filter((generation) => generation.status === "completed")
          .map((generation) => ({
            at: generation.startedAt,
            kind: "generation" as const,
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
          this.history.push({ role: "assistant", content: entry.text });
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
    this.llm.stop();
    this.tts.stop();
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
      this.queueGeneration();
    } finally {
      this.pendingTurns--;
    }
  }

  private onInterrupt(): void {
    this.epoch++;
    this.llm.stop();
    this.tts.stop();
    this.cancelToolWaiters("interrupted");
    this.speechBuffer = "";
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

  private queueGeneration(): void {
    this.pendingGenerations++;
    const epoch = this.epoch;
    this.generationChain = this.generationChain.then(async () => {
      if (this.epoch !== epoch) {
        // Superseded by an interruption while queued.
        this.pendingGenerations--;
        return;
      }
      try {
        await this.generate();
      } finally {
        this.pendingGenerations--;
      }
    });
  }

  private async generate(): Promise<void> {
    this.generating = true;
    try {
      await this.runGeneration(this.epoch);
    } finally {
      this.generating = false;
    }
  }

  private async runGeneration(epoch: number): Promise<void> {
    await this.conversation.pushGeneration({
      id: crypto.randomUUID(),
      conversationId: this.conversation.id,
      agentName: this.agent.name,
      text: "",
      status: "streaming",
      startedAt: Date.now(),
    });

    const definitions: LLMToolDefinition[] = this.agent.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? { type: "object", properties: {} },
    }));

    const messages: LLMMessage[] = [];
    if (this.agent.context) {
      messages.push({ role: "system", content: this.agent.context });
    }
    messages.push(...this.history);

    let text = "";

    try {
      for (let iteration = 0; iteration < this.maxToolIterations; iteration++) {
        if (this.epoch !== epoch) return;

        const toolCalls: LLMToolCall[] = [];
        let done = false;

        for await (const event of this.llm.stream({
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
          // the application, and resume once they are resolved.
          this.flushSpeech();
          messages.push({ role: "assistant", content: text, toolCalls });
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
        speaker: this.agent.name,
        speakerKind: "agent",
        text,
      });
      this.history.push({ role: "assistant", content: text });
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
          speaker: this.agent.name,
          speakerKind: "agent",
          text,
        });
        this.history.push({ role: "assistant", content: text });
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
    const epoch = this.epoch;
    this.speechChain = this.speechChain.then(async () => {
      if (!this.started || this.epoch !== epoch) return;
      try {
        for await (const chunk of this.tts.stream({ text: sentence })) {
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
