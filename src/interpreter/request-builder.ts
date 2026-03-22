import type { PreparedHttpRequest } from "./http-executor.ts";
import type { AuthBinding } from "./auth.ts";
import type { ToolBodySpec, ToolFieldSpec, ToolOperationSpec, ToolParamSpec, ToolSpec } from "../specs/types.ts";

export interface NormalizedOperationInput {
  params: Record<string, unknown>;
  body: Record<string, unknown>;
}

export function validateAndNormalizeOperationInput(
  operation: ToolOperationSpec,
  input: Record<string, unknown>,
): NormalizedOperationInput {
  const allowedKeys = new Set([
    ...Object.keys(operation.params ?? {}),
    ...Object.keys(operation.body?.fields ?? {}),
  ]);

  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unknown parameter: ${key}.`);
    }
  }

  const normalizedParams: Record<string, unknown> = {};
  const normalizedBody: Record<string, unknown> = {};

  for (const [paramName, paramSpec] of Object.entries(operation.params ?? {})) {
    const normalizedValue = normalizeFieldValue(input[paramName], paramSpec, paramName);
    if (normalizedValue !== undefined) {
      normalizedParams[paramName] = normalizedValue;
    }
  }

  for (const [fieldName, fieldSpec] of Object.entries(operation.body?.fields ?? {})) {
    const normalizedValue = normalizeFieldValue(input[fieldName], fieldSpec, fieldName);
    if (normalizedValue !== undefined) {
      normalizedBody[fieldName] = normalizedValue;
    }
  }

  return {
    params: normalizedParams,
    body: normalizedBody,
  };
}

export function buildSpecHttpRequest(
  spec: ToolSpec,
  operation: ToolOperationSpec,
  input: NormalizedOperationInput,
  auth: AuthBinding,
): PreparedHttpRequest {
  if (!operation.method || !operation.path) {
    throw new Error("HTTP tool operation is missing method or path.");
  }

  const pathParams = Object.entries(operation.params ?? {}).filter(([, param]) => param.in === "path");
  let resolvedPath = operation.path;
  for (const [paramName] of pathParams) {
    const paramValue = input.params[paramName];
    if (paramValue === undefined) {
      throw new Error(`Missing path parameter: ${paramName}.`);
    }

    resolvedPath = resolvedPath.replace(`{${paramName}}`, encodeURIComponent(String(paramValue)));
  }

  const url = new URL(resolvedPath, spec.connection.base_url);
  const headers = new Headers(spec.connection.default_headers ?? {});

  for (const [key, value] of Object.entries(auth.headers)) {
    headers.set(key, value);
  }

  for (const [key, value] of Object.entries(auth.query)) {
    appendQueryValue(url.searchParams, key, value);
  }

  for (const [paramName, paramSpec] of Object.entries(operation.params ?? {})) {
    const value = input.params[paramName];
    if (value === undefined) {
      continue;
    }

    switch (paramSpec.in) {
      case "query":
        appendQueryValue(url.searchParams, paramName, value);
        break;
      case "header":
        headers.set(paramName, stringifyScalar(value));
        break;
      case "path":
        break;
      default:
        assertNever(paramSpec.in);
    }
  }

  const serializedBody = serializeBody(operation.body, input.body, headers);

  return {
    url: url.toString(),
    init: {
      method: operation.method,
      headers,
      body: serializedBody,
    },
  };
}

export function buildRawHttpRequest(params: Record<string, unknown>): PreparedHttpRequest {
  for (const key of Object.keys(params)) {
    if (key !== "url" && key !== "method" && key !== "headers" && key !== "body") {
      throw new Error(`Unknown parameter: ${key}.`);
    }
  }

  const url = requireAbsoluteUrl(params.url);
  const method = requireMethod(params.method);
  const headers = normalizeHeaders(params.headers);
  const body = normalizeRawBody(params.body, headers);

  return {
    url,
    init: {
      method,
      headers,
      body,
    },
  };
}

function requireAbsoluteUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("Invalid url: expected an absolute http:// or https:// URL.");
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Invalid url: expected an absolute http:// or https:// URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Invalid url: only http and https URLs are supported.");
  }

  return url.toString();
}

function requireMethod(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("Invalid method: expected a non-empty string.");
  }

  return value.toUpperCase();
}

function normalizeHeaders(value: unknown): Headers {
  const headers = new Headers();

  if (value === undefined) {
    return headers;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid headers: expected an object.");
  }

  for (const [key, headerValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof headerValue !== "string") {
      throw new Error(`Invalid header ${key}: expected a string value.`);
    }

    headers.set(key, headerValue);
  }

  return headers;
}

function normalizeRawBody(value: unknown, headers: Headers): BodyInit | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "string" || value instanceof Blob || value instanceof FormData || value instanceof URLSearchParams) {
    return value;
  }

  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes = value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : Uint8Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    return new Blob([bytes]);
  }

  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  return JSON.stringify(value);
}

function normalizeFieldValue(value: unknown, field: ToolParamSpec | ToolFieldSpec, name: string): unknown {
  const effectiveValue = value === undefined ? field.default : value;

  if (effectiveValue === undefined) {
    if (field.required) {
      throw new Error(`Missing required parameter: ${name}.`);
    }

    return undefined;
  }

  if (!matchesFieldType(effectiveValue, field.type)) {
    throw new Error(`Invalid parameter ${name}: expected ${field.type}.`);
  }

  if (field.enum && !field.enum.some((candidate) => deepEqual(candidate, effectiveValue))) {
    throw new Error(`Invalid parameter ${name}: expected one of ${field.enum.join(", ")}.`);
  }

  return effectiveValue;
}

function serializeBody(bodySpec: ToolBodySpec | undefined, bodyValues: Record<string, unknown>, headers: Headers): BodyInit | undefined {
  if (!bodySpec) {
    return undefined;
  }

  const fieldNames = Object.keys(bodyValues);
  if (fieldNames.length === 0) {
    return undefined;
  }

  const contentType = bodySpec.content_type.toLowerCase();
  if (contentType === "application/json") {
    headers.set("content-type", bodySpec.content_type);
    return JSON.stringify(bodyValues);
  }

  if (contentType === "application/x-www-form-urlencoded") {
    const params = new URLSearchParams();
    for (const [fieldName, fieldValue] of Object.entries(bodyValues)) {
      appendQueryValue(params, fieldName, fieldValue);
    }
    headers.set("content-type", bodySpec.content_type);
    return params;
  }

  if (contentType === "multipart/form-data") {
    const formData = new FormData();
    for (const [fieldName, fieldValue] of Object.entries(bodyValues)) {
      appendFormValue(formData, fieldName, fieldValue);
    }
    headers.delete("content-type");
    return formData;
  }

  headers.set("content-type", bodySpec.content_type);
  return JSON.stringify(bodyValues);
}

function appendQueryValue(
  searchParams: URLSearchParams,
  key: string,
  value: string | string[] | unknown,
): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      searchParams.append(key, stringifyScalar(entry));
    }
    return;
  }

  searchParams.append(key, stringifyScalar(value));
}

function appendFormValue(formData: FormData, key: string, value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      formData.append(key, stringifyScalar(entry));
    }
    return;
  }

  formData.append(key, stringifyScalar(value));
}

function stringifyScalar(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  throw new Error("Unsupported value type in HTTP request.");
}

function matchesFieldType(value: unknown, type: ToolFieldSpec["type"]): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    default:
      return false;
  }
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertNever(value: never): never {
  throw new Error(`Unsupported request param location: ${value}`);
}
