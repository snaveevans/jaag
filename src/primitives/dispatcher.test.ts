import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDatabaseMigrations } from "../db/migrations.ts";
import { buildMockBearerToolSpec } from "../test/tool-spec-fixtures.ts";
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

    const blockedWrite = await dispatcher.dispatch(
      "file_write",
      {
        path: join(rootDir, "outside.txt"),
        content: "should be blocked",
      },
      { sessionId: "session-1" },
    );

    expect(blockedWrite).toMatchObject({
      success: false,
      error: expect.stringContaining("Policy blocked"),
    });
  });

  test("routes raw http, system tools, and spec-backed operations", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "agent-dispatcher-http-"));
    tempDirs.push(rootDir);

    const agentHome = join(rootDir, ".agent");
    const workspaceDir = join(rootDir, "workspace");
    await mkdir(agentHome, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/raw") {
          return Response.json({ ok: true });
        }

        if (url.pathname === "/items/octocat") {
          expect(request.headers.get("Authorization")).toBe("Bearer test-token");
          return Response.json([{ id: 1, name: "alpha", ignored: true }]);
        }

        return new Response("missing", { status: 404 });
      },
    });

    try {
      const dispatcher = new PrimitiveDispatcher({
        agentHome,
        workspaceDir,
        env: {
          MOCK_API_TOKEN: "test-token",
        },
      });

      const registerResult = await dispatcher.dispatch(
        "spec.register",
        {
          spec: buildMockBearerToolSpec(`http://127.0.0.1:${server.port}`),
        },
        { sessionId: "session-1" },
      );
      expect(registerResult.success).toBe(true);

      const declarations = dispatcher.getToolDeclarations();
      expect(declarations).toContainEqual(expect.objectContaining({
        name: "mockapi.items.list",
        providerName: "mockapi_items_list",
      }));

      const rawHttpResult = await dispatcher.dispatch(
        "http",
        {
          url: `http://127.0.0.1:${server.port}/raw`,
          method: "GET",
        },
        { sessionId: "session-1" },
      );
      expect(rawHttpResult).toMatchObject({
        success: true,
        data: {
          body: { ok: true },
        },
      });

      const toolResult = await dispatcher.dispatch(
        "mockapi.items.list",
        {
          owner: "octocat",
        },
        { sessionId: "session-1" },
      );
      expect(toolResult).toMatchObject({
        success: true,
        data: {
          response: [{ id: 1, name: "alpha" }],
        },
      });
    } finally {
      server.stop(true);
    }
  });

  test("blocks file writes that escape the workspace through symlinked ancestors", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "agent-dispatcher-symlink-"));
    tempDirs.push(rootDir);

    const homeDir = join(rootDir, "home");
    const agentHome = join(homeDir, ".agent");
    const workspaceDir = join(rootDir, "workspace");
    const outsideDir = join(rootDir, "outside");
    await mkdir(agentHome, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await symlink(outsideDir, join(workspaceDir, "escape"));

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
        path: "escape/leak.txt",
        content: "should stay blocked",
      },
      { sessionId: "session-1" },
    );

    expect(writeResult).toMatchObject({
      success: false,
      error: expect.stringContaining("Policy blocked"),
    });
    expect(await Bun.file(join(outsideDir, "leak.txt")).exists()).toBe(false);
  });
});
