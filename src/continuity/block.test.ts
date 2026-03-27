import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runDatabaseMigrations } from "../db/migrations.ts";
import { buildContinuityBlock, loadContinuitySnapshot } from "./block.ts";

const databases: Database[] = [];

afterEach(() => {
  while (databases.length > 0) {
    databases.pop()?.close(false);
  }
});

describe("continuity block", () => {
  test("builds a bounded block from recent summaries and allowlisted null-domain keys", () => {
    const database = createDatabase();

    insertMemory(database, null, "session_summary:2026-03-25T10:00:00.000Z", "Most recent summary about the current repo and next steps.", "2026-03-25T10:00:00.000Z");
    insertMemory(database, null, "session_summary:2026-03-25T09:00:00.000Z", "Previous summary that still matters.", "2026-03-25T09:00:00.000Z");
    insertMemory(database, null, "session_summary:2026-03-25T08:00:00.000Z", "Older summary that still fits.", "2026-03-25T08:00:00.000Z");
    insertMemory(database, null, "session_summary:2026-03-25T07:00:00.000Z", "Should be omitted by max summary count.", "2026-03-25T07:00:00.000Z");
    insertMemory(database, null, "user.preference:email_style", "Prefers concise, direct updates.", "2026-03-25T06:00:00.000Z");
    insertMemory(database, null, "user.profile:role", "Works as a staff engineer.", "2026-03-25T05:00:00.000Z");
    insertMemory(database, null, "project.context:repo", "Primary repo is playground.", "2026-03-25T04:00:00.000Z");
    insertMemory(database, null, "project.context:api_token", "secret-value", "2026-03-25T03:00:00.000Z");
    insertMemory(database, null, "oauth:github:token", "gho_secret", "2026-03-25T02:00:00.000Z");
    insertMemory(database, "gmail", "user.preference:cross_domain_should_not_appear", "wrong domain", "2026-03-25T01:00:00.000Z");

    const snapshot = loadContinuitySnapshot(database);
    expect(snapshot).toEqual({
      summaries: [
        {
          key: "session_summary:2026-03-25T10:00:00.000Z",
          value: "Most recent summary about the current repo and next steps.",
          updatedAt: "2026-03-25T10:00:00.000Z",
        },
        {
          key: "session_summary:2026-03-25T09:00:00.000Z",
          value: "Previous summary that still matters.",
          updatedAt: "2026-03-25T09:00:00.000Z",
        },
        {
          key: "session_summary:2026-03-25T08:00:00.000Z",
          value: "Older summary that still fits.",
          updatedAt: "2026-03-25T08:00:00.000Z",
        },
      ],
      longLived: [
        {
          key: "user.preference:email_style",
          value: "Prefers concise, direct updates.",
          updatedAt: "2026-03-25T06:00:00.000Z",
        },
        {
          key: "user.profile:role",
          value: "Works as a staff engineer.",
          updatedAt: "2026-03-25T05:00:00.000Z",
        },
        {
          key: "project.context:repo",
          value: "Primary repo is playground.",
          updatedAt: "2026-03-25T04:00:00.000Z",
        },
      ],
    });

    const block = buildContinuityBlock(database);
    expect(block).toContain("Session continuity from persisted memory:");
    expect(block).toContain("Some items below are conversation summaries written automatically by the runtime.");
    expect(block).toContain("Recent session summaries:");
    expect(block).toContain("Long-lived user/project context:");
    expect(block).toContain("2026-03-25T10:00:00.000Z: Most recent summary about the current repo and next steps.");
    expect(block).toContain("user.preference:email_style: Prefers concise, direct updates.");
    expect(block).not.toContain("Should be omitted by max summary count");
    expect(block).not.toContain("project.context:api_token");
    expect(block).not.toContain("oauth:github:token");
    expect(block).not.toContain("cross_domain_should_not_appear");
  });

  test("returns null when no eligible continuity memory exists", () => {
    const database = createDatabase();

    insertMemory(database, null, "oauth:github:token", "secret-value", "2026-03-25T10:00:00.000Z");
    insertMemory(database, "github", "project.context:repo", "playground", "2026-03-25T09:00:00.000Z");

    expect(loadContinuitySnapshot(database)).toEqual({
      summaries: [],
      longLived: [],
    });
    expect(buildContinuityBlock(database)).toBeNull();
  });

  test("truncates overly long continuity values to keep the block bounded", () => {
    const database = createDatabase();
    insertMemory(
      database,
      null,
      "session_summary:2026-03-25T10:00:00.000Z",
      "summary ".repeat(80),
      "2026-03-25T10:00:00.000Z",
    );

    const snapshot = loadContinuitySnapshot(database, {
      maxSummaryChars: 40,
    });

    expect(snapshot.summaries[0]?.value.length).toBeLessThanOrEqual(40);
    expect(snapshot.summaries[0]?.value.endsWith("…")).toBe(true);
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
