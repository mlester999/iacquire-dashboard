import "server-only";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import type { SessionUser } from "@/server/auth/service";
import { actorFor, isId, requireView } from "@/server/purchase-intents/service";
import { PURCHASE_STATUS_TEXT, effectiveStatus, type PurchaseStatus } from "@/lib/purchase-intents/rules";

// Where an invitation came from, and what became of a demo prospect's request. A demo prospect who asks for a purchase link is only recorded (src/server/demo/public.ts): a Super Admin
// then creates the invitation from the prospect's page, and the invitation's "created" entry on its timeline names that prospect. The link between them is that one fact, read here in
// both directions; no checkout, payment or workspace is ever created by the demo, and nothing here changes either record.

export interface InvitationOrigin {
  prospectId: string;
  name: string | null;
  business: string | null;
}

/** The demo prospect an invitation was made from, or null when it was made by hand (or the prospect's details have been erased). */
export async function getInvitationOrigin(user: SessionUser, intentId: unknown): Promise<InvitationOrigin | null> {
  if (!isId(intentId)) throw new AppError("not_found", "That purchase was not found.");
  return withSystem(async (db) => {
    const agency = requireView(await actorFor(db, user));
    const row = (await db.query<{ id: string; name: string | null; business: string | null }>(
      `select p.id, p.name, p.business_name as business
         from purchase_intent_events e join demo_prospects p on p.id::text = e.detail->>'prospectId'
        where e.intent_id = $1 and e.agency_org_id = $2 and e.kind = 'created' and p.erased_at is null limit 1`,
      [intentId, agency],
    )).rows[0];
    return row ? { prospectId: row.id, name: row.name, business: row.business } : null;
  });
}

export interface ProspectInvitation {
  id: string;
  reference: string;
  status: PurchaseStatus;
  statusText: string;
  createdAt: string;
  expiresAt: string;
}

/** The purchase invitations made from one demo prospect, newest first: what the prospect's page shows after a Super Admin acted on "asked for a purchase link". */
export async function listProspectInvitations(user: SessionUser, prospectId: unknown, opts: { now?: Date } = {}): Promise<ProspectInvitation[]> {
  if (!isId(prospectId)) throw new AppError("not_found", "That prospect was not found.");
  const now = opts.now ?? new Date();
  return withSystem(async (db) => {
    const agency = requireView(await actorFor(db, user));
    const { rows } = await db.query<{ id: string; reference: string; status: PurchaseStatus; created_at: Date; expires_at: Date }>(
      `select i.id, i.reference, i.status, i.created_at, i.expires_at
         from purchase_intent_events e join purchase_intents i on i.id = e.intent_id and i.agency_org_id = e.agency_org_id
        where e.kind = 'created' and e.agency_org_id = $1 and e.detail->>'prospectId' = $2::text
        order by i.created_at desc, i.id desc limit 10`,
      [agency, prospectId],
    );
    return rows.map((r) => {
      const status = effectiveStatus({ status: r.status, expiresAt: new Date(r.expires_at).toISOString() }, now);
      return { id: r.id, reference: r.reference, status, statusText: status === "cancelled" ? "Cancelled" : PURCHASE_STATUS_TEXT[status], createdAt: new Date(r.created_at).toISOString(), expiresAt: new Date(r.expires_at).toISOString() };
    });
  });
}
