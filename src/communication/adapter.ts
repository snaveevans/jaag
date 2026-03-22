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
  isConnected(): boolean;
}
