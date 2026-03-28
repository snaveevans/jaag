import type { ServerWebSocket } from "bun";
import type {
  CommandResponse,
  CommunicationAdapter,
  DeliveryResult,
  InboundCommand,
  InboundMessage,
  OutboundMessage,
} from "./adapter.ts";
import { Logger } from "../observability/logger.ts";

interface WebSocketAdapterOptions {
  port: number;
  hostname?: string;
  maxBufferedMessages?: number;
  maxBufferedBytes?: number;
  logger?: Logger;
  helloPayload?: Record<string, unknown>;
}

interface DeliveryDeferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

type QueuedEvent =
  | { type: "message"; payload: OutboundMessage; deliveryDeferred: DeliveryDeferred; serialized: string; sizeBytes: number }
  | { type: "stream_chunk"; payload: { sessionId: string; content: string }; deliveryDeferred: DeliveryDeferred; serialized: string; sizeBytes: number };

type QueuedEventInput =
  | { type: "message"; payload: OutboundMessage; deliveryDeferred: DeliveryDeferred }
  | { type: "stream_chunk"; payload: { sessionId: string; content: string }; deliveryDeferred: DeliveryDeferred };

type ClientEnvelope =
  | { type: "message"; content: string; replyToPromptId?: string; reply_to_prompt_id?: string }
  | { type: "command"; command: string; args?: string[] }
  | { type: string; [key: string]: unknown };

type ServerEnvelope =
  | ({ type: "message" } & OutboundMessage)
  | { type: "stream_chunk"; sessionId: string; content: string }
  | { type: "command_response"; command: string; data: unknown; error?: string };

export class WebSocketCommunicationAdapter implements CommunicationAdapter {
  private readonly port: number;
  private readonly hostname: string;
  private readonly maxBufferedMessages: number;
  private readonly maxBufferedBytes: number;
  private readonly logger: Logger;
  private readonly helloPayload: Record<string, unknown> | null;
  private readonly outboundQueue: QueuedEvent[] = [];
  private outboundQueueBytes = 0;
  private server?: Bun.Server<undefined>;
  private socket: ServerWebSocket<undefined> | null = null;
  private messageHandler: ((message: InboundMessage) => void) | null = null;
  private commandHandler: ((command: InboundCommand) => Promise<CommandResponse>) | null = null;

  constructor(options: WebSocketAdapterOptions) {
    this.port = options.port;
    this.hostname = options.hostname ?? "127.0.0.1";
    this.maxBufferedMessages = options.maxBufferedMessages ?? 100;
    this.maxBufferedBytes = options.maxBufferedBytes ?? 1024 * 1024;
    this.helloPayload = options.helloPayload ?? null;
    this.logger = (options.logger ?? new Logger()).child({ component: "communication.websocket" });
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

          this.logger.info("websocket.client.connected");

          if (this.helloPayload) {
            try {
              socket.send(JSON.stringify({ type: "hello", ...this.helloPayload }));
            } catch {
              // Hello is best-effort; never prevent connection from proceeding.
            }
          }

          void this.flushQueuedEvents();
        },
        message: (socket, message) => {
          const text = normalizeWebSocketPayload(message);
          if (!text) {
            return;
          }

          let envelope: ClientEnvelope;
          try {
            envelope = JSON.parse(text) as ClientEnvelope;
          } catch {
            this.logger.warn("websocket.inbound.malformed", {
              reason: "invalid JSON",
            });
            return;
          }

          if (typeof envelope !== "object" || envelope === null) {
            this.logger.warn("websocket.inbound.unsupported", {
              envelopeType: undefined,
            });
            return;
          }

          if (envelope.type === "message" && typeof envelope.content === "string") {
            this.messageHandler?.({
              content: envelope.content,
              timestamp: new Date(),
              replyToPromptId: getReplyToPromptId(envelope),
            });
            return;
          }

          if (envelope.type === "command" && typeof envelope.command === "string") {
            void this.handleCommand(socket, {
              command: envelope.command,
              args: getCommandArgs(envelope),
            });
            return;
          }

          this.logger.warn("websocket.inbound.unsupported", {
            envelopeType: envelope.type,
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
      const queuedEvent = this.shiftQueuedEvent();
      queuedEvent?.deliveryDeferred.reject(new Error("WebSocket adapter stopped before queued event delivery."));
    }

    this.socket = null;
    this.server?.stop(true);
    this.server = undefined;
  }

  async send(message: OutboundMessage): Promise<DeliveryResult> {
    return this.enqueueOrSend(createQueuedEvent({
      type: "message",
      payload: message,
      deliveryDeferred: createDeliveryDeferred(),
    }));
  }

  async sendStreamChunk(sessionId: string, content: string): Promise<DeliveryResult> {
    return this.enqueueOrSend(createQueuedEvent({
      type: "stream_chunk",
      payload: { sessionId, content },
      deliveryDeferred: createDeliveryDeferred(),
    }));
  }

  onMessage(handler: (message: InboundMessage) => void): void {
    this.messageHandler = handler;
  }

  onCommand(handler: (command: InboundCommand) => Promise<CommandResponse>): void {
    this.commandHandler = handler;
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

  private async handleCommand(socket: ServerWebSocket<undefined>, command: InboundCommand): Promise<void> {
    try {
      const response = this.commandHandler
        ? await this.commandHandler(command)
        : { data: null, error: "Commands not supported" };

      this.sendCommandResponse(socket, command.command, response);
    } catch (error) {
      this.sendCommandResponse(socket, command.command, {
        data: null,
        error: toErrorMessage(error),
      });
    }
  }

  private async enqueueOrSend(event: QueuedEvent): Promise<DeliveryResult> {
    if (!this.socket) {
      return this.enqueueBufferedEvent(event);
    }

    try {
      this.socket.send(event.serialized);
      event.deliveryDeferred.resolve();
      return {
        delivered: true,
        whenDelivered: event.deliveryDeferred.promise,
      };
    } catch {
      this.socket = null;
      return this.enqueueBufferedEvent(event);
    }
  }

  private async flushQueuedEvents(): Promise<void> {
    while (this.socket && this.outboundQueue.length > 0) {
      const nextEvent = this.shiftQueuedEvent();
      if (!nextEvent) {
        return;
      }

      try {
        this.socket.send(nextEvent.serialized);
        nextEvent.deliveryDeferred.resolve();
      } catch {
        this.prependQueuedEvent(nextEvent);
        this.socket = null;
        return;
      }
    }
  }

  private enqueueBufferedEvent(event: QueuedEvent): DeliveryResult {
    this.pushQueuedEvent(event);
    this.trimQueueToFit();

    const queuePosition = this.outboundQueue.indexOf(event);
    return queuePosition >= 0
      ? {
          delivered: false,
          queuePosition: queuePosition + 1,
          whenDelivered: event.deliveryDeferred.promise,
        }
      : {
          delivered: false,
          whenDelivered: event.deliveryDeferred.promise,
        };
  }

  private trimQueueToFit(): void {
    const droppedEvents: QueuedEvent[] = [];

    while (
      this.outboundQueue.length > this.maxBufferedMessages
      || this.outboundQueueBytes > this.maxBufferedBytes
    ) {
      const droppedEvent = this.shiftQueuedEvent();
      if (!droppedEvent) {
        break;
      }

      droppedEvents.push(droppedEvent);
    }

    if (droppedEvents.length === 0) {
      return;
    }

    for (const droppedEvent of droppedEvents) {
      droppedEvent.deliveryDeferred.reject(new Error("WebSocket outbound buffer overflowed before queued event delivery."));
    }

    this.logger.warn("websocket.buffer.overflow", {
      droppedCount: droppedEvents.length,
      droppedBytes: droppedEvents.reduce((total, entry) => total + entry.sizeBytes, 0),
      bufferedMessages: this.outboundQueue.length,
      bufferedBytes: this.outboundQueueBytes,
      maxBufferedMessages: this.maxBufferedMessages,
      maxBufferedBytes: this.maxBufferedBytes,
    });
  }

  private pushQueuedEvent(event: QueuedEvent): void {
    this.outboundQueue.push(event);
    this.outboundQueueBytes += event.sizeBytes;
  }

  private prependQueuedEvent(event: QueuedEvent): void {
    this.outboundQueue.unshift(event);
    this.outboundQueueBytes += event.sizeBytes;
  }

  private shiftQueuedEvent(): QueuedEvent | undefined {
    const event = this.outboundQueue.shift();
    if (event) {
      this.outboundQueueBytes = Math.max(0, this.outboundQueueBytes - event.sizeBytes);
    }

    return event;
  }

  private sendCommandResponse(
    socket: ServerWebSocket<undefined>,
    command: string,
    response: CommandResponse,
  ): void {
    try {
      socket.send(JSON.stringify({
        type: "command_response",
        command,
        data: response.data,
        ...(response.error ? { error: response.error } : {}),
      } satisfies ServerEnvelope));
    } catch (error) {
      if (this.socket === socket) {
        this.socket = null;
      }

      this.logger.warn("websocket.command_response.failed", {
        command,
        error: toErrorMessage(error),
      });
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

function createQueuedEvent(event: QueuedEventInput): QueuedEvent {
  const serialized = JSON.stringify(toServerEnvelopeInput(event));
  const sizeBytes = new TextEncoder().encode(serialized).byteLength;
  return {
    ...event,
    serialized,
    sizeBytes,
  } as QueuedEvent;
}

function toServerEnvelopeInput(event: QueuedEventInput): ServerEnvelope {
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

function getCommandArgs(envelope: ClientEnvelope): string[] | undefined {
  if (!("args" in envelope) || !Array.isArray(envelope.args) || envelope.args.some((value) => typeof value !== "string")) {
    return undefined;
  }

  return envelope.args;
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

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
