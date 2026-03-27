import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runDatabaseMigrations } from "../db/migrations.ts";
import { createContinuityAwareSystemPromptBuilder } from "./prompt.ts";

const databases: Database[] = [];

afterEach(() => {
  while (databases.length > 0) {
    databases.pop()?.close(false);
  }
});

describe("createContinuityAwareSystemPromptBuilder", () => {
  test("adds the continuity block for new interactive sessions only", async () => {
    const database = createDatabase();
    insertMemory(
      database,
      null,
      "session_summary:2026-03-25T10:00:00.000Z",
      "The last session ended after planning the refactor.",
      "2026-03-25T10:00:00.000Z",
    );
    insertMemory(
      database,
      null,
      "user.preference:status_updates",
      "Prefers short status updates.",
      "2026-03-25T09:00:00.000Z",
    );

    const buildPrompt = createContinuityAwareSystemPromptBuilder({
      getDatabase: () => database,
      timeZone: "UTC",
      getPolicySummary: () => "Shell writes require approval.",
      getToolManifests: () => [],
    });

    const interactivePrompt = await buildPrompt({
      now: new Date("2026-03-25T11:00:00.000Z"),
      triggerSource: "user",
    });
    const triggeredPrompt = await buildPrompt({
      now: new Date("2026-03-25T11:00:00.000Z"),
      triggerSource: "schedule",
      triggeredSchedule: {
        schedule_id: "schedule-1",
        workflow: "hydration",
        group: null,
        trigger: { type: "once", at: "2026-03-25T11:00:00.000Z" },
        context: { instruction: "Send the reminder." },
        instruction: "Send the reminder.",
      },
    });

    expect(interactivePrompt).toContain("Session continuity from persisted memory:");
    expect(interactivePrompt).toContain("The last session ended after planning the refactor.");
    expect(interactivePrompt).toContain("user.preference:status_updates: Prefers short status updates.");
    expect(interactivePrompt).toContain("Policy summary: Shell writes require approval.");

    expect(triggeredPrompt).not.toContain("Session continuity from persisted memory:");
    expect(triggeredPrompt).toContain("Triggered schedule context:");
    expect(triggeredPrompt).toContain("schedule_id: schedule-1");
  });

  test("preserves existing behavior when no continuity data exists", async () => {
    const database = createDatabase();
    const buildPrompt = createContinuityAwareSystemPromptBuilder({
      getDatabase: () => database,
      timeZone: "UTC",
      getToolManifests: () => [],
    });

    const prompt = await buildPrompt({
      now: new Date("2026-03-25T11:00:00.000Z"),
      triggerSource: "user",
    });

    expect(prompt).not.toContain("Session continuity from persisted memory:");
    expect(prompt).toContain("Available primitive functions:");
  });
});

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

function insertMemory(database: Database, domain: string | null, key: string, value: string, timestamp: string): void {
  database.run(
    "INSERT INTO memory (domain, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    [domain, key, value, timestamp, timestamp],
  );
}
