import type { Database } from "bun:sqlite";
import { buildBaseSystemPrompt, type SystemPromptOptions } from "../runtime/system-prompt.ts";
import type { ToolManifest } from "../specs/types.ts";
import type { BuildSystemPromptInput } from "../session/manager.ts";
import { buildContinuityBlock } from "./block.ts";

export interface ContinuityAwareSystemPromptBuilderOptions {
  getDatabase: () => Database;
  timeZone?: string;
  getPolicySummary?: () => string | undefined;
  getToolManifests?: () => ToolManifest[];
}

export function createContinuityAwareSystemPromptBuilder(
  options: ContinuityAwareSystemPromptBuilderOptions,
): (input: BuildSystemPromptInput) => Promise<string> {
  return async (input) => {
    const baseOptions: SystemPromptOptions = {
      now: input.now,
      timeZone: options.timeZone,
      policySummary: options.getPolicySummary?.(),
      toolManifests: options.getToolManifests?.(),
      triggeredSchedule: input.triggeredSchedule,
      continuityBlock: input.triggerSource === "user"
        ? buildContinuityBlock(options.getDatabase())
        : null,
    };

    return buildBaseSystemPrompt(baseOptions);
  };
}
