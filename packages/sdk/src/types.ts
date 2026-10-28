// Public types of the SDK, declared here so the published package has no
// dependency on internal workspace packages. They must stay identical to the
// wire contract in @nexward/types; types.test.ts fails the build if they drift.

export type Decision = "ALLOW" | "BLOCK" | "REQUIRE_APPROVAL";
export type Severity = "low" | "medium" | "high" | "critical";
export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "redeemed";

/** Optional context sent with an action (docs/api-contract.md §2). */
export type ActionContext = {
  /** Opaque reference to the end user ([A-Za-z0-9_.:-], up to 128). Never a name or email. */
  end_user_ref?: string | undefined;
  /** For example "support_chat" (up to 64 characters). */
  channel?: string | undefined;
  /** Up to 16 string labels, keys up to 64 and values up to 128 characters. */
  labels?: Record<string, string> | undefined;
};
