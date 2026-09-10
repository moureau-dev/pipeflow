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
  type Plan,
  type PlanStep,
  type PendingFrame,
} from "../../coordination/coordination";
import { ConversationHistory, formatTimeContext } from "../history/history";
import { buildUnderstandPrompt, findAgentByName } from "../routing/routing";
import type { GenerationRunner } from "../generation/generation";
import type { SpeechPipeline } from "../speech/speech";
import type { ToolCallManager } from "../tools/tools";
import type { Logger } from "../../../../logger/types";

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
  /** Abort signal for the current coordination run. */
  currentSignal?(): AbortSignal | undefined;
  /**
   * When true, a multi-agent coordination that answers directly without
   * planning is retried once. Defaults to false: retrying cannot reliably
   * tell a legitimate direct answer from a model that ignored planning.
   */
  retryDirectAnswer?: boolean;
  logger?: Logger;
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
  readonly coordinations: Record<string, Coordination> = {};
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
  private readonly currentSignal: () => AbortSignal | undefined;
  private readonly retryDirectAnswer: boolean;
  private readonly logger: Logger;

  private coordinationEpoch = 0;
  private coordinationStepCount = 0;
  private coordinationRunId = "";
  private pendingExecution: PendingExecution | null = null;
  /** Suppress speech during retry runs so the failed attempt is not re-narrated. */
  private suppressSpeech = false;
  /** True once a coordination run actually delegated work to an agent. */
  private delegatedWork = false;

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
    this.currentSignal = options.currentSignal ?? (() => undefined);
    this.retryDirectAnswer = options.retryDirectAnswer ?? false;
    this.logger = options.logger ?? { info() {}, warn() {}, error() {}, debug() {} } as Logger;
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
    this.logger.info("coordination runDefault started", {
      conversationId: this.conversation.id,
      turn: turn.text.slice(0, 100),
    });
    this.coordinationEpoch = this.currentEpoch();
    this.coordinationStepCount = 0;
    this.coordinationRunId = crypto.randomUUID();
    this.delegatedWork = false;
    await this.conversation.pushGeneration({
      id: this.coordinationRunId,
      conversationId: this.conversation.id,
      agentName: this.agents()[0]!.name,
      text: "",
      status: "streaming",
      startedAt: Date.now(),
    });

    try {
      const output = await understand.run();
      await this.finalizeOrExecute(output);
    } catch (error) {
      if (error instanceof CoordinationSuspension) {
        await this.recordSuspension(error);
      } else if (error instanceof CoordinationCancelled) {
        this.logger.info("coordination cancelled", { conversationId: this.conversation.id });
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
      // If the coordination produced a plan, execute it before continuing
      const plan = this.asPlan(result);
      if (plan) {
        this.conversation.emit("plan", { conversationId: this.conversation.id, steps: plan.steps });
        result = await this.executePlan(plan);
      }
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
        // Plans returned from parent coordinations also get executed
        const plan = this.asPlan(result);
        if (plan) {
          this.conversation.emit("plan", { conversationId: this.conversation.id, steps: plan.steps });
          result = await this.executePlan(plan);
        }
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
      get signal() {
        return runner.currentSignal();
      },
      delegateAgentTasks: (tasks) => {
      this.delegatedWork = true;
      return this.delegateAgentTasks(tasks);
    },
      askUser: (frame, question) => this.askUser(frame, question),
      onDelta: (delta) => { if (!runner.suppressSpeech) this.speech.feed(delta, this.currentEpoch()); },
      flushSpeech: () => { if (!runner.suppressSpeech) this.speech.flush(this.currentEpoch()); },
      speak: (sentence) => { if (!runner.suppressSpeech) this.speech.speak(sentence, this.currentEpoch()); },
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

  /**
   * If the coordination output is a Plan, emit the event, execute it
   * deterministically, and finalize. Otherwise treat it as a direct answer.
   * In multi-agent mode, a direct answer means the model bypassed planning —
   * retry once with a stricter prompt.
   */
  private async finalizeOrExecute(output: unknown): Promise<void> {
    const plan = this.asPlan(output);
    if (plan) {
      this.conversation.emit("plan", { conversationId: this.conversation.id, steps: plan.steps });
      const composed = await this.executePlan(plan);
      const final = plan.narration ? joinNarration(plan.narration, composed) : composed;
      await this.finalizeOutput(final);
      return;
    }
    // Safety net: multi-agent but the model neither planned nor delegated —
    // it answered directly. Retry once when enabled.
    if (this.agents().length > 1 && this.retryDirectAnswer && !this.delegatedWork) {
      this.logger.warn("coordinator answered directly without planning — retrying once", {
        conversationId: this.conversation.id,
      });
      this.suppressSpeech = true;
      this.delegatedWork = false;
      const retryResult = await this.understand?.run();
      this.suppressSpeech = false;
      if (!retryResult) return this.finalizeOutput(String(output));
      const retryPlan = this.asPlan(retryResult);
      if (retryPlan) {
        this.conversation.emit("plan", { conversationId: this.conversation.id, steps: retryPlan.steps });
        const composed = await this.executePlan(retryPlan);
        const final = retryPlan.narration ? joinNarration(retryPlan.narration, composed) : composed;
        await this.finalizeOutput(final);
        return;
      }
    }
    await this.finalizeOutput(String(output));
  }

  /** Check if the coordination output is a plan object. */
  private asPlan(output: unknown): Plan | null {
    if (typeof output !== "object" || output === null) return null;
    const candidate = output as Record<string, unknown>;
    if (!Array.isArray(candidate.plan)) return null;
    return {
      steps: candidate.plan as PlanStep[],
      narration: String(candidate.narration ?? ""),
      composition: typeof candidate.composition === "string" ? candidate.composition : undefined,
    };
  }

  /**
   * Execute a plan's steps in dependency order. Steps with no unmet deps
   * run in parallel; steps whose deps are not yet met wait for their turn.
   * Pure-LLM steps (no agent) run against the coordinator's LLM directly.
   * If the plan has a composition prompt, it runs as a final synthesis step.
   * Returns the composed answer text.
   */
  private async executePlan(plan: Plan): Promise<string> {
    const stepResults = new Map<string, string>();
    const remaining = [...plan.steps];
    let rounds = 0;

    while (remaining.length > 0 && rounds < 20) {
      rounds++;
      const ready = remaining.filter(
        (step) =>
          !step.dependsOn || step.dependsOn.every((dep) => stepResults.has(dep)),
      );
      if (ready.length === 0) {
        this.logger.error("plan deadlock — circular dependency", { conversationId: this.conversation.id });
        break;
      }

      // Inject dependency outputs into each ready step's prompt
      const outcomes = await Promise.all(
        ready.map(async (step) => {
          this.conversation.emit("plan-step", {
            conversationId: this.conversation.id,
            step,
            status: "started",
          });
          let prompt = step.prompt;
          if (step.dependsOn?.length) {
            const depsText = step.dependsOn
              .map((depId) => {
                const depResult = stepResults.get(depId);
                return depResult ? `[${depId} output]:\n${depResult}` : "";
              })
              .filter(Boolean)
              .join("\n\n");
            if (depsText) {
              prompt = `The following results are available:\n\n${depsText}\n\nNow do the following:\n${prompt}`;
            }
          }
          const result = step.agent
            ? await this.runSubGeneration(this.coordinationEpoch, { agent: step.agent, prompt }, this.coordinationRunId, 3)
            : { agent: "", text: await this.runLLMStep(prompt), error: undefined };
          const text = result.text ?? result.error ?? "";
          this.conversation.emit("plan-step", {
            conversationId: this.conversation.id,
            step,
            status: result.error && !result.text ? "failed" : "completed",
            text,
          });
          // Surface each agent step's work in the transcript, in order.
          if (result.agent && text && !result.error) {
            await this.conversation.pushTranscript({
              speaker: result.agent,
              speakerKind: "agent",
              text,
            });
          }
          return { id: step.id, text };
        }),
      );

      for (const outcome of outcomes) {
        stepResults.set(outcome.id, outcome.text);
      }

      const readyIds = new Set(ready.map((s) => s.id));
      for (let i = remaining.length - 1; i >= 0; i--) {
        if (readyIds.has(remaining[i]!.id)) remaining.splice(i, 1);
      }
    }

    // Composition step: use the coordinator's LLM to synthesize the final answer
    if (plan.composition) {
      const allResults = plan.steps
        .map((step) => {
          const text = stepResults.get(step.id);
          return text ? `[${step.id}]: ${text}` : "";
        })
        .filter(Boolean)
        .join("\n\n");
      const composePrompt = `${plan.composition}\n\nHere are the results to compose from:\n${allResults}`;
      const composed = await this.runLLMStep(composePrompt, 384, (delta) => {
        if (this.suppressSpeech) {
          this.conversation.pushTextDelta(delta);
        } else {
          this.speech.feed(delta, this.currentEpoch());
        }
      });
      return composed || plan.steps.map((s) => stepResults.get(s.id) ?? "").filter(Boolean).join("\n\n");
    }

    return plan.steps
      .map((step) => stepResults.get(step.id) ?? "")
      .filter(Boolean)
      .join("\n\n");
  }

  /**
   * Run a pure-LLM step: send the prompt to the coordinator's LLM and return
   * the generated text. No tools, no sub-generation tracking.
   */
  private async runLLMStep(prompt: string, maxTokens?: number, onDelta?: (delta: string) => void): Promise<string> {
    const llm = this.llm();
    if (!llm) return "";
    let text = "";
    for await (const event of llm.stream({
      messages: [{ role: "user", content: prompt }],
      temperature: this.temperature,
      maxTokens: maxTokens ?? this.maxTokens,
    })) {
      if (event.type === "delta") {
        text += event.content;
        if (event.content.length > 0) onDelta?.(event.content);
      }
      if (event.type === "error") throw event.error;
      if (event.type === "done") break;
    }
    return text;
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
        this.runSubGeneration(this.coordinationEpoch, task, this.coordinationRunId, 3),
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
    /** Tighter tool-loop bound for delegated steps (default 3). */
    maxToolIterations: number = 3,
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
      maxTokens: Math.min(this.maxTokens ?? 512, 512),
      maxToolIterations: Math.min(maxToolIterations, this.maxToolIterations),
      isCurrent: () => this.isCurrent(epoch),
      signal: this.currentSignal(),
      onDelta: (delta, textBefore) => {
        if (textBefore.length === 0) this.conversation.noteTiming("firstToken", id);
        if (delta.length > 0) {
          // Stream specialist output for live UX, tagged with the agent name.
          this.conversation.emit("agent-delta", {
            conversationId: this.conversation.id,
            agent: agent.name,
            text: delta,
          });
        }
      },
      resolveToolCalls: (calls) => this.tools.resolveCalls(calls),
      finalizeAfterToolRound: true,
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

/** Combine pre-plan narration with the executed plan's output. */
function joinNarration(narration: string, composed: string): string {
  const n = narration.trim();
  const c = composed.trim();
  if (!n) return c;
  if (!c) return n;
  return `${n} ${c}`.replace(/\s+([.,!?])/g, "$1");
}
