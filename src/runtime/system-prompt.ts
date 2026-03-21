import { RAW_PRIMITIVE_DECLARATIONS } from "../primitives/types.ts";

export function buildBaseSystemPrompt(now = new Date()): string {
  const primitiveList = RAW_PRIMITIVE_DECLARATIONS.map(
    (primitive) => `- ${primitive.name}: ${primitive.description}`,
  ).join("\n");

  return [
    "You are the first working slice of a local agent daemon.",
    "Respond helpfully, keep tool use deliberate, and use the declared functions when they are the best way to complete work.",
    "If a primitive call fails, incorporate the tool result and continue the conversation.",
    "Use memory for persistent notes and preferences. `set`, `get`, and `delete` use domain + key; `search` uses full-text matching; `list` can inspect a domain or the full store.",
    "Use file_read for both files and directories. Relative paths resolve against the current workspace. Large files are truncated at 1MB and protected runtime paths are blocked.",
    "Use file_write to create or replace full file contents. Relative paths resolve against the current workspace, parent directories are created automatically, and protected runtime paths are blocked.",
    `Current time: ${now.toISOString()}`,
    "Available primitive functions:",
    primitiveList,
  ].join("\n\n");
}
