import OpenAI, { APIError } from "openai";
import type { LLMProvider } from "./provider.ts";
import type { InternalMessage, ModelConfig, StreamChunk, ToolCall, ToolDeclaration } from "./types.ts";

interface ToolCallState {
  key: string;
  toolCall: ToolCall;
}

export class OpenAICompatibleProvider implements LLMProvider {
  async *stream(
    messages: InternalMessage[],
    tools: ToolDeclaration[],
    config: ModelConfig,
  ): AsyncIterable<StreamChunk> {
    const client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });
    const toolNameMap = buildToolNameMap(tools);

    const toolCallState = new Map<number, ToolCallState>();
    let emittedToolCallEnd = false;

    try {
      const response = await client.chat.completions.create({
        model: config.model,
        messages: toOpenAIMessages(messages, toolNameMap) as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        tools: toOpenAITools(tools) as unknown as OpenAI.Chat.Completions.ChatCompletionTool[],
        temperature: config.temperature,
        max_tokens: config.maxOutputTokens,
        stream: true,
      });

      for await (const chunk of response) {
        const choice = chunk.choices[0];
        if (!choice) {
          continue;
        }

        const delta = choice.delta;

        if (delta.content) {
          yield { type: "text", content: delta.content };
        }

        for (const toolCallDelta of delta.tool_calls ?? []) {
          const current = toolCallState.get(toolCallDelta.index) ?? {
            key: `tool_call_${toolCallDelta.index}`,
            toolCall: {
              id: toolCallDelta.id ?? `tool_call_${toolCallDelta.index}`,
              name: "",
              arguments: "",
            },
          };
          const isNew = !toolCallState.has(toolCallDelta.index);

          if (toolCallDelta.id) {
            current.toolCall.id = toolCallDelta.id;
          }

          if (toolCallDelta.function?.name) {
            current.toolCall.name += toolCallDelta.function.name;
          }

          if (toolCallDelta.function?.arguments) {
            current.toolCall.arguments += toolCallDelta.function.arguments;
          }

          toolCallState.set(toolCallDelta.index, current);

          if (isNew) {
            yield {
              type: "tool_call_start",
              toolCallKey: current.key,
              toolCall: decodeToolCall(current.toolCall, toolNameMap),
            };
          }

          yield {
            type: "tool_call_delta",
            toolCallKey: current.key,
            toolCall: decodeToolCall(current.toolCall, toolNameMap),
          };
        }

        if (choice.finish_reason === "tool_calls" && !emittedToolCallEnd) {
          emittedToolCallEnd = true;
          for (const [, toolCall] of [...toolCallState.entries()].sort((left, right) => left[0] - right[0])) {
            yield {
              type: "tool_call_end",
              toolCallKey: toolCall.key,
              toolCall: decodeToolCall(toolCall.toolCall, toolNameMap),
            };
          }
        }
      }

      if (toolCallState.size > 0 && !emittedToolCallEnd) {
        for (const [, toolCall] of [...toolCallState.entries()].sort((left, right) => left[0] - right[0])) {
          yield {
            type: "tool_call_end",
            toolCallKey: toolCall.key,
            toolCall: decodeToolCall(toolCall.toolCall, toolNameMap),
          };
        }
      }

      yield { type: "done" };
    } catch (error) {
      if (error instanceof APIError) {
        throw new Error(
          `OpenAI-compatible API error (${error.status ?? "unknown"}): ${error.message}`,
        );
      }

      throw new Error(`OpenAI-compatible request failed: ${toErrorMessage(error)}`);
    }
  }
}

interface ToolNameMap {
  canonicalToProvider: Map<string, string>;
  providerToCanonical: Map<string, string>;
}

function toOpenAIMessages(messages: InternalMessage[], toolNameMap: ToolNameMap): Array<Record<string, unknown>> {
  return messages.map((message) => {
    if (message.role === "tool_result") {
      return {
        role: "tool",
        content: message.content,
        tool_call_id: message.toolResultId,
      };
    }

    if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
      return {
        role: "assistant",
        content: message.content === "" ? null : message.content,
        tool_calls: message.toolCalls.map((toolCall) => ({
          id: toolCall.id,
          type: "function",
          function: {
            name: resolveProviderToolName(toolCall.name, toolNameMap),
            arguments: toolCall.arguments,
          },
        })),
      };
    }

    return {
      role: message.role,
      content: message.content,
    };
  });
}

function toOpenAITools(tools: ToolDeclaration[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.providerName ?? encodeToolName(tool.name),
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function decodeToolCall(toolCall: ToolCall, toolNameMap: ToolNameMap): ToolCall {
  return {
    id: toolCall.id,
    name: toolNameMap.providerToCanonical.get(toolCall.name) ?? decodeToolName(toolCall.name),
    arguments: toolCall.arguments,
  };
}

function buildToolNameMap(tools: ToolDeclaration[]): ToolNameMap {
  const canonicalToProvider = new Map<string, string>();
  const providerToCanonical = new Map<string, string>();

  for (const tool of tools) {
    const providerName = tool.providerName ?? encodeToolName(tool.name);
    canonicalToProvider.set(tool.name, providerName);
    providerToCanonical.set(providerName, tool.name);
  }

  return {
    canonicalToProvider,
    providerToCanonical,
  };
}

function resolveProviderToolName(name: string, toolNameMap: ToolNameMap): string {
  return toolNameMap.canonicalToProvider.get(name) ?? encodeToolName(name);
}

export function encodeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, (character) => `_x${character.charCodeAt(0).toString(16)}_`);
}

export function decodeToolName(name: string): string {
  return name.replace(/_x([0-9a-f]+)_/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
