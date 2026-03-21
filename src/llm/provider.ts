import type { InternalMessage, ModelConfig, StreamChunk, ToolDeclaration } from "./types.ts";

export interface LLMProvider {
  stream(
    messages: InternalMessage[],
    tools: ToolDeclaration[],
    config: ModelConfig,
  ): AsyncIterable<StreamChunk>;
}
