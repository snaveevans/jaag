import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDatabaseMigrations } from "../db/migrations.ts";
import { PrimitiveDispatcher } from "./dispatcher.ts";

const databases: Database[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
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

describe("schedule primitive", () => {
  test("creates, gets, lists, updates, and deletes schedules", async () => {
    const { dispatcher } = await createHarness(new Date("2026-03-21T10:00:00.000Z"));

    const created = await dispatcher.dispatch(
      "schedule",
      {
        operation: "create",
        workflow: "hydration",
        group: "wellness",
        instruction: "Remind the user to drink water.",
        trigger: {
          type: "cron",
          cron: "0 */2 * * *",
        },
      },
      { sessionId: "session-1" },
    );

    expect(created).toMatchObject({
      success: true,
      data: {
        schedule: {
          workflow: "hydration",
          group: "wellness",
          instruction: "Remind the user to drink water.",
          trigger_type: "cron",
          trigger: {
            type: "cron",
            expression: "0 */2 * * *",
            cron: "0 */2 * * *",
          },
          next_fire_at: "2026-03-21T12:00:00.000Z",
          fire_count: 0,
        },
      },
    });

    const scheduleId = ((created.data as { schedule: { schedule_id: string } }).schedule.schedule_id);

    const fetched = await dispatcher.dispatch(
      "schedule",
      {
        operation: "get",
        id: scheduleId,
      },
      { sessionId: "session-1" },
    );

    expect(fetched).toMatchObject({
      success: true,
      data: {
        schedule: {
          schedule_id: scheduleId,
          context: {
            instruction: "Remind the user to drink water.",
          },
        },
      },
    });

    const createdOnce = await dispatcher.dispatch(
      "schedule",
      {
        operation: "create",
        workflow: "hydration",
        group: "wellness",
        context: {
          instruction: "Ask whether the user already had water.",
          hint: "gentle",
        },
        trigger: {
          type: "once",
          at: "2026-03-21T10:30:00.000Z",
        },
      },
      { sessionId: "session-1" },
    );

    expect(createdOnce).toMatchObject({
      success: true,
      data: {
        schedule: {
          context: {
            instruction: "Ask whether the user already had water.",
            hint: "gentle",
          },
          next_fire_at: "2026-03-21T10:30:00.000Z",
        },
      },
    });

    const listed = await dispatcher.dispatch(
      "schedule",
      {
        operation: "list",
        filters: {
          workflow: "hydration",
          group: "wellness",
        },
      },
      { sessionId: "session-1" },
    );

    expect(listed).toMatchObject({
      success: true,
      data: {
        schedules: expect.arrayContaining([
          expect.objectContaining({ schedule_id: scheduleId }),
        ]),
      },
    });

    const updated = await dispatcher.dispatch(
      "schedule",
      {
        operation: "update",
        schedule_id: scheduleId,
        instruction: "Send a shorter hydration reminder.",
        context: {
          tone: "brief",
        },
        trigger: {
          type: "once",
          at: "2026-03-21T11:15:00.000Z",
        },
      },
      { sessionId: "session-1" },
    );

    expect(updated).toMatchObject({
      success: true,
      data: {
        schedule: {
          schedule_id: scheduleId,
          instruction: "Send a shorter hydration reminder.",
          context: {
            instruction: "Send a shorter hydration reminder.",
            tone: "brief",
          },
          trigger: {
            type: "once",
            at: "2026-03-21T11:15:00.000Z",
          },
          next_fire_at: "2026-03-21T11:15:00.000Z",
        },
      },
    });

    const deleted = await dispatcher.dispatch(
      "schedule",
      {
        operation: "delete",
        group: "wellness",
      },
      { sessionId: "session-1" },
    );

    expect(deleted).toEqual({
      success: true,
      data: {
        deleted: true,
        count: 2,
      },
    });
  });

  test("returns field-named repair errors for schedule inputs", async () => {
    const { dispatcher } = await createHarness();

    const invalidGroup = await dispatcher.dispatch(
      "schedule",
      {
        operation: "delete",
        group: "   ",
      },
      { sessionId: "session-1" },
    );

    expect(invalidGroup).toEqual({
      success: false,
      error: "Invalid group: expected a non-empty string.",
    });

    const invalidNestedInstruction = await dispatcher.dispatch(
      "schedule",
      {
        operation: "create",
        workflow: "hydration",
        context: {
          instruction: "   ",
        },
        trigger: {
          type: "once",
          at: "2026-03-21T10:30:00.000Z",
        },
      },
      { sessionId: "session-1" },
    );

    expect(invalidNestedInstruction).toEqual({
      success: false,
      error: "Invalid context.instruction: expected a non-empty string.",
    });

    const invalidFilterGroup = await dispatcher.dispatch(
      "schedule",
      {
        operation: "list",
        filters: {
          group: "   ",
        },
      },
      { sessionId: "session-1" },
    );

    expect(invalidFilterGroup).toEqual({
      success: false,
      error: "Invalid filters.group: expected a non-empty string.",
    });
  });

  test("returns success false when schedule update or delete targets are missing", async () => {
    const { dispatcher } = await createHarness();

    const missingUpdate = await dispatcher.dispatch(
      "schedule",
      {
        operation: "update",
        schedule_id: "missing-schedule",
        instruction: "Try to update a missing schedule.",
      },
      { sessionId: "session-1" },
    );

    expect(missingUpdate).toMatchObject({
      success: false,
      error: "Schedule not found: missing-schedule.",
      data: {
        schedule: null,
      },
    });

    const missingDeleteById = await dispatcher.dispatch(
      "schedule",
      {
        operation: "delete",
        schedule_id: "missing-schedule",
      },
      { sessionId: "session-1" },
    );

    expect(missingDeleteById).toMatchObject({
      success: false,
      error: "Schedule not found: missing-schedule.",
      data: {
        deleted: false,
        count: 0,
      },
    });

    const missingDeleteByGroup = await dispatcher.dispatch(
      "schedule",
      {
        operation: "delete",
        group: "missing-group",
      },
      { sessionId: "session-1" },
    );

    expect(missingDeleteByGroup).toMatchObject({
      success: false,
      error: "No schedules found for group: missing-group.",
      data: {
        deleted: false,
        count: 0,
      },
    });
  });

  test("rejects event schedules with a clear error", async () => {
    const { dispatcher } = await createHarness();

    const result = await dispatcher.dispatch(
      "schedule",
      {
        operation: "create",
        workflow: "github-watch",
        instruction: "Watch for newly assigned issues.",
        trigger: {
          type: "event",
          source: "github",
          event: "issues.assigned",
        },
      },
      { sessionId: "session-1" },
    );

    expect(result).toEqual({
      success: false,
      error: "Event schedules are not supported yet.",
    });
  });

  test("uses nested trigger.type for policy enforcement", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "agent-schedule-policy-"));
    tempDirs.push(rootDir);

    const homeDir = join(rootDir, "home");
    const agentHome = join(homeDir, ".agent");
    const workspaceDir = join(rootDir, "workspace");
    const policyDir = join(homeDir, ".agent-policy");
    await mkdir(agentHome, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(policyDir, { recursive: true });
    await Bun.write(join(policyDir, "policy.yaml"), `rules:\n  - primitive: schedule\n    match: { trigger_type: [cron] }\n    action: block\n  - primitive: schedule\n    action: allow\n`);

    const database = createDatabase();
    const dispatcher = new PrimitiveDispatcher({
      agentHome,
      workspaceDir,
      getDatabase: () => database,
    });

    const result = await dispatcher.dispatch(
      "schedule",
      {
        operation: "create",
        workflow: "hydration",
        instruction: "Blocked cron schedule.",
        trigger: {
          type: "cron",
          cron: "0 * * * *",
        },
      },
      { sessionId: "session-1" },
    );

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("Policy blocked"),
    });
  });
});

async function createHarness(now = new Date("2026-03-21T10:00:00.000Z")) {
  const rootDir = await mkdtemp(join(tmpdir(), "agent-schedule-test-"));
  tempDirs.push(rootDir);

  const homeDir = join(rootDir, "home");
  const agentHome = join(homeDir, ".agent");
  const workspaceDir = join(rootDir, "workspace");
  await mkdir(agentHome, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });

  const database = createDatabase();
  const dispatcher = new PrimitiveDispatcher({
    agentHome,
    workspaceDir,
    getDatabase: () => database,
    now: () => now,
  });

  return { dispatcher, database };
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
