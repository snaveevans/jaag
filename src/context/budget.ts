import type { InternalMessage, ToolDeclaration } from "../llm/types.ts";

export const APPROXIMATE_CHARS_PER_TOKEN = 4;
export const COMPACTION_TRIGGER_UTILIZATION = 0.75;
export const HARD_CEILING_UTILIZATION = 0.9;
export const DEFAULT_COMPACTION_KEEP_WINDOW = 8;

const COMPACTION_REQUEST_SYSTEM_PROMPT = [
  "You are summarizing older conversation history for runtime context compaction.",
  "Preserve only the durable context that still matters:",
  "- current task state that must survive",
  "- key decisions already made",
  "- facts learned about the user, repo, or environment",
  "- pending actions, risks, or commitments",
  "The most recent messages remain available separately, so avoid repeating recent details unless they are essential for continuity.",
  "Return only the summary text.",
].join(" ");

const COMPACTION_SUMMARY_PREFIX = "Runtime summary of earlier conversation:\n";

export interface ContextBudgetSnapshot {
  contextLimit: number;
  messageTokens: number;
  toolDeclarationTokens: number;
  usedTokens: number;
  utilization: number;
  shouldCompact: boolean;
  exceedsHardCeiling: boolean;
}

export interface HistoryCompactionPlan {
  keepStartIndex: number;
  compactedMessages: InternalMessage[];
  keepMessages: InternalMessage[];
}

export function estimateTokenCount(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  return Math.ceil(text.length / APPROXIMATE_CHARS_PER_TOKEN);
}

export function estimateMessageTokens(message: InternalMessage): number {
  return estimateStructuredTokens(message);
}

export function estimateMessagesTokens(messages: InternalMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

export function estimateToolDeclarationsTokens(tools: ToolDeclaration[]): number {
  return estimateStructuredTokens(tools);
}

export function createContextBudgetSnapshot(input: {
  contextLimit: number;
  messageTokens: number;
  toolDeclarationTokens: number;
}): ContextBudgetSnapshot {
  const usedTokens = input.messageTokens + input.toolDeclarationTokens;
  const utilization = input.contextLimit > 0 ? usedTokens / input.contextLimit : 0;

  return {
    contextLimit: input.contextLimit,
    messageTokens: input.messageTokens,
    toolDeclarationTokens: input.toolDeclarationTokens,
    usedTokens,
    utilization,
    shouldCompact: utilization >= COMPACTION_TRIGGER_UTILIZATION,
    exceedsHardCeiling: utilization > HARD_CEILING_UTILIZATION,
  };
}

export function planHistoryCompaction(
  messages: InternalMessage[],
  keepWindow = DEFAULT_COMPACTION_KEEP_WINDOW,
): HistoryCompactionPlan | null {
  if (messages.length <= 2) {
    return null;
  }

  const keepStartIndex = selectCompactionKeepStartIndex(messages, keepWindow);
  if (keepStartIndex <= 1 || keepStartIndex >= messages.length) {
    return null;
  }

  const compactedMessages = messages.slice(1, keepStartIndex);
  if (compactedMessages.length === 0) {
    return null;
  }

  return {
    keepStartIndex,
    compactedMessages,
    keepMessages: messages.slice(keepStartIndex),
  };
}

export function selectCompactionKeepStartIndex(
  messages: InternalMessage[],
  keepWindow = DEFAULT_COMPACTION_KEEP_WINDOW,
): number {
  const normalizedKeepWindow = Math.max(1, Math.trunc(keepWindow));
  const lastWindowStartIndex = Math.max(1, messages.length - normalizedKeepWindow);

  let mostRecentUserMessageIndex = -1;
  for (let index = messages.length - 1; index >= 1; index -= 1) {
    if (messages[index]?.role === "user") {
      mostRecentUserMessageIndex = index;
      break;
    }
  }

  if (mostRecentUserMessageIndex === -1) {
    return lastWindowStartIndex;
  }

  return Math.min(lastWindowStartIndex, mostRecentUserMessageIndex);
}

export function buildCompactionRequestMessages(compactedMessages: InternalMessage[]): InternalMessage[] {
  return [
    {
      role: "system",
      content: COMPACTION_REQUEST_SYSTEM_PROMPT,
    },
    {
      role: "user",
      content: [
        "Summarize the following older conversation history so it can replace those messages in the active session.",
        "",
        renderCompactionHistory(compactedMessages),
      ].join("\n"),
    },
  ];
}

export function buildCompactionSummaryMessage(summary: string): string {
  const trimmedSummary = summary.trim();
  if (trimmedSummary === "") {
    return "Runtime summary of earlier conversation.";
  }

  return `${COMPACTION_SUMMARY_PREFIX}${trimmedSummary}`;
}

export function buildCompactedMessageHistory(
  messages: InternalMessage[],
  keepStartIndex: number,
  summaryMessage: string,
): InternalMessage[] {
  if (messages.length === 0) {
    return [];
  }

  const normalizedKeepStartIndex = Math.min(Math.max(1, keepStartIndex), messages.length);
  if (normalizedKeepStartIndex <= 1) {
    return [...messages];
  }

  return [
    messages[0]!,
    {
      role: "system",
      content: summaryMessage,
    },
    ...messages.slice(normalizedKeepStartIndex),
  ];
}

function estimateStructuredTokens(value: unknown): number {
  return estimateTokenCount(JSON.stringify(value));
}

function renderCompactionHistory(messages: InternalMessage[]): string {
  return messages.map((message, index) => {
    return [`Message ${index + 1}:`, renderCompactionMessage(message)].join("\n");
  }).join("\n\n");
}

function renderCompactionMessage(message: InternalMessage): string {
  const parts = [`role: ${message.role}`, `content:\n${message.content}`];

  if (message.toolCalls && message.toolCalls.length > 0) {
    parts.push(`tool_calls: ${JSON.stringify(message.toolCalls)}`);
  }

  if (message.toolResultId) {
    parts.push(`tool_result_id: ${message.toolResultId}`);
  }

  return parts.join("\n");
}
