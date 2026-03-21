import type { ToolOperationSpec } from "../specs/types.ts";

export interface PaginationResult {
  hasMore: boolean;
  nextCursor?: string;
  nextPageUrl?: string;
  cursorParam?: string;
}

export interface MappedOperationResponse {
  data: unknown;
  pagination?: PaginationResult;
}

export function mapOperationResponse(
  operation: ToolOperationSpec,
  response: Response,
  body: unknown,
  inputParams: Record<string, unknown> = {},
): MappedOperationResponse {
  return {
    data: selectImportantFields(body, operation.response.important_fields ?? {}),
    pagination: extractPagination(operation, response, body, inputParams),
  };
}

function selectImportantFields(body: unknown, importantFields: Record<string, string>): unknown {
  const fieldPaths = Object.keys(importantFields);
  if (fieldPaths.length === 0 || body === null || body === undefined) {
    return body;
  }

  if (Array.isArray(body) && fieldPaths.every((fieldPath) => fieldPath.startsWith("[]."))) {
    return body.map((entry) => {
      const selected: Record<string, unknown> = {};
      for (const fieldPath of fieldPaths) {
        const nestedPath = fieldPath.slice(3);
        const value = getValueAtPath(entry, nestedPath);
        if (value !== undefined) {
          setValueAtPath(selected, nestedPath, value);
        }
      }
      return selected;
    });
  }

  if (!body || typeof body !== "object") {
    return body;
  }

  const selected: Record<string, unknown> = {};
  for (const fieldPath of fieldPaths) {
    const value = getValueAtPath(body, fieldPath);
    if (value !== undefined) {
      setValueAtPath(selected, fieldPath, value);
    }
  }

  return Object.keys(selected).length > 0 ? selected : body;
}

function extractPagination(
  operation: ToolOperationSpec,
  response: Response,
  body: unknown,
  inputParams: Record<string, unknown>,
): PaginationResult | undefined {
  const pagination = operation.pagination;
  if (!pagination) {
    return undefined;
  }

  if (pagination.mechanism === "link_header") {
    const nextPageUrl = parseNextLink(response.headers.get("link"));
    if (!nextPageUrl) {
      return undefined;
    }

    return {
      hasMore: true,
      nextPageUrl,
    };
  }

  if (pagination.mechanism === "response_field" && pagination.cursor_field && typeof body === "object" && body) {
    const nextCursor = getValueAtPath(body, pagination.cursor_field);
    if (typeof nextCursor === "string" && nextCursor.trim() !== "") {
      return {
        hasMore: true,
        nextCursor,
        cursorParam: pagination.cursor_param,
      };
    }
  }

  if (pagination.type === "offset" && typeof body === "object" && body && pagination.total_field) {
    const total = getValueAtPath(body, pagination.total_field);
    if (typeof total === "number" && Number.isFinite(total)) {
      const currentOffset = readPaginationNumber(inputParams, pagination.offset_param) ?? 0;
      if (currentOffset >= total) {
        return {
          hasMore: false,
        };
      }

      const pageSize = readPaginationNumber(inputParams, pagination.limit_param)
        ?? pagination.max_per_page
        ?? getRootArrayLength(body);

      if (pageSize === undefined) {
        return undefined;
      }

      return {
        hasMore: currentOffset + pageSize < total,
      };
    }
  }

  return undefined;
}

function getValueAtPath(value: unknown, path: string): unknown {
  const segments = path.split(".").filter(Boolean);
  let current: unknown = value;

  for (const segment of segments) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

function setValueAtPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".").filter(Boolean);
  if (segments.length === 0) {
    return;
  }

  let current: Record<string, unknown> = target;
  for (const segment of segments.slice(0, -1)) {
    const existing = current[segment];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      current[segment] = {};
    }

    current = current[segment] as Record<string, unknown>;
  }

  current[segments[segments.length - 1]!] = value;
}

function parseNextLink(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }

  for (const part of value.split(",")) {
    const trimmed = part.trim();
    if (trimmed.includes('rel="next"')) {
      const match = trimmed.match(/<([^>]+)>/);
      if (match?.[1]) {
        return match[1];
      }
    }
  }

  return undefined;
}

function readPaginationNumber(inputParams: Record<string, unknown>, key: string | undefined): number | undefined {
  if (!key) {
    return undefined;
  }

  const value = inputParams[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getRootArrayLength(body: unknown): number | undefined {
  return Array.isArray(body) ? body.length : undefined;
}
