import type { PrimitiveContext, PrimitiveResult } from "../primitives/types.ts";
import type { ToolSpecRegistry } from "../specs/registry.ts";
import { resolveAuthBinding, type AuthDependencies, type MemoryAccessor } from "./auth.ts";
import { handleHttpError } from "./error-handler.ts";
import {
  buildRawHttpRequest,
  buildSpecHttpRequest,
  validateAndNormalizeOperationInput,
} from "./request-builder.ts";
import { mapOperationResponse } from "./response-mapper.ts";
import { executeHttpRequest, headersToObject, parseHttpResponseBody } from "./http-executor.ts";

export interface ToolSpecInterpreterOptions {
  registry: ToolSpecRegistry;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  auth: AuthDependencies;
}

export class ToolSpecInterpreter {
  private readonly registry: ToolSpecRegistry;
  private readonly fetchImpl?: typeof fetch;
  private readonly sleep?: (ms: number) => Promise<void>;
  private readonly authDependencies: AuthDependencies;

  constructor(options: ToolSpecInterpreterOptions) {
    this.registry = options.registry;
    this.fetchImpl = options.fetchImpl;
    this.sleep = options.sleep;
    this.authDependencies = options.auth;
  }

  setAuthorizationCodeHandler(handler: AuthDependencies["askForAuthorizationCode"] | undefined): void {
    this.authDependencies.askForAuthorizationCode = handler;
  }

  async executeOperation(
    operationName: string,
    params: Record<string, unknown>,
    context: PrimitiveContext,
  ): Promise<PrimitiveResult> {
    const resolvedOperation = this.registry.getOperation(operationName);
    if (!resolvedOperation) {
      return {
        success: false,
        error: `Unknown tool operation: ${operationName}`,
      };
    }

    if (resolvedOperation.operation.primitive !== "http") {
      return {
        success: false,
        error: `Unsupported operation primitive: ${resolvedOperation.operation.primitive}`,
      };
    }

    try {
      const normalizedInput = validateAndNormalizeOperationInput(resolvedOperation.operation, params);
      let authBinding = await resolveAuthBinding(resolvedOperation.registeredSpec.spec, this.authDependencies, context);
      const buildRequest = () => buildSpecHttpRequest(
        resolvedOperation.registeredSpec.spec,
        resolvedOperation.operation,
        normalizedInput,
        authBinding,
      );

      const executed = await executeHttpRequest(buildRequest(), {
        fetchImpl: this.fetchImpl,
        sleep: this.sleep,
        retryAfterHeader: resolvedOperation.registeredSpec.spec.connection.rate_limit?.retry_after_header,
        rebuildOnUnauthorized: authBinding.refreshOnUnauthorized
          ? async () => {
              const refreshedBinding = await authBinding.refreshOnUnauthorized?.();
              if (!refreshedBinding) {
                return null;
              }

              authBinding = refreshedBinding;
              return buildRequest();
            }
          : undefined,
      });
      const responseBody = await parseHttpResponseBody(executed.response);

      if (!executed.response.ok) {
        return handleHttpError({
          spec: resolvedOperation.registeredSpec.spec,
          operation: resolvedOperation.operation,
          operationName: resolvedOperation.canonicalName,
          status: executed.response.status,
          responseBody,
          attempts: executed.attempts,
        });
      }

      const mappedResponse = mapOperationResponse(
        resolvedOperation.operation,
        executed.response,
        responseBody,
        normalizedInput.params,
      );
      return {
        success: true,
        data: {
          tool: resolvedOperation.registeredSpec.spec.tool,
          operation: `${resolvedOperation.resourceName}.${resolvedOperation.operationName}`,
          trustTier: resolvedOperation.registeredSpec.trustTier,
          status: executed.response.status,
          attempts: executed.attempts,
          response: mappedResponse.data,
          pagination: mappedResponse.pagination,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: toErrorMessage(error),
      };
    }
  }

  async executeRawHttp(params: Record<string, unknown>): Promise<PrimitiveResult> {
    try {
      const request = buildRawHttpRequest(params);
      const executed = await executeHttpRequest(request, {
        fetchImpl: this.fetchImpl,
        sleep: this.sleep,
      });
      const responseBody = await parseHttpResponseBody(executed.response);

      if (!executed.response.ok) {
        return handleHttpError({
          status: executed.response.status,
          responseBody,
          attempts: executed.attempts,
        });
      }

      return {
        success: true,
        data: {
          status: executed.response.status,
          attempts: executed.attempts,
          headers: headersToObject(executed.response.headers),
          body: responseBody,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: toErrorMessage(error),
      };
    }
  }
}

export type { MemoryAccessor };

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
