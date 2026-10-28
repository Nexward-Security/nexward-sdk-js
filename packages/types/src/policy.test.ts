import { describe, expect, it } from "vitest";
import { Condition, LIMITS, PolicyVersionDefinition, RESERVED_REASON_CODES } from "./policy.ts";

const rule = (overrides: Record<string, unknown> = {}) => ({
  id: "bulk-export",
  decision: "BLOCK",
  reason_code: "POLICY_BULK_EXPORT_LIMIT",
  severity: "high",
  conditions: [
    { field: "tool", operator: "equals", value: "crm.export_customers" },
    { field: "arguments.records", operator: "gt", value: 500 },
  ],
  ...overrides,
});

const policy = (rules: unknown[] = [rule()], default_decision = "ALLOW") => ({ default_decision, rules });

describe("PolicyVersionDefinition", () => {
  it("accepts the brief's bulk export policy", () => {
    expect(PolicyVersionDefinition.safeParse(policy()).success).toBe(true);
  });

  it("requires an explicit default_decision", () => {
    expect(PolicyVersionDefinition.safeParse({ rules: [] }).success).toBe(false);
    expect(PolicyVersionDefinition.safeParse(policy([], "MAYBE")).success).toBe(false);
  });

  it("rejects unknown keys at every level (no smuggled fields)", () => {
    expect(PolicyVersionDefinition.safeParse({ ...policy(), script: "x" }).success).toBe(false);
    expect(PolicyVersionDefinition.safeParse(policy([rule({ code: "return true" })])).success).toBe(false);
    const cond = { field: "tool", operator: "equals", value: "x", expr: "1" };
    expect(PolicyVersionDefinition.safeParse(policy([rule({ conditions: [cond] })])).success).toBe(false);
  });

  it("rejects duplicate rule ids", () => {
    expect(PolicyVersionDefinition.safeParse(policy([rule(), rule()])).success).toBe(false);
  });

  it("enforces rule and condition limits", () => {
    const many = Array.from({ length: LIMITS.rulesPerVersion + 1 }, (_, i) => rule({ id: `r${String(i)}` }));
    expect(PolicyVersionDefinition.safeParse(policy(many)).success).toBe(false);
    const conds = Array.from({ length: LIMITS.conditionsPerRule + 1 }, () => ({
      field: "tool",
      operator: "equals",
      value: "x",
    }));
    expect(PolicyVersionDefinition.safeParse(policy([rule({ conditions: conds })])).success).toBe(false);
    expect(PolicyVersionDefinition.safeParse(policy([rule({ conditions: [] })])).success).toBe(false);
  });

  it.each(RESERVED_REASON_CODES)("rejects reserved reason code %s", (code) => {
    expect(PolicyVersionDefinition.safeParse(policy([rule({ reason_code: code })])).success).toBe(false);
  });

  it.each(["lowercase", "AB", "HAS-DASH", "1STARTS_WITH_DIGIT"])("rejects malformed reason code %s", (code) => {
    expect(PolicyVersionDefinition.safeParse(policy([rule({ reason_code: code })])).success).toBe(false);
  });
});

describe("Condition", () => {
  const ok = (c: unknown) => Condition.safeParse(c).success;

  it.each([
    "arguments",
    "arguments.",
    "arguments..records",
    "arguments.records[0]",
    "arguments.*",
    "arguments.a.b.c.d.e.f.g.h.i",
    "prompt",
    "headers.authorization",
    "arguments.café",
    "tool.name",
  ])("rejects field path %j", (field) => {
    expect(ok({ field, operator: "exists" })).toBe(false);
  });

  it.each(["arguments.records", "context.channel", "arguments.a.b.c.d.e.f.g.h", "arguments.__proto__"])(
    "accepts field path %j (resolution is safe; see engine tests)",
    (field) => {
      expect(ok({ field, operator: "exists" })).toBe(true);
    },
  );

  it("rejects unknown operators, including regex", () => {
    expect(ok({ field: "tool", operator: "matches", value: ".*" })).toBe(false);
    expect(ok({ field: "tool", operator: "regex", value: ".*" })).toBe(false);
  });

  it("requires numeric values for numeric operators", () => {
    expect(ok({ field: "arguments.records", operator: "gt", value: "500" })).toBe(false);
    expect(ok({ field: "arguments.records", operator: "gt", value: null })).toBe(false);
    expect(ok({ field: "arguments.records", operator: "gt", value: Number.POSITIVE_INFINITY })).toBe(false);
    expect(ok({ field: "arguments.records", operator: "gt", value: 500 })).toBe(true);
  });

  it("rejects numeric operators, exists, and non-string equality on tool/agent_id", () => {
    expect(ok({ field: "tool", operator: "gt", value: 1 })).toBe(false);
    expect(ok({ field: "agent_id", operator: "exists" })).toBe(false);
    expect(ok({ field: "tool", operator: "equals", value: 1 })).toBe(false);
  });

  it("bounds `in` lists and rejects empty ones", () => {
    expect(ok({ field: "tool", operator: "in", value: [] })).toBe(false);
    const big = Array.from({ length: LIMITS.inListItems + 1 }, (_, i) => String(i));
    expect(ok({ field: "tool", operator: "in", value: big })).toBe(false);
  });

  it("rejects object or array values (only scalars are comparable)", () => {
    expect(ok({ field: "arguments.x", operator: "equals", value: { a: 1 } })).toBe(false);
    expect(ok({ field: "arguments.x", operator: "equals", value: [1] })).toBe(false);
    expect(ok({ field: "arguments.x", operator: "in", value: [[1]] })).toBe(false);
  });

  it("requires a value for every operator except exists", () => {
    expect(ok({ field: "arguments.x", operator: "equals" })).toBe(false);
    expect(ok({ field: "arguments.x", operator: "exists", value: true })).toBe(false);
  });
});

describe("approval_display", () => {
  const approvalRule = (overrides: Record<string, unknown> = {}) =>
    rule({
      id: "email-approval",
      decision: "REQUIRE_APPROVAL",
      reason_code: "POLICY_EMAIL_REQUIRES_APPROVAL",
      severity: "medium",
      conditions: [{ field: "tool", operator: "equals", value: "email.send" }],
      ...overrides,
    });
  const parses = (r: unknown) => PolicyVersionDefinition.safeParse(policy([r])).success;

  it("is optional and accepts argument paths on REQUIRE_APPROVAL rules", () => {
    expect(parses(approvalRule())).toBe(true);
    expect(parses(approvalRule({ approval_display: ["arguments.to", "arguments.message.subject"] }))).toBe(true);
  });

  it.each(["BLOCK", "ALLOW"])("is rejected on %s rules", (decision) => {
    expect(parses(approvalRule({ decision, approval_display: ["arguments.to"] }))).toBe(false);
  });

  it.each(["tool", "agent_id", "context.channel", "arguments", "arguments.", "arguments.a.__proto__x!", "arguments.*", "arguments.to[0]"])(
    "rejects non-argument or malformed path %j",
    (path) => {
      expect(parses(approvalRule({ approval_display: [path] }))).toBe(false);
    },
  );

  it("rejects empty, duplicate, and oversized lists", () => {
    expect(parses(approvalRule({ approval_display: [] }))).toBe(false);
    expect(parses(approvalRule({ approval_display: ["arguments.to", "arguments.to"] }))).toBe(false);
    const many = Array.from({ length: LIMITS.approvalDisplayFields + 1 }, (_, i) => `arguments.f${String(i)}`);
    expect(parses(approvalRule({ approval_display: many }))).toBe(false);
  });
});
