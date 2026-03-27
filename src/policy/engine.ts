import { homedir } from "node:os";
import { normalize, resolve } from "node:path";
import { resolveEffectiveFilesystemTargetSync } from "../primitives/file.ts";
import type { ApprovalDecision, PrimitiveContext, InteractionHandler } from "../primitives/types.ts";
import { Logger } from "../observability/logger.ts";
import type {
  ApprovePolicyRule,
  FilePolicyMatch,
  HttpPolicyMatch,
  LoadedPolicy,
  PolicyDecision,
  PolicyEvaluationContext,
  PolicyRule,
  RateLimitPolicyRule,
} from "./types.ts";
import { APPROVAL_RECEIPT_WINDOW_MS } from "./receipts.ts";
import { PolicyRateLimiter } from "./rate-limiter.ts";

const EXEMPT_PRIMITIVES = new Set(["memory", "interact"]);

export interface PolicyEngineOptions {
  policy: LoadedPolicy;
  workspaceDir: string;
  homeDir?: string;
  rateLimiter: PolicyRateLimiter;
  interactionHandler?: InteractionHandler;
  now?: () => Date;
  logger?: Logger;
}

export class PolicyEngine {
  private readonly policy: LoadedPolicy;
  private readonly workspaceDir: string;
  private readonly homeDir: string;
  private readonly rateLimiter: PolicyRateLimiter;
  private interactionHandler?: InteractionHandler;
  private readonly now: () => Date;
  private readonly logger: Logger;

  constructor(options: PolicyEngineOptions) {
    this.policy = options.policy;
    this.workspaceDir = normalize(resolveEffectiveFilesystemTargetSync(options.workspaceDir));
    this.homeDir = normalize(resolveEffectiveFilesystemTargetSync(options.homeDir ?? homedir()));
    this.rateLimiter = options.rateLimiter;
    this.interactionHandler = options.interactionHandler;
    this.now = options.now ?? (() => new Date());
    this.logger = (options.logger ?? new Logger()).child({ component: "policy.engine" });
  }

  getSummary(): string {
    return this.policy.summary;
  }

  setInteractionHandler(handler: InteractionHandler | undefined): void {
    this.interactionHandler = handler;
  }

  async enforce(policyContext: PolicyEvaluationContext, context: PrimitiveContext): Promise<PolicyDecision> {
    try {
      const decision = await this.enforceInternal(policyContext, context);
      this.logger.info("policy.enforce.decision", {
        sessionId: context.sessionId,
        triggerSource: context.triggerSource,
        primitive: policyContext.primitive,
        action: decision.action,
        ruleId: decision.rule?.id,
        reason: "reason" in decision ? decision.reason : undefined,
      });
      return decision;
    } catch (error) {
      const reason = `Policy evaluation failed: ${toErrorMessage(error)}`;
      this.logger.error("policy.enforce.error", {
        sessionId: context.sessionId,
        triggerSource: context.triggerSource,
        primitive: policyContext.primitive,
        error,
      });
      return {
        action: "block",
        reason,
      };
    }
  }

  private async enforceInternal(policyContext: PolicyEvaluationContext, context: PrimitiveContext): Promise<PolicyDecision> {
    const now = this.now();
    const matchingRateLimitRules = this.policy.rules.filter(
      (rule): rule is RateLimitPolicyRule =>
        rule.action === "rate_limit"
        && rule.primitive === policyContext.primitive
        && this.ruleMatches(rule, policyContext),
    );

    for (const rule of matchingRateLimitRules) {
      const result = this.rateLimiter.check(rule.id, rule.limit, now);
      if (!result.allowed) {
        return {
          action: "rate_limit",
          reason: `Rate limit exceeded: ${describeTarget(policyContext)}. Try again in ${formatDuration(result.retryAfterMs)}.`,
          retryAfterMs: result.retryAfterMs,
          rule,
        };
      }
    }

    const matchingRule = this.policy.rules.find(
      (rule) => rule.action !== "rate_limit"
        && rule.primitive === policyContext.primitive
        && this.ruleMatches(rule, policyContext),
    );

    if (!matchingRule) {
      this.recordRateLimits(matchingRateLimitRules, now);
      return {
        action: "allow",
        source: "default",
      };
    }

    if (matchingRule.action === "allow") {
      this.recordRateLimits(matchingRateLimitRules, now);
      return {
        action: "allow",
        source: "rule",
        rule: matchingRule,
      };
    }

    if (matchingRule.action === "block") {
      return {
        action: "block",
        reason: `Policy blocked: ${describeTarget(policyContext)} is not permitted.`,
        rule: matchingRule,
      };
    }

    if (matchingRule.action !== "approve") {
      return {
        action: "block",
        reason: `Unsupported policy action for ${describeTarget(policyContext)}.`,
        rule: matchingRule,
      };
    }

    return await this.handleApprovalRule(matchingRule, matchingRateLimitRules, policyContext, context, now);
  }

  private async handleApprovalRule(
    rule: ApprovePolicyRule,
    matchingRateLimitRules: RateLimitPolicyRule[],
    policyContext: PolicyEvaluationContext,
    context: PrimitiveContext,
    now: Date,
  ): Promise<PolicyDecision> {
    const interactionHandler = this.interactionHandler;

    if (
      rule.modelApprovalSufficient
      && policyContext.primitive === "http"
      && policyContext.tool
      && policyContext.operation
      && interactionHandler?.hasApprovalReceipt(context, {
        tool: policyContext.tool,
        operation: policyContext.operation,
        now,
        maxAgeMs: APPROVAL_RECEIPT_WINDOW_MS,
      })
    ) {
      this.recordRateLimits(matchingRateLimitRules, now);
      return {
        action: "allow",
        source: "receipt",
        rule,
      };
    }

    if (!interactionHandler) {
      return {
        action: "block",
        reason: `Approval required: ${describeTarget(policyContext)} cannot proceed because user interaction is unavailable.`,
        rule,
      };
    }

    const decision = await interactionHandler.requestApproval(buildApprovalMessage(policyContext), context, {
      tool: policyContext.primitive === "http" ? policyContext.tool : undefined,
      operation: policyContext.primitive === "http" ? policyContext.operation : undefined,
      recordReceipt: false,
      summary: describeTarget(policyContext),
    });

    if (decision.approved === false) {
      return {
        action: "block",
        reason: `User denied: ${describeTarget(policyContext)}.`,
        rule,
      };
    }

    if (decision.approved !== true) {
      return {
        action: "block",
        reason: describeAmbiguousApproval(policyContext, decision),
        rule,
      };
    }

    this.recordRateLimits(matchingRateLimitRules, now);
    return {
      action: "allow",
      source: "approved",
      rule,
    };
  }

  private recordRateLimits(rules: RateLimitPolicyRule[], at: Date): void {
    for (const rule of rules) {
      this.rateLimiter.record(rule.id, at);
    }
  }

  private ruleMatches(rule: PolicyRule, policyContext: PolicyEvaluationContext): boolean {
    if (!rule.match) {
      return true;
    }

    switch (policyContext.primitive) {
      case "http":
        return this.matchesHttpRule(rule.match as HttpPolicyMatch, policyContext);
      case "file_read":
      case "file_write":
        return this.matchesFileRule(rule.match as FilePolicyMatch, policyContext.path);
      case "execute":
        return matchesStringPatterns(policyContext.command, (rule.match as { command?: string[] }).command, "command");
      case "schedule":
        return matchesStringPatterns(policyContext.trigger_type, (rule.match as { trigger_type?: string[] }).trigger_type, "generic");
      default:
        return false;
    }
  }

  private matchesHttpRule(match: HttpPolicyMatch, policyContext: Extract<PolicyEvaluationContext, { primitive: "http" }>): boolean {
    return matchesStringPatterns(policyContext.domain, match.domain, "domain")
      && matchesStringPatterns(policyContext.path, match.path?.map((pattern) => resolvePolicyPathPattern(pattern, this.workspaceDir, this.homeDir)), "path")
      && matchesStringPatterns(policyContext.method, match.method, "method")
      && matchesStringPatterns(policyContext.tool, match.tool, "generic")
      && matchesStringPatterns(policyContext.trust_tier, match.trust_tier, "generic")
      && matchesStringPatterns(policyContext.operation, match.operation, "generic");
  }

  private matchesFileRule(match: FilePolicyMatch, path: string): boolean {
    return matchesStringPatterns(
      normalizePortablePath(resolveEffectiveFilesystemTargetSync(path)),
      match.path?.map((pattern) => normalizePortablePath(resolvePolicyPathPattern(pattern, this.workspaceDir, this.homeDir))),
      "path",
    );
  }
}

export function isPolicyExemptPrimitive(primitiveName: string): boolean {
  return EXEMPT_PRIMITIVES.has(primitiveName);
}

function buildApprovalMessage(policyContext: PolicyEvaluationContext): string {
  switch (policyContext.primitive) {
    case "http":
      if (policyContext.tool && policyContext.operation) {
        return `Agent wants to call ${policyContext.tool}.${policyContext.operation} via HTTP ${policyContext.method} ${policyContext.domain}${policyContext.path}. Allow? Reply exactly yes or no only.`;
      }

      return `Agent wants to send HTTP ${policyContext.method} request to ${policyContext.domain}${policyContext.path}. Allow? Reply exactly yes or no only.`;
    case "file_read":
      return `Agent wants to read ${policyContext.path}. Allow? Reply exactly yes or no only.`;
    case "file_write":
      return `Agent wants to write to ${policyContext.path}. Allow? Reply exactly yes or no only.`;
    case "execute":
      return `Agent wants to run shell command: ${policyContext.command}. Allow? Reply exactly yes or no only.`;
    case "schedule":
      return `Agent wants to use schedule${policyContext.trigger_type ? ` with trigger type ${policyContext.trigger_type}` : ""}. Allow? Reply exactly yes or no only.`;
    default:
      return assertNever(policyContext);
  }
}

function describeAmbiguousApproval(policyContext: PolicyEvaluationContext, decision: ApprovalDecision): string {
  const base = `Approval response was unrecognized for ${describeTarget(policyContext)}.`;
  if (decision.response) {
    return `${base} Received: ${JSON.stringify(decision.response)}. Reply exactly yes or no.`;
  }

  if (decision.error) {
    return `${base} ${decision.error}`;
  }

  return `${base} Reply exactly yes or no.`;
}

function describeTarget(policyContext: PolicyEvaluationContext): string {
  switch (policyContext.primitive) {
    case "http":
      if (policyContext.tool && policyContext.operation) {
        return `${policyContext.tool}.${policyContext.operation} (${policyContext.method} ${policyContext.domain}${policyContext.path})`;
      }

      return `HTTP ${policyContext.method} ${policyContext.domain}${policyContext.path}`;
    case "file_read":
      return `file read ${policyContext.path}`;
    case "file_write":
      return `file write ${policyContext.path}`;
    case "execute":
      return `shell command ${policyContext.command}`;
    case "schedule":
      return policyContext.trigger_type ? `schedule ${policyContext.trigger_type}` : "schedule action";
    default:
      return assertNever(policyContext);
  }
}

function matchesStringPatterns(
  value: string | undefined,
  patterns: string[] | undefined,
  kind: "path" | "domain" | "method" | "command" | "generic",
): boolean {
  if (!patterns || patterns.length === 0) {
    return true;
  }

  if (!value) {
    return false;
  }

  return patterns.some((pattern) => globMatch(pattern, value, kind));
}

function globMatch(
  pattern: string,
  value: string,
  kind: "path" | "domain" | "method" | "command" | "generic",
): boolean {
  const renderedPattern = normalizeValue(pattern, kind);
  const renderedValue = normalizeValue(value, kind);
  const singleWildcard = kind === "command" ? ".*" : "[^/]*";
  const expression = escapeRegExp(renderedPattern)
    .replace(/\\\*\\\*/g, "__DOUBLE_WILDCARD__")
    .replace(/\\\*/g, singleWildcard)
    .replace(/__DOUBLE_WILDCARD__/g, ".*");

  return new RegExp(`^${expression}$`).test(renderedValue);
}

function normalizeValue(value: string, kind: "path" | "domain" | "method" | "command" | "generic"): string {
  switch (kind) {
    case "path":
      return normalizePortablePath(value);
    case "domain":
      return value.toLowerCase();
    case "method":
      return value.toUpperCase();
    default:
      return value;
  }
}

function resolvePolicyPathPattern(pattern: string, workspaceDir: string, homeDir: string): string {
  if (pattern === "~/.agent/workspace" || pattern.startsWith("~/.agent/workspace/")) {
    const suffix = pattern.slice("~/.agent/workspace".length);
    return normalize(`${workspaceDir}${suffix}`);
  }

  if (pattern === "~" || pattern.startsWith("~/")) {
    return normalize(resolve(homeDir, pattern.slice(2)));
  }

  return normalize(pattern);
}

function normalizePortablePath(value: string): string {
  return normalize(value).replaceAll("\\", "/");
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.*]/g, "\\$&");
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  const seconds = Math.ceil(durationMs / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }

  return `${Math.ceil(minutes / 60)}h`;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function assertNever(value: never): never {
  throw new Error(`Unsupported value: ${JSON.stringify(value)}`);
}
