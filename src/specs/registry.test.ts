import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolSpecRegistry, getToolsDirectory } from "./registry.ts";
import { buildMockBearerToolSpec } from "../test/tool-spec-fixtures.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("ToolSpecRegistry", () => {
  test("seeds the trusted GitHub spec and exposes canonical/provider-safe mappings", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "agent-spec-registry-"));
    tempDirs.push(rootDir);

    const registry = new ToolSpecRegistry({
      agentHome: join(rootDir, ".agent"),
    });

    const manifests = registry.listToolManifests();
    expect(manifests).toContainEqual({
      tool: "github",
      name: "GitHub",
      description: expect.any(String),
      specVersion: "0.1",
      trustTier: "trusted",
      docsUrl: expect.any(String),
      operationCount: 3,
      operations: ["issues.create", "issues.get", "issues.list"],
    });

    const canonicalOperation = registry.getOperation("github.issues.list");
    const providerOperation = registry.getOperation("github_issues_list");

    expect(canonicalOperation?.canonicalName).toBe("github.issues.list");
    expect(canonicalOperation?.providerName).toBe("github_issues_list");
    expect(providerOperation?.canonicalName).toBe("github.issues.list");
  });

  test("registers an untrusted spec to disk and updates declarations", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "agent-spec-register-"));
    tempDirs.push(rootDir);

    const agentHome = join(rootDir, ".agent");
    const registry = new ToolSpecRegistry({ agentHome });
    const spec = buildMockBearerToolSpec("https://example.test");

    const registered = registry.registerUntrustedSpec(spec);
    const savedPath = join(getToolsDirectory(agentHome, "untrusted"), "mockapi.json");

    expect(registered.trustTier).toBe("untrusted");
    expect(existsSync(savedPath)).toBe(true);
    expect(JSON.parse(readFileSync(savedPath, "utf8"))).toMatchObject({ tool: "mockapi" });
    expect(registry.getToolDeclarations().map((tool) => tool.name)).toContain("mockapi.items.list");
  });
});
