import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPolicy, PolicyError, resolvePolicyPath } from "./loader.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("policy loader", () => {
  test("installs the default policy when the file is missing", async () => {
    const homeDir = await createHomeDir();

    const policy = loadPolicy({ homeDir });

    expect(policy.installedDefault).toBe(true);
    expect(policy.rules).toHaveLength(10);
    expect(policy.summary).toContain("File writes are limited");
    expect(await Bun.file(resolvePolicyPath({ homeDir })).exists()).toBe(true);
  });

  test("fails clearly when the policy file is malformed", async () => {
    const homeDir = await createHomeDir();
    await mkdir(join(homeDir, ".agent-policy"), { recursive: true });
    await writeFile(resolvePolicyPath({ homeDir }), "rules: [", "utf8");

    expect(() => loadPolicy({ homeDir })).toThrow(PolicyError);
    expect(() => loadPolicy({ homeDir })).toThrow("Failed to parse policy");
  });

  test("fails clearly when a rule uses an unsupported primitive", async () => {
    const homeDir = await createHomeDir();
    await mkdir(join(homeDir, ".agent-policy"), { recursive: true });
    await writeFile(resolvePolicyPath({ homeDir }), `rules:\n  - primitive: interact\n    action: allow\n`, "utf8");

    expect(() => loadPolicy({ homeDir })).toThrow("primitive must be one of");
  });
});

async function createHomeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-policy-loader-test-"));
  tempDirs.push(dir);
  return dir;
}
