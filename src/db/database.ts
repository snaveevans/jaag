import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_AGENT_HOME } from "../config/schema.ts";
import type { Logger } from "../observability/logger.ts";
import { runDatabaseMigrations } from "./migrations.ts";

export interface DatabaseOptions {
  agentHome?: string;
  databasePath?: string;
}

export interface SqliteLockRetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => void;
  logger?: Logger;
}

export class SqliteLockTimeoutError extends Error {
  constructor(operationName: string) {
    super(`SQLite lock retry exhausted while ${operationName}. Try again shortly.`);
    this.name = "SqliteLockTimeoutError";
  }
}

let sharedDatabase: Database | null = null;
let sharedDatabasePath: string | null = null;

const DEFAULT_SQLITE_LOCK_MAX_RETRIES = 3;
const DEFAULT_SQLITE_LOCK_BASE_DELAY_MS = 25;
const DEFAULT_SQLITE_LOCK_MAX_DELAY_MS = 200;

export function resolveDatabasePath(options: DatabaseOptions = {}): string {
  if (options.databasePath) {
    return options.databasePath;
  }

  return join(options.agentHome ?? DEFAULT_AGENT_HOME, "agent.db");
}

export function initializeDatabase(options: DatabaseOptions = {}): Database {
  const databasePath = resolveDatabasePath(options);
  mkdirSync(dirname(databasePath), { recursive: true });

  const database = new Database(databasePath, {
    create: true,
    strict: true,
  });

  database.run("PRAGMA journal_mode = WAL");
  verifyDatabaseIntegrity(database);
  runDatabaseMigrations(database);
  return database;
}

export function getDatabase(options: DatabaseOptions = {}): Database {
  const databasePath = resolveDatabasePath(options);
  if (sharedDatabase && sharedDatabasePath === databasePath) {
    return sharedDatabase;
  }

  closeDatabase();
  sharedDatabase = initializeDatabase(options);
  sharedDatabasePath = databasePath;
  return sharedDatabase;
}

export function closeDatabase(): void {
  sharedDatabase?.close(false);
  sharedDatabase = null;
  sharedDatabasePath = null;
}

export function verifyDatabaseIntegrity(database: Database): void {
  const results = database.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all();
  const messages = results.map((row) => row.integrity_check.trim()).filter((value) => value !== "");

  if (messages.length === 1 && messages[0]?.toLowerCase() === "ok") {
    return;
  }

  throw new Error(`SQLite integrity check failed: ${messages.join("; ") || "unknown corruption detected"}.`);
}

export function withSqliteLockRetry<T>(
  operationName: string,
  action: () => T,
  options: SqliteLockRetryOptions = {},
): T {
  const maxRetries = options.maxRetries ?? DEFAULT_SQLITE_LOCK_MAX_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_SQLITE_LOCK_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_SQLITE_LOCK_MAX_DELAY_MS;
  const sleep = options.sleep ?? sleepSync;

  for (let attempt = 0; ; attempt += 1) {
    try {
      return action();
    } catch (error) {
      if (!isSqliteLockError(error)) {
        throw error;
      }

      if (attempt >= maxRetries) {
        const finalError = new SqliteLockTimeoutError(operationName);
        options.logger?.error("sqlite.lock.failed", {
          component: "db.database",
          operationName,
          attempts: attempt + 1,
          error,
        });
        throw finalError;
      }

      const delayMs = Math.min(maxDelayMs, baseDelayMs * (2 ** attempt));
      options.logger?.warn("sqlite.lock.retry", {
        component: "db.database",
        operationName,
        attempt: attempt + 1,
        delayMs,
        error,
      });
      sleep(delayMs);
    }
  }
}

export function isSqliteLockError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes("database is locked")
    || message.includes("database table is locked")
    || message.includes("sqlite_busy")
    || message.includes("sqlite_locked");
}

function sleepSync(durationMs: number): void {
  if (durationMs <= 0) {
    return;
  }

  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, durationMs);
}
