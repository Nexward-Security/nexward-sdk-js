import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { Nexward, NexwardConfigError, NexwardValidationError } from "./index.ts";
import type { NexwardOptions } from "./index.ts";

const KEY = `nxw_test_abcdefghjkmn_${"S".repeat(43)}`;
const BASE = "https://api.nexward.test";

type Reply = { status: number; body?: unknown; raw?: string; headers?: Record<string, string> } | "network-error" | "hang";

/** Fake fetch that serves replies in order and records every request. */
function fakeFetch(replies: Reply[]) {
  const calls: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const reqInit = init ?? {};
    const target = url instanceof Request ? url.url : url.toString();
    const raw = typeof reqInit.body === "string" ? reqInit.body : "{}";
    calls.push({ url: target, init: reqInit, body: JSON.parse(raw) as Record<string, unknown> });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)] ?? "network-error";
    if (reply === "network-error") throw new TypeError("fetch failed");
    if (reply === "hang") {
      return new Promise<Response>((_resolve, reject) => {
        reqInit.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }
    const text = reply.raw ?? JSON.stringify(reply.body ?? {});
    return new Response(text, { status: reply.status, headers: reply.headers ?? {} });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

function client(replies: Reply[], opts: Partial<NexwardOptions> = {}) {
  const f = fakeFetch(replies);
  const nx = new Nexward({
    apiKey: KEY,
    baseUrl: BASE,
    fetch: f.fn,
    timeouts: { attemptMs: 50, totalMs: 400, maxAttempts: 3 },
    ...opts,
  });
  return { nx, calls: f.calls };
}

/** Echoes the request's action_id so responses pass the SDK's match check. */
function decisionBody(decision: string, patch: Record<string, unknown> = {}) {
  return (actionId: string) => ({
    decision,
    decision_id: "0192f6a4-3b1c-7d2e-8f00-123456789abc",
    event_id: "0192f6a4-3b1c-7d2e-8f00-123456789abd",
    action_id: actionId,
    risk_score: 40,
    severity: "medium",
    reason_codes: ["DEFAULT_DECISION"],
    policy_version_id: null,
    approval_id: decision === "REQUIRE_APPROVAL" ? "0192f6a4-3b1c-7d2e-8f00-123456789abe" : null,
    approval_expires_at: decision === "REQUIRE_APPROVAL" ? "2026-09-28T16:00:00.000Z" : null,
    replayed: false,
    duplicate_invocation: false,
    evaluated_at: "2026-09-28T15:00:00.000Z",
    ...patch,
  });
}

const ACTION = { agentId: "support-agent", tool: "crm.export_customers", actionId: "act_1", arguments: { records: 1000 } };
const ok = (decision: string, patch: Record<string, unknown> = {}): Reply => ({
  status: 200,
  body: decisionBody(decision, patch)("act_1"),
});

describe("failure policy §1: callback call counts", () => {
  const rows: Array<[string, Reply[], string, number, string?]> = [
    ["F1 ALLOW", [ok("ALLOW")], "executed", 1],
    ["F2 BLOCK", [ok("BLOCK")], "blocked", 0],
    ["F3 REQUIRE_APPROVAL", [ok("REQUIRE_APPROVAL")], "approval_required", 0],
    ["F4 network error (all attempts)", ["network-error"], "not_executed", 0, "NEXWARD_UNAVAILABLE"],
    ["F5/F6 attempts time out", ["hang"], "not_executed", 0, "NEXWARD_UNAVAILABLE"],
    ["F7 429 throughout", [{ status: 429 }], "not_executed", 0, "NEXWARD_UNAVAILABLE"],
    ["F8 503 throughout", [{ status: 503 }], "not_executed", 0, "NEXWARD_UNAVAILABLE"],
    ["F9 500", [{ status: 500 }], "not_executed", 0, "NEXWARD_UNAVAILABLE"],
    ["F10 400", [{ status: 400 }], "not_executed", 0, "INVALID_REQUEST"],
    ["F10 413", [{ status: 413 }], "not_executed", 0, "INVALID_REQUEST"],
    ["F11 401", [{ status: 401 }], "not_executed", 0, "AUTH_FAILED"],
    ["F12 409", [{ status: 409 }], "not_executed", 0, "DUPLICATE_ACTION"],
    ["F13 not JSON", [{ status: 200, raw: "<html>ok</html>" }], "not_executed", 0, "MALFORMED_RESPONSE"],
    ["F14 duplicate ALLOW", [ok("ALLOW", { duplicate_invocation: true, replayed: true })], "not_executed", 0, "DUPLICATE_ACTION"],
    ["unexpected 302", [{ status: 302 }], "not_executed", 0, "NEXWARD_UNAVAILABLE"],
    ["unexpected 204", [{ status: 204 }], "not_executed", 0, "NEXWARD_UNAVAILABLE"],
  ];

  it.each(rows)("%s → %s, callback ×%d", async (_label, replies, outcome, calls, reason) => {
    const { nx } = client(replies);
    const cb = vi.fn(() => "crm-result");
    const result = await nx.protect(ACTION, cb);
    expect(result.outcome).toBe(outcome);
    expect(cb).toHaveBeenCalledTimes(calls);
    if (reason !== undefined) expect(result).toMatchObject({ reason });
    if (outcome === "executed") expect(result).toMatchObject({ value: "crm-result" });
  });

  it("F16 callback throws: error propagates, callback ran exactly once, no re-evaluation", async () => {
    const { nx, calls } = client([ok("ALLOW")]);
    const cb = vi.fn(() => {
      throw new Error("crm down");
    });
    await expect(nx.protect(ACTION, cb)).rejects.toThrow("crm down");
    expect(cb).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
  });

  it("async callback rejection propagates and is not retried", async () => {
    const { nx } = client([ok("ALLOW")]);
    const cb = vi.fn(() => Promise.reject(new Error("async fail")));
    await expect(nx.protect(ACTION, cb)).rejects.toThrow("async fail");
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe("malformed responses never execute (F13)", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["lowercase allow", { decision: "allow" }],
    ["unknown decision", { decision: "PERMIT" }],
    ["decision as boolean", { decision: true }],
    ["missing decision_id", { decision_id: undefined }],
    ["action_id for a different action", { action_id: "act_other" }],
    ["REQUIRE_APPROVAL without approval_id", { decision: "REQUIRE_APPROVAL", approval_id: null }],
    ["risk_score out of range", { risk_score: 500 }],
    ["empty reason codes", { reason_codes: [] }],
  ];

  it.each(cases)("%s → MALFORMED_RESPONSE", async (_label, patch) => {
    const { nx, calls } = client([{ status: 200, body: { ...decisionBody("ALLOW")("act_1"), ...patch } }]);
    const cb = vi.fn();
    const result = await nx.protect(ACTION, cb);
    expect(result).toMatchObject({ outcome: "not_executed", reason: "MALFORMED_RESPONSE" });
    expect(cb).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1); // malformed is not retried
  });

  it("property: the callback runs only for a schema-valid, matching, non-duplicate ALLOW", async () => {
    const allowBody = decisionBody("ALLOW")("act_1");
    const bodyArb = fc.oneof(
      fc.anything(),
      fc.record({
        decision: fc.constantFrom("ALLOW", "BLOCK", "REQUIRE_APPROVAL", "allow", "", null),
        decision_id: fc.constantFrom(allowBody.decision_id, "nope", undefined),
        event_id: fc.constant(allowBody.event_id),
        action_id: fc.constantFrom("act_1", "act_2"),
        risk_score: fc.integer({ min: -5, max: 105 }),
        severity: fc.constantFrom("low", "extreme"),
        reason_codes: fc.constantFrom(["X"], []),
        policy_version_id: fc.constant(null),
        approval_id: fc.constantFrom(null, allowBody.decision_id),
        approval_expires_at: fc.constantFrom(null, "2026-09-28T16:00:00.000Z"),
        replayed: fc.boolean(),
        duplicate_invocation: fc.boolean(),
        evaluated_at: fc.constant(allowBody.evaluated_at),
      }),
    );
    await fc.assert(
      fc.asyncProperty(bodyArb, async (body) => {
        const text = JSON.stringify(body) as string | undefined;
        const { nx } = client([{ status: 200, raw: text ?? "null" }]);
        const cb = vi.fn();
        const result = await nx.protect(ACTION, cb);
        const b = body as Record<string, unknown> | null;
        const shouldRun =
          typeof b === "object" &&
          b !== null &&
          b.decision === "ALLOW" &&
          b.decision_id === allowBody.decision_id &&
          b.action_id === "act_1" &&
          typeof b.risk_score === "number" &&
          b.risk_score >= 0 &&
          b.risk_score <= 100 &&
          b.severity === "low" &&
          Array.isArray(b.reason_codes) &&
          b.reason_codes.length > 0 &&
          b.approval_id === null &&
          b.duplicate_invocation === false;
        expect(cb).toHaveBeenCalledTimes(shouldRun ? 1 : 0);
        expect(result.outcome === "executed").toBe(shouldRun);
      }),
      { numRuns: 300 },
    );
  });
});

describe("retries apply only to authorization", () => {
  it("retries availability failures with the same action_id and invocation_id, then executes once", async () => {
    const { nx, calls } = client(["network-error", { status: 503 }, ok("ALLOW")]);
    const cb = vi.fn(() => 1);
    const result = await nx.protect(ACTION, cb);
    expect(result.outcome).toBe("executed");
    expect(cb).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((c) => c.body.action_id)).size).toBe(1);
    expect(new Set(calls.map((c) => c.body.invocation_id)).size).toBe(1);
  });

  it("stops at maxAttempts", async () => {
    const { nx, calls } = client([{ status: 503 }], { timeouts: { attemptMs: 50, totalMs: 5000, maxAttempts: 2 } });
    await nx.protect(ACTION, vi.fn());
    expect(calls).toHaveLength(2);
  });

  it("stops at the total deadline even when attempts remain", async () => {
    const { nx, calls } = client(["hang"], { timeouts: { attemptMs: 100, totalMs: 150, maxAttempts: 5 } });
    const started = Date.now();
    const result = await nx.protect(ACTION, vi.fn());
    expect(result).toMatchObject({ outcome: "not_executed", reason: "NEXWARD_UNAVAILABLE" });
    expect(Date.now() - started).toBeLessThan(400);
    expect(calls.length).toBeLessThanOrEqual(2);
  });

  it("does not wait past the deadline for a long Retry-After", async () => {
    const { nx, calls } = client([{ status: 429, headers: { "retry-after": "30" } }, ok("ALLOW")]);
    const cb = vi.fn();
    const result = await nx.protect(ACTION, cb);
    expect(result.outcome).toBe("not_executed");
    expect(calls).toHaveLength(1);
    expect(cb).not.toHaveBeenCalled();
  });

  it.each([400, 401, 409, 413, 500])("never retries HTTP %d", async (status) => {
    const { nx, calls } = client([{ status }]);
    await nx.protect(ACTION, vi.fn());
    expect(calls).toHaveLength(1);
  });

  it("each protect() call gets a fresh invocation_id", async () => {
    const { nx, calls } = client([ok("BLOCK")]);
    await nx.protect(ACTION, vi.fn());
    await nx.protect(ACTION, vi.fn());
    expect(calls[0]?.body.invocation_id).not.toBe(calls[1]?.body.invocation_id);
  });
});

describe("arguments are bound to what was evaluated (T5)", () => {
  it("callback receives a deep-frozen copy of the evaluated arguments", async () => {
    const { nx, calls } = client([ok("ALLOW")]);
    const args = { records: 1000, filter: { region: "us" } };
    let received: unknown;
    await nx.protect({ ...ACTION, arguments: args }, (a) => {
      received = a;
      expect(Object.isFrozen(a)).toBe(true);
      expect(Object.isFrozen(a.filter)).toBe(true);
      expect(() => {
        (a as { records: number }).records = 1;
      }).toThrow(TypeError);
    });
    expect(received).toEqual(calls[0]?.body.arguments);
    expect(received).not.toBe(args);
  });

  it("mutating the caller's object during evaluation does not change what the callback gets", async () => {
    const args = { records: 10 };
    const f = fakeFetch([ok("ALLOW")]);
    const nx = new Nexward({
      apiKey: KEY,
      baseUrl: BASE,
      fetch: (async (url: string, init: RequestInit) => {
        args.records = 1_000_000; // attacker-controlled code mutates after submission
        return f.fn(url, init);
      }) as unknown as typeof fetch,
    });
    let seen = 0;
    await nx.protect({ ...ACTION, arguments: args }, (a) => {
      seen = a.records;
    });
    expect(seen).toBe(10);
  });

  it.each([
    ["function", { fn: () => 1 }],
    ["Date", { when: new Date() }],
    ["Map", { m: new Map() }],
    ["undefined value", { x: undefined }],
    ["NaN", { n: Number.NaN }],
    ["Infinity", { n: Number.POSITIVE_INFINITY }],
    ["bigint", { n: 1n }],
    ["class instance", { c: new (class Box { readonly v = 1; })() }],
  ])("rejects %s before any network call; callback never runs", async (_label, args) => {
    const { nx, calls } = client([ok("ALLOW")]);
    const cb = vi.fn();
    await expect(nx.protect({ ...ACTION, arguments: args }, cb)).rejects.toThrow(
      NexwardValidationError,
    );
    expect(calls).toHaveLength(0);
    expect(cb).not.toHaveBeenCalled();
  });

  it("rejects cyclic arguments", async () => {
    const { nx, calls } = client([ok("ALLOW")]);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(nx.protect({ ...ACTION, arguments: cyclic }, vi.fn())).rejects.toThrow(NexwardValidationError);
    expect(calls).toHaveLength(0);
  });

  it("rejects an invalid tool name before any network call", async () => {
    const { nx, calls } = client([ok("ALLOW")]);
    await expect(nx.protect({ ...ACTION, tool: "CRM.Export" }, vi.fn())).rejects.toThrow(NexwardValidationError);
    expect(calls).toHaveLength(0);
  });
});

describe("failOpenTools (failure policy §2)", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

  it("executes a listed tool once on availability failure", async () => {
    const { nx } = client(["network-error"], { failOpenTools: ["crm.export_customers"] });
    const cb = vi.fn(() => "ran");
    const result = await nx.protect(ACTION, cb);
    expect(result).toEqual({ outcome: "executed_fail_open", value: "ran", reason: "FAIL_OPEN_EXECUTED" });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
  });

  it.each([
    ["BLOCK", [ok("BLOCK")]],
    ["REQUIRE_APPROVAL", [ok("REQUIRE_APPROVAL")]],
    ["malformed", [{ status: 200, raw: "nope" }]],
    ["401", [{ status: 401 }]],
    ["400", [{ status: 400 }]],
    ["409", [{ status: 409 }]],
    ["duplicate", [ok("ALLOW", { duplicate_invocation: true })]],
  ] as Array<[string, Reply[]]>)("never fails open on %s", async (_label, replies) => {
    const { nx } = client(replies, { failOpenTools: ["crm.export_customers"] });
    const cb = vi.fn();
    const result = await nx.protect(ACTION, cb);
    expect(["executed", "executed_fail_open"]).not.toContain(result.outcome);
    expect(cb).not.toHaveBeenCalled();
  });

  it("does not fail open for tools that are not listed", async () => {
    const { nx } = client(["network-error"], { failOpenTools: ["kb.search"] });
    const cb = vi.fn();
    expect((await nx.protect(ACTION, cb)).outcome).toBe("not_executed");
    expect(cb).not.toHaveBeenCalled();
  });

  it("rejects wildcards", () => {
    expect(() => new Nexward({ apiKey: KEY, baseUrl: BASE, failOpenTools: ["crm.*"] })).toThrow(NexwardConfigError);
  });
});

describe("configuration (F15) and transport safety", () => {
  it.each([
    ["missing key", { apiKey: "" }],
    ["malformed key", { apiKey: "sk-not-a-nexward-key" }],
    ["missing URL", { baseUrl: "" }],
    ["plain http to a remote host", { baseUrl: "http://api.nexward.test" }],
    ["credentials in URL", { baseUrl: "https://user:pass@api.nexward.test" }],
    ["not a URL", { baseUrl: "api.nexward.test" }],
    ["bad timeouts", { timeouts: { maxAttempts: 0 } }],
  ])("throws NexwardConfigError for %s", (_label, patch) => {
    expect(() => new Nexward({ apiKey: KEY, baseUrl: BASE, ...patch })).toThrow(NexwardConfigError);
  });

  it("allows http only for localhost", () => {
    expect(() => new Nexward({ apiKey: KEY, baseUrl: "http://localhost:4000" })).not.toThrow();
    expect(() => new Nexward({ apiKey: KEY, baseUrl: "http://127.0.0.1:4000" })).not.toThrow();
  });

  it("sends the key as a Bearer header, refuses redirects, and targets the evaluate path", async () => {
    const { nx, calls } = client([ok("BLOCK")]);
    await nx.protect(ACTION, vi.fn());
    const call = calls[0];
    expect(call?.url).toBe(`${BASE}/v1/actions/evaluate`);
    expect(call?.init.redirect).toBe("error");
    expect((call?.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
  });

  it("never exposes the API key in outcomes, events, errors, or serialization", async () => {
    const events: unknown[] = [];
    const { nx } = client([{ status: 401 }], { onEvent: (e) => events.push(e) });
    const result = await nx.protect(ACTION, vi.fn());
    const secretPart = KEY.slice(-43);
    expect(JSON.stringify(result)).not.toContain(secretPart);
    expect(JSON.stringify(events)).not.toContain(secretPart);
    expect(JSON.stringify(nx)).not.toContain(secretPart);
    expect(Object.keys(nx)).toEqual([]);
  });

  it("an onEvent hook that throws cannot affect enforcement", async () => {
    const { nx } = client([ok("ALLOW")], {
      onEvent: () => {
        throw new Error("observer bug");
      },
    });
    const cb = vi.fn(() => "ok");
    expect(await nx.protect(ACTION, cb)).toMatchObject({ outcome: "executed", value: "ok" });
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe("evaluate()", () => {
  it("returns the decision and never executes anything", async () => {
    const { nx } = client([ok("ALLOW")]);
    const r = await nx.evaluate(ACTION);
    expect(r).toMatchObject({ ok: true, decision: { decision: "ALLOW" }, duplicateInvocation: false });
  });

  it("reports failures as values, not exceptions", async () => {
    const { nx } = client([{ status: 401 }]);
    expect(await nx.evaluate(ACTION)).toMatchObject({ ok: false, reason: "AUTH_FAILED" });
  });
});

describe("resume() (ADR 0003)", () => {
  const APPROVAL = "0192f6a4-3b1c-7d2e-8f00-123456789abe";
  const RESUME = { agentId: "support-agent", tool: "email.send", actionId: "act_1", arguments: { to: "a@example.com" } };

  it("posts the original action with a fresh invocation to the redeem path and executes once on ALLOW", async () => {
    const { nx, calls } = client([ok("ALLOW", { reason_codes: ["APPROVAL_GRANTED"] })]);
    const cb = vi.fn(() => "sent");
    const result = await nx.resume(APPROVAL, RESUME, cb);
    expect(result).toMatchObject({ outcome: "executed", value: "sent" });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(calls[0]?.url).toBe(`${BASE}/v1/approvals/${APPROVAL}/redeem`);
    expect(calls[0]?.body).toMatchObject({ action_id: "act_1", tool: "email.send", arguments: { to: "a@example.com" } });
  });

  it("BLOCK (policy tightened after approval) → blocked, callback never runs", async () => {
    const { nx } = client([ok("BLOCK", { reason_codes: ["X", "APPROVAL_SUPERSEDED_BY_BLOCK"] })]);
    const cb = vi.fn();
    expect((await nx.resume(APPROVAL, RESUME, cb)).outcome).toBe("blocked");
    expect(cb).not.toHaveBeenCalled();
  });

  it.each([
    ["404", { status: 404 }, "APPROVAL_NOT_FOUND"],
    ["410", { status: 410 }, "APPROVAL_EXPIRED"],
    ["409 not approved", { status: 409, body: { error: { code: "APPROVAL_NOT_APPROVED" } } }, "APPROVAL_NOT_APPROVED"],
    ["409 already redeemed", { status: 409, body: { error: { code: "APPROVAL_ALREADY_REDEEMED" } } }, "APPROVAL_ALREADY_REDEEMED"],
    ["409 mismatch", { status: 409, body: { error: { code: "APPROVAL_ACTION_MISMATCH" } } }, "APPROVAL_ACTION_MISMATCH"],
    ["409 unknown code", { status: 409, body: { error: { code: "SOMETHING_NEW" } } }, "APPROVAL_NOT_APPROVED"],
    ["409 non-JSON", { status: 409, raw: "conflict" }, "APPROVAL_NOT_APPROVED"],
    ["REQUIRE_APPROVAL again", ok("REQUIRE_APPROVAL"), "MALFORMED_RESPONSE"],
    ["duplicate ALLOW", ok("ALLOW", { duplicate_invocation: true }), "MALFORMED_RESPONSE"],
    ["401", { status: 401 }, "AUTH_FAILED"],
  ] as Array<[string, Reply, string]>)("%s → not_executed %s", async (_label, reply, reason) => {
    const { nx } = client([reply]);
    const cb = vi.fn();
    expect(await nx.resume(APPROVAL, RESUME, cb)).toMatchObject({ outcome: "not_executed", reason });
    expect(cb).not.toHaveBeenCalled();
  });

  it("never fails open, even for a listed tool", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { nx } = client(["network-error"], { failOpenTools: ["email.send"] });
    const cb = vi.fn();
    expect(await nx.resume(APPROVAL, RESUME, cb)).toMatchObject({ outcome: "not_executed", reason: "NEXWARD_UNAVAILABLE" });
    expect(cb).not.toHaveBeenCalled();
  });

  it("retries availability failures with the same invocation_id (server replays safely)", async () => {
    const { nx, calls } = client([{ status: 503 }, ok("ALLOW")]);
    const cb = vi.fn();
    await nx.resume(APPROVAL, RESUME, cb);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body.invocation_id).toBe(calls[1]?.body.invocation_id);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-UUID approval id or a missing actionId before any network call", async () => {
    const { nx, calls } = client([ok("ALLOW")]);
    await expect(nx.resume("../../v1/actions/evaluate", RESUME, vi.fn())).rejects.toThrow(NexwardValidationError);
    await expect(nx.resume(APPROVAL, { ...RESUME, actionId: "" }, vi.fn())).rejects.toThrow(NexwardValidationError);
    expect(calls).toHaveLength(0);
  });
});

describe("getApproval()", () => {
  const APPROVAL = "0192f6a4-3b1c-7d2e-8f00-123456789abe";
  const statusBody = (patch: Record<string, unknown> = {}) => ({
    approval_id: APPROVAL,
    action_id: "act_1",
    status: "approved",
    expires_at: "2026-09-28T16:00:00.000Z",
    decided_at: "2026-09-28T15:30:00.000Z",
    ...patch,
  });

  it("GETs the approval and maps the response", async () => {
    const { nx, calls } = client([{ status: 200, body: statusBody() }]);
    expect(await nx.getApproval(APPROVAL)).toMatchObject({ ok: true, status: "approved", actionId: "act_1" });
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.init.body).toBeUndefined();
  });

  it("treats a response for a different approval as malformed", async () => {
    const { nx } = client([{ status: 200, body: statusBody({ approval_id: "0192f6a4-3b1c-7d2e-8f00-000000000000" }) }]);
    expect(await nx.getApproval(APPROVAL)).toMatchObject({ ok: false, reason: "MALFORMED_RESPONSE" });
  });

  it("maps 404 to APPROVAL_NOT_FOUND", async () => {
    const { nx } = client([{ status: 404 }]);
    expect(await nx.getApproval(APPROVAL)).toMatchObject({ ok: false, reason: "APPROVAL_NOT_FOUND" });
  });
});
