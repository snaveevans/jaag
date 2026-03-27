import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_AGENT_HOME } from "../config/schema.ts";
import { runDatabaseMigrations } from "./migrations.ts";

export interface DatabaseOptions {
  agentHome?: string;
  databasePath?: string;
}

let sharedDatabase: Database | null = null;
let sharedDatabasePath: string | null = null;

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
