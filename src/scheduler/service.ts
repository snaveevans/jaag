import type { ScheduleStore } from "./store.ts";
import type { TriggeredScheduleContext } from "./types.ts";
import { Logger } from "../observability/logger.ts";

export interface SchedulerServiceOptions {
  store: ScheduleStore;
  launchSchedule: (schedule: TriggeredScheduleContext, firedAt: Date) => Promise<boolean>;
  now?: () => Date;
  tickIntervalMs?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  logger?: Logger;
}

export class SchedulerService {
  private readonly store: ScheduleStore;
  private readonly launchSchedule: (schedule: TriggeredScheduleContext, firedAt: Date) => Promise<boolean>;
  private readonly now: () => Date;
  private readonly tickIntervalMs: number;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  private readonly logger: Logger;
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
    this.logger = (options.logger ?? new Logger()).child({ component: "scheduler.service" });
  }

  async start(): Promise<void> {
    if (this.intervalHandle) {
      return;
    }

    this.stopping = false;
    this.logger.info("scheduler.start", {
      tickIntervalMs: this.tickIntervalMs,
    });
    try {
      const reconciledCount = this.store.reconcileInterruptedExecutions(this.now());
      if (reconciledCount > 0) {
        this.logger.warn("scheduler.reconciled_interrupted_executions", {
          reconciledCount,
        });
      }
    } catch (error) {
      this.logger.error("scheduler.reconcile.error", {
        error,
      });
    }

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
    this.logger.info("scheduler.stop");
  }

  async runTick(): Promise<void> {
    if (this.activeTick) {
      await this.activeTick;
      return;
    }

    this.activeTick = this.performTick()
      .catch((error) => {
        this.logger.error("scheduler.tick.error", {
          error,
        });
      })
      .finally(() => {
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

      this.logger.info("scheduler.execution.dispatched", {
        scheduleId: schedule.schedule_id,
        workflow: schedule.workflow,
        firedAt,
      });
      void this.trackExecution(schedule, triggeredSchedule, firedAt);
    }
  }

  private async trackExecution(
    schedule: { schedule_id: string; workflow: string },
    triggeredSchedule: TriggeredScheduleContext,
    firedAt: Date,
  ): Promise<void> {
    try {
      const success = await this.launchSchedule(triggeredSchedule, firedAt);
      this.recordExecutionResultSafely(schedule.schedule_id, success ? "success" : "failed");
      this.logger.info("scheduler.execution.completed", {
        scheduleId: schedule.schedule_id,
        workflow: schedule.workflow,
        success,
      });
    } catch (error) {
      this.recordExecutionResultSafely(schedule.schedule_id, "failed");
      this.logger.error("scheduler.execution.failed", {
        scheduleId: schedule.schedule_id,
        workflow: schedule.workflow,
        error,
      });
    }
  }

  private recordExecutionResultSafely(scheduleId: string, status: "success" | "failed"): void {
    try {
      this.store.recordExecutionResult(scheduleId, status);
    } catch (error) {
      this.logger.error("scheduler.execution.record_failed", {
        scheduleId,
        status,
        error,
      });
    }
  }
}
