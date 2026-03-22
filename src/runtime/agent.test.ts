import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommunicationAdapter, DeliveryResult, InboundMessage, OutboundMessage } from "../communication/adapter.ts";
import type { LLMProvider } from "../llm/provider.ts";
import type { InternalMessage, ModelConfig, StreamChunk, ToolDeclaration } from "../llm/types.ts";
import { PrimitiveDispatcher } from "../primitives/dispatcher.ts";
import { SessionManager } from "../session/manager.ts";
import { buildMockBearerToolSpec, buildMockMutationToolSpec, buildMockOAuthToolSpec } from "../test/tool-spec-fixtures.ts";
import { AgentRuntime } from "./agent.ts";

const servers: Bun.Server<unknown>[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    servers.pop()?.stop(true);
  }

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

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

  dispatchInbound(content: string, timestamp = new Date(), replyToPromptId?: string): void {
    this.handler?.({ content, timestamp, replyToPromptId });
  }
}

class PromptReplyingAdapter extends FakeAdapter {
  private replied = false;

  constructor(private readonly reply: string) {
    super();
  }

  override async send(message: OutboundMessage): Promise<DeliveryResult> {
    this.sentMessages.push(message);
    if (!this.replied && (message.mode === "ask" || message.mode === "approve")) {
      this.replied = true;
      this.dispatchInbound(this.reply);
    }

    return { delivered: true };
  }
}

class QueuedDeliveryAdapter extends FakeAdapter {
  private queuedDeliveryResolvers: Array<() => void> = [];

  override async send(message: OutboundMessage): Promise<DeliveryResult> {
    this.sentMessages.push(message);

    if (message.mode === "ask" || message.mode === "approve") {
      let resolveDelivery!: () => void;
      const whenDelivered = new Promise<void>((resolve) => {
        resolveDelivery = resolve;
      });
      this.queuedDeliveryResolvers.push(resolveDelivery);
      return {
        delivered: false,
        queuePosition: this.queuedDeliveryResolvers.length,
        whenDelivered,
      };
    }

    return { delivered: true };
  }

  markNextPromptDelivered(): void {
    const resolveDelivery = this.queuedDeliveryResolvers.shift();
    resolveDelivery?.();
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

class ToolRecordingProvider implements LLMProvider {
  toolNames: string[] = [];

  async *stream(
    _messages: InternalMessage[],
    tools: ToolDeclaration[],
    _config: ModelConfig,
  ): AsyncIterable<StreamChunk> {
    this.toolNames = tools.map((tool) => tool.name);
    yield { type: "text", content: "Recorded tools." };
    yield { type: "done" };
  }
}

class RegisterThenCheckFreshnessProvider implements LLMProvider {
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
        toolCall: { id: "call-1", name: "spec.register", arguments: "" },
      };
      yield {
        type: "tool_call_end",
        toolCall: {
          id: "call-1",
          name: "spec.register",
          arguments: JSON.stringify({ spec: buildMockBearerToolSpec("https://example.test") }),
        },
      };
      yield { type: "done" };
      return;
    }

    yield { type: "text", content: "Freshness note observed." };
    yield { type: "done" };
  }
}

class RegisterTwiceThenCheckFreshnessProvider implements LLMProvider {
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
        toolCall: { id: "call-1", name: "spec.register", arguments: "" },
      };
      yield {
        type: "tool_call_end",
        toolCall: {
          id: "call-1",
          name: "spec.register",
          arguments: JSON.stringify({ spec: buildMockBearerToolSpec("https://example.test") }),
        },
      };
      yield {
        type: "tool_call_start",
        toolCall: { id: "call-2", name: "spec.register", arguments: "" },
      };
      yield {
        type: "tool_call_end",
        toolCall: {
          id: "call-2",
          name: "spec.register",
          arguments: JSON.stringify({ spec: buildMockOAuthToolSpec("https://oauth.example.test") }),
        },
      };
      yield { type: "done" };
      return;
    }

    yield { type: "text", content: "Single freshness note observed." };
    yield { type: "done" };
  }
}

class OAuthToolThenTextProvider implements LLMProvider {
  callCount = 0;

  async *stream(
    messages: InternalMessage[],
    _tools: ToolDeclaration[],
    _config: ModelConfig,
  ): AsyncIterable<StreamChunk> {
    this.callCount += 1;

    if (this.callCount === 1) {
      yield {
        type: "tool_call_start",
        toolCall: { id: "call-1", name: "oauthmock.profile.get", arguments: "" },
      };
      yield {
        type: "tool_call_end",
        toolCall: { id: "call-1", name: "oauthmock.profile.get", arguments: "{}" },
      };
      yield { type: "done" };
      return;
    }

    const latestToolResult = [...messages].reverse().find((message) => message.role === "tool_result");
    expect(latestToolResult?.content).toContain('"success":true');

    yield { type: "text", content: "Authorized fetch complete." };
    yield { type: "done" };
  }
}

class MutationThenTextProvider implements LLMProvider {
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
        toolCall: { id: "call-1", name: "mockmail.messages.send", arguments: "" },
      };
      yield {
        type: "tool_call_end",
        toolCall: { id: "call-1", name: "mockmail.messages.send", arguments: '{"subject":"Hello","body":"World"}' },
      };
      yield { type: "done" };
      return;
    }

    yield { type: "text", content: "Sent after approval." };
    yield { type: "done" };
  }
}

class InteractApproveThenMutationProvider implements LLMProvider {
  callCount = 0;

  async *stream(
    messages: InternalMessage[],
    _tools: ToolDeclaration[],
    _config: ModelConfig,
  ): AsyncIterable<StreamChunk> {
    this.callCount += 1;

    if (this.callCount === 1) {
      yield {
        type: "tool_call_start",
        toolCall: { id: "call-1", name: "interact", arguments: "" },
      };
      yield {
        type: "tool_call_end",
        toolCall: {
          id: "call-1",
          name: "interact",
          arguments: '{"mode":"approve","message":"Send the drafted message? Reply yes or no.","tool":"mockmail","operation":"messages.send"}',
        },
      };
      yield { type: "done" };
      return;
    }

    if (this.callCount === 2) {
      const latestToolResult = [...messages].reverse().find((message) => message.role === "tool_result");
      expect(latestToolResult?.content).toContain('"approved":true');
      yield {
        type: "tool_call_start",
        toolCall: { id: "call-2", name: "mockmail.messages.send", arguments: "" },
      };
      yield {
        type: "tool_call_end",
        toolCall: { id: "call-2", name: "mockmail.messages.send", arguments: '{"subject":"Hello","body":"World"}' },
      };
      yield { type: "done" };
      return;
    }

    yield { type: "text", content: "Sent with cached approval." };
    yield { type: "done" };
  }
}

class InteractAskThenTextProvider implements LLMProvider {
  callCount = 0;

  async *stream(
    messages: InternalMessage[],
    _tools: ToolDeclaration[],
    _config: ModelConfig,
  ): AsyncIterable<StreamChunk> {
    this.callCount += 1;

    if (this.callCount === 1) {
      yield {
        type: "tool_call_start",
        toolCall: { id: "call-1", name: "interact", arguments: "" },
      };
      yield {
        type: "tool_call_end",
        toolCall: {
          id: "call-1",
          name: "interact",
          arguments: '{"mode":"ask","message":"Need input now."}',
        },
      };
      yield { type: "done" };
      return;
    }

    const latestToolResult = [...messages].reverse().find((message) => message.role === "tool_result");
    expect(latestToolResult?.content).toContain('"response":"instant reply"');

    yield { type: "text", content: "Prompt round-trip complete." };
    yield { type: "done" };
  }
}

class CorrelatedAskThenTextProvider implements LLMProvider {
  callCount = 0;

  async *stream(
    messages: InternalMessage[],
    _tools: ToolDeclaration[],
    _config: ModelConfig,
  ): AsyncIterable<StreamChunk> {
    this.callCount += 1;

    if (this.callCount === 1) {
      yield {
        type: "tool_call_start",
        toolCall: { id: "call-1", name: "interact", arguments: "" },
      };
      yield {
        type: "tool_call_end",
        toolCall: {
          id: "call-1",
          name: "interact",
          arguments: '{"mode":"ask","message":"Need the correlated reply."}',
        },
      };
      yield { type: "done" };
      return;
    }

    if (this.callCount === 2) {
      const latestToolResult = [...messages].reverse().find((message) => message.role === "tool_result");
      expect(latestToolResult?.content).toContain('"response":"correct reply"');
      yield { type: "text", content: "Prompt used the matching reply." };
      yield { type: "done" };
      return;
    }

    const latestUserMessage = [...messages].reverse().find((message) => message.role === "user");
    expect(latestUserMessage?.content).toBe("wrong reply");
    yield { type: "text", content: "Handled unmatched inbound message." };
    yield { type: "done" };
  }
}

class DeliveryAwareTriggeredAskProvider implements LLMProvider {
  callCount = 0;

  async *stream(
    messages: InternalMessage[],
    _tools: ToolDeclaration[],
    _config: ModelConfig,
  ): AsyncIterable<StreamChunk> {
    this.callCount += 1;

    if (this.callCount === 1) {
      yield {
        type: "tool_call_start",
        toolCall: { id: "call-1", name: "interact", arguments: "" },
      };
      yield {
        type: "tool_call_end",
        toolCall: {
          id: "call-1",
          name: "interact",
          arguments: '{"mode":"ask","message":"Reply after delivery."}',
        },
      };
      yield { type: "done" };
      return;
    }

    const latestToolResult = [...messages].reverse().find((message) => message.role === "tool_result");
    expect(latestToolResult?.content).toContain('"response":"delivered reply"');
    expect(latestToolResult?.content).not.toContain('"timedOut":true');

    yield { type: "text", content: "Prompt waited for delivery." };
    yield { type: "done" };
  }
}

class InteractAmbiguousApproveProvider implements LLMProvider {
  callCount = 0;

  async *stream(
    messages: InternalMessage[],
    _tools: ToolDeclaration[],
    _config: ModelConfig,
  ): AsyncIterable<StreamChunk> {
    this.callCount += 1;

    if (this.callCount === 1) {
      yield {
        type: "tool_call_start",
        toolCall: { id: "call-1", name: "interact", arguments: "" },
      };
      yield {
        type: "tool_call_end",
        toolCall: {
          id: "call-1",
          name: "interact",
          arguments: '{"mode":"approve","message":"Proceed with the operation?"}',
        },
      };
      yield { type: "done" };
      return;
    }

    const latestToolResult = [...messages].reverse().find((message) => message.role === "tool_result");
    expect(latestToolResult?.content).toContain('"approved":null');
    expect(latestToolResult?.content).toContain('"response":"maybe"');
    expect(latestToolResult?.content).toContain("Unrecognized approval response");

    yield { type: "text", content: "Ambiguous approval surfaced." };
    yield { type: "done" };
  }
}

class TriggeredMemoryProvider implements LLMProvider {
  callCount = 0;
  systemPrompts: string[] = [];

  async *stream(
    messages: InternalMessage[],
    _tools: ToolDeclaration[],
    _config: ModelConfig,
  ): AsyncIterable<StreamChunk> {
    this.callCount += 1;
    this.systemPrompts.push(messages[0]?.content ?? "");

    if (this.callCount === 1) {
      yield {
        type: "tool_call_start",
        toolCall: { id: "call-1", name: "memory", arguments: "" },
      };
      yield {
        type: "tool_call_end",
        toolCall: {
          id: "call-1",
          name: "memory",
          arguments: '{"operation":"set","domain":"schedules","key":"last-run","value":"done"}',
        },
      };
      yield { type: "done" };
      return;
    }

    const latestToolResult = [...messages].reverse().find((message) => message.role === "tool_result");
    expect(latestToolResult?.content).toContain('"success":true');

    yield { type: "text", content: "Triggered run complete." };
    yield { type: "done" };
  }
}

class TriggeredAskTimeoutProvider implements LLMProvider {
  callCount = 0;

  async *stream(
    messages: InternalMessage[],
    _tools: ToolDeclaration[],
    _config: ModelConfig,
  ): AsyncIterable<StreamChunk> {
    this.callCount += 1;

    if (this.callCount === 1) {
      yield {
        type: "tool_call_start",
        toolCall: { id: "call-1", name: "interact", arguments: "" },
      };
      yield {
        type: "tool_call_end",
        toolCall: {
          id: "call-1",
          name: "interact",
          arguments: '{"mode":"ask","message":"Did you drink water?"}',
        },
      };
      yield { type: "done" };
      return;
    }

    const latestToolResult = [...messages].reverse().find((message) => message.role === "tool_result");
    expect(latestToolResult?.content).toContain('"timedOut":true');
    expect(latestToolResult?.content).toContain('"response":null');

    yield { type: "text", content: "Handled timeout." };
    yield { type: "done" };
  }
}

class ConcurrentTriggeredAskProvider implements LLMProvider {
  async *stream(
    messages: InternalMessage[],
    _tools: ToolDeclaration[],
    _config: ModelConfig,
  ): AsyncIterable<StreamChunk> {
    const scheduleId = extractScheduleId(messages[0]?.content ?? "");
    const latestToolResult = [...messages].reverse().find((message) => message.role === "tool_result");

    if (!latestToolResult) {
      yield {
        type: "tool_call_start",
        toolCall: { id: `ask-${scheduleId}`, name: "interact", arguments: "" },
      };
      yield {
        type: "tool_call_end",
        toolCall: {
          id: `ask-${scheduleId}`,
          name: "interact",
          arguments: JSON.stringify({
            mode: "ask",
            message: `Reply for ${scheduleId}.`,
          }),
        },
      };
      yield { type: "done" };
      return;
    }

    expect(latestToolResult.content).toContain('"success":true');
    expect(latestToolResult.content).toContain('"response":"');

    yield { type: "text", content: `Completed ${scheduleId}.` };
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
      primitiveDispatcher: new PrimitiveDispatcher({
        workspaceDir: join(tmpdir(), `agent-runtime-missing-${crypto.randomUUID()}`),
      }),
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
    expect(session?.messages[3]?.content).toContain('"success":false');
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
      primitiveDispatcher: new PrimitiveDispatcher({
        workspaceDir: join(tmpdir(), `agent-runtime-missing-${crypto.randomUUID()}`),
      }),
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
      primitiveDispatcher: new PrimitiveDispatcher({
        workspaceDir: join(tmpdir(), `agent-runtime-missing-${crypto.randomUUID()}`),
      }),
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

  test("passes dispatcher-generated tool declarations to the provider", async () => {
    const adapter = new FakeAdapter();
    const provider = new ToolRecordingProvider();
    const dispatcher = new PrimitiveDispatcher({
      workspaceDir: join(tmpdir(), `agent-runtime-tools-${crypto.randomUUID()}`),
      seedTrustedSpecs: false,
    });
    await dispatcher.dispatch(
      "spec.register",
      {
        spec: buildMockBearerToolSpec("https://example.test"),
      },
      { sessionId: "seed-session" },
    );

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
      primitiveDispatcher: dispatcher,
    });

    runtime.start();
    adapter.dispatchInbound("hello");

    expect(await runtime.waitForIdle(1000)).toBe(true);
    expect(provider.toolNames).toContain("spec.list");
    expect(provider.toolNames).toContain("mockapi.items.list");
  });

  test("injects a freshness note after successful spec.register before the next model turn", async () => {
    const adapter = new FakeAdapter();
    const provider = new RegisterThenCheckFreshnessProvider();
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
      primitiveDispatcher: new PrimitiveDispatcher({
        workspaceDir: join(tmpdir(), `agent-runtime-register-note-${crypto.randomUUID()}`),
        seedTrustedSpecs: false,
      }),
    });

    runtime.start();
    adapter.dispatchInbound("install the tool");

    expect(await runtime.waitForIdle(1000)).toBe(true);
    expect(provider.callCount).toBe(2);

    const secondTurnMessages = provider.messageSnapshots[1] ?? [];
    const toolResultIndex = secondTurnMessages.findIndex((message) => message.role === "tool_result" && message.toolResultId === "call-1");
    const freshnessNoteIndex = secondTurnMessages.findIndex((message) => message.role === "system" && message.content.includes("Installed-tool guidance may now be stale after spec.register succeeded."));

    expect(toolResultIndex).toBeGreaterThanOrEqual(0);
    expect(freshnessNoteIndex).toBe(toolResultIndex + 1);
    expect(secondTurnMessages[freshnessNoteIndex]?.content).toContain("Use spec.list to refresh the current manifest");

    const session = sessionManager.getInteractiveSession();
    expect(session?.messages[toolResultIndex + 1]).toMatchObject({
      role: "system",
      content: expect.stringContaining("Installed-tool guidance may now be stale after spec.register succeeded."),
    });
  });

  test("appends the freshness note at most once when multiple spec.register calls succeed in one assistant turn", async () => {
    const adapter = new FakeAdapter();
    const provider = new RegisterTwiceThenCheckFreshnessProvider();
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
      primitiveDispatcher: new PrimitiveDispatcher({
        workspaceDir: join(tmpdir(), `agent-runtime-register-note-${crypto.randomUUID()}`),
        seedTrustedSpecs: false,
      }),
    });

    runtime.start();
    adapter.dispatchInbound("install both tools");

    expect(await runtime.waitForIdle(1000)).toBe(true);
    expect(provider.callCount).toBe(2);

    const secondTurnMessages = provider.messageSnapshots[1] ?? [];
    const freshnessNotes = secondTurnMessages.filter(
      (message) => message.role === "system" && message.content.includes("Installed-tool guidance may now be stale after spec.register succeeded."),
    );

    expect(freshnessNotes).toHaveLength(1);
  });

  test("uses the adapter to collect an OAuth authorization code and resumes the active session", async () => {
    let tokenRequests = 0;
    let profileRequests = 0;
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/oauth/token") {
          tokenRequests += 1;
          const body = await request.formData();
          expect(body.get("grant_type")).toBe("authorization_code");
          expect(body.get("code")).toBe("code-123");

          return Response.json({
            access_token: "fresh-token",
            refresh_token: "refresh-456",
            expires_in: 3600,
            token_type: "Bearer",
          });
        }

        if (pathname === "/profile") {
          profileRequests += 1;
          expect(request.headers.get("Authorization")).toBe("Bearer fresh-token");
          return Response.json({ id: "user-1", name: "Taylor", ignored: true });
        }

        return new Response("missing", { status: 404 });
      },
    });
    servers.push(server);

    const rootDir = await mkdtemp(join(tmpdir(), "agent-runtime-oauth-"));
    tempDirs.push(rootDir);

    const agentHome = join(rootDir, ".agent");
    const workspaceDir = join(rootDir, "workspace");
    await mkdir(agentHome, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const dispatcher = new PrimitiveDispatcher({
      agentHome,
      workspaceDir,
      env: {
        MOCK_CLIENT_ID: "client-id",
        MOCK_CLIENT_SECRET: "client-secret",
      },
      seedTrustedSpecs: false,
    });
    const registerResult = await dispatcher.dispatch(
      "spec.register",
      {
        spec: buildMockOAuthToolSpec(`http://127.0.0.1:${server.port}`),
      },
      { sessionId: "seed-session" },
    );
    expect(registerResult.success).toBe(true);

    const adapter = new FakeAdapter();
    const provider = new OAuthToolThenTextProvider();
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
      primitiveDispatcher: dispatcher,
    });

    runtime.start();
    adapter.dispatchInbound("fetch my profile");

    await waitForCondition(
      () => adapter.sentMessages.some((message) => message.mode === "ask"),
      1000,
      "Timed out waiting for the OAuth prompt",
    );

    expect(adapter.sentMessages).toContainEqual(expect.objectContaining({
      mode: "ask",
      content: expect.stringContaining("Authorization is required for OAuth Mock."),
    }));

    adapter.dispatchInbound("code-123");

    expect(await runtime.waitForIdle(1000)).toBe(true);
    expect(provider.callCount).toBe(2);
    expect(tokenRequests).toBe(1);
    expect(profileRequests).toBe(1);

    const session = sessionManager.getInteractiveSession();
    expect(session?.messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual([
      "fetch my profile",
    ]);
    expect(session?.messages[3]?.content).toContain('"success":true');
    expect(adapter.streamChunks).toEqual([
      { sessionId: sessionManager.getInteractiveSession()!.id, content: "Authorized fetch complete." },
    ]);

    const storedToken = await dispatcher.dispatch(
      "memory",
      {
        operation: "get",
        domain: "oauthmock",
        key: "oauth:oauthmock:tokens",
      },
      { sessionId: "session-check" },
    );
    expect(storedToken).toMatchObject({
      success: true,
      data: {
        entry: {
          value: expect.stringContaining("fresh-token"),
        },
      },
    });
  });

  test("captures prompt replies that arrive during adapter.send", async () => {
    const adapter = new PromptReplyingAdapter("instant reply");
    const provider = new InteractAskThenTextProvider();
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
      primitiveDispatcher: new PrimitiveDispatcher({
        workspaceDir: join(tmpdir(), `agent-runtime-prompt-${crypto.randomUUID()}`),
      }),
    });

    runtime.start();

    try {
      adapter.dispatchInbound("start");

      expect(await runtime.waitForIdle(1000)).toBe(true);
      expect(provider.callCount).toBe(2);
      expect(adapter.sentMessages).toContainEqual(expect.objectContaining({
        mode: "ask",
        content: "Need input now.",
        promptId: expect.any(String),
      }));

      const session = sessionManager.getInteractiveSession();
      expect(session?.messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual([
        "start",
      ]);
      expect(adapter.streamChunks).toEqual([
        { sessionId: sessionManager.getInteractiveSession()!.id, content: "Prompt round-trip complete." },
      ]);
    } finally {
      await runtime.shutdown(1000);
    }
  });

  test("only consumes replies that match the active prompt id and routes unmatched inbound messages normally", async () => {
    const adapter = new FakeAdapter();
    const provider = new CorrelatedAskThenTextProvider();
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
      primitiveDispatcher: new PrimitiveDispatcher({
        workspaceDir: join(tmpdir(), `agent-runtime-correlated-${crypto.randomUUID()}`),
      }),
    });

    runtime.start();

    try {
      adapter.dispatchInbound("start");

      await waitForCondition(
        () => adapter.sentMessages.some((message) => message.mode === "ask" && typeof message.promptId === "string"),
        1000,
        "Timed out waiting for the correlated ask prompt",
      );

      const promptMessage = adapter.sentMessages.find((message) => message.mode === "ask");
      expect(promptMessage?.promptId).toEqual(expect.any(String));

      adapter.dispatchInbound("wrong reply", new Date(), "different-prompt-id");

      adapter.dispatchInbound("correct reply", new Date(), promptMessage?.promptId);

      expect(await runtime.waitForIdle(1000)).toBe(true);
      expect(provider.callCount).toBe(3);
      expect(adapter.streamChunks).toEqual([
        { sessionId: sessionManager.getInteractiveSession()!.id, content: "Prompt used the matching reply." },
        { sessionId: sessionManager.getInteractiveSession()!.id, content: "Handled unmatched inbound message." },
      ]);

      const session = sessionManager.getInteractiveSession();
      expect(session?.messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual([
        "start",
        "wrong reply",
      ]);
    } finally {
      await runtime.shutdown(1000);
    }
  });

  test("sends a runtime approval prompt before a policy-gated HTTP mutation", async () => {
    let postRequests = 0;
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/messages") {
          postRequests += 1;
          expect(request.method).toBe("POST");
          return Response.json({ id: "msg-1", ignored: true });
        }

        return new Response("missing", { status: 404 });
      },
    });
    servers.push(server);

    const rootDir = await mkdtemp(join(tmpdir(), "agent-runtime-policy-approve-"));
    tempDirs.push(rootDir);

    const homeDir = join(rootDir, "home");
    const agentHome = join(homeDir, ".agent");
    const workspaceDir = join(rootDir, "workspace");
    await mkdir(agentHome, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await writePolicy(homeDir, `rules:\n  - primitive: http\n    match: { method: [POST] }\n    action: approve\n    model_approval_sufficient: false\n  - primitive: http\n    action: allow\n  - primitive: file_write\n    match: { path: "~/.agent/workspace/**" }\n    action: allow\n  - primitive: file_write\n    action: block\n  - primitive: file_read\n    action: allow\n`);

    const dispatcher = new PrimitiveDispatcher({
      agentHome,
      workspaceDir,
      seedTrustedSpecs: false,
    });
    const registerResult = await dispatcher.dispatch(
      "spec.register",
      {
        spec: buildMockMutationToolSpec(`http://127.0.0.1:${server.port}`),
      },
      { sessionId: "seed-session" },
    );
    expect(registerResult.success).toBe(true);

    const adapter = new FakeAdapter();
    const provider = new MutationThenTextProvider();
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
      sessionManager: new SessionManager({
        buildSystemPrompt: () => "system prompt",
      }),
      primitiveDispatcher: dispatcher,
    });

    runtime.start();
    adapter.dispatchInbound("send the message");

    await waitForCondition(
      () => adapter.sentMessages.some((message) => message.mode === "approve"),
      1000,
      "Timed out waiting for the policy approval prompt",
    );

    expect(adapter.sentMessages).toContainEqual(expect.objectContaining({
      mode: "approve",
      content: expect.stringMatching(/mockmail\.messages\.send.*Reply exactly yes or no only\./),
      promptId: expect.any(String),
    }));

    adapter.dispatchInbound("yes");

    expect(await runtime.waitForIdle(1000)).toBe(true);
    expect(provider.callCount).toBe(2);
    expect(postRequests).toBe(1);
  });

  test("reuses interact approval receipts for matching policy-gated mutations", async () => {
    let postRequests = 0;
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/messages") {
          postRequests += 1;
          expect(request.method).toBe("POST");
          return Response.json({ id: "msg-2", ignored: true });
        }

        return new Response("missing", { status: 404 });
      },
    });
    servers.push(server);

    const rootDir = await mkdtemp(join(tmpdir(), "agent-runtime-policy-receipt-"));
    tempDirs.push(rootDir);

    const homeDir = join(rootDir, "home");
    const agentHome = join(homeDir, ".agent");
    const workspaceDir = join(rootDir, "workspace");
    await mkdir(agentHome, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await writePolicy(homeDir, `rules:\n  - primitive: http\n    match: { method: [POST] }\n    action: approve\n    model_approval_sufficient: true\n  - primitive: http\n    action: allow\n  - primitive: file_write\n    match: { path: "~/.agent/workspace/**" }\n    action: allow\n  - primitive: file_write\n    action: block\n  - primitive: file_read\n    action: allow\n`);

    const dispatcher = new PrimitiveDispatcher({
      agentHome,
      workspaceDir,
      seedTrustedSpecs: false,
    });
    const registerResult = await dispatcher.dispatch(
      "spec.register",
      {
        spec: buildMockMutationToolSpec(`http://127.0.0.1:${server.port}`),
      },
      { sessionId: "seed-session" },
    );
    expect(registerResult.success).toBe(true);

    const adapter = new FakeAdapter();
    const provider = new InteractApproveThenMutationProvider();
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
      sessionManager: new SessionManager({
        buildSystemPrompt: () => "system prompt",
      }),
      primitiveDispatcher: dispatcher,
    });

    runtime.start();
    adapter.dispatchInbound("send the drafted message");

    await waitForCondition(
      () => adapter.sentMessages.some((message) => message.mode === "approve"),
      1000,
      "Timed out waiting for the interact approval prompt",
    );

    adapter.dispatchInbound("yes");

    expect(await runtime.waitForIdle(1000)).toBe(true);
    expect(provider.callCount).toBe(3);
    expect(postRequests).toBe(1);
    expect(adapter.sentMessages.filter((message) => message.mode === "approve")).toHaveLength(1);
  });

  test("does not burn prompt timeout while delivery is queued", async () => {
    const adapter = new QueuedDeliveryAdapter();
    const provider = new DeliveryAwareTriggeredAskProvider();
    const sessionManager = new SessionManager({
      buildSystemPrompt: ({ now, triggeredSchedule }) => buildTriggeredSystemPrompt(now, triggeredSchedule),
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
      primitiveDispatcher: new PrimitiveDispatcher({
        workspaceDir: join(tmpdir(), `agent-runtime-delivery-aware-${crypto.randomUUID()}`),
      }),
      scheduledUserResponseTimeoutMs: 30,
    });

    runtime.start();

    try {
      const run = runtime.launchTriggeredSchedule({
        schedule_id: "schedule-delivery-aware",
        workflow: "hydration",
        group: null,
        trigger: { type: "once", at: "2026-03-21T10:05:00.000Z" },
        context: { instruction: "Ask after delivery." },
        instruction: "Ask after delivery.",
      });

      await waitForCondition(
        () => adapter.sentMessages.some((message) => message.mode === "ask"),
        1000,
        "Timed out waiting for the queued ask prompt",
      );

      await Bun.sleep(60);
      adapter.markNextPromptDelivered();

      const promptMessage = adapter.sentMessages.find((message) => message.mode === "ask");
      expect(promptMessage?.promptId).toEqual(expect.any(String));

      adapter.dispatchInbound("delivered reply", new Date(), promptMessage?.promptId);

      expect(await run).toBe(true);
      expect(await runtime.waitForIdle(1000)).toBe(true);
      expect(provider.callCount).toBe(2);
      expect(adapter.streamChunks).toEqual([
        expect.objectContaining({ content: "Prompt waited for delivery." }),
      ]);
    } finally {
      await runtime.shutdown(1000);
    }
  });

  test("runs triggered sessions with full primitive access and schedule context", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "agent-runtime-triggered-"));
    tempDirs.push(rootDir);

    const agentHome = join(rootDir, ".agent");
    const workspaceDir = join(rootDir, "workspace");
    await mkdir(agentHome, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const adapter = new FakeAdapter();
    const provider = new TriggeredMemoryProvider();
    const dispatcher = new PrimitiveDispatcher({
      agentHome,
      workspaceDir,
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
      sessionManager: new SessionManager({
        buildSystemPrompt: ({ now, triggeredSchedule }) => buildTriggeredSystemPrompt(now, triggeredSchedule),
      }),
      primitiveDispatcher: dispatcher,
    });

    runtime.start();

    try {
      const success = await runtime.launchTriggeredSchedule({
        schedule_id: "schedule-1",
        workflow: "hydration",
        group: "wellness",
        trigger: { type: "once", at: "2026-03-21T10:05:00.000Z" },
        context: { instruction: "Remind the user to drink water." },
        instruction: "Remind the user to drink water.",
      });

      expect(success).toBe(true);
      expect(provider.callCount).toBe(2);
      expect(provider.systemPrompts[0]).toContain("schedule_id: schedule-1");
      expect(provider.systemPrompts[0]).toContain("instruction: Remind the user to drink water.");
      expect(adapter.streamChunks).toEqual([
        expect.objectContaining({ content: "Triggered run complete." }),
      ]);

      const memoryEntry = await dispatcher.dispatch(
        "memory",
        {
          operation: "get",
          domain: "schedules",
          key: "last-run",
        },
        { sessionId: "session-check" },
      );

      expect(memoryEntry).toMatchObject({
        success: true,
        data: {
          entry: {
            value: "done",
          },
        },
      });
      expect(await runtime.waitForIdle(1000)).toBe(true);
    } finally {
      await runtime.shutdown(1000);
    }
  });

  test("returns a timeout result for triggered interact prompts", async () => {
    const adapter = new FakeAdapter();
    const provider = new TriggeredAskTimeoutProvider();
    const sessionManager = new SessionManager({
      buildSystemPrompt: ({ now, triggeredSchedule }) => buildTriggeredSystemPrompt(now, triggeredSchedule),
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
      primitiveDispatcher: new PrimitiveDispatcher({
        workspaceDir: join(tmpdir(), `agent-runtime-trigger-timeout-${crypto.randomUUID()}`),
      }),
      scheduledUserResponseTimeoutMs: 20,
    });

    runtime.start();

    try {
      const success = await runtime.launchTriggeredSchedule({
        schedule_id: "schedule-timeout",
        workflow: "hydration",
        group: null,
        trigger: { type: "once", at: "2026-03-21T10:05:00.000Z" },
        context: { instruction: "Ask whether the user drank water." },
        instruction: "Ask whether the user drank water.",
      });

      expect(success).toBe(true);
      expect(provider.callCount).toBe(2);
      expect(adapter.sentMessages).toContainEqual(expect.objectContaining({
        mode: "ask",
        content: "Did you drink water?",
        promptId: expect.any(String),
      }));
      expect(adapter.streamChunks).toEqual([
        expect.objectContaining({ content: "Handled timeout." }),
      ]);
      expect(await runtime.waitForIdle(1000)).toBe(true);
    } finally {
      await runtime.shutdown(1000);
    }
  });

  test("surfaces ambiguous approval responses instead of treating them as denials", async () => {
    const adapter = new FakeAdapter();
    const provider = new InteractAmbiguousApproveProvider();
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
      primitiveDispatcher: new PrimitiveDispatcher({
        workspaceDir: join(tmpdir(), `agent-runtime-ambiguous-approve-${crypto.randomUUID()}`),
      }),
    });

    runtime.start();

    try {
      adapter.dispatchInbound("start");

      await waitForCondition(
        () => adapter.sentMessages.some((message) => message.mode === "approve"),
        1000,
        "Timed out waiting for the approval prompt",
      );

      const promptMessage = adapter.sentMessages.find((message) => message.mode === "approve");
      expect(promptMessage?.content).toContain("Reply exactly yes or no.");

      adapter.dispatchInbound("maybe", new Date(), promptMessage?.promptId);

      expect(await runtime.waitForIdle(1000)).toBe(true);
      expect(provider.callCount).toBe(2);
      expect(adapter.streamChunks).toEqual([
        expect.objectContaining({ content: "Ambiguous approval surfaced." }),
      ]);
    } finally {
      await runtime.shutdown(1000);
    }
  });

  test("serializes overlapping triggered prompts instead of failing the second session", async () => {
    const adapter = new FakeAdapter();
    const provider = new ConcurrentTriggeredAskProvider();
    const sessionManager = new SessionManager({
      buildSystemPrompt: ({ now, triggeredSchedule }) => buildTriggeredSystemPrompt(now, triggeredSchedule),
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
      primitiveDispatcher: new PrimitiveDispatcher({
        workspaceDir: join(tmpdir(), `agent-runtime-trigger-queue-${crypto.randomUUID()}`),
      }),
    });

    runtime.start();

    try {
      const firstRun = runtime.launchTriggeredSchedule({
        schedule_id: "schedule-1",
        workflow: "hydration",
        group: null,
        trigger: { type: "once", at: "2026-03-21T10:05:00.000Z" },
        context: { instruction: "Prompt for the first schedule." },
        instruction: "Prompt for the first schedule.",
      });
      const secondRun = runtime.launchTriggeredSchedule({
        schedule_id: "schedule-2",
        workflow: "hydration",
        group: null,
        trigger: { type: "once", at: "2026-03-21T10:06:00.000Z" },
        context: { instruction: "Prompt for the second schedule." },
        instruction: "Prompt for the second schedule.",
      });

      await waitForCondition(
        () => adapter.sentMessages.filter((message) => message.mode === "ask").length === 1,
        1000,
        "Timed out waiting for the first triggered prompt",
      );

      expect(adapter.sentMessages.filter((message) => message.mode === "ask")).toEqual([
        expect.objectContaining({
          mode: "ask",
          content: "Reply for schedule-1.",
        }),
      ]);

      adapter.dispatchInbound("first reply");

      await waitForCondition(
        () => adapter.sentMessages.filter((message) => message.mode === "ask").length === 2,
        1000,
        "Timed out waiting for the queued triggered prompt",
      );

      expect(adapter.sentMessages.filter((message) => message.mode === "ask")).toEqual([
        expect.objectContaining({
          mode: "ask",
          content: "Reply for schedule-1.",
        }),
        expect.objectContaining({
          mode: "ask",
          content: "Reply for schedule-2.",
        }),
      ]);

      adapter.dispatchInbound("second reply");

      expect(await firstRun).toBe(true);
      expect(await secondRun).toBe(true);
      expect(await runtime.waitForIdle(1000)).toBe(true);
      expect(adapter.streamChunks).toEqual([
        expect.objectContaining({ content: "Completed schedule-1." }),
        expect.objectContaining({ content: "Completed schedule-2." }),
      ]);
      expect(adapter.sentMessages.some((message) => message.content.includes("Another user prompt is already waiting for a response."))).toBe(false);
    } finally {
      await runtime.shutdown(1000);
    }
  });
});

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

async function writePolicy(homeDir: string, content: string): Promise<void> {
  const policyDir = join(homeDir, ".agent-policy");
  await mkdir(policyDir, { recursive: true });
  await Bun.write(join(policyDir, "policy.yaml"), content);
}

function buildTriggeredSystemPrompt(now: Date, triggeredSchedule: { schedule_id: string; instruction: string } | undefined): string {
  return [
    `Current time: ${now.toISOString()}`,
    triggeredSchedule ? `schedule_id: ${triggeredSchedule.schedule_id}` : null,
    triggeredSchedule ? `instruction: ${triggeredSchedule.instruction}` : null,
  ].filter(Boolean).join("\n");
}

function extractScheduleId(systemPrompt: string): string {
  return systemPrompt.match(/schedule_id: (.+)/)?.[1] ?? "unknown";
}
