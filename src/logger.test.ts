import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test";
import { createLogger } from "./logger.ts";
import type { Logger } from "./logger.ts";

describe("createLogger", () => {
  let logger: Logger;
  let logSpy: ReturnType<typeof spyOn>;
  let warnSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logger = createLogger();
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test("info writes to console.log with level and timestamp", () => {
    logger.info("daemon started");
    expect(logSpy).toHaveBeenCalledTimes(1);
    const output: string = logSpy.mock.calls[0][0];
    expect(output).toContain("[INFO ]");
    expect(output).toContain("daemon started");
    expect(output).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("warn writes to console.warn with level and timestamp", () => {
    logger.warn("shutdown timed out");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const output: string = warnSpy.mock.calls[0][0];
    expect(output).toContain("[WARN ]");
    expect(output).toContain("shutdown timed out");
    expect(output).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("error writes to console.error with level and timestamp", () => {
    logger.error("failed to bind port");
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const output: string = errorSpy.mock.calls[0][0];
    expect(output).toContain("[ERROR]");
    expect(output).toContain("failed to bind port");
    expect(output).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
