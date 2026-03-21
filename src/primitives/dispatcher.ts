import type { PrimitiveContext, PrimitiveHandler, PrimitiveResult } from "./types.ts";
import { RAW_PRIMITIVE_DECLARATIONS } from "./types.ts";
import { DEFAULT_AGENT_HOME } from "../config/schema.ts";
import { getDatabase } from "../db/database.ts";
import { createFileReadHandler, createFileWriteHandler } from "./file.ts";
import { createMemoryHandler } from "./memory.ts";
import type { AuthDependencies } from "../interpreter/auth.ts";
import { ToolSpecRegistry } from "../specs/registry.ts";
import { ToolSpecInterpreter } from "../interpreter/pipeline.ts";
import { SYSTEM_TOOL_DECLARATIONS, SystemToolHandler } from "../system-tools/handler.ts";

const KNOWN_PRIMITIVES = new Set(RAW_PRIMITIVE_DECLARATIONS.map((tool) => tool.name));

export interface PrimitiveDispatcherOptions {
  agentHome?: string;
  workspaceDir?: string;
  getDatabase?: typeof getDatabase;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  seedTrustedSpecs?: boolean;
}

export class PrimitiveDispatcher {
  private readonly handlers: Partial<Record<string, PrimitiveHandler>>;
  private readonly registry: ToolSpecRegistry;
  private readonly systemToolHandler: SystemToolHandler;
  private readonly interpreter: ToolSpecInterpreter;

  constructor(options: PrimitiveDispatcherOptions = {}) {
    const agentHome = options.agentHome ?? DEFAULT_AGENT_HOME;
    const workspaceDir = options.workspaceDir ?? process.cwd();
    const getRuntimeDatabase = options.getDatabase ?? ((databaseOptions) => getDatabase(databaseOptions));
    const memoryHandler = createMemoryHandler({
      getDatabase: () => getRuntimeDatabase({ agentHome }),
    });
    const registry = new ToolSpecRegistry({
      agentHome,
      seedTrustedSpecs: options.seedTrustedSpecs,
    });
    const interpreter = new ToolSpecInterpreter({
      registry,
      fetchImpl: options.fetchImpl,
      sleep: options.sleep,
      auth: {
        env: options.env,
        fetchImpl: options.fetchImpl,
        memory: createMemoryAccessor(memoryHandler),
      },
    });

    this.registry = registry;
    this.systemToolHandler = new SystemToolHandler({ registry });
    this.interpreter = interpreter;
    this.handlers = {
      http: async (params) => await interpreter.executeRawHttp(params),
      file_read: createFileReadHandler({
        agentHome,
        workspaceDir,
      }),
      file_write: createFileWriteHandler({
        agentHome,
        workspaceDir,
      }),
      memory: memoryHandler,
    };
  }

  getToolDeclarations() {
    return [
      ...RAW_PRIMITIVE_DECLARATIONS,
      ...SYSTEM_TOOL_DECLARATIONS,
      ...this.registry.getToolDeclarations(),
    ];
  }

  listToolManifests() {
    return this.registry.listToolManifests();
  }

  setAuthorizationCodeHandler(handler: AuthDependencies["askForAuthorizationCode"] | undefined): void {
    this.interpreter.setAuthorizationCodeHandler(handler);
  }

  async dispatch(
    primitiveName: string,
    params: Record<string, unknown>,
    context: PrimitiveContext,
  ): Promise<PrimitiveResult> {
    if (KNOWN_PRIMITIVES.has(primitiveName)) {
      const handler = this.handlers[primitiveName];
      if (handler) {
        return await handler(params, context);
      }

      return {
        success: false,
        error: "Primitive not implemented yet",
      };
    }

    if (this.systemToolHandler.canHandle(primitiveName)) {
      return await this.systemToolHandler.dispatch(primitiveName, params, context);
    }

    if (this.registry.getOperation(primitiveName)) {
      return await this.interpreter.executeOperation(primitiveName, params, context);
    }

    return {
      success: false,
      error: `Unknown primitive or tool: ${primitiveName}`,
    };
  }
}

function createMemoryAccessor(memoryHandler: PrimitiveHandler) {
  return {
    async get(domain: string | null, key: string, context: PrimitiveContext): Promise<string | null> {
      const result = await memoryHandler(
        {
          operation: "get",
          domain,
          key,
        },
        context,
      );

      if (!result.success) {
        throw new Error(result.error ?? `Failed to get memory key ${key}.`);
      }

      const entry = (result.data as { entry?: { value?: string } | null } | undefined)?.entry;
      return typeof entry?.value === "string" ? entry.value : null;
    },

    async set(domain: string | null, key: string, value: string, context: PrimitiveContext): Promise<void> {
      const result = await memoryHandler(
        {
          operation: "set",
          domain,
          key,
          value,
        },
        context,
      );

      if (!result.success) {
        throw new Error(result.error ?? `Failed to set memory key ${key}.`);
      }
    },
  };
}
