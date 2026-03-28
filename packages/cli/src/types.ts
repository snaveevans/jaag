export type ServerMessage = HelloMessage | ContentMessage | StreamChunkMessage | CommandResponseMessage;

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

export interface CommandResponseMessage {
  type: "command_response";
  command: string;
  data: unknown;
  error?: string;
}

export interface ClientMessage {
  type: "message";
  content: string;
  replyToPromptId?: string;
}

export type ClientOutbound = ClientMessage | ClientCommandMessage;

export interface ClientCommandMessage {
  type: "command";
  command: string;
  args?: string[];
}

export interface DisplayMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
  streaming?: boolean;
}

export type ConnectionState = "disconnected" | "connecting" | "connected";
