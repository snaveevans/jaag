import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabase, resolveDatabasePath } from "./database.ts";

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
