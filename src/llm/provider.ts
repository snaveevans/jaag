import type { InternalMessage, ModelConfig, StreamChunk, ToolDeclaration } from "./types.ts";

export class LLMProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LLMProviderUnavailableError";
  }
}

export interface LLMProvider {
  stream(
    messages: InternalMessage[],
    tools: ToolDeclaration[],
    config: ModelConfig,
  ): AsyncIterable<StreamChunk>;
}
