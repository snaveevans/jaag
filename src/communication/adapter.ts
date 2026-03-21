export interface Action {
  label: string;
  value: string;
}

export interface OutboundMessage {
  sessionId: string;
  mode: "ask" | "notify" | "approve";
  content: string;
  actions?: Action[];
  format?: "plain" | "markdown";
}

export interface InboundMessage {
  content: string;
  timestamp: Date;
}

export interface DeliveryResult {
  delivered: boolean;
  queuePosition?: number;
}

export interface CommunicationAdapter {
  send(message: OutboundMessage): Promise<DeliveryResult>;
  onMessage(handler: (message: InboundMessage) => void): void;
  isConnected(): boolean;
}
