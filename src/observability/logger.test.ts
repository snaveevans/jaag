import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger, createFileLogSink } from "./logger.ts";

describe("Logger", () => {
  test("emits structured JSON lines with default fields", () => {
    const lines: string[] = [];
    const logger = new Logger({
      sink: {
        write(line: string) {
          lines.push(line);
        },
      },
      now: () => new Date("2026-03-26T12:00:00.000Z"),
      defaults: {
        service: "agent",
      },
    });

    logger.child({ component: "runtime.agent" }).warn("runtime.session.failed", {
      sessionId: "session-1",
      reason: "provider unavailable",
    });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}") as Record<string, unknown>).toEqual({
      timestamp: "2026-03-26T12:00:00.000Z",
      level: "warn",
      event: "runtime.session.failed",
      service: "agent",
      component: "runtime.agent",
      sessionId: "session-1",
      reason: "provider unavailable",
    });
  });

  test("writes newline-delimited entries to ~/.agent/logs/agent.log sinks", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "agent-logger-test-"));

    try {
      const agentHome = join(rootDir, ".agent");
      const logger = new Logger({
        sink: createFileLogSink(agentHome),
        now: () => new Date("2026-03-26T12:30:00.000Z"),
      });

      logger.info("daemon.ready", { port: 8765 });

      const contents = await readFile(join(agentHome, "logs", "agent.log"), "utf8");
      expect(contents.endsWith("\n")).toBe(true);
      expect(JSON.parse(contents.trim()) as Record<string, unknown>).toMatchObject({
        timestamp: "2026-03-26T12:30:00.000Z",
        level: "info",
        event: "daemon.ready",
        port: 8765,
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
