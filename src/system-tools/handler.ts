import type { ToolDeclaration } from "../llm/types.ts";
import type { PrimitiveContext, PrimitiveResult } from "../primitives/types.ts";
import type { ToolSpecRegistry } from "../specs/registry.ts";
import { handleSpecGet } from "./get.ts";
import { handleSpecList } from "./list.ts";
import { handleSpecRegister } from "./register.ts";
import { handleSpecValidate } from "./validate.ts";

export const SYSTEM_TOOL_DECLARATIONS: ToolDeclaration[] = [
  {
    name: "spec.validate",
    providerName: "spec_validate",
    description: "Validate a tool spec JSON document without registering it.",
    parameters: {
      type: "object",
      properties: {
        spec: {
          description: "Tool spec as a JSON object or JSON string.",
        },
      },
      required: ["spec"],
      additionalProperties: false,
    },
  },
  {
    name: "spec.register",
    providerName: "spec_register",
    description: "Validate and register a tool spec into the untrusted tier.",
    parameters: {
      type: "object",
      properties: {
        spec: {
          description: "Tool spec as a JSON object or JSON string.",
        },
      },
      required: ["spec"],
      additionalProperties: false,
    },
  },
  {
    name: "spec.list",
    providerName: "spec_list",
    description: "List installed tool specs with trust tiers and operation manifests.",
    parameters: {
      type: "object",
      properties: {
        trustTier: {
          type: "string",
          enum: ["trusted", "user-reviewed", "untrusted"],
          description: "Optional trust tier filter.",
        },
        name: {
          type: "string",
          description: "Optional tool id or name filter.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "spec.get",
    providerName: "spec_get",
    description: "Get a full tool spec or a single operation definition.",
    parameters: {
      type: "object",
      properties: {
        tool: {
          type: "string",
          description: "Tool id or exact tool name.",
        },
        operation: {
          type: "string",
          description: "Optional operation id in resource.operation form.",
        },
      },
      required: ["tool"],
      additionalProperties: false,
    },
  },
];

const SYSTEM_TOOL_NAMES = new Set(SYSTEM_TOOL_DECLARATIONS.map((tool) => tool.name));

export interface SystemToolHandlerOptions {
  registry: ToolSpecRegistry;
}

export class SystemToolHandler {
  private readonly registry: ToolSpecRegistry;

  constructor(options: SystemToolHandlerOptions) {
    this.registry = options.registry;
  }

  canHandle(name: string): boolean {
    return SYSTEM_TOOL_NAMES.has(name);
  }

  async dispatch(
    name: string,
    params: Record<string, unknown>,
    _context: PrimitiveContext,
  ): Promise<PrimitiveResult> {
    try {
      switch (name) {
        case "spec.validate":
          return handleSpecValidate(this.registry, params);
        case "spec.register":
          return handleSpecRegister(this.registry, params);
        case "spec.list":
          return handleSpecList(this.registry, params);
        case "spec.get":
          return handleSpecGet(this.registry, params);
        default:
          return {
            success: false,
            error: `Unknown system tool: ${name}`,
          };
      }
    } catch (error) {
      return {
        success: false,
        error: toErrorMessage(error),
      };
    }
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
