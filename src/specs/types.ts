import type { ToolDeclaration } from "../llm/types.ts";

export type TrustTier = "trusted" | "user-reviewed" | "untrusted";
export type ToolFieldType = "string" | "integer" | "number" | "boolean" | "array";
export type ToolParamLocation = "path" | "query" | "header";

export interface ToolRateLimitSpec {
  requests?: number;
  period?: "second" | "minute" | "hour";
  strategy?: "fixed_window" | "respect_headers";
  retry_after_header?: string;
}

export interface ToolConnectionSpec {
  base_url: string;
  default_headers?: Record<string, string>;
  rate_limit?: ToolRateLimitSpec;
}

export interface ToolMemoryKeySpec {
  description: string;
}

export interface ToolNoneAuthSpec {
  type: "none";
  description: string;
}

export interface ToolApiKeyAuthSpec {
  type: "api_key";
  description: string;
  location: "header" | "query";
  key_name: string;
  env_var: string;
}

export interface ToolBearerTokenAuthSpec {
  type: "bearer_token";
  description: string;
  env_var: string;
}

export interface ToolBasicAuthSpec {
  type: "basic";
  description: string;
  username_env: string;
  password_env: string;
}

export interface ToolOAuth2CredentialsSpec {
  client_id_env: string;
  client_secret_env?: string;
}

export interface ToolOAuth2AuthSpec {
  type: "oauth2";
  description: string;
  flow: "authorization_code" | "client_credentials";
  authorization_url?: string;
  token_url: string;
  scopes: string[];
  credentials: ToolOAuth2CredentialsSpec;
  pkce?: boolean;
  token_storage_key: string;
}

export type ToolAuthSpec =
  | ToolNoneAuthSpec
  | ToolApiKeyAuthSpec
  | ToolBearerTokenAuthSpec
  | ToolBasicAuthSpec
  | ToolOAuth2AuthSpec;

export interface ToolFieldSpec {
  type: ToolFieldType;
  required: boolean;
  description: string;
  default?: unknown;
  enum?: unknown[];
}

export interface ToolParamSpec extends ToolFieldSpec {
  in: ToolParamLocation;
}

export interface ToolBodySpec {
  content_type: string;
  fields: Record<string, ToolFieldSpec>;
}

export interface ToolSideEffectsSpec {
  description: string;
  reversible: boolean;
}

export interface ToolResponseSpec {
  description: string;
  important_fields?: Record<string, string>;
}

export interface ToolErrorSpec {
  meaning: string;
  recovery: string;
}

export interface ToolPaginationSpec {
  type: "cursor" | "offset" | "page_number";
  description?: string;
  mechanism?: string;
  has_more?: string;
  next_page?: string;
  max_per_page?: number;
  per_page_param?: string;
  cursor_field?: string;
  cursor_param?: string;
  offset_param?: string;
  limit_param?: string;
  total_field?: string;
  page_param?: string;
  total_pages_field?: string;
}

export interface ToolOperationSpec {
  description: string;
  when_to_use: string;
  primitive: string;
  method?: string;
  path?: string;
  params?: Record<string, ToolParamSpec>;
  body?: ToolBodySpec;
  side_effects?: ToolSideEffectsSpec;
  response: ToolResponseSpec;
  errors?: Record<string, ToolErrorSpec>;
  pagination?: ToolPaginationSpec;
}

export interface ToolResourceSpec {
  description: string;
  operations: Record<string, ToolOperationSpec>;
}

export interface ToolSpec {
  spec_version: "0.1";
  tool: string;
  name: string;
  description: string;
  docs_url?: string;
  auth: ToolAuthSpec;
  connection: ToolConnectionSpec;
  memory_keys?: Record<string, ToolMemoryKeySpec>;
  resources: Record<string, ToolResourceSpec>;
}

export interface LoadedToolSpec {
  spec: ToolSpec;
  sourcePath: string;
  trustTier: TrustTier;
}

export interface OperationRegistration {
  canonicalName: string;
  providerName: string;
  toolId: string;
  resourceName: string;
  operationName: string;
  declaration: ToolDeclaration;
  operation: ToolOperationSpec;
}

export interface RegisteredToolSpec extends LoadedToolSpec {
  operations: OperationRegistration[];
}

export interface ToolManifest {
  tool: string;
  name: string;
  description: string;
  specVersion: string;
  trustTier: TrustTier;
  docsUrl?: string;
  operationCount: number;
  operations: string[];
}

export interface ToolSpecValidationResult {
  valid: boolean;
  errors: string[];
  spec?: ToolSpec;
}
