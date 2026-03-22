import { afterEach, describe, expect, test } from "bun:test";
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
