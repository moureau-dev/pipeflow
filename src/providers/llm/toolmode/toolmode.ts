/**
 * Tool-mode benchmark: measures availability, latency (percentiles), and cost
 * of each tool-call encoding (`native` | `envelope` | `prompted`) for a
 * model, through the real adapter path (`llm.stream({ toolMode })`). A
 * diagnostic utility for onboarding models — the runtime never calls it.
 *
 * ```ts
 * const bench = new ToolModeBenchmark({ apiKey, model: "..." });
 * const { fastest, cheapest, report } = await bench.run();
 * console.log(report.envelope.time.p50);
 * ```
 */

import { OpenRouterLLM } from "../adapters/openrouter/openrouter";
import { z } from "zod";
import type { FetchLike } from "../../shared";
import type { LLMMessage, LLMToolDefinition, ToolMode } from "../types";

export interface ToolModeBenchmarkOptions {
  apiKey: string;
  model: string;
  /** Override the OpenRouter base URL. */
  baseUrl?: string;
  /** Runs per mode (default 3). */
  runs?: number;
  /** Probe messages (default: a weather question). */
  messages?: LLMMessage[];
  /** Probe tool (default: get_weather). */
  tools?: LLMToolDefinition[];
  /**
   * Validates each emitted tool call's arguments to count `correct` runs — a
   * call that succeeds with garbage arguments (e.g. `{ "city": "?" }`) is a
   * failed decision. Defaults to the weather probe's schema.
   */
  correctnessSchema?: z.ZodType;
  /** Injectable fetch implementation, mainly for tests. */
  fetch?: FetchLike;
}

export interface ToolModeBenchmarkRun {
  /** ms to the tool call (decision latency), or to stream end when none. */
  latencyMs?: number;
  toolCall: boolean;
  /** Every emitted call's arguments parsed cleanly and validated. */
  correct?: boolean;
  prompt?: number;
  completion?: number;
  error?: string;
}

/** Latency percentiles over the runs that produced a tool call. */
export interface ToolModeTiming {
  p50: number;
  p95: number;
  p99: number;
}

export interface ToolModeReportEntry {
  /** Median cost ($) per decision over runs with provider usage. */
  cost?: number;
  /** Decision-latency percentiles; absent when no run emitted a tool call. */
  time?: ToolModeTiming;
  /** How many runs produced a tool call. */
  toolCalls: number;
  /**
   * How many runs emitted only schema-valid calls (undefined when no
   * `correctnessSchema` was provided).
   */
  correct: number | undefined;
  /** Cost per decision that was actually correct: `cost / (correct / runs)`. */
  effectiveCost?: number;
  /** How many runs failed outright (transport, envelope parse, …). */
  errors: number;
  /** The first run's error, when every run failed. */
  error?: string;
  /** Raw per-run rows, for diagnostics. */
  runs: ToolModeBenchmarkRun[];
}

export interface ToolModeBenchmarkResult {
  model: string;
  /** Prompt/completion prices ($/token) from the registry, when available. */
  pricing: { in: number; out: number } | undefined;
  report: Record<ToolMode, ToolModeReportEntry>;
  /** Fastest mode that actually emitted a tool call. */
  fastest: ToolMode | null;
  /** Cheapest mode that actually emitted a tool call. */
  cheapest: ToolMode | null;
}

const WEATHER_TOOL: LLMToolDefinition = {
  name: "get_weather",
  description: "Get the current weather for a city.",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
};

const WEATHER_MESSAGES: LLMMessage[] = [
  {
    role: "system",
    content:
      "You are a weather assistant. Always use the get_weather tool to answer, calling it once per city.",
  },
  { role: "user", content: "What is the weather in Paris and Tokyo?" },
];

const WEATHER_ARGS = z.object({ city: z.string().min(1) });

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)));
  return sorted[index]!;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

async function fetchPricing(
  model: string,
  fetchImpl: FetchLike,
): Promise<{ in: number; out: number } | undefined> {
  try {
    const response = await fetchImpl("https://openrouter.ai/api/v1/models");
    const data = (await response.json()) as {
      data: Array<{ id: string; pricing?: { prompt?: string; completion?: string } }>;
    };
    const entry = data.data.find((m) => m.id === model);
    const prompt = Number(entry?.pricing?.prompt ?? 0);
    const completion = Number(entry?.pricing?.completion ?? 0);
    return { in: prompt, out: completion };
  } catch {
    return undefined;
  }
}

export class ToolModeBenchmark {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string | undefined;
  private readonly runs: number;
  private readonly messages: LLMMessage[];
  private readonly tools: LLMToolDefinition[];
  private readonly correctnessSchema: z.ZodType | undefined;
  private readonly fetchImpl: FetchLike;

  constructor(options: ToolModeBenchmarkOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = options.baseUrl;
    this.runs = options.runs ?? 3;
    this.messages = options.messages ?? WEATHER_MESSAGES;
    this.tools = options.tools ?? [WEATHER_TOOL];
    this.correctnessSchema = options.correctnessSchema ?? WEATHER_ARGS;
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** Benchmark every mode and return the structured report. */
  async run(): Promise<ToolModeBenchmarkResult> {
    const pricing = await fetchPricing(this.model, this.fetchImpl);
    const report = {} as Record<ToolMode, ToolModeReportEntry>;
    for (const mode of ["native", "envelope", "prompted"] as const) {
      report[mode] = await this.benchmarkMode(mode, pricing);
    }

    const withCalls = (["native", "envelope", "prompted"] as const)
      .filter((mode) => (report[mode].toolCalls ?? 0) > 0)
      .map((mode) => ({ mode, entry: report[mode]! }));
    const byLatency = [...withCalls].sort(
      (a, b) => (a.entry.time?.p50 ?? Infinity) - (b.entry.time?.p50 ?? Infinity),
    );
    const byCost = [...withCalls].sort(
      (a, b) => (a.entry.cost ?? Infinity) - (b.entry.cost ?? Infinity),
    );

    return {
      model: this.model,
      pricing,
      report,
      fastest: byLatency[0]?.mode ?? null,
      cheapest: byCost[0]?.mode ?? null,
    };
  }

  private async benchmarkMode(
    mode: ToolMode,
    pricing: { in: number; out: number } | undefined,
  ): Promise<ToolModeReportEntry> {
    const runRows: ToolModeBenchmarkRun[] = [];

    for (let i = 0; i < this.runs; i++) {
      let usage: { prompt?: number; completion?: number } = {};
      const llm = new OpenRouterLLM({
        apiKey: this.apiKey,
        model: this.model,
        baseUrl: this.baseUrl,
        fetch: this.fetchImpl,
        onUsage: (u) => {
          usage = { prompt: u.promptTokens, completion: u.completionTokens };
        },
      });
      const start = performance.now();
      let toolCallAt: number | undefined;
      let error: string | undefined;
      const callArguments: string[] = [];
      try {
        for await (const event of llm.stream({
          messages: this.messages,
          tools: this.tools,
          temperature: 0,
          toolMode: mode,
        })) {
          if (event.type === "tool_call" && toolCallAt === undefined) {
            toolCallAt = performance.now() - start;
          }
          if (event.type === "tool_call") {
            callArguments.push(event.arguments);
          }
          if (event.type === "error") throw event.error;
          if (event.type === "done") break;
        }
      } catch (e) {
        error = e instanceof Error ? e.message.slice(0, 120) : String(e);
      }
      // A run is correct when every emitted call's arguments parse and
      // validate — a call that succeeds with garbage args is a failed decision.
      let correct: boolean | undefined;
      if (error === undefined && callArguments.length > 0 && this.correctnessSchema !== undefined) {
        correct = callArguments.every((raw) => {
          try {
            return this.correctnessSchema!.safeParse(JSON.parse(raw)).success;
          } catch {
            return false;
          }
        });
      }
      runRows.push({
        latencyMs:
          toolCallAt ?? (error === undefined ? performance.now() - start : undefined),
        toolCall: toolCallAt !== undefined,
        correct,
        prompt: usage.prompt,
        completion: usage.completion,
        error,
      });
    }

    const decisionLatencies = runRows
      .filter((r) => r.toolCall && r.latencyMs !== undefined)
      .map((r) => r.latencyMs!)
      .sort((a, b) => a - b);
    const costs = runRows
      .filter((r) => r.prompt !== undefined && r.completion !== undefined && pricing !== undefined)
      .map((r) => r.prompt! * pricing!.in + r.completion! * pricing!.out);
    const errors = runRows.filter((r) => r.error !== undefined);
    const correctRuns = runRows.filter((r) => r.correct === true).length;
    const correct = this.correctnessSchema !== undefined ? correctRuns : undefined;
    const cost = median(costs);
    // Price per decision that was actually usable: the median decision cost
    // divided by the correct rate.
    const effectiveCost =
      correct !== undefined && correct > 0 && cost !== undefined
        ? cost / (correct / runRows.length)
        : undefined;

    return {
      cost,
      time:
        decisionLatencies.length > 0
          ? {
              p50: percentile(decisionLatencies, 0.5),
              p95: percentile(decisionLatencies, 0.95),
              p99: percentile(decisionLatencies, 0.99),
            }
          : undefined,
      toolCalls: runRows.filter((r) => r.toolCall).length,
      correct,
      effectiveCost,
      errors: errors.length,
      error: errors[0]?.error,
      runs: runRows,
    };
  }
}
