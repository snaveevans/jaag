import type { PrimitiveResult } from "../primitives/types.ts";
import type { ToolSpecRegistry } from "../specs/registry.ts";

export function handleSpecGet(
  registry: ToolSpecRegistry,
  params: Record<string, unknown>,
): PrimitiveResult {
  const tool = typeof params.tool === "string" ? params.tool.trim() : "";
  if (tool === "") {
    return {
      success: false,
      error: "Missing tool: expected a tool id or tool name.",
    };
  }

  const registeredSpec = registry.getToolSpec(tool);
  if (!registeredSpec) {
    return {
      success: false,
      error: `Unknown tool spec: ${tool}`,
    };
  }

  const operationName = typeof params.operation === "string" ? params.operation.trim() : "";
  if (operationName !== "") {
    const operation = registeredSpec.operations.find(
      (candidate) => `${candidate.resourceName}.${candidate.operationName}` === operationName,
    );

    if (!operation) {
      return {
        success: false,
        error: `Operation ${operationName} not found on tool ${registeredSpec.spec.tool}.`,
      };
    }

    return {
      success: true,
      data: {
        tool: registeredSpec.spec.tool,
        trustTier: registeredSpec.trustTier,
        operation: {
          canonicalName: operation.canonicalName,
          providerName: operation.providerName,
          resource: operation.resourceName,
          name: operation.operationName,
          definition: operation.operation,
        },
      },
    };
  }

  return {
    success: true,
    data: {
      tool: registeredSpec.spec.tool,
      trustTier: registeredSpec.trustTier,
      spec: registeredSpec.spec,
    },
  };
}
