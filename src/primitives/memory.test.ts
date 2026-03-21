import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runDatabaseMigrations } from "../db/migrations.ts";
import { createMemoryHandler } from "./memory.ts";

const databases: Database[] = [];

afterEach(() => {
  while (databases.length > 0) {
    databases.pop()?.close(false);
  }
});

describe("memory primitive", () => {
  test("returns structured errors when database acquisition fails", async () => {
    const handler = createMemoryHandler({
      getDatabase: () => {
        throw new Error("Failed to open memory database.");
      },
    });

    await expect(
      handler(
        {
          operation: "list",
        },
        { sessionId: "session-1" },
      ),
    ).resolves.toEqual({
      success: false,
      error: "Failed to open memory database.",
    });
  });

  test("supports get, set, upsert, and delete for null-domain memories", async () => {
    const { database, handler } = createHarness();

    const createResult = await handler(
      {
        operation: "set",
        domain: null,
        key: "user_prefers_short_emails",
        value: "true",
      },
      { sessionId: "session-1" },
    );

    expect(createResult).toMatchObject({
      success: true,
      data: {
        entry: {
          domain: null,
          key: "user_prefers_short_emails",
          value: "true",
          accessCount: 0,
        },
      },
    });

    const getResult = await handler(
      {
        operation: "get",
        domain: null,
        key: "user_prefers_short_emails",
      },
      { sessionId: "session-1" },
    );

    expect(getResult).toMatchObject({
      success: true,
      data: {
        entry: {
          value: "true",
          accessCount: 1,
        },
      },
    });

    const updateResult = await handler(
      {
        operation: "set",
        domain: null,
        key: "user_prefers_short_emails",
        value: "false",
      },
      { sessionId: "session-1" },
    );

    expect(updateResult).toMatchObject({
      success: true,
      data: {
        entry: {
          key: "user_prefers_short_emails",
          value: "false",
        },
      },
    });

    const listResult = await handler(
      {
        operation: "list",
        domain: null,
      },
      { sessionId: "session-1" },
    );

    expect(listResult).toMatchObject({
      success: true,
      data: {
        entries: [
          {
            key: "user_prefers_short_emails",
            value: "false",
          },
        ],
      },
    });

    expect(
      database
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM memory WHERE domain IS NULL AND key = 'user_prefers_short_emails'")
        .get()?.count,
    ).toBe(1);

    const deleteResult = await handler(
      {
        operation: "delete",
        domain: null,
        key: "user_prefers_short_emails",
      },
      { sessionId: "session-1" },
    );

    expect(deleteResult).toMatchObject({
      success: true,
      data: {
        deleted: true,
      },
    });

    const afterDelete = await handler(
      {
        operation: "get",
        domain: null,
        key: "user_prefers_short_emails",
      },
      { sessionId: "session-1" },
    );

    expect(afterDelete).toEqual({
      success: true,
      data: {
        entry: null,
      },
    });
  });

  test("supports search and list with domain scoping", async () => {
    const { database, handler } = createHarness();

    await handler(
      {
        operation: "set",
        domain: null,
        key: "email_style",
        value: "user prefers short emails",
      },
      { sessionId: "session-1" },
    );
    await handler(
      {
        operation: "set",
        domain: "gmail",
        key: "last_triage",
        value: "triage inbox daily",
      },
      { sessionId: "session-1" },
    );
    await handler(
      {
        operation: "set",
        domain: "calendar",
        key: "meeting_pref",
        value: "prefers afternoon meetings",
      },
      { sessionId: "session-1" },
    );

    const generalSearch = await handler(
      {
        operation: "search",
        domain: null,
        query: "email preferences",
        limit: 10,
      },
      { sessionId: "session-1" },
    );

    expect(generalSearch).toMatchObject({
      success: true,
      data: {
        entries: [
          {
            domain: null,
            key: "email_style",
            value: "user prefers short emails",
          },
        ],
      },
    });

    const gmailList = await handler(
      {
        operation: "list",
        domain: "gmail",
      },
      { sessionId: "session-1" },
    );

    expect(gmailList).toMatchObject({
      success: true,
      data: {
        entries: [
          {
            domain: "gmail",
            key: "last_triage",
            value: "triage inbox daily",
          },
        ],
      },
    });

    expect(
      database
        .query<{ access_count: number }, any[]>("SELECT access_count FROM memory WHERE domain IS NULL AND key = ?")
        .get("email_style")?.access_count,
    ).toBe(1);
  });
});

function createHarness() {
  const database = new Database(":memory:", {
    create: true,
    strict: true,
  });
  database.run("PRAGMA journal_mode = WAL");
  runDatabaseMigrations(database);
  databases.push(database);

  return {
    database,
    handler: createMemoryHandler({
      getDatabase: () => database,
    }),
  };
}
