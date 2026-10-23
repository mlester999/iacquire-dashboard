import "server-only";
import crypto from "node:crypto";
import { withSystem } from "@/server/db";
import { env } from "@/server/env";
import { recordAudit } from "@/server/audit";
import { revokeByProviderUser } from "@/server/social/accounts";
import { parseSignedRequest } from "@/server/social/providers/meta-oauth";

// Meta's two callbacks for an app: "deauthorize" (a person removed the app from their account) and "data deletion" (a person asked Meta to delete the data the
// app holds about them). Each arrives as a form post carrying `signed_request`, an HMAC of its payload made with the app secret. An unsigned or wrongly signed
// request does nothing at all.

export interface CallbackResult {
  status: number;
  body: Record<string, unknown>;
}

const TEXT_LIMIT = 8_000;

function readSigned(raw: string, secretOverride?: string): { userId: string } | { error: CallbackResult } {
  const secret = secretOverride ?? env().META_SOCIAL_APP_SECRET;
  if (!secret) return { error: { status: 503, body: { error: "not_configured" } } };
  if (raw.length > TEXT_LIMIT) return { error: { status: 413, body: { error: "too_large" } } };
  const signed = new URLSearchParams(raw).get("signed_request");
  const payload = signed ? parseSignedRequest(signed, secret) : null;
  if (!payload || typeof payload.user_id !== "string" || !payload.user_id) return { error: { status: 400, body: { error: "invalid_signature" } } };
  return { userId: payload.user_id };
}

/** The person removed the app: every account they authorized stops working here and its token is deleted. Answers 200 whether or not we held anything for them. */
export async function handleDeauthorize(raw: string, deps: { secret?: string } = {}): Promise<CallbackResult> {
  const r = readSigned(raw, deps.secret);
  if ("error" in r) return r.error;
  const revoked = await revokeByProviderUser(r.userId, "deauthorized");
  return { status: 200, body: { ok: true, revoked } };
}

/**
 * The person asked for their data to be deleted: their accounts stop working and the tokens we held are deleted, exactly as for a deauthorization. Sign-ins
 * they left unfinished are cleared and their platform user id is removed from every account row. The posts a business published are the business's own content
 * and stay. Returns what Meta requires: a status address and a confirmation code.
 */
export async function handleDataDeletion(raw: string, deps: { secret?: string } = {}): Promise<CallbackResult> {
  const r = readSigned(raw, deps.secret);
  if ("error" in r) return r.error;
  const revoked = await revokeByProviderUser(r.userId, "data_deletion");
  const code = crypto.randomBytes(12).toString("hex");
  await withSystem((db) => recordAudit({ actorKind: "system", action: "social.data_deletion_requested", targetType: "social_account", result: "success", metadata: { code, revoked } }, db));
  return { status: 200, body: { url: `${env().APP_URL.replace(/\/+$/, "")}/api/webhooks/meta-social/data-deletion-status?code=${code}`, confirmation_code: code } };
}

/** What the status address shows: whether a deletion request with that code was processed. Says nothing else. */
export async function deletionStatus(code: string | null): Promise<CallbackResult> {
  if (!code || !/^[0-9a-f]{24}$/.test(code)) return { status: 404, body: { status: "unknown" } };
  const found = await withSystem(async (db) => (await db.query("select 1 from audit_logs where action = 'social.data_deletion_requested' and metadata ->> 'code' = $1", [code])).rows.length > 0);
  return found ? { status: 200, body: { status: "completed", detail: "The sign-in tokens, unfinished sign-ins and platform user id held for this request were deleted." } } : { status: 404, body: { status: "unknown" } };
}
