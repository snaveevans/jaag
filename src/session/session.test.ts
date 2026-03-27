import { describe, expect, test } from "bun:test";
import { buildCompactionSummaryMessage } from "../context/budget.ts";
import { SessionManager } from "./manager.ts";
import { AgentSession } from "./session.ts";

describe("AgentSession", () => {
  test("appends messages and tracks iteration limit", () => {
    const session = new AgentSession({
      systemPrompt: "system prompt",
      createdAt: new Date("2026-03-19T00:00:00.000Z"),
      maxIterations: 2,
    });

    session.appendUserMessage("hello", new Date("2026-03-19T00:01:00.000Z"));
    session.appendAssistantMessage("working");
    session.appendToolResult("call-1", '{"success":false}');

    expect(session.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool_result",
    ]);

    expect(session.incrementIteration()).toBe(1);
    expect(session.incrementIteration()).toBe(2);
    expect(session.hasReachedIterationLimit()).toBe(true);
  });

  test("detects inactivity timeout", () => {
    const session = new AgentSession({
      systemPrompt: "system prompt",
      createdAt: new Date("2026-03-19T00:00:00.000Z"),
      inactivityTimeoutMs: 1000,
    });

    expect(session.isExpired(new Date("2026-03-19T00:00:00.999Z"))).toBe(false);
    expect(session.isExpired(new Date("2026-03-19T00:00:01.500Z"))).toBe(true);
  });

  test("stores approval receipts scoped to tool and operation", () => {
    const session = new AgentSession({
      systemPrompt: "system prompt",
      createdAt: new Date("2026-03-19T00:00:00.000Z"),
    });

    session.addApprovalReceipt({
      timestamp: new Date("2026-03-19T00:01:00.000Z"),
      tool: "mockmail",
      operation: "messages.send",
      summary: "Send the message",
    });

    expect(session.hasApprovalReceipt({
      tool: "mockmail",
      operation: "messages.send",
      now: new Date("2026-03-19T00:05:00.000Z"),
    })).toBe(true);
    expect(session.hasApprovalReceipt({
      tool: "mockmail",
      operation: "messages.delete",
      now: new Date("2026-03-19T00:05:00.000Z"),
    })).toBe(false);
  });

  test("replaces older history with one summary system message and refreshes token accounting", () => {
    const session = new AgentSession({
      systemPrompt: "system prompt",
      createdAt: new Date("2026-03-19T00:00:00.000Z"),
    });

    session.appendUserMessage("first user");
    session.appendAssistantMessage("first assistant");
    session.appendToolResult("call-1", "tool result");
    session.appendAssistantMessage("second assistant");
    session.appendUserMessage("latest user");
    session.appendAssistantMessage("latest assistant");

    const before = session.getMessageTokenEstimate();

    session.replaceCompactedHistory(
      buildCompactionSummaryMessage("Earlier context."),
      4,
    );

    expect(session.messages.map((message) => message.role)).toEqual([
      "system",
      "system",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(session.messages[1]?.content).toContain("Earlier context.");
    expect(session.messages[2]?.content).toBe("second assistant");
    expect(session.getMessageTokenEstimate()).toBeLessThan(before);
  });
});

describe("SessionManager", () => {
  test("reuses one interactive session until timeout", async () => {
    const manager = new SessionManager({
      inactivityTimeoutMs: 60_000,
      buildSystemPrompt: () => "prompt",
    });

    const first = await manager.getOrCreateInteractiveSession(new Date("2026-03-19T00:00:00.000Z"));
    const second = await manager.getOrCreateInteractiveSession(new Date("2026-03-19T00:00:30.000Z"));
    const third = await manager.getOrCreateInteractiveSession(new Date("2026-03-19T00:02:00.000Z"));

    expect(second.id).toBe(first.id);
    expect(third.id).not.toBe(first.id);
    expect(manager.getSession(first.id)).toBeUndefined();
    expect(manager.listSessions()).toHaveLength(1);
  });

  test("prunes completed and failed sessions from memory", async () => {
    const manager = new SessionManager({
      buildSystemPrompt: () => "prompt",
    });

    const completed = await manager.getOrCreateInteractiveSession(new Date("2026-03-19T00:00:00.000Z"));
    manager.completeSession(completed.id, new Date("2026-03-19T00:00:01.000Z"));

    expect(manager.getInteractiveSession()).toBeNull();
    expect(manager.getSession(completed.id)).toBeUndefined();
    expect(manager.listSessions()).toHaveLength(0);

    const failed = await manager.getOrCreateInteractiveSession(new Date("2026-03-19T00:01:00.000Z"));
    manager.failSession(failed.id, new Date("2026-03-19T00:01:01.000Z"));

    expect(manager.getInteractiveSession()).toBeNull();
    expect(manager.getSession(failed.id)).toBeUndefined();
    expect(manager.listSessions()).toHaveLength(0);
  });
});
