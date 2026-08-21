import type { LLM, LLMRequest } from "./types";

export type {
  FavoriteModel,
  LLM,
  LLMEvent,
  LLMMessage,
  LLMRole,
  LLMToolCall,
  LLMToolDefinition,
  LLMRequest,
  StringOr,
} from "./types";

export { FAVORITE_MODELS } from "./types";

/**
 * Stream only the text deltas of an LLM generation, rethrowing any
 * streamed error.
 */
export async function* streamText(
  llm: LLM,
  request: LLMRequest,
): AsyncGenerator<string> {
  for await (const event of llm.stream(request)) {
    if (event.type === "delta") {
      yield event.content;
    } else if (event.type === "error") {
      throw event.error;
    }
  }
}

/** Collect an entire LLM generation into a single string. */
export async function complete(llm: LLM, request: LLMRequest): Promise<string> {
  let text = "";
  for await (const chunk of streamText(llm, request)) {
    text += chunk;
  }
  return text;
}

export { DeepSeekLLM, OpenRouterLLM } from "./adapters/index";
export { ToolModeBenchmark } from "./toolmode";
export type {
  ToolModeBenchmarkOptions,
  ToolModeBenchmarkResult,
  ToolModeBenchmarkRun,
  ToolModeReportEntry,
  ToolModeTiming,
} from "./toolmode";
