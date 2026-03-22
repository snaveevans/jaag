import { describe, expect, test } from "bun:test";
import { GITHUB_TRUSTED_SPEC } from "../specs/github-spec.ts";
import { buildRawHttpRequest, buildSpecHttpRequest, validateAndNormalizeOperationInput } from "./request-builder.ts";

describe("request builder", () => {
  test("builds a spec-backed request with defaults, auth, and JSON body", async () => {
    const operation = GITHUB_TRUSTED_SPEC.resources.issues.operations.create;
    const normalized = validateAndNormalizeOperationInput(operation, {
      owner: "octocat",
      repo: "hello-world",
      title: "Fix flaky test",
      body: "Investigate recent CI failures.",
      labels: ["bug", "ci"],
    });

    const request = buildSpecHttpRequest(GITHUB_TRUSTED_SPEC, operation, normalized, {
      headers: {
        Authorization: "Bearer test-token",
      },
      query: {},
    });

    expect(request.url).toBe("https://api.github.com/repos/octocat/hello-world/issues");
    expect(request.init.method).toBe("POST");

    const headers = request.init.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer test-token");
    expect(headers.get("Accept")).toBe("application/vnd.github+json");
    expect(headers.get("content-type")).toBe("application/json");

    const body = request.init.body as string;
    expect(JSON.parse(body)).toEqual({
      title: "Fix flaky test",
      body: "Investigate recent CI failures.",
      labels: ["bug", "ci"],
    });
  });

  test("applies query defaults for list operations", () => {
    const operation = GITHUB_TRUSTED_SPEC.resources.issues.operations.list;
    const normalized = validateAndNormalizeOperationInput(operation, {
      owner: "octocat",
      repo: "hello-world",
    });

    const request = buildSpecHttpRequest(GITHUB_TRUSTED_SPEC, operation, normalized, {
      headers: {},
      query: {},
    });

    expect(request.url).toBe("https://api.github.com/repos/octocat/hello-world/issues?state=open&per_page=30");
  });

  test("validates raw http urls and header values with explicit errors", () => {
    expect(() => buildRawHttpRequest({
      url: "/relative/path",
      method: "GET",
    })).toThrow("Invalid url: expected an absolute http:// or https:// URL.");

    expect(() => buildRawHttpRequest({
      url: "ftp://example.com/resource",
      method: "GET",
    })).toThrow("Invalid url: only http and https URLs are supported.");

    expect(() => buildRawHttpRequest({
      url: "https://example.com/resource",
      method: "GET",
      headers: {
        Authorization: 123,
      },
    })).toThrow("Invalid header Authorization: expected a string value.");

    expect(() => buildRawHttpRequest({
      url: "https://example.com/resource",
      method: "GET",
      extra: 123,
    })).toThrow("Unknown parameter: extra.");
  });
});
