import "server-only";
import { NextResponse } from "next/server";
import { toPublicError } from "@/server/errors";

/** JSON for the inbox's read endpoints: private (never cached by a shared cache), with the error shape the interface expects. */
export function inboxJson(body: unknown, init: ResponseInit = {}): NextResponse {
  return NextResponse.json(body, { ...init, headers: { "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff", ...(init.headers ?? {}) } });
}

export function inboxError(err: unknown): NextResponse {
  const e = toPublicError(err);
  return inboxJson({ error: e.message, code: e.code, ...(e.retryAfterSeconds ? { retryAfterSeconds: e.retryAfterSeconds } : {}) }, { status: e.status, headers: e.retryAfterSeconds ? { "Retry-After": String(e.retryAfterSeconds) } : {} });
}

/**
 * A per-process allowance for a polling endpoint. A database-backed counter would turn every poll into a write, so this is a plain in-memory
 * window: it bounds a runaway tab on one instance, and the authenticated session plus row-level security remain the real boundary.
 */
const windows = new Map<string, { start: number; hits: number }>();
export function pollAllowed(key: string, limit: number, windowMs = 60_000, now = Date.now()): { ok: true } | { ok: false; retryAfterSeconds: number } {
  const w = windows.get(key);
  if (!w || now - w.start >= windowMs) {
    if (windows.size > 5000) for (const [k, v] of windows) if (now - v.start >= windowMs) windows.delete(k);
    windows.set(key, { start: now, hits: 1 });
    return { ok: true };
  }
  w.hits += 1;
  return w.hits <= limit ? { ok: true } : { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((w.start + windowMs - now) / 1000)) };
}
