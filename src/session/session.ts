import type { InternalMessage, ToolCall } from "../llm/types.ts";
import {
  findMatchingApprovalReceipt,
  type ApprovalReceipt,
  type ApprovalReceiptCriteria,
} from "../policy/receipts.ts";

export type TriggerSource = "user" | "schedule";

export type SessionStatus =
  | "active"
  | "waiting_for_llm"
  | "waiting_for_user"
  | "completed"
  | "failed";

export interface AgentSessionOptions {
  systemPrompt: string;
  id?: string;
  triggerSource?: TriggerSource;
  createdAt?: Date;
  inactivityTimeoutMs?: number;
  maxIterations?: number;
}

export class AgentSession {
  readonly id: string;
  readonly triggerSource: TriggerSource;
  status: SessionStatus;
  readonly messages: InternalMessage[];
  readonly approvalReceipts: ApprovalReceipt[];
  readonly createdAt: Date;
  lastActivityAt: Date;
  iterationCount: number;
  readonly inactivityTimeoutMs: number;
  readonly maxIterations: number;

  constructor(options: AgentSessionOptions) {
    const createdAt = options.createdAt ?? new Date();

    this.id = options.id ?? crypto.randomUUID();
    this.triggerSource = options.triggerSource ?? "user";
    this.status = "waiting_for_user";
    this.messages = [{ role: "system", content: options.systemPrompt }];
    this.approvalReceipts = [];
    this.createdAt = createdAt;
    this.lastActivityAt = createdAt;
    this.iterationCount = 0;
    this.inactivityTimeoutMs = options.inactivityTimeoutMs ?? 10 * 60 * 1000;
    this.maxIterations = options.maxIterations ?? 50;
  }

  appendUserMessage(content: string, at = new Date()): void {
    this.messages.push({ role: "user", content });
    this.status = "active";
    this.touch(at);
  }

  appendAssistantMessage(content: string, toolCalls?: ToolCall[], at = new Date()): void {
    this.messages.push({
      role: "assistant",
      content,
      ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
    });
    this.status = "active";
    this.touch(at);
  }

  appendToolResult(toolResultId: string, content: string, at = new Date()): void {
    this.messages.push({
      role: "tool_result",
      content,
      toolResultId,
    });
    this.status = "active";
    this.touch(at);
  }

  addApprovalReceipt(receipt: ApprovalReceipt): void {
    this.approvalReceipts.push(receipt);
    this.touch(receipt.timestamp);
  }

  findApprovalReceipt(criteria: ApprovalReceiptCriteria): ApprovalReceipt | null {
    return findMatchingApprovalReceipt(this.approvalReceipts, criteria);
  }

  hasApprovalReceipt(criteria: ApprovalReceiptCriteria): boolean {
    return this.findApprovalReceipt(criteria) !== null;
  }

  incrementIteration(count = 1, at = new Date()): number {
    this.iterationCount += count;
    this.touch(at);
    return this.iterationCount;
  }

  hasReachedIterationLimit(): boolean {
    return this.iterationCount >= this.maxIterations;
  }

  isExpired(now = new Date()): boolean {
    return now.getTime() - this.lastActivityAt.getTime() > this.inactivityTimeoutMs;
  }

  isTerminal(): boolean {
    return this.status === "completed" || this.status === "failed";
  }

  markWaitingForLLM(at = new Date()): void {
    this.status = "waiting_for_llm";
    this.touch(at);
  }

  markWaitingForUser(at = new Date()): void {
    this.status = "waiting_for_user";
    this.touch(at);
  }

  markCompleted(at = new Date()): void {
    this.status = "completed";
    this.touch(at);
  }

  markFailed(at = new Date()): void {
    this.status = "failed";
    this.touch(at);
  }

  private touch(at: Date): void {
    this.lastActivityAt = at;
  }
}
