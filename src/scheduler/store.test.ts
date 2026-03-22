import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runDatabaseMigrations } from "../db/migrations.ts";
import { ScheduleStore } from "./store.ts";

const databases: Database[] = [];

afterEach(() => {
  while (databases.length > 0) {
    databases.pop()?.close(false);
  }
});

describe("ScheduleStore.update", () => {
  test("preserves due cron timing when updating metadata", () => {
    let currentTime = new Date("2026-03-21T10:00:00.000Z");
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

    expect(created.next_fire_at).toBe("2026-03-21T10:05:00.000Z");

    currentTime = new Date("2026-03-21T10:06:00.000Z");

    const updated = store.update(created.schedule_id, {
      context: {
        instruction: "Send a shorter hydration reminder.",
        tone: "brief",
      },
    });

    expect(updated).toMatchObject({
      instruction: "Send a shorter hydration reminder.",
      context: {
        instruction: "Send a shorter hydration reminder.",
        tone: "brief",
      },
      next_fire_at: "2026-03-21T10:05:00.000Z",
    });
    expect(store.listDueScheduleIds(currentTime)).toEqual([created.schedule_id]);
  });

  test("recomputes cron timing when reactivating a paused schedule", () => {
    let currentTime = new Date("2026-03-21T10:00:00.000Z");
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

    currentTime = new Date("2026-03-21T10:03:00.000Z");

    const paused = store.update(created.schedule_id, {
      status: "paused",
    });

    expect(paused).toMatchObject({
      status: "paused",
      next_fire_at: "2026-03-21T10:05:00.000Z",
    });

    currentTime = new Date("2026-03-21T10:06:00.000Z");

    const resumed = store.update(created.schedule_id, {
      status: "active",
    });

    expect(resumed).toMatchObject({
      status: "active",
      next_fire_at: "2026-03-21T10:10:00.000Z",
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
