import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommunicationAdapter, DeliveryResult, InboundMessage, OutboundMessage } from "../communication/adapter.ts";
import { runDatabaseMigrations } from "../db/migrations.ts";
import { OpenAICompatibleProvider } from "../llm/openai.ts";
import { PrimitiveDispatcher } from "../primitives/dispatcher.ts";
import { AgentRuntime } from "../runtime/agent.ts";
import { buildBaseSystemPrompt } from "../runtime/system-prompt.ts";
import { SessionManager } from "../session/manager.ts";
import { SchedulerService } from "./service.ts";
import { ScheduleStore } from "./store.ts";
import type { TriggeredScheduleContext } from "./types.ts";

const databases: Database[] = [];
const servers: Bun.Server<unknown>[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    servers.pop()?.stop(true);
  }

  while (databases.length > 0) {
    databases.pop()?.close(false);
  }

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

class RecordingAdapter implements CommunicationAdapter {
  sentMessages: OutboundMessage[] = [];
  private handler: ((message: InboundMessage) => void) | null = null;

  async send(message: OutboundMessage): Promise<DeliveryResult> {
    this.sentMessages.push(message);
    return { delivered: true };
  }

  onMessage(handler: (message: InboundMessage) => void): void {
    this.handler = handler;
  }

  isConnected(): boolean {
    return true;
  }

  dispatchInbound(content: string, timestamp = new Date(), replyToPromptId?: string): void {
    this.handler?.({ content, timestamp, replyToPromptId });
  }
}

describe("SchedulerService", () => {
  test("fires once schedules and marks them completed before launch", async () => {
    let currentTime = new Date("2026-03-21T10:00:00.000Z");
    const store = createStore(() => currentTime);
    const created = store.create({
      workflow: "stretch",
      context: { instruction: "Tell the user to stretch." },
      trigger: {
        type: "once",
        at: "2026-03-21T09:55:00.000Z",
      },
    });

    const launchedStates: Array<{ schedule: TriggeredScheduleContext; persistedStatus: string | undefined }> = [];
    const service = new SchedulerService({
      store,
      now: () => currentTime,
      launchSchedule: async (schedule) => {
        launchedStates.push({
          schedule,
          persistedStatus: store.getById(schedule.schedule_id)?.status,
        });
        return true;
      },
    });

    await service.runTick();
    await Bun.sleep(0);

    expect(launchedStates).toHaveLength(1);
    expect(launchedStates[0]).toMatchObject({
      schedule: {
        schedule_id: created.schedule_id,
        instruction: "Tell the user to stretch.",
      },
      persistedStatus: "completed",
    });

    expect(store.getById(created.schedule_id)).toMatchObject({
      status: "completed",
      fire_count: 1,
      last_fired_at: "2026-03-21T10:00:00.000Z",
      next_fire_at: null,
      last_fire_status: "success",
    });
  });

  test("fires missed cron schedules once and recomputes from the current time", async () => {
    let currentTime = new Date("2026-03-21T00:00:00.000Z");
    const store = createStore(() => currentTime);
    const created = store.create({
      workflow: "hydration",
      context: { instruction: "Send a hydration reminder." },
      trigger: {
        type: "cron",
        expression: "*/5 * * * *",
        cron: "*/5 * * * *",
      },
    });

    currentTime = new Date("2026-03-21T00:21:00.000Z");

    const launchedIds: string[] = [];
    const service = new SchedulerService({
      store,
      now: () => currentTime,
      launchSchedule: async (schedule) => {
        launchedIds.push(schedule.schedule_id);
        return true;
      },
    });

    await service.runTick();
    await service.runTick();
    await Bun.sleep(0);

    expect(launchedIds).toEqual([created.schedule_id]);
    expect(store.getById(created.schedule_id)).toMatchObject({
      status: "active",
      fire_count: 1,
      last_fired_at: "2026-03-21T00:21:00.000Z",
      next_fire_at: "2026-03-21T00:25:00.000Z",
      last_fire_status: "success",
    });
  });

  test("fires persisted schedules through runtime and completes notify-only runs across OpenAI translation", async () => {
    let currentTime = new Date("2026-03-21T10:00:00.000Z");
    const database = createDatabase();

    const rootDir = await mkdtemp(join(tmpdir(), "scheduler-service-trigger-e2e-"));
    tempDirs.push(rootDir);

    const agentHome = join(rootDir, ".agent");
    const workspaceDir = join(rootDir, "workspace");
    await mkdir(agentHome, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const requestBodies: Array<Record<string, unknown>> = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const requestBody = (await request.json()) as Record<string, unknown>;
        requestBodies.push(requestBody);

        const messages = requestBody.messages as Array<Record<string, unknown>> | undefined;
        const assistantToolMessage = messages?.find(
          (message) => message.role === "assistant" && Array.isArray(message.tool_calls),
        );

        if (assistantToolMessage?.content === "") {
          return Response.json({
            error: {
              message: "assistant tool-call content must be null",
            },
          }, { status: 400 });
        }

        if (requestBodies.length === 1) {
          return new Response(buildSseBody([
            'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_notify","type":"function","function":{"name":"interact"}}]},"finish_reason":null}]}\n\n',
            'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"mode\\":\\"notify\\",\\"message\\":\\"Drink "}}]},"finish_reason":null}]}\n\n',
            'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"water now.\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
            "data: [DONE]\n\n",
          ]), {
            headers: {
              "content-type": "text/event-stream",
            },
          });
        }

        return new Response(buildSseBody(["data: [DONE]\n\n"]), {
          headers: {
            "content-type": "text/event-stream",
          },
        });
      },
    });
    servers.push(server);

    const dispatcher = new PrimitiveDispatcher({
      agentHome,
      workspaceDir,
      getDatabase: () => database,
      now: () => currentTime,
    });
    const adapter = new RecordingAdapter();
    const runtime = new AgentRuntime({
      adapter,
      llmProvider: new OpenAICompatibleProvider(),
      modelConfig: {
        model: "gpt-4o-mini",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        temperature: 0,
        maxOutputTokens: 128,
        apiKey: "test-key",
      },
      sessionManager: new SessionManager({
        buildSystemPrompt: ({ now, triggeredSchedule }) => buildBaseSystemPrompt({
          now,
          triggeredSchedule,
          policySummary: dispatcher.getPolicySummary(),
          toolManifests: dispatcher.listToolManifests(),
        }),
      }),
      primitiveDispatcher: dispatcher,
    });
    const store = new ScheduleStore({
      database,
      now: () => currentTime,
    });
    const service = new SchedulerService({
      store,
      now: () => currentTime,
      launchSchedule: async (schedule, firedAt) => await runtime.launchTriggeredSchedule(schedule, firedAt),
    });

    runtime.start();

    try {
      const createResult = await dispatcher.dispatch(
        "schedule",
        {
          operation: "create",
          workflow: "hydration",
          instruction: "Notify the user to drink water.",
          trigger: {
            type: "once",
            at: "2026-03-21T09:55:00.000Z",
          },
        },
        { sessionId: "schedule-create", triggerSource: "user" },
      );

      expect(createResult).toMatchObject({
        success: true,
      });

      const created = (createResult.data as { schedule: { schedule_id: string } }).schedule;
      expect(store.getById(created.schedule_id)).toMatchObject({
        schedule_id: created.schedule_id,
        status: "active",
        instruction: "Notify the user to drink water.",
        next_fire_at: "2026-03-21T09:55:00.000Z",
      });

      await service.runTick();

      await waitForCondition(
        () => requestBodies.length === 2,
        1_000,
        "Timed out waiting for the provider follow-up request after the notify tool result",
      );
      expect(await runtime.waitForIdle(1_000)).toBe(true);
      await waitForCondition(
        () => store.getById(created.schedule_id)?.last_fire_status === "success",
        1_000,
        "Timed out waiting for the schedule execution result",
      );

      expect(adapter.sentMessages).toEqual([
        expect.objectContaining({
          mode: "notify",
          content: "Drink water now.",
        }),
      ]);

      const firstRequestMessages = requestBodies[0]?.messages as Array<Record<string, unknown>>;
      const secondRequestMessages = requestBodies[1]?.messages as Array<Record<string, unknown>>;
      const secondRequestAssistantMessage = secondRequestMessages.find((message) => message.role === "assistant");

      expect(firstRequestMessages[0]?.role).toBe("system");
      expect(firstRequestMessages[0]?.content).toEqual(expect.stringContaining(`schedule_id: ${created.schedule_id}`));
      expect(firstRequestMessages[0]?.content).toEqual(expect.stringContaining("instruction: Notify the user to drink water."));
      expect((requestBodies[0]?.tools as Array<Record<string, unknown>>).some((tool) => {
        const fn = tool.function;
        return !!fn && typeof fn === "object" && (fn as { name?: unknown }).name === "interact";
      })).toBe(true);

      expect(secondRequestAssistantMessage).toMatchObject({
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_notify",
          type: "function",
          function: {
            name: "interact",
            arguments: '{"mode":"notify","message":"Drink water now."}',
          },
        }],
      });
      expect(secondRequestAssistantMessage?.content).not.toBe("");
      expect(secondRequestMessages.find((message) => message.role === "tool")).toMatchObject({
        role: "tool",
        tool_call_id: "call_notify",
      });
      expect(store.getById(created.schedule_id)).toMatchObject({
        status: "completed",
        fire_count: 1,
        last_fired_at: "2026-03-21T10:00:00.000Z",
        next_fire_at: null,
        last_fire_status: "success",
      });
    } finally {
      await runtime.shutdown(1_000);
    }
  });

  test("reconciles interrupted schedules on startup before normal ticking", async () => {
    let currentTime = new Date("2026-03-21T10:20:00.000Z");
    const store = createStore(() => currentTime);
    const created = store.create({
      workflow: "hydration",
      context: { instruction: "Send a hydration reminder." },
      trigger: {
        type: "cron",
        expression: "*/5 * * * *",
        cron: "*/5 * * * *",
      },
    });

    store.advanceForExecution(created.schedule_id, new Date("2026-03-21T10:25:00.000Z"));
    expect(store.getById(created.schedule_id)?.last_fire_status).toBeNull();

    currentTime = new Date("2026-03-21T10:30:00.000Z");

    const launchedIds: string[] = [];
    const service = new SchedulerService({
      store,
      now: () => currentTime,
      tickIntervalMs: 60_000,
      launchSchedule: async (schedule) => {
        launchedIds.push(schedule.schedule_id);
        return true;
      },
    });

    await service.start();
    await Bun.sleep(0);
    await service.stop();

    expect(launchedIds).toEqual([created.schedule_id]);
    expect(store.getById(created.schedule_id)).toMatchObject({
      last_fired_at: "2026-03-21T10:30:00.000Z",
      last_fire_status: "success",
      fire_count: 2,
      next_fire_at: "2026-03-21T10:35:00.000Z",
    });
  });
});

function createStore(now: () => Date): ScheduleStore {
  const database = createDatabase();

  return new ScheduleStore({
    database,
    now,
  });
}

function createDatabase(): Database {
  const database = new Database(":memory:", {
    create: true,
    strict: true,
  });
  database.run("PRAGMA journal_mode = WAL");
  runDatabaseMigrations(database);
  databases.push(database);
  return database;
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs: number,
  errorMessage: string,
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(errorMessage);
    }

    await Bun.sleep(10);
  }
}

function buildSseBody(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });
}
