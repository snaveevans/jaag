import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type LogLevel = "info" | "warn" | "error";

export interface LogSink {
  write(line: string): void;
}

export interface LoggerOptions {
  sink?: LogSink;
  now?: () => Date;
  defaults?: Record<string, unknown>;
}

export class Logger {
  private readonly sink: LogSink;
  private readonly now: () => Date;
  private readonly defaults: Record<string, unknown>;

  constructor(options: LoggerOptions = {}) {
    this.sink = options.sink ?? new NoopLogSink();
    this.now = options.now ?? (() => new Date());
    this.defaults = options.defaults ?? {};
  }

  child(defaults: Record<string, unknown>): Logger {
    return new Logger({
      sink: this.sink,
      now: this.now,
      defaults: {
        ...this.defaults,
        ...defaults,
      },
    });
  }

  info(event: string, fields: Record<string, unknown> = {}): void {
    this.log("info", event, fields);
  }

  warn(event: string, fields: Record<string, unknown> = {}): void {
    this.log("warn", event, fields);
  }

  error(event: string, fields: Record<string, unknown> = {}): void {
    this.log("error", event, fields);
  }

  private log(level: LogLevel, event: string, fields: Record<string, unknown>): void {
    const payload = sanitizeRecord({
      ...this.defaults,
      ...fields,
    });
    delete payload.timestamp;
    delete payload.level;
    delete payload.event;

    const line = JSON.stringify({
      timestamp: this.now().toISOString(),
      level,
      event,
      ...payload,
    });

    try {
      this.sink.write(`${line}\n`);
    } catch {
      // Logging must never crash the runtime.
    }
  }
}

export function createFileLogSink(agentHome: string): LogSink {
  const logDirectory = join(agentHome, "logs");
  const logPath = join(logDirectory, "agent.log");
  mkdirSync(logDirectory, { recursive: true });

  return {
    write(line: string): void {
      appendFileSync(logPath, line, "utf8");
    },
  } satisfies LogSink;
}

class NoopLogSink implements LogSink {
  write(_line: string): void {}
}

function sanitizeRecord(value: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const [key, fieldValue] of Object.entries(value)) {
    if (fieldValue === undefined) {
      continue;
    }

    sanitized[key] = sanitizeValue(fieldValue);
  }

  return sanitized;
}

function sanitizeValue(value: unknown): unknown {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean"
  ) {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    return sanitizeRecord({
      name: value.name,
      message: value.message,
      stack: value.stack,
    });
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry));
  }

  if (typeof value === "object") {
    return sanitizeRecord(value as Record<string, unknown>);
  }

  return String(value);
}
