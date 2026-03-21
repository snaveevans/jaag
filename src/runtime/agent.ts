import type { CommunicationAdapter, DeliveryResult, InboundMessage, OutboundMessage } from "../communication/adapter.ts";
import type { LLMProvider } from "../llm/provider.ts";
import type { ModelConfig, ToolCall } from "../llm/types.ts";
import { RAW_PRIMITIVE_DECLARATIONS } from "../primitives/types.ts";
import { PrimitiveDispatcher } from "../primitives/dispatcher.ts";
import { SessionManager } from "../session/manager.ts";
import type { AgentSession } from "../session/session.ts";

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
  private drainPromise: Promise<void> | null = null;
  private started = false;
  private shuttingDown = false;

  constructor(options: AgentRuntimeOptions) {
    this.adapter = options.adapter;
    this.llmProvider = options.llmProvider;
    this.modelConfig = options.modelConfig;
    this.sessionManager = options.sessionManager;
    this.primitiveDispatcher = options.primitiveDispatcher;
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

      this.inboundQueue.push(message);
      this.ensureDrainLoop();
    });
  }

  async shutdown(timeoutMs = 30_000): Promise<boolean> {
    this.shuttingDown = true;
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

      for await (const chunk of this.llmProvider.stream(
        session.messages,
        RAW_PRIMITIVE_DECLARATIONS,
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
