import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig } from "./loader.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("loadConfig", () => {
  test("loads valid config and resolves API key", async () => {
    const homeDir = await createHomeDir();
    await writeAgentConfig(
      homeDir,
      `llm:
  provider: openai
  model: gpt-4o-mini
  context_limit: 128000
  max_output_tokens: 4096
  temperature: 0
  api_key_env: OPENAI_API_KEY
communication:
  type: websocket
  port: 8765
`,
    );

    const config = await loadConfig({
      homeDir,
      env: { OPENAI_API_KEY: "test-key" },
    });

    expect(config.agentHome).toEndWith(".agent");
    expect(config.llm.apiKey).toBe("test-key");
    expect(config.llm.baseUrl).toBe("https://api.openai.com/v1");
    expect(config.communication.port).toBe(8765);
  });

  test("fails with instructional error when config is missing", async () => {
    const homeDir = await createHomeDir();

    await expect(
      loadConfig({
        homeDir,
        env: { OPENAI_API_KEY: "test-key" },
      }),
    ).rejects.toThrow(ConfigError);

    await expect(
      loadConfig({
        homeDir,
        env: { OPENAI_API_KEY: "test-key" },
      }),
    ).rejects.toThrow("Create ~/.agent/config.yaml");
  });

  test("fails clearly when API key env var is missing", async () => {
    const homeDir = await createHomeDir();
    await writeAgentConfig(
      homeDir,
      `llm:
  provider: openai
  model: gpt-4o-mini
  context_limit: 128000
  max_output_tokens: 4096
  temperature: 0
  api_key_env: OPENAI_API_KEY
communication:
  type: websocket
  port: 8765
`,
    );

    await expect(
      loadConfig({
        homeDir,
        env: {},
      }),
    ).rejects.toThrow("Missing API key environment variable OPENAI_API_KEY");
  });
});

async function createHomeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-config-test-"));
  tempDirs.push(dir);
  return dir;
}

async function writeAgentConfig(homeDir: string, content: string): Promise<void> {
  const agentHome = join(homeDir, ".agent");
  await Bun.write(join(agentHome, "config.yaml"), content);
}
