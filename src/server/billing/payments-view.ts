import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import type { SessionUser } from "@/server/auth/service";

/**
 * Reads of iAcquire's own payments for the agency screens: the list on /admin/billing and the payments on a client's billing tab. These are iAcquire's setup fees and
 * plan payments (the `payments` table), never the invoices a client sends its customers. The bank reference and the note a Super Admin recorded are agency-only: they
 * are read here, by trusted server code, and never granted to the application role.
 */

type Viewer = Pick<SessionUser, "id" | "platformRole">;

export interface AgencyPaymentView {
  id: string;
  orgId: string;
  orgName: string;
  kind: string;
  status: string;
  provider: string;
  method: string | null;
  description: string;
  usdMicros: number;
  refundedMicros: number;
  referenceNumber: string;
  /** Present only for a payment recorded by hand. */
  externalReference: string | null;
  verificationNote: string | null;
  verifiedByName: string | null;
  paidOn: string | null;
  paidAt: string | null;
  createdAt: string;
  /** This payment is the one that cleared the client's setup fee. */
  clearedSetup: boolean;
  /**
   * Refunds and disputes PayMongo reported for this payment, newest first (at most three). They are reports, not changes: the payment's status and amounts above are what a
   * person recorded, and the screen says so.
   */
  providerNotices: Array<{ type: string; detail: string | null; receivedAt: string }>;
}

export interface PaymentClientOption {
  orgId: string;
  name: string;
  setupStatus: string;
  setupFeeCents: number;
  cleared: boolean;
}

interface Row {
  id: string; org_id: string; org_name: string; kind: string; status: string; provider: string; method: string | null; description: string; usd_amount_micros: string; refunded_micros: string;
  reference_number: string; external_reference: string | null; verification_note: string | null; verified_by_name: string | null; paid_on: string | null; paid_at: Date | null; created_at: Date; cleared_setup: boolean;
}

const COLUMNS = `p.id, p.org_id, o.name as org_name, p.kind, p.status, p.provider, p.method, p.description, p.usd_amount_micros::text, p.refunded_micros::text, p.reference_number,
  p.external_reference, p.verification_note, (select coalesce(nullif(u.full_name, ''), u.email::text) from users u where u.id = p.verified_by) as verified_by_name,
  to_char(p.paid_on, 'YYYY-MM-DD') as paid_on, p.paid_at, p.created_at,
  exists (select 1 from billing_accounts b where b.org_id = p.org_id and b.verified_payment_id = p.id) as cleared_setup`;

const toView = (r: Row): AgencyPaymentView => ({
  id: r.id, orgId: r.org_id, orgName: r.org_name, kind: r.kind, status: r.status, provider: r.provider, method: r.method, description: r.description,
  usdMicros: Number(r.usd_amount_micros), refundedMicros: Number(r.refunded_micros), referenceNumber: r.reference_number, externalReference: r.external_reference,
  verificationNote: r.verification_note, verifiedByName: r.verified_by_name, paidOn: r.paid_on, paidAt: r.paid_at ? new Date(r.paid_at).toISOString() : null,
  createdAt: new Date(r.created_at).toISOString(), clearedSetup: r.cleared_setup, providerNotices: [],
});

/** Adds the refunds, disputes and reversals the payment provider (PayMongo or PayPal) reported for each payment (read from the event ledger). */
async function withProviderNotices(db: Queryable, views: AgencyPaymentView[]): Promise<AgencyPaymentView[]> {
  if (!views.length) return views;
  const { rows } = await db.query<{ payment_id: string; event_type: string; detail: string | null; received_at: Date }>(
    `select payment_id, event_type, detail, received_at from payment_webhook_events
      where payment_id = any($1::uuid[]) and event_type ~* '(refund|dispute|chargeback|revers)' and outcome = 'processed' order by received_at desc, id`,
    [views.map((v) => v.id)],
  );
  const byPayment = new Map<string, AgencyPaymentView["providerNotices"]>();
  for (const r of rows) {
    const list = byPayment.get(r.payment_id) ?? [];
    if (list.length < 3) list.push({ type: r.event_type, detail: r.detail, receivedAt: new Date(r.received_at).toISOString() });
    byPayment.set(r.payment_id, list);
  }
  return views.map((v) => ({ ...v, providerNotices: byPayment.get(v.id) ?? [] }));
}

async function assertBillingView(db: Queryable, user: Viewer) {
  const { rows } = await db.query<{ allowed: boolean; agency_wide: boolean }>(
    `select coalesce(app.user_has_agency_permission($1, 'billing.agency_view'), false) as allowed,
            coalesce(app.user_has_agency_permission($1, 'agency.security.manage'), false) as agency_wide`, [user.id],
  );
  if (rows[0]?.allowed !== true) throw new AppError("forbidden", "Agency access is required.");
  return { agencyWide: rows[0].agency_wide === true };
}

/** The newest payments across the clients this person may see (all of them for a Super Admin), and the clients a payment can be recorded for. */
export async function listAgencyPayments(user: Viewer, opts: { limit?: number } = {}): Promise<{ payments: AgencyPaymentView[]; clients: PaymentClientOption[] }> {
  return withSystem(async (db) => {
    const { agencyWide } = await assertBillingView(db, user);
    const scope = agencyWide ? "true" : "app.user_can_access_org($1, o.id)";
    const params: unknown[] = agencyWide ? [Math.min(Math.max(opts.limit ?? 100, 1), 300)] : [user.id, Math.min(Math.max(opts.limit ?? 100, 1), 300)];
    const limit = agencyWide ? "$1" : "$2";
    const payments = await db.query<Row>(
      `select ${COLUMNS} from payments p join organizations o on o.id = p.org_id where o.kind = 'client' and ${scope} and p.status <> 'pending'
       order by coalesce(p.paid_at, p.created_at) desc, p.id limit ${limit}`, params,
    );
    const clients = await db.query<{ org_id: string; name: string; status: string | null; fee: number | null; cleared: boolean }>(
      `select o.id as org_id, o.name, b.setup_payment_status as status, b.setup_fee_cents as fee, app.setup_payment_cleared(o.id) as cleared
       from organizations o left join billing_accounts b on b.org_id = o.id where o.kind = 'client' and ${scope} order by o.name`,
      agencyWide ? [] : [user.id],
    );
    return {
      payments: await withProviderNotices(db, payments.rows.map(toView)),
      clients: clients.rows.filter((c) => c.status !== null).map((c) => ({ orgId: c.org_id, name: c.name, setupStatus: c.status as string, setupFeeCents: c.fee ?? 0, cleared: c.cleared === true })),
    };
  });
}

/** One client's payments for its billing tab, newest first. */
export async function listClientPayments(db: Queryable, orgId: string, limit = 25): Promise<AgencyPaymentView[]> {
  const { rows } = await db.query<Row>(
    `select ${COLUMNS} from payments p join organizations o on o.id = p.org_id where p.org_id = $1 and p.status <> 'pending' order by coalesce(p.paid_at, p.created_at) desc, p.id limit $2`,
    [orgId, limit],
  );
  return withProviderNotices(db, rows.map(toView));
}
