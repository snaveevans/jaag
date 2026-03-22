import type { DeliveryResult } from "../communication/adapter.ts";
import type { ToolDeclaration } from "../llm/types.ts";

export interface PrimitiveResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface PrimitiveContext {
  sessionId: string;
  triggerSource?: "user" | "schedule";
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

export interface ApprovalDecision {
  approved: boolean | null;
  response: string | null;
  error?: string;
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
  requestApproval(message: string, context: PrimitiveContext, options?: ApprovalRequestOptions): Promise<ApprovalDecision>;
  hasApprovalReceipt(context: PrimitiveContext, criteria: ApprovalReceiptLookup): boolean;
}

export class InteractionTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InteractionTimeoutError";
  }
}

export type PrimitiveHandler = (
  params: Record<string, unknown>,
  context: PrimitiveContext,
) => Promise<PrimitiveResult>;

const SCHEDULE_STATUS_ENUM = ["active", "paused", "completed", "failed"];
const SCHEDULE_FILTER_TRIGGER_TYPE_ENUM = ["cron", "once", "event"];

export const RAW_PRIMITIVE_DECLARATIONS: ToolDeclaration[] = [
  {
    name: "http",
    description: "Perform a raw HTTP request as an escape hatch when no higher-level tool exists.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          minLength: 1,
          pattern: "^https?://",
          description: "Absolute request URL starting with http:// or https://.",
        },
        method: {
          type: "string",
          minLength: 1,
          description: "HTTP method such as GET, POST, PUT, PATCH, or DELETE.",
        },
        headers: {
          type: "object",
          description: "Optional request headers as an object of string values.",
          additionalProperties: { type: "string" },
        },
        body: { description: "Optional request body." },
      },
      required: ["url", "method"],
      additionalProperties: false,
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
        operation: {
          type: "string",
          enum: ["create", "get", "list", "update", "delete"],
          description: "Schedule operation to perform.",
        },
        schedule_id: {
          type: "string",
          description: "Schedule identifier used by get, update, or delete. Alias of id.",
        },
        id: {
          type: "string",
          description: "Schedule identifier used by get, update, or delete. Alias of schedule_id.",
        },
        workflow: {
          type: "string",
          description: "Workflow name associated with the schedule.",
        },
        group: {
          type: ["string", "null"],
          description: "Optional group label for create/update, or group selector for delete.",
        },
        trigger: {
          type: "object",
          description: "Trigger definition for create or update operations.",
          properties: {
            type: {
              type: "string",
              enum: ["cron", "once"],
              description: "Supported trigger type.",
            },
            cron: {
              type: "string",
              description: "Cron expression for cron schedules. Alias of trigger.expression.",
            },
            expression: {
              type: "string",
              description: "Cron expression for cron schedules.",
            },
            at: {
              type: "string",
              description: "RFC 3339 timestamp for once schedules.",
            },
            description: {
              type: "string",
              description: "Optional human-readable description for the trigger.",
            },
          },
          required: ["type"],
          additionalProperties: false,
        },
        instruction: {
          type: "string",
          description: "Instruction for the scheduled workflow. Can also be supplied as context.instruction.",
        },
        context: {
          type: "object",
          description: "Schedule context payload merged into the triggered session.",
          properties: {
            instruction: {
              type: "string",
              description: "Instruction for the scheduled workflow when provided inside context.",
            },
          },
          additionalProperties: true,
        },
        status: {
          type: "string",
          enum: SCHEDULE_STATUS_ENUM,
          description: "Schedule status for create, update, or list filtering.",
        },
        trigger_type: {
          type: "string",
          enum: SCHEDULE_FILTER_TRIGGER_TYPE_ENUM,
          description: "Optional top-level trigger type filter for list operations.",
        },
        filters: {
          type: "object",
          description: "Optional list filters. Top-level workflow/group/status/trigger_type are also accepted.",
          properties: {
            workflow: {
              type: "string",
              description: "Filter schedules by workflow.",
            },
            group: {
              type: "string",
              description: "Filter schedules by group label.",
            },
            status: {
              type: "string",
              enum: SCHEDULE_STATUS_ENUM,
              description: "Filter schedules by status.",
            },
            trigger_type: {
              type: "string",
              enum: SCHEDULE_FILTER_TRIGGER_TYPE_ENUM,
              description: "Filter schedules by trigger type.",
            },
          },
          additionalProperties: false,
        },
      },
      required: ["operation"],
      additionalProperties: false,
    },
  },
  {
    name: "interact",
    description: "Ask the user a question, show a notification, or request approval. For approval requests, instruct the user to reply exactly yes or no.",
    parameters: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["notify", "ask", "approve"],
          description: "Interaction mode to perform.",
        },
        message: { type: "string", description: "Text shown to the user." },
        tool: {
          type: "string",
          description: "Optional tool id associated with an approval request.",
        },
        operation: {
          type: "string",
          description: "Optional tool operation associated with an approval request.",
        },
      },
      required: ["mode", "message"],
      additionalProperties: false,
    },
  },
];
