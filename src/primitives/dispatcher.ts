import type { PrimitiveContext, PrimitiveResult } from "./types.ts";
import { RAW_PRIMITIVE_DECLARATIONS } from "./types.ts";
import { DEFAULT_AGENT_HOME } from "../config/schema.ts";
import { getDatabase } from "../db/database.ts";
import { createFileReadHandler, createFileWriteHandler } from "./file.ts";
import { createMemoryHandler } from "./memory.ts";

const KNOWN_PRIMITIVES = new Set(RAW_PRIMITIVE_DECLARATIONS.map((tool) => tool.name));

export interface PrimitiveDispatcherOptions {
  agentHome?: string;
  workspaceDir?: string;
  getDatabase?: typeof getDatabase;
}

export class PrimitiveDispatcher {
  private readonly handlers: Partial<Record<string, ReturnType<typeof createMemoryHandler>>>;

  constructor(options: PrimitiveDispatcherOptions = {}) {
    const agentHome = options.agentHome ?? DEFAULT_AGENT_HOME;
    const workspaceDir = options.workspaceDir ?? process.cwd();
    const getRuntimeDatabase = options.getDatabase ?? ((databaseOptions) => getDatabase(databaseOptions));

    this.handlers = {
      file_read: createFileReadHandler({
        agentHome,
        workspaceDir,
      }),
      file_write: createFileWriteHandler({
        agentHome,
        workspaceDir,
      }),
      memory: createMemoryHandler({
        getDatabase: () => getRuntimeDatabase({ agentHome }),
      }),
    };
  }

  async dispatch(
    primitiveName: string,
    params: Record<string, unknown>,
    context: PrimitiveContext,
  ): Promise<PrimitiveResult> {
    if (!KNOWN_PRIMITIVES.has(primitiveName)) {
      return {
        success: false,
        error: `Unknown primitive: ${primitiveName}`,
      };
    }

    const handler = this.handlers[primitiveName];
    if (handler) {
      return await handler(params, context);
    }

    return {
      success: false,
      error: "Primitive not implemented yet",
    };
  }
}
