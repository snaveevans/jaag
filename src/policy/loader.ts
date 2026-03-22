import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { parse } from "yaml";
import type {
  AllowPolicyRule,
  ApprovePolicyRule,
  BlockPolicyRule,
  HttpPolicyMatch,
  LoadedPolicy,
  PolicyPrimitive,
  PolicyRateLimit,
  PolicyRule,
  RateLimitPolicyRule,
  SchedulePolicyMatch,
} from "./types.ts";
import { POLICY_ACTIONS, POLICY_PRIMITIVES } from "./types.ts";

const POLICY_DIR_NAME = ".agent-policy";
const DEFAULT_POLICY_CONTENT = `# Default Agent Policy - secure defaults
rules:
  - primitive: execute
    match: { command: ["git status", "git diff *", "git log *", "ls *", "cat *", "head *", "tail *", "wc *", "find *", "which *"] }
    action: allow

  - primitive: execute
    action: approve

  - primitive: http
    match: { method: [GET, HEAD, OPTIONS] }
    action: allow

  - primitive: http
    match: { trust_tier: untrusted }
    action: approve
    model_approval_sufficient: false

  - primitive: http
    match: { method: [POST, PUT, PATCH, DELETE] }
    action: approve
    model_approval_sufficient: true

  - primitive: http
    action: allow

  - primitive: file_write
    match: { path: "~/.agent/workspace/**" }
    action: allow

  - primitive: file_write
    action: block

  - primitive: file_read
    action: allow

  - primitive: schedule
    action: allow
`;

const HTTP_MATCH_FIELDS = new Set(["domain", "path", "method", "tool", "trust_tier", "operation"]);
const FILE_MATCH_FIELDS = new Set(["path"]);
const EXECUTE_MATCH_FIELDS = new Set(["command"]);
const SCHEDULE_MATCH_FIELDS = new Set(["trigger_type"]);

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

export interface LoadPolicyOptions {
  agentHome?: string;
  homeDir?: string;
  policyPath?: string;
}

export function resolvePolicyPath(options: LoadPolicyOptions = {}): string {
  if (options.policyPath) {
    return options.policyPath;
  }

  const homeDir = options.homeDir ?? (options.agentHome ? dirname(options.agentHome) : homedir());
  return join(homeDir, POLICY_DIR_NAME, "policy.yaml");
}

export function loadPolicy(options: LoadPolicyOptions = {}): LoadedPolicy {
  const policyPath = resolvePolicyPath(options);
  let rawText = "";
  let installedDefault = false;

  if (!existsSync(policyPath)) {
    mkdirSync(dirname(policyPath), { recursive: true });
    writeFileSync(policyPath, DEFAULT_POLICY_CONTENT, "utf8");
    rawText = DEFAULT_POLICY_CONTENT;
    installedDefault = true;
  } else {
    rawText = readFileSync(policyPath, "utf8");
  }

  let parsed: unknown;
  try {
    parsed = parse(rawText);
  } catch (error) {
    throw new PolicyError(`Failed to parse policy at ${policyPath}: ${toErrorMessage(error)}`);
  }

  const rules = parseRules(parsed, policyPath);
  return {
    policyPath,
    installedDefault,
    rules,
    summary: buildPolicySummary(rules),
  };
}

function parseRules(value: unknown, policyPath: string): PolicyRule[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PolicyError(`Invalid policy at ${policyPath}: expected a top-level object with a rules array.`);
  }

  const rules = (value as { rules?: unknown }).rules;
  if (!Array.isArray(rules)) {
    throw new PolicyError(`Invalid policy at ${policyPath}: expected "rules" to be an array.`);
  }

  return rules.map((rule, index) => parseRule(rule, index + 1, policyPath));
}

function parseRule(value: unknown, index: number, policyPath: string): PolicyRule {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PolicyError(`Invalid policy rule ${index} in ${policyPath}: expected an object.`);
  }

  const rawRule = value as Record<string, unknown>;
  const primitive = requirePolicyPrimitive(rawRule.primitive, index, policyPath);
  const action = requirePolicyAction(rawRule.action, index, policyPath);
  const match = parseMatch(rawRule.match, primitive, index, policyPath);
  const id = buildRuleId(index, rawRule);

  if (action === "approve") {
    return {
      id,
      primitive,
      action,
      match,
      modelApprovalSufficient: rawRule.model_approval_sufficient === undefined
        ? false
        : requireBoolean(rawRule.model_approval_sufficient, index, policyPath, "model_approval_sufficient"),
    } satisfies ApprovePolicyRule;
  }

  if (rawRule.model_approval_sufficient !== undefined) {
    throw new PolicyError(
      `Invalid policy rule ${index} in ${policyPath}: model_approval_sufficient is only valid for action: approve.`,
    );
  }

  if (action === "rate_limit") {
    return {
      id,
      primitive,
      action,
      match,
      limit: parseRateLimit(rawRule.limit, index, policyPath),
    } satisfies RateLimitPolicyRule;
  }

  if (rawRule.limit !== undefined) {
    throw new PolicyError(`Invalid policy rule ${index} in ${policyPath}: limit is only valid for action: rate_limit.`);
  }

  return {
    id,
    primitive,
    action,
    match,
  } satisfies AllowPolicyRule | BlockPolicyRule;
}

function requirePolicyPrimitive(value: unknown, index: number, policyPath: string): PolicyPrimitive {
  if (typeof value !== "string" || !POLICY_PRIMITIVES.includes(value as PolicyPrimitive)) {
    throw new PolicyError(
      `Invalid policy rule ${index} in ${policyPath}: primitive must be one of ${POLICY_PRIMITIVES.join(", ")}.`,
    );
  }

  return value as PolicyPrimitive;
}

function requirePolicyAction(value: unknown, index: number, policyPath: string) {
  if (typeof value !== "string" || !POLICY_ACTIONS.includes(value as typeof POLICY_ACTIONS[number])) {
    throw new PolicyError(
      `Invalid policy rule ${index} in ${policyPath}: action must be one of ${POLICY_ACTIONS.join(", ")}.`,
    );
  }

  return value as typeof POLICY_ACTIONS[number];
}

function parseMatch(value: unknown, primitive: PolicyPrimitive, index: number, policyPath: string) {
  if (value === undefined) {
    return undefined;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PolicyError(`Invalid policy rule ${index} in ${policyPath}: match must be an object.`);
  }

  const rawMatch = value as Record<string, unknown>;
  const allowedFields = getAllowedMatchFields(primitive);
  for (const fieldName of Object.keys(rawMatch)) {
    if (!allowedFields.has(fieldName)) {
      throw new PolicyError(
        `Invalid policy rule ${index} in ${policyPath}: match field ${fieldName} is not valid for primitive ${primitive}.`,
      );
    }
  }

  switch (primitive) {
    case "http":
      return {
        domain: parseStringMatchers(rawMatch.domain, index, policyPath, "match.domain"),
        path: parseStringMatchers(rawMatch.path, index, policyPath, "match.path"),
        method: parseStringMatchers(rawMatch.method, index, policyPath, "match.method")?.map((entry) => entry.toUpperCase()),
        tool: parseStringMatchers(rawMatch.tool, index, policyPath, "match.tool"),
        trust_tier: parseStringMatchers(rawMatch.trust_tier, index, policyPath, "match.trust_tier") as HttpPolicyMatch["trust_tier"],
        operation: parseStringMatchers(rawMatch.operation, index, policyPath, "match.operation"),
      } satisfies HttpPolicyMatch;
    case "file_read":
    case "file_write":
      return {
        path: parseStringMatchers(rawMatch.path, index, policyPath, "match.path"),
      };
    case "execute":
      return {
        command: parseStringMatchers(rawMatch.command, index, policyPath, "match.command"),
      };
    case "schedule":
      return {
        trigger_type: parseStringMatchers(rawMatch.trigger_type, index, policyPath, "match.trigger_type"),
      } satisfies SchedulePolicyMatch;
    default:
      return assertNever(primitive);
  }
}

function parseStringMatchers(
  value: unknown,
  index: number,
  policyPath: string,
  fieldName: string,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    return [requireNonEmptyString(value, index, policyPath, fieldName)];
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      throw new PolicyError(`Invalid policy rule ${index} in ${policyPath}: ${fieldName} must not be an empty array.`);
    }

    return value.map((entry) => requireNonEmptyString(entry, index, policyPath, fieldName));
  }

  throw new PolicyError(`Invalid policy rule ${index} in ${policyPath}: ${fieldName} must be a string or list of strings.`);
}

function parseRateLimit(value: unknown, index: number, policyPath: string): PolicyRateLimit {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PolicyError(`Invalid policy rule ${index} in ${policyPath}: rate_limit rules require a limit object.`);
  }

  const rawLimit = value as Record<string, unknown>;
  const count = rawLimit.count;
  const window = rawLimit.window;

  if (typeof count !== "number" || !Number.isInteger(count) || count < 1) {
    throw new PolicyError(`Invalid policy rule ${index} in ${policyPath}: limit.count must be an integer >= 1.`);
  }

  const renderedWindow = requireNonEmptyString(window, index, policyPath, "limit.window");
  return {
    count,
    window: renderedWindow,
    windowMs: parseRateLimitWindow(renderedWindow, index, policyPath),
  };
}

function parseRateLimitWindow(value: string, index: number, policyPath: string): number {
  const match = /^(\d+)(ms|s|m|h)$/.exec(value.trim());
  if (!match) {
    throw new PolicyError(
      `Invalid policy rule ${index} in ${policyPath}: limit.window must use ms, s, m, or h (example: 10m).`,
    );
  }

  const amount = Number(match[1]);
  const unit = match[2] as "ms" | "s" | "m" | "h";
  if (!Number.isFinite(amount) || amount < 1) {
    throw new PolicyError(`Invalid policy rule ${index} in ${policyPath}: limit.window must be greater than zero.`);
  }

  switch (unit) {
    case "ms":
      return amount;
    case "s":
      return amount * 1000;
    case "m":
      return amount * 60 * 1000;
    case "h":
      return amount * 60 * 60 * 1000;
    default:
      return assertNever(unit);
  }
}

function getAllowedMatchFields(primitive: PolicyPrimitive): Set<string> {
  switch (primitive) {
    case "http":
      return HTTP_MATCH_FIELDS;
    case "file_read":
    case "file_write":
      return FILE_MATCH_FIELDS;
    case "execute":
      return EXECUTE_MATCH_FIELDS;
    case "schedule":
      return SCHEDULE_MATCH_FIELDS;
    default:
      return assertNever(primitive);
  }
}

function buildRuleId(index: number, rawRule: Record<string, unknown>): string {
  const digest = createHash("sha256").update(JSON.stringify(rawRule)).digest("hex").slice(0, 12);
  return `rule-${index}-${digest}`;
}

function buildPolicySummary(rules: PolicyRule[]): string {
  const summaryParts = ["Follow runtime safety limits and use tools deliberately."];

  if (hasCatchAllAllow(rules, "file_read")) {
    summaryParts.push("File reads are generally allowed except for protected runtime paths.");
  }

  if (isWorkspaceRestrictedFileWritePolicy(rules)) {
    summaryParts.push("File writes are limited to approved paths, typically your current workspace.");
  } else if (hasAction(rules, "file_write", "approve")) {
    summaryParts.push("Some file writes require user approval.");
  } else if (hasAction(rules, "file_write", "block")) {
    summaryParts.push("Some file writes are blocked by policy.");
  }

  if (hasCatchAllAction(rules, "execute", "approve")) {
    summaryParts.push("Shell commands usually require user approval.");
  } else if (hasCatchAllAction(rules, "execute", "block")) {
    summaryParts.push("Shell commands are blocked unless a more specific rule allows them.");
  }

  if (hasHttpMutationApproval(rules) && hasHttpReadAllowance(rules)) {
    summaryParts.push("HTTP reads are generally allowed, while some mutations or lower-trust tool calls may require approval.");
  } else if (hasAction(rules, "http", "approve")) {
    summaryParts.push("Some HTTP requests require user approval.");
  } else if (hasCatchAllAllow(rules, "http")) {
    summaryParts.push("HTTP requests are generally allowed.");
  }

  if (hasCatchAllAllow(rules, "schedule")) {
    summaryParts.push("Schedule management is generally allowed, with policy checked again when schedules execute.");
  }

  if (rules.some((rule) => rule.action === "rate_limit")) {
    summaryParts.push("Some actions are rate-limited over time.");
  }

  return summaryParts.join(" ");
}

function hasCatchAllAllow(rules: PolicyRule[], primitive: PolicyPrimitive): boolean {
  return rules.some((rule) => rule.primitive === primitive && rule.action === "allow" && rule.match === undefined);
}

function hasCatchAllAction(rules: PolicyRule[], primitive: PolicyPrimitive, action: PolicyRule["action"]): boolean {
  return rules.some((rule) => rule.primitive === primitive && rule.action === action && rule.match === undefined);
}

function hasAction(rules: PolicyRule[], primitive: PolicyPrimitive, action: PolicyRule["action"]): boolean {
  return rules.some((rule) => rule.primitive === primitive && rule.action === action);
}

function hasHttpReadAllowance(rules: PolicyRule[]): boolean {
  return rules.some(
    (rule) => rule.primitive === "http"
      && rule.action === "allow"
      && rule.match !== undefined
      && "method" in rule.match
      && Boolean(rule.match.method?.some((method) => ["GET", "HEAD", "OPTIONS"].includes(method))),
  );
}

function hasHttpMutationApproval(rules: PolicyRule[]): boolean {
  return rules.some(
    (rule) => rule.primitive === "http"
      && rule.action === "approve"
      && rule.match !== undefined
      && "method" in rule.match
      && Boolean(rule.match.method?.some((method) => ["POST", "PUT", "PATCH", "DELETE"].includes(method))),
  );
}

function isWorkspaceRestrictedFileWritePolicy(rules: PolicyRule[]): boolean {
  const workspaceAllowRule = rules.some(
    (rule) => rule.primitive === "file_write"
      && rule.action === "allow"
      && rule.match !== undefined
      && "path" in rule.match
      && Boolean(rule.match.path?.some((path) => path.includes("workspace"))),
  );

  return workspaceAllowRule && hasCatchAllAction(rules, "file_write", "block");
}

function requireBoolean(value: unknown, index: number, policyPath: string, fieldName: string): boolean {
  if (typeof value !== "boolean") {
    throw new PolicyError(`Invalid policy rule ${index} in ${policyPath}: ${fieldName} must be true or false.`);
  }

  return value;
}

function requireNonEmptyString(value: unknown, index: number, policyPath: string, fieldName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PolicyError(`Invalid policy rule ${index} in ${policyPath}: ${fieldName} must be a non-empty string.`);
  }

  return value.trim();
}

function assertNever(value: never): never {
  throw new Error(`Unsupported value: ${JSON.stringify(value)}`);
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
