import type {
  ToolAuthSpec,
  ToolBodySpec,
  ToolFieldSpec,
  ToolOperationSpec,
  ToolParamSpec,
  ToolResourceSpec,
  ToolSpec,
  ToolSpecValidationResult,
} from "./types.ts";

const FIELD_TYPES = new Set(["string", "integer", "number", "boolean", "array"]);
const PARAM_LOCATIONS = new Set(["path", "query", "header"]);
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const PAGINATION_TYPES = new Set(["cursor", "offset", "page_number"]);
const SUPPORTED_OPERATION_PRIMITIVES = new Set(["http"]);

export function validateToolSpec(input: unknown): ToolSpecValidationResult {
  const errors: string[] = [];
  const root = asRecord(input);

  if (!root) {
    return {
      valid: false,
      errors: ["$ must be an object."],
    };
  }

  validateTopLevel(root, errors);
  validateAuth(root.auth, errors);
  validateConnection(root.connection, errors);
  validateMemoryKeys(root.memory_keys, errors);
  validateResources(root.resources, errors);

  return {
    valid: errors.length === 0,
    errors,
    spec: errors.length === 0 ? root as unknown as ToolSpec : undefined,
  };
}

function validateTopLevel(root: Record<string, unknown>, errors: string[]): void {
  requireLiteral(root.spec_version, "0.1", "spec_version", errors);
  requirePattern(root.tool, /^[a-z0-9][a-z0-9_-]*$/, "tool", errors, "a lowercase identifier");
  requireString(root.name, "name", errors);
  requireString(root.description, "description", errors);

  if (root.docs_url !== undefined && typeof root.docs_url !== "string") {
    errors.push("docs_url must be a string when present.");
  }

  requireObject(root.auth, "auth", errors);
  requireObject(root.connection, "connection", errors);
  requireObject(root.resources, "resources", errors);
}

function validateAuth(value: unknown, errors: string[]): void {
  const auth = asRecord(value);
  if (!auth) {
    return;
  }

  requireString(auth.description, "auth.description", errors);

  const type = requireString(auth.type, "auth.type", errors);
  if (!type) {
    return;
  }

  switch (type) {
    case "none":
      return;
    case "api_key":
      requireLiteralSet(auth.location, ["header", "query"], "auth.location", errors);
      requireString(auth.key_name, "auth.key_name", errors);
      requireString(auth.env_var, "auth.env_var", errors);
      return;
    case "bearer_token":
      requireString(auth.env_var, "auth.env_var", errors);
      return;
    case "basic":
      requireString(auth.username_env, "auth.username_env", errors);
      requireString(auth.password_env, "auth.password_env", errors);
      return;
    case "oauth2":
      requireLiteralSet(auth.flow, ["authorization_code", "client_credentials"], "auth.flow", errors);
      if (auth.flow === "authorization_code") {
        requireString(auth.authorization_url, "auth.authorization_url", errors);
      }
      requireString(auth.token_url, "auth.token_url", errors);
      requireStringArray(auth.scopes, "auth.scopes", errors);
      requireString(auth.token_storage_key, "auth.token_storage_key", errors);

      const credentials = asRecord(auth.credentials);
      if (!credentials) {
        errors.push("auth.credentials must be an object.");
      } else {
        requireString(credentials.client_id_env, "auth.credentials.client_id_env", errors);
        if (credentials.client_secret_env !== undefined) {
          requireString(credentials.client_secret_env, "auth.credentials.client_secret_env", errors);
        }
      }

      if (auth.pkce !== undefined && typeof auth.pkce !== "boolean") {
        errors.push("auth.pkce must be a boolean when present.");
      }
      return;
    default:
      errors.push(`auth.type must be one of none, api_key, bearer_token, basic, oauth2; received ${String(type)}.`);
  }
}

function validateConnection(value: unknown, errors: string[]): void {
  const connection = asRecord(value);
  if (!connection) {
    return;
  }

  requireString(connection.base_url, "connection.base_url", errors);

  if (connection.default_headers !== undefined) {
    const headers = asRecord(connection.default_headers);
    if (!headers) {
      errors.push("connection.default_headers must be an object when present.");
    } else {
      for (const [key, headerValue] of Object.entries(headers)) {
        if (typeof headerValue !== "string") {
          errors.push(`connection.default_headers.${key} must be a string.`);
        }
      }
    }
  }

  if (connection.rate_limit !== undefined) {
    const rateLimit = asRecord(connection.rate_limit);
    if (!rateLimit) {
      errors.push("connection.rate_limit must be an object when present.");
    } else {
      if (rateLimit.requests !== undefined && !isPositiveInteger(rateLimit.requests)) {
        errors.push("connection.rate_limit.requests must be a positive integer when present.");
      }

      if (rateLimit.period !== undefined) {
        requireLiteralSet(rateLimit.period, ["second", "minute", "hour"], "connection.rate_limit.period", errors);
      }

      if (rateLimit.strategy !== undefined) {
        requireLiteralSet(
          rateLimit.strategy,
          ["fixed_window", "respect_headers"],
          "connection.rate_limit.strategy",
          errors,
        );
      }

      if (rateLimit.retry_after_header !== undefined) {
        requireString(rateLimit.retry_after_header, "connection.rate_limit.retry_after_header", errors);
      }
    }
  }
}

function validateMemoryKeys(value: unknown, errors: string[]): void {
  if (value === undefined) {
    return;
  }

  const memoryKeys = asRecord(value);
  if (!memoryKeys) {
    errors.push("memory_keys must be an object when present.");
    return;
  }

  for (const [key, memoryKey] of Object.entries(memoryKeys)) {
    const entry = asRecord(memoryKey);
    if (!entry) {
      errors.push(`memory_keys.${key} must be an object.`);
      continue;
    }

    requireString(entry.description, `memory_keys.${key}.description`, errors);
  }
}

function validateResources(value: unknown, errors: string[]): void {
  const resources = asRecord(value);
  if (!resources) {
    return;
  }

  for (const [resourceName, resourceValue] of Object.entries(resources)) {
    validateResource(resourceName, resourceValue, errors);
  }
}

function validateResource(resourceName: string, value: unknown, errors: string[]): void {
  const resource = asRecord(value) as ToolResourceSpec | null;
  if (!resource) {
    errors.push(`resources.${resourceName} must be an object.`);
    return;
  }

  requireString(resource.description, `resources.${resourceName}.description`, errors);

  const operations = asRecord(resource.operations);
  if (!operations) {
    errors.push(`resources.${resourceName}.operations must be an object.`);
    return;
  }

  for (const [operationName, operationValue] of Object.entries(operations)) {
    validateOperation(resourceName, operationName, operationValue, errors);
  }
}

function validateOperation(resourceName: string, operationName: string, value: unknown, errors: string[]): void {
  const operation = asRecord(value) as ToolOperationSpec | null;
  const prefix = `resources.${resourceName}.operations.${operationName}`;
  if (!operation) {
    errors.push(`${prefix} must be an object.`);
    return;
  }

  requireString(operation.description, `${prefix}.description`, errors);
  requireString(operation.when_to_use, `${prefix}.when_to_use`, errors);
  const primitive = requireString(operation.primitive, `${prefix}.primitive`, errors);

  if (primitive && !SUPPORTED_OPERATION_PRIMITIVES.has(primitive)) {
    errors.push(`${prefix}.primitive must be http in Slice 03; received ${primitive}.`);
  }

  if (primitive === "http") {
    const method = requireString(operation.method, `${prefix}.method`, errors);
    if (method && !HTTP_METHODS.has(method)) {
      errors.push(`${prefix}.method must be one of ${[...HTTP_METHODS].join(", ")}.`);
    }

    requireString(operation.path, `${prefix}.path`, errors);
  }

  validateParams(operation.params, `${prefix}.params`, errors);
  validateBody(operation.body, `${prefix}.body`, errors);
  validateOperationPathParameters(operation, prefix, errors);
  validateSideEffects(operation.side_effects, `${prefix}.side_effects`, errors);
  validateResponse(operation.response, `${prefix}.response`, errors);
  validateErrors(operation.errors, `${prefix}.errors`, errors);
  validatePagination(operation.pagination, `${prefix}.pagination`, errors);
}

function validateParams(value: unknown, path: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }

  const params = asRecord(value);
  if (!params) {
    errors.push(`${path} must be an object when present.`);
    return;
  }

  for (const [paramName, paramValue] of Object.entries(params)) {
    const param = asRecord(paramValue) as ToolParamSpec | null;
    if (!param) {
      errors.push(`${path}.${paramName} must be an object.`);
      continue;
    }

    requireLiteralSet(param.in, [...PARAM_LOCATIONS], `${path}.${paramName}.in`, errors);
    validateFieldSpec(param, `${path}.${paramName}`, errors);
  }
}

function validateBody(value: unknown, path: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }

  const body = asRecord(value) as ToolBodySpec | null;
  if (!body) {
    errors.push(`${path} must be an object when present.`);
    return;
  }

  requireString(body.content_type, `${path}.content_type`, errors);
  const fields = asRecord(body.fields);
  if (!fields) {
    errors.push(`${path}.fields must be an object.`);
    return;
  }

  for (const [fieldName, fieldValue] of Object.entries(fields)) {
    const field = asRecord(fieldValue) as ToolFieldSpec | null;
    if (!field) {
      errors.push(`${path}.fields.${fieldName} must be an object.`);
      continue;
    }

    validateFieldSpec(field, `${path}.fields.${fieldName}`, errors);
  }
}

function validateFieldSpec(field: ToolFieldSpec, path: string, errors: string[]): void {
  if (!FIELD_TYPES.has(field.type)) {
    errors.push(`${path}.type must be one of ${[...FIELD_TYPES].join(", ")}.`);
  }

  if (typeof field.required !== "boolean") {
    errors.push(`${path}.required must be a boolean.`);
  }

  requireString(field.description, `${path}.description`, errors);

  if (field.enum !== undefined) {
    if (!Array.isArray(field.enum) || field.enum.length === 0) {
      errors.push(`${path}.enum must be a non-empty array when present.`);
    } else {
      for (const enumValue of field.enum) {
        if (!matchesFieldType(enumValue, field.type)) {
          errors.push(`${path}.enum contains a value that does not match type ${field.type}.`);
          break;
        }
      }
    }
  }

  if (field.default !== undefined && !matchesFieldType(field.default, field.type)) {
    errors.push(`${path}.default must match declared type ${field.type}.`);
  }
}

function validateOperationPathParameters(operation: ToolOperationSpec, path: string, errors: string[]): void {
  if (!operation.path) {
    return;
  }

  const pathParams = new Set(
    Object.entries(operation.params ?? {})
      .filter(([, param]) => param.in === "path")
      .map(([paramName]) => paramName),
  );
  const templateMatches = [...operation.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);

  for (const templateParam of templateMatches) {
    if (!pathParams.has(templateParam)) {
      errors.push(`${path}.path references {${templateParam}} but ${path}.params.${templateParam} is missing or not a path param.`);
    }
  }
}

function validateSideEffects(value: unknown, path: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }

  const sideEffects = asRecord(value);
  if (!sideEffects) {
    errors.push(`${path} must be an object when present.`);
    return;
  }

  requireString(sideEffects.description, `${path}.description`, errors);
  if (typeof sideEffects.reversible !== "boolean") {
    errors.push(`${path}.reversible must be a boolean.`);
  }
}

function validateResponse(value: unknown, path: string, errors: string[]): void {
  const response = asRecord(value);
  if (!response) {
    errors.push(`${path} must be an object.`);
    return;
  }

  requireString(response.description, `${path}.description`, errors);

  if (response.important_fields !== undefined) {
    const importantFields = asRecord(response.important_fields);
    if (!importantFields) {
      errors.push(`${path}.important_fields must be an object when present.`);
      return;
    }

    for (const [fieldName, description] of Object.entries(importantFields)) {
      if (typeof description !== "string") {
        errors.push(`${path}.important_fields.${fieldName} must be a string.`);
      }
    }
  }
}

function validateErrors(value: unknown, path: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }

  const errorMap = asRecord(value);
  if (!errorMap) {
    errors.push(`${path} must be an object when present.`);
    return;
  }

  for (const [statusCode, errorValue] of Object.entries(errorMap)) {
    const entry = asRecord(errorValue);
    if (!entry) {
      errors.push(`${path}.${statusCode} must be an object.`);
      continue;
    }

    requireString(entry.meaning, `${path}.${statusCode}.meaning`, errors);
    requireString(entry.recovery, `${path}.${statusCode}.recovery`, errors);
  }
}

function validatePagination(value: unknown, path: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }

  const pagination = asRecord(value);
  if (!pagination) {
    errors.push(`${path} must be an object when present.`);
    return;
  }

  const type = requireString(pagination.type, `${path}.type`, errors);
  if (type && !PAGINATION_TYPES.has(type)) {
    errors.push(`${path}.type must be one of ${[...PAGINATION_TYPES].join(", ")}.`);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function requireString(value: unknown, path: string, errors: string[]): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${path} must be a non-empty string.`);
    return null;
  }

  return value.trim();
}

function requireObject(value: unknown, path: string, errors: string[]): void {
  if (!asRecord(value)) {
    errors.push(`${path} must be an object.`);
  }
}

function requireStringArray(value: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    errors.push(`${path} must be a non-empty array of strings.`);
  }
}

function requirePattern(
  value: unknown,
  pattern: RegExp,
  path: string,
  errors: string[],
  expectation: string,
): void {
  if (typeof value !== "string" || !pattern.test(value)) {
    errors.push(`${path} must be ${expectation}.`);
  }
}

function requireLiteral(value: unknown, expected: string, path: string, errors: string[]): void {
  if (value !== expected) {
    errors.push(`${path} must be ${expected}.`);
  }
}

function requireLiteralSet(value: unknown, allowed: string[], path: string, errors: string[]): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    errors.push(`${path} must be one of ${allowed.join(", ")}.`);
  }
}

function isPositiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
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
