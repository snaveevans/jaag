import { afterEach, describe, expect, test } from "bun:test";
import { Logger } from "../observability/logger.ts";
import { WebSocketCommunicationAdapter } from "./websocket.ts";

const adapters: WebSocketCommunicationAdapter[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  while (sockets.length > 0) {
    sockets.pop()?.close();
  }

  while (adapters.length > 0) {
    await adapters.pop()?.stop();
  }
});

describe("WebSocketCommunicationAdapter", () => {
  test("queues outbound messages until a client reconnects", async () => {
    const adapter = new WebSocketCommunicationAdapter({ port: 0 });
    adapters.push(adapter);
    await adapter.start();

    const delivery = await adapter.send({
      sessionId: "session-1",
      mode: "notify",
      content: "queued",
    });

    expect(delivery).toMatchObject({ delivered: false, queuePosition: 1 });
    expect(delivery.whenDelivered).toBeInstanceOf(Promise);

    const client = await connect(adapter.getUrl());
    sockets.push(client);

    const event = await waitForJsonMessage(client);
    await expect(delivery.whenDelivered).resolves.toBeUndefined();
    expect(event).toEqual({
      type: "message",
      sessionId: "session-1",
      mode: "notify",
      content: "queued",
    });
  });

  test("drops the oldest buffered messages on overflow and delivers the rest after reconnect", async () => {
    const { parsed, sink } = createCaptureSink();
    const adapter = new WebSocketCommunicationAdapter({
      port: 0,
      maxBufferedMessages: 3,
      logger: new Logger({ sink }),
    });
    adapters.push(adapter);
    await adapter.start();

    const deliveries = await Promise.all([
      adapter.send({ sessionId: "session-1", mode: "notify", content: "queued-1" }),
      adapter.send({ sessionId: "session-1", mode: "notify", content: "queued-2" }),
      adapter.send({ sessionId: "session-1", mode: "notify", content: "queued-3" }),
      adapter.send({ sessionId: "session-1", mode: "notify", content: "queued-4" }),
    ]);

    await expect(deliveries[0]?.whenDelivered).rejects.toThrow(
      "WebSocket outbound buffer overflowed before queued event delivery.",
    );

    const { messages: receivedPromise, socket: client } = await connectWithJsonMessages(adapter.getUrl(), 3);
    sockets.push(client);

    await expect(Promise.all(deliveries.slice(1).map((delivery) => delivery.whenDelivered))).resolves.toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(await receivedPromise).toEqual([
      {
        type: "message",
        sessionId: "session-1",
        mode: "notify",
        content: "queued-2",
      },
      {
        type: "message",
        sessionId: "session-1",
        mode: "notify",
        content: "queued-3",
      },
      {
        type: "message",
        sessionId: "session-1",
        mode: "notify",
        content: "queued-4",
      },
    ]);

    expect(parsed()).toContainEqual(expect.objectContaining({
      level: "warn",
      event: "websocket.buffer.overflow",
      component: "communication.websocket",
      droppedCount: 1,
      bufferedMessages: 3,
      maxBufferedMessages: 3,
    }));
  });

  test("drops the oldest buffered messages when the byte limit overflows", async () => {
    const { parsed, sink } = createCaptureSink();
    const logger = new Logger({ sink });
    const content = "x".repeat(60);
    const adapter = new WebSocketCommunicationAdapter({
      port: 0,
      maxBufferedMessages: 10,
      maxBufferedBytes: 200,
      logger,
    });
    adapters.push(adapter);
    await adapter.start();

    const firstDelivery = await adapter.send({ sessionId: "session-1", mode: "notify", content: `first-${content}` });
    const secondDelivery = await adapter.send({ sessionId: "session-1", mode: "notify", content: `second-${content}` });

    await expect(firstDelivery.whenDelivered).rejects.toThrow(
      "WebSocket outbound buffer overflowed before queued event delivery.",
    );

    const client = await connect(adapter.getUrl());
    sockets.push(client);

    const event = await waitForJsonMessage(client);
    await expect(secondDelivery.whenDelivered).resolves.toBeUndefined();
    expect(event).toEqual({
      type: "message",
      sessionId: "session-1",
      mode: "notify",
      content: `second-${content}`,
    });

    expect(parsed()).toContainEqual(expect.objectContaining({
      level: "warn",
      event: "websocket.buffer.overflow",
      component: "communication.websocket",
      droppedCount: 1,
      maxBufferedBytes: 200,
    }));
  });

  test("delivers inbound client messages to the handler", async () => {
    const adapter = new WebSocketCommunicationAdapter({ port: 0 });
    adapters.push(adapter);
    await adapter.start();

    const received = new Promise<{ content: string; replyToPromptId?: string }>((resolve) => {
      adapter.onMessage((message) => resolve({ content: message.content, replyToPromptId: message.replyToPromptId }));
    });

    const client = await connect(adapter.getUrl());
    sockets.push(client);
    client.send(JSON.stringify({ type: "message", content: "hello daemon", replyToPromptId: "prompt-123" }));

    expect(await received).toEqual({ content: "hello daemon", replyToPromptId: "prompt-123" });
  });

  test("includes prompt ids on outbound prompt messages", async () => {
    const adapter = new WebSocketCommunicationAdapter({ port: 0 });
    adapters.push(adapter);
    await adapter.start();

    const client = await connect(adapter.getUrl());
    sockets.push(client);

    const delivery = await adapter.send({
      sessionId: "session-1",
      mode: "ask",
      content: "Need input.",
      promptId: "prompt-123",
    });

    expect(delivery).toMatchObject({ delivered: true });
    await expect(delivery.whenDelivered).resolves.toBeUndefined();

    const event = await waitForJsonMessage(client);
    expect(event).toEqual({
      type: "message",
      sessionId: "session-1",
      mode: "ask",
      content: "Need input.",
      promptId: "prompt-123",
    });
  });

  test("logs malformed and unsupported inbound websocket payloads", async () => {
    const { parsed, sink } = createCaptureSink();
    const adapter = new WebSocketCommunicationAdapter({
      port: 0,
      logger: new Logger({ sink }),
    });
    adapters.push(adapter);
    await adapter.start();

    const client = await connect(adapter.getUrl());
    sockets.push(client);

    client.send("not-json");
    await waitForCondition(
      () => parsed().some((entry) => entry.event === "websocket.inbound.malformed"),
      1000,
      "Timed out waiting for malformed payload logging.",
    );

    client.send(JSON.stringify({ type: "unknown" }));
    await waitForCondition(
      () => parsed().some((entry) => entry.event === "websocket.inbound.unsupported"),
      1000,
      "Timed out waiting for unsupported payload logging.",
    );

    expect(parsed()).toContainEqual(expect.objectContaining({
      level: "warn",
      event: "websocket.inbound.malformed",
      component: "communication.websocket",
      reason: "invalid JSON",
    }));
    expect(parsed()).toContainEqual(expect.objectContaining({
      level: "warn",
      event: "websocket.inbound.unsupported",
      component: "communication.websocket",
      envelopeType: "unknown",
    }));
  });
});

async function connect(url: string): Promise<WebSocket> {
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket failed to connect")), {
      once: true,
    });
  });
}

async function connectWithJsonMessages(
  url: string,
  count: number,
): Promise<{ socket: WebSocket; messages: Promise<Record<string, unknown>[]> }> {
  const messages = createJsonMessageCollector(count);

  const socket = await new Promise<WebSocket>((resolve, reject) => {
    const candidate = new WebSocket(url);
    candidate.addEventListener("message", messages.handleMessage);
    candidate.addEventListener("open", () => resolve(candidate), { once: true });
    candidate.addEventListener("error", () => reject(new Error("WebSocket failed to connect")), {
      once: true,
    });
  });

  return {
    socket,
    messages: messages.promise,
  };
}

async function waitForJsonMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    socket.addEventListener(
      "message",
      (event) => {
        try {
          resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
        } catch (error) {
          reject(error);
        }
      },
      { once: true },
    );
  });
}

async function waitForJsonMessages(socket: WebSocket, count: number): Promise<Record<string, unknown>[]> {
  const collector = createJsonMessageCollector(count);
  socket.addEventListener("message", collector.handleMessage);
  return await collector.promise;
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs: number,
  errorMessage: string,
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(errorMessage);
    }

    await Bun.sleep(10);
  }
}

function createCaptureSink() {
  const lines: string[] = [];
  return {
    sink: {
      write(line: string) {
        lines.push(line);
      },
    },
    lines,
    parsed: () => lines.map((line) => JSON.parse(line.trim()) as Record<string, unknown>),
  };
}

function createJsonMessageCollector(count: number) {
  const messages: Record<string, unknown>[] = [];
  let settled = false;
  let resolve!: (messages: Record<string, unknown>[]) => void;
  let reject!: (error: unknown) => void;

  return {
    handleMessage(event: MessageEvent) {
      if (settled) {
        return;
      }

      try {
        messages.push(JSON.parse(String(event.data)) as Record<string, unknown>);
        if (messages.length === count) {
          settled = true;
          resolve(messages);
        }
      } catch (error) {
        settled = true;
        reject(error);
      }
    },
    promise: new Promise<Record<string, unknown>[]>((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    }),
  };
}
