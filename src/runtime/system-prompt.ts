import { RAW_PRIMITIVE_DECLARATIONS } from "../primitives/types.ts";
import type { TriggeredScheduleContext } from "../scheduler/types.ts";
import type { ToolManifest } from "../specs/types.ts";
import { SYSTEM_TOOL_DECLARATIONS } from "../system-tools/handler.ts";

export interface SystemPromptOptions {
  now?: Date;
  timeZone?: string;
  toolManifests?: ToolManifest[];
  policySummary?: string;
  triggeredSchedule?: TriggeredScheduleContext;
  continuityBlock?: string | null;
}

export function buildBaseSystemPrompt(options: SystemPromptOptions = {}): string {
  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? "UTC";
  const primitiveList = RAW_PRIMITIVE_DECLARATIONS.map(
    (primitive) => `- ${primitive.name}: ${primitive.description}`,
  ).join("\n");
  const systemToolList = SYSTEM_TOOL_DECLARATIONS.map(
    (tool) => `- ${tool.name}: ${tool.description}`,
  ).join("\n");
  const toolManifestList = (options.toolManifests ?? []).length > 0
    ? (options.toolManifests ?? [])
      .map((tool) => `- ${tool.tool} [${tool.trustTier}]: ${tool.operations.join(", ")}`)
      .join("\n")
    : "- No installed tool specs yet.";
  const triggeredSchedule = options.triggeredSchedule
    ? [
      "Triggered schedule context:",
      `- trigger_source: schedule`,
      `- schedule_id: ${options.triggeredSchedule.schedule_id}`,
      `- workflow: ${options.triggeredSchedule.workflow}`,
      `- group: ${options.triggeredSchedule.group ?? "(none)"}`,
      `- instruction: ${options.triggeredSchedule.instruction}`,
      "Treat the stored instruction as the task to execute now.",
    ].join("\n")
    : null;

  return [
    "You are the first working slice of a local agent daemon.",
    "Respond helpfully, keep tool use deliberate, and use the declared functions when they are the best way to complete work.",
    "If a primitive call fails, incorporate the tool result and continue the conversation.",
    "Installed tool specs are exposed as callable functions. Use spec.list for a manifest and spec.get when you need operation details, side effects, or error guidance.",
    "Use memory for persistent notes and preferences. `set`, `get`, and `delete` use domain + key; `search` uses full-text matching; `list` can inspect a domain or the full store.",
    "Use file_read for both files and directories. Relative paths resolve against the current workspace. Large files are truncated at 1MB and protected runtime paths are blocked.",
    "Use file_write to create or replace full file contents. Relative paths resolve against the current workspace, parent directories are created automatically, and protected runtime paths are blocked.",
    "When you ask for approval through interact(mode: approve), instruct the operator to reply exactly yes or no. Treat any other reply as ambiguous, not as a denial.",
    options.policySummary ? `Policy summary: ${options.policySummary}` : null,
    `Current time: ${now.toISOString()}`,
    `Runtime timezone: ${timeZone}`,
    options.continuityBlock,
    triggeredSchedule,
    "Available primitive functions:",
    primitiveList,
    "Available system tools:",
    systemToolList,
    "Installed tool manifests:",
    toolManifestList,
  ].filter(Boolean).join("\n\n");
}
