import type { PrimitiveContext } from "../primitives/types.ts";
import type {
  ToolApiKeyAuthSpec,
  ToolAuthSpec,
  ToolOAuth2AuthSpec,
  ToolSpec,
} from "../specs/types.ts";
import { parseHttpResponseBody } from "./http-executor.ts";

const OAUTH_EXPIRY_SKEW_MS = 30_000;

export interface StoredOAuthToken {
  access_token: string;
  refresh_token?: string;
  expires_at?: string;
  scope?: string | string[];
  token_type?: string;
}

export interface AuthBinding {
  headers: Record<string, string>;
  query: Record<string, string | string[]>;
  refreshOnUnauthorized?: () => Promise<AuthBinding | null>;
}

export interface MemoryAccessor {
  get(domain: string | null, key: string, context: PrimitiveContext): Promise<string | null>;
  set(domain: string | null, key: string, value: string, context: PrimitiveContext): Promise<void>;
}

export interface AuthDependencies {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  memory: MemoryAccessor;
  now?: () => Date;
  askForAuthorizationCode?: (message: string, context: PrimitiveContext) => Promise<string>;
}

export async function resolveAuthBinding(
  spec: ToolSpec,
  dependencies: AuthDependencies,
  context: PrimitiveContext,
): Promise<AuthBinding> {
  const auth = spec.auth;

  switch (auth.type) {
    case "none":
      return { headers: {}, query: {} };
    case "api_key":
      return resolveApiKeyBinding(auth, dependencies.env ?? process.env);
    case "bearer_token":
      return {
        headers: {
          Authorization: `Bearer ${requireEnvValue(dependencies.env ?? process.env, auth.env_var, spec.tool)}`,
        },
        query: {},
      };
    case "basic":
      return {
        headers: {
          Authorization: `Basic ${Buffer.from(
            `${requireEnvValue(dependencies.env ?? process.env, auth.username_env, spec.tool)}:${requireEnvValue(dependencies.env ?? process.env, auth.password_env, spec.tool)}`,
          ).toString("base64")}`,
        },
        query: {},
      };
    case "oauth2":
      return await resolveOAuth2Binding(spec, auth, dependencies, context, { forceRefresh: false });
    default:
      return assertNever(auth);
  }
}

function resolveApiKeyBinding(
  auth: ToolApiKeyAuthSpec,
  env: Record<string, string | undefined>,
): AuthBinding {
  const apiKey = requireEnvValue(env, auth.env_var, auth.key_name);

  if (auth.location === "header") {
    return {
      headers: {
        [auth.key_name]: apiKey,
      },
      query: {},
    };
  }

  return {
    headers: {},
    query: {
      [auth.key_name]: apiKey,
    },
  };
}

async function resolveOAuth2Binding(
  spec: ToolSpec,
  auth: ToolOAuth2AuthSpec,
  dependencies: AuthDependencies,
  context: PrimitiveContext,
  options: { forceRefresh: boolean },
): Promise<AuthBinding> {
  const storedToken = await loadStoredToken(spec, auth, dependencies.memory, context);

  if (!options.forceRefresh && storedToken && !isExpired(storedToken, dependencies.now)) {
    return buildOAuthBinding(spec, auth, storedToken, dependencies, context);
  }

  if (storedToken?.refresh_token) {
    const refreshedToken = await refreshOAuthToken(spec, auth, storedToken.refresh_token, dependencies, context);
    return buildOAuthBinding(spec, auth, refreshedToken, dependencies, context);
  }

  if (auth.flow === "client_credentials") {
    const token = await requestClientCredentialsToken(spec, auth, dependencies, context);
    return buildOAuthBinding(spec, auth, token, dependencies, context);
  }

  if (dependencies.askForAuthorizationCode) {
    const authorizationCode = await dependencies.askForAuthorizationCode(buildAuthorizationMessage(spec, auth), context);
    const token = await requestAuthorizationCodeToken(spec, auth, authorizationCode, dependencies, context);
    return buildOAuthBinding(spec, auth, token, dependencies, context);
  }

  throw new Error(
    `OAuth2 authorization is required for ${spec.tool}, but the interactive authorization flow is not implemented in this slice. `
      + `Store a token in memory domain "${spec.tool}" with key "${getOAuthMemoryKey(spec.tool, auth.token_storage_key)}" or configure a refresh token so the runtime can refresh automatically.`,
  );
}

function buildOAuthBinding(
  spec: ToolSpec,
  auth: ToolOAuth2AuthSpec,
  token: StoredOAuthToken,
  dependencies: AuthDependencies,
  context: PrimitiveContext,
): AuthBinding {
  return {
    headers: {
      Authorization: `${token.token_type ?? "Bearer"} ${token.access_token}`,
    },
    query: {},
    refreshOnUnauthorized: async () => {
      if (token.refresh_token) {
        return await resolveOAuth2Binding(spec, auth, dependencies, context, { forceRefresh: true });
      }

      if (auth.flow === "client_credentials") {
        return await resolveOAuth2Binding(spec, auth, dependencies, context, { forceRefresh: true });
      }

      return null;
    },
  };
}

async function loadStoredToken(
  spec: ToolSpec,
  auth: ToolOAuth2AuthSpec,
  memory: MemoryAccessor,
  context: PrimitiveContext,
): Promise<StoredOAuthToken | null> {
  const rawValue = await memory.get(spec.tool, getOAuthMemoryKey(spec.tool, auth.token_storage_key), context);
  if (!rawValue) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawValue) as StoredOAuthToken;
    if (!parsed.access_token || typeof parsed.access_token !== "string") {
      throw new Error("missing access_token");
    }

    return parsed;
  } catch (error) {
    throw new Error(`Stored OAuth token for ${spec.tool} is invalid: ${toErrorMessage(error)}`);
  }
}

async function refreshOAuthToken(
  spec: ToolSpec,
  auth: ToolOAuth2AuthSpec,
  refreshToken: string,
  dependencies: AuthDependencies,
  context: PrimitiveContext,
): Promise<StoredOAuthToken> {
  return await requestOAuthToken(spec, auth, dependencies, context, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  }, "refresh the OAuth token");
}

async function requestClientCredentialsToken(
  spec: ToolSpec,
  auth: ToolOAuth2AuthSpec,
  dependencies: AuthDependencies,
  context: PrimitiveContext,
): Promise<StoredOAuthToken> {
  return await requestOAuthToken(spec, auth, dependencies, context, {
    grant_type: "client_credentials",
  }, "request a client-credentials OAuth token");
}

async function requestAuthorizationCodeToken(
  spec: ToolSpec,
  auth: ToolOAuth2AuthSpec,
  authorizationCode: string,
  dependencies: AuthDependencies,
  context: PrimitiveContext,
): Promise<StoredOAuthToken> {
  const trimmedCode = authorizationCode.trim();
  if (trimmedCode === "") {
    throw new Error(`Received an empty OAuth authorization code for ${spec.tool}.`);
  }

  return await requestOAuthToken(spec, auth, dependencies, context, {
    grant_type: "authorization_code",
    code: trimmedCode,
  }, "exchange the OAuth authorization code");
}

async function requestOAuthToken(
  spec: ToolSpec,
  auth: ToolOAuth2AuthSpec,
  dependencies: AuthDependencies,
  context: PrimitiveContext,
  grantFields: Record<string, string>,
  actionDescription: string,
): Promise<StoredOAuthToken> {
  const env = dependencies.env ?? process.env;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const requestBody = new URLSearchParams({
    ...grantFields,
    client_id: requireEnvValue(env, auth.credentials.client_id_env, spec.tool),
  });

  if (auth.credentials.client_secret_env) {
    requestBody.set("client_secret", requireEnvValue(env, auth.credentials.client_secret_env, spec.tool));
  }

  if (auth.scopes.length > 0 && !requestBody.has("scope")) {
    requestBody.set("scope", auth.scopes.join(" "));
  }

  const response = await fetchImpl(auth.token_url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: requestBody,
    signal: AbortSignal.timeout(30_000),
  });
  const responseBody = await parseHttpResponseBody(response);

  if (!response.ok) {
    throw new Error(
      `Failed to ${actionDescription} for ${spec.tool}: HTTP ${response.status}. ${extractResponseMessage(responseBody)}`.trim(),
    );
  }

  const token = normalizeTokenResponse(responseBody, grantFields.refresh_token);
  await dependencies.memory.set(
    spec.tool,
    getOAuthMemoryKey(spec.tool, auth.token_storage_key),
    JSON.stringify(token),
    context,
  );

  return token;
}

function normalizeTokenResponse(responseBody: unknown, priorRefreshToken?: string): StoredOAuthToken {
  if (!responseBody || typeof responseBody !== "object" || Array.isArray(responseBody)) {
    throw new Error("OAuth token response was not a JSON object.");
  }

  const payload = responseBody as Record<string, unknown>;
  if (typeof payload.access_token !== "string" || payload.access_token.trim() === "") {
    throw new Error("OAuth token response did not include access_token.");
  }

  const expiresIn = typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)
    ? payload.expires_in
    : undefined;

  return {
    access_token: payload.access_token,
    refresh_token: typeof payload.refresh_token === "string" ? payload.refresh_token : priorRefreshToken,
    expires_at: expiresIn !== undefined ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined,
    scope: Array.isArray(payload.scope)
      ? payload.scope.filter((value): value is string => typeof value === "string")
      : typeof payload.scope === "string"
      ? payload.scope
      : undefined,
    token_type: typeof payload.token_type === "string" ? payload.token_type : "Bearer",
  };
}

function buildAuthorizationMessage(spec: ToolSpec, auth: ToolOAuth2AuthSpec): string {
  return [
    `Authorization is required for ${spec.name}.`,
    auth.authorization_url ? `Open: ${auth.authorization_url}` : null,
    auth.scopes.length > 0 ? `Scopes: ${auth.scopes.join(", ")}` : null,
    "Paste the authorization code here when the provider returns it.",
  ].filter(Boolean).join(" ");
}

function extractResponseMessage(responseBody: unknown): string {
  if (!responseBody) {
    return "";
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

function isExpired(token: StoredOAuthToken, nowFactory?: () => Date): boolean {
  if (!token.expires_at) {
    return false;
  }

  const expiryTime = Date.parse(token.expires_at);
  if (Number.isNaN(expiryTime)) {
    return false;
  }

  const now = nowFactory ? nowFactory().getTime() : Date.now();
  return expiryTime <= now + OAUTH_EXPIRY_SKEW_MS;
}

function requireEnvValue(env: Record<string, string | undefined>, key: string, scope: string): string {
  const value = env[key];
  if (!value) {
    throw new Error(`Missing environment variable ${key} required for ${scope}.`);
  }

  return value;
}

export function getOAuthMemoryKey(toolId: string, tokenStorageKey: string): string {
  return `oauth:${toolId}:${tokenStorageKey}`;
}

function assertNever(value: never): never {
  throw new Error(`Unsupported auth spec: ${JSON.stringify(value)}`);
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
