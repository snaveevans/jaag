export type ScheduleTriggerType = "cron" | "once" | "event";

export type ScheduleStatus = "active" | "paused" | "completed" | "failed";

export type ScheduleLastFireStatus = "success" | "failed";

export interface ScheduleContextPayload extends Record<string, unknown> {
  instruction: string;
}

export interface CronScheduleTrigger {
  type: "cron";
  expression: string;
  cron: string;
  description?: string;
}

export interface OnceScheduleTrigger {
  type: "once";
  at: string;
  description?: string;
}

export interface EventScheduleTrigger {
  type: "event";
  [key: string]: unknown;
}

export type ScheduleTrigger = CronScheduleTrigger | OnceScheduleTrigger | EventScheduleTrigger;

export interface ScheduleRecord {
  schedule_id: string;
  workflow: string;
  group: string | null;
  trigger_type: ScheduleTriggerType;
  trigger: ScheduleTrigger;
  context: ScheduleContextPayload;
  instruction: string;
  status: ScheduleStatus;
  created_at: string;
  updated_at: string;
  last_fired_at: string | null;
  next_fire_at: string | null;
  fire_count: number;
  last_fire_status: ScheduleLastFireStatus | null;
}

export interface ScheduleListFilters {
  workflow?: string;
  group?: string;
  status?: ScheduleStatus;
  trigger_type?: ScheduleTriggerType;
}

export interface TriggeredScheduleContext {
  schedule_id: string;
  workflow: string;
  group: string | null;
  trigger: ScheduleTrigger;
  context: ScheduleContextPayload;
  instruction: string;
}
