import "server-only";
import { NextResponse } from "next/server";
import { assertSameOrigin, requireFreshUserOrThrow, requireUserOrThrow } from "@/server/auth/session";
import { AppError, toPublicError } from "@/server/errors";
import type { SessionUser } from "@/server/auth/service";

/**
 * Every AQi Operations endpoint starts here. The role is read from the authenticated session and the
 * database, never from the request, and anything other than a Super Admin is refused before any
 * parameter is looked at. This is the server-side boundary: hiding the console is not enforcement.
 */
export async function requireOpsAdmin(options: { mutating?: boolean; fresh?: boolean } = {}): Promise<SessionUser> {
  if (options.mutating) await assertSameOrigin();
  // `fresh` asks the auth server whether the account still exists and is not banned, instead of trusting a token up to an hour old.
  const user = options.fresh ? await requireFreshUserOrThrow() : await requireUserOrThrow();
  if (user.platformRole !== "agency_super_admin") throw new AppError("forbidden", "AQi Operations is available to Super Admins only.");
  return user;
}

export function opsJson(body: unknown, init: ResponseInit = {}): NextResponse {
  return NextResponse.json(body, { ...init, headers: { "Cache-Control": "private, no-store", ...(init.headers ?? {}) } });
}

export function opsError(err: unknown): NextResponse {
  const error = toPublicError(err);
  return NextResponse.json(
    { error: error.message, code: error.code, ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}) },
    { status: error.status, headers: { "Cache-Control": "private, no-store" } },
  );
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
