import { describe, expect, it } from "vitest";
import { EvaluateRequest, EvaluateResponse, jsonBoundsViolation } from "./api.ts";

const valid = {
  agent_id: "support-agent",
  action_id: "act_1",
  invocation_id: "0192f6a4-3b1c-7d2e-8f00-123456789abc",
  tool: "crm.export_customers",
  arguments: { records: 1000 },
};

describe("EvaluateRequest", () => {
  it("accepts the documented shape", () => {
    expect(EvaluateRequest.safeParse(valid).success).toBe(true);
    expect(EvaluateRequest.safeParse({ ...valid, context: { channel: "support_chat", labels: { tier: "gold" } } }).success).toBe(
      true,
    );
  });

  it.each(["organization_id", "application_id", "prompt", "messages"])("rejects a smuggled %s field", (field) => {
    expect(EvaluateRequest.safeParse({ ...valid, [field]: "x" }).success).toBe(false);
  });

  it("rejects unknown context keys (no raw prompts or PII fields)", () => {
    expect(EvaluateRequest.safeParse({ ...valid, context: { user_email: "a@b.c" } }).success).toBe(false);
  });

  it.each([
    ["tool", "CRM.export"],
    ["tool", "crm"],
    ["agent_id", "Support Agent"],
    ["action_id", "has space"],
    ["action_id", "x".repeat(129)],
    ["invocation_id", "not-a-uuid"],
  ])("rejects invalid %s %j", (field, value) => {
    expect(EvaluateRequest.safeParse({ ...valid, [field]: value }).success).toBe(false);
  });

  it("requires arguments to be an object when present", () => {
    expect(EvaluateRequest.safeParse({ ...valid, arguments: [1] }).success).toBe(false);
    expect(EvaluateRequest.safeParse({ ...valid, arguments: "x" }).success).toBe(false);
  });

  it("enforces nesting and size bounds", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 10; i++) deep = { d: deep };
    expect(EvaluateRequest.safeParse({ ...valid, arguments: deep }).success).toBe(false);
    const wide = Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`k${String(i)}`, 1]));
    expect(EvaluateRequest.safeParse({ ...valid, arguments: wide }).success).toBe(false);
    expect(EvaluateRequest.safeParse({ ...valid, arguments: { s: "x".repeat(8193) } }).success).toBe(false);
  });

  it("jsonBoundsViolation accepts depth exactly at the limit", () => {
    let atLimit: unknown = 1;
    for (let i = 0; i < 8; i++) atLimit = { d: atLimit };
    expect(jsonBoundsViolation(atLimit)).toBeNull();
  });
});

describe("EvaluateResponse invariants", () => {
  const base = {
    decision: "ALLOW",
    decision_id: "0192f6a4-3b1c-7d2e-8f00-123456789abc",
    event_id: "0192f6a4-3b1c-7d2e-8f00-123456789abd",
    action_id: "act_1",
    risk_score: 10,
    severity: "low",
    reason_codes: ["DEFAULT_DECISION"],
    policy_version_id: null,
    approval_id: null,
    approval_expires_at: null,
    replayed: false,
    duplicate_invocation: false,
    evaluated_at: "2026-09-28T15:04:05.123Z",
  };

  it("accepts a valid ALLOW", () => {
    expect(EvaluateResponse.safeParse(base).success).toBe(true);
  });

  it("REQUIRE_APPROVAL without approval fields is malformed", () => {
    expect(EvaluateResponse.safeParse({ ...base, decision: "REQUIRE_APPROVAL" }).success).toBe(false);
  });

  it("an approval_id on ALLOW is malformed", () => {
    expect(EvaluateResponse.safeParse({ ...base, approval_id: base.decision_id }).success).toBe(false);
  });

  it.each([
    ["lowercase decision", { decision: "allow" }],
    ["unknown decision", { decision: "PERMIT" }],
    ["missing decision_id", { decision_id: undefined }],
    ["empty reason codes", { reason_codes: [] }],
    ["risk out of range", { risk_score: 101 }],
  ])("rejects %s", (_label, patch) => {
    expect(EvaluateResponse.safeParse({ ...base, ...patch }).success).toBe(false);
  });
});
