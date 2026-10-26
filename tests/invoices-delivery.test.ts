// Sending an issued invoice's link to the customer through the real consent-gated send chain (message scope "delivery"), on embedded Postgres: what the sender is shown, what the
// chain says, every way it refuses, what stops a message that has not gone out, a double click, a new link, and a customer's link that is never stored. Every provider is a
// recording stand-in; nothing leaves the process.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { setContactConsent } from "@/server/crm/contacts";
import { redactContact, suppressAddress } from "@/server/messaging/contacts";
import { deliveryConversation } from "@/server/messaging/delivery";
import { dispatchMessage, queueOutbound } from "@/server/messaging/send";
import { buildExport } from "@/server/offboarding/export";
import { readZip } from "@/server/offboarding/zip";
import { setRetentionPaused } from "@/server/retention/service";
import { setInvoicesEnabled } from "@/server/invoices/feature";
import { invoiceLinkUrl, invoiceTokenFor } from "@/server/invoices/links";
import { applyDisputeInTx } from "@/server/invoices/apply";
import { invoiceDeliveriesFor, invoiceLinkForDelivery, previewInvoiceDelivery, sendInvoiceDelivery, type InvoiceDeliveryPreview, type SendInvoiceDeliveryResult } from "@/server/invoices/delivery";
import { getInvoiceDetail, voidInvoice, writeOffInvoice } from "@/server/invoices/invoices";
import { recordManualPayment } from "@/server/invoices/payments";
import { rotateInvoiceLink } from "@/server/invoices/share";
import { loadPublicInvoice } from "@/server/invoices/public";
import { recordingProvider } from "./support/messaging";
import {
  addMessaging, connectionFor, consentTo, contactIn, draftBy, freshIp, invoiceOrg, issuedInvoice, issuedTestInvoice, providerPayment, rows, submittedInvoice, uniqueEmail, uniquePhone, type InvoiceOrg,
} from "./support/invoices";

const NOW = new Date("2026-10-23T12:00:00Z");
const TOKEN_RE = /\/pay\/([A-Za-z0-9_-]{43})/;
const cash = (amount: string) => ({ amount, receivedOn: "2026-10-23", method: "cash" as const, evidence: "Cash, receipt 12" });

interface Shop {
  io: InvoiceOrg;
  contactId: string;
  email: string;
  phone: string;
  id: string;
  /** The customer's address for the invoice, as the team would copy it. */
  url: string;
  token: string;
}

async function shop(opts: { channels?: Array<"email" | "sms">; consent?: Array<"email" | "sms">; credits?: number; timezone?: string; firstName?: string } = {}): Promise<Shop> {
  const io = await invoiceOrg({ timezone: opts.timezone });
  await addMessaging(io, { credits: opts.credits, channels: opts.channels });
  const email = uniqueEmail();
  const phone = uniquePhone();
  const contactId = await contactIn(io, { firstName: opts.firstName ?? "Maria", email, phone });
  for (const channel of opts.consent ?? ["email"]) await consentTo(io, contactId, channel);
  const inv = await issuedInvoice(io, { contactId }, NOW);
  const token = invoiceTokenFor(inv.invoice.id, 1);
  return { io, contactId, email, phone, id: inv.invoice.id, url: invoiceLinkUrl(token), token };
}

async function read(s: Shop, channel: "email" | "sms" | "whatsapp" = "email", who: "owner" | "manager" = "owner", now = NOW): Promise<InvoiceDeliveryPreview> {
  const r = await previewInvoiceDelivery(s.io.ctx(who), s.id, channel, { now });
  if (!r.available) throw new Error(`not available: ${r.text}`);
  return r;
}

/** Reads the message and confirms exactly what was read, as the owner. */
async function send(s: Shop, channel: "email" | "sms" | "whatsapp" = "email", now = NOW): Promise<SendInvoiceDeliveryResult> {
  const pre = await read(s, channel, "owner", now);
  return sendInvoiceDelivery(s.io.ctx("owner"), s.id, { channel, linkVersion: pre.linkVersion, wordingHash: pre.wordingHash }, { now });
}

const deliveries = (id: string) => rows<{ id: string; link_version: number; channel: string; message_id: string | null; wording_version: string; wording_hash: string; address_mask: string | null; requested_by: string | null; withdrawn_at: Date | null; withdrawn_reason: string | null }>(
  "select id, link_version, channel, message_id, wording_version, wording_hash, address_mask, requested_by, withdrawn_at, withdrawn_reason from customer_invoice_deliveries where invoice_id = $1 order by created_at, id", [id],
);
const message = async (id: string) => (await rows<{ id: string; status: string; scope: string; purpose: string; body: string; author_kind: string; author_user_id: string | null; dedupe_key: string | null; blocked_reason: string | null; status_detail: string | null; send_after: Date; reservation_id: string | null; channel: string; thread_key: string; subject: string | null; owner_kind: string }>(
  `select m.id, m.status, m.scope, m.purpose, m.body, m.author_kind, m.author_user_id, m.dedupe_key, m.blocked_reason, m.status_detail, m.send_after, m.reservation_id, c.channel, c.thread_key, c.subject, c.owner_kind
   from conversation_messages m join conversations c on c.id = m.conversation_id where m.id = $1`, [id],
))[0];
const onlyMessage = async (invoiceId: string, n = 0) => {
  const d = await deliveries(invoiceId);
  if (!d[n]?.message_id) throw new Error(`no delivery message #${n}`);
  return message(d[n].message_id as string);
};
const reservation = async (id: string | null) => (id ? (await rows<{ status: string }>("select status from usage_reservations where id = $1", [id]))[0]?.status : undefined);
const eventKinds = async (id: string) => (await rows<{ kind: string }>("select kind from customer_invoice_events where invoice_id = $1 order by id", [id])).map((e) => e.kind);
const messageCount = async (orgId: string) => Number((await rows<{ n: string }>("select count(*)::text as n from conversation_messages where org_id = $1", [orgId]))[0].n);

async function withQuietHours<T>(start: string, end: string, run: () => Promise<T>): Promise<T> {
  await withSystem((db) => db.query("update messaging_policy set quiet_hours_start = $1, quiet_hours_end = $2", [start, end]));
  try {
    return await run();
  } finally {
    await withSystem((db) => db.query("update messaging_policy set quiet_hours_start = '00:00', quiet_hours_end = '00:00'"));
  }
}

/** A message that is queued and waiting for sending hours (quiet hours 11:00 to 14:00 around the fixed clock), so the things that stop it can be tried. */
async function waiting(s: Shop, channel: "email" | "sms" = "email") {
  const r = await withQuietHours("11:00", "14:00", () => send(s, channel));
  if (r.status !== "queued") throw new Error(`not queued: ${JSON.stringify(r)}`);
  expect(r.waitingUntil).not.toBeNull();
  return r;
}

const spies: Array<ReturnType<typeof vi.spyOn>> = [];
function captureLogs(): string[] {
  const seen: string[] = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const spy = vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void seen.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")));
    spies.push(spy);
  }
  return seen;
}
beforeEach(() => {
  delete process.env.INVOICES_PUBLIC_DISABLED;
  resetEnvCache();
});
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
  delete process.env.INVOICES_PUBLIC_DISABLED;
  resetEnvCache();
});

describe("what the sender is shown before anything is sent", () => {
  it("is the exact message with the customer's link as words, where it would go (masked), and what the chain says, and it writes nothing", async () => {
    const s = await shop();
    const before = await messageCount(s.io.orgId);
    const pre = await read(s);
    expect(pre).toMatchObject({ available: true, linkVersion: 1, channel: "email", channelLabel: "Email", usesCredits: false, wordingIsDraft: true, standing: null, remaining: 6 });
    expect(pre.subject).toMatch(/^Invoice INV-0001 from /);
    expect(pre.body).toContain("Hi Maria,");
    expect(pre.body).toContain("for PHP 1,500.00 is ready for you. It is due on 6 Nov 2026.");
    expect(pre.body).toContain("[the customer's own link to the invoice]");
    expect(pre.body).not.toContain("{{");
    expect(pre.body).not.toContain(s.token);
    expect(pre.addressMask).toBe(`${s.email[0]}***${s.email.slice(s.email.lastIndexOf("@"))}`);
    expect(pre.addressMask).not.toContain(s.email);
    expect(pre.verdict).toMatchObject({ kind: "ready", reason: null });
    expect(pre.verdict.text).toContain("Nothing is sent until you confirm");
    expect(pre.wordingHash).toMatch(/^[0-9a-f]{64}$/);
    // Nothing was made: no message, no conversation, no delivery, no history line.
    expect(await messageCount(s.io.orgId)).toBe(before);
    expect(await rows("select 1 from conversations where org_id = $1", [s.io.orgId])).toHaveLength(0);
    expect(await deliveries(s.id)).toHaveLength(0);
    expect(await eventKinds(s.id)).not.toContain("delivery_queued");
  });

  it("marks a text message as using prepaid credits, and shows no subject", async () => {
    const s = await shop({ consent: ["email", "sms"] });
    const pre = await read(s, "sms");
    expect(pre).toMatchObject({ available: true, channel: "sms", subject: null, usesCredits: true });
    expect(pre.addressMask).toBe(`***${s.phone.slice(-4)}`);
    expect(pre.body).not.toContain("\n");
  });

  it("is for people who can send invoices only, and says the true reason first when the workspace has no invoicing", async () => {
    const s = await shop();
    for (const who of ["owner", "manager"] as const) await expect(previewInvoiceDelivery(s.io.ctx(who), s.id, "email", { now: NOW }), who).resolves.toMatchObject({ available: true });
    for (const who of ["sales", "setter", "support", "viewer", "member"] as const) await expect(previewInvoiceDelivery(s.io.ctx(who), s.id, "email", { now: NOW }), who).rejects.toMatchObject({ code: "forbidden" });
    await expect(previewInvoiceDelivery(s.io.ctx("owner"), s.id, "carrier_pigeon", { now: NOW })).rejects.toMatchObject({ code: "invalid_input" });
    await setInvoicesEnabled(s.io.superAdmin, s.io.orgId, false);
    await expect(previewInvoiceDelivery(s.io.ctx("viewer"), s.id, "email", { now: NOW })).rejects.toMatchObject({ code: "not_enabled" });
  });

  describe("says why a message cannot be offered at all, in words, without throwing", () => {
    const unavailable = async (s: Shop, id: string, reason: string, text: RegExp) => {
      const r = await previewInvoiceDelivery(s.io.ctx("owner"), id, "email", { now: NOW });
      expect(r).toMatchObject({ available: false, reason });
      expect((r as { text: string }).text).toMatch(text);
    };

    it("for an invoice that is not issued: a draft, one waiting for approval and a void one", async () => {
      const s = await shop();
      const draft = await draftBy(s.io, "owner", { contactId: s.contactId });
      await unavailable(s, draft.invoice.id, "not_issued", /after it is issued/);
      const waitingOne = await submittedInvoice(s.io, "sales", { contactId: s.contactId });
      await unavailable(s, waitingOne.invoice.id, "not_issued", /after it is issued/);
      await voidInvoice(s.io.ctx("owner"), s.id, { reason: "Raised for the wrong job" });
      await unavailable(s, s.id, "not_issued", /void/);
    });

    it("for a test invoice, which is never sent to a customer", async () => {
      const s = await shop();
      const test = await issuedTestInvoice(s.io, { contactId: s.contactId }, NOW);
      await unavailable(s, test.invoice.id, "test_invoice", /test invoice is never sent to a customer/);
    });

    it("for an invoice that is paid, written off or disputed", async () => {
      const s = await shop();
      const conn = await connectionFor(s.io);
      const paid = await issuedInvoice(s.io, { contactId: s.contactId }, NOW);
      await recordManualPayment(s.io.ctx("owner"), paid.invoice.id, cash("1500.00"), { now: NOW });
      await unavailable(s, paid.invoice.id, "paid", /paid, so there is nothing to send/);
      const off = await issuedInvoice(s.io, { contactId: s.contactId }, NOW);
      await writeOffInvoice(s.io.ctx("owner"), off.invoice.id, { reason: "The customer closed their business" });
      await unavailable(s, off.invoice.id, "written_off", /written off/);
      const disputed = await issuedInvoice(s.io, { contactId: s.contactId }, NOW);
      const part = await providerPayment(s.io, disputed.invoice.id, conn, 50_000, { livemode: true });
      await withSystem((db) => applyDisputeInTx(db, { orgId: s.io.orgId, paymentId: part.paymentId, open: true, actor: { id: null, kind: "provider" } }));
      await unavailable(s, disputed.invoice.id, "disputed", /disputed/);
    });

    it("for an invoice with no customer record, a removed one, or a link that can no longer be shown", async () => {
      const s = await shop();
      const noCustomer = await issuedInvoice(s.io, { contactId: s.contactId }, NOW);
      await withSystem((db) => db.query("update customer_invoices set contact_id = null where id = $1", [noCustomer.invoice.id]));
      await unavailable(s, noCustomer.invoice.id, "no_customer", /not linked to a customer record/);
      const gone = await issuedInvoice(s.io, { contactId: await contactIn(s.io) }, NOW);
      await withSystem((db) => db.query("update contacts set archived_at = now() where id = (select contact_id from customer_invoices where id = $1)", [gone.invoice.id]));
      await unavailable(s, gone.invoice.id, "contact_unreachable", /removed or archived/);
      await withSystem((db) => db.query("update customer_invoices set public_token_hash = null where id = $1", [s.id]));
      await unavailable(s, s.id, "no_link", /Replace the link first/);
    });

    it("while the platform's emergency stop for invoice links is on, because a link sent now would not open", async () => {
      const s = await shop();
      process.env.INVOICES_PUBLIC_DISABLED = "true";
      resetEnvCache();
      await unavailable(s, s.id, "public_pages_off", /would not open/);
      await expect(sendInvoiceDelivery(s.io.ctx("owner"), s.id, { channel: "email", linkVersion: 1, wordingHash: "a".repeat(64) }, { now: NOW })).resolves.toMatchObject({ status: "refused", reason: "public_pages_off" });
      expect(await deliveries(s.id)).toHaveLength(0);
    });
  });

  it("tells a waiting message from a refused one", async () => {
    const s = await shop();
    const pre = await withQuietHours("11:00", "14:00", () => read(s));
    expect(pre.verdict).toMatchObject({ kind: "waiting", reason: "quiet_hours", waitingUntil: "2026-10-23T14:00:00.000Z" });
    expect(pre.verdict.text).toContain("Nothing is sent until you confirm");
  });
});

describe("what the send chain says no to, and that nothing is left behind", () => {
  const refusal = async (s: Shop, channel: "email" | "sms", reason: string) => {
    const pre = await read(s, channel);
    expect(pre.verdict, `preview ${reason}`).toMatchObject({ kind: "refused", reason });
    expect(pre.verdict.text).toMatch(/can't be sent/);
    const r = await sendInvoiceDelivery(s.io.ctx("owner"), s.id, { channel, linkVersion: 1, wordingHash: pre.wordingHash }, { now: NOW });
    expect(r, `send ${reason}`).toMatchObject({ status: "refused", reason });
    // No half-made message, conversation, credit hold or delivery; one audit line.
    expect(await messageCount(s.io.orgId)).toBe(0);
    expect(await rows("select 1 from conversations where org_id = $1", [s.io.orgId])).toHaveLength(0);
    expect(await deliveries(s.id)).toHaveLength(0);
    expect(await rows("select 1 from usage_reservations where org_id = $1 and status = 'held'", [s.io.orgId])).toHaveLength(0);
    const audit = await rows<{ result: string; metadata: Record<string, unknown> }>("select result, metadata from audit_logs where org_id = $1 and action = 'invoice.delivery_refused' order by created_at desc limit 1", [s.io.orgId]);
    expect(audit[0]).toMatchObject({ result: "denied", metadata: { linkVersion: 1, channel, reason } });
    return r as Extract<SendInvoiceDeliveryResult, { status: "refused" }>;
  };

  it("refuses a customer who has not agreed to messages on the channel, and sends once they have", async () => {
    const s = await shop({ consent: [] });
    const r = await refusal(s, "email", "no_consent");
    expect(r.text).toContain("There is no consent on record");
    await setContactConsent(s.io.c.actor("owner"), s.contactId, { channel: "email", purpose: "service", status: "granted", evidence: "Signed intake form on file, 12 Oct" });
    expect(await send(s)).toMatchObject({ status: "queued" });
  });

  it("keeps the channels apart: consent to email is not consent to text messages", async () => {
    const s = await shop({ consent: ["email"] });
    await refusal(s, "sms", "no_consent");
    expect(await send(s, "email")).toMatchObject({ status: "queued" });
  });

  it("refuses a customer who withdrew consent, and an address that opted out or bounced", async () => {
    const s = await shop();
    await setContactConsent(s.io.c.actor("owner"), s.contactId, { channel: "email", purpose: "service", status: "revoked", evidence: "Asked to stop, 20 Oct" });
    await refusal(s, "email", "no_consent");
    const t = await shop();
    await withSystem((db) => suppressAddress(db, { orgId: t.io.orgId, channel: "email", address: t.email, reason: "opt_out", source: "test" }));
    await refusal(t, "email", "suppressed");
  });

  it("refuses a channel the workspace has not set up, and a customer with no address on it", async () => {
    const s = await shop({ consent: ["email", "sms"] });
    await withSystem((db) => db.query("update messaging_channels set enabled = false where org_id = $1 and channel = 'sms'", [s.io.orgId]));
    await refusal(s, "sms", "channel_not_ready");
    const t = await shop({ consent: ["email", "sms"] });
    await withSystem((db) => db.query("delete from contact_identities where org_id = $1 and contact_id = $2 and kind <> 'email'", [t.io.orgId, t.contactId]));
    await refusal(t, "sms", "contact_unreachable");
  });

  it("refuses when the workspace has no service credits", async () => {
    const s = await shop({ credits: 0 });
    await refusal(s, "email", "credits");
  });

  it("refuses an address a website visitor typed and nobody has confirmed, as it does for every automatic message", async () => {
    const s = await shop();
    await withSystem((db) => db.query("update contact_identities set typed_by_visitor = true, verified = false where org_id = $1 and contact_id = $2", [s.io.orgId, s.contactId]));
    const r = await refusal(s, "email", "identity_unverified");
    expect(r.text).toContain("typed this address or number into the website chat and nobody has confirmed it");
  });

  it("refuses a customer a person on the team excluded from automatic messages", async () => {
    const s = await shop();
    await withSystem((db) => db.query("update contacts set retention_paused = true where id = $1", [s.contactId]));
    const r = await refusal(s, "email", "held_by_person");
    expect(r.text).toContain("A person on your team excluded this customer from automatic messages");
  });

  it("refuses while customer messaging is paused, and for a suspended workspace", async () => {
    const s = await shop();
    await withSystem((db) => db.query("insert into automation_pauses (org_id, scope, active, reason) values ($1, 'messaging', true, 'Reviewing replies')", [s.io.orgId]));
    await refusal(s, "email", "automation_paused");
    const t = await shop();
    await withSystem((db) => db.query("update organizations set status = 'suspended' where id = $1", [t.io.orgId]));
    await refusal(t, "email", "org_inactive");
  });

  it("does not turn a final refusal into a wait just because quiet hours are on", async () => {
    const s = await shop({ consent: [] });
    await withQuietHours("11:00", "14:00", async () => {
      expect((await read(s)).verdict.kind).toBe("refused");
    });
  });
});

describe("sending", () => {
  it("queues the message the person read, as the chain's own record, with the link as words", async () => {
    const s = await shop();
    const pre = await read(s);
    const r = await sendInvoiceDelivery(s.io.ctx("owner"), s.id, { channel: "email", linkVersion: pre.linkVersion, wordingHash: pre.wordingHash }, { now: NOW });
    expect(r).toMatchObject({ status: "queued", waitingUntil: null, delivery: { channel: "email", state: "queued", label: "Queued", ended: false, linkVersion: 1, addressMask: pre.addressMask } });

    const [d] = await deliveries(s.id);
    expect(d).toMatchObject({ link_version: 1, channel: "email", wording_version: pre.wordingVersion, wording_hash: pre.wordingHash, address_mask: pre.addressMask, requested_by: s.io.c.people.owner.id, withdrawn_at: null });
    const m = await message(d.message_id as string);
    expect(m).toMatchObject({
      status: "queued", scope: "delivery", purpose: "service", author_kind: "system", author_user_id: s.io.c.people.owner.id, channel: "email", owner_kind: "unassigned",
      dedupe_key: `invoice-delivery:${s.id}:1:email`, thread_key: `invoice:${s.id}`, subject: pre.subject,
    });
    expect(m.body).toContain("{{invoice.link}}");
    expect(m.body).not.toContain(s.token);
    expect(m.body).not.toMatch(/https?:/);
    expect(m.reservation_id).not.toBeNull();
    expect(await reservation(m.reservation_id)).toBe("held");
    expect(await eventKinds(s.id)).toContain("delivery_queued");
    const audit = await rows<{ actor_user_id: string; result: string; metadata: Record<string, unknown> }>("select actor_user_id, result, metadata from audit_logs where org_id = $1 and action = 'invoice.delivery_queued'", [s.io.orgId]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_user_id: s.io.c.people.owner.id, result: "success", metadata: { number: "INV-0001", linkVersion: 1, channel: "email", deliveryId: d.id, wordingVersion: pre.wordingVersion } });
    // Where it went is kept on the delivery only, which a privacy request can clear; the history and the audit line, which stay, do not carry any part of the address.
    const history = await rows<{ detail: Record<string, unknown> }>("select detail from customer_invoice_events where invoice_id = $1 and kind = 'delivery_queued'", [s.id]);
    expect(history).toHaveLength(1);
    expect(history[0].detail).toEqual({ channel: "email", deliveryId: d.id, waitingUntil: null });
    for (const stored of [JSON.stringify(audit), JSON.stringify(history)]) {
      expect(stored).not.toContain("***");
      expect(stored).not.toContain(s.email);
      expect(stored).not.toContain(s.email.slice(s.email.lastIndexOf("@")));
    }
  });

  it("hands the provider the real link, once, to the customer's address, and keeps it out of everything else", async () => {
    const logs = captureLogs();
    const s = await shop();
    await send(s);
    const m = await onlyMessage(s.id);
    const rec = recordingProvider("resend");
    expect((await dispatchMessage(m.id, { transport: rec.transport, now: NOW })).status).toBe("sent");
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].to).toBe(s.email);
    expect(rec.calls[0].channel).toBe("email");
    expect(rec.calls[0].subject).toMatch(/^Invoice INV-0001/);
    const link = TOKEN_RE.exec(rec.calls[0].body);
    expect(link, rec.calls[0].body).not.toBeNull();
    expect(rec.calls[0].body.match(/\/pay\//g)).toHaveLength(1);
    expect(rec.calls[0].body).not.toContain("{{");
    // It is the very link the team would copy, and it opens the invoice.
    expect(link![1]).toBe(s.token);
    expect(rec.calls[0].body).toContain(s.url);
    expect(await loadPublicInvoice(s.token, { ip: freshIp() })).toMatchObject({ state: "ok" });

    // The stored message is unchanged and the conversation's preview is masked.
    const after = await message(m.id);
    expect(after.status).toBe("sent");
    expect(after.body).toContain("{{invoice.link}}");
    expect(after.body).not.toContain(s.token);
    const preview = (await rows<{ last_message_preview: string }>("select last_message_preview from conversations where id = (select conversation_id from conversation_messages where id = $1)", [m.id]))[0].last_message_preview;
    expect(preview).toContain("[customer invoice link]");
    expect(preview).not.toContain(s.token);

    // The token is in no table at all, in no log line, and not in the client's own export.
    const tables = ["conversation_messages", "conversations", "customer_invoice_events", "customer_invoice_deliveries", "customer_invoices", "customer_invoice_reminders", "audit_logs", "notifications",
      "crm_events", "crm_activities", "metered_usage_events", "usage_reservations", "credit_ledger_entries", "email_outbox"];
    for (const table of tables) {
      const hit = await rows<{ n: string }>(`select count(*)::text as n from ${table} t where t::text like $1`, [`%${s.token}%`]);
      expect(Number(hit[0].n), `${table} holds the customer's link`).toBe(0);
    }
    const files = readZip((await buildExport(s.io.orgId)).bytes);
    expect(files.find((f) => f.name === "conversations/messages.json")!.data.toString("utf8")).toContain("[customer invoice link]");
    expect(files.some((f) => f.name === "invoices/deliveries.json")).toBe(true);
    for (const f of files) {
      const text = f.data.toString("utf8");
      expect(text, f.name).not.toContain(s.token);
      expect(text, f.name).not.toContain("{{invoice.link}}");
    }
    expect(logs.join("\n")).not.toContain(s.token);
  });

  it("says 'sent' only once the provider has taken the message, and never delivered or read, whatever the provider says later", async () => {
    const s = await shop();
    await send(s);
    const m = await onlyMessage(s.id);
    let detail = await getInvoiceDetail(s.io.ctx("owner"), s.id, { now: NOW });
    expect(detail.deliveries[0]).toMatchObject({ state: "queued", label: "Queued" });
    expect((await dispatchMessage(m.id, { transport: recordingProvider("resend").transport, now: NOW })).status).toBe("sent");
    detail = await getInvoiceDetail(s.io.ctx("owner"), s.id, { now: NOW });
    expect(detail.deliveries[0]).toMatchObject({ state: "sent", label: "Sent by email", tone: "success", channelLabel: "Email", requestedByName: expect.any(String) });
    for (const status of ["delivered", "read"]) {
      await withSystem((db) => db.query("update conversation_messages set status = $2 where id = $1", [m.id, status]));
      detail = await getInvoiceDetail(s.io.ctx("owner"), s.id, { now: NOW });
      expect(`${detail.deliveries[0].label} ${detail.deliveries[0].explain}`).not.toMatch(/\b(delivered|read|received|opened|seen)\b/i);
      expect(detail.deliveries[0].label).toBe("Sent by email");
    }
  });

  it("tells a failure from a refusal, and lets the same channel try again once a message has ended without reaching the customer", async () => {
    const s = await shop();
    await send(s);
    const first = await onlyMessage(s.id);
    const refusing = recordingProvider("resend", () => ({ ok: false, retryable: false, error: "The address was refused." }));
    expect((await dispatchMessage(first.id, { transport: refusing.transport, now: NOW })).status).toBe("failed");
    let view = (await getInvoiceDetail(s.io.ctx("owner"), s.id, { now: NOW })).deliveries[0];
    expect(view).toMatchObject({ state: "failed", label: "Not sent", ended: true });
    expect(view.explain).toContain("The email provider refused the message: The address was refused. Nothing reached the customer.");
    // The same channel may be tried again; the failed message's key is spent, so the new one takes the next number.
    expect(await send(s)).toMatchObject({ status: "queued" });
    const second = await message((await deliveries(s.id))[1].message_id as string);
    expect(second.dedupe_key).toBe(`invoice-delivery:${s.id}:1:email:1`);
    expect((await dispatchMessage(second.id, { transport: recordingProvider("resend").transport, now: NOW })).status).toBe("sent");
    await withSystem((db) => db.query("update conversation_messages set status = 'failed', failure_kind = 'rejected', status_detail = 'The mailbox is full.' where id = $1", [second.id]));
    view = (await getInvoiceDetail(s.io.ctx("owner"), s.id, { now: NOW })).deliveries[0];
    expect(view).toMatchObject({ state: "failed", label: "Failed after it was sent", ended: true });
    expect(view.explain).toContain("took the message");
    expect(view.explain).not.toContain("Nothing reached the customer");
    const third = await shop();
    await send(third);
    const silent = recordingProvider("resend", () => ({ ok: false, retryable: false, error: "Resend did not confirm the send. The message was not confirmed sent." }));
    expect((await dispatchMessage((await onlyMessage(third.id)).id, { transport: silent.transport, now: NOW })).status).toBe("failed");
    expect((await getInvoiceDetail(third.io.ctx("owner"), third.id, { now: NOW })).deliveries[0]).toMatchObject({ state: "failed", label: "Not confirmed", ended: true });
  });

  it("sends a text message to the customer's phone in one line, through the carrier that carries the workspace's texts", async () => {
    const s = await shop({ consent: ["email", "sms"] });
    expect(await send(s, "sms")).toMatchObject({ status: "queued", delivery: { channel: "sms" } });
    const m = await onlyMessage(s.id);
    expect(m).toMatchObject({ channel: "sms", dedupe_key: `invoice-delivery:${s.id}:1:sms`, scope: "delivery" });
    const rec = recordingProvider("twilio");
    expect((await dispatchMessage(m.id, { transport: rec.transport, now: NOW })).status).toBe("sent");
    expect(rec.calls[0].to).toBe(s.phone);
    expect(rec.calls[0].body).toContain(s.url);
    expect(rec.calls[0].body).not.toContain("\n");
    expect((await deliveries(s.id))[0].address_mask).toBe(`***${s.phone.slice(-4)}`);
  });

  it("records where the message really went, masked, at the moment it was sent", async () => {
    const s = await shop();
    await send(s);
    const m = await onlyMessage(s.id);
    await withSystem((db) => db.query("update contact_identities set value = $3 where org_id = $1 and contact_id = $2 and kind = 'email'", [s.io.orgId, s.contactId, "new.address@example.test"]));
    const rec = recordingProvider("resend");
    await dispatchMessage(m.id, { transport: rec.transport, now: NOW });
    expect(rec.calls[0].to).toBe("new.address@example.test");
    expect((await deliveries(s.id))[0].address_mask).toBe("n***@example.test");
  });

  it("sends a double click once, and a second person's click returns the first message", async () => {
    const s = await shop();
    const pre = await read(s);
    const input = { channel: "email" as const, linkVersion: 1, wordingHash: pre.wordingHash };
    const [a, b] = await Promise.all([sendInvoiceDelivery(s.io.ctx("owner"), s.id, input, { now: NOW }), sendInvoiceDelivery(s.io.ctx("manager"), s.id, input, { now: NOW })]);
    expect([a.status, b.status].sort()).toEqual(["already", "queued"]);
    expect(await deliveries(s.id)).toHaveLength(1);
    expect(await rows("select 1 from conversation_messages where org_id = $1 and scope = 'delivery'", [s.io.orgId])).toHaveLength(1);
    expect(await sendInvoiceDelivery(s.io.ctx("owner"), s.id, input, { now: NOW })).toMatchObject({ status: "already", delivery: { channel: "email", state: "queued" } });
    // After the provider took it, a request still sends nothing new.
    await dispatchMessage((await onlyMessage(s.id)).id, { transport: recordingProvider("resend").transport, now: NOW });
    expect(await sendInvoiceDelivery(s.io.ctx("owner"), s.id, input, { now: NOW })).toMatchObject({ status: "already", delivery: { state: "sent", label: "Sent by email" } });
    expect(await deliveries(s.id)).toHaveLength(1);
    expect(await rows("select 1 from audit_logs where org_id = $1 and action = 'invoice.delivery_queued'", [s.io.orgId])).toHaveLength(1);
    expect((await eventKinds(s.id)).filter((k) => k === "delivery_queued")).toHaveLength(1);
  });

  it("allows the same link a message on another channel, and not the same one twice", async () => {
    const s = await shop({ consent: ["email", "sms"] });
    expect(await send(s, "email")).toMatchObject({ status: "queued" });
    expect(await send(s, "sms")).toMatchObject({ status: "queued" });
    expect(await send(s, "email")).toMatchObject({ status: "already" });
    expect((await deliveries(s.id)).map((d) => d.channel)).toEqual(["email", "sms"]);
  });

  it("refuses a message that is not the one the person read, and a link that is not the one they looked at", async () => {
    const s = await shop();
    const pre = await read(s);
    const base = { channel: "email" as const, linkVersion: 1, wordingHash: pre.wordingHash };
    const as = (over: Record<string, unknown>) => sendInvoiceDelivery(s.io.ctx("owner"), s.id, { ...base, ...over } as typeof base, { now: NOW });
    await expect(as({ wordingHash: "0".repeat(64) })).rejects.toMatchObject({ code: "conflict" });
    await expect(as({ channel: "sms" })).rejects.toMatchObject({ code: "conflict" });
    await expect(as({ linkVersion: 2 })).rejects.toMatchObject({ code: "conflict" });
    await expect(as({ wordingHash: "not a hash" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(as({ linkVersion: 0 })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(as({ channel: "fax" })).rejects.toMatchObject({ code: "invalid_input" });
    expect(await deliveries(s.id)).toHaveLength(0);
    // The wording changes if the customer's first name does: what was read is then stale.
    await withSystem((db) => db.query("update contacts set first_name = 'Marie' where id = $1", [s.contactId]));
    await expect(as({})).rejects.toThrow(/changed since you read it/);
  });

  it("is for people who can send invoices only, and only for this workspace's invoices", async () => {
    const s = await shop();
    const pre = await read(s);
    const input = { channel: "email" as const, linkVersion: 1, wordingHash: pre.wordingHash };
    for (const who of ["sales", "setter", "support", "viewer", "member"] as const) await expect(sendInvoiceDelivery(s.io.ctx(who), s.id, input, { now: NOW }), who).rejects.toMatchObject({ code: "forbidden" });
    // Another workspace's owner cannot preview or send for it, nor see its messages.
    const other = await shop();
    await expect(previewInvoiceDelivery(other.io.ctx("owner"), s.id, "email", { now: NOW })).rejects.toMatchObject({ code: "not_found" });
    await expect(sendInvoiceDelivery(other.io.ctx("owner"), s.id, input, { now: NOW })).rejects.toMatchObject({ code: "not_found" });
    await expect(getInvoiceDetail(other.io.ctx("owner"), s.id)).rejects.toMatchObject({ code: "not_found" });
    expect(await withSystem((db) => invoiceDeliveriesFor(db, other.io.orgId, s.id))).toEqual([]);
    expect(await deliveries(s.id)).toHaveLength(0);
    expect(await messageCount(s.io.orgId)).toBe(0);
  });

  it("does nothing for a workspace a Super Admin has not switched invoicing on for", async () => {
    const s = await shop();
    await setInvoicesEnabled(s.io.superAdmin, s.io.orgId, false);
    await expect(previewInvoiceDelivery(s.io.ctx("owner"), s.id, "email", { now: NOW })).rejects.toMatchObject({ code: "not_enabled" });
    await expect(sendInvoiceDelivery(s.io.ctx("owner"), s.id, { channel: "email", linkVersion: 1, wordingHash: "a".repeat(64) }, { now: NOW })).rejects.toMatchObject({ code: "not_enabled" });
  });

  it("is never done for a test invoice, by the service or by the database", async () => {
    const s = await shop();
    const test = await issuedTestInvoice(s.io, { contactId: s.contactId }, NOW);
    expect(await sendInvoiceDelivery(s.io.ctx("owner"), test.invoice.id, { channel: "email", linkVersion: 1, wordingHash: (await read(s)).wordingHash }, { now: NOW })).toMatchObject({ status: "refused", reason: "test_invoice" });
    expect(await rows("select 1 from conversation_messages where org_id = $1", [s.io.orgId])).toHaveLength(0);
    await expect(withSystem(async (db) => {
      const conv = await deliveryConversation(db, { orgId: s.io.orgId, contactId: s.contactId, channel: "email", threadKey: "probe", subject: null });
      const queued = await queueOutbound(db, { orgId: s.io.orgId, conversationId: conv, scope: "delivery", actor: { kind: "system", userId: s.io.c.people.owner.id }, body: "x {{invoice.link}}", now: NOW, businessHoursOnly: false });
      await db.query("insert into customer_invoice_deliveries (org_id, invoice_id, link_version, channel, message_id, wording_version, wording_hash) values ($1, $2, 1, 'email', $3, 'x', repeat('a', 64))", [s.io.orgId, test.invoice.id, queued.messageId]);
    })).rejects.toThrow(/only an issued invoice that is not a test invoice can be sent to a customer/);
  });

  it("limits what any one link can send, counting messages that ended, and then points at copying the link", async () => {
    const s = await shop();
    const refusing = recordingProvider("resend", () => ({ ok: false, retryable: false, error: "The address was refused." }));
    for (let i = 0; i < 6; i += 1) {
      expect(await send(s)).toMatchObject({ status: "queued" });
      expect((await dispatchMessage((await onlyMessage(s.id, i)).id, { transport: refusing.transport, now: NOW })).status).toBe("failed");
    }
    const pre = await read(s);
    expect(pre.remaining).toBe(0);
    expect(await sendInvoiceDelivery(s.io.ctx("owner"), s.id, { channel: "email", linkVersion: 1, wordingHash: pre.wordingHash }, { now: NOW })).toMatchObject({ status: "refused", reason: "too_many" });
    expect(await deliveries(s.id)).toHaveLength(6);
    const keys = (await rows<{ dedupe_key: string }>("select dedupe_key from conversation_messages where org_id = $1 order by created_at", [s.io.orgId])).map((k) => k.dedupe_key);
    expect(keys).toEqual([0, 1, 2, 3, 4, 5].map((n) => (n === 0 ? `invoice-delivery:${s.id}:1:email` : `invoice-delivery:${s.id}:1:email:${n}`)));
  });
});

describe("a message that waits for sending hours", () => {
  it("is queued with its due time, is not sent early, and goes once the hours open", async () => {
    const s = await shop();
    const r = await waiting(s);
    expect(r.delivery).toMatchObject({ state: "waiting", label: "Waiting for sending hours", sendAfter: "2026-10-23T14:00:00.000Z" });
    expect(r.waitingUntil).toBe("2026-10-23T14:00:00.000Z");
    const m = await onlyMessage(s.id);
    expect(m.status).toBe("queued");
    const rec = recordingProvider("resend");
    await withQuietHours("11:00", "14:00", async () => {
      expect((await dispatchMessage(m.id, { transport: rec.transport, now: NOW })).status).toBe("skipped");
      expect(rec.calls).toHaveLength(0);
      expect((await dispatchMessage(m.id, { transport: rec.transport, now: new Date("2026-10-23T14:30:00Z") })).status).toBe("sent");
    });
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].body).toContain(s.url);
  });

  it("is sent in the customer's quiet hours only after they end, whatever the workspace's own clock says", async () => {
    const s = await shop({ timezone: "Asia/Manila" });
    await withQuietHours("20:00", "23:00", async () => {
      // 12:00 UTC is 20:00 in Manila: inside the quiet hours.
      const r = await send(s);
      expect(r).toMatchObject({ status: "queued", delivery: { state: "waiting" } });
      expect(new Date((r as { waitingUntil: string }).waitingUntil).toISOString()).toBe("2026-10-23T15:00:00.000Z");
    });
  });
});

describe("stopping a message that has not gone out", () => {
  const stopped = async (s: Shop, reason: string, text: RegExp) => {
    const [d] = await deliveries(s.id);
    expect(d.withdrawn_at, "delivery withdrawn").not.toBeNull();
    expect(d.withdrawn_reason).toBe(reason);
    const m = await message(d.message_id as string);
    expect(m).toMatchObject({ status: "blocked", blocked_reason: reason });
    expect(await reservation(m.reservation_id)).toBe("released");
    const detail = await getInvoiceDetail(s.io.ctx("owner"), s.id, { now: NOW });
    expect(detail.deliveries[0]).toMatchObject({ state: "withdrawn", label: "Stopped before it was sent", ended: true });
    expect(detail.deliveries[0].explain).toMatch(text);
    expect(await eventKinds(s.id)).toContain("delivery_withdrawn");
    // The dispatcher no longer sees it.
    const rec = recordingProvider("resend");
    expect((await dispatchMessage(m.id, { transport: rec.transport, now: new Date("2026-10-23T15:00:00Z") })).status).toBe("skipped");
    expect(rec.calls).toHaveLength(0);
  };

  it("when the invoice is voided", async () => {
    const s = await shop();
    await waiting(s);
    await voidInvoice(s.io.ctx("owner"), s.id, { reason: "Raised for the wrong job" });
    await stopped(s, "invoice_voided", /voided before the message went out/);
  });

  it("when it is paid in full by a payment a person recorded", async () => {
    const s = await shop();
    await waiting(s);
    await recordManualPayment(s.io.ctx("owner"), s.id, cash("1500.00"), { now: NOW });
    await stopped(s, "invoice_paid", /paid before the message went out/);
  });

  it("when a payment provider reports it paid in full", async () => {
    const s = await shop();
    await waiting(s);
    await providerPayment(s.io, s.id, await connectionFor(s.io), 150_000, { livemode: true });
    await stopped(s, "invoice_paid", /paid before the message went out/);
  });

  it("when a payment on it is disputed", async () => {
    const s = await shop();
    await waiting(s);
    const part = await providerPayment(s.io, s.id, await connectionFor(s.io), 50_000, { livemode: true });
    await withSystem((db) => applyDisputeInTx(db, { orgId: s.io.orgId, paymentId: part.paymentId, open: true, actor: { id: null, kind: "provider" } }));
    await stopped(s, "invoice_disputed", /disputed before the message went out/);
  });

  it("when it is written off", async () => {
    const s = await shop();
    await waiting(s);
    await writeOffInvoice(s.io.ctx("owner"), s.id, { reason: "The customer closed their business" });
    await stopped(s, "invoice_written_off", /written off before the message went out/);
  });

  it("when the link is replaced, so a link that would not open is never sent; a new send then carries the new link", async () => {
    const s = await shop();
    await waiting(s);
    await rotateInvoiceLink(s.io.ctx("owner"), s.id);
    await stopped(s, "invoice_link_replaced", /link was replaced before the message went out/);
    const r = await send(s);
    expect(r).toMatchObject({ status: "queued", delivery: { linkVersion: 2 } });
    const d = await deliveries(s.id);
    expect(d.map((x) => x.link_version)).toEqual([1, 2]);
    // A new link is a new key space: the first message's key is not spent for it.
    expect((await message(d[1].message_id as string)).dedupe_key).toBe(`invoice-delivery:${s.id}:2:email`);
    const rec = recordingProvider("resend");
    await dispatchMessage(d[1].message_id as string, { transport: rec.transport, now: NOW });
    const sent = TOKEN_RE.exec(rec.calls[0].body)![1];
    expect(sent).toBe(invoiceTokenFor(s.id, 2));
    expect(sent).not.toBe(s.token);
    expect(await loadPublicInvoice(sent, { ip: freshIp() })).toMatchObject({ state: "ok" });
    expect(await loadPublicInvoice(s.token, { ip: freshIp() })).not.toMatchObject({ state: "ok" });
  });

  it("when the customer asks for their data to be erased, which also removes the masked address and the text", async () => {
    const s = await shop();
    await waiting(s);
    await redactContact(s.io.c.actor("owner"), s.contactId, "Customer asked for erasure by email, 22 Oct");
    const [d] = await deliveries(s.id);
    expect(d).toMatchObject({ withdrawn_reason: "privacy_request", address_mask: null });
    const m = await message(d.message_id as string);
    expect(m).toMatchObject({ status: "blocked", blocked_reason: "privacy_request", body: "[removed on request]" });
    expect(await reservation(m.reservation_id)).toBe("released");
  });

  it("when a person puts a hold on the customer, and says so in the history of the hold", async () => {
    const s = await shop();
    await waiting(s);
    await setRetentionPaused(s.io.ctx("owner"), s.contactId, true, "In a dispute");
    const m = await onlyMessage(s.id);
    expect(m).toMatchObject({ status: "blocked", blocked_reason: "held_by_person" });
    expect(await reservation(m.reservation_id)).toBe("released");
    const detail = await getInvoiceDetail(s.io.ctx("owner"), s.id, { now: NOW });
    expect(detail.deliveries[0]).toMatchObject({ state: "blocked", label: "Not sent", ended: true });
    expect(detail.deliveries[0].explain).toContain("excluded this customer from automatic messages");
    const rec = recordingProvider("resend");
    expect((await dispatchMessage(m.id, { transport: rec.transport, now: new Date("2026-10-23T15:00:00Z") })).status).toBe("skipped");
    expect(rec.calls).toHaveLength(0);
  });

  it("leaves a message that is already on its way, or that the provider took, as it is", async () => {
    const s = await shop();
    await send(s);
    const m = await onlyMessage(s.id);
    await dispatchMessage(m.id, { transport: recordingProvider("resend").transport, now: NOW });
    await voidInvoice(s.io.ctx("owner"), s.id, { reason: "Raised for the wrong job" });
    const [d] = await deliveries(s.id);
    expect(d.withdrawn_at).toBeNull();
    expect((await message(m.id)).status).toBe("sent");
    expect((await getInvoiceDetail(s.io.ctx("owner"), s.id, { now: NOW })).deliveries[0]).toMatchObject({ state: "sent", label: "Sent by email" });
    expect(await eventKinds(s.id)).not.toContain("delivery_withdrawn");
  });

  it("stops only the invoice it is about", async () => {
    const s = await shop();
    const second = await issuedInvoice(s.io, { contactId: s.contactId }, NOW);
    await waiting(s);
    const t: Shop = { ...s, id: second.invoice.id, token: invoiceTokenFor(second.invoice.id, 1), url: invoiceLinkUrl(invoiceTokenFor(second.invoice.id, 1)) };
    await withQuietHours("11:00", "14:00", () => send(t));
    await voidInvoice(s.io.ctx("owner"), s.id, { reason: "Raised for the wrong job" });
    expect((await deliveries(s.id))[0].withdrawn_reason).toBe("invoice_voided");
    expect((await deliveries(second.invoice.id))[0].withdrawn_at).toBeNull();
    expect((await onlyMessage(second.invoice.id)).status).toBe("queued");
  });
});

describe("checked again right before it leaves", () => {
  const dispatchBlocked = async (s: Shop, reason: string) => {
    const m = await onlyMessage(s.id);
    const rec = recordingProvider("resend");
    expect((await dispatchMessage(m.id, { transport: rec.transport, now: NOW })).status).toBe("blocked");
    expect(rec.calls).toHaveLength(0);
    const after = await message(m.id);
    expect(after).toMatchObject({ status: "blocked", blocked_reason: reason });
    expect(await reservation(after.reservation_id)).toBe("released");
    // Read with trusted code: a suspended workspace, or one with invoicing switched off, is not one a member's own read can open.
    return (await withSystem((db) => invoiceDeliveriesFor(db, s.io.orgId, s.id, NOW)))[0];
  };

  it("stops it when a person's hold was set without the hold's own withdrawal reaching it", async () => {
    const s = await shop();
    await send(s);
    await withSystem((db) => db.query("update contacts set retention_paused = true where id = $1", [s.contactId]));
    expect(await dispatchBlocked(s, "held_by_person")).toMatchObject({ state: "blocked", label: "Not sent" });
  });

  it("stops it when customer messaging was paused, and when the workspace was suspended, after it was queued", async () => {
    const s = await shop();
    await send(s);
    await withSystem((db) => db.query("insert into automation_pauses (org_id, scope, active, reason) values ($1, 'outbound', true, 'Reviewing')", [s.io.orgId]));
    expect((await dispatchBlocked(s, "automation_paused")).explain).toContain("Customer messaging");
    const t = await shop();
    await send(t);
    await withSystem((db) => db.query("update organizations set status = 'suspended' where id = $1", [t.io.orgId]));
    await dispatchBlocked(t, "org_inactive");
  });

  it("stops it when the address opted out after it was queued", async () => {
    const s = await shop();
    await send(s);
    await withSystem((db) => suppressAddress(db, { orgId: s.io.orgId, channel: "email", address: s.email, reason: "opt_out", source: "test" }));
    expect((await dispatchBlocked(s, "suppressed")).explain).toContain("opted out");
  });

  it("does not send a link that has stopped working, whatever stopped it and whether or not anything withdrew the message", async () => {
    const cases: Array<[string, string]> = [
      ["the invoice was voided behind the module's back", "update customer_invoices set status = 'void', voided_at = now(), void_reason = 'x' where id = $1"],
      ["the invoice was written off", "update customer_invoices set written_off_at = now(), write_off_reason = 'x' where id = $1"],
      ["the link was replaced", "update customer_invoices set public_token_version = 2 where id = $1"],
      ["the link's key is gone", "update customer_invoices set public_token_hash = repeat('a', 64) where id = $1"],
    ];
    for (const [what, sql] of cases) {
      const s = await shop();
      await send(s);
      // Written straight to the rows, the way a fault in some other code path could leave them: the dispatcher reads the facts, not the history of how they came about.
      await withSystem((db) => db.query(sql, [s.id]));
      const view = await dispatchBlocked(s, "invoice_link_unavailable");
      expect(view.explain, what).toContain("link had stopped working");
    }
  });

  it("does not send a link for a workspace whose invoicing was switched off, or while the platform's stop for invoice links is on", async () => {
    const s = await shop();
    await send(s);
    await setInvoicesEnabled(s.io.superAdmin, s.io.orgId, false);
    await dispatchBlocked(s, "invoice_link_unavailable");
    const t = await shop();
    await send(t);
    process.env.INVOICES_PUBLIC_DISABLED = "true";
    resetEnvCache();
    await dispatchBlocked(t, "invoice_link_unavailable");
  });

  it("gives a link for a message only to the workspace that owns it, and only for the channel it was made for", async () => {
    const s = await shop();
    await send(s);
    const m = await onlyMessage(s.id);
    const other = await shop();
    const { link, wrongOrg, wrongChannel, nonsense } = await withSystem(async (db) => ({
      link: await invoiceLinkForDelivery(db, s.io.orgId, m.id, s.email, "email"),
      wrongOrg: await invoiceLinkForDelivery(db, other.io.orgId, m.id, s.email, "email"),
      wrongChannel: await invoiceLinkForDelivery(db, s.io.orgId, m.id, s.email, "sms"),
      nonsense: await invoiceLinkForDelivery(db, s.io.orgId, "00000000-0000-4000-8000-000000000000", s.email, "email"),
    }));
    expect(link).toBe(s.url);
    expect([wrongOrg, wrongChannel, nonsense]).toEqual([null, null, null]);
  });

  it("never fills the link into any other message, whoever wrote it, and sends nothing", async () => {
    const s = await shop();
    const typed = "Here you go: {{invoice.link}}";
    const queue = async (scope: "human" | "billing" | "delivery", actor: Parameters<typeof queueOutbound>[1]["actor"]) => {
      const queued = await withSystem(async (db) => {
        const conversationId = await deliveryConversation(db, { orgId: s.io.orgId, contactId: s.contactId, channel: "email", threadKey: `stray:${scope}`, subject: "Hello" });
        return queueOutbound(db, { orgId: s.io.orgId, conversationId, scope, actor, body: typed, now: NOW, businessHoursOnly: false });
      });
      expect(queued.status, scope).toBe("queued");
      const rec = recordingProvider("resend");
      expect((await dispatchMessage(queued.messageId, { transport: rec.transport, now: NOW })).status, scope).toBe("blocked");
      expect(rec.calls, scope).toHaveLength(0);
      expect((await message(queued.messageId)).blocked_reason, scope).toBe("invoice_link_unavailable");
    };
    await queue("human", { kind: "human", userId: s.io.c.people.owner.id });
    // A reminder-scope message with no reminder behind it, and a delivery-scope message with no invoice delivery behind it (a proposal's, say), are not given a link either.
    await queue("billing", { kind: "system", userId: s.io.c.people.owner.id });
    await queue("delivery", { kind: "system", userId: s.io.c.people.owner.id });
  });
});

describe("the words on the screen", () => {
  it("lists each message newest first with its channel, link version, who asked and what became of it, to anyone who can see invoices", async () => {
    const s = await shop({ consent: ["email", "sms"] });
    await send(s, "email");
    await send(s, "sms");
    const detail = await getInvoiceDetail(s.io.ctx("sales"), s.id, { now: NOW });
    expect(detail.deliveries.map((d) => d.channel)).toEqual(["sms", "email"]);
    expect(detail.deliveries.every((d) => d.linkVersion === 1 && d.requestedByName && d.state === "queued")).toBe(true);
    expect(JSON.stringify(detail.deliveries)).not.toMatch(/https?:|\{\{|\/pay\//);
    expect(detail.events.filter((e) => e.kind === "delivery_queued")).toHaveLength(2);
  });

  it("shows nothing for an invoice that was never sent from here, and copying the link still sends nothing", async () => {
    const s = await shop();
    expect((await getInvoiceDetail(s.io.ctx("owner"), s.id, { now: NOW })).deliveries).toEqual([]);
    const before = await messageCount(s.io.orgId);
    const { getInvoiceLink } = await import("@/server/invoices/share");
    expect((await getInvoiceLink(s.io.ctx("owner"), s.id)).url).toBe(s.url);
    expect(await messageCount(s.io.orgId)).toBe(before);
  });
});
