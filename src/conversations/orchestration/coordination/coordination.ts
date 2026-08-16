import type { Agent } from "../../../agents/agent";
import { z } from "zod";
import type { LLM, LLMMessage, LLMToolCall, LLMToolDefinition } from "../../../providers/llm/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One task delegated to an agent: a self-contained prompt for a roster member.
 */
export interface DelegatedTask {
  agent: string;
  prompt: string;
}

/**
 * The outcome of a delegated agent run (or sub-coordination, via `error`).
 */
export interface DelegationResult {
  agent: string;
  text: string;
  error?: string;
}

/** What a coordination's LLM may decide to do next. */
export type DelegateAction =
  | { action: "agents"; tasks: DelegatedTask[] }
  | { action: "coordination"; coordination: string; input?: unknown }
  | { action: "user"; question: string }
  | { action: "complete"; output: string };

/**
 * The runtime a coordination reasons against: the roster, every registered
 * coordination, and the primitives for delegating work. Supplied by the
 * orchestrator, so coordinations never couple to it directly.
 */
export interface CoordinationRuntime {
  readonly agents: readonly Agent[];
  readonly coordinations: readonly Coordination[];
  /** Shared LLM used for coordination reasoning. */
  readonly llm: LLM;
  /** Shared conversation history, seeded into fresh runs. */
  readonly history: readonly LLMMessage[];

  /** Run one or more agents in parallel (text-only) and return their outputs. */
  delegateAgentTasks(tasks: DelegatedTask[]): Promise<DelegationResult[]>;
  /**
   * Ask the user a question. Never returns: it throws `CoordinationSuspension`
   * carrying the innermost frame, which the orchestrator catches to park the
   * execution until the user answers.
   */
  askUser(frame: PendingFrame, question: string): Promise<never>;
  /** Stream a delta to speech (TTS narration). */
  onDelta(delta: string): void;
  /** Flush pending narration (e.g. before delegating or suspending). */
  flushSpeech(): void;
  /** Speak a standalone sentence (e.g. a `complete` output). */
  speak(sentence: string): void;
  /** True once an interrupt/stop has cancelled this run. */
  isCancelled(): boolean;
  /** Throw if the run exceeded the coordination step budget. */
  checkBudget(): void;
}

export interface CoordinationOptions {
  name: string;
  /** System prompt describing the coordination's reasoning role. */
  prompt?: string;
  /** Overrides the runtime's shared LLM for this coordination. */
  llm?: LLM;
  maxTokens?: number;
  /** Hard wall-clock limit for a single run (including suspensions). */
  maxDurationMs?: number;
}

/**
 * The resumable state of one coordination invocation. Plain data so it can be
 * parked in a `PendingExecution` while waiting for the user.
 */
export interface CoordinationState {
  messages: LLMMessage[];
  startedAt: number;
  /** Everything the coordination has spoken so far, for the final record. */
  narration: string;
  /** Tool call id awaiting a sub-coordination result, for resume replies. */
  pendingToolCallId?: string;
}

/** One frame of a suspended execution stack (outermost first). */
export interface PendingFrame {
  coordination: Coordination;
  state: CoordinationState;
}

/** Thrown when a coordination asks the user; carries the whole frame stack. */
export class CoordinationSuspension extends Error {
  readonly frames: PendingFrame[];
  readonly question: string;

  constructor(frames: PendingFrame[], question: string) {
    super(`Coordination suspended: ${question}`);
    this.name = "CoordinationSuspension";
    this.frames = frames;
    this.question = question;
  }
}

/** Thrown when a coordination run is cancelled (interrupt/stop). */
export class CoordinationCancelled extends Error {
  constructor() {
    super("Coordination cancelled");
    this.name = "CoordinationCancelled";
  }
}

/** Thrown when a coordination exceeded its step or duration budget. */
export class CoordinationBudgetExceeded extends Error {
  constructor(detail: string) {
    super(`Coordination budget exceeded: ${detail}`);
    this.name = "CoordinationBudgetExceeded";
  }
}

// ---------------------------------------------------------------------------
// Delegate tool
// ---------------------------------------------------------------------------

const DELEGATE_DESCRIPTION =
  "Decide what should happen next in order to produce the desired result. " +
  "You may run one or more agents (each with a self-contained prompt), pass the work to " +
  "another coordination, ask the user for missing information, or complete with the final " +
  "spoken answer. Only ever take one action per call.";

/** Non-empty zod enum, or a plain string when there are no targets. */
function targetsEnum(targets: string[]): z.ZodType<string> {
  return targets.length > 0
    ? z.enum(targets as [string, ...string[]])
    : z.string();
}

/**
 * The strict schema a coordination's LLM output must satisfy. A discriminated
 * union on `action` — each variant carries exactly its own fields.
 */
function delegateActionSchema(
  agents: readonly Agent[],
  coordinations: readonly Coordination[],
): z.ZodType<DelegateAction> {
  const agentTargets = agents.map((agent) => [agent.name, ...agent.aliases]).flat();
  const coordinationTargets = coordinations.map((coordination) => coordination.name);
  return z.discriminatedUnion("action", [
    z.object({
      action: z.literal("agents"),
      tasks: z
        .array(
          z.object({
            agent: targetsEnum(agentTargets).describe("Agent name or alias from the roster."),
            prompt: z.string().trim().min(1, "a prompt is required").describe("Self-contained instruction for that agent."),
          }),
        )
        .describe("Agents to run in parallel.")
        .min(1, "at least one task is required"),
    }),
    z.object({
      action: z.literal("coordination"),
      coordination: targetsEnum(coordinationTargets).describe(
        "The coordination to pass the work to.",
      ),
      input: z.unknown().describe("Input for the delegated coordination.").optional(),
    }),
    z.object({
      action: z.literal("user"),
      question: z.string().trim().min(1, "a question is required").describe("Clarifying question for the user."),
    }),
    z.object({
      action: z.literal("complete"),
      output: z.string().trim().min(1, "an output is required").describe("The final spoken answer."),
    }),
  ]);
}

/**
 * The tool definition that lets a coordination's LLM choose the next execution
 * target: agents (one or more, in parallel), another coordination, the user,
 * or completion. The parameters are generated from the zod schema, flattened
 * so any provider's tool-calling accepts them.
 */
export function delegateToolDefinition(
  agents: readonly Agent[],
  coordinations: readonly Coordination[],
): LLMToolDefinition {
  const agentTargets = agents.map((agent) => [agent.name, ...agent.aliases]).flat();
  const coordinationTargets = coordinations.map((coordination) => coordination.name);
  const parameters = z.object({
    action: z
      .enum(["agents", "coordination", "user", "complete"])
      .describe("What to do next."),
    tasks: z
      .array(
        z.object({
          agent: targetsEnum(agentTargets).describe("Agent name or alias from the roster."),
          prompt: z.string().trim().min(1, "a prompt is required").describe("Self-contained instruction for that agent."),
        }),
      )
      .describe("Agents to run in parallel (action 'agents').")
      .optional(),
    coordination: targetsEnum(coordinationTargets)
      .describe("The coordination to pass the work to (action 'coordination').")
      .optional(),
    input: z
      .unknown()
      .describe("Input for the delegated coordination (action 'coordination').")
      .optional(),
    question: z
      .string()
      .trim()
      .min(1, "a question is required")
      .describe("Clarifying question for the user (action 'user').")
      .optional(),
    output: z
      .string()
      .trim()
      .min(1, "an output is required")
      .describe("The final spoken answer (action 'complete').")
      .optional(),
  });
  const jsonSchema = z.toJSONSchema(parameters) as Record<string, unknown>;
  delete jsonSchema.$schema;
  return { name: "delegate", description: DELEGATE_DESCRIPTION, parameters: jsonSchema };
}

export function parseDelegateAction(
  argumentsJson: string,
  agents: readonly Agent[],
  coordinations: readonly Coordination[],
): DelegateAction {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    throw new Error("delegate arguments must be valid JSON");
  }
  const result = delegateActionSchema(agents, coordinations).safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
      .join("; ");
    throw new Error(`invalid delegate arguments: ${details}`);
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Coordination
// ---------------------------------------------------------------------------

/**
 * A hardcoded reasoning/control-flow unit. Unlike an `Agent` (input → LLM →
 * output), a coordination decides *what should happen next*: run agents, pass
 * work to another coordination, ask the user, or complete. Definitions are
 * stateless; each invocation carries its own `CoordinationState`, which can be
 * parked (suspended) while waiting for the user and resumed later.
 */
export class Coordination {
  readonly name: string;
  readonly prompt: string;
  readonly maxTokens: number | undefined;
  readonly maxDurationMs: number | undefined;
  private readonly runtime: CoordinationRuntime;
  private readonly llm: LLM;
  private cachedToolDefinition: LLMToolDefinition | null = null;
  private cachedSchema: ReturnType<typeof delegateActionSchema> | null = null;

  constructor(options: CoordinationOptions, runtime: CoordinationRuntime) {
    if (!options.name.trim()) {
      throw new Error("Coordination requires a non-empty name");
    }
    this.name = options.name.trim();
    this.prompt = options.prompt?.trim() ?? "";
    this.maxTokens = options.maxTokens;
    this.maxDurationMs = options.maxDurationMs;
    this.runtime = runtime;
    this.llm = options.llm ?? runtime.llm;
  }

  /** The delegate tool definition, generated once from the roster. */
  private toolDefinition(): LLMToolDefinition {
    this.cachedToolDefinition ??= delegateToolDefinition(
      this.runtime.agents,
      this.runtime.coordinations,
    );
    return this.cachedToolDefinition;
  }

  /** Parse a `delegate` tool call against the roster's strict schema. */
  private parseDelegate(argumentsJson: string): DelegateAction {
    this.cachedSchema ??= delegateActionSchema(
      this.runtime.agents,
      this.runtime.coordinations,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(argumentsJson);
    } catch {
      throw new Error("delegate arguments must be valid JSON");
    }
    const result = this.cachedSchema.safeParse(parsed);
    if (!result.success) {
      const details = result.error.issues
        .map((issue) =>
          issue.path.length > 0
            ? `${issue.path.join(".")}: ${issue.message}`
            : issue.message,
        )
        .join("; ");
      throw new Error(`invalid delegate arguments: ${details}`);
    }
    return result.data;
  }

  /** Run the coordination with fresh state (seeded with the shared history). */
  async run(input?: unknown): Promise<unknown> {
    const state: CoordinationState = {
      messages: [],
      startedAt: Date.now(),
      narration: "",
    };
    if (this.prompt) {
      state.messages.push({ role: "system", name: this.name, content: this.prompt });
    }
    state.messages.push(...this.runtime.history);
    if (input !== undefined) {
      state.messages.push({
        role: "user",
        content: typeof input === "string" ? input : JSON.stringify(input),
      });
    }
    return this.loop(state);
  }

  /** Resume a suspended state with the user's answer. */
  async resume(state: CoordinationState, answer: string): Promise<unknown> {
    // The pre-suspension narration was already recorded as the question.
    state.narration = "";
    state.messages.push({ role: "user", content: answer });
    return this.loop(state);
  }

  /** Continue a suspended state with an injected message (e.g. a sub-result). */
  async continueWith(state: CoordinationState, message: LLMMessage): Promise<unknown> {
    state.narration = "";
    state.messages.push(message);
    return this.loop(state);
  }

  /**
   * The coordination loop: one LLM round trip per iteration, choosing the next
   * execution target via the `delegate` tool. Throws `CoordinationSuspension`
   * when asking the user; the state carried in the suspension is resumable.
   */
  private async loop(state: CoordinationState): Promise<unknown> {
    const startedAt = state.startedAt;

    for (;;) {
      this.runtime.checkBudget();
      if (this.runtime.isCancelled()) throw new CoordinationCancelled();
      if (this.maxDurationMs && Date.now() - startedAt > this.maxDurationMs) {
        throw new CoordinationBudgetExceeded(`"${this.name}" exceeded ${this.maxDurationMs}ms`);
      }

      const toolCalls: LLMToolCall[] = [];
      let done = false;

      for await (const event of this.llm.stream({
        messages: state.messages,
        tools: [this.toolDefinition()],
        maxTokens: this.maxTokens,
      })) {
        if (this.runtime.isCancelled()) throw new CoordinationCancelled();
        switch (event.type) {
          case "delta":
            state.narration += event.content;
            this.runtime.onDelta(event.content);
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

      // Re-check the wall-clock limit after the round trip: a single slow
      // iteration must still count against maxDurationMs.
      if (this.maxDurationMs && Date.now() - startedAt > this.maxDurationMs) {
        throw new CoordinationBudgetExceeded(`"${this.name}" exceeded ${this.maxDurationMs}ms`);
      }

      if (toolCalls.length > 0) {
        this.runtime.flushSpeech();
        state.messages.push({
          role: "assistant",
          name: this.name,
          content: state.narration,
          toolCalls,
        });
        for (const call of toolCalls) {
          let action: DelegateAction;
          try {
            action = this.parseDelegate(call.arguments);
          } catch (error) {
            // Malformed arguments: report to the coordination's LLM so it can
            // recover instead of crashing the run.
            state.messages.push({
              role: "tool",
              toolCallId: call.id,
              name: "delegate",
              content: JSON.stringify({
                error: error instanceof Error ? error.message : String(error),
              }),
            });
            continue;
          }
          switch (action.action) {
            case "agents": {
              const results = await this.runtime.delegateAgentTasks(action.tasks);
              state.messages.push({
                role: "tool",
                toolCallId: call.id,
                name: "delegate",
                content: JSON.stringify(results),
              });
              break;
            }
            case "coordination": {
              const target = this.runtime.coordinations.find(
                (coordination) => coordination.name === action.coordination,
              );
              if (!target) {
                state.messages.push({
                  role: "tool",
                  toolCallId: call.id,
                  name: "delegate",
                  content: JSON.stringify({
                    error: `Unknown coordination "${action.coordination}"`,
                  }),
                });
                break;
              }
              try {
                const result = await this.delegateToCoordination(
                  target,
                  action.input,
                  state,
                  call.id,
                );
                state.messages.push({
                  role: "tool",
                  toolCallId: call.id,
                  name: "delegate",
                  content: JSON.stringify(result),
                });
              } catch (error) {
                if (error instanceof CoordinationBudgetExceeded) {
                  state.messages.push({
                    role: "tool",
                    toolCallId: call.id,
                    name: "delegate",
                    content: JSON.stringify({ error: error.message }),
                  });
                } else {
                  throw error; // suspension or cancellation propagates
                }
              }
              break;
            }
            case "user": {
              // The question was (typically) narrated; park the whole stack.
              await this.runtime.askUser({ coordination: this, state }, action.question);
              throw new Error("unreachable");
            }
            case "complete":
              this.runtime.speak(action.output);
              return this.completeOutput(state.narration, action.output);
          }
        }
        continue;
      }

      if (done) {
        // No delegate call: the coordination answered directly.
        return this.completeOutput(state.narration, "");
      }
    }
  }

  /** Delegate to a sub-coordination, attaching this frame on suspension. */
  private async delegateToCoordination(
    target: Coordination,
    input: unknown,
    state: CoordinationState,
    toolCallId: string,
  ): Promise<unknown> {
    state.pendingToolCallId = toolCallId;
    try {
      return await target.run(input);
    } catch (error) {
      if (error instanceof CoordinationSuspension) {
        error.frames.unshift({ coordination: this, state });
        throw error;
      }
      throw error;
    }
  }

  private completeOutput(narration: string, output: string): string {
    const trimmed = narration.trim();
    return output ? `${trimmed ? trimmed + " " : ""}${output}` : trimmed;
  }
}
