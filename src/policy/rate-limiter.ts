import type { Database } from "bun:sqlite";
import type { SqliteLockRetryOptions } from "../db/database.ts";
import { withSqliteLockRetry } from "../db/database.ts";
import type { Logger } from "../observability/logger.ts";
import type { PolicyRateLimit } from "./types.ts";

export interface PolicyRateLimiterOptions {
  database: Database;
  now?: () => Date;
  sqliteLockRetry?: SqliteLockRetryOptions;
  logger?: Logger;
}

export interface RateLimitCheckResult {
  allowed: boolean;
  retryAfterMs: number;
}

export class PolicyRateLimiter {
  private readonly database: Database;
  private readonly now: () => Date;
  private readonly sqliteLockRetry?: SqliteLockRetryOptions;
  private readonly logger?: Logger;

  constructor(options: PolicyRateLimiterOptions) {
    this.database = options.database;
    this.now = options.now ?? (() => new Date());
    this.sqliteLockRetry = options.sqliteLockRetry;
    this.logger = options.logger;
  }

  check(ruleId: string, limit: PolicyRateLimit, at = this.now()): RateLimitCheckResult {
    return withSqliteLockRetry("policy rate limit check", () => {
      const windowStart = new Date(at.getTime() - limit.windowMs).toISOString();
      this.database.run("DELETE FROM rate_limits WHERE rule_id = ? AND timestamp < ?", [ruleId, windowStart]);

      const rows = this.database
        .query<{ timestamp: string }, [string, string]>(
          "SELECT timestamp FROM rate_limits WHERE rule_id = ? AND timestamp >= ? ORDER BY timestamp ASC",
        )
        .all(ruleId, windowStart);

      if (rows.length < limit.count) {
        return {
          allowed: true,
          retryAfterMs: 0,
        };
      }

      const oldestTimestamp = Date.parse(rows[0]?.timestamp ?? "");
      const retryAfterMs = Number.isNaN(oldestTimestamp)
        ? limit.windowMs
        : Math.max(0, oldestTimestamp + limit.windowMs - at.getTime());

      return {
        allowed: false,
        retryAfterMs,
      };
    }, {
      ...this.sqliteLockRetry,
      logger: this.sqliteLockRetry?.logger ?? this.logger,
    });
  }

  record(ruleId: string, at = this.now()): void {
    withSqliteLockRetry("policy rate limit record", () => {
      let candidate = new Date(at);

      while (true) {
        try {
          this.database.run("INSERT INTO rate_limits (rule_id, timestamp) VALUES (?, ?)", [ruleId, candidate.toISOString()]);
          return;
        } catch (error) {
          if (!isUniqueConstraintError(error)) {
            throw error;
          }

          candidate = new Date(candidate.getTime() + 1);
        }
      }
    }, {
      ...this.sqliteLockRetry,
      logger: this.sqliteLockRetry?.logger ?? this.logger,
    });
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("UNIQUE constraint failed");
}
