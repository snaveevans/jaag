import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runDatabaseMigrations } from "../db/migrations.ts";
import { PolicyRateLimiter } from "./rate-limiter.ts";

const databases: Database[] = [];

afterEach(() => {
  while (databases.length > 0) {
    databases.pop()?.close(false);
  }
});

describe("policy rate limiter", () => {
  test("persists counters and blocks once the window is full", () => {
    const database = new Database(":memory:", { create: true, strict: true });
    runDatabaseMigrations(database);
    databases.push(database);

    const limiter = new PolicyRateLimiter({ database });
    const window = { count: 2, window: "1m", windowMs: 60_000 };
    const now = new Date("2026-03-21T00:00:00.000Z");

    expect(limiter.check("rule-a", window, now)).toEqual({ allowed: true, retryAfterMs: 0 });
    limiter.record("rule-a", now);
    limiter.record("rule-a", now);

    const persistedLimiter = new PolicyRateLimiter({ database });
    const blocked = persistedLimiter.check("rule-a", window, new Date("2026-03-21T00:00:10.000Z"));

    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBe(50_000);
  });
});
