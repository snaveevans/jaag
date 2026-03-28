export type ServerMessage = HelloMessage | ContentMessage | StreamChunkMessage;

export interface HelloMessage {
  type: "hello";
  version: string;
  model: string;
  provider: string;
  agentHome: string;
  workspace: string;
}

export interface ContentMessage {
  type: "message";
  sessionId: string;
  mode: "ask" | "notify" | "approve";
  content: string;
  promptId?: string;
  actions?: { label: string; value: string }[];
  format?: "plain" | "markdown";
}

export interface StreamChunkMessage {
  type: "stream_chunk";
  sessionId: string;
  content: string;
}

export interface ClientMessage {
  type: "message";
  content: string;
  replyToPromptId?: string;
}

export interface DisplayMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
  streaming?: boolean;
}

export type ConnectionState = "disconnected" | "connecting" | "connected";
