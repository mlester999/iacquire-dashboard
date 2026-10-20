import "server-only";

export type ErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "invalid_input"
  | "conflict"
  | "rate_limited"
  | "usage_limit"
  | "plan_required"
  | "budget_exhausted"
  | "billing_unavailable"
  | "agent_unavailable"
  | "integration_unavailable"
  | "upstream_error"
  | "internal";

const STATUS: Record<ErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  invalid_input: 400,
  conflict: 409,
  rate_limited: 429,
  usage_limit: 429,
  // The action belongs to an optional plan the workspace doesn't have (Automation Studio); the interface shows the upgrade page.
  plan_required: 403,
  budget_exhausted: 429,
  billing_unavailable: 503,
  agent_unavailable: 503,
  integration_unavailable: 503,
  upstream_error: 502,
  internal: 500,
};

/** Errors whose message is safe to show to the signed-in user. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryAfterSeconds?: number;

  constructor(code: ErrorCode, message: string, opts?: { retryAfterSeconds?: number }) {
    super(message);
    this.code = code;
    this.status = STATUS[code];
    this.retryAfterSeconds = opts?.retryAfterSeconds;
  }
}

export function toPublicError(err: unknown): { code: ErrorCode; message: string; status: number; retryAfterSeconds?: number } {
  if (err instanceof AppError) {
    return { code: err.code, message: err.message, status: err.status, retryAfterSeconds: err.retryAfterSeconds };
  }
  // Driver/HTTP errors may contain URLs, SQL parameters or upstream credentials.
  if (process.env.NODE_ENV !== "test") console.error("[iacquire] unexpected server error", { type: err instanceof Error ? err.name : "unknown" });
  return { code: "internal", message: "Something went wrong on our side. Please try again.", status: 500 };
}

export type ActionResult<T = undefined> =
  | ({ ok: true } & (T extends undefined ? { data?: undefined } : { data: T }))
  | { ok: false; error: string; code: ErrorCode; fieldErrors?: Record<string, string> };

export function actionError(err: unknown): { ok: false; error: string; code: ErrorCode } {
  const e = toPublicError(err);
  return { ok: false, error: e.message, code: e.code };
}
