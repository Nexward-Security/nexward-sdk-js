import { z } from "zod";
import { Decision, Severity } from "./policy.ts";

// Wire contract for POST /v1/actions/evaluate (docs/api-contract.md §2).
// Shared by apps/api (request parsing) and @nexward/sdk (response validation).

export const ARGUMENT_LIMITS = {
  maxDepth: 8,
  maxKeysPerObject: 256,
  maxArrayLength: 1000,
  maxStringLength: 8192,
} as const;

export const AGENT_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const TOOL_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
export const CLIENT_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Walks parsed JSON and reports the first bound it violates, or null. */
export function jsonBoundsViolation(value: unknown, depth = 0): string | null {
  if (depth > ARGUMENT_LIMITS.maxDepth) return `nesting deeper than ${String(ARGUMENT_LIMITS.maxDepth)}`;
  if (typeof value === "string") {
    return value.length > ARGUMENT_LIMITS.maxStringLength ? "string too long" : null;
  }
  if (Array.isArray(value)) {
    if (value.length > ARGUMENT_LIMITS.maxArrayLength) return "array too long";
    for (const item of value) {
      const v = jsonBoundsViolation(item, depth + 1);
      if (v !== null) return v;
    }
    return null;
  }
  if (typeof value === "object" && value !== null) {
    const keys = Object.keys(value);
    if (keys.length > ARGUMENT_LIMITS.maxKeysPerObject) return "too many keys in one object";
    for (const key of keys) {
      if (key.length > 256) return "key too long";
      const v = jsonBoundsViolation((value as Record<string, unknown>)[key], depth + 1);
      if (v !== null) return v;
    }
  }
  return null;
}

const BoundedArguments = z
  .record(z.string(), z.unknown())
  .superRefine((value, ctx) => {
    const violation = jsonBoundsViolation(value);
    if (violation !== null) ctx.addIssue({ code: "custom", message: `arguments: ${violation}` });
  });

export const ActionContext = z.strictObject({
  end_user_ref: z.string().regex(CLIENT_ID).optional(),
  channel: z.string().min(1).max(64).optional(),
  labels: z
    .record(z.string().min(1).max(64), z.string().max(128))
    .refine((l) => Object.keys(l).length <= 16, "at most 16 labels")
    .optional(),
});
export type ActionContext = z.infer<typeof ActionContext>;

export const EvaluateRequest = z.strictObject({
  agent_id: z.string().regex(AGENT_KEY),
  session_id: z.string().regex(CLIENT_ID).optional(),
  action_id: z.string().regex(CLIENT_ID),
  invocation_id: z.uuid(),
  tool: z.string().max(128).regex(TOOL_NAME),
  arguments: BoundedArguments.optional(),
  context: ActionContext.optional(),
});
export type EvaluateRequest = z.infer<typeof EvaluateRequest>;

export const EvaluateResponse = z
  .object({
    decision: Decision,
    decision_id: z.uuid(),
    event_id: z.uuid(),
    action_id: z.string(),
    risk_score: z.number().int().min(0).max(100),
    severity: Severity,
    reason_codes: z.array(z.string()).min(1),
    policy_version_id: z.uuid().nullable(),
    approval_id: z.uuid().nullable(),
    approval_expires_at: z.iso.datetime().nullable(),
    replayed: z.boolean(),
    duplicate_invocation: z.boolean(),
    evaluated_at: z.iso.datetime(),
  })
  .superRefine((r, ctx) => {
    if (r.decision === "REQUIRE_APPROVAL" && (r.approval_id === null || r.approval_expires_at === null)) {
      ctx.addIssue({ code: "custom", message: "REQUIRE_APPROVAL requires approval_id and approval_expires_at" });
    }
    if (r.decision !== "REQUIRE_APPROVAL" && r.approval_id !== null) {
      ctx.addIssue({ code: "custom", message: "approval_id is only valid with REQUIRE_APPROVAL" });
    }
  });
export type EvaluateResponse = z.infer<typeof EvaluateResponse>;

export const API_ERROR_CODES = [
  "VALIDATION_ERROR",
  "UNAUTHENTICATED",
  "IDEMPOTENCY_CONFLICT",
  "PAYLOAD_TOO_LARGE",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
  "EVALUATION_UNAVAILABLE",
  "NOT_FOUND",
  "APPROVAL_NOT_APPROVED",
  "APPROVAL_ALREADY_REDEEMED",
  "APPROVAL_ACTION_MISMATCH",
  "APPROVAL_EXPIRED",
  "FORBIDDEN",
  "REAUTH_REQUIRED",
  "STALE_POLICY_VERSION",
  "POLICY_INVALID",
  "ALREADY_SUBSCRIBED",
  "NO_BILLING_ACCOUNT",
  "BILLING_UNAVAILABLE",
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const ApiError = z.object({
  error: z.object({
    code: z.enum(API_ERROR_CODES),
    message: z.string(),
    request_id: z.string(),
    /** POLICY_INVALID only: which fields failed and why (never echoes values). */
    issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

// Approvals (docs/api-contract.md §3-4, ADR 0003).

/** Redemption presents the same action that was evaluated, with a new invocation_id. */
export const RedeemRequest = EvaluateRequest;
export type RedeemRequest = EvaluateRequest;

export const APPROVAL_STATUSES = ["pending", "approved", "denied", "expired", "redeemed"] as const;
export const ApprovalStatus = z.enum(APPROVAL_STATUSES);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

export const ApprovalStatusResponse = z.object({
  approval_id: z.uuid(),
  action_id: z.string(),
  status: ApprovalStatus,
  expires_at: z.iso.datetime(),
  decided_at: z.iso.datetime().nullable(),
});
export type ApprovalStatusResponse = z.infer<typeof ApprovalStatusResponse>;

// Management API (dashboard → apps/api, authenticated with the user's Supabase session).

export const CreateApiKeyRequest = z.strictObject({
  name: z.string().trim().min(1).max(100),
  expires_in_days: z.number().int().min(1).max(3650).optional(),
});
export type CreateApiKeyRequest = z.infer<typeof CreateApiKeyRequest>;

export const CreateApiKeyResponse = z.object({
  key_id: z.uuid(),
  /** Shown exactly once. Never stored or logged by Nexward. */
  api_key: z.string(),
  key_prefix: z.string(),
  environment: z.enum(["test", "live"]),
  expires_at: z.iso.datetime().nullable(),
});
export type CreateApiKeyResponse = z.infer<typeof CreateApiKeyResponse>;

export const PublishPolicyRequest = z.strictObject({
  definition: z.unknown(),
  expected_active_version_id: z.uuid().nullable(),
  notes: z.string().max(1000).optional(),
});
export type PublishPolicyRequest = z.infer<typeof PublishPolicyRequest>;

export const PublishPolicyResponse = z.object({ policy_version_id: z.uuid() });
export type PublishPolicyResponse = z.infer<typeof PublishPolicyResponse>;

// Billing (ADR 0006 phase B; owners only). The response is a Stripe-hosted URL to redirect to.

export const CreateCheckoutRequest = z.strictObject({
  plan: z.enum(["team", "scale"]),
  interval: z.enum(["month", "year"]),
});
export type CreateCheckoutRequest = z.infer<typeof CreateCheckoutRequest>;

export const BillingSessionResponse = z.object({ url: z.url() });
export type BillingSessionResponse = z.infer<typeof BillingSessionResponse>;
