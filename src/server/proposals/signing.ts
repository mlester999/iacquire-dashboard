import "server-only";
import type { Queryable } from "@/server/db";
import { env } from "@/server/env";
import { ESIGN_FEATURE, featureOn } from "@/server/proposals/features";

// Whether the workspace has a signing service connected and ready to take a request, as the proposal's checks ask it (a proposal that needs a signature cannot be sent while there
// is none). The connection itself, the requests and the worker are src/server/esign; this reads only what a member is allowed to read (the connection's status and kind, never its
// keys), so it also works inside a member's own session.

/** Why signing is not available: no connection (or signing is not switched on), a connection that needs attention, or a real service whose write switch is off here. */
export type SigningUnavailable = "none" | "needs_attention" | "writes_off";

export type SigningStatus = { available: true } | { available: false; why: SigningUnavailable };

export async function signingStatus(db: Queryable, orgId: string): Promise<SigningStatus> {
  if (!(await featureOn(orgId, ESIGN_FEATURE, db))) return { available: false, why: "none" };
  const c = (await db.query<{ provider: string; mode: string; status: string }>("select provider, mode, status from esign_connections where org_id = $1 and status not in ('revoked', 'disconnected') limit 1", [orgId])).rows[0];
  if (!c) return { available: false, why: "none" };
  if (c.status !== "connected") return { available: false, why: "needs_attention" };
  if (c.mode !== "simulated" && !env().ESIGN_WRITES_ENABLED) return { available: false, why: "writes_off" };
  return { available: true };
}

export async function signingAvailable(db: Queryable, orgId: string): Promise<boolean> {
  return (await signingStatus(db, orgId)).available;
}
