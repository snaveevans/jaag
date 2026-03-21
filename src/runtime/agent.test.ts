import { describe, expect, test } from "bun:test";
import type { CommunicationAdapter, DeliveryResult, InboundMessage, OutboundMessage } from "../communication/adapter.ts";
import type { LLMProvider } from "../llm/provider.ts";
import type { InternalMessage, ModelConfig, StreamChunk, ToolDeclaration } from "../llm/types.ts";
import { PrimitiveDispatcher } from "../primitives/dispatcher.ts";
import { SessionManager } from "../session/manager.ts";
import { AgentRuntime } from "./agent.ts";

class FakeAdapter implements CommunicationAdapter {
  sentMessages: OutboundMessage[] = [];
  streamChunks: Array<{ sessionId: string; content: string }> = [];
  private handler: ((message: InboundMessage) => void) | null = null;

  async send(message: OutboundMessage): Promise<DeliveryResult> {
    this.sentMessages.push(message);
    return { delivered: true };
  }

  onMessage(handler: (message: InboundMessage) => void): void {
    this.handler = handler;
  }

  isConnected(): boolean {
    return true;
  }

  async sendStreamChunk(sessionId: string, content: string): Promise<DeliveryResult> {
    this.streamChunks.push({ sessionId, content });
    return { delivered: true };
  }

  dispatchInbound(content: string, timestamp = new Date()): void {
    this.handler?.({ content, timestamp });
  }
}

class ToolThenTextProvider implements LLMProvider {
  callCount = 0;
  messageSnapshots: InternalMessage[][] = [];

  async *stream(
    messages: InternalMessage[],
    _tools: ToolDeclaration[],
    _config: ModelConfig,
  ): AsyncIterable<StreamChunk> {
    this.callCount += 1;
    this.messageSnapshots.push(messages.map((message) => ({ ...message })));

    if (this.callCount === 1) {
      yield {
        type: "tool_call_start",
        toolCall: { id: "call-1", name: "file_read", arguments: "" },
      };
      yield {
        type: "tool_call_delta",
        toolCall: { id: "call-1", name: "file_read", arguments: '{"path":"notes.txt"}' },
      };
      yield {
        type: "tool_call_end",
        toolCall: { id: "call-1", name: "file_read", arguments: '{"path":"notes.txt"}' },
      };
      yield { type: "done" };
      return;
    }

    yield { type: "text", content: "Tool attempt finished." };
    yield { type: "done" };
  }
}

class LateIdToolThenTextProvider implements LLMProvider {
  callCount = 0;

  async *stream(
    _messages: InternalMessage[],
    _tools: ToolDeclaration[],
    _config: ModelConfig,
  ): AsyncIterable<StreamChunk> {
    this.callCount += 1;

    if (this.callCount === 1) {
      yield {
        type: "tool_call_start",
        toolCallKey: "tool_call_0",
        toolCall: { id: "tool_call_0", name: "file_read", arguments: "" },
      };
      yield {
        type: "tool_call_delta",
        toolCallKey: "tool_call_0",
        toolCall: { id: "tool_call_0", name: "file_read", arguments: '{"path":"no' },
      };
      yield {
        type: "tool_call_delta",
        toolCallKey: "tool_call_0",
        toolCall: { id: "call-1", name: "file_read", arguments: '{"path":"notes.txt"}' },
      };
      yield {
        type: "tool_call_end",
        toolCallKey: "tool_call_0",
        toolCall: { id: "call-1", name: "file_read", arguments: '{"path":"notes.txt"}' },
      };
      yield { type: "done" };
      return;
    }

    yield { type: "text", content: "Resolved with late id." };
    yield { type: "done" };
  }
}

class SlowTextProvider implements LLMProvider {
  userMessages: string[] = [];

  async *stream(
    messages: InternalMessage[],
    _tools: ToolDeclaration[],
    _config: ModelConfig,
  ): AsyncIterable<StreamChunk> {
    const latestUserMessage = [...messages].reverse().find((message) => message.role === "user");
    this.userMessages.push(latestUserMessage?.content ?? "");
    await Bun.sleep(25);
    yield { type: "text", content: `reply:${latestUserMessage?.content ?? ""}` };
    yield { type: "done" };
  }
}

describe("AgentRuntime", () => {
  test("runs the tool-call loop and appends stub tool results", async () => {
    const adapter = new FakeAdapter();
    const provider = new ToolThenTextProvider();
    const sessionManager = new SessionManager({
      buildSystemPrompt: () => "system prompt",
    });
    const runtime = new AgentRuntime({
      adapter,
      llmProvider: provider,
      modelConfig: {
        model: "fake-model",
        baseUrl: "http://localhost",
        temperature: 0,
        maxOutputTokens: 128,
        apiKey: "test-key",
      },
      sessionManager,
      primitiveDispatcher: new PrimitiveDispatcher(),
    });

    runtime.start();
    adapter.dispatchInbound("hello");

    expect(await runtime.waitForIdle(1000)).toBe(true);
    expect(provider.callCount).toBe(2);
    expect(adapter.streamChunks).toEqual([
      { sessionId: sessionManager.getInteractiveSession()!.id, content: "Tool attempt finished." },
    ]);

    const session = sessionManager.getInteractiveSession();
    expect(session).not.toBeNull();
    expect(session?.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool_result",
      "assistant",
    ]);
    expect(session?.messages[2]?.toolCalls?.[0]?.name).toBe("file_read");
    expect(session?.messages[3]?.content).toContain("Primitive not implemented yet");
    expect(session?.status).toBe("waiting_for_user");
  });

  test("queues inbound messages while the active session is busy", async () => {
    const adapter = new FakeAdapter();
    const provider = new SlowTextProvider();
    const sessionManager = new SessionManager({
      buildSystemPrompt: () => "system prompt",
    });
    const runtime = new AgentRuntime({
      adapter,
      llmProvider: provider,
      modelConfig: {
        model: "fake-model",
        baseUrl: "http://localhost",
        temperature: 0,
        maxOutputTokens: 128,
        apiKey: "test-key",
      },
      sessionManager,
      primitiveDispatcher: new PrimitiveDispatcher(),
    });

    runtime.start();
    adapter.dispatchInbound("first", new Date("2026-03-19T00:00:00.000Z"));
    adapter.dispatchInbound("second", new Date("2026-03-19T00:00:01.000Z"));

    expect(await runtime.waitForIdle(1000)).toBe(true);
    expect(provider.userMessages).toEqual(["first", "second"]);

    const session = sessionManager.getInteractiveSession();
    expect(session?.messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual([
      "first",
      "second",
    ]);
  });

  test("merges streamed tool calls when the provider resolves the id later", async () => {
    const adapter = new FakeAdapter();
    const provider = new LateIdToolThenTextProvider();
    const sessionManager = new SessionManager({
      buildSystemPrompt: () => "system prompt",
    });
    const runtime = new AgentRuntime({
      adapter,
      llmProvider: provider,
      modelConfig: {
        model: "fake-model",
        baseUrl: "http://localhost",
        temperature: 0,
        maxOutputTokens: 128,
        apiKey: "test-key",
      },
      sessionManager,
      primitiveDispatcher: new PrimitiveDispatcher(),
    });

    runtime.start();
    adapter.dispatchInbound("hello");

    expect(await runtime.waitForIdle(1000)).toBe(true);
    expect(provider.callCount).toBe(2);

    const session = sessionManager.getInteractiveSession();
    expect(session?.messages[2]?.toolCalls).toEqual([
      { id: "call-1", name: "file_read", arguments: '{"path":"notes.txt"}' },
    ]);
    expect(session?.messages[3]?.toolResultId).toBe("call-1");
  });
});
