import type { PrimitiveResult } from "../primitives/types.ts";
import type { ToolSpecRegistry } from "../specs/registry.ts";

export function handleSpecRegister(
  registry: ToolSpecRegistry,
  params: Record<string, unknown>,
): PrimitiveResult {
  if (!("spec" in params)) {
    return {
      success: false,
      error: "Missing spec: expected a tool spec object or JSON string.",
    };
  }

  try {
    const validation = registry.validateSpec(params.spec);
    if (!validation.valid) {
      return {
        success: false,
        error: "Spec validation failed.",
        data: {
          valid: false,
          errors: validation.errors,
        },
      };
    }

    const registeredSpec = registry.registerUntrustedSpec(params.spec);
    return {
      success: true,
      data: {
        tool: registeredSpec.spec.tool,
        trustTier: registeredSpec.trustTier,
        sourcePath: registeredSpec.sourcePath,
        operations: registeredSpec.operations.map((operation) => ({
          canonicalName: operation.canonicalName,
          providerName: operation.providerName,
        })),
      },
    };
  } catch (error) {
    return {
      success: false,
      error: toErrorMessage(error),
    };
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
