import { describe, expect, test } from "bun:test";
import type { InternalMessage } from "../llm/types.ts";
import {
  buildCompactedMessageHistory,
  buildCompactionSummaryMessage,
  createContextBudgetSnapshot,
  estimateTokenCount,
  planHistoryCompaction,
} from "./budget.ts";

describe("context budget helpers", () => {
  test("uses rough 4-chars-per-token estimation and utilization thresholds", () => {
    expect(estimateTokenCount("")).toBe(0);
    expect(estimateTokenCount("abcd")).toBe(1);
    expect(estimateTokenCount("abcde")).toBe(2);

    const snapshot = createContextBudgetSnapshot({
      contextLimit: 100,
      messageTokens: 64,
      toolDeclarationTokens: 16,
    });

    expect(snapshot.usedTokens).toBe(80);
    expect(snapshot.utilization).toBe(0.8);
    expect(snapshot.shouldCompact).toBe(true);
    expect(snapshot.exceedsHardCeiling).toBe(false);
  });

  test("keeps the larger of the recent window or the latest user exchange", () => {
    const messages = buildMessages([
      ["user", "u1"],
      ["assistant", "a1"],
      ["tool_result", "t1"],
      ["assistant", "a2"],
      ["user", "u2"],
      ["assistant", "a3"],
      ["tool_result", "t2"],
      ["assistant", "a4"],
      ["assistant", "a5"],
      ["assistant", "a6"],
    ]);

    const plan = planHistoryCompaction(messages, 6);
    expect(plan).not.toBeNull();
    expect(plan?.keepStartIndex).toBe(5);
    expect(plan?.compactedMessages.map((message) => message.content)).toEqual(["u1", "a1", "t1", "a2"]);
    expect(plan?.keepMessages.map((message) => message.content)).toEqual(["u2", "a3", "t2", "a4", "a5", "a6"]);
  });

  test("builds compacted history with one inserted summary system message", () => {
    const messages = buildMessages([
      ["user", "u1"],
      ["assistant", "a1"],
      ["tool_result", "t1"],
      ["assistant", "a2"],
    ]);

    const compacted = buildCompactedMessageHistory(
      messages,
      4,
      buildCompactionSummaryMessage("Older context."),
    );

    expect(compacted.map((message) => message.role)).toEqual([
      "system",
      "system",
      "assistant",
    ]);
    expect(compacted[1]?.content).toContain("Older context.");
    expect(compacted[2]?.content).toBe("a2");
  });
});

function buildMessages(entries: Array<[InternalMessage["role"], string]>): InternalMessage[] {
  return [
    { role: "system", content: "system prompt" },
    ...entries.map(([role, content], index) => {
      if (role === "tool_result") {
        return {
          role,
          content,
          toolResultId: `call-${index + 1}`,
        } satisfies InternalMessage;
      }

      return {
        role,
        content,
      } satisfies InternalMessage;
    }),
  ];
}
