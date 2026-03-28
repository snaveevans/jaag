import type { Database } from "bun:sqlite";
import type { CommandResponse, InboundCommand } from "../communication/adapter.ts";
import {
  COMPACTION_TRIGGER_UTILIZATION,
  DEFAULT_COMPACTION_KEEP_WINDOW,
  HARD_CEILING_UTILIZATION,
} from "../context/budget.ts";
import type { AgentConfig } from "../config/schema.ts";
import type { LoadedPolicy } from "../policy/types.ts";
import type { PrimitiveDispatcher } from "../primitives/dispatcher.ts";
import type { ScheduleStore } from "../scheduler/store.ts";
import type { SessionManager } from "../session/manager.ts";
import { RAW_PRIMITIVE_DECLARATIONS } from "../primitives/types.ts";
import { SYSTEM_TOOL_DECLARATIONS } from "../system-tools/handler.ts";

const DAEMON_VERSION = "0.1.0";

export interface CommandHandlerDeps {
  config: AgentConfig;
  primitiveDispatcher: PrimitiveDispatcher;
  startedAt: Date;
  getConnectionState: () => { connected: boolean };
  scheduleStore?: ScheduleStore;
  sessionManager?: SessionManager;
  database?: Database;
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
      case "schedules":
        return handleSchedules(deps);
      case "memory":
        return handleMemory(deps);
      case "history":
        return handleHistory(deps);
      case "compact":
        return handleCompact(deps);
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

function handleSchedules(deps: CommandHandlerDeps): CommandResponse {
  if (!deps.scheduleStore) {
    return { data: null, error: "Scheduler not available" };
  }

  const schedules = deps.scheduleStore.list({});
  return {
    data: {
      schedules: schedules.map((schedule) => ({
        id: schedule.schedule_id,
        workflow: schedule.workflow,
        group: schedule.group,
        triggerType: schedule.trigger_type,
        trigger: schedule.trigger,
        instruction: schedule.instruction,
        status: schedule.status,
        nextFireAt: schedule.next_fire_at,
        lastFiredAt: schedule.last_fired_at,
        fireCount: schedule.fire_count,
        lastFireStatus: schedule.last_fire_status,
      })),
      total: schedules.length,
    },
  };
}

function handleMemory(deps: CommandHandlerDeps): CommandResponse {
  if (!deps.database) {
    return { data: null, error: "Database not available" };
  }

  const rows = deps.database.query(
    `SELECT id, domain, key, substr(value, 1, 200) as value,
            length(value) as fullLength,
            created_at, updated_at, access_count
     FROM memory
     ORDER BY updated_at DESC
     LIMIT 25`,
  ).all() as Array<{
    id: number;
    domain: string | null;
    key: string | null;
    value: string;
    fullLength: number;
    created_at: string;
    updated_at: string;
    access_count: number;
  }>;

  return {
    data: {
      memories: rows.map((row) => ({
        id: String(row.id),
        domain: row.domain,
        key: row.key,
        value: row.fullLength > 200 ? `${row.value}...` : row.value,
        updatedAt: row.updated_at,
        accessCount: row.access_count,
      })),
      total: rows.length,
    },
  };
}

function handleHistory(deps: CommandHandlerDeps): CommandResponse {
  if (!deps.sessionManager) {
    return { data: null, error: "Session manager not available" };
  }

  const sessions = deps.sessionManager.listSessions();
  return {
    data: {
      sessions: sessions.map((session) => ({
        id: session.id,
        triggerSource: session.triggerSource,
        status: session.status,
        messageCount: session.messages.length,
        iterationCount: session.iterationCount,
        tokenEstimate: session.getMessageTokenEstimate(),
        createdAt: session.createdAt.toISOString(),
        lastActivityAt: session.lastActivityAt.toISOString(),
      })),
      total: sessions.length,
      note: "Shows active sessions only. Completed sessions are not persisted.",
    },
  };
}

function handleCompact(deps: CommandHandlerDeps): CommandResponse {
  const compactionConfig = {
    triggerUtilization: COMPACTION_TRIGGER_UTILIZATION,
    hardCeilingUtilization: HARD_CEILING_UTILIZATION,
    keepWindow: DEFAULT_COMPACTION_KEEP_WINDOW,
    contextLimit: deps.config.llm.contextLimit,
  };

  let summaries: Array<{ key: string; updatedAt: string; valuePreview: string }> = [];

  if (deps.database) {
    const rows = deps.database.query(
      `SELECT key, updated_at, substr(value, 1, 150) as value, length(value) as fullLength
       FROM memory
       WHERE key LIKE 'session_summary:%'
       ORDER BY updated_at DESC
       LIMIT 10`,
    ).all() as Array<{
      key: string;
      updated_at: string;
      value: string;
      fullLength: number;
    }>;

    summaries = rows.map((row) => ({
      key: row.key,
      updatedAt: row.updated_at,
      valuePreview: row.fullLength > 150 ? `${row.value}...` : row.value,
    }));
  }

  return {
    data: {
      config: compactionConfig,
      storedSummaries: summaries,
      summaryCount: summaries.length,
      note: "Compaction runs automatically when context utilization exceeds the trigger threshold. Manual compaction is not yet supported.",
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
