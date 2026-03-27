export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

function formatEntry(entry: LogEntry): string {
  const tag = entry.level.toUpperCase().padEnd(5);
  return `${entry.timestamp} [${tag}] ${entry.message}`;
}

function now(): string {
  return new Date().toISOString();
}

export function createLogger(): Logger {
  return {
    info(message: string): void {
      const entry: LogEntry = { level: "info", message, timestamp: now() };
      console.log(formatEntry(entry));
    },
    warn(message: string): void {
      const entry: LogEntry = { level: "warn", message, timestamp: now() };
      console.warn(formatEntry(entry));
    },
    error(message: string): void {
      const entry: LogEntry = { level: "error", message, timestamp: now() };
      console.error(formatEntry(entry));
    },
  };
}
