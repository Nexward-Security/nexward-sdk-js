import { z } from "zod";

// Policy definitions are data, never code (CLAUDE.md rule 9). This schema is the
// publish-time gate: anything it rejects can never reach the evaluator.
// Semantics: docs/architecture.md §5.

export const DECISIONS = ["ALLOW", "BLOCK", "REQUIRE_APPROVAL"] as const;
export const Decision = z.enum(DECISIONS);
export type Decision = z.infer<typeof Decision>;

export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export const Severity = z.enum(SEVERITIES);
export type Severity = z.infer<typeof Severity>;

/** Reason codes the platform emits itself; customer rules may not use them. */
export const RESERVED_REASON_CODES = [
  "POLICY_RULE_MATCHED",
  "RULE_INDETERMINATE",
  "DEFAULT_DECISION",
  "UNKNOWN_AGENT",
  "AGENT_DISABLED",
  "UNKNOWN_TOOL",
  "TOOL_DISABLED",
  "TOOL_NOT_GRANTED",
  "NO_ACTIVE_POLICY",
  "RISK_THRESHOLD_EXCEEDED",
  "SENSITIVE_DATA_DETECTED",
  "APPROVAL_GRANTED",
  "APPROVAL_SUPERSEDED_BY_BLOCK",
  "PLAN_LIMIT_REACHED",
] as const;
const RESERVED = new Set<string>(RESERVED_REASON_CODES);

export const LIMITS = {
  rulesPerVersion: 200,
  conditionsPerRule: 10,
  inListItems: 100,
  pathDepth: 8,
  stringValueLength: 1024,
  approvalDisplayFields: 10,
} as const;

/**
 * `tool`, `agent_id`, or a dotted path under `arguments` / `context`.
 * Segments are ASCII identifiers; no wildcards, indexes, or expressions.
 */
export const FIELD_PATH = /^(tool|agent_id|(arguments|context)(\.[A-Za-z0-9_]{1,64}){1,8})$/;
export const FieldPath = z.string().regex(FIELD_PATH, "invalid field path");

export const Scalar = z.union([z.string().max(LIMITS.stringValueLength), z.number(), z.boolean(), z.null()]);
export type Scalar = z.infer<typeof Scalar>;

const EqualityCondition = z.strictObject({
  field: FieldPath,
  operator: z.enum(["equals", "not_equals"]),
  value: Scalar,
});

const ComparisonCondition = z.strictObject({
  field: FieldPath,
  operator: z.enum(["gt", "gte", "lt", "lte"]),
  value: z.number(),
});

const ContainsCondition = z.strictObject({
  field: FieldPath,
  operator: z.literal("contains"),
  value: z.union([z.string().min(1).max(LIMITS.stringValueLength), z.number(), z.boolean()]),
});

const InCondition = z.strictObject({
  field: FieldPath,
  operator: z.literal("in"),
  value: z.array(Scalar).min(1).max(LIMITS.inListItems),
});

const ExistsCondition = z.strictObject({
  field: FieldPath,
  operator: z.literal("exists"),
});

export const Condition = z
  .discriminatedUnion("operator", [EqualityCondition, ComparisonCondition, ContainsCondition, InCondition, ExistsCondition])
  .superRefine((c, ctx) => {
    const builtin = c.field === "tool" || c.field === "agent_id";
    if (builtin && (c.operator === "gt" || c.operator === "gte" || c.operator === "lt" || c.operator === "lte")) {
      ctx.addIssue({ code: "custom", message: `${c.field} is a string; numeric operators are not allowed` });
    }
    if (builtin && c.operator === "exists") {
      ctx.addIssue({ code: "custom", message: `${c.field} is always present; exists is meaningless` });
    }
    if (builtin && (c.operator === "equals" || c.operator === "not_equals") && typeof c.value !== "string") {
      ctx.addIssue({ code: "custom", message: `${c.field} can only be compared with a string` });
    }
  });
export type Condition = z.infer<typeof Condition>;
export type Operator = Condition["operator"];

export const ReasonCode = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{2,63}$/, "reason codes are UPPER_SNAKE_CASE, 3-64 chars")
  .refine((code) => !RESERVED.has(code), "reason code is reserved by Nexward");

/**
 * Argument paths a REQUIRE_APPROVAL rule shows to the approver (ADR 0003, amended
 * 2026-10-02). Only `arguments.*`: approvers judge what the tool will do.
 */
export const ApprovalDisplayPath = FieldPath.refine((p) => p.startsWith("arguments."), "approval_display paths must start with arguments.");

export const Rule = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "invalid rule id"),
    decision: Decision,
    reason_code: ReasonCode,
    severity: Severity,
    conditions: z.array(Condition).min(1).max(LIMITS.conditionsPerRule),
    approval_display: z.array(ApprovalDisplayPath).min(1).max(LIMITS.approvalDisplayFields).optional(),
  })
  .superRefine((r, ctx) => {
    if (r.approval_display === undefined) return;
    if (r.decision !== "REQUIRE_APPROVAL") {
      ctx.addIssue({ code: "custom", path: ["approval_display"], message: "approval_display is only allowed on REQUIRE_APPROVAL rules" });
    }
    if (new Set(r.approval_display).size !== r.approval_display.length) {
      ctx.addIssue({ code: "custom", path: ["approval_display"], message: "approval_display paths must be unique" });
    }
  });
export type Rule = z.infer<typeof Rule>;

export const PolicyVersionDefinition = z
  .strictObject({
    // Required and explicit: there is no implicit default (CLAUDE.md rule 12).
    default_decision: Decision,
    rules: z.array(Rule).max(LIMITS.rulesPerVersion),
  })
  .superRefine((p, ctx) => {
    const seen = new Set<string>();
    for (const [i, rule] of p.rules.entries()) {
      if (seen.has(rule.id)) {
        ctx.addIssue({ code: "custom", path: ["rules", i, "id"], message: `duplicate rule id ${rule.id}` });
      }
      seen.add(rule.id);
    }
  });
export type PolicyVersionDefinition = z.infer<typeof PolicyVersionDefinition>;
