import { ApprovalStatusResponse, EvaluateRequest, EvaluateResponse } from "@nexward/types";
import type { ActionContext, ApprovalStatus, Decision, Severity } from "./types.ts";
import { NexwardConfigError, NexwardValidationError } from "./errors.ts";
import { cloneJson, deepFreeze } from "./json.ts";
import type { JsonValue } from "./json.ts";
import { sendRequest } from "./transport.ts";
import type { RequestSpec, Timeouts, TransportDeps, TransportResult } from "./transport.ts";

// Runtime enforcement (ADR 0001, docs/api-contract.md §7, docs/failure-policy.md).
//
// Invariants:
//   * The callback runs only for a validated ALLOW (or an explicit fail-open
//     tool during an availability failure), and at most once per call.
//   * The callback is never retried; its errors propagate unchanged.
//   * Nexward-side failures never throw from protect()/resume()/evaluate(); they
//     return a non-executed outcome. Only programmer errors throw, before any network call.
//   * resume() never fails open: approvals exist for high-risk actions.

export type LocalReasonCode =
  | "NEXWARD_UNAVAILABLE"
  | "MALFORMED_RESPONSE"
  | "DUPLICATE_ACTION"
  | "AUTH_FAILED"
  | "INVALID_REQUEST"
  | "APPROVAL_NOT_FOUND"
  | "APPROVAL_NOT_APPROVED"
  | "APPROVAL_ALREADY_REDEEMED"
  | "APPROVAL_ACTION_MISMATCH"
  | "APPROVAL_EXPIRED";

export type Action<A extends Record<string, unknown> = Record<string, unknown>> = {
  readonly agentId: string;
  readonly tool: string;
  /** Stable id for this unit of work. Generated if omitted; pass one to make retries across processes safe. */
  readonly actionId?: string;
  readonly sessionId?: string;
  readonly arguments?: A;
  readonly context?: ActionContext;
};

export type DecisionInfo = {
  readonly decision: Decision;
  readonly decisionId: string;
  readonly eventId: string;
  readonly actionId: string;
  readonly riskScore: number;
  readonly severity: Severity;
  readonly reasonCodes: readonly string[];
  readonly policyVersionId: string | null;
  readonly replayed: boolean;
};

export type EvaluateResult =
  | { readonly ok: true; readonly decision: DecisionInfo; readonly approvalId: string | null; readonly duplicateInvocation: boolean }
  | { readonly ok: false; readonly reason: LocalReasonCode; readonly detail?: string };

export type ApprovalStatusResult =
  | {
      readonly ok: true;
      readonly approvalId: string;
      readonly actionId: string;
      readonly status: ApprovalStatus;
      readonly expiresAt: string;
      readonly decidedAt: string | null;
    }
  | { readonly ok: false; readonly reason: LocalReasonCode; readonly detail?: string };

export type ProtectOutcome<T> =
  | { readonly outcome: "executed"; readonly value: T; readonly decision: DecisionInfo }
  | { readonly outcome: "blocked"; readonly decision: DecisionInfo }
  | { readonly outcome: "approval_required"; readonly approvalId: string; readonly expiresAt: string; readonly decision: DecisionInfo }
  | { readonly outcome: "not_executed"; readonly reason: LocalReasonCode; readonly detail?: string }
  | { readonly outcome: "executed_fail_open"; readonly value: T; readonly reason: "FAIL_OPEN_EXECUTED" };

export type NexwardEvent =
  | { readonly type: "decision"; readonly tool: string; readonly outcome: ProtectOutcome<unknown>["outcome"]; readonly decision?: DecisionInfo }
  | { readonly type: "not_executed"; readonly tool: string; readonly reason: LocalReasonCode }
  | { readonly type: "fail_open_executed"; readonly tool: string };

export type NexwardOptions = {
  /** Defaults to process.env.NEXWARD_API_KEY. */
  readonly apiKey?: string;
  /** Defaults to process.env.NEXWARD_API_URL. HTTPS required except for localhost. */
  readonly baseUrl?: string;
  readonly timeouts?: Partial<Timeouts>;
  /** Tools that may run when Nexward is unreachable. Default none. See docs/failure-policy.md §2. */
  readonly failOpenTools?: readonly string[];
  /** Observability hook. Exceptions thrown here are swallowed. */
  readonly onEvent?: (event: NexwardEvent) => void;
  /** For tests and custom runtimes. */
  readonly fetch?: typeof fetch;
};

const KEY_PATTERN = /^nxw_(?:test|live)_[0-9abcdefghjkmnpqrstvwxyz]{12}_[A-Za-z0-9_-]{43}$/;
const DEFAULT_TIMEOUTS: Timeouts = { attemptMs: 1000, totalMs: 2500, maxAttempts: 3 };

function readEnv(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name];
}

function resolveEndpoint(baseUrl: string | undefined): string {
  if (baseUrl === undefined || baseUrl === "") {
    throw new NexwardConfigError("Nexward API URL is required (baseUrl option or NEXWARD_API_URL).");
  }
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new NexwardConfigError("Nexward API URL is not a valid URL.");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new NexwardConfigError("Nexward API URL must use https (http is allowed only for localhost).");
  }
  if (url.username !== "" || url.password !== "") {
    throw new NexwardConfigError("Nexward API URL must not contain credentials.");
  }
  return new URL("/v1/actions/evaluate", url).toString();
}

function toDecisionInfo(r: EvaluateResponse): DecisionInfo {
  return {
    decision: r.decision,
    decisionId: r.decision_id,
    eventId: r.event_id,
    actionId: r.action_id,
    riskScore: r.risk_score,
    severity: r.severity,
    reasonCodes: r.reason_codes,
    policyVersionId: r.policy_version_id,
    replayed: r.replayed,
  };
}

const APPROVAL_CONFLICTS: ReadonlySet<string> = new Set([
  "APPROVAL_NOT_APPROVED",
  "APPROVAL_ALREADY_REDEEMED",
  "APPROVAL_ACTION_MISMATCH",
]);

function localReason(result: Exclude<TransportResult<unknown>, { kind: "ok" }>, context: "evaluate" | "approval"): LocalReasonCode {
  switch (result.kind) {
    case "unavailable":
      return "NEXWARD_UNAVAILABLE";
    case "auth_failed":
      return "AUTH_FAILED";
    case "invalid_request":
      return "INVALID_REQUEST";
    case "conflict":
      if (context === "evaluate") return "DUPLICATE_ACTION";
      return result.code !== null && APPROVAL_CONFLICTS.has(result.code)
        ? (result.code as LocalReasonCode)
        : "APPROVAL_NOT_APPROVED";
    case "not_found":
      return context === "approval" ? "APPROVAL_NOT_FOUND" : "NEXWARD_UNAVAILABLE";
    case "gone":
      return context === "approval" ? "APPROVAL_EXPIRED" : "NEXWARD_UNAVAILABLE";
    case "malformed":
      return "MALFORMED_RESPONSE";
  }
}

function detailOf(result: Exclude<TransportResult<unknown>, { kind: "ok" }>): { detail?: string } {
  return result.kind === "unavailable" || result.kind === "malformed" ? { detail: result.detail } : {};
}

/** Accepts a 200 only if it passes the shared schema AND answers the action we sent. */
function decisionSpec(url: string, request: EvaluateRequest): RequestSpec<EvaluateResponse> {
  return {
    url,
    method: "POST",
    body: request,
    validate: (value) => {
      const parsed = EvaluateResponse.safeParse(value);
      if (!parsed.success) return { ok: false, reason: "response failed schema validation" };
      if (parsed.data.action_id !== request.action_id) return { ok: false, reason: "action_id mismatch" };
      return { ok: true, value: parsed.data };
    },
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class Nexward {
  readonly #apiKey: string;
  readonly #base: string;
  readonly #endpoint: string;
  readonly #timeouts: Timeouts;
  readonly #failOpen: ReadonlySet<string>;
  readonly #onEvent: ((event: NexwardEvent) => void) | undefined;
  readonly #deps: TransportDeps;

  constructor(options: NexwardOptions = {}) {
    const apiKey = options.apiKey ?? readEnv("NEXWARD_API_KEY");
    if (apiKey === undefined || apiKey === "") {
      throw new NexwardConfigError("Nexward API key is required (apiKey option or NEXWARD_API_KEY).");
    }
    if (!KEY_PATTERN.test(apiKey)) {
      throw new NexwardConfigError("Nexward API key is malformed.");
    }
    this.#apiKey = apiKey;
    this.#endpoint = resolveEndpoint(options.baseUrl ?? readEnv("NEXWARD_API_URL"));
    this.#base = new URL("/", this.#endpoint).toString();

    const t = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    if (!(t.attemptMs > 0 && t.totalMs > 0 && Number.isInteger(t.maxAttempts) && t.maxAttempts >= 1 && t.maxAttempts <= 5)) {
      throw new NexwardConfigError("Invalid timeouts.");
    }
    this.#timeouts = t;

    for (const tool of options.failOpenTools ?? []) {
      if (tool.includes("*")) throw new NexwardConfigError("failOpenTools does not support wildcards.");
    }
    this.#failOpen = new Set(options.failOpenTools ?? []);
    if (this.#failOpen.size > 0) {
      console.warn(`[nexward] These tools will run WITHOUT authorization if Nexward is unreachable: ${[...this.#failOpen].join(", ")}`);
    }

    this.#onEvent = options.onEvent;
    const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#deps = {
      fetch: fetchImpl,
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      random: Math.random,
    };
  }

  /** Never exposes the key through inspection or JSON serialization. */
  toJSON(): Record<string, string> {
    return { endpoint: this.#endpoint };
  }

  /** Asks for a decision without executing anything. */
  async evaluate(action: Action): Promise<EvaluateResult> {
    const { request } = this.#buildRequest(action);
    const result = await sendRequest(decisionSpec(this.#endpoint, request), this.#apiKey, this.#timeouts, this.#deps);
    if (result.kind !== "ok") {
      return { ok: false, reason: localReason(result, "evaluate"), ...detailOf(result) };
    }
    return {
      ok: true,
      decision: toDecisionInfo(result.response),
      approvalId: result.response.approval_id,
      duplicateInvocation: result.response.duplicate_invocation,
    };
  }

  /**
   * Evaluates the action and runs `callback` only if Nexward returns ALLOW.
   * The callback receives a deep-frozen copy of exactly the evaluated arguments.
   */
  async protect<A extends Record<string, unknown>, T>(
    action: Action<A>,
    callback: (args: Readonly<A>) => T | Promise<T>,
  ): Promise<ProtectOutcome<T>> {
    const { request, frozenArgs } = this.#buildRequest(action);

    // One-shot latch: the callback reference is consumed on first use.
    let pending: ((args: Readonly<A>) => T | Promise<T>) | null = callback;
    const runOnce = async (): Promise<T> => {
      const fn = pending;
      pending = null;
      if (fn === null) throw new Error("nexward: callback already consumed");
      return fn(frozenArgs as unknown as Readonly<A>);
    };

    const result = await sendRequest(decisionSpec(this.#endpoint, request), this.#apiKey, this.#timeouts, this.#deps);

    if (result.kind === "ok") {
      const response = result.response;
      const decision = toDecisionInfo(response);

      if (response.duplicate_invocation) {
        return this.#notExecuted(request.tool, "DUPLICATE_ACTION", "action_id was already evaluated by another call");
      }
      if (response.decision === "ALLOW") {
        this.#emit({ type: "decision", tool: request.tool, outcome: "executed", decision });
        const value = await runOnce();
        return { outcome: "executed", value, decision };
      }
      if (response.decision === "REQUIRE_APPROVAL" && response.approval_id !== null && response.approval_expires_at !== null) {
        this.#emit({ type: "decision", tool: request.tool, outcome: "approval_required", decision });
        return { outcome: "approval_required", approvalId: response.approval_id, expiresAt: response.approval_expires_at, decision };
      }
      this.#emit({ type: "decision", tool: request.tool, outcome: "blocked", decision });
      return { outcome: "blocked", decision };
    }

    // Fail-open applies ONLY to availability failures, and only for explicitly listed tools.
    if (result.kind === "unavailable" && this.#failOpen.has(request.tool)) {
      this.#emit({ type: "fail_open_executed", tool: request.tool });
      const value = await runOnce();
      return { outcome: "executed_fail_open", value, reason: "FAIL_OPEN_EXECUTED" };
    }

    return this.#notExecuted(request.tool, localReason(result, "evaluate"), detailOf(result).detail);
  }

  /** Current status of an approval request (ADR 0003). Never throws for Nexward-side failures. */
  async getApproval(approvalId: string): Promise<ApprovalStatusResult> {
    if (!UUID.test(approvalId)) throw new NexwardValidationError("approvalId must be a UUID");
    const result = await sendRequest<ApprovalStatusResponse>(
      {
        url: new URL(`v1/approvals/${approvalId}`, this.#base).toString(),
        method: "GET",
        validate: (value) => {
          const parsed = ApprovalStatusResponse.safeParse(value);
          if (!parsed.success) return { ok: false, reason: "response failed schema validation" };
          if (parsed.data.approval_id.toLowerCase() !== approvalId.toLowerCase()) {
            return { ok: false, reason: "approval_id mismatch" };
          }
          return { ok: true, value: parsed.data };
        },
      },
      this.#apiKey,
      this.#timeouts,
      this.#deps,
    );
    if (result.kind !== "ok") return { ok: false, reason: localReason(result, "approval"), ...detailOf(result) };
    const r = result.response;
    return {
      ok: true,
      approvalId: r.approval_id,
      actionId: r.action_id,
      status: r.status,
      expiresAt: r.expires_at,
      decidedAt: r.decided_at,
    };
  }

  /**
   * Redeems an approved action and runs `callback` at most once if Nexward grants it.
   * `action` must be the original action: same actionId, agentId, tool, and arguments.
   * The server re-evaluates current policy; a new BLOCK wins. Never fails open.
   */
  async resume<A extends Record<string, unknown>, T>(
    approvalId: string,
    action: Action<A> & { readonly actionId: string },
    callback: (args: Readonly<A>) => T | Promise<T>,
  ): Promise<ProtectOutcome<T>> {
    if (!UUID.test(approvalId)) throw new NexwardValidationError("approvalId must be a UUID");
    if (typeof action.actionId !== "string" || action.actionId === "") {
      throw new NexwardValidationError("resume() requires the original actionId");
    }
    const { request, frozenArgs } = this.#buildRequest(action);

    const url = new URL(`v1/approvals/${approvalId}/redeem`, this.#base).toString();
    const result = await sendRequest(decisionSpec(url, request), this.#apiKey, this.#timeouts, this.#deps);

    if (result.kind !== "ok") {
      return this.#notExecuted(request.tool, localReason(result, "approval"), detailOf(result).detail);
    }
    const response = result.response;
    const decision = toDecisionInfo(response);
    if (response.decision === "ALLOW" && !response.duplicate_invocation) {
      this.#emit({ type: "decision", tool: request.tool, outcome: "executed", decision });
      // Single call site: the callback runs at most once and is never retried.
      const value = await callback(frozenArgs as unknown as Readonly<A>);
      return { outcome: "executed", value, decision };
    }
    if (response.decision === "BLOCK") {
      this.#emit({ type: "decision", tool: request.tool, outcome: "blocked", decision });
      return { outcome: "blocked", decision };
    }
    // Redemption never legitimately returns REQUIRE_APPROVAL or a duplicate.
    return this.#notExecuted(request.tool, "MALFORMED_RESPONSE", "unexpected redemption response");
  }

  #buildRequest(action: Action): { request: EvaluateRequest; frozenArgs: JsonValue } {
    const args = action.arguments === undefined ? {} : cloneJson(action.arguments);
    const candidate = {
      agent_id: action.agentId,
      action_id: action.actionId ?? `act_${crypto.randomUUID()}`,
      invocation_id: crypto.randomUUID(),
      tool: action.tool,
      arguments: args,
      ...(action.sessionId === undefined ? {} : { session_id: action.sessionId }),
      ...(action.context === undefined ? {} : { context: cloneJson(action.context, "context") }),
    };
    const parsed = EvaluateRequest.safeParse(candidate);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => i.path.join(".") || "action");
      throw new NexwardValidationError(`Invalid action: ${[...new Set(issues)].join(", ")}`, issues);
    }
    // The callback gets its own frozen copy; the request body is serialized separately.
    return { request: parsed.data, frozenArgs: deepFreeze(cloneJson(args)) };
  }

  #notExecuted(tool: string, reason: LocalReasonCode, detail?: string): ProtectOutcome<never> {
    this.#emit({ type: "not_executed", tool, reason });
    return { outcome: "not_executed", reason, ...(detail === undefined ? {} : { detail }) };
  }

  #emit(event: NexwardEvent): void {
    try {
      this.#onEvent?.(event);
    } catch {
      // Observability must never affect enforcement.
    }
  }
}
