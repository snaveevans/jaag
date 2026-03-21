import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import {
  AGENT_DIR_NAME,
  CONFIG_EXAMPLE,
  DEFAULT_CONFIG_PATH,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_PID_PATH,
  type AgentConfig,
  type RawAgentConfigFile,
} from "./schema.ts";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface LoadConfigOptions {
  homeDir?: string;
  env?: Record<string, string | undefined>;
}

export function resolveAgentHome(homeDir = homedir()): string {
  return join(homeDir, AGENT_DIR_NAME);
}

export function resolveConfigPath(homeDir = homedir()): string {
  if (homeDir === homedir()) {
    return DEFAULT_CONFIG_PATH;
  }

  return join(resolveAgentHome(homeDir), "config.yaml");
}

export function resolvePidPath(homeDir = homedir()): string {
  if (homeDir === homedir()) {
    return DEFAULT_PID_PATH;
  }

  return join(resolveAgentHome(homeDir), "agent.pid");
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<AgentConfig> {
  const homeDir = options.homeDir ?? homedir();
  const configPath = resolveConfigPath(homeDir);
  const agentHome = resolveAgentHome(homeDir);
  const env = options.env ?? process.env;

  try {
    await access(configPath, constants.F_OK);
  } catch {
    throw new ConfigError(
      `Missing config at ${configPath}. Create ~/.agent/config.yaml with content like:\n\n${CONFIG_EXAMPLE}`,
    );
  }

  let parsed: RawAgentConfigFile;

  try {
    const rawText = await readFile(configPath, "utf8");
    const rawValue = parse(rawText) as RawAgentConfigFile | null;
    parsed = rawValue ?? {};
  } catch (error) {
    throw new ConfigError(
      `Failed to parse config at ${configPath}: ${toErrorMessage(error)}`,
    );
  }

  const llm = parsed.llm ?? {};
  const communication = parsed.communication ?? {};

  const provider = requireString(llm.provider, "llm.provider");
  if (provider !== "openai") {
    throw new ConfigError(
      `Unsupported llm.provider "${provider}". Slice 01 supports only "openai" for OpenAI-compatible APIs.`,
    );
  }

  const model = requireString(llm.model, "llm.model");
  const apiKeyEnv = requireString(llm.api_key_env, "llm.api_key_env");
  const apiKey = env[apiKeyEnv];

  if (!apiKey) {
    throw new ConfigError(
      `Missing API key environment variable ${apiKeyEnv}. Export it before starting the daemon.`,
    );
  }

  const port = requireInteger(communication.port, "communication.port", { min: 1, max: 65535 });
  const contextLimit = requireInteger(llm.context_limit, "llm.context_limit", { min: 1 });
  const maxOutputTokens = requireInteger(llm.max_output_tokens, "llm.max_output_tokens", { min: 1 });
  const temperature = requireNumber(llm.temperature, "llm.temperature");
  const communicationType = requireString(communication.type, "communication.type");

  if (communicationType !== "websocket") {
    throw new ConfigError(
      `Unsupported communication.type "${communicationType}". Slice 01 supports only "websocket".`,
    );
  }

  return {
    agentHome,
    configPath,
    pidPath: resolvePidPath(homeDir),
    llm: {
      provider: "openai",
      model,
      baseUrl: llm.base_url ?? DEFAULT_OPENAI_BASE_URL,
      contextLimit,
      maxOutputTokens,
      temperature,
      apiKeyEnv,
      apiKey,
    },
    communication: {
      type: "websocket",
      port,
    },
  };
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`Missing or invalid ${fieldName}.`);
  }

  return value.trim();
}

function requireNumber(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ConfigError(`Missing or invalid ${fieldName}.`);
  }

  return value;
}

function requireInteger(
  value: unknown,
  fieldName: string,
  bounds: { min?: number; max?: number } = {},
): number {
  const numberValue = requireNumber(value, fieldName);
  if (!Number.isInteger(numberValue)) {
    throw new ConfigError(`Missing or invalid ${fieldName}. Expected an integer.`);
  }

  if (bounds.min !== undefined && numberValue < bounds.min) {
    throw new ConfigError(`${fieldName} must be >= ${bounds.min}.`);
  }

  if (bounds.max !== undefined && numberValue > bounds.max) {
    throw new ConfigError(`${fieldName} must be <= ${bounds.max}.`);
  }

  return numberValue;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
