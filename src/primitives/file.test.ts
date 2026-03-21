import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILE_READ_LIMIT_BYTES, createFileReadHandler, createFileWriteHandler } from "./file.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("file primitives", () => {
  test("writes workspace-relative files and reads them back", async () => {
    const harness = await createHarness();

    const writeResult = await harness.writeHandler(
      {
        path: "notes/today.md",
        content: "slice 02 is live",
      },
      { sessionId: "session-1" },
    );

    expect(writeResult).toMatchObject({
      success: true,
      data: {
        path: join(harness.workspaceDir, "notes", "today.md"),
        bytesWritten: 16,
      },
    });

    const readResult = await harness.readHandler(
      {
        path: "notes/today.md",
      },
      { sessionId: "session-1" },
    );

    expect(readResult).toMatchObject({
      success: true,
      data: {
        path: join(harness.workspaceDir, "notes", "today.md"),
        type: "file",
        content: "slice 02 is live",
        truncated: false,
      },
    });
  });

  test("lists directories and truncates large files", async () => {
    const harness = await createHarness();
    await mkdir(join(harness.workspaceDir, "docs", "nested"), { recursive: true });
    await Bun.write(join(harness.workspaceDir, "docs", "alpha.txt"), "alpha");
    await Bun.write(join(harness.workspaceDir, "big.txt"), "a".repeat(FILE_READ_LIMIT_BYTES + 128));

    const dirResult = await harness.readHandler(
      {
        path: "docs",
      },
      { sessionId: "session-1" },
    );

    expect(dirResult).toMatchObject({
      success: true,
      data: {
        type: "directory",
        entries: ["alpha.txt", "nested/"],
      },
    });

    const fileResult = await harness.readHandler(
      {
        path: "big.txt",
      },
      { sessionId: "session-1" },
    );

    expect(fileResult).toMatchObject({
      success: true,
      data: {
        type: "file",
        truncated: true,
        totalBytes: FILE_READ_LIMIT_BYTES + 128,
      },
    });
    expect((fileResult.data as { content: string }).content).toHaveLength(FILE_READ_LIMIT_BYTES);
    expect((fileResult.data as { notice: string }).notice).toContain("File truncated");
  });

  test("reads sparse files without loading beyond the truncation limit", async () => {
    const harness = await createHarness();
    const targetPath = join(harness.workspaceDir, "huge.txt");
    const handle = await open(targetPath, "w");

    try {
      await handle.writeFile("prefix");
      await handle.truncate(5 * 1024 * 1024 * 1024);
    } finally {
      await handle.close();
    }

    const fileResult = await harness.readHandler(
      {
        path: "huge.txt",
      },
      { sessionId: "session-1" },
    );

    expect(fileResult).toMatchObject({
      success: true,
      data: {
        type: "file",
        truncated: true,
        totalBytes: 5 * 1024 * 1024 * 1024,
      },
    });
    expect((fileResult.data as { content: string }).content).toHaveLength(FILE_READ_LIMIT_BYTES);
    expect((fileResult.data as { content: string }).content.startsWith("prefix")).toBe(true);
  });

  test("reads runtime config while keeping protected paths blocked", async () => {
    const harness = await createHarness();
    await Bun.write(join(harness.agentHome, "config.yaml"), "model: gpt-5\n");

    const blockedWrite = await harness.writeHandler(
      {
        path: "~/.agent-policy/policy.yaml",
        content: "deny: all",
      },
      { sessionId: "session-1" },
    );

    expect(blockedWrite).toMatchObject({
      success: false,
      error: `Write blocked: ${join(harness.homeDir, ".agent-policy")} is protected by the runtime.`,
    });

    const configRead = await harness.readHandler(
      {
        path: "~/.agent/config.yaml",
      },
      { sessionId: "session-1" },
    );

    expect(configRead).toMatchObject({
      success: true,
      data: {
        path: join(harness.agentHome, "config.yaml"),
        type: "file",
        content: "model: gpt-5\n",
        truncated: false,
      },
    });

    const blockedRead = await harness.readHandler(
      {
        path: "~/.agent-policy/policy.yaml",
      },
      { sessionId: "session-1" },
    );

    expect(blockedRead).toMatchObject({
      success: false,
      error: `Read blocked: ${join(harness.homeDir, ".agent-policy")} is protected by the runtime.`,
    });

    const blockedConfigWrite = await harness.writeHandler(
      {
        path: "~/.agent/config.yaml",
        content: "model: should-stay-blocked\n",
      },
      { sessionId: "session-1" },
    );

    expect(blockedConfigWrite).toMatchObject({
      success: false,
      error: `Write blocked: ${join(harness.agentHome, "config.yaml")} is protected by the runtime.`,
    });
  });

  test("blocks access to the runtime SQLite database", async () => {
    const harness = await createHarness();
    await Bun.write(join(harness.agentHome, "agent.db"), "sqlite payload");

    const blockedRead = await harness.readHandler(
      {
        path: "~/.agent/agent.db",
      },
      { sessionId: "session-1" },
    );

    expect(blockedRead).toMatchObject({
      success: false,
      error: `Read blocked: ${join(harness.agentHome, "agent.db")} is protected by the runtime.`,
    });

    const blockedWrite = await harness.writeHandler(
      {
        path: "~/.agent/agent.db",
        content: "corrupt db",
      },
      { sessionId: "session-1" },
    );

    expect(blockedWrite).toMatchObject({
      success: false,
      error: `Write blocked: ${join(harness.agentHome, "agent.db")} is protected by the runtime.`,
    });
  });

  test("surfaces missing-path errors", async () => {
    const harness = await createHarness();

    const missingRead = await harness.readHandler(
      {
        path: "missing.txt",
      },
      { sessionId: "session-1" },
    );

    expect(missingRead).toEqual({
      success: false,
      error: "Path not found: missing.txt",
    });
  });
});

async function createHarness() {
  const rootDir = await mkdtemp(join(tmpdir(), "agent-file-test-"));
  tempDirs.push(rootDir);

  const homeDir = join(rootDir, "home");
  const agentHome = join(homeDir, ".agent");
  const workspaceDir = join(rootDir, "workspace");

  await mkdir(agentHome, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });

  return {
    homeDir,
    agentHome,
    workspaceDir,
    readHandler: createFileReadHandler({
      agentHome,
      workspaceDir,
      homeDir,
    }),
    writeHandler: createFileWriteHandler({
      agentHome,
      workspaceDir,
      homeDir,
    }),
  };
}
