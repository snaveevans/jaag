import type { TrustTier } from "../specs/types.ts";

export const POLICY_PRIMITIVES = ["http", "file_read", "file_write", "execute", "schedule"] as const;
export const POLICY_ACTIONS = ["allow", "block", "approve", "rate_limit"] as const;

export type PolicyPrimitive = typeof POLICY_PRIMITIVES[number];
export type PolicyAction = typeof POLICY_ACTIONS[number];

export interface HttpPolicyMatch {
  domain?: string[];
  path?: string[];
  method?: string[];
  tool?: string[];
  trust_tier?: TrustTier[];
  operation?: string[];
}

export interface FilePolicyMatch {
  path?: string[];
}

export interface ExecutePolicyMatch {
  command?: string[];
}

export interface SchedulePolicyMatch {
  trigger_type?: string[];
}

export interface PolicyRateLimit {
  count: number;
  window: string;
  windowMs: number;
}

export interface BasePolicyRule<TMatch> {
  id: string;
  primitive: PolicyPrimitive;
  action: PolicyAction;
  match?: TMatch;
}

export interface AllowPolicyRule extends BasePolicyRule<HttpPolicyMatch | FilePolicyMatch | ExecutePolicyMatch | SchedulePolicyMatch> {
  action: "allow";
}

export interface BlockPolicyRule extends BasePolicyRule<HttpPolicyMatch | FilePolicyMatch | ExecutePolicyMatch | SchedulePolicyMatch> {
  action: "block";
}

export interface ApprovePolicyRule extends BasePolicyRule<HttpPolicyMatch | FilePolicyMatch | ExecutePolicyMatch | SchedulePolicyMatch> {
  action: "approve";
  modelApprovalSufficient: boolean;
}

export interface RateLimitPolicyRule extends BasePolicyRule<HttpPolicyMatch | FilePolicyMatch | ExecutePolicyMatch | SchedulePolicyMatch> {
  action: "rate_limit";
  limit: PolicyRateLimit;
}

export type PolicyRule = AllowPolicyRule | BlockPolicyRule | ApprovePolicyRule | RateLimitPolicyRule;

export interface LoadedPolicy {
  policyPath: string;
  installedDefault: boolean;
  rules: PolicyRule[];
  summary: string;
}

export interface HttpPolicyContext {
  primitive: "http";
  domain: string;
  path: string;
  method: string;
  tool?: string;
  trust_tier?: TrustTier;
  operation?: string;
}

export interface FileReadPolicyContext {
  primitive: "file_read";
  path: string;
}

export interface FileWritePolicyContext {
  primitive: "file_write";
  path: string;
}

export interface ExecutePolicyContext {
  primitive: "execute";
  command: string;
}

export interface SchedulePolicyContext {
  primitive: "schedule";
  trigger_type?: string;
}

export type PolicyEvaluationContext =
  | HttpPolicyContext
  | FileReadPolicyContext
  | FileWritePolicyContext
  | ExecutePolicyContext
  | SchedulePolicyContext;

export type PolicyDecision =
  | {
      action: "allow";
      source: "default" | "rule" | "receipt" | "approved" | "exempt";
      rule?: PolicyRule;
    }
  | {
      action: "block";
      reason: string;
      rule?: PolicyRule;
    }
  | {
      action: "rate_limit";
      reason: string;
      retryAfterMs: number;
      rule: RateLimitPolicyRule;
    };
