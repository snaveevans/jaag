import type { Database } from "bun:sqlite";
import { withSqliteLockRetry } from "../db/database.ts";

const SESSION_SUMMARY_PREFIX = "session_summary:";
const LONG_LIVED_PREFIXES = [
  "user.preference:",
  "user.profile:",
  "project.context:",
] as const;
const DEFAULT_MAX_SUMMARIES = 3;
const DEFAULT_MAX_LONG_LIVED_ENTRIES = 4;
const DEFAULT_MAX_SUMMARY_CHARS = 280;
const DEFAULT_MAX_LONG_LIVED_CHARS = 180;
const SECRET_LIKE_KEY_PATTERNS = [
  /(^|[:._-])token(s)?($|[:._-])/i,
  /(^|[:._-])secret(s)?($|[:._-])/i,
  /(^|[:._-])password(s)?($|[:._-])/i,
  /(^|[:._-])credential(s)?($|[:._-])/i,
  /(^|[:._-])api[_-]?key(s)?($|[:._-])/i,
  /(^|[:._-])cookie(s)?($|[:._-])/i,
  /(^|[:._-])private[_-]?key(s)?($|[:._-])/i,
] as const;

interface ContinuityRow {
  id: number;
  key: string;
  value: string;
  updated_at: string;
}

export interface ContinuityEntry {
  key: string;
  value: string;
  updatedAt: string;
}

export interface ContinuitySnapshot {
  summaries: ContinuityEntry[];
  longLived: ContinuityEntry[];
}

export interface ContinuitySelectionOptions {
  maxSummaries?: number;
  maxLongLivedEntries?: number;
  maxSummaryChars?: number;
  maxLongLivedChars?: number;
}

export function buildContinuityBlock(
  database: Database,
  options: ContinuitySelectionOptions = {},
): string | null {
  return formatContinuityBlock(loadContinuitySnapshot(database, options));
}

export function loadContinuitySnapshot(
  database: Database,
  options: ContinuitySelectionOptions = {},
): ContinuitySnapshot {
  return withSqliteLockRetry("continuity snapshot load", () => {
    const maxSummaries = options.maxSummaries ?? DEFAULT_MAX_SUMMARIES;
    const maxLongLivedEntries = options.maxLongLivedEntries ?? DEFAULT_MAX_LONG_LIVED_ENTRIES;
    const maxSummaryChars = options.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS;
    const maxLongLivedChars = options.maxLongLivedChars ?? DEFAULT_MAX_LONG_LIVED_CHARS;
    const longLivedSelectionLimit = Math.max(maxLongLivedEntries * 4, maxLongLivedEntries);

    const summaries = database
      .query<ContinuityRow, [number]>(`
        SELECT id, key, value, updated_at
        FROM memory
        WHERE domain IS NULL
          AND key LIKE 'session_summary:%'
        ORDER BY updated_at DESC, id DESC
        LIMIT ?
      `)
      .all(maxSummaries)
      .map((row) => mapContinuityRow(row, maxSummaryChars))
      .filter((entry) => entry !== null);

    const longLived = database
      .query<ContinuityRow, [number]>(`
        SELECT id, key, value, updated_at
        FROM memory
        WHERE domain IS NULL
          AND (
            key LIKE 'user.preference:%'
            OR key LIKE 'user.profile:%'
            OR key LIKE 'project.context:%'
          )
        ORDER BY updated_at DESC, id DESC
        LIMIT ?
      `)
      .all(longLivedSelectionLimit)
      .filter((row) => !isLikelySecretLikeKey(row.key))
      .map((row) => mapContinuityRow(row, maxLongLivedChars))
      .filter((entry) => entry !== null)
      .slice(0, maxLongLivedEntries);

    return {
      summaries,
      longLived,
    };
  });
}

export function formatContinuityBlock(snapshot: ContinuitySnapshot): string | null {
  if (snapshot.summaries.length === 0 && snapshot.longLived.length === 0) {
    return null;
  }

  const lines = [
    "Session continuity from persisted memory:",
    "- This block is runtime-selected and intentionally small. Prefer fresher evidence from the current conversation or tool results if anything conflicts.",
  ];

  if (snapshot.summaries.length > 0) {
    lines.push("- Some items below are conversation summaries written automatically by the runtime.");
    lines.push("Recent session summaries:");

    for (const summary of snapshot.summaries) {
      lines.push(`- ${formatSummaryLabel(summary)}: ${summary.value}`);
    }
  }

  if (snapshot.longLived.length > 0) {
    lines.push("Long-lived user/project context:");

    for (const entry of snapshot.longLived) {
      lines.push(`- ${entry.key}: ${entry.value}`);
    }
  }

  return lines.join("\n");
}

function mapContinuityRow(row: ContinuityRow, maxChars: number): ContinuityEntry | null {
  const value = normalizeContinuityValue(row.value, maxChars);
  if (value === "") {
    return null;
  }

  return {
    key: row.key,
    value,
    updatedAt: row.updated_at,
  };
}

function normalizeContinuityValue(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized === "") {
    return "";
  }

  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function formatSummaryLabel(entry: ContinuityEntry): string {
  const timestamp = entry.key.startsWith(SESSION_SUMMARY_PREFIX)
    ? entry.key.slice(SESSION_SUMMARY_PREFIX.length)
    : entry.updatedAt;

  return timestamp || entry.updatedAt;
}

function isLikelySecretLikeKey(key: string): boolean {
  return SECRET_LIKE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

export const CONTINUITY_CONSTANTS = {
  SESSION_SUMMARY_PREFIX,
  LONG_LIVED_PREFIXES,
};
