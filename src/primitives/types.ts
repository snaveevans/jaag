import type { DeliveryResult } from "../communication/adapter.ts";
import type { ToolDeclaration } from "../llm/types.ts";

export interface PrimitiveResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface PrimitiveContext {
  sessionId: string;
}

export interface PromptOptions {
  timeoutMs?: number;
}

export interface ApprovalRequestOptions extends PromptOptions {
  tool?: string;
  operation?: string;
  summary?: string;
  recordReceipt?: boolean;
}

export interface ApprovalReceiptLookup {
  tool: string;
  operation: string;
  now?: Date;
  maxAgeMs?: number;
}

export interface InteractionHandler {
  notify(message: string, context: PrimitiveContext): Promise<DeliveryResult>;
  ask(message: string, context: PrimitiveContext, options?: PromptOptions): Promise<string>;
  requestApproval(message: string, context: PrimitiveContext, options?: ApprovalRequestOptions): Promise<boolean>;
  hasApprovalReceipt(context: PrimitiveContext, criteria: ApprovalReceiptLookup): boolean;
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
    description:
      "Read a UTF-8 file or list a directory. Relative paths resolve against the workspace and files larger than 1MB are truncated with a notice.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to read. Supports absolute paths, ~/ paths, and workspace-relative paths.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "file_write",
    description:
      "Write full UTF-8 file contents to disk. Relative paths resolve against the workspace, parent directories are created, and protected runtime paths are blocked.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Destination path. Supports absolute paths, ~/ paths, and workspace-relative paths.",
        },
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
    description:
      "Use persistent SQLite-backed memory. Supports exact get/set/delete by domain+key plus FTS search and listing across stored memories.",
    parameters: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["get", "set", "search", "list", "delete"],
          description: "Memory operation to perform.",
        },
        key: { type: "string", description: "Key used by get, set, and delete." },
        value: { type: "string", description: "Value used by set." },
        query: { type: "string", description: "Full-text query used by search." },
        domain: {
          type: ["string", "null"],
          description:
            "Domain namespace. Use null for general memory. Omit it for search/list to scan all domains.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Optional max number of entries returned by search or list.",
        },
      },
      required: ["operation"],
      additionalProperties: false,
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
        tool: { type: "string", description: "Optional tool id associated with an approval request." },
        operation: { type: "string", description: "Optional tool operation associated with an approval request." },
      },
      required: ["mode", "message"],
      additionalProperties: true,
    },
  },
];
