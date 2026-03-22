import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runDatabaseMigrations } from "../db/migrations.ts";
import { SchedulerService } from "./service.ts";
import { ScheduleStore } from "./store.ts";
import type { TriggeredScheduleContext } from "./types.ts";

const databases: Database[] = [];

afterEach(() => {
  while (databases.length > 0) {
    databases.pop()?.close(false);
  }
});

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
});

function createStore(now: () => Date): ScheduleStore {
  const database = new Database(":memory:", {
    create: true,
    strict: true,
  });
  database.run("PRAGMA journal_mode = WAL");
  runDatabaseMigrations(database);
  databases.push(database);

  return new ScheduleStore({
    database,
    now,
  });
}
