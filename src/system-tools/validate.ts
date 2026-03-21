import type { PrimitiveResult } from "../primitives/types.ts";
import type { ToolSpecRegistry } from "../specs/registry.ts";

export function handleSpecValidate(
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
    const result = registry.validateSpec(params.spec);
    return {
      success: true,
      data: {
        valid: result.valid,
        errors: result.errors,
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
