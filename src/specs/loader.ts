import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { validateToolSpec } from "./validator.ts";
import type { ToolSpec } from "./types.ts";

export function parseToolSpecInput(input: unknown): ToolSpec {
  const parsedInput = typeof input === "string" ? parseJsonText(input, "inline spec") : input;
  const validation = validateToolSpec(parsedInput);

  if (!validation.valid || !validation.spec) {
    throw new Error(validation.errors.join(" "));
  }

  return validation.spec;
}

export function loadToolSpecFile(filePath: string): ToolSpec {
  const rawText = readFileSync(filePath, "utf8");
  const parsed = parseJsonText(rawText, basename(filePath));
  const validation = validateToolSpec(parsed);

  if (!validation.valid || !validation.spec) {
    throw new Error(`Invalid tool spec ${filePath}: ${validation.errors.join(" ")}`);
  }

  return validation.spec;
}

function parseJsonText(rawText: string, source: string): unknown {
  try {
    return JSON.parse(rawText) as unknown;
  } catch (error) {
    throw new Error(`Failed to parse ${source}: ${toErrorMessage(error)}`);
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
