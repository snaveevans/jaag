import { dirname } from "node:path";
import type { PrimitiveContext, PrimitiveHandler, PrimitiveResult, InteractionHandler } from "./types.ts";
import { RAW_PRIMITIVE_DECLARATIONS } from "./types.ts";
import { DEFAULT_AGENT_HOME } from "../config/schema.ts";
import { getDatabase } from "../db/database.ts";
import { createFileReadHandler, createFileWriteHandler, resolveEffectiveFilePath, type FileHandlerOptions } from "./file.ts";
import { createMemoryHandler } from "./memory.ts";
import type { AuthDependencies } from "../interpreter/auth.ts";
import { ToolSpecRegistry } from "../specs/registry.ts";
import { ToolSpecInterpreter } from "../interpreter/pipeline.ts";
import { buildRawHttpRequest, buildSpecHttpRequest, validateAndNormalizeOperationInput } from "../interpreter/request-builder.ts";
import { SYSTEM_TOOL_DECLARATIONS, SystemToolHandler } from "../system-tools/handler.ts";
import { isPolicyExemptPrimitive, PolicyEngine } from "../policy/engine.ts";
import { loadPolicy } from "../policy/loader.ts";
import { PolicyRateLimiter } from "../policy/rate-limiter.ts";
import type { LoadedPolicy, PolicyEvaluationContext } from "../policy/types.ts";

const KNOWN_PRIMITIVES = new Set(RAW_PRIMITIVE_DECLARATIONS.map((tool) => tool.name));

export interface PrimitiveDispatcherOptions {
  agentHome?: string;
  workspaceDir?: string;
  homeDir?: string;
  policyPath?: string;
  policy?: LoadedPolicy;
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
  private readonly policy: LoadedPolicy;
  private readonly policyEngine: PolicyEngine;
  private readonly fileHandlerOptions: FileHandlerOptions;
  private interactionHandler: InteractionHandler | undefined;

  constructor(options: PrimitiveDispatcherOptions = {}) {
    const agentHome = options.agentHome ?? DEFAULT_AGENT_HOME;
    const workspaceDir = options.workspaceDir ?? process.cwd();
    const homeDir = options.homeDir ?? dirname(agentHome);
    const getRuntimeDatabase = options.getDatabase ?? ((databaseOptions) => getDatabase(databaseOptions));
    const runtimeDatabase = getRuntimeDatabase({ agentHome });
    const fileHandlerOptions = {
      agentHome,
      workspaceDir,
      homeDir,
    } satisfies FileHandlerOptions;
    const memoryHandler = createMemoryHandler({
      getDatabase: () => runtimeDatabase,
    });
    const registry = new ToolSpecRegistry({
      agentHome,
      seedTrustedSpecs: options.seedTrustedSpecs,
    });
    const policy = options.policy ?? loadPolicy({
      agentHome,
      homeDir,
      policyPath: options.policyPath,
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
    this.policy = policy;
    this.fileHandlerOptions = fileHandlerOptions;
    this.policyEngine = new PolicyEngine({
      policy,
      workspaceDir,
      homeDir,
      rateLimiter: new PolicyRateLimiter({ database: runtimeDatabase }),
    });
    this.handlers = {
      http: async (params) => await interpreter.executeRawHttp(params),
      file_read: createFileReadHandler(fileHandlerOptions),
      file_write: createFileWriteHandler(fileHandlerOptions),
      memory: memoryHandler,
      interact: createInteractHandler(() => this.interactionHandler),
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

  getPolicySummary(): string {
    return this.policy.summary;
  }

  setAuthorizationCodeHandler(handler: AuthDependencies["askForAuthorizationCode"] | undefined): void {
    this.interpreter.setAuthorizationCodeHandler(handler);
  }

  setInteractionHandler(handler: InteractionHandler | undefined): void {
    this.interactionHandler = handler;
    this.policyEngine.setInteractionHandler(handler);
  }

  async dispatch(
    primitiveName: string,
    params: Record<string, unknown>,
    context: PrimitiveContext,
  ): Promise<PrimitiveResult> {
    if (KNOWN_PRIMITIVES.has(primitiveName)) {
      const policyResult = await this.enforcePrimitivePolicy(primitiveName, params, context);
      if (policyResult) {
        return policyResult;
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

    if (this.systemToolHandler.canHandle(primitiveName)) {
      return await this.systemToolHandler.dispatch(primitiveName, params, context);
    }

    if (this.registry.getOperation(primitiveName)) {
      const policyResult = await this.enforceOperationPolicy(primitiveName, params, context);
      if (policyResult) {
        return policyResult;
      }

      return await this.interpreter.executeOperation(primitiveName, params, context);
    }

    return {
      success: false,
      error: `Unknown primitive or tool: ${primitiveName}`,
    };
  }

  private async enforcePrimitivePolicy(
    primitiveName: string,
    params: Record<string, unknown>,
    context: PrimitiveContext,
  ): Promise<PrimitiveResult | null> {
    if (isPolicyExemptPrimitive(primitiveName)) {
      return null;
    }

    const policyContext = await buildPrimitivePolicyContext(primitiveName, params, this.fileHandlerOptions);
    if (!policyContext) {
      return null;
    }

    return await this.applyPolicy(policyContext, context);
  }

  private async enforceOperationPolicy(
    primitiveName: string,
    params: Record<string, unknown>,
    context: PrimitiveContext,
  ): Promise<PrimitiveResult | null> {
    const resolvedOperation = this.registry.getOperation(primitiveName);
    if (!resolvedOperation || resolvedOperation.operation.primitive !== "http") {
      return null;
    }

    const policyContext = buildOperationPolicyContext(resolvedOperation, params);
    if (!policyContext) {
      return null;
    }

    return await this.applyPolicy(policyContext, context);
  }

  private async applyPolicy(
    policyContext: PolicyEvaluationContext,
    context: PrimitiveContext,
  ): Promise<PrimitiveResult | null> {
    const decision = await this.policyEngine.enforce(policyContext, context);
    if (decision.action === "allow") {
      return null;
    }

    return {
      success: false,
      error: decision.reason,
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

function createInteractHandler(getInteractionHandler: () => InteractionHandler | undefined): PrimitiveHandler {
  return async (params, context) => {
    try {
      const interactionHandler = getInteractionHandler();
      if (!interactionHandler) {
        return {
          success: false,
          error: "Interact is unavailable because no communication adapter is attached.",
        };
      }

      const mode = requireStringParam(params.mode, "mode");
      const message = requireStringParam(params.message, "message");

      switch (mode) {
        case "notify": {
          const delivery = await interactionHandler.notify(message, context);
          return {
            success: true,
            data: delivery,
          };
        }
        case "ask": {
          const response = await interactionHandler.ask(message, context);
          return {
            success: true,
            data: { response },
          };
        }
        case "approve": {
          const approved = await interactionHandler.requestApproval(message, context, {
            tool: optionalStringParam(params.tool),
            operation: optionalStringParam(params.operation),
            summary: message,
            recordReceipt: true,
          });
          return {
            success: true,
            data: { approved },
          };
        }
        default:
          return {
            success: false,
            error: "Invalid interact mode: expected ask, notify, or approve.",
          };
      }
    } catch (error) {
      return {
        success: false,
        error: toErrorMessage(error),
      };
    }
  };
}

async function buildPrimitivePolicyContext(
  primitiveName: string,
  params: Record<string, unknown>,
  fileHandlerOptions: FileHandlerOptions,
): Promise<PolicyEvaluationContext | null> {
  try {
    switch (primitiveName) {
      case "http": {
        const request = buildRawHttpRequest(params);
        const url = new URL(request.url);
        return {
          primitive: "http",
          domain: url.hostname,
          path: url.pathname,
          method: String(request.init.method ?? "GET").toUpperCase(),
        };
      }
      case "file_read": {
        const resolvedPath = await resolveEffectiveFilePath(requireStringParam(params.path, "path"), fileHandlerOptions);
        return {
          primitive: "file_read",
          path: resolvedPath.effectivePath,
        };
      }
      case "file_write": {
        const resolvedPath = await resolveEffectiveFilePath(requireStringParam(params.path, "path"), fileHandlerOptions);
        return {
          primitive: "file_write",
          path: resolvedPath.effectivePath,
        };
      }
      case "execute":
        return {
          primitive: "execute",
          command: requireStringParam(params.command, "command"),
        };
      case "schedule":
        return {
          primitive: "schedule",
          trigger_type: optionalStringParam(params.trigger_type),
        };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function buildOperationPolicyContext(
  resolvedOperation: NonNullable<ReturnType<ToolSpecRegistry["getOperation"]>>,
  params: Record<string, unknown>,
): PolicyEvaluationContext | null {
  try {
    const normalizedInput = validateAndNormalizeOperationInput(resolvedOperation.operation, params);
    const request = buildSpecHttpRequest(
      resolvedOperation.registeredSpec.spec,
      resolvedOperation.operation,
      normalizedInput,
      { headers: {}, query: {} },
    );
    const url = new URL(request.url);

    return {
      primitive: "http",
      domain: url.hostname,
      path: url.pathname,
      method: String(request.init.method ?? "GET").toUpperCase(),
      tool: resolvedOperation.registeredSpec.spec.tool,
      trust_tier: resolvedOperation.registeredSpec.trustTier,
      operation: `${resolvedOperation.resourceName}.${resolvedOperation.operationName}`,
    };
  } catch {
    return null;
  }
}

function requireStringParam(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid ${fieldName}: expected a non-empty string.`);
  }

  return value.trim();
}

function optionalStringParam(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("Expected optional string parameter to be a non-empty string.");
  }

  return value.trim();
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
