export interface LLM {
  stream(request: LLMRequest): AsyncIterable<LLMEvent>;
  stop(): void;
}
