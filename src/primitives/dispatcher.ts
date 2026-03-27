import { dirname } from "node:path";
import {
  InteractionTimeoutError,
  type PrimitiveContext,
  type PrimitiveHandler,
  type PrimitiveResult,
  type InteractionHandler,
} from "./types.ts";
import { RAW_PRIMITIVE_DECLARATIONS } from "./types.ts";
import { DEFAULT_AGENT_HOME, resolveExecuteWorkspaceDir } from "../config/schema.ts";
import { getDatabase } from "../db/database.ts";
import { createFileReadHandler, createFileWriteHandler, resolveEffectiveFilePath, type FileHandlerOptions } from "./file.ts";
import { createExecuteHandler } from "./execute/handler.ts";
import { createMemoryHandler } from "./memory.ts";
import { createScheduleHandler } from "./schedule.ts";
import type { AuthDependencies } from "../interpreter/auth.ts";
import { ToolSpecRegistry } from "../specs/registry.ts";
import { ToolSpecInterpreter } from "../interpreter/pipeline.ts";
import { buildRawHttpRequest, buildSpecHttpRequest, validateAndNormalizeOperationInput } from "../interpreter/request-builder.ts";
import { Logger } from "../observability/logger.ts";
import { SYSTEM_TOOL_DECLARATIONS, SystemToolHandler } from "../system-tools/handler.ts";
import { isPolicyExemptPrimitive, PolicyEngine } from "../policy/engine.ts";
import { loadPolicy } from "../policy/loader.ts";
import { PolicyRateLimiter } from "../policy/rate-limiter.ts";
import type { LoadedPolicy, PolicyEvaluationContext } from "../policy/types.ts";

const KNOWN_PRIMITIVES = new Set(RAW_PRIMITIVE_DECLARATIONS.map((tool) => tool.name));

export interface PrimitiveDispatcherOptions {
  agentHome?: string;
  workspaceDir?: string;
  executeWorkspaceDir?: string;
  homeDir?: string;
  timeZone?: string;
  policyPath?: string;
  policy?: LoadedPolicy;
  getDatabase?: typeof getDatabase;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  seedTrustedSpecs?: boolean;
  logger?: Logger;
}

export class PrimitiveDispatcher {
  private readonly handlers: Partial<Record<string, PrimitiveHandler>>;
  private readonly registry: ToolSpecRegistry;
  private readonly systemToolHandler: SystemToolHandler;
  private readonly interpreter: ToolSpecInterpreter;
  private readonly policy: LoadedPolicy;
  private readonly policyEngine: PolicyEngine;
  private readonly fileHandlerOptions: FileHandlerOptions;
  private readonly logger: Logger;
  private interactionHandler: InteractionHandler | undefined;

  constructor(options: PrimitiveDispatcherOptions = {}) {
    const baseLogger = options.logger ?? new Logger();
    const agentHome = options.agentHome ?? DEFAULT_AGENT_HOME;
    const workspaceDir = options.workspaceDir ?? process.cwd();
    const executeWorkspaceDir = options.executeWorkspaceDir ?? resolveExecuteWorkspaceDir(agentHome);
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
      logger: baseLogger,
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
    this.logger = baseLogger.child({ component: "primitives.dispatcher" });
    this.policyEngine = new PolicyEngine({
      policy,
      workspaceDir,
      homeDir,
      rateLimiter: new PolicyRateLimiter({ database: runtimeDatabase, logger: baseLogger }),
      logger: baseLogger,
    });
    this.handlers = {
      http: async (params) => await interpreter.executeRawHttp(params),
      file_read: createFileReadHandler(fileHandlerOptions),
      file_write: createFileWriteHandler(fileHandlerOptions),
      execute: createExecuteHandler({
        executeWorkspaceDir,
        homeDir,
        env: options.env,
      }),
      memory: memoryHandler,
      schedule: createScheduleHandler({
        getDatabase: () => runtimeDatabase,
        now: options.now,
        timeZone: options.timeZone,
        logger: baseLogger,
      }),
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
    this.logger.info("primitive.dispatch.start", {
      primitiveName,
      sessionId: context.sessionId,
      triggerSource: context.triggerSource,
    });

    try {
      let result: PrimitiveResult;

      if (KNOWN_PRIMITIVES.has(primitiveName)) {
        const policyResult = await this.enforcePrimitivePolicy(primitiveName, params, context);
        if (policyResult) {
          result = policyResult;
        } else {
          const handler = this.handlers[primitiveName];
          result = handler
            ? await handler(params, context)
            : {
                success: false,
                error: "Primitive not implemented yet",
              };
        }
      } else if (this.systemToolHandler.canHandle(primitiveName)) {
        result = await this.systemToolHandler.dispatch(primitiveName, params, context);
      } else if (this.registry.getOperation(primitiveName)) {
        const policyResult = await this.enforceOperationPolicy(primitiveName, params, context);
        if (policyResult) {
          result = policyResult;
        } else {
          result = await this.interpreter.executeOperation(primitiveName, params, context);
        }
      } else {
        result = {
          success: false,
          error: `Unknown primitive or tool: ${primitiveName}`,
        };
      }

      if (result.success) {
        this.logger.info("primitive.dispatch.complete", {
          primitiveName,
          sessionId: context.sessionId,
          triggerSource: context.triggerSource,
          success: true,
        });
      } else {
        this.logger.warn("primitive.dispatch.complete", {
          primitiveName,
          sessionId: context.sessionId,
          triggerSource: context.triggerSource,
          success: false,
          error: result.error,
        });
      }
      return result;
    } catch (error) {
      this.logger.error("primitive.dispatch.error", {
        primitiveName,
        sessionId: context.sessionId,
        triggerSource: context.triggerSource,
        error,
      });
      return {
        success: false,
        error: toErrorMessage(error),
      };
    }
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
          const decision = await interactionHandler.requestApproval(message, context, {
            tool: optionalStringParam(params.tool, "tool"),
            operation: optionalStringParam(params.operation, "operation"),
            summary: message,
            recordReceipt: true,
          });
          return {
            success: true,
            data: decision,
          };
        }
        default:
          return {
            success: false,
            error: "Invalid interact mode: expected ask, notify, or approve.",
          };
      }
    } catch (error) {
      if (context.triggerSource === "schedule" && error instanceof InteractionTimeoutError) {
        const mode = optionalStringParam(params.mode, "mode");
        if (mode === "approve") {
          return {
            success: true,
            data: {
              approved: null,
              response: null,
              timedOut: true,
            },
          };
        }

        if (mode === "ask") {
          return {
            success: true,
            data: {
              response: null,
              timedOut: true,
            },
          };
        }
      }

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
          trigger_type: extractScheduleTriggerType(params),
        };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function extractScheduleTriggerType(params: Record<string, unknown>): string | undefined {
  const directType = optionalStringParam(params.trigger_type, "trigger_type");
  if (directType) {
    return directType;
  }

  const rawTrigger = params.trigger;
  if (!rawTrigger || typeof rawTrigger !== "object" || Array.isArray(rawTrigger)) {
    return undefined;
  }

  return optionalStringParam((rawTrigger as Record<string, unknown>).type, "trigger.type");
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

function optionalStringParam(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid ${fieldName}: expected a non-empty string.`);
  }

  return value.trim();
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
