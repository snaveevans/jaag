import { describe, expect, test } from "bun:test";
import { GITHUB_TRUSTED_SPEC } from "../specs/github-spec.ts";
import { handleHttpError } from "./error-handler.ts";

describe("error handler", () => {
  test("combines generic, spec-specific, and API-provided error details", () => {
    const result = handleHttpError({
      spec: GITHUB_TRUSTED_SPEC,
      operation: GITHUB_TRUSTED_SPEC.resources.issues.operations.get,
      operationName: "github.issues.get",
      status: 404,
      responseBody: { message: "Not Found" },
      attempts: 1,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Requested resource was not found.");
    expect(result.error).toContain("The issue was not found.");
    expect(result.error).toContain("API message: Not Found");
    expect(result.error).toContain("Recovery: Verify the owner, repo, and issue_number.");
  });
});
