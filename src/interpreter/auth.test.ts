import { afterEach, describe, expect, test } from "bun:test";
import { buildMockOAuthToolSpec } from "../test/tool-spec-fixtures.ts";
import { getOAuthMemoryKey, resolveAuthBinding, type StoredOAuthToken } from "./auth.ts";

const servers: Bun.Server<unknown>[] = [];

afterEach(() => {
  while (servers.length > 0) {
    servers.pop()?.stop(true);
  }
});

describe("auth middleware", () => {
  test("refreshes expired oauth2 tokens and stores the replacement", async () => {
    const writes: Array<{ domain: string | null; key: string; value: string }> = [];
    const storage = new Map<string, string>();
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        if (new URL(request.url).pathname === "/oauth/token") {
          const body = await request.formData();
          expect(body.get("grant_type")).toBe("refresh_token");
          expect(body.get("refresh_token")).toBe("refresh-123");

          return Response.json({
            access_token: "fresh-token",
            refresh_token: "refresh-456",
            expires_in: 3600,
            token_type: "Bearer",
          });
        }

        return new Response("missing", { status: 404 });
      },
    });
    servers.push(server);

    const spec = buildMockOAuthToolSpec(`http://127.0.0.1:${server.port}`);
    storage.set(
      `${spec.tool}:${getOAuthMemoryKey(spec.tool, "tokens")}`,
      JSON.stringify({
        access_token: "expired-token",
        refresh_token: "refresh-123",
        expires_at: "2020-01-01T00:00:00.000Z",
      } satisfies StoredOAuthToken),
    );

    const binding = await resolveAuthBinding(spec, {
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
          writes.push({ domain, key, value });
        },
      },
    }, { sessionId: "session-auth" });

    expect(binding.headers.Authorization).toBe("Bearer fresh-token");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      domain: "oauthmock",
      key: "oauth:oauthmock:tokens",
    });
  });

  test("returns an actionable error when authorization_code needs user authorization", async () => {
    const spec = buildMockOAuthToolSpec("https://example.test");

    await expect(resolveAuthBinding(spec, {
      env: {
        MOCK_CLIENT_ID: "client-id",
        MOCK_CLIENT_SECRET: "client-secret",
      },
      memory: {
        async get() {
          return null;
        },
        async set() {
          throw new Error("should not write");
        },
      },
    }, { sessionId: "session-auth" })).rejects.toThrow(
      "interactive authorization flow is not implemented in this slice",
    );
  });

  test("exchanges a first-time authorization code and stores the resulting token", async () => {
    const writes: Array<{ domain: string | null; key: string; value: string }> = [];
    const storage = new Map<string, string>();
    let authorizationPrompt = "";
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        if (new URL(request.url).pathname === "/oauth/token") {
          const body = await request.formData();
          expect(body.get("grant_type")).toBe("authorization_code");
          expect(body.get("code")).toBe("code-123");
          expect(body.get("client_id")).toBe("client-id");
          expect(body.get("client_secret")).toBe("client-secret");
          expect(body.get("scope")).toBe("read:data");

          return Response.json({
            access_token: "fresh-token",
            refresh_token: "refresh-456",
            expires_in: 3600,
            token_type: "Bearer",
          });
        }

        return new Response("missing", { status: 404 });
      },
    });
    servers.push(server);

    const spec = buildMockOAuthToolSpec(`http://127.0.0.1:${server.port}`);

    const binding = await resolveAuthBinding(spec, {
      env: {
        MOCK_CLIENT_ID: "client-id",
        MOCK_CLIENT_SECRET: "client-secret",
      },
      memory: {
        async get() {
          return null;
        },
        async set(domain, key, value) {
          storage.set(`${domain}:${key}`, value);
          writes.push({ domain, key, value });
        },
      },
      askForAuthorizationCode: async (message) => {
        authorizationPrompt = message;
        return "code-123";
      },
    }, { sessionId: "session-auth" });

    expect(authorizationPrompt).toContain("Authorization is required for OAuth Mock.");
    expect(spec.auth.type).toBe("oauth2");
    if (spec.auth.type !== "oauth2") {
      throw new Error("expected oauth2 auth");
    }
    expect(authorizationPrompt).toContain(`Open: ${spec.auth.authorization_url}`);
    expect(binding.headers.Authorization).toBe("Bearer fresh-token");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      domain: "oauthmock",
      key: "oauth:oauthmock:tokens",
    });
    expect(storage.get(`${spec.tool}:${getOAuthMemoryKey(spec.tool, "tokens")}`)).toContain("fresh-token");
  });
});
