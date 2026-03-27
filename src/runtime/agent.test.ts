import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommunicationAdapter, DeliveryResult, InboundMessage, OutboundMessage } from "../communication/adapter.ts";
import {
  buildCompactedMessageHistory,
  buildCompactionRequestMessages,
  buildCompactionSummaryMessage,
  COMPACTION_TRIGGER_UTILIZATION,
  estimateMessagesTokens,
  estimateToolDeclarationsTokens,
  HARD_CEILING_UTILIZATION,
  planHistoryCompaction,
} from "../context/budget.ts";
import { LLMProviderUnavailableError, type LLMProvider } from "../llm/provider.ts";
import type { InternalMessage, ModelConfig, StreamChunk, ToolDeclaration } from "../llm/types.ts";
import { Logger } from "../observability/logger.ts";
import { PrimitiveDispatcher } from "../primitives/dispatcher.ts";
import type { PrimitiveContext, PrimitiveResult } from "../primitives/types.ts";
import type { TriggeredScheduleContext } from "../scheduler/types.ts";
import { AgentSession } from "../session/session.ts";
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

class TriggeredNotifyOnlyProvider implements LLMProvider {
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
          arguments: '{"mode":"notify","message":"Drink water now."}',
        },
      };
      yield { type: "done" };
      return;
    }

    const latestToolResult = [...messages].reverse().find((message) => message.role === "tool_result");
    expect(latestToolResult?.content).toContain('"success":true');

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

class CompactionAwareProvider implements LLMProvider {
  summaryCallCount = 0;
  normalCallCount = 0;
  summaryCallTools: ToolDeclaration[][] = [];

  constructor(
    private readonly summaryText: string,
    private readonly normalText: string,
  ) {}

  async *stream(
    _messages: InternalMessage[],
    tools: ToolDeclaration[],
    _config: ModelConfig,
  ): AsyncIterable<StreamChunk> {
    if (tools.length === 0) {
      this.summaryCallCount += 1;
      this.summaryCallTools.push(tools);
      yield { type: "text", content: this.summaryText };
      yield { type: "done" };
      return;
    }

    this.normalCallCount += 1;
    yield { type: "text", content: this.normalText };
    yield { type: "done" };
  }
}

class UnavailableProvider implements LLMProvider {
  async *stream(
    _messages: InternalMessage[],
    _tools: ToolDeclaration[],
    _config: ModelConfig,
  ): AsyncIterable<StreamChunk> {
    throw new LLMProviderUnavailableError("Provider offline.");
  }
}

class SeededTriggeredSessionManager extends SessionManager {
  constructor(
    private readonly seedMessages: InternalMessage[],
    options: ConstructorParameters<typeof SessionManager>[0],
  ) {
    super(options);
  }

  override async createTriggeredSession(triggeredSchedule: TriggeredScheduleContext, now = new Date()): Promise<AgentSession> {
    const session = await super.createTriggeredSession(triggeredSchedule, now);
    seedSession(session, this.seedMessages);
    return session;
  }
}

class RecordingFailureSessionManager extends SessionManager {
  failedSessions: AgentSession[] = [];

  override failSession(sessionId: string, at = new Date()): void {
    const session = this.getSession(sessionId);
    if (session) {
      this.failedSessions.push(session);
    }

    super.failSession(sessionId, at);
  }
}

class FailingSummaryMemoryDispatcher extends PrimitiveDispatcher {
  override async dispatch(
    primitiveName: string,
    params: Record<string, unknown>,
    context: PrimitiveContext,
  ): Promise<PrimitiveResult> {
    if (
      primitiveName === "memory"
      && params.operation === "set"
      && params.domain === null
      && typeof params.key === "string"
      && params.key.startsWith("session_summary:")
    ) {
      return {
        success: false,
        error: "Injected compaction summary persistence failure.",
      };
    }

    return await super.dispatch(primitiveName, params, context);
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

  test("completes triggered notify-only sessions when the model stops after the notify tool result", async () => {
    const adapter = new FakeAdapter();
    const provider = new TriggeredNotifyOnlyProvider();
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
        workspaceDir: join(tmpdir(), `agent-runtime-trigger-notify-${crypto.randomUUID()}`),
      }),
    });

    runtime.start();

    try {
      const success = await runtime.launchTriggeredSchedule({
        schedule_id: "schedule-notify",
        workflow: "hydration",
        group: null,
        trigger: { type: "once", at: "2026-03-21T10:05:00.000Z" },
        context: { instruction: "Notify the user to drink water." },
        instruction: "Notify the user to drink water.",
      });

      expect(success).toBe(true);
      expect(provider.callCount).toBe(2);
      expect(adapter.sentMessages).toEqual([
        expect.objectContaining({
          mode: "notify",
          content: "Drink water now.",
        }),
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

  test("compacts interactive history, stores the summary in memory, and continues", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "agent-runtime-compaction-"));
    tempDirs.push(rootDir);

    const agentHome = join(rootDir, ".agent");
    const workspaceDir = join(rootDir, "workspace");
    await mkdir(agentHome, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const adapter = new FakeAdapter();
    const dispatcher = new PrimitiveDispatcher({ agentHome, workspaceDir });
    const sessionManager = new SessionManager({
      buildSystemPrompt: () => "system prompt",
    });
    const session = await sessionManager.getOrCreateInteractiveSession(new Date("2026-03-22T00:00:00.000Z"));
    seedSession(session, buildSeedMessages());

    const finalUserMessage = "latest request that should trigger compaction";
    const futureMessages = [...session.messages, { role: "user", content: finalUserMessage } satisfies InternalMessage];
    const compactionPlan = planHistoryCompaction(futureMessages);
    expect(compactionPlan).not.toBeNull();

    const summaryText = "Older repo and user context that still matters.";
    const postCompactionMessages = buildCompactedMessageHistory(
      futureMessages,
      compactionPlan!.keepStartIndex,
      buildCompactionSummaryMessage(summaryText),
    );
    const toolTokens = estimateToolDeclarationsTokens(dispatcher.getToolDeclarations());
    const preUsedTokens = estimateMessagesTokens(futureMessages) + toolTokens;
    const postUsedTokens = estimateMessagesTokens(postCompactionMessages) + toolTokens;
    const contextLimit = findContextLimit(preUsedTokens, postUsedTokens, "continue_after_compaction");

    const provider = new CompactionAwareProvider(summaryText, "Compacted reply complete.");
    const runtime = new AgentRuntime({
      adapter,
      llmProvider: provider,
      modelConfig: createModelConfig({ contextLimit }),
      sessionManager,
      primitiveDispatcher: dispatcher,
    });

    runtime.start();
    adapter.dispatchInbound(finalUserMessage);

    expect(await runtime.waitForIdle(1000)).toBe(true);
    expect(provider.summaryCallCount).toBe(1);
    expect(provider.normalCallCount).toBe(1);
    expect(provider.summaryCallTools[0]).toEqual([]);
    expect(adapter.streamChunks).toEqual([
      { sessionId: session.id, content: "Compacted reply complete." },
    ]);

    const activeSession = sessionManager.getInteractiveSession();
    expect(activeSession).not.toBeNull();
    expect(activeSession?.messages.filter((message) => message.role === "system" && message.content.includes("Runtime summary of earlier conversation"))).toHaveLength(1);
    expect(activeSession?.messages[1]?.content).toContain(summaryText);
    expect(activeSession?.messages.some((message) => message.content === "legacy user 1")).toBe(false);

    const memoryEntries = await dispatcher.dispatch(
      "memory",
      {
        operation: "list",
        domain: null,
      },
      { sessionId: "memory-check" },
    );
    expect(memoryEntries).toMatchObject({
      success: true,
      data: {
        entries: [
          {
            key: expect.stringMatching(/^session_summary:/),
            value: summaryText,
          },
        ],
      },
    });
  });

  test("continues after compaction when summary persistence fails", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "agent-runtime-compaction-persist-fail-"));
    tempDirs.push(rootDir);

    const agentHome = join(rootDir, ".agent");
    const workspaceDir = join(rootDir, "workspace");
    await mkdir(agentHome, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const adapter = new FakeAdapter();
    const dispatcher = new FailingSummaryMemoryDispatcher({ agentHome, workspaceDir });
    const sessionManager = new SessionManager({
      buildSystemPrompt: () => "system prompt",
    });
    const session = await sessionManager.getOrCreateInteractiveSession(new Date("2026-03-22T00:00:00.000Z"));
    seedSession(session, buildSeedMessages());

    const finalUserMessage = "latest request that should still continue";
    const futureMessages = [...session.messages, { role: "user", content: finalUserMessage } satisfies InternalMessage];
    const compactionPlan = planHistoryCompaction(futureMessages);
    expect(compactionPlan).not.toBeNull();

    const summaryText = "Older repo and user context that still matters.";
    const postCompactionMessages = buildCompactedMessageHistory(
      futureMessages,
      compactionPlan!.keepStartIndex,
      buildCompactionSummaryMessage(summaryText),
    );
    const toolTokens = estimateToolDeclarationsTokens(dispatcher.getToolDeclarations());
    const preUsedTokens = estimateMessagesTokens(futureMessages) + toolTokens;
    const postUsedTokens = estimateMessagesTokens(postCompactionMessages) + toolTokens;
    const contextLimit = findContextLimit(preUsedTokens, postUsedTokens, "continue_after_compaction");

    const provider = new CompactionAwareProvider(summaryText, "Compacted reply complete.");
    const runtime = new AgentRuntime({
      adapter,
      llmProvider: provider,
      modelConfig: createModelConfig({ contextLimit }),
      sessionManager,
      primitiveDispatcher: dispatcher,
    });

    runtime.start();
    adapter.dispatchInbound(finalUserMessage);

    try {
      expect(await runtime.waitForIdle(1000)).toBe(true);
      expect(provider.summaryCallCount).toBe(1);
      expect(provider.normalCallCount).toBe(1);
      expect(adapter.streamChunks).toEqual([
        { sessionId: session.id, content: "Compacted reply complete." },
      ]);
      expect(adapter.sentMessages.some((message) => message.content.startsWith("Runtime error:"))).toBe(false);

      const activeSession = sessionManager.getInteractiveSession();
      expect(activeSession).not.toBeNull();
      expect(activeSession?.messages.filter((message) => message.role === "system" && message.content.includes("Runtime summary of earlier conversation"))).toHaveLength(1);
      expect(activeSession?.messages[1]?.content).toContain(summaryText);

      const memoryEntries = await dispatcher.dispatch(
        "memory",
        {
          operation: "list",
          domain: null,
        },
        { sessionId: "memory-check" },
      );
      expect(memoryEntries).toMatchObject({
        success: true,
        data: {
          entries: [],
        },
      });
    } finally {
      await runtime.shutdown(1000);
    }
  });

  test("allows an oversized first-turn interactive session to reach the model when nothing can be compacted", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "agent-runtime-first-turn-oversized-"));
    tempDirs.push(rootDir);

    const agentHome = join(rootDir, ".agent");
    const workspaceDir = join(rootDir, "workspace");
    await mkdir(agentHome, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const adapter = new FakeAdapter();
    const dispatcher = new PrimitiveDispatcher({ agentHome, workspaceDir });
    const sessionManager = new SessionManager({
      buildSystemPrompt: () => "system prompt",
    });
    const oversizedMessage = "first turn ".repeat(800);
    const predictedSession = new AgentSession({ systemPrompt: "system prompt" });
    predictedSession.appendUserMessage(oversizedMessage);
    const contextLimit = predictedSession.getMessageTokenEstimate() + estimateToolDeclarationsTokens(dispatcher.getToolDeclarations());

    const provider = new CompactionAwareProvider("unused summary", "First turn still reached the model.");
    const runtime = new AgentRuntime({
      adapter,
      llmProvider: provider,
      modelConfig: createModelConfig({ contextLimit }),
      sessionManager,
      primitiveDispatcher: dispatcher,
    });

    runtime.start();
    adapter.dispatchInbound(oversizedMessage);

    try {
      expect(await runtime.waitForIdle(1000)).toBe(true);
      expect(provider.summaryCallCount).toBe(0);
      expect(provider.normalCallCount).toBe(1);
      expect(adapter.streamChunks).toEqual([
        { sessionId: expect.any(String), content: "First turn still reached the model." },
      ]);
      expect(adapter.sentMessages.some((message) => message.content.includes("grown too large to continue safely"))).toBe(false);

      const activeSession = sessionManager.getInteractiveSession();
      expect(activeSession).not.toBeNull();
      expect(activeSession?.messages.filter((message) => message.role === "user")).toHaveLength(1);
    } finally {
      await runtime.shutdown(1000);
    }
  });

  test("ends cleanly without crashing when the compaction request itself cannot fit", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "agent-runtime-compaction-request-too-large-"));
    tempDirs.push(rootDir);

    const agentHome = join(rootDir, ".agent");
    const workspaceDir = join(rootDir, "workspace");
    await mkdir(agentHome, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const adapter = new FakeAdapter();
    const dispatcher = new PrimitiveDispatcher({ agentHome, workspaceDir });
    const sessionManager = new SessionManager({
      buildSystemPrompt: () => "system prompt",
    });
    const session = await sessionManager.getOrCreateInteractiveSession(new Date("2026-03-22T00:00:00.000Z"));
    seedSession(session, buildLargeCompactionSeedMessages());

    const finalUserMessage = "latest request that cannot be compacted safely";
    const futureMessages = [...session.messages, { role: "user", content: finalUserMessage } satisfies InternalMessage];
    const compactionPlan = planHistoryCompaction(futureMessages);
    expect(compactionPlan).not.toBeNull();

    const toolTokens = estimateToolDeclarationsTokens(dispatcher.getToolDeclarations());
    const preUsedTokens = estimateMessagesTokens(futureMessages) + toolTokens;
    const compactionRequestTokens = estimateMessagesTokens(
      buildCompactionRequestMessages(compactionPlan!.compactedMessages),
    );
    expect(compactionRequestTokens).toBeGreaterThan(1);

    const contextLimit = Math.min(preUsedTokens, Math.max(1, Math.floor(compactionRequestTokens / HARD_CEILING_UTILIZATION) - 1));
    const provider = new CompactionAwareProvider("This summary call should not happen.", "This normal call should not happen.");
    const runtime = new AgentRuntime({
      adapter,
      llmProvider: provider,
      modelConfig: createModelConfig({ contextLimit }),
      sessionManager,
      primitiveDispatcher: dispatcher,
    });

    runtime.start();
    adapter.dispatchInbound(finalUserMessage);

    try {
      expect(await runtime.waitForIdle(1000)).toBe(true);
      expect(provider.summaryCallCount).toBe(0);
      expect(provider.normalCallCount).toBe(0);
      expect(adapter.streamChunks).toEqual([]);
      expect(adapter.sentMessages).toContainEqual(expect.objectContaining({
        mode: "notify",
        content: expect.stringContaining("I ended this session"),
      }));
      expect(adapter.sentMessages.some((message) => message.content.startsWith("Runtime error:"))).toBe(false);
      expect(sessionManager.getInteractiveSession()).toBeNull();
    } finally {
      await runtime.shutdown(1000);
    }
  });

  test("ends an interactive session cleanly when utilization stays above the hard ceiling after compaction", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "agent-runtime-hard-ceiling-"));
    tempDirs.push(rootDir);

    const agentHome = join(rootDir, ".agent");
    const workspaceDir = join(rootDir, "workspace");
    await mkdir(agentHome, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const adapter = new FakeAdapter();
    const dispatcher = new PrimitiveDispatcher({ agentHome, workspaceDir });
    const sessionManager = new SessionManager({
      buildSystemPrompt: () => "system prompt",
    });
    const session = await sessionManager.getOrCreateInteractiveSession(new Date("2026-03-22T00:00:00.000Z"));
    seedSession(session, buildSeedMessages());

    const finalUserMessage = "latest request that should hard stop";
    const futureMessages = [...session.messages, { role: "user", content: finalUserMessage } satisfies InternalMessage];
    const compactionPlan = planHistoryCompaction(futureMessages);
    expect(compactionPlan).not.toBeNull();

    const summaryText = "summary ".repeat(120).trim();
    const postCompactionMessages = buildCompactedMessageHistory(
      futureMessages,
      compactionPlan!.keepStartIndex,
      buildCompactionSummaryMessage(summaryText),
    );
    const toolTokens = estimateToolDeclarationsTokens(dispatcher.getToolDeclarations());
    const preUsedTokens = estimateMessagesTokens(futureMessages) + toolTokens;
    const postUsedTokens = estimateMessagesTokens(postCompactionMessages) + toolTokens;
    const compactionRequestTokens = estimateMessagesTokens(
      buildCompactionRequestMessages(compactionPlan!.compactedMessages),
    );
    const contextLimit = findContextLimit(preUsedTokens, postUsedTokens, "hard_ceiling_after_compaction", {
      minimumContextLimit: Math.ceil(compactionRequestTokens / HARD_CEILING_UTILIZATION),
    });

    const provider = new CompactionAwareProvider(summaryText, "This should never stream.");
    const runtime = new AgentRuntime({
      adapter,
      llmProvider: provider,
      modelConfig: createModelConfig({ contextLimit }),
      sessionManager,
      primitiveDispatcher: dispatcher,
    });

    runtime.start();
    adapter.dispatchInbound(finalUserMessage);

    expect(await runtime.waitForIdle(1000)).toBe(true);
    expect(provider.summaryCallCount).toBe(1);
    expect(provider.normalCallCount).toBe(0);
    expect(adapter.streamChunks).toEqual([]);
    expect(adapter.sentMessages).toContainEqual(expect.objectContaining({
      mode: "notify",
      content: expect.stringContaining("stored a summary in memory and ended this session"),
    }));
    expect(sessionManager.getInteractiveSession()).toBeNull();

    const memoryEntries = await dispatcher.dispatch(
      "memory",
      {
        operation: "list",
        domain: null,
      },
      { sessionId: "memory-check" },
    );
    expect(memoryEntries).toMatchObject({
      success: true,
      data: {
        entries: [
          {
            key: expect.stringMatching(/^session_summary:/),
            value: summaryText,
          },
        ],
      },
    });
  });

  test("ends triggered sessions successfully when utilization stays above the hard ceiling after compaction", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "agent-runtime-triggered-hard-ceiling-"));
    tempDirs.push(rootDir);

    const agentHome = join(rootDir, ".agent");
    const workspaceDir = join(rootDir, "workspace");
    await mkdir(agentHome, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const adapter = new FakeAdapter();
    const dispatcher = new PrimitiveDispatcher({ agentHome, workspaceDir });
    const seedMessages = buildSeedMessages();
    const schedule = {
      schedule_id: "schedule-context-limit",
      workflow: "hydration",
      group: null,
      trigger: { type: "once", at: "2026-03-22T10:00:00.000Z" },
      context: { instruction: "Continue the scheduled work." },
      instruction: "Continue the scheduled work.",
    } satisfies TriggeredScheduleContext;
    const now = new Date("2026-03-22T10:00:00.000Z");

    const predictedSession = new AgentSession({
      systemPrompt: buildTriggeredSystemPrompt(now, schedule),
      triggerSource: "schedule",
      createdAt: now,
    });
    seedSession(predictedSession, seedMessages);
    const compactionPlan = planHistoryCompaction(predictedSession.messages);
    expect(compactionPlan).not.toBeNull();

    const summaryText = "scheduled summary ".repeat(120).trim();
    const postCompactionMessages = buildCompactedMessageHistory(
      predictedSession.messages,
      compactionPlan!.keepStartIndex,
      buildCompactionSummaryMessage(summaryText),
    );
    const toolTokens = estimateToolDeclarationsTokens(dispatcher.getToolDeclarations());
    const preUsedTokens = estimateMessagesTokens(predictedSession.messages) + toolTokens;
    const postUsedTokens = estimateMessagesTokens(postCompactionMessages) + toolTokens;
    const compactionRequestTokens = estimateMessagesTokens(
      buildCompactionRequestMessages(compactionPlan!.compactedMessages),
    );
    const contextLimit = findContextLimit(preUsedTokens, postUsedTokens, "hard_ceiling_after_compaction", {
      minimumContextLimit: Math.ceil(compactionRequestTokens / HARD_CEILING_UTILIZATION),
    });

    const provider = new CompactionAwareProvider(summaryText, "This should never stream.");
    const runtime = new AgentRuntime({
      adapter,
      llmProvider: provider,
      modelConfig: createModelConfig({ contextLimit }),
      sessionManager: new SeededTriggeredSessionManager(seedMessages, {
        buildSystemPrompt: ({ now: runtimeNow, triggeredSchedule }) => buildTriggeredSystemPrompt(runtimeNow, triggeredSchedule),
      }),
      primitiveDispatcher: dispatcher,
    });

    runtime.start();

    try {
      expect(await runtime.launchTriggeredSchedule(schedule, now)).toBe(true);
      expect(await runtime.waitForIdle(1000)).toBe(true);
      expect(provider.summaryCallCount).toBe(1);
      expect(provider.normalCallCount).toBe(0);
      expect(adapter.sentMessages).toContainEqual(expect.objectContaining({
        mode: "notify",
        content: expect.stringContaining("Scheduled session ended because it stayed above the context hard ceiling"),
      }));

      const memoryEntries = await dispatcher.dispatch(
        "memory",
        {
          operation: "list",
          domain: null,
        },
        { sessionId: "memory-check" },
      );
      expect(memoryEntries).toMatchObject({
        success: true,
        data: {
          entries: [
            {
              key: expect.stringMatching(/^session_summary:/),
              value: summaryText,
            },
          ],
        },
      });
    } finally {
      await runtime.shutdown(1000);
    }
  });

  test("surfaces provider outages to interactive users and keeps the runtime alive", async () => {
    const { parsed, sink } = createCaptureSink();
    const adapter = new FakeAdapter();
    const provider = new UnavailableProvider();
    const sessionManager = new RecordingFailureSessionManager({
      buildSystemPrompt: () => "system prompt",
    });
    const runtime = new AgentRuntime({
      adapter,
      llmProvider: provider,
      modelConfig: createModelConfig(),
      sessionManager,
      primitiveDispatcher: new PrimitiveDispatcher({
        workspaceDir: join(tmpdir(), `agent-runtime-provider-unavailable-${crypto.randomUUID()}`),
      }),
      logger: new Logger({ sink }),
    });

    runtime.start();

    try {
      adapter.dispatchInbound("hello");

      expect(await runtime.waitForIdle(1000)).toBe(true);
      expect(adapter.sentMessages).toContainEqual(expect.objectContaining({
        mode: "notify",
        content: "The language model is currently unavailable. Check the network connection or provider settings, then try again.",
      }));
      expect(sessionManager.failedSessions).toHaveLength(1);
      expect(sessionManager.failedSessions[0]?.status).toBe("failed");
      expect(sessionManager.getInteractiveSession()).toBeNull();

      expect(parsed()).toContainEqual(expect.objectContaining({
        level: "error",
        event: "runtime.session.interactive.failed",
        component: "runtime.agent",
        sessionId: sessionManager.failedSessions[0]?.id,
        triggerSource: "user",
        providerUnavailable: true,
        error: expect.objectContaining({
          name: "LLMProviderUnavailableError",
          message: "Provider offline.",
        }),
      }));

      adapter.dispatchInbound("retry");

      expect(await runtime.waitForIdle(1000)).toBe(true);
      expect(
        adapter.sentMessages.filter((message) => {
          return message.mode === "notify"
            && message.content === "The language model is currently unavailable. Check the network connection or provider settings, then try again.";
        }),
      ).toHaveLength(2);
      expect(sessionManager.failedSessions).toHaveLength(2);
    } finally {
      await runtime.shutdown(1000);
    }
  });

  test("marks triggered sessions failed on provider outages and keeps processing later work", async () => {
    const { parsed, sink } = createCaptureSink();
    const adapter = new FakeAdapter();
    let callCount = 0;
    const provider: LLMProvider = {
      async *stream(
        messages: InternalMessage[],
        _tools: ToolDeclaration[],
        _config: ModelConfig,
      ): AsyncIterable<StreamChunk> {
        callCount += 1;

        if (callCount === 1) {
          throw new LLMProviderUnavailableError("Provider offline.");
        }

        const latestUserMessage = [...messages].reverse().find((message) => message.role === "user");
        yield { type: "text", content: `reply:${latestUserMessage?.content ?? ""}` };
        yield { type: "done" };
      },
    };
    const sessionManager = new RecordingFailureSessionManager({
      buildSystemPrompt: ({ now, triggeredSchedule }) => buildTriggeredSystemPrompt(now, triggeredSchedule),
    });
    const runtime = new AgentRuntime({
      adapter,
      llmProvider: provider,
      modelConfig: createModelConfig(),
      sessionManager,
      primitiveDispatcher: new PrimitiveDispatcher({
        workspaceDir: join(tmpdir(), `agent-runtime-trigger-provider-unavailable-${crypto.randomUUID()}`),
      }),
      logger: new Logger({ sink }),
    });

    runtime.start();

    try {
      const success = await runtime.launchTriggeredSchedule({
        schedule_id: "schedule-provider-unavailable",
        workflow: "hydration",
        group: null,
        trigger: { type: "once", at: "2026-03-22T10:05:00.000Z" },
        context: { instruction: "Run the scheduled reminder." },
        instruction: "Run the scheduled reminder.",
      });

      expect(success).toBe(false);
      expect(sessionManager.failedSessions).toHaveLength(1);
      expect(sessionManager.failedSessions[0]?.status).toBe("failed");
      expect(adapter.sentMessages).toContainEqual(expect.objectContaining({
        sessionId: sessionManager.failedSessions[0]?.id,
        mode: "notify",
        content: "Scheduled run failed because the language model is currently unavailable. Check the network connection or provider settings, then retry the schedule.",
      }));
      expect(parsed()).toContainEqual(expect.objectContaining({
        level: "error",
        event: "runtime.session.triggered.failed",
        component: "runtime.agent",
        sessionId: sessionManager.failedSessions[0]?.id,
        triggerSource: "schedule",
        providerUnavailable: true,
        error: expect.objectContaining({
          name: "LLMProviderUnavailableError",
          message: "Provider offline.",
        }),
      }));

      adapter.dispatchInbound("follow-up after outage");

      expect(await runtime.waitForIdle(1000)).toBe(true);
      expect(callCount).toBe(2);
      expect(adapter.streamChunks).toEqual([
        {
          sessionId: sessionManager.getInteractiveSession()!.id,
          content: "reply:follow-up after outage",
        },
      ]);
    } finally {
      await runtime.shutdown(1000);
    }
  });

  test("logs compaction summary persistence throws and continues", async () => {
    const { parsed, sink } = createCaptureSink();
    const rootDir = await mkdtemp(join(tmpdir(), "agent-runtime-compaction-persist-throw-"));
    tempDirs.push(rootDir);

    const agentHome = join(rootDir, ".agent");
    const workspaceDir = join(rootDir, "workspace");
    await mkdir(agentHome, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const adapter = new FakeAdapter();
    class ThrowingSummaryMemoryDispatcher extends PrimitiveDispatcher {
      override async dispatch(
        primitiveName: string,
        params: Record<string, unknown>,
        context: PrimitiveContext,
      ): Promise<PrimitiveResult> {
        if (
          primitiveName === "memory"
          && params.operation === "set"
          && params.domain === null
          && typeof params.key === "string"
          && params.key.startsWith("session_summary:")
        ) {
          throw new Error("Injected compaction summary persistence throw.");
        }

        return await super.dispatch(primitiveName, params, context);
      }
    }
    const dispatcher = new ThrowingSummaryMemoryDispatcher({ agentHome, workspaceDir });
    const sessionManager = new SessionManager({
      buildSystemPrompt: () => "system prompt",
    });
    const session = await sessionManager.getOrCreateInteractiveSession(new Date("2026-03-22T00:00:00.000Z"));
    seedSession(session, buildSeedMessages());

    const finalUserMessage = "latest request that should still continue after a thrown persistence failure";
    const futureMessages = [...session.messages, { role: "user", content: finalUserMessage } satisfies InternalMessage];
    const compactionPlan = planHistoryCompaction(futureMessages);
    expect(compactionPlan).not.toBeNull();

    const summaryText = "Older repo and user context that still matters.";
    const postCompactionMessages = buildCompactedMessageHistory(
      futureMessages,
      compactionPlan!.keepStartIndex,
      buildCompactionSummaryMessage(summaryText),
    );
    const toolTokens = estimateToolDeclarationsTokens(dispatcher.getToolDeclarations());
    const preUsedTokens = estimateMessagesTokens(futureMessages) + toolTokens;
    const postUsedTokens = estimateMessagesTokens(postCompactionMessages) + toolTokens;
    const contextLimit = findContextLimit(preUsedTokens, postUsedTokens, "continue_after_compaction");

    const provider = new CompactionAwareProvider(summaryText, "Compacted reply complete.");
    const runtime = new AgentRuntime({
      adapter,
      llmProvider: provider,
      modelConfig: createModelConfig({ contextLimit }),
      sessionManager,
      primitiveDispatcher: dispatcher,
      logger: new Logger({ sink }),
    });

    runtime.start();
    adapter.dispatchInbound(finalUserMessage);

    try {
      expect(await runtime.waitForIdle(1000)).toBe(true);
      expect(provider.summaryCallCount).toBe(1);
      expect(provider.normalCallCount).toBe(1);
      expect(adapter.streamChunks).toEqual([
        { sessionId: session.id, content: "Compacted reply complete." },
      ]);
      expect(parsed()).toContainEqual(expect.objectContaining({
        level: "warn",
        event: "runtime.compaction.persist_failed",
        component: "runtime.agent",
        sessionId: session.id,
        error: expect.objectContaining({
          name: "Error",
          message: "Injected compaction summary persistence throw.",
        }),
      }));

      const memoryEntries = await dispatcher.dispatch(
        "memory",
        {
          operation: "list",
          domain: null,
        },
        { sessionId: "memory-check" },
      );
      expect(memoryEntries).toMatchObject({
        success: true,
        data: {
          entries: [],
        },
      });
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

function createModelConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    model: "fake-model",
    baseUrl: "http://localhost",
    temperature: 0,
    maxOutputTokens: 128,
    apiKey: "test-key",
    ...overrides,
  } satisfies ModelConfig;
}

function buildSeedMessages(): InternalMessage[] {
  return [
    { role: "user", content: "legacy user 1" },
    { role: "assistant", content: "legacy assistant 1" },
    { role: "tool_result", content: '{"success":true,"data":"legacy tool 1"}', toolResultId: "legacy-call-1" },
    { role: "assistant", content: "legacy assistant 2" },
    { role: "user", content: "legacy user 2" },
    { role: "assistant", content: "legacy assistant 3" },
    { role: "tool_result", content: '{"success":true,"data":"legacy tool 2"}', toolResultId: "legacy-call-2" },
    { role: "assistant", content: "legacy assistant 4" },
    { role: "user", content: "legacy user 3" },
    { role: "assistant", content: "legacy assistant 5" },
  ];
}

function buildLargeCompactionSeedMessages(): InternalMessage[] {
  const largeChunk = "older context ".repeat(700);

  return [
    { role: "user", content: `${largeChunk}legacy user 1` },
    { role: "assistant", content: `${largeChunk}legacy assistant 1` },
    { role: "tool_result", content: `{"success":true,"data":"${largeChunk}legacy tool 1"}`, toolResultId: "legacy-call-1" },
    { role: "assistant", content: `${largeChunk}legacy assistant 2` },
    { role: "user", content: `${largeChunk}legacy user 2` },
    { role: "assistant", content: "recent assistant 1" },
    { role: "tool_result", content: '{"success":true,"data":"recent tool 1"}', toolResultId: "legacy-call-2" },
    { role: "assistant", content: "recent assistant 2" },
    { role: "user", content: "recent user 3" },
    { role: "assistant", content: "recent assistant 3" },
  ];
}

function seedSession(session: AgentSession, messages: InternalMessage[]): void {
  for (const message of messages) {
    switch (message.role) {
      case "user":
        session.appendUserMessage(message.content);
        break;
      case "assistant":
        session.appendAssistantMessage(message.content, message.toolCalls);
        break;
      case "system":
        session.appendSystemMessage(message.content);
        break;
      case "tool_result":
        session.appendToolResult(message.toolResultId ?? crypto.randomUUID(), message.content);
        break;
    }
  }
}

function findContextLimit(
  preUsedTokens: number,
  postUsedTokens: number,
  mode: "continue_after_compaction" | "hard_ceiling_after_compaction",
  options: { minimumContextLimit?: number } = {},
): number {
  const minimumContextLimit = Math.max(1, Math.trunc(options.minimumContextLimit ?? 1));

  for (let contextLimit = minimumContextLimit; contextLimit <= Math.max(preUsedTokens, postUsedTokens) + 1_000; contextLimit += 1) {
    const preUtilization = preUsedTokens / contextLimit;
    const postUtilization = postUsedTokens / contextLimit;

    if (preUtilization < COMPACTION_TRIGGER_UTILIZATION) {
      continue;
    }

    if (mode === "continue_after_compaction" && postUtilization < HARD_CEILING_UTILIZATION) {
      return contextLimit;
    }

    if (mode === "hard_ceiling_after_compaction" && postUtilization > HARD_CEILING_UTILIZATION) {
      return contextLimit;
    }
  }

  throw new Error(`Unable to find a context limit for ${mode}.`);
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
