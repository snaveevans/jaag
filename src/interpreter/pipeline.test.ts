import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolSpecRegistry } from "../specs/registry.ts";
import { buildMockBearerToolSpec, buildMockOAuthToolSpec } from "../test/tool-spec-fixtures.ts";
import { ToolSpecInterpreter } from "./pipeline.ts";

const tempDirs: string[] = [];
const servers: Bun.Server<unknown>[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    servers.pop()?.stop(true);
  }

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("ToolSpecInterpreter", () => {
  test("retries 429 responses and maps a successful bearer-token response", async () => {
    let itemAttempts = 0;
    const sleeps: number[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        itemAttempts += 1;
        expect(request.headers.get("Authorization")).toBe("Bearer secret-token");
        if (itemAttempts === 1) {
          return new Response(JSON.stringify({ message: "Slow down" }), {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": "0",
            },
          });
        }

        return new Response(JSON.stringify([{ id: 1, name: "alpha", ignored: true }]), {
          headers: {
            "Content-Type": "application/json",
            Link: '<http://127.0.0.1/next>; rel="next"',
          },
        });
      },
    });
    servers.push(server);

    const rootDir = await mkdtemp(join(tmpdir(), "agent-interpreter-bearer-"));
    tempDirs.push(rootDir);

    const registry = new ToolSpecRegistry({ agentHome: join(rootDir, ".agent") });
    registry.registerUntrustedSpec(buildMockBearerToolSpec(`http://127.0.0.1:${server.port}`));

    const interpreter = new ToolSpecInterpreter({
      registry,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      auth: {
        env: {
          MOCK_API_TOKEN: "secret-token",
        },
        memory: {
          async get() {
            return null;
          },
          async set() {
            return;
          },
        },
      },
    });

    const result = await interpreter.executeOperation("mockapi.items.list", { owner: "octocat" }, { sessionId: "session-1" });

    expect(result).toMatchObject({
      success: true,
      data: {
        attempts: 2,
        response: [{ id: 1, name: "alpha" }],
        pagination: {
          hasMore: true,
          nextPageUrl: "http://127.0.0.1/next",
        },
      },
    });
    expect(sleeps).toEqual([0]);
  });

  test("refreshes oauth tokens after a 401 and retries once", async () => {
    let profileAttempts = 0;
    let tokenRequests = 0;
    const storage = new Map<string, string>();
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/oauth/token") {
          tokenRequests += 1;
          return Response.json({
            access_token: "fresh-token",
            refresh_token: "refresh-456",
            expires_in: 3600,
            token_type: "Bearer",
          });
        }

        if (pathname === "/profile") {
          profileAttempts += 1;
          const authHeader = request.headers.get("Authorization");
          if (authHeader === "Bearer stale-token") {
            return Response.json({ message: "expired" }, { status: 401 });
          }

          expect(authHeader).toBe("Bearer fresh-token");
          return Response.json({ id: "user-1", name: "Taylor", ignored: true });
        }

        return new Response("missing", { status: 404 });
      },
    });
    servers.push(server);

    const rootDir = await mkdtemp(join(tmpdir(), "agent-interpreter-oauth-"));
    tempDirs.push(rootDir);

    const registry = new ToolSpecRegistry({ agentHome: join(rootDir, ".agent") });
    const spec = buildMockOAuthToolSpec(`http://127.0.0.1:${server.port}`);
    registry.registerUntrustedSpec(spec);
    storage.set(`${spec.tool}:oauth:${spec.tool}:tokens`, JSON.stringify({
      access_token: "stale-token",
      refresh_token: "refresh-123",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    }));

    const interpreter = new ToolSpecInterpreter({
      registry,
      auth: {
        env: {
          MOCK_CLIENT_ID: "client-id",
          MOCK_CLIENT_SECRET: "client-secret",
        },
        memory: {
          async get(domain, key) {
            return storage.get(`${domain}:${key}`) ?? null;
          },
          async set(domain, key, value) {
            storage.set(`${domain}:${key}`, value);
          },
        },
      },
    });

    const result = await interpreter.executeOperation("oauthmock.profile.get", {}, { sessionId: "session-2" });

    expect(result).toMatchObject({
      success: true,
      data: {
        attempts: 2,
        response: {
          id: "user-1",
          name: "Taylor",
        },
      },
    });
    expect(profileAttempts).toBe(2);
    expect(tokenRequests).toBe(1);
    expect(storage.get(`${spec.tool}:oauth:${spec.tool}:tokens`)).toContain("fresh-token");
  });
});
