import { homedir } from "node:os";
import { join } from "node:path";

export const AGENT_DIR_NAME = ".agent";
export const DEFAULT_AGENT_HOME = join(homedir(), AGENT_DIR_NAME);
export const DEFAULT_CONFIG_PATH = join(DEFAULT_AGENT_HOME, "config.yaml");
export const DEFAULT_PID_PATH = join(DEFAULT_AGENT_HOME, "agent.pid");
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

export interface RawAgentConfigFile {
  llm?: {
    provider?: string;
    model?: string;
    base_url?: string;
    context_limit?: number;
    max_output_tokens?: number;
    temperature?: number;
    api_key_env?: string;
  };
  communication?: {
    type?: string;
    port?: number;
  };
  runtime?: {
    timezone?: string;
  };
}

export interface RuntimeLLMConfig {
  provider: "openai";
  model: string;
  baseUrl: string;
  contextLimit: number;
  maxOutputTokens: number;
  temperature: number;
  apiKeyEnv: string;
  apiKey: string;
}

export interface AgentConfig {
  agentHome: string;
  configPath: string;
  pidPath: string;
  llm: RuntimeLLMConfig;
  runtime: {
    timezone: string;
  };
  communication: {
    type: "websocket";
    port: number;
  };
}

export const CONFIG_EXAMPLE = `llm:
  provider: openai
  model: gpt-4o-mini
  base_url: https://api.openai.com/v1
  context_limit: 128000
  max_output_tokens: 4096
  temperature: 0
  api_key_env: OPENAI_API_KEY

communication:
  type: websocket
  port: 8765

runtime:
  timezone: UTC
`;
