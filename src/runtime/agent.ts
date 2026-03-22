import type { CommunicationAdapter, DeliveryResult, InboundMessage, OutboundMessage } from "../communication/adapter.ts";
import type { LLMProvider } from "../llm/provider.ts";
import type { ModelConfig, ToolCall } from "../llm/types.ts";
import { PrimitiveDispatcher } from "../primitives/dispatcher.ts";
import type {
  ApprovalReceiptLookup,
  ApprovalDecision,
  InteractionHandler,
  PrimitiveContext,
  PromptOptions,
  ApprovalRequestOptions,
} from "../primitives/types.ts";
import { InteractionTimeoutError } from "../primitives/types.ts";
import { createApprovalReceipt } from "../policy/receipts.ts";
import type { TriggeredScheduleContext } from "../scheduler/types.ts";
import { SessionManager } from "../session/manager.ts";
import type { AgentSession } from "../session/session.ts";

const USER_RESPONSE_TIMEOUT_MS = 5 * 60 * 1000;
const SCHEDULED_USER_RESPONSE_TIMEOUT_MS = 2 * 60 * 1000;

interface UserResponseRequest {
  promptId: string;
  promise: Promise<string>;
  resolve: (content: string) => void;
  reject: (error: Error) => void;
  message: OutboundMessage;
  context: PrimitiveContext;
  timeoutMs: number;
  timeoutError: string;
  timer: ReturnType<typeof setTimeout> | null;
  timeoutRemainingMs: number;
  timeoutStartedAt: number | null;
}

interface StreamCapableAdapter extends CommunicationAdapter {
  sendStreamChunk(sessionId: string, content: string): Promise<DeliveryResult>;
}

export interface AgentRuntimeOptions {
  adapter: CommunicationAdapter;
  llmProvider: LLMProvider;
  modelConfig: ModelConfig;
  sessionManager: SessionManager;
  primitiveDispatcher: PrimitiveDispatcher;
  userResponseTimeoutMs?: number;
  scheduledUserResponseTimeoutMs?: number;
}

export class AgentRuntime {
  private readonly adapter: CommunicationAdapter;
  private readonly llmProvider: LLMProvider;
  private readonly modelConfig: ModelConfig;
  private readonly sessionManager: SessionManager;
  private readonly primitiveDispatcher: PrimitiveDispatcher;
  private readonly userResponseTimeoutMs: number;
  private readonly scheduledUserResponseTimeoutMs: number;
  private readonly inboundQueue: InboundMessage[] = [];
  private readonly activeBackgroundTasks = new Set<Promise<boolean>>();
  private readonly queuedUserResponseRequests: UserResponseRequest[] = [];
  private pendingUserResponseRequest: UserResponseRequest | null = null;
  private drainPromise: Promise<void> | null = null;
  private started = false;
  private shuttingDown = false;

  constructor(options: AgentRuntimeOptions) {
    this.adapter = options.adapter;
    this.llmProvider = options.llmProvider;
    this.modelConfig = options.modelConfig;
    this.sessionManager = options.sessionManager;
    this.primitiveDispatcher = options.primitiveDispatcher;
    this.userResponseTimeoutMs = options.userResponseTimeoutMs ?? USER_RESPONSE_TIMEOUT_MS;
    this.scheduledUserResponseTimeoutMs = options.scheduledUserResponseTimeoutMs ?? SCHEDULED_USER_RESPONSE_TIMEOUT_MS;
    this.primitiveDispatcher.setAuthorizationCodeHandler(async (message, context) => {
      return await this.requestAuthorizationCode(message, context);
    });
    this.primitiveDispatcher.setInteractionHandler(this.createInteractionHandler());
  }

  start(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    this.adapter.onMessage((message) => {
      if (this.shuttingDown) {
        return;
      }

      if (this.shouldConsumePendingUserResponseRequest(message)) {
        this.resolvePendingUserResponseRequest(message);
        return;
      }

      this.inboundQueue.push(message);
      this.ensureDrainLoop();
    });
  }

  async shutdown(timeoutMs = 30_000): Promise<boolean> {
    this.shuttingDown = true;
    this.rejectAllUserResponseRequests("Runtime is shutting down.");
    return this.waitForIdle(timeoutMs);
  }

  async waitForIdle(timeoutMs = 30_000): Promise<boolean> {
    const startedAt = Date.now();
    while (this.drainPromise || this.activeBackgroundTasks.size > 0) {
      if (Date.now() - startedAt >= timeoutMs) {
        return false;
      }

      await Bun.sleep(10);
    }

    return true;
  }

  launchTriggeredSchedule(schedule: TriggeredScheduleContext, firedAt = new Date()): Promise<boolean> {
    if (this.shuttingDown) {
      return Promise.resolve(false);
    }

    const session = this.sessionManager.createTriggeredSession(schedule, firedAt);
    const task = this.runTriggeredSession(session);
    this.activeBackgroundTasks.add(task);
    void task.finally(() => {
      this.activeBackgroundTasks.delete(task);
    });
    return task;
  }

  private ensureDrainLoop(): void {
    if (this.drainPromise || this.shuttingDown) {
      return;
    }

    this.drainPromise = this.drainQueue().finally(() => {
      this.drainPromise = null;
      if (this.inboundQueue.length > 0 && !this.shuttingDown) {
        this.ensureDrainLoop();
      }
    });
  }

  private async drainQueue(): Promise<void> {
    while (this.inboundQueue.length > 0) {
      const inbound = this.inboundQueue.shift();
      if (!inbound) {
        return;
      }

      const session = this.sessionManager.getOrCreateInteractiveSession(inbound.timestamp);
      try {
        await this.processSession(session, {
          initialUserMessage: inbound,
          completeOnAssistantText: false,
        });
      } catch (error) {
        this.sessionManager.failSession(session.id);
        await this.adapter.send({
          sessionId: session.id,
          mode: "notify",
          content: `Runtime error: ${toErrorMessage(error)}`,
        });
      }

      if (this.shuttingDown) {
        return;
      }
    }
  }

  private async processSession(
    session: AgentSession,
    options: { initialUserMessage?: InboundMessage; completeOnAssistantText: boolean },
  ): Promise<void> {
    if (options.initialUserMessage) {
      session.appendUserMessage(options.initialUserMessage.content, options.initialUserMessage.timestamp);
    }

    while (true) {
      session.markWaitingForLLM();

      const assistantTextParts: string[] = [];
      const toolCallsById = new Map<string, ToolCall>();
      const toolCallOrder: string[] = [];
      const toolDeclarations = this.primitiveDispatcher.getToolDeclarations();

      for await (const chunk of this.llmProvider.stream(
        session.messages,
        toolDeclarations,
        this.modelConfig,
      )) {
        if (chunk.type === "text" && chunk.content) {
          assistantTextParts.push(chunk.content);
          await this.sendStreamChunk(session.id, chunk.content);
          continue;
        }

        if (
          (chunk.type === "tool_call_start" ||
            chunk.type === "tool_call_delta" ||
            chunk.type === "tool_call_end") &&
          chunk.toolCall
        ) {
          const toolCallKey = chunk.toolCallKey ?? chunk.toolCall.id;
          const current = toolCallsById.get(toolCallKey) ?? {
            id: chunk.toolCall.id,
            name: "",
            arguments: "",
          };

          if (!toolCallsById.has(toolCallKey)) {
            toolCallOrder.push(toolCallKey);
          }

          current.id = chunk.toolCall.id;
          current.name = chunk.toolCall.name;
          current.arguments = chunk.toolCall.arguments;
          toolCallsById.set(toolCallKey, current);
        }
      }

      const assistantText = assistantTextParts.join("");
      const toolCalls = toolCallOrder.map((toolCallId) => toolCallsById.get(toolCallId)).filter(Boolean) as ToolCall[];

      if (toolCalls.length > 0) {
        session.appendAssistantMessage(assistantText, toolCalls);

        for (const toolCall of toolCalls) {
          session.incrementIteration();
          if (session.hasReachedIterationLimit()) {
            this.sessionManager.failSession(session.id);
            await this.adapter.send({
              sessionId: session.id,
              mode: "notify",
              content: "Session stopped after reaching the 50-iteration limit.",
            });
            return;
          }

          const toolResult = await this.dispatchToolCall(session, toolCall);
          session.appendToolResult(toolCall.id, JSON.stringify(toolResult));
        }

        continue;
      }

      if (assistantText) {
        session.appendAssistantMessage(assistantText);
        if (options.completeOnAssistantText) {
          this.sessionManager.completeSession(session.id);
        } else {
          session.markWaitingForUser();
        }
        return;
      }

      throw new Error("LLM returned no text or tool calls.");
    }
  }

  private async dispatchToolCall(session: AgentSession, toolCall: ToolCall) {
    let params: Record<string, unknown> = {};

    if (toolCall.arguments.trim() !== "") {
      try {
        const parsed = JSON.parse(toolCall.arguments) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          params = parsed as Record<string, unknown>;
        } else {
          return {
            success: false,
            error: `Invalid arguments for ${toolCall.name}: expected a JSON object.`,
          };
        }
      } catch (error) {
        return {
          success: false,
          error: `Invalid arguments for ${toolCall.name}: ${toErrorMessage(error)}`,
        };
      }
    }

    return await this.primitiveDispatcher.dispatch(toolCall.name, params, {
      sessionId: session.id,
      triggerSource: session.triggerSource,
    });
  }

  private async sendStreamChunk(sessionId: string, content: string): Promise<void> {
    if (hasStreamSupport(this.adapter)) {
      await this.adapter.sendStreamChunk(sessionId, content);
      return;
    }

    const message: OutboundMessage = {
      sessionId,
      mode: "notify",
      content,
      format: "plain",
    };
    await this.adapter.send(message);
  }

  private async requestAuthorizationCode(message: string, context: PrimitiveContext): Promise<string> {
    return await this.requestTextResponse(message, context, {
      timeoutMs: this.userResponseTimeoutMs,
      timeoutError: "Timed out waiting for an OAuth authorization code from the user.",
    });
  }

  private createInteractionHandler(): InteractionHandler {
    return {
      notify: async (message, context) => await this.sendNotification(message, context),
      ask: async (message, context, options) => await this.askUser(message, context, options),
      requestApproval: async (message, context, options) => await this.requestUserApproval(message, context, options),
      hasApprovalReceipt: (context, criteria) => this.hasApprovalReceipt(context, criteria),
    };
  }

  private async sendNotification(message: string, context: PrimitiveContext): Promise<DeliveryResult> {
    this.ensureActiveSession(context.sessionId, "send a notification to");
    return await this.adapter.send({
      sessionId: context.sessionId,
      mode: "notify",
      content: message,
      format: "plain",
    });
  }

  private async askUser(message: string, context: PrimitiveContext, options: PromptOptions = {}): Promise<string> {
    return await this.requestTextResponse(message, context, {
      timeoutMs: options.timeoutMs ?? this.getDefaultPromptTimeoutMs(context.sessionId),
      timeoutError: "Timed out waiting for a reply from the user.",
    });
  }

  private async requestUserApproval(
    message: string,
    context: PrimitiveContext,
    options: ApprovalRequestOptions = {},
  ): Promise<ApprovalDecision> {
    const response = await this.awaitUserResponse({
      sessionId: context.sessionId,
      mode: "approve",
      content: renderApprovalPromptContent(message),
      actions: [
        { label: "Allow", value: "yes" },
        { label: "Deny", value: "no" },
      ],
      format: "plain",
    }, context, {
      timeoutMs: options.timeoutMs ?? this.getDefaultPromptTimeoutMs(context.sessionId),
      timeoutError: "Timed out waiting for an approval decision from the user.",
    });

    const decision = parseApprovalResponse(response);
    if (decision.approved === true && options.recordReceipt) {
      const session = this.ensureActiveSession(context.sessionId, "record an approval receipt for");
      session.addApprovalReceipt(createApprovalReceipt({
        timestamp: new Date(),
        tool: options.tool,
        operation: options.operation,
        summary: options.summary ?? message,
      }));
    }

    return decision;
  }

  private hasApprovalReceipt(context: PrimitiveContext, criteria: ApprovalReceiptLookup): boolean {
    const session = this.sessionManager.getSession(context.sessionId);
    if (!session) {
      return false;
    }

    return session.hasApprovalReceipt({
      tool: criteria.tool,
      operation: criteria.operation,
      now: criteria.now,
      maxAgeMs: criteria.maxAgeMs,
    });
  }

  private async requestTextResponse(
    message: string,
    context: PrimitiveContext,
    options: { timeoutMs: number; timeoutError: string },
  ): Promise<string> {
    return await this.awaitUserResponse({
      sessionId: context.sessionId,
      mode: "ask",
      content: message,
      format: "plain",
    }, context, {
      timeoutMs: options.timeoutMs,
      timeoutError: options.timeoutError,
    });
  }

  private async awaitUserResponse(
    message: OutboundMessage,
    context: PrimitiveContext,
    options: { timeoutMs: number; timeoutError: string },
  ): Promise<string> {
    if (this.shuttingDown) {
      throw new Error("Runtime is shutting down.");
    }

    this.ensureActiveSession(context.sessionId, "prompt");

    const request = this.createUserResponseRequest(message, context, options.timeoutMs, options.timeoutError);
    this.queuedUserResponseRequests.push(request);
    this.activateNextUserResponseRequest();
    return await request.promise;
  }

  private createUserResponseRequest(
    message: OutboundMessage,
    context: PrimitiveContext,
    timeoutMs: number,
    timeoutError: string,
  ): UserResponseRequest {
    const promptId = crypto.randomUUID();
    let resolveRequest!: (content: string) => void;
    let rejectRequest!: (error: Error) => void;

    const promise = new Promise<string>((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });

    const request: UserResponseRequest = {
      promptId,
      promise,
      resolve: resolveRequest,
      reject: rejectRequest,
      message: {
        ...message,
        promptId,
      },
      context,
      timeoutMs,
      timeoutError,
      timer: null,
      timeoutRemainingMs: timeoutMs,
      timeoutStartedAt: null,
    };

    return request;
  }

  private activateNextUserResponseRequest(): void {
    if (this.pendingUserResponseRequest || this.shuttingDown) {
      return;
    }

    const request = this.queuedUserResponseRequests.shift();
    if (!request) {
      return;
    }

    try {
      this.ensureActiveSession(request.context.sessionId, "prompt");
    } catch (error) {
      request.reject(new Error(toErrorMessage(error)));
      this.activateNextUserResponseRequest();
      return;
    }

    this.pendingUserResponseRequest = request;
    void this.deliverPendingUserResponseRequest(request);
  }

  private async deliverPendingUserResponseRequest(request: UserResponseRequest): Promise<void> {
    try {
      const delivery = await this.adapter.send(request.message);
      if (this.pendingUserResponseRequest !== request) {
        return;
      }

      if (delivery.delivered) {
        this.startOrResumeUserResponseTimer(request);
        return;
      }

      await delivery.whenDelivered;
      if (this.pendingUserResponseRequest !== request) {
        return;
      }

      this.startOrResumeUserResponseTimer(request);
    } catch (error) {
      if (this.pendingUserResponseRequest !== request) {
        return;
      }

      this.pendingUserResponseRequest = null;
      clearRequestTimer(request);
      request.reject(new Error(toErrorMessage(error)));
      this.activateNextUserResponseRequest();
    }
  }

  private shouldConsumePendingUserResponseRequest(message: InboundMessage): boolean {
    const request = this.pendingUserResponseRequest;
    if (!request) {
      return false;
    }

    if (message.replyToPromptId) {
      return message.replyToPromptId === request.promptId;
    }

    return true;
  }

  private resolvePendingUserResponseRequest(message: InboundMessage): void {
    const request = this.pendingUserResponseRequest;
    if (!request) {
      return;
    }

    this.pendingUserResponseRequest = null;
    clearRequestTimer(request);

    const renderedContent = message.content.trim();
    if (renderedContent === "") {
      request.reject(new Error("Received an empty response from the user."));
      this.activateNextUserResponseRequest();
      return;
    }

    request.resolve(renderedContent);
    this.activateNextUserResponseRequest();
  }

  private rejectPendingUserResponseRequest(message: string): void {
    const request = this.pendingUserResponseRequest;
    if (!request) {
      return;
    }

    this.pendingUserResponseRequest = null;
    clearRequestTimer(request);
    request.reject(new Error(message));
  }

  private rejectAllUserResponseRequests(message: string): void {
    this.rejectPendingUserResponseRequest(message);

    while (this.queuedUserResponseRequests.length > 0) {
      const request = this.queuedUserResponseRequests.shift();
      if (!request) {
        continue;
      }

      clearRequestTimer(request);
      request.reject(new Error(message));
    }
  }

  private startOrResumeUserResponseTimer(request: UserResponseRequest): void {
    if (request.timer || request.timeoutRemainingMs <= 0) {
      return;
    }

    request.timeoutStartedAt = Date.now();
    request.timer = setTimeout(() => {
      if (this.pendingUserResponseRequest !== request) {
        return;
      }

      this.pendingUserResponseRequest = null;
      request.timer = null;
      request.timeoutStartedAt = null;
      request.timeoutRemainingMs = 0;
      request.reject(new InteractionTimeoutError(request.timeoutError));
      this.activateNextUserResponseRequest();
    }, request.timeoutRemainingMs);
  }

  private ensureActiveSession(sessionId: string, action: string): AgentSession {
    const session = this.sessionManager.getSession(sessionId);
    if (!session || session.isTerminal()) {
      throw new Error(`Cannot ${action} inactive session ${sessionId}.`);
    }

    return session;
  }

  private async runTriggeredSession(session: AgentSession): Promise<boolean> {
    try {
      await this.processSession(session, { completeOnAssistantText: true });
      if (!session.isTerminal()) {
        this.sessionManager.completeSession(session.id);
      }

      return true;
    } catch (error) {
      this.sessionManager.failSession(session.id);
      await this.adapter.send({
        sessionId: session.id,
        mode: "notify",
        content: `Runtime error: ${toErrorMessage(error)}`,
      });
      return false;
    }
  }

  private getDefaultPromptTimeoutMs(sessionId: string): number {
    const session = this.sessionManager.getSession(sessionId);
    if (session?.triggerSource === "schedule") {
      return this.scheduledUserResponseTimeoutMs;
    }

    return this.userResponseTimeoutMs;
  }
}

function hasStreamSupport(adapter: CommunicationAdapter): adapter is StreamCapableAdapter {
  return "sendStreamChunk" in adapter && typeof adapter.sendStreamChunk === "function";
}

function clearRequestTimer(request: UserResponseRequest): void {
  if (!request.timer) {
    return;
  }

  clearTimeout(request.timer);
  request.timer = null;

  if (request.timeoutStartedAt !== null) {
    request.timeoutRemainingMs = Math.max(0, request.timeoutRemainingMs - (Date.now() - request.timeoutStartedAt));
    request.timeoutStartedAt = null;
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function parseApprovalResponse(content: string): ApprovalDecision {
  const response = content.trim();
  const normalized = response.toLowerCase();
  if (["yes", "y", "approve", "approved", "allow", "allowed", "ok", "okay", "true"].includes(normalized)) {
    return {
      approved: true,
      response,
    };
  }

  if (["no", "n", "deny", "denied", "reject", "rejected", "false"].includes(normalized)) {
    return {
      approved: false,
      response,
    };
  }

  return {
    approved: null,
    response,
    error: "Unrecognized approval response: expected yes or no.",
  };
}

function renderApprovalPromptContent(message: string): string {
  if (/reply\s+exactly\s+yes\s+or\s+no(?:\s+only)?/i.test(message)) {
    return message;
  }

  const trimmedMessage = message.trim();
  if (trimmedMessage === "") {
    return "Reply exactly yes or no.";
  }

  return `${trimmedMessage} Reply exactly yes or no.`;
}
