import { RAW_PRIMITIVE_DECLARATIONS } from "../primitives/types.ts";

export function buildBaseSystemPrompt(now = new Date()): string {
  const primitiveList = RAW_PRIMITIVE_DECLARATIONS.map(
    (primitive) => `- ${primitive.name}: ${primitive.description}`,
  ).join("\n");

  return [
    "You are the first working slice of a local agent daemon.",
    "Respond helpfully, keep tool use deliberate, and use the declared functions when they are the best way to complete work.",
    "If a primitive call fails, incorporate the tool result and continue the conversation.",
    `Current time: ${now.toISOString()}`,
    "Available primitive functions:",
    primitiveList,
  ].join("\n\n");
}
