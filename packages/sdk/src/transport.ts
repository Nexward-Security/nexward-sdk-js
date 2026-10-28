// Authorization transport with bounded retries (docs/failure-policy.md §1).
// Only idempotent requests go through here: evaluate and redeem reuse the same
// action_id + invocation_id across retries, and GET is read-only.
// This module never touches customer callbacks.

export type Timeouts = { readonly attemptMs: number; readonly totalMs: number; readonly maxAttempts: number };

export type TransportResult<T> =
  | { readonly kind: "ok"; readonly response: T }
  | { readonly kind: "unavailable"; readonly detail: string } // F4-F9: network, timeout, 429, 5xx, unexpected status
  | { readonly kind: "auth_failed" } // F11
  | { readonly kind: "invalid_request" } // F10
  | { readonly kind: "conflict"; readonly code: string | null } // F12 and approval conflicts
  | { readonly kind: "not_found" }
  | { readonly kind: "gone" }
  | { readonly kind: "malformed"; readonly detail: string }; // F13

export type TransportDeps = {
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
};

export type RequestSpec<T> = {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly body?: unknown;
  /** Returns the validated response, or a reason string if it is malformed. */
  readonly validate: (value: unknown) => { ok: true; value: T } | { ok: false; reason: string };
};

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

function parseRetryAfter(header: string | null): number | null {
  if (header === null) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

async function readJson(res: Response): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: await res.json() };
  } catch {
    return { ok: false };
  }
}

async function errorCode(res: Response): Promise<string | null> {
  const json = await readJson(res);
  if (!json.ok || typeof json.value !== "object" || json.value === null) return null;
  const error = (json.value as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

export async function sendRequest<T>(
  spec: RequestSpec<T>,
  apiKey: string,
  timeouts: Timeouts,
  deps: TransportDeps,
): Promise<TransportResult<T>> {
  const deadline = deps.now() + timeouts.totalMs;
  const payload = spec.body === undefined ? undefined : JSON.stringify(spec.body);
  let lastDetail = "no attempt made";

  for (let attempt = 1; attempt <= timeouts.maxAttempts; attempt++) {
    const remaining = deadline - deps.now();
    if (remaining <= 0) break;

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, Math.min(timeouts.attemptMs, remaining));

    let retryAfterMs: number | null = null;
    try {
      const headers: Record<string, string> = { authorization: `Bearer ${apiKey}` };
      if (payload !== undefined) headers["content-type"] = "application/json";
      const res = await deps.fetch(spec.url, {
        method: spec.method,
        headers,
        ...(payload === undefined ? {} : { body: payload }),
        signal: controller.signal,
        // Never follow redirects: a redirect could send the key or a forged decision elsewhere (T12).
        redirect: "error",
      });

      if (res.status === 200) {
        const json = await readJson(res);
        if (!json.ok) return { kind: "malformed", detail: "response is not JSON" };
        const checked = spec.validate(json.value);
        return checked.ok ? { kind: "ok", response: checked.value } : { kind: "malformed", detail: checked.reason };
      }
      if (res.status === 401) return { kind: "auth_failed" };
      if (res.status === 400 || res.status === 413) return { kind: "invalid_request" };
      if (res.status === 404) return { kind: "not_found" };
      if (res.status === 409) return { kind: "conflict", code: await errorCode(res) };
      if (res.status === 410) return { kind: "gone" };
      if (!RETRYABLE_STATUS.has(res.status)) {
        // 500 and anything unexpected: likely deterministic, do not retry (F9).
        return { kind: "unavailable", detail: `HTTP ${String(res.status)}` };
      }
      lastDetail = `HTTP ${String(res.status)}`;
      retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
    } catch {
      lastDetail = controller.signal.aborted ? "attempt timed out" : "network error";
    } finally {
      clearTimeout(timer);
    }

    if (attempt === timeouts.maxAttempts) break;
    // Full-jitter exponential backoff (100 ms, 300 ms, ...), or Retry-After when given.
    const backoff = retryAfterMs ?? Math.floor(deps.random() * 100 * 3 ** (attempt - 1));
    const left = deadline - deps.now();
    if (backoff >= left) break;
    await deps.sleep(backoff);
  }

  return { kind: "unavailable", detail: lastDetail };
}
