export interface Action {
  label: string;
  value: string;
}

export interface OutboundMessage {
  sessionId: string;
  mode: "ask" | "notify" | "approve";
  content: string;
  promptId?: string;
  actions?: Action[];
  format?: "plain" | "markdown";
}

export interface InboundMessage {
  content: string;
  timestamp: Date;
  replyToPromptId?: string;
}

export interface InboundCommand {
  command: string;
  args?: string[];
}

export interface CommandResponse {
  data: unknown;
  error?: string;
}

export type DeliveryResult =
  | {
      delivered: true;
      whenDelivered?: Promise<void>;
    }
  | {
      delivered: false;
      queuePosition?: number;
      whenDelivered: Promise<void>;
    };

export interface CommunicationAdapter {
  send(message: OutboundMessage): Promise<DeliveryResult>;
  onMessage(handler: (message: InboundMessage) => void): void;
  onCommand(handler: (command: InboundCommand) => Promise<CommandResponse>): void;
  isConnected(): boolean;
}
