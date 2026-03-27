import type { Database } from "bun:sqlite";
import { Logger } from "../observability/logger.ts";
import { buildBaseSystemPrompt, type SystemPromptOptions } from "../runtime/system-prompt.ts";
import type { ToolManifest } from "../specs/types.ts";
import type { BuildSystemPromptInput } from "../session/manager.ts";
import { buildContinuityBlock } from "./block.ts";

export interface ContinuityAwareSystemPromptBuilderOptions {
  getDatabase: () => Database;
  timeZone?: string;
  getPolicySummary?: () => string | undefined;
  getToolManifests?: () => ToolManifest[];
  logger?: Logger;
}

export function createContinuityAwareSystemPromptBuilder(
  options: ContinuityAwareSystemPromptBuilderOptions,
): (input: BuildSystemPromptInput) => Promise<string> {
  const logger = (options.logger ?? new Logger()).child({ component: "continuity.prompt" });

  return async (input) => {
    const baseOptions: SystemPromptOptions = {
      now: input.now,
      timeZone: options.timeZone,
      policySummary: options.getPolicySummary?.(),
      toolManifests: options.getToolManifests?.(),
      triggeredSchedule: input.triggeredSchedule,
      continuityBlock: input.triggerSource === "user"
        ? safeBuildContinuityBlock(options.getDatabase, logger)
        : null,
    };

    return buildBaseSystemPrompt(baseOptions);
  };
}

function safeBuildContinuityBlock(getDatabase: () => Database, logger: Logger): string | null {
  try {
    return buildContinuityBlock(getDatabase());
  } catch (error) {
    logger.warn("continuity.block.unavailable", {
      error,
    });
    return null;
  }
}
