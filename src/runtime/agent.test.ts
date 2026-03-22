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

  dispatchInbound(content: string, timestamp = new Date()): void {
    this.handler?.({ content, timestamp });
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
      content: expect.stringContaining("mockmail.messages.send"),
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
