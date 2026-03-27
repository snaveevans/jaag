import type { ScheduleStore } from "./store.ts";
import type { TriggeredScheduleContext } from "./types.ts";

export interface SchedulerServiceOptions {
  store: ScheduleStore;
  launchSchedule: (schedule: TriggeredScheduleContext, firedAt: Date) => Promise<boolean>;
  now?: () => Date;
  tickIntervalMs?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

export class SchedulerService {
  private readonly store: ScheduleStore;
  private readonly launchSchedule: (schedule: TriggeredScheduleContext, firedAt: Date) => Promise<boolean>;
  private readonly now: () => Date;
  private readonly tickIntervalMs: number;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private activeTick: Promise<void> | null = null;
  private stopping = false;

  constructor(options: SchedulerServiceOptions) {
    this.store = options.store;
    this.launchSchedule = options.launchSchedule;
    this.now = options.now ?? (() => new Date());
    this.tickIntervalMs = options.tickIntervalMs ?? 5_000;
    this.setIntervalFn = options.setIntervalFn ?? setInterval;
    this.clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  }

  async start(): Promise<void> {
    if (this.intervalHandle) {
      return;
    }

    this.stopping = false;
    this.store.reconcileInterruptedExecutions(this.now());
    await this.runTick();
    this.intervalHandle = this.setIntervalFn(() => {
      void this.runTick();
    }, this.tickIntervalMs);
  }

  async stop(): Promise<void> {
    this.stopping = true;

    if (this.intervalHandle) {
      this.clearIntervalFn(this.intervalHandle);
      this.intervalHandle = null;
    }

    await this.activeTick;
  }

  async runTick(): Promise<void> {
    if (this.activeTick) {
      await this.activeTick;
      return;
    }

    this.activeTick = this.performTick().finally(() => {
      this.activeTick = null;
    });
    await this.activeTick;
  }

  private async performTick(): Promise<void> {
    if (this.stopping) {
      return;
    }

    const firedAt = this.now();
    const dueScheduleIds = this.store.listDueScheduleIds(firedAt);
    for (const scheduleId of dueScheduleIds) {
      if (this.stopping) {
        return;
      }

      const schedule = this.store.advanceForExecution(scheduleId, firedAt);
      if (!schedule) {
        continue;
      }

      const triggeredSchedule: TriggeredScheduleContext = {
        schedule_id: schedule.schedule_id,
        workflow: schedule.workflow,
        group: schedule.group,
        trigger: schedule.trigger,
        context: schedule.context,
        instruction: schedule.instruction,
      };

      void this.launchSchedule(triggeredSchedule, firedAt)
        .then((success) => {
          this.store.recordExecutionResult(schedule.schedule_id, success ? "success" : "failed");
        })
        .catch(() => {
          this.store.recordExecutionResult(schedule.schedule_id, "failed");
        });
    }
  }
}
