import { describe, expect, test } from "bun:test";
import {
  APPROVAL_RECEIPT_WINDOW_MS,
  createApprovalReceipt,
  hasMatchingApprovalReceipt,
} from "./receipts.ts";

describe("approval receipts", () => {
  test("matches only the same tool and operation within five minutes", () => {
    const now = new Date("2026-03-21T00:05:00.000Z");
    const receipts = [
      createApprovalReceipt({
        timestamp: new Date("2026-03-21T00:01:00.000Z"),
        tool: "mockmail",
        operation: "messages.send",
        summary: "Send the message",
      }),
    ];

    expect(hasMatchingApprovalReceipt(receipts, {
      tool: "mockmail",
      operation: "messages.send",
      now,
    })).toBe(true);

    expect(hasMatchingApprovalReceipt(receipts, {
      tool: "mockmail",
      operation: "messages.delete",
      now,
    })).toBe(false);

    expect(hasMatchingApprovalReceipt(receipts, {
      tool: "mockmail",
      operation: "messages.send",
      now: new Date(now.getTime() + APPROVAL_RECEIPT_WINDOW_MS + 1),
    })).toBe(false);
  });
});
