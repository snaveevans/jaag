import type { ServerWebSocket } from "bun";
import type { CommunicationAdapter, DeliveryResult, InboundMessage, OutboundMessage } from "./adapter.ts";

interface WebSocketAdapterOptions {
  port: number;
  hostname?: string;
}

interface DeliveryDeferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

type QueuedEvent =
  | { type: "message"; payload: OutboundMessage; deliveryDeferred: DeliveryDeferred }
  | { type: "stream_chunk"; payload: { sessionId: string; content: string }; deliveryDeferred: DeliveryDeferred };

type ClientEnvelope =
  | { type: "message"; content: string; replyToPromptId?: string; reply_to_prompt_id?: string }
  | { type: string; [key: string]: unknown };

type ServerEnvelope =
  | ({ type: "message" } & OutboundMessage)
  | { type: "stream_chunk"; sessionId: string; content: string };

export class WebSocketCommunicationAdapter implements CommunicationAdapter {
  private readonly port: number;
  private readonly hostname: string;
  private readonly outboundQueue: QueuedEvent[] = [];
  private server?: Bun.Server<undefined>;
  private socket: ServerWebSocket<undefined> | null = null;
  private messageHandler: ((message: InboundMessage) => void) | null = null;

  constructor(options: WebSocketAdapterOptions) {
    this.port = options.port;
    this.hostname = options.hostname ?? "127.0.0.1";
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    this.server = Bun.serve<undefined>({
      hostname: this.hostname,
      port: this.port,
      fetch: (request, server) => {
        if (server.upgrade(request)) {
          return undefined;
        }

        return new Response("Agent daemon websocket endpoint", { status: 200 });
      },
      websocket: {
        open: (socket) => {
          const previousSocket = this.socket;
          this.socket = socket;

          if (previousSocket && previousSocket !== socket) {
            previousSocket.close(1000, "Replaced by newer connection");
          }

          void this.flushQueuedEvents();
        },
        message: (_socket, message) => {
          const text = normalizeWebSocketPayload(message);
          if (!text) {
            return;
          }

          let envelope: ClientEnvelope;
          try {
            envelope = JSON.parse(text) as ClientEnvelope;
          } catch {
            return;
          }

          if (envelope.type !== "message" || typeof envelope.content !== "string") {
            return;
          }

          this.messageHandler?.({
            content: envelope.content,
            timestamp: new Date(),
            replyToPromptId: getReplyToPromptId(envelope),
          });
        },
        close: (socket) => {
          if (this.socket === socket) {
            this.socket = null;
          }
        },
      },
    });
  }

  async stop(): Promise<void> {
    while (this.outboundQueue.length > 0) {
      const queuedEvent = this.outboundQueue.shift();
      queuedEvent?.deliveryDeferred.reject(new Error("WebSocket adapter stopped before queued event delivery."));
    }

    this.socket = null;
    this.server?.stop(true);
    this.server = undefined;
  }

  async send(message: OutboundMessage): Promise<DeliveryResult> {
    return this.enqueueOrSend({
      type: "message",
      payload: message,
      deliveryDeferred: createDeliveryDeferred(),
    });
  }

  async sendStreamChunk(sessionId: string, content: string): Promise<DeliveryResult> {
    return this.enqueueOrSend({
      type: "stream_chunk",
      payload: { sessionId, content },
      deliveryDeferred: createDeliveryDeferred(),
    });
  }

  onMessage(handler: (message: InboundMessage) => void): void {
    this.messageHandler = handler;
  }

  isConnected(): boolean {
    return this.socket !== null;
  }

  getPort(): number {
    return this.server?.port ?? this.port;
  }

  getUrl(): string {
    return `ws://${this.hostname}:${this.getPort()}`;
  }

  private async enqueueOrSend(event: QueuedEvent): Promise<DeliveryResult> {
    if (!this.socket) {
      this.outboundQueue.push(event);
      return {
        delivered: false,
        queuePosition: this.outboundQueue.length,
        whenDelivered: event.deliveryDeferred.promise,
      };
    }

    try {
      this.socket.send(JSON.stringify(toServerEnvelope(event)));
      event.deliveryDeferred.resolve();
      return {
        delivered: true,
        whenDelivered: event.deliveryDeferred.promise,
      };
    } catch {
      this.socket = null;
      this.outboundQueue.push(event);
      return {
        delivered: false,
        queuePosition: this.outboundQueue.length,
        whenDelivered: event.deliveryDeferred.promise,
      };
    }
  }

  private async flushQueuedEvents(): Promise<void> {
    while (this.socket && this.outboundQueue.length > 0) {
      const nextEvent = this.outboundQueue.shift();
      if (!nextEvent) {
        return;
      }

      try {
        this.socket.send(JSON.stringify(toServerEnvelope(nextEvent)));
        nextEvent.deliveryDeferred.resolve();
      } catch {
        this.outboundQueue.unshift(nextEvent);
        this.socket = null;
        return;
      }
    }
  }
}

function toServerEnvelope(event: QueuedEvent): ServerEnvelope {
  if (event.type === "message") {
    return {
      type: "message",
      ...event.payload,
    };
  }

  return {
    type: "stream_chunk",
    sessionId: event.payload.sessionId,
    content: event.payload.content,
  };
}

function getReplyToPromptId(envelope: ClientEnvelope): string | undefined {
  const replyToPromptId = "replyToPromptId" in envelope ? envelope.replyToPromptId : undefined;
  if (typeof replyToPromptId === "string" && replyToPromptId.trim() !== "") {
    return replyToPromptId.trim();
  }

  const snakeCaseReplyToPromptId = "reply_to_prompt_id" in envelope ? envelope.reply_to_prompt_id : undefined;
  if (typeof snakeCaseReplyToPromptId === "string" && snakeCaseReplyToPromptId.trim() !== "") {
    return snakeCaseReplyToPromptId.trim();
  }

  return undefined;
}

function createDeliveryDeferred(): DeliveryDeferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;

  const promise = new Promise<void>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = (error: Error) => promiseReject(error);
  });
  void promise.catch(() => {});

  return { promise, resolve, reject };
}

function normalizeWebSocketPayload(payload: string | ArrayBuffer | Uint8Array): string {
  if (typeof payload === "string") {
    return payload;
  }

  if (payload instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(payload));
  }

  return new TextDecoder().decode(payload);
}
