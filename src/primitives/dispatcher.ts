import type { PrimitiveContext, PrimitiveResult } from "./types.ts";
import { RAW_PRIMITIVE_DECLARATIONS } from "./types.ts";

const KNOWN_PRIMITIVES = new Set(RAW_PRIMITIVE_DECLARATIONS.map((tool) => tool.name));

export class PrimitiveDispatcher {
  async dispatch(
    primitiveName: string,
    _params: Record<string, unknown>,
    _context: PrimitiveContext,
  ): Promise<PrimitiveResult> {
    if (!KNOWN_PRIMITIVES.has(primitiveName)) {
      return {
        success: false,
        error: `Unknown primitive: ${primitiveName}`,
      };
    }

    return {
      success: false,
      error: "Primitive not implemented yet",
    };
  }
}
