import { describe, expect, test } from "bun:test";
import { GITHUB_TRUSTED_SPEC } from "./github-spec.ts";
import { validateToolSpec } from "./validator.ts";
import { buildInvalidToolSpec, buildMockBearerToolSpec } from "../test/tool-spec-fixtures.ts";

describe("validateToolSpec", () => {
  test("accepts the seeded GitHub spec", () => {
    const result = validateToolSpec(GITHUB_TRUSTED_SPEC);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("reports structural errors with actionable paths", () => {
    const result = validateToolSpec(buildInvalidToolSpec());

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("tool must be a lowercase identifier.");
    expect(result.errors).toContain("auth.env_var must be a non-empty string.");
    expect(result.errors).toContain(
      "resources.broken.operations.get.path references {id} but resources.broken.operations.get.params.id is missing or not a path param.",
    );
  });

  test("rejects operation primitives the Slice 03 runtime cannot execute", () => {
    const spec = buildMockBearerToolSpec("https://example.test");
    spec.resources.items.operations.list.primitive = "execute";

    const result = validateToolSpec(spec);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "resources.items.operations.list.primitive must be http in Slice 03; received execute.",
    );
  });
});
