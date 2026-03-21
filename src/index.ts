import { loadConfig, resolveAgentHome } from "./config/loader.ts";
import { WebSocketCommunicationAdapter } from "./communication/websocket.ts";
import { OpenAICompatibleProvider } from "./llm/openai.ts";
import { PrimitiveDispatcher } from "./primitives/dispatcher.ts";
import { SessionManager } from "./session/manager.ts";
import { AgentRuntime } from "./runtime/agent.ts";
import { acquirePidFile } from "./runtime/pid.ts";
import { buildBaseSystemPrompt } from "./runtime/system-prompt.ts";
import { closeDatabase, getDatabase } from "./db/database.ts";

async function main(): Promise<void> {
  const agentHome = resolveAgentHome();
  const pidLock = await acquirePidFile(`${agentHome}/agent.pid`);
  let adapter: WebSocketCommunicationAdapter | undefined;
  let runtime: AgentRuntime | undefined;
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.log(`Received ${signal}. Shutting down...`);

    const completed = await runtime?.shutdown(30_000);
    if (completed === false) {
      console.warn("Shutdown timed out while waiting for the active session to finish.");
    }

    await adapter?.stop();
    closeDatabase();
    await pidLock.release();
    process.exit(0);
  };

  try {
    const config = await loadConfig();
    getDatabase({ agentHome: config.agentHome });
    adapter = new WebSocketCommunicationAdapter({
      port: config.communication.port,
    });
    await adapter.start();

    runtime = new AgentRuntime({
      adapter,
      llmProvider: new OpenAICompatibleProvider(),
      modelConfig: config.llm,
      sessionManager: new SessionManager({
        buildSystemPrompt: buildBaseSystemPrompt,
      }),
      primitiveDispatcher: new PrimitiveDispatcher({
        agentHome: config.agentHome,
        workspaceDir: process.cwd(),
      }),
    });
    runtime.start();

    process.on("SIGINT", () => {
      void shutdown("SIGINT");
    });
    process.on("SIGTERM", () => {
      void shutdown("SIGTERM");
    });

    console.log("Agent daemon ready");
    console.log(`Config: ${config.configPath}`);
    console.log(`Port: ${adapter.getPort()}`);
    console.log(`Model: ${config.llm.model}`);
  } catch (error) {
    await adapter?.stop();
    closeDatabase();
    await pidLock.release();
    console.error(toErrorMessage(error));
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
