// Fixtures for the customer invoice tests. Synthetic workspaces only: no payment provider is contacted, and every provider payment is recorded straight into the
// database through the same functions the webhooks will call.
import crypto from "node:crypto";
import { withSystem } from "@/server/db";
import { adjustCredits } from "@/server/billing/ledger";
import { publishUnitRate } from "@/server/billing/service";
import { saveCredential } from "@/server/security/credentials";
import { createContact, setContactConsent } from "@/server/crm/contacts";
import { createOpportunity } from "@/server/crm/opportunities";
import { setInvoicesEnabled } from "@/server/invoices/feature";
import { createDraft, issueInvoice, submitForApproval } from "@/server/invoices/invoices";
import { getInvoiceLink } from "@/server/invoices/share";
import { applyPaymentInTx, type ApplyPaymentInput, type ApplyPaymentResult } from "@/server/invoices/apply";
import type { InvoiceDetail } from "@/server/invoices/views";
import type { LineFormInput } from "@/lib/invoices/lines";
import type { DraftInput } from "@/lib/invoices/schemas";
import type { OrgContext } from "@/server/tenancy/context";
import { agencyUser, createUser, ctxFor, uid } from "./fixtures";
import { CRM_ROLES, crmOrg, type CrmOrg, type CrmWho } from "./crm";
import { FIXTURE_RATES } from "./messaging";

export type InvoiceWho = CrmWho | "member";

export interface InvoiceOrg {
  c: CrmOrg;
  orgId: string;
  superAdmin: ReturnType<typeof agencyUser>;
  ctx: (who: InvoiceWho) => OrgContext;
}

/** A client workspace with one person in every client role, with invoicing switched on (pass `enabled: false` for a workspace nobody switched it on for). */
export async function invoiceOrg(opts: { enabled?: boolean; timezone?: string; name?: string } = {}): Promise<InvoiceOrg> {
  const c = await crmOrg({ name: opts.name, timezone: opts.timezone });
  const member = await createUser({ name: "Member Person" });
  await withSystem((db) => db.query("insert into organization_memberships (org_id, user_id, role) values ($1, $2, 'member')", [c.org.id, member.id]));
  const superUser = await createUser({ platformRole: "agency_super_admin", name: "Super Admin" });
  const superAdmin = agencyUser(superUser, "agency_super_admin");
  if (opts.enabled !== false) await setInvoicesEnabled(superAdmin, c.org.id, true);
  const tz = opts.timezone ?? "UTC";
  return {
    c,
    orgId: c.org.id,
    superAdmin,
    ctx: (who) => {
      const person = who === "member" ? member : c.people[who];
      const ctx = ctxFor(person, c.org, who === "member" ? "member" : CRM_ROLES[who]);
      ctx.org.timezone = tz;
      return ctx;
    },
  };
}

let phoneCounter = 1_000_000 + Math.floor(Math.random() * 5_000_000);
export const uniquePhone = () => `+1555${String(phoneCounter++).padStart(7, "0")}`;
export const uniqueEmail = () => `customer-${uid()}-${uid()}@example.test`;

/** A customer in the workspace's CRM. */
export async function contactIn(io: InvoiceOrg, over: { firstName?: string; lastName?: string; email?: string; phone?: string | null; city?: string } = {}): Promise<string> {
  const r = await createContact(io.c.actor("owner"), {
    firstName: over.firstName ?? "Maria", lastName: over.lastName ?? "Santos", email: over.email ?? uniqueEmail(), phone: over.phone === undefined ? uniquePhone() : over.phone,
    addressLine1: "12 Mango Street", city: over.city ?? "Cebu", region: "Cebu", postalCode: "6000", country: "PH",
  });
  return r.id;
}

/** An open deal for a customer. */
export async function dealFor(io: InvoiceOrg, contactId: string, over: { name?: string; ownerId?: string } = {}): Promise<string> {
  const r = await createOpportunity(io.c.actor("owner"), { name: over.name ?? `Deal ${uid()}`, contactId, value: 1500, ownerId: over.ownerId });
  return r.id;
}

export const line = (over: Partial<LineFormInput> = {}): LineFormInput => ({ description: "Service call", quantity: "1", unitPrice: "1500.00", ...over });

/** A draft written by `who` for a fresh customer with one line of 1,500.00 (override anything). */
export async function draftBy(io: InvoiceOrg, who: InvoiceWho = "owner", over: Partial<DraftInput> = {}): Promise<InvoiceDetail> {
  const contactId = over.contactId === undefined ? await contactIn(io) : over.contactId;
  return createDraft(io.ctx(who), { contactId, currency: "PHP", lines: [line()], ...over });
}

/** An issued invoice (written and issued by the owner). */
export async function issuedInvoice(io: InvoiceOrg, over: Partial<DraftInput> = {}, now?: Date): Promise<InvoiceDetail> {
  const d = await draftBy(io, "owner", over);
  return (await issueInvoice(io.ctx("owner"), d.invoice.id, { version: d.invoice.version }, { now })).detail;
}

/** A submitted invoice, waiting for an approver. */
export async function submittedInvoice(io: InvoiceOrg, who: InvoiceWho = "sales", over: Partial<DraftInput> = {}): Promise<InvoiceDetail> {
  const d = await draftBy(io, who, over);
  return submitForApproval(io.ctx(who), d.invoice.id, d.invoice.version);
}

export const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;

/** A synthetic payment connection (simulated provider, test mode). Its sealed credentials are a placeholder: nothing opens them. */
export async function connectionFor(io: InvoiceOrg, over: { provider?: "paymongo" | "paypal" | "simulated"; mode?: "test" | "live" } = {}): Promise<string> {
  const key = `cpk_${Math.random().toString(36).slice(2).padEnd(20, "0").slice(0, 20).replace(/[^a-z0-9]/g, "0")}`;
  const r = await withSystem((db) =>
    db.query<{ id: string }>(
      "insert into customer_payment_connections (org_id, provider, mode, public_key, credentials, status) values ($1, $2, $3, $4, 'sealed-placeholder', 'connected') returning id",
      [io.orgId, over.provider ?? "simulated", over.mode ?? "test", key],
    ),
  );
  return r.rows[0].id;
}

let paymentCounter = 0;
/** What a verified provider event would record: a payment confirmed by the provider, through the same function a webhook calls. */
export function providerPayment(io: InvoiceOrg, invoiceId: string, connectionId: string, amountMinor: number, over: Partial<ApplyPaymentInput> = {}): Promise<ApplyPaymentResult> {
  paymentCounter += 1;
  return withSystem((db) =>
    applyPaymentInTx(db, {
      orgId: io.orgId, invoiceId, amountMinor, currency: "PHP", provider: "simulated", verification: "provider_confirmed", connectionId, providerPaymentId: `pay_${uid()}_${paymentCounter}`,
      livemode: false, receivedAt: new Date("2026-10-23T12:00:00Z"), actor: { id: null, kind: "provider" }, ...over,
    }),
  );
}

const hex = (n: number) => crypto.randomBytes(n).toString("hex");

/**
 * Messaging for an invoice workspace, the way a client has it once set up: email through Resend and text messages through Twilio (synthetic credentials in the test vault,
 * a recorded passing capability test, published rates, credits), quiet hours off. Nothing is sent to anyone: tests dispatch through a recording transport.
 */
export async function addMessaging(io: InvoiceOrg, opts: { credits?: number; channels?: Array<"email" | "sms"> } = {}): Promise<void> {
  const channels = opts.channels ?? ["email", "sms"];
  await withSystem(async (db) => {
    await db.query("update messaging_policy set quiet_hours_start = '00:00', quiet_hours_end = '00:00'");
    await db.query("insert into messaging_settings (org_id, auto_reply_enabled) values ($1, true) on conflict (org_id) do nothing", [io.orgId]);
    for (const channel of channels) {
      const provider = channel === "email" ? "resend" : "twilio";
      const saved = await saveCredential(db, { orgId: io.orgId, provider, label: `${provider} (synthetic test)`, secret: `synthetic-${provider}-credential-${hex(12)}`, actorId: io.superAdmin.id });
      const identity = channel === "email" ? `Invoice Fixture <hello-${hex(3)}@example.test>` : `+1555${String(1_000_000 + crypto.randomInt(8_000_000))}`;
      await db.query(
        `insert into messaging_channels (org_id, channel, provider, enabled, sender_identity, sender_verified_at, registration_status, provider_sender_id, provider_account_id, credential_id, capability_test, capability_tested_at)
         values ($1, $2, $3, true, $4, now(), $5, $6, $7, $8, $9::jsonb, now())`,
        [io.orgId, channel, provider, identity, channel === "email" ? "not_required" : "approved", provider === "resend" ? crypto.randomUUID() : `MG${hex(16)}`, provider === "twilio" ? `AC${hex(16)}` : null, saved.id,
          JSON.stringify({ ok: true, checkedAt: new Date().toISOString(), checks: [{ label: "Synthetic", ok: true, detail: "Test fixture." }] })],
      );
    }
    const credit = Math.round((opts.credits ?? 20) * 1_000_000);
    if (credit > 0) await adjustCredits(db, { orgId: io.orgId, deltaMicros: credit, reason: "seed credit for tests", userId: io.c.people.owner.id });
  });
  if (channels.includes("email")) await publishUnitRate(io.superAdmin, { provider: "resend", unitType: "email_send", wholesaleMicrosPerUnit: FIXTURE_RATES.resend.email_send });
  if (channels.includes("sms")) await publishUnitRate(io.superAdmin, { provider: "twilio", unitType: "sms_segment", wholesaleMicrosPerUnit: FIXTURE_RATES.twilio.sms_segment });
}

/** The customer has agreed to service messages on a channel (consent the business recorded with its evidence), so a reminder may be sent to them. */
export async function consentTo(io: InvoiceOrg, contactId: string, channel: "email" | "sms" = "email"): Promise<void> {
  await setContactConsent(io.c.actor("owner"), contactId, { channel, purpose: "service", status: "granted", evidence: "Signed intake form on file, 12 Oct" });
}

let ipCounter = 0;
/** An address no other test has used, so the per-address limits of the public endpoints never carry from one test to the next. */
export const freshIp = (): string => `203.0.113.${(ipCounter += 1) % 250}-${Math.random().toString(36).slice(2, 8)}`;

/** The customer's link token of an issued invoice, the way the owner gets it from the screen. */
export async function linkTokenOf(io: InvoiceOrg, invoiceId: string): Promise<string> {
  const { url } = await getInvoiceLink(io.ctx("owner"), invoiceId);
  return url.split("/").pop() as string;
}
