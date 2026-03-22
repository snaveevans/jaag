import type { Database } from "bun:sqlite";
import type { PrimitiveHandler, PrimitiveResult } from "./types.ts";
import { ScheduleStore, type CreateScheduleInput, type UpdateScheduleInput } from "../scheduler/store.ts";
import type {
  ScheduleContextPayload,
  ScheduleListFilters,
  ScheduleStatus,
  ScheduleTrigger,
  ScheduleTriggerType,
} from "../scheduler/types.ts";

interface ScheduleHandlerOptions {
  getDatabase: () => Database;
  timeZone?: string;
  now?: () => Date;
}

export function createScheduleHandler(options: ScheduleHandlerOptions): PrimitiveHandler {
  const store = new ScheduleStore({
    database: options.getDatabase(),
    timeZone: options.timeZone,
    now: options.now,
  });

  return async (params) => {
    try {
      const operation = requireString(params.operation, "operation");

      switch (operation) {
        case "create":
          return handleCreate(store, params);
        case "get":
          return handleGet(store, params);
        case "list":
          return handleList(store, params);
        case "update":
          return handleUpdate(store, params);
        case "delete":
          return handleDelete(store, params);
        default:
          return {
            success: false,
            error: `Unsupported schedule operation: ${operation}`,
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

function handleCreate(store: ScheduleStore, params: Record<string, unknown>): PrimitiveResult {
  const created = store.create(parseCreateInput(params));
  return {
    success: true,
    data: { schedule: created },
  };
}

function handleGet(store: ScheduleStore, params: Record<string, unknown>): PrimitiveResult {
  const schedule = store.getById(requireScheduleId(params));
  return {
    success: true,
    data: { schedule },
  };
}

function handleList(store: ScheduleStore, params: Record<string, unknown>): PrimitiveResult {
  return {
    success: true,
    data: {
      schedules: store.list(parseListFilters(params)),
    },
  };
}

function handleUpdate(store: ScheduleStore, params: Record<string, unknown>): PrimitiveResult {
  const scheduleId = requireScheduleId(params);
  const current = store.getById(scheduleId);
  if (!current) {
    return {
      success: true,
      data: { schedule: null },
    };
  }

  const updates = parseUpdateInput(params, current.context);
  if (Object.keys(updates).length === 0) {
    throw new Error("Schedule update requires at least one field to change.");
  }

  const updated = store.update(scheduleId, updates);
  return {
    success: true,
    data: { schedule: updated ?? current },
  };
}

function handleDelete(store: ScheduleStore, params: Record<string, unknown>): PrimitiveResult {
  const scheduleId = optionalScheduleId(params);
  const group = optionalNullableString(params.group);

  if (scheduleId && group !== undefined) {
    throw new Error("Schedule delete accepts either schedule_id/id or group, not both.");
  }

  if (scheduleId) {
    const count = store.deleteById(scheduleId);
    return {
      success: true,
      data: {
        deleted: count > 0,
        count,
      },
    };
  }

  if (group === undefined || group === null) {
    throw new Error("Schedule delete requires schedule_id/id or group.");
  }

  const count = store.deleteByGroup(group);
  return {
    success: true,
    data: {
      deleted: count > 0,
      count,
    },
  };
}

function parseCreateInput(params: Record<string, unknown>): CreateScheduleInput {
  return {
    workflow: requireString(params.workflow, "workflow"),
    group: optionalNullableString(params.group),
    trigger: parseTrigger(params.trigger),
    context: normalizeContext(params),
    status: optionalScheduleStatus(params.status),
  };
}

function parseUpdateInput(
  params: Record<string, unknown>,
  existingContext: ScheduleContextPayload,
): UpdateScheduleInput {
  const updates: UpdateScheduleInput = {};

  if (params.workflow !== undefined) {
    updates.workflow = requireString(params.workflow, "workflow");
  }

  if (params.group !== undefined) {
    updates.group = optionalNullableString(params.group) ?? null;
  }

  if (params.trigger !== undefined) {
    updates.trigger = parseTrigger(params.trigger);
  }

  if (params.instruction !== undefined || params.context !== undefined) {
    updates.context = normalizeContext(params, existingContext);
  }

  if (params.status !== undefined) {
    updates.status = requireScheduleStatus(params.status, "status");
  }

  return updates;
}

function parseListFilters(params: Record<string, unknown>): ScheduleListFilters {
  const rawFilters = params.filters;
  const filters = rawFilters === undefined ? {} : requireRecord(rawFilters, "filters");

  return {
    workflow: optionalString(params.workflow) ?? optionalString(filters.workflow),
    group: optionalString(params.group) ?? optionalString(filters.group),
    status: optionalScheduleStatus(params.status) ?? optionalScheduleStatus(filters.status),
    trigger_type: optionalScheduleTriggerType(params.trigger_type) ?? optionalScheduleTriggerType(filters.trigger_type),
  };
}

function normalizeContext(
  params: Record<string, unknown>,
  existingContext?: ScheduleContextPayload,
): ScheduleContextPayload {
  const rawContext = params.context === undefined ? {} : requireRecord(params.context, "context");
  const instruction = optionalString(params.instruction)
    ?? optionalString(rawContext.instruction)
    ?? existingContext?.instruction
    ?? null;

  if (!instruction) {
    throw new Error("Schedule requires instruction or context.instruction.");
  }

  return {
    ...(existingContext ?? {}),
    ...rawContext,
    instruction,
  };
}

function parseTrigger(value: unknown): ScheduleTrigger {
  const trigger = requireRecord(value, "trigger");
  const type = requireScheduleTriggerType(trigger.type, "trigger.type");

  if (type === "cron") {
    const expression = requireString(trigger.expression ?? trigger.cron, "trigger.expression");
    return {
      type: "cron",
      expression,
      cron: expression,
      description: optionalString(trigger.description),
    };
  }

  if (type === "once") {
    return {
      type: "once",
      at: requireString(trigger.at, "trigger.at"),
      description: optionalString(trigger.description),
    };
  }

  throw new Error("Event schedules are not supported yet.");
}

function requireScheduleId(params: Record<string, unknown>): string {
  return optionalScheduleId(params) ?? (() => {
    throw new Error("Schedule operation requires schedule_id or id.");
  })();
}

function optionalScheduleId(params: Record<string, unknown>): string | undefined {
  return optionalString(params.schedule_id) ?? optionalString(params.id);
}

function requireRecord(value: unknown, fieldName: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${fieldName}: expected an object.`);
  }

  return value as Record<string, unknown>;
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

function optionalNullableString(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  return requireString(value, "string");
}

function optionalScheduleStatus(value: unknown): ScheduleStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  return requireScheduleStatus(value, "status");
}

function requireScheduleStatus(value: unknown, fieldName: string): ScheduleStatus {
  if (value === "active" || value === "paused" || value === "completed" || value === "failed") {
    return value;
  }

  throw new Error(`Invalid ${fieldName}: expected active, paused, completed, or failed.`);
}

function optionalScheduleTriggerType(value: unknown): ScheduleTriggerType | undefined {
  if (value === undefined) {
    return undefined;
  }

  return requireScheduleTriggerType(value, "trigger_type");
}

function requireScheduleTriggerType(value: unknown, fieldName: string): ScheduleTriggerType {
  if (value === "cron" || value === "once" || value === "event") {
    return value;
  }

  throw new Error(`Invalid ${fieldName}: expected cron, once, or event.`);
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
