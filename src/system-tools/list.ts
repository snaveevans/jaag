import type { PrimitiveResult } from "../primitives/types.ts";
import type { ToolSpecRegistry } from "../specs/registry.ts";
import type { TrustTier } from "../specs/types.ts";

export function handleSpecList(
  registry: ToolSpecRegistry,
  params: Record<string, unknown>,
): PrimitiveResult {
  const trustTier = parseTrustTier(params.trustTier);
  const name = typeof params.name === "string" ? params.name : undefined;

  return {
    success: true,
    data: {
      tools: registry.listToolManifests({
        trustTier,
        name,
      }),
    },
  };
}

function parseTrustTier(value: unknown): TrustTier | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === "trusted" || value === "user-reviewed" || value === "untrusted") {
    return value;
  }

  throw new Error("Invalid trustTier filter.");
}
