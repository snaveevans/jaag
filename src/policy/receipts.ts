export const APPROVAL_RECEIPT_WINDOW_MS = 5 * 60 * 1000;

export interface ApprovalReceipt {
  timestamp: Date;
  tool?: string;
  operation?: string;
  summary: string;
}

export interface ApprovalReceiptCriteria {
  tool?: string;
  operation?: string;
  now?: Date;
  maxAgeMs?: number;
}

export function createApprovalReceipt(input: {
  timestamp?: Date;
  tool?: string;
  operation?: string;
  summary: string;
}): ApprovalReceipt {
  return {
    timestamp: input.timestamp ?? new Date(),
    tool: input.tool,
    operation: input.operation,
    summary: input.summary,
  };
}

export function findMatchingApprovalReceipt(
  receipts: ApprovalReceipt[],
  criteria: ApprovalReceiptCriteria,
): ApprovalReceipt | null {
  if (!criteria.tool || !criteria.operation) {
    return null;
  }

  const now = criteria.now ?? new Date();
  const maxAgeMs = criteria.maxAgeMs ?? APPROVAL_RECEIPT_WINDOW_MS;

  for (let index = receipts.length - 1; index >= 0; index -= 1) {
    const receipt = receipts[index];
    if (!receipt) {
      continue;
    }

    if (now.getTime() - receipt.timestamp.getTime() > maxAgeMs) {
      continue;
    }

    if (receipt.tool === criteria.tool && receipt.operation === criteria.operation) {
      return receipt;
    }
  }

  return null;
}

export function hasMatchingApprovalReceipt(
  receipts: ApprovalReceipt[],
  criteria: ApprovalReceiptCriteria,
): boolean {
  return findMatchingApprovalReceipt(receipts, criteria) !== null;
}
