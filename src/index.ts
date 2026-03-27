import { mkdir } from "node:fs/promises";
import { loadConfig, resolveAgentHome } from "./config/loader.ts";
import { WebSocketCommunicationAdapter } from "./communication/websocket.ts";
import { OpenAICompatibleProvider } from "./llm/openai.ts";
import { PrimitiveDispatcher } from "./primitives/dispatcher.ts";
import { ScheduleStore } from "./scheduler/store.ts";
import { SchedulerService } from "./scheduler/service.ts";
import { SessionManager } from "./session/manager.ts";
import { AgentRuntime } from "./runtime/agent.ts";
import { acquirePidFile } from "./runtime/pid.ts";
import { closeDatabase, getDatabase } from "./db/database.ts";
import { resolveExecuteWorkspaceDir } from "./config/schema.ts";
import { createContinuityAwareSystemPromptBuilder } from "./continuity/prompt.ts";
import { createLogger } from "./logger.ts";

async function main(): Promise<void> {
  const log = createLogger();
  const agentHome = resolveAgentHome();
  const pidLock = await acquirePidFile(`${agentHome}/agent.pid`);
  let adapter: WebSocketCommunicationAdapter | undefined;
  let runtime: AgentRuntime | undefined;
  let scheduler: SchedulerService | undefined;
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    log.info(`Received ${signal}. Shutting down...`);

    await scheduler?.stop();
    const completed = await runtime?.shutdown(30_000);
    if (completed === false) {
      log.warn("Shutdown timed out while waiting for the active session to finish.");
    }

    await adapter?.stop();
    closeDatabase();
    await pidLock.release();
    process.exit(0);
  };

  try {
    const config = await loadConfig();
    const database = getDatabase({ agentHome: config.agentHome });
    const executeWorkspaceDir = resolveExecuteWorkspaceDir(config.agentHome);
    await mkdir(executeWorkspaceDir, { recursive: true });
    const primitiveDispatcher = new PrimitiveDispatcher({
      agentHome: config.agentHome,
      timeZone: config.runtime.timezone,
      workspaceDir: process.cwd(),
      executeWorkspaceDir,
    });
    adapter = new WebSocketCommunicationAdapter({
      port: config.communication.port,
    });
    await adapter.start();

    runtime = new AgentRuntime({
      adapter,
      llmProvider: new OpenAICompatibleProvider(),
      modelConfig: config.llm,
      sessionManager: new SessionManager({
        buildSystemPrompt: createContinuityAwareSystemPromptBuilder({
          getDatabase: () => database,
          getPolicySummary: () => primitiveDispatcher.getPolicySummary(),
          getToolManifests: () => primitiveDispatcher.listToolManifests(),
          timeZone: config.runtime.timezone,
        }),
      }),
      primitiveDispatcher,
    });
    runtime.start();

    scheduler = new SchedulerService({
      store: new ScheduleStore({
        database,
        timeZone: config.runtime.timezone,
      }),
      launchSchedule: async (schedule, firedAt) => await runtime!.launchTriggeredSchedule(schedule, firedAt),
    });
    await scheduler.start();

    process.on("SIGINT", () => {
      void shutdown("SIGINT");
    });
    process.on("SIGTERM", () => {
      void shutdown("SIGTERM");
    });

    log.info("Agent daemon ready");
    log.info(`Config: ${config.configPath}`);
    log.info(`Port: ${adapter.getPort()}`);
    log.info(`Model: ${config.llm.model}`);
    log.info(`Timezone: ${config.runtime.timezone}`);
  } catch (error) {
    await scheduler?.stop();
    await adapter?.stop();
    closeDatabase();
    await pidLock.release();
    log.error(toErrorMessage(error));
    process.exit(1);
  }
}

void main();

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
