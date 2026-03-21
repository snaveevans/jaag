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

describe("PrimitiveDispatcher", () => {
  test("routes file and memory primitives to real handlers", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "agent-dispatcher-test-"));
    tempDirs.push(rootDir);

    const homeDir = join(rootDir, "home");
    const agentHome = join(homeDir, ".agent");
    const workspaceDir = join(rootDir, "workspace");
    await mkdir(agentHome, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const database = new Database(":memory:", {
      create: true,
      strict: true,
    });
    database.run("PRAGMA journal_mode = WAL");
    runDatabaseMigrations(database);
    databases.push(database);

    const dispatcher = new PrimitiveDispatcher({
      agentHome,
      workspaceDir,
      getDatabase: () => database,
    });

    const writeResult = await dispatcher.dispatch(
      "file_write",
      {
        path: "dispatch.txt",
        content: "dispatcher wrote this",
      },
      { sessionId: "session-1" },
    );

    expect(writeResult).toMatchObject({
      success: true,
      data: {
        path: join(workspaceDir, "dispatch.txt"),
      },
    });

    const readResult = await dispatcher.dispatch(
      "file_read",
      {
        path: "dispatch.txt",
      },
      { sessionId: "session-1" },
    );

    expect(readResult).toMatchObject({
      success: true,
      data: {
        content: "dispatcher wrote this",
      },
    });

    await dispatcher.dispatch(
      "memory",
      {
        operation: "set",
        domain: null,
        key: "repo_pref",
        value: "prefers short emails",
      },
      { sessionId: "session-1" },
    );

    const searchResult = await dispatcher.dispatch(
      "memory",
      {
        operation: "search",
        domain: null,
        query: "email preferences",
      },
      { sessionId: "session-1" },
    );

    expect(searchResult).toMatchObject({
      success: true,
      data: {
        entries: [
          {
            key: "repo_pref",
            value: "prefers short emails",
          },
        ],
      },
    });
  });
});
