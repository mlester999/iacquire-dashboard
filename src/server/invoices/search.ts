import "server-only";
import { withUser } from "@/server/db";
import { AppError } from "@/server/errors";
import type { OrgContext } from "@/server/tenancy/context";
import type { CurrencyCode } from "@/lib/money";
import { assertInvoicesAvailable, invoicesEnabled } from "@/server/invoices/feature";
import { toMinor } from "@/server/invoices/core";
import type { CrmActor } from "@/server/crm/actor";
import { listInvoices, type InvoiceFilter, type InvoiceReader } from "@/server/invoices/invoices";
import type { InvoiceView } from "@/server/invoices/views";

// What the screens around an invoice look things up with: the deal picker on the new-invoice form, the invoices on a customer's or a deal's page, and the payments that need
// a person to look. All of it is read under the signed-in person's own row-level security.

export interface DealChoice {
  id: string;
  name: string;
  contactId: string | null;
  contactName: string | null;
  currency: string | null;
}

/** Open deals whose name matches, for the picker on the new-invoice form. */
export async function searchDealsForInvoice(ctx: OrgContext, q: string, limit = 10): Promise<DealChoice[]> {
  if (!ctx.can("invoices.create")) throw new AppError("forbidden", "Your role can't write invoices.");
  const term = q.trim().slice(0, 80).replace(/[\\%_]/g, (m) => `\\${m}`);
  return withUser(ctx.user.id, async (db) => {
    await assertInvoicesAvailable(db, ctx);
    const { rows } = await db.query<{ id: string; name: string; contact_id: string | null; contact_name: string | null; currency: string | null }>(
      `select o.id, o.name, o.contact_id, c.display_name as contact_name, o.currency
       from crm_opportunities o left join contacts c on c.id = o.contact_id and c.org_id = o.org_id
       where o.org_id = $1 and o.provider = 'native' and o.archived_at is null and o.status = 'open' and ($2 = '' or o.name ilike '%' || $2 || '%' escape '\\')
       order by o.updated_at desc limit $3`,
      [ctx.org.orgId, term, Math.min(25, limit)],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, contactId: r.contact_id, contactName: r.contact_name, currency: r.currency }));
  });
}

/**
 * The invoices of one customer or one deal, for their page. Null when the person should not be offered a panel at all (the module is off for the workspace, they cannot see
 * invoices, or the workspace is an agency's), so the page simply has no Invoices tab.
 */
export async function invoicesForRecord(ctx: InvoiceReader, filter: Pick<InvoiceFilter, "contactId" | "opportunityId">): Promise<InvoiceView[] | null> {
  if (ctx.org.kind !== "client" || !ctx.can("invoices.view")) return null;
  if (!(await invoicesEnabled(ctx.org.orgId))) return null;
  return listInvoices(ctx, { ...filter, limit: 50 }).catch(() => null);
}

/**
 * The same, for a CRM page, which has an actor rather than a signed-in context. An agency person looking in a support session, or an automation, is never offered the panel:
 * an invoice holds a customer's details and the client's finances.
 */
export function invoicesForActor(actor: CrmActor, filter: Pick<InvoiceFilter, "contactId" | "opportunityId">): Promise<InvoiceView[] | null> {
  if (actor.kind !== "member" || !actor.userId) return Promise.resolve(null);
  return invoicesForRecord({ can: (p) => actor.can(p), user: { id: actor.userId }, org: { orgId: actor.orgId, kind: "client", timezone: actor.timezone } }, filter);
}

export interface NeedsLookRow {
  paymentId: string;
  invoiceId: string;
  invoiceNumber: string | null;
  amountMinor: number;
  currency: CurrencyCode;
  status: "needs_review" | "disputed" | "pending";
  provider: string;
  at: string;
}

/** Payments a person has to look at: kept for review (they count for nothing until someone decides), disputed, or still pending at the provider. Newest first. */
export async function paymentsNeedingLook(ctx: OrgContext, limit = 25): Promise<NeedsLookRow[]> {
  if (!ctx.can("invoices.view")) throw new AppError("forbidden", "Your role can't see invoices.");
  return withUser(ctx.user.id, async (db) => {
    await assertInvoicesAvailable(db, ctx);
    const { rows } = await db.query<{ id: string; invoice_id: string; number: string | null; amount_minor: string; currency: CurrencyCode; status: NeedsLookRow["status"]; provider: string; updated_at: Date }>(
      `select p.id, p.invoice_id, i.number, p.amount_minor::text as amount_minor, p.currency, p.status, p.provider, p.updated_at
       from customer_payments p join customer_invoices i on i.id = p.invoice_id and i.org_id = p.org_id
       where p.org_id = $1 and p.status in ('needs_review', 'disputed', 'pending') order by p.updated_at desc limit $2`,
      [ctx.org.orgId, Math.min(Math.max(limit, 1), 100)],
    );
    return rows.map((r) => ({ paymentId: r.id, invoiceId: r.invoice_id, invoiceNumber: r.number, amountMinor: toMinor(r.amount_minor), currency: r.currency, status: r.status, provider: r.provider, at: new Date(r.updated_at).toISOString() }));
  });
}
