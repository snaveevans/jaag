import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "../observability/logger.ts";
import {
  initializeDatabase,
  resolveDatabasePath,
  SqliteLockTimeoutError,
  verifyDatabaseIntegrity,
  withSqliteLockRetry,
} from "./database.ts";

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

describe("initializeDatabase", () => {
  test("creates agent.db, enables WAL, and keeps the FTS index synced", async () => {
    const homeDir = await createHomeDir();
    const agentHome = join(homeDir, ".agent");
    const database = initializeDatabase({ agentHome });
    databases.push(database);

    expect(await Bun.file(resolveDatabasePath({ agentHome })).exists()).toBe(true);

    const journalMode = database.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
    expect(journalMode?.journal_mode.toLowerCase()).toBe("wal");

    const now = new Date("2026-03-21T00:00:00.000Z").toISOString();
    database.run(
      "INSERT INTO memory (domain, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      [null, "pref", "user prefers short emails", now, now],
    );

    expect(searchCount(database, "emails")).toBe(1);

    database.run(
      "UPDATE memory SET value = ?, updated_at = ? WHERE domain IS NULL AND key = ?",
      ["daily notes only", now, "pref"],
    );

    expect(searchCount(database, "emails")).toBe(0);
    expect(searchCount(database, "notes")).toBe(1);

    database.run("DELETE FROM memory WHERE domain IS NULL AND key = ?", ["pref"]);

    expect(searchCount(database, "notes")).toBe(0);

    database.run("INSERT INTO rate_limits (rule_id, timestamp) VALUES (?, ?)", [
      "rule-1",
      new Date("2026-03-21T00:00:00.000Z").toISOString(),
    ]);
    const rateLimitCount = database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM rate_limits").get();
    expect(rateLimitCount?.count).toBe(1);

    database.run(
      `
        INSERT INTO schedules (
          id,
          workflow,
          group_label,
          trigger_type,
          trigger_config,
          context,
          status,
          created_at,
          updated_at,
          next_fire_at,
          fire_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        "schedule-1",
        "hydration",
        "wellness",
        "once",
        JSON.stringify({ at: "2026-03-21T01:00:00.000Z" }),
        JSON.stringify({ instruction: "Remind the user to drink water." }),
        "active",
        now,
        now,
        "2026-03-21T01:00:00.000Z",
        0,
      ],
    );
    const scheduleCount = database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM schedules").get();
    expect(scheduleCount?.count).toBe(1);
  });

  test("throws a clear startup error when integrity_check is not ok", async () => {
    const homeDir = await createHomeDir();
    const agentHome = join(homeDir, ".agent");
    const database = initializeDatabase({ agentHome });
    databases.push(database);

    expect(() => verifyDatabaseIntegrity({
      query: () => ({
        all: () => [
          { integrity_check: "*** in database main ***\nPage 3 is never used" },
        ],
      }),
    } as unknown as Database)).toThrow(
      "SQLite integrity check failed: *** in database main ***\nPage 3 is never used.",
    );
  });
});

describe("withSqliteLockRetry", () => {
  test("returns immediately without logging when the first attempt succeeds", () => {
    const { parsed, sink } = createCaptureSink();
    const logger = new Logger({ sink });
    let attempts = 0;

    const result = withSqliteLockRetry("test operation", () => {
      attempts += 1;
      return "done";
    }, {
      logger,
      sleep: () => {
        throw new Error("sleep should not be called when the first attempt succeeds");
      },
    });

    expect(result).toBe("done");
    expect(attempts).toBe(1);
    expect(parsed()).toEqual([]);
  });

  test("retries SQLite lock errors and logs retry warnings before succeeding", () => {
    const { parsed, sink } = createCaptureSink();
    const logger = new Logger({ sink });
    const sleepCalls: number[] = [];
    let attempts = 0;

    const result = withSqliteLockRetry("test operation", () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("database is locked");
      }

      return "done";
    }, {
      logger,
      baseDelayMs: 5,
      maxDelayMs: 5,
      sleep: (delayMs) => {
        sleepCalls.push(delayMs);
      },
    });

    expect(result).toBe("done");
    expect(attempts).toBe(2);
    expect(sleepCalls).toEqual([5]);
    expect(parsed()).toContainEqual(expect.objectContaining({
      level: "warn",
      event: "sqlite.lock.retry",
      component: "db.database",
      operationName: "test operation",
      attempt: 1,
      delayMs: 5,
    }));
  });

  test("throws SqliteLockTimeoutError and logs the final failure when retries are exhausted", () => {
    const { parsed, sink } = createCaptureSink();
    const logger = new Logger({ sink });
    const sleepCalls: number[] = [];
    let attempts = 0;
    let thrown: unknown;

    try {
      withSqliteLockRetry("test operation", () => {
        attempts += 1;
        throw new Error("database table is locked");
      }, {
        logger,
        maxRetries: 2,
        baseDelayMs: 5,
        maxDelayMs: 10,
        sleep: (delayMs) => {
          sleepCalls.push(delayMs);
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SqliteLockTimeoutError);
    expect((thrown as Error).message).toBe("SQLite lock retry exhausted while test operation. Try again shortly.");
    expect(attempts).toBe(3);
    expect(sleepCalls).toEqual([5, 10]);
    expect(parsed()).toContainEqual(expect.objectContaining({
      level: "error",
      event: "sqlite.lock.failed",
      component: "db.database",
      operationName: "test operation",
      attempts: 3,
    }));
  });

  test("rethrows non-lock errors immediately without retry logging", () => {
    const { parsed, sink } = createCaptureSink();
    const logger = new Logger({ sink });
    let attempts = 0;
    const failure = new Error("boom");

    expect(() => withSqliteLockRetry("test operation", () => {
      attempts += 1;
      throw failure;
    }, {
      logger,
      sleep: () => {
        throw new Error("sleep should not be called for non-lock errors");
      },
    })).toThrow("boom");

    expect(attempts).toBe(1);
    expect(parsed()).toEqual([]);
  });
});

function searchCount(database: Database, query: string): number {
  return database
    .query<{ count: number }, any[]>("SELECT COUNT(*) AS count FROM memory_fts WHERE memory_fts MATCH ?")
    .get(query)?.count ?? 0;
}

async function createHomeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-db-test-"));
  tempDirs.push(dir);
  return dir;
}

function createCaptureSink() {
  const lines: string[] = [];
  return {
    sink: {
      write(line: string) {
        lines.push(line);
      },
    },
    lines,
    parsed: () => lines.map((line) => JSON.parse(line.trim()) as Record<string, unknown>),
  };
}
