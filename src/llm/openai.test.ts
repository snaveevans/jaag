import { afterEach, describe, expect, test } from "bun:test";
import { OpenAICompatibleProvider } from "./openai.ts";
import type { InternalMessage, StreamChunk, ToolDeclaration } from "./types.ts";

const servers: Bun.Server<unknown>[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    servers.pop()?.stop(true);
  }
});

describe("OpenAICompatibleProvider", () => {
  test("translates messages/tools and parses SSE tool call chunks", async () => {
    let requestBody: Record<string, unknown> | undefined;

    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        requestBody = (await request.json()) as Record<string, unknown>;
        return new Response(buildSseBody(), {
          headers: {
            "content-type": "text/event-stream",
          },
        });
      },
    });
    servers.push(server);

    const provider = new OpenAICompatibleProvider();
    const chunks: StreamChunk[] = [];
    const messages: InternalMessage[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "read the file" },
      {
        role: "assistant",
        content: "Calling a tool",
        toolCalls: [{ id: "call-1", name: "file_read", arguments: '{"path":"notes.txt"}' }],
      },
      { role: "tool_result", toolResultId: "call-1", content: '{"success":false}' },
    ];
    const tools: ToolDeclaration[] = [
      {
        name: "file.read",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
          },
          required: ["path"],
        },
      },
    ];

    for await (const chunk of provider.stream(messages, tools, {
      model: "gpt-4o-mini",
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      temperature: 0,
      maxOutputTokens: 128,
      apiKey: "test-key",
    })) {
      chunks.push(chunk);
    }

    expect(requestBody?.model).toBe("gpt-4o-mini");
    expect(requestBody?.stream).toBe(true);

    const sentMessages = requestBody?.messages as Array<Record<string, unknown>>;
    expect(sentMessages[2]?.tool_calls).toBeArray();
    expect(sentMessages[3]?.role).toBe("tool");

    const sentTools = requestBody?.tools as Array<Record<string, unknown>>;
    expect(sentTools[0]?.function).toMatchObject({ name: "file_x2e_read" });

    expect(chunks).toEqual([
      { type: "text", content: "Working on it." },
      {
        type: "tool_call_start",
        toolCallKey: "tool_call_0",
        toolCall: { id: "call_1", name: "file.read", arguments: "" },
      },
      {
        type: "tool_call_delta",
        toolCallKey: "tool_call_0",
        toolCall: { id: "call_1", name: "file.read", arguments: "" },
      },
      {
        type: "tool_call_delta",
        toolCallKey: "tool_call_0",
        toolCall: { id: "call_1", name: "file.read", arguments: '{"path":"no' },
      },
      {
        type: "tool_call_delta",
        toolCallKey: "tool_call_0",
        toolCall: { id: "call_1", name: "file.read", arguments: '{"path":"notes.txt"}' },
      },
      {
        type: "tool_call_end",
        toolCallKey: "tool_call_0",
        toolCall: { id: "call_1", name: "file.read", arguments: '{"path":"notes.txt"}' },
      },
      { type: "done" },
    ]);
  });

  test("serializes assistant tool-call messages without empty string content", async () => {
    let requestBody: Record<string, unknown> | undefined;

    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        requestBody = (await request.json()) as Record<string, unknown>;
        return new Response(buildSseBody([]), {
          headers: {
            "content-type": "text/event-stream",
          },
        });
      },
    });
    servers.push(server);

    const provider = new OpenAICompatibleProvider();

    for await (const _chunk of provider.stream([
      { role: "user", content: "run the schedule" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-1", name: "interact", arguments: '{"mode":"notify"}' }],
      },
      { role: "tool_result", toolResultId: "call-1", content: '{"ok":true}' },
    ], [{
      name: "interact",
      description: "Send a notification to the user",
      parameters: {
        type: "object",
        properties: {
          mode: { type: "string" },
        },
        required: ["mode"],
      },
    }], {
      model: "gpt-4o-mini",
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      temperature: 0,
      maxOutputTokens: 128,
      apiKey: "test-key",
    })) {
      // Consume stream to completion so the request is sent.
    }

    const sentMessages = requestBody?.messages as Array<Record<string, unknown>>;
    expect(sentMessages[1]).toMatchObject({
      role: "assistant",
      tool_calls: [{
        id: "call-1",
        type: "function",
        function: {
          name: "interact",
          arguments: '{"mode":"notify"}',
        },
      }],
    });
    expect(sentMessages[1]?.content).toBeNull();
    expect(sentMessages[1]?.content).not.toBe("");
  });

  test("keeps a stable tool-call key when the provider id arrives later", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(buildSseBody([
          'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"type":"function","function":{"name":"file_x2e_read"}}]},"finish_reason":null}]}\n\n',
          'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"no"}}]},"finish_reason":null}]}\n\n',
          'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_late","function":{"arguments":"tes.txt\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
          "data: [DONE]\n\n",
        ]), {
          headers: {
            "content-type": "text/event-stream",
          },
        }),
    });
    servers.push(server);

    const provider = new OpenAICompatibleProvider();
    const chunks: StreamChunk[] = [];

    for await (const chunk of provider.stream([{ role: "user", content: "read the file" }], [], {
      model: "gpt-4o-mini",
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      temperature: 0,
      maxOutputTokens: 128,
      apiKey: "test-key",
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      {
        type: "tool_call_start",
        toolCallKey: "tool_call_0",
        toolCall: { id: "tool_call_0", name: "file.read", arguments: "" },
      },
      {
        type: "tool_call_delta",
        toolCallKey: "tool_call_0",
        toolCall: { id: "tool_call_0", name: "file.read", arguments: "" },
      },
      {
        type: "tool_call_delta",
        toolCallKey: "tool_call_0",
        toolCall: { id: "tool_call_0", name: "file.read", arguments: '{"path":"no' },
      },
      {
        type: "tool_call_delta",
        toolCallKey: "tool_call_0",
        toolCall: { id: "call_late", name: "file.read", arguments: '{"path":"notes.txt"}' },
      },
      {
        type: "tool_call_end",
        toolCallKey: "tool_call_0",
        toolCall: { id: "call_late", name: "file.read", arguments: '{"path":"notes.txt"}' },
      },
      { type: "done" },
    ]);
  });
});

function buildSseBody(frames = [
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Working on it."},"finish_reason":null}]}\n\n',
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"file_x2e_read"}}]},"finish_reason":null}]}\n\n',
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"no"}}]},"finish_reason":null}]}\n\n',
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"tes.txt\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
  "data: [DONE]\n\n",
]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });
}
