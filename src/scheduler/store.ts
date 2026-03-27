import type { Database } from "bun:sqlite";
import type { SqliteLockRetryOptions } from "../db/database.ts";
import { withSqliteLockRetry } from "../db/database.ts";
import type { Logger } from "../observability/logger.ts";
import { assertSupportedScheduleTriggerType, computeNextCronOccurrence, parseCronExpression } from "./cron.ts";
import type {
  ScheduleContextPayload,
  ScheduleLastFireStatus,
  ScheduleListFilters,
  ScheduleRecord,
  ScheduleStatus,
  ScheduleTrigger,
  ScheduleTriggerType,
} from "./types.ts";

interface ScheduleRow {
  id: string;
  workflow: string;
  group_label: string | null;
  trigger_type: string;
  trigger_config: string;
  context: string;
  status: string;
  created_at: string;
  updated_at: string;
  last_fired_at: string | null;
  next_fire_at: string | null;
  fire_count: number;
  last_fire_status: string | null;
}

export interface CreateScheduleInput {
  workflow: string;
  group?: string | null;
  trigger: ScheduleTrigger;
  context: ScheduleContextPayload;
  status?: ScheduleStatus;
}

export interface UpdateScheduleInput {
  workflow?: string;
  group?: string | null;
  trigger?: ScheduleTrigger;
  context?: ScheduleContextPayload;
  status?: ScheduleStatus;
}

export interface ScheduleStoreOptions {
  database: Database;
  timeZone?: string;
  now?: () => Date;
  sqliteLockRetry?: SqliteLockRetryOptions;
  logger?: Logger;
}

export class ScheduleStore {
  private readonly database: Database;
  private readonly timeZone: string;
  private readonly now: () => Date;
  private readonly sqliteLockRetry?: SqliteLockRetryOptions;
  private readonly logger?: Logger;

  constructor(options: ScheduleStoreOptions) {
    this.database = options.database;
    this.timeZone = options.timeZone ?? "UTC";
    this.now = options.now ?? (() => new Date());
    this.sqliteLockRetry = options.sqliteLockRetry;
    this.logger = options.logger;
  }

  create(input: CreateScheduleInput): ScheduleRecord {
    return this.withDatabaseRetry("schedule create", () => {
      const now = this.now();
      const nowIso = now.toISOString();
      const triggerState = computeTriggerState(input.trigger, now, this.timeZone, input.status ?? "active");
      const scheduleId = crypto.randomUUID();
      const status = input.status ?? "active";

      this.database.run(
        `
          INSERT INTO schedules (
            id,
            workflow,
            group_label,
            trigger_type,
            trigger_config,
            context,
            status,
            created_at,
            updated_at,
            last_fired_at,
            next_fire_at,
            fire_count,
            last_fire_status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          scheduleId,
          input.workflow,
          input.group ?? null,
          input.trigger.type,
          JSON.stringify(serializeTriggerConfig(input.trigger)),
          JSON.stringify(input.context),
          status,
          nowIso,
          nowIso,
          null,
          triggerState.next_fire_at,
          0,
          null,
        ],
      );

      const created = this.getByIdInternal(scheduleId);
      if (!created) {
        throw new Error(`Failed to load created schedule ${scheduleId}.`);
      }

      return created;
    });
  }

  getById(scheduleId: string): ScheduleRecord | null {
    return this.withDatabaseRetry("schedule get", () => this.getByIdInternal(scheduleId));
  }

  list(filters: ScheduleListFilters = {}): ScheduleRecord[] {
    return this.withDatabaseRetry("schedule list", () => {
      const clauses: string[] = [];
      const values: unknown[] = [];

      if (filters.workflow !== undefined) {
        clauses.push("workflow = ?");
        values.push(filters.workflow);
      }

      if (filters.group !== undefined) {
        clauses.push("group_label = ?");
        values.push(filters.group);
      }

      if (filters.status !== undefined) {
        clauses.push("status = ?");
        values.push(filters.status);
      }

      if (filters.trigger_type !== undefined) {
        clauses.push("trigger_type = ?");
        values.push(filters.trigger_type);
      }

      const sql = `
        SELECT
          id,
          workflow,
          group_label,
          trigger_type,
          trigger_config,
          context,
          status,
          created_at,
          updated_at,
          last_fired_at,
          next_fire_at,
          fire_count,
          last_fire_status
        FROM schedules
        ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
        ORDER BY created_at ASC, id ASC
      `;

      return this.database.query<ScheduleRow, any[]>(sql).all(...values).map(mapScheduleRow);
    });
  }

  update(scheduleId: string, input: UpdateScheduleInput): ScheduleRecord | null {
    return this.withDatabaseRetry("schedule update", () => {
      const current = this.getByIdInternal(scheduleId);
      if (!current) {
        return null;
      }

      const nextTrigger = input.trigger ?? current.trigger;
      const nextStatus = input.status ?? current.status;
      const nextContext = input.context ?? current.context;
      const nextWorkflow = input.workflow ?? current.workflow;
      const nextGroup = input.group === undefined ? current.group : input.group;
      const now = this.now();
      const nowIso = now.toISOString();
      const triggerState = shouldPreserveNextFireAt(current, nextTrigger, nextStatus)
        ? { next_fire_at: current.next_fire_at }
        : computeTriggerState(nextTrigger, now, this.timeZone, nextStatus, current.next_fire_at);

      this.database.run(
        `
          UPDATE schedules
          SET workflow = ?,
              group_label = ?,
              trigger_type = ?,
              trigger_config = ?,
              context = ?,
              status = ?,
              updated_at = ?,
              next_fire_at = ?
          WHERE id = ?
        `,
        [
          nextWorkflow,
          nextGroup ?? null,
          nextTrigger.type,
          JSON.stringify(serializeTriggerConfig(nextTrigger)),
          JSON.stringify(nextContext),
          nextStatus,
          nowIso,
          triggerState.next_fire_at,
          scheduleId,
        ],
      );

      return this.getByIdInternal(scheduleId);
    });
  }

  deleteById(scheduleId: string): number {
    return this.withDatabaseRetry("schedule delete by id", () => {
      return this.database.run("DELETE FROM schedules WHERE id = ?", [scheduleId]).changes;
    });
  }

  deleteByGroup(group: string): number {
    return this.withDatabaseRetry("schedule delete by group", () => {
      return this.database.run("DELETE FROM schedules WHERE group_label = ?", [group]).changes;
    });
  }

  listDueScheduleIds(now = this.now()): string[] {
    return this.withDatabaseRetry("schedule list due ids", () => {
      const nowIso = now.toISOString();
      return this.database
        .query<{ id: string }, [string]>(`
          SELECT id
          FROM schedules
          WHERE status = 'active'
            AND next_fire_at IS NOT NULL
            AND next_fire_at <= ?
          ORDER BY next_fire_at ASC, id ASC
        `)
        .all(nowIso)
        .map((row) => row.id);
    });
  }

  advanceForExecution(scheduleId: string, firedAt = this.now()): ScheduleRecord | null {
    return this.withDatabaseRetry("schedule advance for execution", () => {
      const advance = this.database.transaction((targetId: string, targetTimeIso: string) => {
        const row = this.database
          .query<ScheduleRow, [string]>(`
            SELECT
              id,
              workflow,
              group_label,
              trigger_type,
              trigger_config,
              context,
              status,
              created_at,
              updated_at,
              last_fired_at,
              next_fire_at,
              fire_count,
              last_fire_status
            FROM schedules
            WHERE id = ?
            LIMIT 1
          `)
          .get(targetId);

        if (!row) {
          return null;
        }

        const schedule = mapScheduleRow(row);
        if (schedule.status !== "active") {
          return null;
        }

        if (!schedule.next_fire_at || schedule.next_fire_at > targetTimeIso) {
          return null;
        }

        const advancedState = computeExecutionAdvance(schedule, firedAt, this.timeZone);
        this.database.run(
          `
            UPDATE schedules
            SET status = ?,
                updated_at = ?,
                last_fired_at = ?,
                next_fire_at = ?,
                fire_count = ?,
                last_fire_status = ?
            WHERE id = ?
          `,
          [
            advancedState.status,
            targetTimeIso,
            targetTimeIso,
            advancedState.next_fire_at,
            schedule.fire_count + 1,
            null,
            targetId,
          ],
        );

        return this.getByIdInternal(targetId);
      });

      return advance(scheduleId, firedAt.toISOString());
    });
  }

  recordExecutionResult(
    scheduleId: string,
    executionStatus: ScheduleLastFireStatus,
    at = this.now(),
  ): void {
    this.withDatabaseRetry("schedule record execution result", () => {
      this.database.run(
        "UPDATE schedules SET last_fire_status = ?, updated_at = ? WHERE id = ?",
        [executionStatus, at.toISOString(), scheduleId],
      );
    });
  }

  reconcileInterruptedExecutions(at = this.now()): number {
    return this.withDatabaseRetry("schedule reconcile interrupted executions", () => {
      return this.database.run(
        `
          UPDATE schedules
          SET last_fire_status = 'failed',
              updated_at = ?
          WHERE last_fire_status IS NULL
            AND last_fired_at IS NOT NULL
        `,
        [at.toISOString()],
      ).changes;
    });
  }

  private getByIdInternal(scheduleId: string): ScheduleRecord | null {
    const row = this.database
      .query<ScheduleRow, [string]>(`
        SELECT
          id,
          workflow,
          group_label,
          trigger_type,
          trigger_config,
          context,
          status,
          created_at,
          updated_at,
          last_fired_at,
          next_fire_at,
          fire_count,
          last_fire_status
        FROM schedules
        WHERE id = ?
        LIMIT 1
      `)
      .get(scheduleId);

    return row ? mapScheduleRow(row) : null;
  }

  private withDatabaseRetry<T>(operationName: string, action: () => T): T {
    return withSqliteLockRetry(operationName, action, {
      ...this.sqliteLockRetry,
      logger: this.sqliteLockRetry?.logger ?? this.logger,
    });
  }
}

function computeTriggerState(
  trigger: ScheduleTrigger,
  now: Date,
  timeZone: string,
  status: ScheduleStatus,
  fallbackNextFireAt: string | null = null,
): { next_fire_at: string | null } {
  if (status === "completed") {
    return { next_fire_at: null };
  }

  if (status === "paused" || status === "failed") {
    return { next_fire_at: fallbackNextFireAt };
  }

  if (trigger.type === "once") {
    return {
      next_fire_at: normalizeIsoDate(trigger.at),
    };
  }

  if (trigger.type === "cron") {
    return {
      next_fire_at: computeNextCronOccurrence(trigger.expression, now, timeZone).toISOString(),
    };
  }

  assertSupportedScheduleTriggerType(trigger.type);
  return { next_fire_at: null };
}

function shouldPreserveNextFireAt(
  current: ScheduleRecord,
  nextTrigger: ScheduleTrigger,
  nextStatus: ScheduleStatus,
): boolean {
  return current.status === nextStatus && hasEquivalentTimingSemantics(current.trigger, nextTrigger);
}

function hasEquivalentTimingSemantics(left: ScheduleTrigger, right: ScheduleTrigger): boolean {
  if (left.type !== right.type) {
    return false;
  }

  if (left.type === "cron" && right.type === "cron") {
    return left.expression === right.expression;
  }

  if (left.type === "once" && right.type === "once") {
    return normalizeIsoDate(left.at) === normalizeIsoDate(right.at);
  }

  if (left.type === "event" && right.type === "event") {
    return true;
  }

  assertSupportedScheduleTriggerType(left.type);
  return false;
}

function computeExecutionAdvance(
  schedule: ScheduleRecord,
  firedAt: Date,
  timeZone: string,
): { status: ScheduleStatus; next_fire_at: string | null } {
  if (schedule.trigger.type === "once") {
    return {
      status: "completed",
      next_fire_at: null,
    };
  }

  if (schedule.trigger.type === "cron") {
    return {
      status: "active",
      next_fire_at: computeNextCronOccurrence(schedule.trigger.expression, firedAt, timeZone).toISOString(),
    };
  }

  assertSupportedScheduleTriggerType(schedule.trigger.type);
  return {
    status: schedule.status,
    next_fire_at: schedule.next_fire_at,
  };
}

function mapScheduleRow(row: ScheduleRow): ScheduleRecord {
  const trigger = deserializeTrigger(row.trigger_type, row.trigger_config);
  const context = parseContext(row.context);

  return {
    schedule_id: row.id,
    workflow: row.workflow,
    group: row.group_label,
    trigger_type: normalizeTriggerType(row.trigger_type),
    trigger,
    context,
    instruction: context.instruction,
    status: normalizeStatus(row.status),
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_fired_at: row.last_fired_at,
    next_fire_at: row.next_fire_at,
    fire_count: row.fire_count,
    last_fire_status: normalizeLastFireStatus(row.last_fire_status),
  };
}

function deserializeTrigger(rawType: string, rawConfig: string): ScheduleTrigger {
  const triggerType = normalizeTriggerType(rawType);
  const parsedConfig = parseJsonRecord(rawConfig, "trigger_config");

  if (triggerType === "cron") {
    const expression = requireString(parsedConfig.expression ?? parsedConfig.cron, "trigger.expression");
    return {
      type: "cron",
      expression,
      cron: expression,
      description: optionalString(parsedConfig.description),
    };
  }

  if (triggerType === "once") {
    return {
      type: "once",
      at: normalizeIsoDate(requireString(parsedConfig.at, "trigger.at")),
      description: optionalString(parsedConfig.description),
    };
  }

  return {
    type: "event",
    ...parsedConfig,
  };
}

function serializeTriggerConfig(trigger: ScheduleTrigger): Record<string, unknown> {
  if (trigger.type === "cron") {
    parseCronExpression(trigger.expression);
    return {
      expression: trigger.expression,
      description: trigger.description,
    };
  }

  if (trigger.type === "once") {
    return {
      at: normalizeIsoDate(trigger.at),
      description: trigger.description,
    };
  }

  const { type: _type, ...rest } = trigger;
  return rest;
}

function parseContext(rawContext: string): ScheduleContextPayload {
  const parsed = parseJsonRecord(rawContext, "context");
  return {
    ...parsed,
    instruction: requireString(parsed.instruction, "context.instruction"),
  };
}

function normalizeTriggerType(value: string): ScheduleTriggerType {
  if (value === "cron" || value === "once" || value === "event") {
    return value;
  }

  throw new Error(`Unsupported schedule trigger type: ${value}`);
}

function normalizeStatus(value: string): ScheduleStatus {
  if (value === "active" || value === "paused" || value === "completed" || value === "failed") {
    return value;
  }

  throw new Error(`Unsupported schedule status: ${value}`);
}

function normalizeLastFireStatus(value: string | null): ScheduleLastFireStatus | null {
  if (value === null) {
    return null;
  }

  if (value === "success" || value === "failed") {
    return value;
  }

  throw new Error(`Unsupported schedule fire status: ${value}`);
}

function parseJsonRecord(value: string, fieldName: string): Record<string, unknown> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`Invalid ${fieldName}: ${toErrorMessage(error)}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid ${fieldName}: expected an object.`);
  }

  return parsed as Record<string, unknown>;
}

function normalizeIsoDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ISO 8601 datetime: ${value}`);
  }

  return parsed.toISOString();
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid ${fieldName}: expected a non-empty string.`);
  }

  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return requireString(value, "string");
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
