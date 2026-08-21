export { Orchestrator } from "./orchestrator";
export type { OrchestratorOptions } from "./orchestrator";

// Extracted execution domains. The orchestrator composes these; re-exporting
// them keeps the folder's public surface under one roof.
export {
  ConversationHistory,
  formatTimeContext,
  formatTurnContext,
  windowHistory,
  type HistoryWindow,
} from "./history";
export { buildUnderstandPrompt, findAddressedAgent, findAgentByName, pickAgent } from "./routing";
export { GenerationRunner } from "./generation";
export type { GenerationOutcome, GenerationRequest, GenerationStatus } from "./generation";
export { SpeechPipeline } from "./speech";
export type { SpeechPipelineOptions } from "./speech";
export { ToolCallManager } from "./tools";
export type { ResolvedToolCall } from "./tools";
export { CoordinationRunner } from "./coordination-runner";
export type { CoordinationRunnerOptions } from "./coordination-runner";
