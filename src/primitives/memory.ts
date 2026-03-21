import type { Database } from "bun:sqlite";
import type { PrimitiveHandler, PrimitiveResult } from "./types.ts";

const DEFAULT_SEARCH_LIMIT = 10;
const DEFAULT_LIST_LIMIT = 100;
const MAX_RESULT_LIMIT = 100;

interface MemoryRow {
  id: number;
  domain: string | null;
  key: string;
  value: string;
  created_at: string;
  updated_at: string;
  access_count: number;
}

interface SearchRow extends MemoryRow {
  score: number;
}

interface MemoryHandlerOptions {
  getDatabase: () => Database;
}

export function createMemoryHandler(options: MemoryHandlerOptions): PrimitiveHandler {
  return async (params) => {
    try {
      const operation = requireString(params.operation, "operation");
      const database = options.getDatabase();

      switch (operation) {
        case "get":
          return handleGet(database, params);
        case "set":
          return handleSet(database, params);
        case "search":
          return handleSearch(database, params);
        case "list":
          return handleList(database, params);
        case "delete":
          return handleDelete(database, params);
        default:
          return {
            success: false,
            error: `Unsupported memory operation: ${operation}`,
          };
      }
    } catch (error) {
      return {
        success: false,
        error: toErrorMessage(error),
      };
    }
  };
}

function handleGet(database: Database, params: Record<string, unknown>): PrimitiveResult {
  const key = requireString(params.key, "key");
  const domain = parseScopedDomain(params.domain);
  const row = getMemoryByDomainAndKey(database, domain, key);

  if (!row) {
    return {
      success: true,
      data: {
        entry: null,
      },
    };
  }

  incrementAccessCounts(database, [row.id]);
  return {
    success: true,
    data: {
      entry: mapMemoryRow({
        ...row,
        access_count: row.access_count + 1,
      }),
    },
  };
}

function handleSet(database: Database, params: Record<string, unknown>): PrimitiveResult {
  const key = requireString(params.key, "key");
  const value = requireString(params.value, "value");
  const domain = parseScopedDomain(params.domain);
  const now = new Date().toISOString();

  const persistMemory = database.transaction((targetDomain: string | null, targetKey: string, targetValue: string) => {
    const existing = getMemoryByDomainAndKey(database, targetDomain, targetKey);
    if (existing) {
      database.run("UPDATE memory SET value = ?, updated_at = ? WHERE id = ?", [targetValue, now, existing.id]);
      return getMemoryById(database, existing.id);
    }

    const insertResult = database.run(
      "INSERT INTO memory (domain, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      [targetDomain, targetKey, targetValue, now, now],
    );
    return getMemoryById(database, Number(insertResult.lastInsertRowid));
  });

  const row = persistMemory(domain, key, value);
  if (!row) {
    throw new Error("Failed to persist memory entry.");
  }

  return {
    success: true,
    data: {
      entry: mapMemoryRow(row),
    },
  };
}

function handleSearch(database: Database, params: Record<string, unknown>): PrimitiveResult {
  const query = requireString(params.query, "query");
  const domain = parseOptionalDomain(params.domain);
  const limit = parseLimit(params.limit, DEFAULT_SEARCH_LIMIT);

  const searchSql = domain === undefined
    ? `
      SELECT
        memory.id,
        memory.domain,
        memory.key,
        memory.value,
        memory.created_at,
        memory.updated_at,
        memory.access_count,
        (
          bm25(memory_fts, 1.0, 0.7)
          + (MIN(MAX(julianday('now') - julianday(memory.updated_at), 0), 365) * 0.01)
          - (MIN(memory.access_count, 20) * 0.05)
        ) AS score
      FROM memory_fts
      JOIN memory ON memory.id = memory_fts.rowid
      WHERE memory_fts MATCH ?
      ORDER BY score ASC, memory.updated_at DESC
      LIMIT ?
    `
    : `
      SELECT
        memory.id,
        memory.domain,
        memory.key,
        memory.value,
        memory.created_at,
        memory.updated_at,
        memory.access_count,
        (
          bm25(memory_fts, 1.0, 0.7)
          + (MIN(MAX(julianday('now') - julianday(memory.updated_at), 0), 365) * 0.01)
          - (MIN(memory.access_count, 20) * 0.05)
        ) AS score
      FROM memory_fts
      JOIN memory ON memory.id = memory_fts.rowid
      WHERE memory_fts MATCH ?
        AND ((memory.domain = ?) OR (memory.domain IS NULL AND ? IS NULL))
      ORDER BY score ASC, memory.updated_at DESC
      LIMIT ?
    `;

  const rows = domain === undefined
    ? database.query<SearchRow, any[]>(searchSql).all(query, limit)
    : database.query<SearchRow, any[]>(searchSql).all(query, domain, domain, limit);

  incrementAccessCounts(database, rows.map((row) => row.id));

  return {
    success: true,
    data: {
      entries: rows.map((row) => ({
        ...mapMemoryRow({
          ...row,
          access_count: row.access_count + 1,
        }),
        score: row.score,
      })),
    },
  };
}

function handleList(database: Database, params: Record<string, unknown>): PrimitiveResult {
  const domain = parseOptionalDomain(params.domain);
  const limit = parseLimit(params.limit, DEFAULT_LIST_LIMIT);
  const listSql = domain === undefined
    ? `
      SELECT id, domain, key, value, created_at, updated_at, access_count
      FROM memory
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `
    : `
      SELECT id, domain, key, value, created_at, updated_at, access_count
      FROM memory
      WHERE ((domain = ?) OR (domain IS NULL AND ? IS NULL))
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `;

  const rows = domain === undefined
    ? database.query<MemoryRow, any[]>(listSql).all(limit)
    : database.query<MemoryRow, any[]>(listSql).all(domain, domain, limit);

  return {
    success: true,
    data: {
      entries: rows.map(mapMemoryRow),
    },
  };
}

function handleDelete(database: Database, params: Record<string, unknown>): PrimitiveResult {
  const key = requireString(params.key, "key");
  const domain = parseScopedDomain(params.domain);
  const row = getMemoryByDomainAndKey(database, domain, key);

  if (!row) {
    return {
      success: true,
      data: {
        deleted: false,
      },
    };
  }

  database.run("DELETE FROM memory WHERE id = ?", [row.id]);
  return {
    success: true,
    data: {
      deleted: true,
      entry: mapMemoryRow(row),
    },
  };
}

function getMemoryByDomainAndKey(database: Database, domain: string | null, key: string): MemoryRow | null {
  return database
    .query<MemoryRow, any[]>(`
      SELECT id, domain, key, value, created_at, updated_at, access_count
      FROM memory
      WHERE ((domain = ?) OR (domain IS NULL AND ? IS NULL)) AND key = ?
      LIMIT 1
    `)
    .get(domain, domain, key);
}

function getMemoryById(database: Database, id: number): MemoryRow | null {
  return database
    .query<MemoryRow, any[]>(`
      SELECT id, domain, key, value, created_at, updated_at, access_count
      FROM memory
      WHERE id = ?
      LIMIT 1
    `)
    .get(id);
}

function incrementAccessCounts(database: Database, ids: number[]): void {
  if (ids.length === 0) {
    return;
  }

  const updateSql = `UPDATE memory SET access_count = access_count + 1 WHERE id IN (${ids.map(() => "?").join(", ")})`;
  database.run(updateSql, ids);
}

function parseOptionalDomain(
  value: unknown,
  options: { defaultToNull?: boolean } = {},
): string | null | undefined {
  if (value === undefined) {
    return options.defaultToNull ? null : undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("Invalid domain: expected a non-empty string, null, or undefined.");
  }

  return value.trim();
}

function parseScopedDomain(value: unknown): string | null {
  return parseOptionalDomain(value, { defaultToNull: true }) ?? null;
}

function parseLimit(value: unknown, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_RESULT_LIMIT) {
    throw new Error(`Invalid limit: expected an integer between 1 and ${MAX_RESULT_LIMIT}.`);
  }

  return value;
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid ${fieldName}: expected a non-empty string.`);
  }

  return value.trim();
}

function mapMemoryRow(row: MemoryRow) {
  return {
    id: row.id,
    domain: row.domain,
    key: row.key,
    value: row.value,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    accessCount: row.access_count,
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
