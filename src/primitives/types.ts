import type { ToolDeclaration } from "../llm/types.ts";

export interface PrimitiveResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface PrimitiveContext {
  sessionId: string;
}

export type PrimitiveHandler = (
  params: Record<string, unknown>,
  context: PrimitiveContext,
) => Promise<PrimitiveResult>;

export const RAW_PRIMITIVE_DECLARATIONS: ToolDeclaration[] = [
  {
    name: "http",
    description: "Perform a raw HTTP request when no higher-level tool exists.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute request URL." },
        method: { type: "string", description: "HTTP method such as GET or POST." },
        headers: { type: "object", description: "Optional request headers." },
        body: { description: "Optional request body." },
      },
      required: ["url", "method"],
      additionalProperties: true,
    },
  },
  {
    name: "file_read",
    description: "Read a file or list a directory path on disk.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to read." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "file_write",
    description: "Write content to a file path on disk.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Destination path." },
        content: { type: "string", description: "Full file content to write." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "execute",
    description: "Run a shell command in the agent workspace.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute." },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "memory",
    description: "Read, write, search, list, or delete memory entries.",
    parameters: {
      type: "object",
      properties: {
        operation: { type: "string", description: "Memory operation such as get, set, or search." },
        key: { type: "string", description: "Optional memory key." },
        value: { description: "Optional value for writes." },
        query: { type: "string", description: "Optional search query." },
        domain: { type: ["string", "null"], description: "Optional memory domain." },
      },
      required: ["operation"],
      additionalProperties: true,
    },
  },
  {
    name: "schedule",
    description: "Create, update, inspect, or delete schedules.",
    parameters: {
      type: "object",
      properties: {
        operation: { type: "string", description: "Schedule operation such as create, get, list, or delete." },
      },
      required: ["operation"],
      additionalProperties: true,
    },
  },
  {
    name: "interact",
    description: "Ask the user a question, show a notification, or request approval.",
    parameters: {
      type: "object",
      properties: {
        mode: { type: "string", description: "Interaction mode: ask, notify, or approve." },
        message: { type: "string", description: "Text shown to the user." },
      },
      required: ["mode", "message"],
      additionalProperties: true,
    },
  },
];
