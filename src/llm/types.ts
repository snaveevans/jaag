export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface InternalMessage {
  role: "system" | "user" | "assistant" | "tool_result";
  content: string;
  toolCalls?: ToolCall[];
  toolResultId?: string;
}

export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ModelConfig {
  model: string;
  baseUrl: string;
  temperature: number;
  maxOutputTokens: number;
  apiKey: string;
}

export interface StreamChunk {
  type: "text" | "tool_call_start" | "tool_call_delta" | "tool_call_end" | "done";
  content?: string;
  toolCall?: ToolCall;
  toolCallKey?: string;
}
