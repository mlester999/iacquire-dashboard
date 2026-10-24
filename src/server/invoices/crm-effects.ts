import "server-only";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { sanitizeErrorText } from "@/lib/ops";
import { systemActor, type CrmActor } from "@/server/crm/actor";
import { emitEvent, recordActivity } from "@/server/crm/events";
import { activityFor, dedupeKeyFor, payloadFor, startsAutomations, type AnnounceFacts, type InvoiceEventType, type TimelineOnlyKind } from "@/lib/invoices/crm-events";
import type { CurrencyCode } from "@/lib/money";
import { addInvoiceEvent, toMinor, type InvoiceActorKind } from "@/server/invoices/core";

// What an invoice or a payment does to the rest of the CRM: a line on the customer's and the deal's timeline, and an event Automation Studio can start a workflow from. Each
// runs in its own savepoint inside the transaction that recorded the money or the invoice: a problem here is written on the invoice's history ("effect_failed") and never
// undoes a payment, an issue or a void. Each announcement happens once (a key per announcement), however many times the code that raises it runs.
//
// The announcements carry ids and amounts only (src/lib/invoices/crm-events.ts). Money that moved in a provider's test mode is on the timeline, labelled, but starts nothing.

export type Actor = { id: string | null; kind: InvoiceActorKind };

interface Brief {
  number: string | null;
  currency: CurrencyCode;
  total_minor: string;
  balance_minor: string;
  contact_id: string | null;
  company_id: string | null;
  opportunity_id: string | null;
  due_on: string | null;
  is_test: boolean;
}

async function briefOf(db: Queryable, orgId: string, invoiceId: string): Promise<Brief | null> {
  const { rows } = await db.query<Brief>(
    `select number, currency, total_minor::text as total_minor, balance_minor::text as balance_minor, contact_id, company_id, opportunity_id, to_char(due_on, 'YYYY-MM-DD') as due_on, is_test
     from customer_invoices where id = $1 and org_id = $2`,
    [invoiceId, orgId],
  );
  return rows[0] ?? null;
}

/** The CRM actor for an announcement: the person when a person did it, the system otherwise. */
export function crmActorFor(orgId: string, actor: Actor): CrmActor {
  const base = systemActor({ id: orgId });
  return actor.kind === "user" && actor.id ? { ...base, kind: "member", userId: actor.id, label: "A team member" } : base;
}

async function guarded(db: Queryable, orgId: string, invoiceId: string, effect: string, fn: () => Promise<void>): Promise<void> {
  await db.query("savepoint invoice_effect");
  try {
    await fn();
    await db.query("release savepoint invoice_effect");
  } catch (e) {
    await db.query("rollback to savepoint invoice_effect");
    await db.query("release savepoint invoice_effect");
    await addInvoiceEvent(db, orgId, invoiceId, "effect_failed", { id: null, kind: "system" }, { effect, message: (e instanceof AppError ? e.message : sanitizeErrorText(e)).slice(0, 300) });
  }
}

/** A timeline line once per announcement: the key rides in the line's metadata, so the same announcement made twice leaves one line. */
async function lineOnce(db: Queryable, actor: CrmActor, b: Brief, invoiceId: string, key: string, line: { kind: string; summary: string }): Promise<void> {
  if (!b.contact_id && !b.company_id && !b.opportunity_id) return;
  const seen = await db.query("select 1 from crm_activities where org_id = $1 and ref_type = 'invoice' and ref_id = $2 and kind = $3 and metadata->>'key' = $4 limit 1", [actor.orgId, invoiceId, line.kind, key]);
  if (seen.rows[0]) return;
  await recordActivity(db, actor, { ...line, contactId: b.contact_id, companyId: b.company_id, opportunityId: b.opportunity_id, refType: "invoice", refId: invoiceId, metadata: { key } });
}

async function announce(db: Queryable, orgId: string, invoiceId: string, type: InvoiceEventType | TimelineOnlyKind, actor: Actor, extra: Partial<AnnounceFacts> = {}): Promise<void> {
  const b = await briefOf(db, orgId, invoiceId);
  if (!b) return;
  const facts: AnnounceFacts = {
    invoiceId, number: b.number, currency: b.currency, totalMinor: toMinor(b.total_minor), balanceMinor: toMinor(b.balance_minor), dueOn: b.due_on, opportunityId: b.opportunity_id, isTest: b.is_test, ...extra,
  };
  const who = crmActorFor(orgId, actor);
  await guarded(db, orgId, invoiceId, type, async () => {
    if (type === "payment.recorded") {
      await lineOnce(db, who, b, invoiceId, `payment.recorded:${facts.paymentId ?? invoiceId}`, activityFor(type, facts));
      return;
    }
    const key = dedupeKeyFor(type, facts);
    if (startsAutomations(type, facts)) {
      await emitEvent(db, who, { type, entityType: "invoice", entityId: invoiceId, contactId: b.contact_id, payload: payloadFor(type, facts), dedupeKey: key });
    }
    await lineOnce(db, who, b, invoiceId, key, activityFor(type, facts));
  });
}

export const announceCreated = (db: Queryable, orgId: string, invoiceId: string, actor: Actor) => announce(db, orgId, invoiceId, "invoice.created", actor);
export const announceIssued = (db: Queryable, orgId: string, invoiceId: string, actor: Actor) => announce(db, orgId, invoiceId, "invoice.issued", actor);
export const announceVoided = (db: Queryable, orgId: string, invoiceId: string, actor: Actor) => announce(db, orgId, invoiceId, "invoice.voided", actor);
export const announceOverdue = (db: Queryable, orgId: string, invoiceId: string, daysOverdue: number) => announce(db, orgId, invoiceId, "invoice.overdue", { id: null, kind: "system" }, { daysOverdue });

/** The invoice is paid in full. Test money anywhere among its payments makes the whole announcement a labelled test: it starts nothing. */
export async function announcePaid(db: Queryable, orgId: string, invoiceId: string, actor: Actor, paid: { paymentId: string; verification: "provider_confirmed" | "manual" }): Promise<void> {
  const test = await db.query("select 1 from customer_payments where invoice_id = $1 and org_id = $2 and livemode = false and status in ('succeeded', 'partially_refunded', 'refunded', 'disputed') limit 1", [invoiceId, orgId]);
  await announce(db, orgId, invoiceId, "invoice.paid", actor, { paymentId: paid.paymentId, verification: paid.verification, livemode: test.rows.length === 0 });
}

export interface PaymentAnnouncement {
  paymentId: string;
  amountMinor: number;
  verification: "provider_confirmed" | "manual";
  livemode: boolean;
  attemptId?: string | null;
}

/** A payment counted toward the invoice. The provider's word starts workflows (payment.verified); a person's record is a line on the timeline and nothing more. */
export function announcePaymentReceived(db: Queryable, orgId: string, invoiceId: string, actor: Actor, p: PaymentAnnouncement): Promise<void> {
  return announce(db, orgId, invoiceId, p.verification === "provider_confirmed" ? "payment.verified" : "payment.recorded", actor, {
    paymentId: p.paymentId, amountMinor: p.amountMinor, verification: p.verification, livemode: p.livemode, attemptId: p.attemptId ?? null,
  });
}

/** A payment attempt that did not go through. `paymentId` when the provider named a payment, otherwise the attempt and the delivery that reported it. */
export function announcePaymentFailed(db: Queryable, orgId: string, invoiceId: string, actor: Actor, p: { paymentId?: string | null; attemptId?: string | null; providerEventId?: string | null; amountMinor?: number; livemode: boolean }): Promise<void> {
  return announce(db, orgId, invoiceId, "payment.failed", actor, {
    paymentId: p.paymentId ?? null, attemptId: p.attemptId ?? null, providerEventId: p.providerEventId ?? null, amountMinor: p.amountMinor, livemode: p.livemode,
  });
}

export function announceRefunded(db: Queryable, orgId: string, invoiceId: string, actor: Actor, r: { refundId: string; paymentId: string; amountMinor: number; livemode: boolean }): Promise<void> {
  return announce(db, orgId, invoiceId, "payment.refunded", actor, { refundId: r.refundId, paymentId: r.paymentId, amountMinor: r.amountMinor, livemode: r.livemode });
}
