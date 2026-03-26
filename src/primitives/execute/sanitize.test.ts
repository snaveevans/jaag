import { describe, expect, test } from "bun:test";
import { sanitizeEnv } from "./sanitize.ts";

describe("sanitizeEnv", () => {
  test("preserves only the safe allowlist and strips secrets", () => {
    const sanitized = sanitizeEnv({
      PATH: "/usr/bin:/bin",
      HOME: "/tmp/home",
      USER: "agent-user",
      TERM: "xterm-256color",
      OPENAI_API_KEY: "top-secret",
      GITHUB_TOKEN: "ghs_123",
      CUSTOM_SECRET: "keep-out",
    }, {});

    expect(sanitized).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/tmp/home",
      USER: "agent-user",
      TERM: "xterm-256color",
    });
  });

  test("forces HOME to the configured runtime home", () => {
    const sanitized = sanitizeEnv({
      PATH: "/usr/bin:/bin",
      HOME: "/tmp/ambient-home",
      USER: "agent-user",
    }, {
      HOME: "/tmp/fallback-home",
    }, "/tmp/runtime-home");

    expect(sanitized).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/tmp/runtime-home",
      USER: "agent-user",
    });
  });
});
