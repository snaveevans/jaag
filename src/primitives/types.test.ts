import { describe, expect, test } from "bun:test";
import { RAW_PRIMITIVE_DECLARATIONS } from "./types.ts";

describe("primitive tool schemas", () => {
  test("schedule declaration exposes the schedule handler contract", () => {
    const parameters = getPrimitiveParameters("schedule");

    expect(parameters.type).toBe("object");
    expect(parameters.required).toEqual(["operation"]);
    expect(parameters.additionalProperties).toBe(false);

    const properties = getSchemaProperties(parameters);
    expect(properties.operation).toMatchObject({
      type: "string",
      enum: ["create", "get", "list", "update", "delete"],
    });
    expect(properties.schedule_id).toMatchObject({ type: "string" });
    expect(properties.id).toMatchObject({ type: "string" });
    expect(properties.workflow).toMatchObject({ type: "string" });
    expect(properties.group).toMatchObject({ type: ["string", "null"] });
    expect(properties.instruction).toMatchObject({ type: "string" });
    expect(properties.status).toMatchObject({
      type: "string",
      enum: ["active", "paused", "completed", "failed"],
    });
    expect(properties.trigger_type).toMatchObject({
      type: "string",
      enum: ["cron", "once", "event"],
    });

    const trigger = getSchemaProperty(parameters, "trigger");
    expect(trigger).toMatchObject({
      type: "object",
      required: ["type"],
      additionalProperties: false,
    });
    expect(getSchemaProperties(trigger)).toMatchObject({
      type: {
        type: "string",
        enum: ["cron", "once"],
      },
      cron: { type: "string" },
      expression: { type: "string" },
      at: { type: "string" },
      description: { type: "string" },
    });

    const context = getSchemaProperty(parameters, "context");
    expect(context).toMatchObject({
      type: "object",
      additionalProperties: true,
    });
    expect(getSchemaProperties(context)).toMatchObject({
      instruction: { type: "string" },
    });

    const filters = getSchemaProperty(parameters, "filters");
    expect(filters).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
    expect(getSchemaProperties(filters)).toMatchObject({
      workflow: { type: "string" },
      group: { type: "string" },
      status: {
        type: "string",
        enum: ["active", "paused", "completed", "failed"],
      },
      trigger_type: {
        type: "string",
        enum: ["cron", "once", "event"],
      },
    });
  });

  test("interact declaration exposes an explicit request shape", () => {
    const parameters = getPrimitiveParameters("interact");

    expect(parameters).toMatchObject({
      type: "object",
      required: ["mode", "message"],
      additionalProperties: false,
    });

    expect(getSchemaProperties(parameters)).toMatchObject({
      mode: {
        type: "string",
        enum: ["notify", "ask", "approve"],
      },
      message: { type: "string" },
      tool: { type: "string" },
      operation: { type: "string" },
    });
  });

  test("interact declaration tells the model to require strict yes or no for approvals", () => {
    const declaration = RAW_PRIMITIVE_DECLARATIONS.find((tool) => tool.name === "interact");
    expect(declaration?.description).toContain("reply exactly yes or no");
  });
});

function getPrimitiveParameters(name: string): Record<string, unknown> {
  const declaration = RAW_PRIMITIVE_DECLARATIONS.find((tool) => tool.name === name);
  expect(declaration).toBeDefined();

  return declaration?.parameters as Record<string, unknown>;
}

function getSchemaProperty(schema: Record<string, unknown>, name: string): Record<string, unknown> {
  const property = getSchemaProperties(schema)[name];
  expect(property).toBeDefined();

  return property as Record<string, unknown>;
}

function getSchemaProperties(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = schema.properties;

  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    throw new Error("Schema is missing an object-shaped properties map.");
  }

  return properties as Record<string, unknown>;
}
