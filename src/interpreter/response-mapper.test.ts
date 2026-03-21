import { describe, expect, test } from "bun:test";
import { buildMockBearerToolSpec } from "../test/tool-spec-fixtures.ts";
import { mapOperationResponse } from "./response-mapper.ts";

describe("response mapper", () => {
  test("filters root-array responses and extracts pagination", () => {
    const spec = buildMockBearerToolSpec("https://example.test");
    const operation = spec.resources.items.operations.list;
    const response = new Response(JSON.stringify([
      { id: 1, name: "alpha", ignored: true },
      { id: 2, name: "beta", ignored: true },
    ]), {
      headers: {
        Link: '<https://example.test/items/octocat?page=2>; rel="next"',
      },
    });

    const mapped = mapOperationResponse(operation, response, [
      { id: 1, name: "alpha", ignored: true },
      { id: 2, name: "beta", ignored: true },
    ]);

    expect(mapped.data).toEqual([
      { id: 1, name: "alpha" },
      { id: 2, name: "beta" },
    ]);
    expect(mapped.pagination).toEqual({
      hasMore: true,
      nextPageUrl: "https://example.test/items/octocat?page=2",
    });
  });

  test("does not claim hasMore for offset pagination when the response lacks page position context", () => {
    const spec = buildMockBearerToolSpec("https://example.test");
    const operation = {
      ...spec.resources.items.operations.list,
      pagination: {
        type: "offset" as const,
        total_field: "total_count",
      },
    };

    const mapped = mapOperationResponse(
      operation,
      Response.json({ total_count: 25, items: [{ id: 1, name: "alpha" }] }),
      { total_count: 25, items: [{ id: 1, name: "alpha" }] },
    );

    expect(mapped.pagination).toBeUndefined();
  });

  test("reports hasMore false for the last offset page when offset and limit are known", () => {
    const spec = buildMockBearerToolSpec("https://example.test");
    const operation = {
      ...spec.resources.items.operations.list,
      params: {
        ...spec.resources.items.operations.list.params,
        offset: {
          in: "query" as const,
          type: "integer" as const,
          required: false,
          description: "Offset into the full result set.",
        },
        limit: {
          in: "query" as const,
          type: "integer" as const,
          required: false,
          description: "Requested page size.",
        },
      },
      pagination: {
        type: "offset" as const,
        offset_param: "offset",
        limit_param: "limit",
        total_field: "total_count",
      },
    };

    const mapped = mapOperationResponse(
      operation,
      Response.json({ total_count: 25, items: [{ id: 21, name: "omega" }] }),
      { total_count: 25, items: [{ id: 21, name: "omega" }] },
      { offset: 20, limit: 10 },
    );

    expect(mapped.pagination).toEqual({ hasMore: false });
  });
});
