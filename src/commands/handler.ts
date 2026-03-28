import type { CommandResponse, InboundCommand } from "../communication/adapter.ts";
import type { AgentConfig } from "../config/schema.ts";
import type { LoadedPolicy } from "../policy/types.ts";
import type { PrimitiveDispatcher } from "../primitives/dispatcher.ts";
import { RAW_PRIMITIVE_DECLARATIONS } from "../primitives/types.ts";
import { SYSTEM_TOOL_DECLARATIONS } from "../system-tools/handler.ts";

const DAEMON_VERSION = "0.1.0";

export interface CommandHandlerDeps {
  config: AgentConfig;
  primitiveDispatcher: PrimitiveDispatcher;
  startedAt: Date;
  getConnectionState: () => { connected: boolean };
}

export function createCommandHandler(deps: CommandHandlerDeps) {
  return async (command: InboundCommand): Promise<CommandResponse> => {
    switch (command.command) {
      case "model":
        return handleModel(deps);
      case "tools":
        return handleTools(deps);
      case "policy":
        return handlePolicy(deps);
      case "status":
        return handleStatus(deps);
      default:
        return { data: null, error: `Unknown command: ${command.command}` };
    }
  };
}

function handleModel(deps: CommandHandlerDeps): CommandResponse {
  const { model, provider, baseUrl, contextLimit, maxOutputTokens, temperature } = deps.config.llm;

  return {
    data: {
      model,
      provider,
      baseUrl,
      contextLimit,
      maxOutputTokens,
      temperature,
    },
  };
}

function handleTools(deps: CommandHandlerDeps): CommandResponse {
  return {
    data: {
      primitives: RAW_PRIMITIVE_DECLARATIONS.map(({ name, description }) => ({
        name,
        description,
      })),
      systemTools: SYSTEM_TOOL_DECLARATIONS.map(({ name, description }) => ({
        name,
        description,
      })),
      registryTools: deps.primitiveDispatcher.listToolManifests().map((tool) => ({
        name: tool.tool,
        description: tool.description,
        trustTier: tool.trustTier,
        operationCount: tool.operationCount,
      })),
    },
  };
}

function handlePolicy(deps: CommandHandlerDeps): CommandResponse {
  const policy = deps.primitiveDispatcher.getPolicy();

  return {
    data: {
      policyPath: policy.policyPath,
      rules: policy.rules.map((rule) => toReadablePolicyRule(rule)),
      summary: deps.primitiveDispatcher.getPolicySummary(),
    },
  };
}

function handleStatus(deps: CommandHandlerDeps): CommandResponse {
  const uptime = Date.now() - deps.startedAt.getTime();

  return {
    data: {
      uptime,
      uptimeFormatted: formatUptime(uptime),
      model: deps.config.llm.model,
      provider: deps.config.llm.provider,
      port: deps.config.communication.port,
      connected: deps.getConnectionState().connected,
      timezone: deps.config.runtime.timezone,
      agentHome: deps.config.agentHome,
      workspace: process.cwd(),
      version: DAEMON_VERSION,
    },
  };
}

function toReadablePolicyRule(rule: LoadedPolicy["rules"][number]) {
  return rule.match
    ? {
        id: rule.id,
        primitive: rule.primitive,
        action: rule.action,
        match: rule.match,
      }
    : {
        id: rule.id,
        primitive: rule.primitive,
        action: rule.action,
      };
}

function formatUptime(uptimeMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(uptimeMs / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];

  if (days > 0) {
    parts.push(`${days}d`);
  }

  if (hours > 0) {
    parts.push(`${hours}h`);
  }

  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }

  if (seconds > 0 || parts.length === 0) {
    parts.push(`${seconds}s`);
  }

  return parts.join(" ");
}
