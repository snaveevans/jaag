import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolSpecRegistry, getToolsDirectory } from "../specs/registry.ts";
import { buildInvalidToolSpec, buildMockBearerToolSpec } from "../test/tool-spec-fixtures.ts";
import { SystemToolHandler } from "./handler.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("SystemToolHandler", () => {
  test("validates, registers, lists, and gets specs", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "agent-system-tools-"));
    tempDirs.push(rootDir);

    const agentHome = join(rootDir, ".agent");
    const registry = new ToolSpecRegistry({ agentHome });
    const handler = new SystemToolHandler({ registry });

    const invalidResult = await handler.dispatch("spec.validate", { spec: buildInvalidToolSpec() }, { sessionId: "session-1" });
    expect(invalidResult).toMatchObject({
      success: true,
      data: {
        valid: false,
      },
    });

    const spec = buildMockBearerToolSpec("https://example.test");
    const registerResult = await handler.dispatch("spec.register", { spec }, { sessionId: "session-1" });
    expect(registerResult).toMatchObject({
      success: true,
      data: {
        tool: "mockapi",
        trustTier: "untrusted",
      },
    });
    expect(existsSync(join(getToolsDirectory(agentHome, "untrusted"), "mockapi.json"))).toBe(true);

    const listResult = await handler.dispatch("spec.list", { trustTier: "untrusted" }, { sessionId: "session-1" });
    expect(listResult).toMatchObject({
      success: true,
      data: {
        tools: [
          {
            tool: "mockapi",
            trustTier: "untrusted",
          },
        ],
      },
    });

    const getResult = await handler.dispatch(
      "spec.get",
      { tool: "mockapi", operation: "items.list" },
      { sessionId: "session-1" },
    );
    expect(getResult).toMatchObject({
      success: true,
      data: {
        operation: {
          canonicalName: "mockapi.items.list",
          providerName: "mockapi_items_list",
        },
      },
    });
  });

  test("does not leave a spec file behind when registration fails after validation", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "agent-system-tools-"));
    tempDirs.push(rootDir);

    const agentHome = join(rootDir, ".agent");
    const registry = new ToolSpecRegistry({ agentHome });
    const handler = new SystemToolHandler({ registry });
    const spec = buildMockBearerToolSpec("https://example.test");

    spec.resources.items.operations.list.body = {
      content_type: "application/json",
      fields: {
        owner: {
          type: "string",
          required: true,
          description: "Duplicate body field name.",
        },
      },
    };

    const registerResult = await handler.dispatch("spec.register", { spec }, { sessionId: "session-1" });

    expect(registerResult).toMatchObject({
      success: false,
      error: "Operation mockapi.items.list has duplicate param/body field name: owner",
    });
    expect(existsSync(join(getToolsDirectory(agentHome, "untrusted"), "mockapi.json"))).toBe(false);
    expect(() => new ToolSpecRegistry({ agentHome })).not.toThrow();
  });
});
