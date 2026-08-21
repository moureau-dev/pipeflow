import type { Agent } from "../../../../agents/agent";
import type { Conversation } from "../../../conversation/conversation";
import type { LLM, LLMMessage, LLMToolDefinition } from "../../../../providers/llm/types";
import type { Turn } from "../../../types";
import {
  Coordination,
  CoordinationBudgetExceeded,
  CoordinationCancelled,
  CoordinationSuspension,
  type CoordinationRegistration,
  type CoordinationRuntime,
  type DelegatedTask,
  type DelegationResult,
  type PendingFrame,
} from "../../coordination/coordination";
import { ConversationHistory, formatTimeContext } from "../history/history";
import { buildUnderstandPrompt, findAgentByName } from "../routing/routing";
import type { GenerationRunner } from "../generation/generation";
import type { SpeechPipeline } from "../speech/speech";
import type { ToolCallManager } from "../tools/tools";

export interface CoordinationRunnerOptions {
  conversation: Conversation;
  /** Live roster accessor (read at coordination-run time). */
  agents(): Agent[];
  /** Live shared-LLM accessor (undefined in transcription-only mode). */
  llm(): LLM | undefined;
  /** The conversation's message log, seeded into fresh coordination runs. */
  history: ConversationHistory;
  historyWindow: Parameters<ConversationHistory["windowed"]>[0];
  speech: SpeechPipeline;
  generation: GenerationRunner;
  tools: ToolCallManager;
  /** Safety bound on LLM reasoning steps per coordination execution. */
  maxCoordinationSteps: number;
  maxToolIterations: number;
  temperature?: number;
  maxTokens?: number;
  /** The orchestrator's current generation epoch (bumped on interrupt/stop). */
  currentEpoch(): number;
  /** True while the orchestrator is started and the epoch is current. */
  isCurrent(epoch: number): boolean;
}

/** A coordination execution parked while waiting for the user to answer. */
interface PendingExecution {
  /** Execution stack, outermost frame first. */
  frames: PendingFrame[];
  question: string;
  /** Coordination step count so the budget survives the suspension. */
  stepCount: number;
}

/**
 * The application-specific execution of coordinations: binds the generic
 * `Coordination` primitives to the orchestrator's machinery (roster, shared
 * LLM, history, speech, delegation, budgets, cancellation) and owns the
 * suspension/resume lifecycle — the parked frame stack, the step budget, and
 * the coordination generation records.
 */
export class CoordinationRunner {
  /** Coordinations registered by name (the key is the coordination's name). */
  readonly coordinations: Record<string, Coordination> = {};
  /** The built-in `understand` coordination, when one is active. */
  understand: Coordination | null = null;

  private readonly conversation: Conversation;
  private readonly agents: () => Agent[];
  private readonly llm: () => LLM | undefined;
  private readonly history: ConversationHistory;
  private readonly historyWindow: Parameters<ConversationHistory["windowed"]>[0];
  private readonly speech: SpeechPipeline;
  private readonly generation: GenerationRunner;
  private readonly tools: ToolCallManager;
  private readonly maxCoordinationSteps: number;
  private readonly maxToolIterations: number;
  private readonly temperature: number | undefined;
  private readonly maxTokens: number | undefined;
  private readonly currentEpoch: () => number;
  private readonly isCurrent: (epoch: number) => boolean;

  private coordinationEpoch = 0;
  private coordinationStepCount = 0;
  private coordinationRunId = "";
  private pendingExecution: PendingExecution | null = null;

  constructor(options: CoordinationRunnerOptions) {
    this.conversation = options.conversation;
    this.agents = options.agents;
    this.llm = options.llm;
    this.history = options.history;
    this.historyWindow = options.historyWindow;
    this.speech = options.speech;
    this.generation = options.generation;
    this.tools = options.tools;
    this.maxCoordinationSteps = options.maxCoordinationSteps;
    this.maxToolIterations = options.maxToolIterations;
    this.temperature = options.temperature;
    this.maxTokens = options.maxTokens;
    this.currentEpoch = options.currentEpoch;
    this.isCurrent = options.isCurrent;
  }

  /**
   * Register coordinations by name. The built-in `understand` runs unaddressed
   * turns: it decides whether to delegate to agents, ask the user, or answer
   * directly. Apps can override it by registering their own "understand" key,
   * and add their own (e.g. clarify, review).
   */
  register(
    registrations: Record<string, CoordinationRegistration>,
    agents: readonly Agent[],
  ): void {
    const merged: Record<string, CoordinationRegistration> = {
      ...registrations,
    };
    if (agents.length > 1 && !merged.understand) {
      merged.understand = { prompt: buildUnderstandPrompt(agents) };
    }
    for (const [name, registration] of Object.entries(merged)) {
      this.coordinations[name] = new Coordination(
        { name, ...registration },
        this.runtime(),
      );
    }
    this.understand = this.coordinations["understand"] ?? null;
  }

  /** True while a coordination is parked waiting for the user to answer. */
  hasPending(): boolean {
    return this.pendingExecution !== null;
  }

  /** Drop a parked execution (interrupt, stop). */
  cancel(): void {
    this.pendingExecution = null;
  }

  /**
   * Run the built-in `understand` coordination on an unaddressed turn. A
   * streaming generation is opened for the conversation's default agent; the
   * coordination's final answer (or question) completes it.
   */
  async runDefault(turn: Turn): Promise<void> {
    const understand = this.understand;
    const llm = this.llm();
    if (!understand || !llm) return;
    this.coordinationEpoch = this.currentEpoch();
    this.coordinationStepCount = 0;
    this.coordinationRunId = crypto.randomUUID();
    await this.conversation.pushGeneration({
      id: this.coordinationRunId,
      conversationId: this.conversation.id,
      agentName: this.agents()[0]!.name,
      text: "",
      status: "streaming",
      startedAt: Date.now(),
    });

    try {
      // The current turn is already in history, so no separate input message.
      const output = await understand.run();
      await this.finalizeOutput(String(output));
    } catch (error) {
      if (error instanceof CoordinationSuspension) {
        await this.recordSuspension(error);
      } else if (error instanceof CoordinationCancelled) {
        // Discarded by an interrupt — nothing to finalize.
      } else {
        this.emitError(error);
      }
    }
  }

  /**
   * Resume a parked coordination with the user's answer, propagating the
   * result back up the frame stack to the outermost coordination.
   */
  async resume(turn: Turn): Promise<void> {
    const pending = this.pendingExecution;
    if (!pending) return;
    this.pendingExecution = null;
    this.coordinationEpoch = this.currentEpoch();
    this.coordinationStepCount = pending.stepCount;
    this.coordinationRunId = crypto.randomUUID();
    await this.conversation.pushGeneration({
      id: this.coordinationRunId,
      conversationId: this.conversation.id,
      agentName: this.agents()[0]!.name,
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
        this.emitError(error);
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
          this.emitError(error);
        }
        return;
      }
    }

    await this.finalizeOutput(String(result));
  }

  /**
   * The runtime the coordinations reason against. Binds the coordination
   * primitives (delegate to agents, ask the user, speech, budget, cancellation)
   * to the runner's machinery without coupling `Coordination` to it.
   */
  runtime(): CoordinationRuntime {
    const runner = this;
    return {
      // Getters: read the current state at call time (the coordinations are
      // built after the runtime object is created).
      get agents() {
        return runner.agents();
      },
      get coordinations() {
        return Object.values(runner.coordinations);
      },
      get llm() {
        return runner.llm()!;
      },
      get history() {
        return runner.history.windowed(runner.historyWindow);
      },
      delegateAgentTasks: (tasks) => this.delegateAgentTasks(tasks),
      askUser: (frame, question) => this.askUser(frame, question),
      onDelta: (delta) => this.speech.feed(delta, this.currentEpoch()),
      flushSpeech: () => this.speech.flush(this.currentEpoch()),
      speak: (sentence) => this.speech.speak(sentence, this.currentEpoch()),
      isCancelled: () => this.currentEpoch() !== this.coordinationEpoch,
      checkBudget: () => this.checkBudget(),
    };
  }

  /** Complete the current generation and record the coordination's answer. */
  private async finalizeOutput(text: string): Promise<void> {
    this.speech.flush(this.currentEpoch());
    await this.speech.waitForIdle();
    if (this.currentEpoch() !== this.coordinationEpoch) return;
    await this.conversation.completeGeneration(text);
    await this.conversation.pushTranscript({
      speaker: this.agents()[0]!.name,
      speakerKind: "agent",
      text,
    });
    this.history.addAssistant(this.agents()[0]!.name, text);
  }

  /** Park a suspended coordination: record the question and store the stack. */
  private async recordSuspension(suspension: CoordinationSuspension): Promise<void> {
    await this.conversation.completeGeneration(suspension.question);
    await this.conversation.pushTranscript({
      speaker: this.agents()[0]!.name,
      speakerKind: "agent",
      text: suspension.question,
    });
    this.history.addAssistant(this.agents()[0]!.name, suspension.question);
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
  private checkBudget(): void {
    this.coordinationStepCount++;
    if (this.coordinationStepCount > this.maxCoordinationSteps) {
      throw new CoordinationBudgetExceeded(
        `exceeded ${this.maxCoordinationSteps} coordination steps`,
      );
    }
  }

  private emitError(error: unknown): void {
    this.conversation.emit("error", {
      conversationId: this.conversation.id,
      error: error instanceof Error ? error : new Error(String(error)),
    });
    // Finalize the current coordination generation so an errored run does not
    // leave a dangling "streaming" record. The narration was streamed to
    // speech; the failure surfaces through the error event.
    if (this.currentEpoch() === this.coordinationEpoch) {
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

    if (!this.isCurrent(this.coordinationEpoch)) {
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
    const agent = findAgentByName(this.agents(), task.agent);
    if (!agent) {
      return { agent: task.agent, text: "", error: `Unknown agent "${task.agent}"` };
    }
    const llm = agent.llm ?? this.llm();
    if (!llm) {
      return {
        agent: agent.name,
        text: "",
        error: `Agent "${agent.name}" has no LLM configured`,
      };
    }

    const id = crypto.randomUUID();
    await this.conversation.pushSubGeneration({
      id,
      conversationId: this.conversation.id,
      agentName: agent.name,
      text: "",
      status: "streaming",
      startedAt: Date.now(),
      kind: "sub",
      parentGenerationId,
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
    // The prompt carries a time stamp so time-sensitive tasks (flights,
    // meetings, deadlines) don't reason about a stale "now".
    messages.push({ role: "user", content: `${task.prompt}\n\n${formatTimeContext()}` });

    const outcome = await this.generation.run({
      agentName: agent.name,
      llm,
      messages,
      tools: definitions,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      maxToolIterations: this.maxToolIterations,
      isCurrent: () => this.isCurrent(epoch),
      onDelta: (delta, textBefore) => {
        if (textBefore.length === 0) this.conversation.noteTiming("firstToken", id);
      },
      resolveToolCalls: (calls) => this.tools.resolveCalls(calls),
    });

    if (!this.isCurrent(epoch) || outcome.status === "interrupted") {
      await this.conversation.cancelSubGeneration(id);
      return { agent: agent.name, text: "", error: "interrupted" };
    }

    await this.conversation.completeSubGeneration(id, outcome.text);
    if (outcome.status === "error") {
      this.conversation.emit("error", {
        conversationId: this.conversation.id,
        error: outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error)),
      });
      return {
        agent: agent.name,
        text: outcome.text,
        error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
      };
    }
    return { agent: agent.name, text: outcome.text };
  }
}
