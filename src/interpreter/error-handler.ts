import type { PrimitiveResult } from "../primitives/types.ts";
import type { ToolOperationSpec, ToolSpec } from "../specs/types.ts";

export interface HttpErrorContext {
  spec?: ToolSpec;
  operation?: ToolOperationSpec;
  operationName?: string;
  status: number;
  responseBody: unknown;
  attempts: number;
}

export function handleHttpError(context: HttpErrorContext): PrimitiveResult {
  const specError = context.operation?.errors?.[String(context.status)];
  const statusMessage = getGenericStatusMessage(context.status, context.attempts);
  const apiMessage = extractApiMessage(context.responseBody);

  const parts = [statusMessage];
  if (specError?.meaning) {
    parts.push(specError.meaning);
  }
  if (apiMessage) {
    parts.push(`API message: ${apiMessage}`);
  }
  if (specError?.recovery) {
    parts.push(`Recovery: ${specError.recovery}`);
  }

  return {
    success: false,
    error: parts.join(" "),
    data: {
      tool: context.spec?.tool,
      operation: context.operationName,
      status: context.status,
      attempts: context.attempts,
      response: context.responseBody,
    },
  };
}

function getGenericStatusMessage(status: number, attempts: number): string {
  switch (status) {
    case 400:
      return "Invalid parameters for the API request.";
    case 401:
      return "Authentication failed after the available refresh attempt.";
    case 403:
      return "Permission denied by the API.";
    case 404:
      return "Requested resource was not found.";
    case 429:
      return `Rate limited after ${attempts} attempt${attempts === 1 ? "" : "s"}.`;
    case 503:
      return `API temporarily unavailable after ${attempts} attempt${attempts === 1 ? "" : "s"}.`;
    default:
      if (status >= 500) {
        return "API server error.";
      }

      return `HTTP ${status} from API.`;
  }
}

function extractApiMessage(responseBody: unknown): string | null {
  if (responseBody === null || responseBody === undefined) {
    return null;
  }

  if (typeof responseBody === "string") {
    return responseBody;
  }

  if (typeof responseBody === "object" && !Array.isArray(responseBody)) {
    const payload = responseBody as Record<string, unknown>;
    const message = payload["message"];
    if (typeof message === "string") {
      return message;
    }

    const error = payload["error"];
    if (typeof error === "string") {
      return error;
    }
  }

  return JSON.stringify(responseBody);
}
