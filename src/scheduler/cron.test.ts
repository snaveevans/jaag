import { describe, expect, test } from "bun:test";
import { computeNextCronOccurrence, parseCronExpression } from "./cron.ts";

describe("parseCronExpression", () => {
  test("parses steps, lists, and normalizes sunday to 0", () => {
    const parsed = parseCronExpression("*/15 9,17 1-5 1,6 0,7");

    expect(parsed.minute.values).toEqual([0, 15, 30, 45]);
    expect(parsed.hour.values).toEqual([9, 17]);
    expect(parsed.dayOfMonth.values).toEqual([1, 2, 3, 4, 5]);
    expect(parsed.month.values).toEqual([1, 6]);
    expect(parsed.dayOfWeek.values).toEqual([0]);
  });

  test("rejects invalid field counts", () => {
    expect(() => parseCronExpression("0 9 * *")).toThrow("expected 5 fields");
  });
});

describe("computeNextCronOccurrence", () => {
  test("computes the next matching UTC minute", () => {
    const next = computeNextCronOccurrence("*/5 * * * *", new Date("2026-03-21T10:02:30.000Z"), "UTC");
    expect(next.toISOString()).toBe("2026-03-21T10:05:00.000Z");
  });

  test("handles month boundaries and leap years", () => {
    const next = computeNextCronOccurrence("0 0 29 2 *", new Date("2025-03-01T00:00:00.000Z"), "UTC");
    expect(next.toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });

  test("evaluates cron expressions in the configured runtime timezone", () => {
    const next = computeNextCronOccurrence("0 9 * * *", new Date("2026-01-15T14:30:00.000Z"), "America/New_York");
    expect(next.toISOString()).toBe("2026-01-16T14:00:00.000Z");
  });
});
