import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDatabaseMigrations } from "../../db/migrations.ts";
import type { LoadedPolicy } from "../../policy/types.ts";
import type { InteractionHandler } from "../types.ts";
import { PrimitiveDispatcher } from "../dispatcher.ts";
import { createExecuteHandler } from "./handler.ts";

const tempDirs: string[] = [];
const databases: Database[] = [];

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

describe("execute primitive", () => {
  test("runs commands in the execute workspace by default", async () => {
    const harness = await createHarness();

    const result = await harness.handler(
      { command: "pwd" },
      { sessionId: "session-1" },
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        exitCode: 0,
        stderr: "",
      },
    });
    expect((result.data as { stdout: string }).stdout.trim()).toBe(harness.executeWorkspaceDir);
  });

  test("returns non-zero exits with captured stderr", async () => {
    const harness = await createHarness();

    const result = await harness.handler(
      {
        command: `bun -e "console.error('boom'); process.exit(7)"`,
      },
      { sessionId: "session-1" },
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        exitCode: 7,
      },
    });
    expect((result.data as { stderr: string }).stderr).toContain("boom");
  });

  test("validates missing commands", async () => {
    const harness = await createHarness();

    const result = await harness.handler(
      { command: "   " },
      { sessionId: "session-1" },
    );

    expect(result).toEqual({
      success: false,
      error: "Invalid command: expected a non-empty string.",
    });
  });

  test("does not leak API keys or tokens into subprocess environments", async () => {
    const harness = await createHarness({
      env: {
        USER: "agent-user",
        OPENAI_API_KEY: "top-secret",
        GITHUB_TOKEN: "ghs_123",
      },
    });

    const result = await harness.handler(
      { command: "env" },
      { sessionId: "session-1" },
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        exitCode: 0,
      },
    });

    const stdout = (result.data as { stdout: string }).stdout;
    expect(stdout).toContain("USER=agent-user");
    expect(stdout).not.toContain("OPENAI_API_KEY");
    expect(stdout).not.toContain("GITHUB_TOKEN");
    expect(stdout).not.toContain("top-secret");
    expect(stdout).not.toContain("ghs_123");
  });

  test("kills long-running commands after the timeout", async () => {
    const harness = await createHarness({ defaultTimeoutMs: 50 });

    const result = await harness.handler(
      { command: "sleep 5" },
      { sessionId: "session-1" },
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        exitCode: -1,
      },
    });
    expect((result.data as { stderr: string }).stderr).toContain("Process timed out");
  });

  const processGroupTimeoutTest = process.platform === "win32" ? test.skip : test;

  processGroupTimeoutTest("kills the spawned process group after the timeout", async () => {
    const harness = await createHarness({ defaultTimeoutMs: 100 });
    const childPidPath = join(harness.executeWorkspaceDir, "child.pid");

    const result = await harness.handler(
      {
        command:
          `bun -e "import { writeFileSync } from 'node:fs'; const child = Bun.spawn({ cmd: ['sleep', '5'] }); writeFileSync('child.pid', String(child.pid)); await child.exited;"`,
      },
      { sessionId: "session-1" },
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        exitCode: -1,
      },
    });

    const childPid = Number((await readFile(childPidPath, "utf8")).trim());
    expect(Number.isInteger(childPid)).toBe(true);

    await Bun.sleep(50);

    expect(() => process.kill(childPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  });

  test("truncates stdout and stderr independently at 64KB", async () => {
    const harness = await createHarness();

    const result = await harness.handler(
      {
        command: `bun -e "process.stdout.write('a'.repeat(70000)); process.stderr.write('b'.repeat(70000))"`,
      },
      { sessionId: "session-1" },
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        exitCode: 0,
      },
    });

    const data = result.data as { stdout: string; stderr: string };
    expect(data.stdout).toContain("[stdout truncated at 64KB");
    expect(data.stderr).toContain("[stderr truncated at 64KB");
    expect(data.stdout.startsWith("a".repeat(1024))).toBe(true);
    expect(data.stderr.startsWith("b".repeat(1024))).toBe(true);
  });

  test("resolves relative cwd values from the execute workspace", async () => {
    const harness = await createHarness();
    const nestedDir = join(harness.executeWorkspaceDir, "nested");
    await mkdir(nestedDir, { recursive: true });

    const result = await harness.handler(
      {
        command: "pwd",
        cwd: "nested",
      },
      { sessionId: "session-1" },
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        exitCode: 0,
      },
    });
    expect((result.data as { stdout: string }).stdout.trim()).toBe(nestedDir);
  });

  test("allows absolute cwd values that stay within the execute workspace", async () => {
    const harness = await createHarness();
    const nestedDir = join(harness.executeWorkspaceDir, "nested");
    await mkdir(nestedDir, { recursive: true });

    const result = await harness.handler(
      {
        command: "pwd",
        cwd: nestedDir,
      },
      { sessionId: "session-1" },
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        exitCode: 0,
      },
    });
    expect((result.data as { stdout: string }).stdout.trim()).toBe(nestedDir);
  });

  test("rejects cwd values that escape the execute workspace", async () => {
    const harness = await createHarness();

    const relativeEscapeResult = await harness.handler(
      {
        command: "pwd",
        cwd: "..",
      },
      { sessionId: "session-1" },
    );

    expect(relativeEscapeResult).toEqual({
      success: false,
      error: "Invalid cwd: cwd must stay within the execute workspace.",
    });

    const absoluteEscapeResult = await harness.handler(
      {
        command: "pwd",
        cwd: harness.homeDir,
      },
      { sessionId: "session-1" },
    );

    expect(absoluteEscapeResult).toEqual({
      success: false,
      error: "Invalid cwd: cwd must stay within the execute workspace.",
    });
  });

  test("sets subprocess HOME to the configured runtime home", async () => {
    const harness = await createHarness({
      env: {
        HOME: "/tmp/ambient-home",
        USER: "agent-user",
      },
    });

    const result = await harness.handler(
      { command: "env" },
      { sessionId: "session-1" },
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        exitCode: 0,
      },
    });

    const stdout = (result.data as { stdout: string }).stdout;
    expect(stdout).toContain(`HOME=${harness.homeDir}`);
    expect(stdout).not.toContain("HOME=/tmp/ambient-home");
  });

  test("blocks obvious high-risk commands before execution", async () => {
    const harness = await createHarness();

    const result = await harness.handler(
      { command: "curl https://example.com" },
      { sessionId: "session-1" },
    );

    expect(result).toEqual({
      success: false,
      error: "Execute blocked: curl is blocked by the runtime execute layer.",
    });
  });

  test("rejects unsupported shell control syntax instead of invoking a shell", async () => {
    const harness = await createHarness();

    const result = await harness.handler(
      { command: "pwd | wc -l" },
      { sessionId: "session-1" },
    );

    expect(result).toEqual({
      success: false,
      error:
        "Unsupported shell syntax: \"|\" is not supported. Use a simple command without pipes, redirects, shell expansion, or control operators.",
    });
  });

  test("keeps the dispatcher policy gate in front of execute", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "agent-execute-policy-test-"));
    tempDirs.push(rootDir);

    const homeDir = join(rootDir, "home");
    const agentHome = join(homeDir, ".agent");
    const workspaceDir = join(rootDir, "workspace");
    const executeWorkspaceDir = join(agentHome, "workspace");
    await mkdir(agentHome, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(executeWorkspaceDir, { recursive: true });

    const database = new Database(":memory:", { create: true, strict: true });
    runDatabaseMigrations(database);
    databases.push(database);

    const policy: LoadedPolicy = {
      policyPath: join(rootDir, "policy.yaml"),
      installedDefault: false,
      summary: "test execute policy",
      rules: [
        {
          id: "rule-allow-pwd",
          primitive: "execute",
          action: "allow",
          match: { command: ["pwd"] },
        },
        {
          id: "rule-approve-rest",
          primitive: "execute",
          action: "approve",
          modelApprovalSufficient: false,
        },
      ],
    };

    const dispatcher = new PrimitiveDispatcher({
      agentHome,
      workspaceDir,
      executeWorkspaceDir,
      policy,
      getDatabase: () => database,
    });

    let approvals = 0;
    dispatcher.setInteractionHandler({
      notify: async () => ({ delivered: true }),
      ask: async () => "ok",
      requestApproval: async () => {
        approvals += 1;
        return { approved: true, response: "yes" };
      },
      hasApprovalReceipt: () => false,
    } satisfies InteractionHandler);

    const allowedResult = await dispatcher.dispatch(
      "execute",
      { command: "pwd" },
      { sessionId: "session-1" },
    );
    expect(allowedResult).toMatchObject({
      success: true,
      data: {
        exitCode: 0,
      },
    });
    expect(approvals).toBe(0);

    const approvedResult = await dispatcher.dispatch(
      "execute",
      { command: "ls" },
      { sessionId: "session-1" },
    );
    expect(approvedResult).toMatchObject({
      success: true,
      data: {
        exitCode: 0,
      },
    });
    expect(approvals).toBe(1);
  });

  test("default policy allows common read-only commands without approval", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "agent-execute-default-policy-test-"));
    tempDirs.push(rootDir);

    const homeDir = join(rootDir, "home");
    const agentHome = join(homeDir, ".agent");
    const workspaceDir = join(rootDir, "workspace");
    const executeWorkspaceDir = join(agentHome, "workspace");
    const repoDir = join(executeWorkspaceDir, "repo");
    await mkdir(agentHome, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(repoDir, { recursive: true });
    await writeFile(join(repoDir, "tracked.txt"), "hello\n", "utf8");

    const initResult = Bun.spawnSync({
      cmd: ["git", "init"],
      cwd: repoDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(initResult.exitCode).toBe(0);

    const addResult = Bun.spawnSync({
      cmd: ["git", "add", "tracked.txt"],
      cwd: repoDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(addResult.exitCode).toBe(0);

    const commitResult = Bun.spawnSync({
      cmd: ["git", "-c", "user.name=Agent Test", "-c", "user.email=agent@example.com", "commit", "-m", "initial"],
      cwd: repoDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(commitResult.exitCode).toBe(0);

    const database = new Database(":memory:", { create: true, strict: true });
    runDatabaseMigrations(database);
    databases.push(database);

    const dispatcher = new PrimitiveDispatcher({
      agentHome,
      workspaceDir,
      executeWorkspaceDir,
      homeDir,
      getDatabase: () => database,
    });

    let approvals = 0;
    dispatcher.setInteractionHandler({
      notify: async () => ({ delivered: true }),
      ask: async () => "ok",
      requestApproval: async () => {
        approvals += 1;
        return { approved: true, response: "yes" };
      },
      hasApprovalReceipt: () => false,
    } satisfies InteractionHandler);

    const allowedCommands = [
      { command: "ls", cwd: "repo", expect: { stdout: expect.stringContaining("tracked.txt") } },
      { command: "ls -la", cwd: "repo", expect: { stdout: expect.stringContaining("tracked.txt") } },
      { command: "git status", cwd: "repo", expect: { stdout: expect.stringContaining("On branch") } },
      { command: "git diff", cwd: "repo", expect: { stdout: "" } },
      { command: "git diff --stat", cwd: "repo", expect: { stdout: "" } },
      { command: "git log", cwd: "repo", expect: { stdout: expect.stringContaining("initial") } },
      { command: "git log --oneline", cwd: "repo", expect: { stdout: expect.stringContaining("initial") } },
    ] as const;

    for (const entry of allowedCommands) {
      const result = await dispatcher.dispatch(
        "execute",
        { command: entry.command, cwd: entry.cwd },
        { sessionId: "session-1" },
      );

      expect(result).toMatchObject({
        success: true,
        data: {
          exitCode: 0,
          stderr: "",
          ...entry.expect,
        },
      });
    }

    expect(approvals).toBe(0);

    const approvedResult = await dispatcher.dispatch(
      "execute",
      { command: "git commit -m second", cwd: "repo" },
      { sessionId: "session-1" },
    );

    expect(approvedResult.success).toBe(true);
    expect(approvals).toBe(1);
  });
});

async function createHarness(
  options: {
    env?: Record<string, string | undefined>;
    defaultTimeoutMs?: number;
  } = {},
) {
  const rootDir = await mkdtemp(join(tmpdir(), "agent-execute-test-"));
  tempDirs.push(rootDir);

  const homeDir = join(rootDir, "home");
  const agentHome = join(homeDir, ".agent");
  const executeWorkspaceDirPath = join(agentHome, "workspace");
  await mkdir(executeWorkspaceDirPath, { recursive: true });
  const executeWorkspaceDir = await realpath(executeWorkspaceDirPath);

  return {
    homeDir,
    agentHome,
    executeWorkspaceDir,
    handler: createExecuteHandler({
      executeWorkspaceDir,
      homeDir,
      env: options.env,
      defaultTimeoutMs: options.defaultTimeoutMs,
    }),
  };
}
