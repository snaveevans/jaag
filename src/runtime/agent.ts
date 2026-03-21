import type { CommunicationAdapter, DeliveryResult, InboundMessage, OutboundMessage } from "../communication/adapter.ts";
import type { LLMProvider } from "../llm/provider.ts";
import type { ModelConfig, ToolCall } from "../llm/types.ts";
import { PrimitiveDispatcher } from "../primitives/dispatcher.ts";
import type { PrimitiveContext } from "../primitives/types.ts";
import { SessionManager } from "../session/manager.ts";
import type { AgentSession } from "../session/session.ts";

const AUTHORIZATION_CODE_TIMEOUT_MS = 5 * 60 * 1000;

interface PendingAuthorizationCodeRequest {
  resolve: (authorizationCode: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
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
}

export class AgentRuntime {
  private readonly adapter: CommunicationAdapter;
  private readonly llmProvider: LLMProvider;
  private readonly modelConfig: ModelConfig;
  private readonly sessionManager: SessionManager;
  private readonly primitiveDispatcher: PrimitiveDispatcher;
  private readonly inboundQueue: InboundMessage[] = [];
  private pendingAuthorizationCodeRequest: PendingAuthorizationCodeRequest | null = null;
  private drainPromise: Promise<void> | null = null;
  private started = false;
  private shuttingDown = false;

  constructor(options: AgentRuntimeOptions) {
    this.adapter = options.adapter;
    this.llmProvider = options.llmProvider;
    this.modelConfig = options.modelConfig;
    this.sessionManager = options.sessionManager;
    this.primitiveDispatcher = options.primitiveDispatcher;
    this.primitiveDispatcher.setAuthorizationCodeHandler(async (message, context) => {
      return await this.requestAuthorizationCode(message, context);
    });
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

      if (this.pendingAuthorizationCodeRequest) {
        this.resolvePendingAuthorizationCodeRequest(message.content);
        return;
      }

      this.inboundQueue.push(message);
      this.ensureDrainLoop();
    });
  }

  async shutdown(timeoutMs = 30_000): Promise<boolean> {
    this.shuttingDown = true;
    this.rejectPendingAuthorizationCodeRequest("Runtime is shutting down.");
    return this.waitForIdle(timeoutMs);
  }

  async waitForIdle(timeoutMs = 30_000): Promise<boolean> {
    if (!this.drainPromise) {
      return true;
    }

    const drainPromise = this.drainPromise;
    const timeoutPromise = new Promise<false>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      void drainPromise.finally(() => clearTimeout(timer));
    });

    const drainResult = drainPromise.then(() => true);
    return await Promise.race([drainResult, timeoutPromise]);
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
        await this.processUserMessage(session, inbound);
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

  private async processUserMessage(session: AgentSession, inbound: InboundMessage): Promise<void> {
    session.appendUserMessage(inbound.content, inbound.timestamp);

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
        session.markWaitingForUser();
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
    if (this.shuttingDown) {
      throw new Error("Runtime is shutting down.");
    }

    const session = this.sessionManager.getSession(context.sessionId);
    if (!session || session.isTerminal()) {
      throw new Error(`Cannot request an OAuth authorization code for inactive session ${context.sessionId}.`);
    }

    if (this.pendingAuthorizationCodeRequest) {
      throw new Error("Another OAuth authorization request is already waiting for a user response.");
    }

    await this.adapter.send({
      sessionId: context.sessionId,
      mode: "ask",
      content: message,
      format: "plain",
    });

    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAuthorizationCodeRequest = null;
        reject(new Error("Timed out waiting for an OAuth authorization code from the user."));
      }, AUTHORIZATION_CODE_TIMEOUT_MS);

      this.pendingAuthorizationCodeRequest = {
        resolve,
        reject,
        timer,
      };
    });
  }

  private resolvePendingAuthorizationCodeRequest(content: string): void {
    const request = this.pendingAuthorizationCodeRequest;
    if (!request) {
      return;
    }

    this.pendingAuthorizationCodeRequest = null;
    clearTimeout(request.timer);

    const authorizationCode = content.trim();
    if (authorizationCode === "") {
      request.reject(new Error("Received an empty OAuth authorization code from the user."));
      return;
    }

    request.resolve(authorizationCode);
  }

  private rejectPendingAuthorizationCodeRequest(message: string): void {
    const request = this.pendingAuthorizationCodeRequest;
    if (!request) {
      return;
    }

    this.pendingAuthorizationCodeRequest = null;
    clearTimeout(request.timer);
    request.reject(new Error(message));
  }
}

function hasStreamSupport(adapter: CommunicationAdapter): adapter is StreamCapableAdapter {
  return "sendStreamChunk" in adapter && typeof adapter.sendStreamChunk === "function";
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
