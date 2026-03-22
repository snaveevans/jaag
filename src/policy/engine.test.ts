import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDatabaseMigrations } from "../db/migrations.ts";
import type { PrimitiveContext, InteractionHandler } from "../primitives/types.ts";
import { PolicyEngine } from "./engine.ts";
import { PolicyRateLimiter } from "./rate-limiter.ts";
import type { LoadedPolicy, PolicyRule } from "./types.ts";

const databases: Database[] = [];
const tempDirs: string[] = [];
const SESSION_CONTEXT: PrimitiveContext = { sessionId: "session-1" };

afterEach(async () => {
  while (databases.length > 0) {
    databases.pop()?.close(false);
  }

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("policy engine", () => {
  test("matches the workspace alias for file writes and blocks writes outside it", async () => {
    const { engine } = createHarness([
      {
        id: "rule-1",
        primitive: "file_write",
        action: "allow",
        match: { path: ["~/.agent/workspace/**"] },
      },
      {
        id: "rule-2",
        primitive: "file_write",
        action: "block",
      },
    ]);

    await expect(engine.enforce({
      primitive: "file_write",
      path: "/tmp/workspace/notes/today.md",
    }, SESSION_CONTEXT)).resolves.toMatchObject({ action: "allow" });

    await expect(engine.enforce({
      primitive: "file_write",
      path: "/tmp/outside.txt",
    }, SESSION_CONTEXT)).resolves.toMatchObject({
      action: "block",
      reason: expect.stringContaining("Policy blocked"),
    });
  });

  test("matches the workspace alias against the workspace realpath", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "agent-policy-engine-workspace-"));
    tempDirs.push(rootDir);

    const actualWorkspaceDir = join(rootDir, "actual-workspace");
    const workspaceDir = join(rootDir, "workspace-link");
    await mkdir(actualWorkspaceDir, { recursive: true });
    await symlink(actualWorkspaceDir, workspaceDir);

    const { engine } = createHarness(
      [
        {
          id: "rule-1",
          primitive: "file_write",
          action: "allow",
          match: { path: ["~/.agent/workspace/**"] },
        },
        {
          id: "rule-2",
          primitive: "file_write",
          action: "block",
        },
      ],
      {},
      { workspaceDir },
    );

    await expect(engine.enforce({
      primitive: "file_write",
      path: join(actualWorkspaceDir, "notes", "today.md"),
    }, SESSION_CONTEXT)).resolves.toMatchObject({ action: "allow" });
  });

  test("evaluates rate limits before allow rules", async () => {
    const { engine } = createHarness([
      {
        id: "rule-1",
        primitive: "http",
        action: "rate_limit",
        match: { tool: ["mockmail"], operation: ["messages.send"] },
        limit: { count: 1, window: "1m", windowMs: 60_000 },
      },
      {
        id: "rule-2",
        primitive: "http",
        action: "allow",
      },
    ]);

    await expect(engine.enforce({
      primitive: "http",
      domain: "example.test",
      path: "/messages",
      method: "POST",
      tool: "mockmail",
      operation: "messages.send",
    }, SESSION_CONTEXT)).resolves.toMatchObject({ action: "allow" });

    await expect(engine.enforce({
      primitive: "http",
      domain: "example.test",
      path: "/messages",
      method: "POST",
      tool: "mockmail",
      operation: "messages.send",
    }, SESSION_CONTEXT)).resolves.toMatchObject({ action: "rate_limit" });
  });

  test("uses approval receipts before prompting the user again", async () => {
    let approvalPrompts = 0;
    const { engine } = createHarness([
      {
        id: "rule-1",
        primitive: "http",
        action: "approve",
        match: { method: ["POST"] },
        modelApprovalSufficient: true,
      },
    ], {
      hasApprovalReceipt: () => true,
      requestApproval: async () => {
        approvalPrompts += 1;
        return true;
      },
    });

    const result = await engine.enforce({
      primitive: "http",
      domain: "example.test",
      path: "/messages",
      method: "POST",
      tool: "mockmail",
      operation: "messages.send",
    }, SESSION_CONTEXT);

    expect(result).toMatchObject({ action: "allow", source: "receipt" });
    expect(approvalPrompts).toBe(0);
  });

  test("matches http domain, method, trust tier, and operation fields", async () => {
    const { engine } = createHarness([
      {
        id: "rule-1",
        primitive: "http",
        action: "block",
        match: {
          domain: ["api.example.test"],
          method: ["DELETE"],
          trust_tier: ["untrusted"],
          operation: ["messages.send"],
        },
      },
      {
        id: "rule-2",
        primitive: "http",
        action: "allow",
      },
    ]);

    const blocked = await engine.enforce({
      primitive: "http",
      domain: "api.example.test",
      path: "/messages",
      method: "DELETE",
      trust_tier: "untrusted",
      tool: "mockmail",
      operation: "messages.send",
    }, SESSION_CONTEXT);

    const allowed = await engine.enforce({
      primitive: "http",
      domain: "api.example.test",
      path: "/messages",
      method: "DELETE",
      trust_tier: "trusted",
      tool: "mockmail",
      operation: "messages.send",
    }, SESSION_CONTEXT);

    expect(blocked.action).toBe("block");
    expect(allowed.action).toBe("allow");
  });
});

function createHarness(
  rules: PolicyRule[],
  interactionOverrides: Partial<InteractionHandler> = {},
  options: { workspaceDir?: string; homeDir?: string } = {},
): { engine: PolicyEngine } {
  const database = new Database(":memory:", { create: true, strict: true });
  runDatabaseMigrations(database);
  databases.push(database);

  const interactionHandler: InteractionHandler = {
    notify: async () => ({ delivered: true }),
    ask: async () => "ok",
    requestApproval: async () => true,
    hasApprovalReceipt: () => false,
    ...interactionOverrides,
  };

  const policy: LoadedPolicy = {
    policyPath: "/tmp/policy.yaml",
    installedDefault: false,
    summary: "test summary",
    rules,
  };

  return {
    engine: new PolicyEngine({
      policy,
      workspaceDir: options.workspaceDir ?? "/tmp/workspace",
      homeDir: options.homeDir ?? "/tmp/home",
      interactionHandler,
      rateLimiter: new PolicyRateLimiter({ database }),
    }),
  };
}
