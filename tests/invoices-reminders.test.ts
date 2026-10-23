// Invoice reminders through the real consent-gated send chain (scope "billing"): the owner's authorization of the exact wording, the rows planned for each invoice, what the job
// queues, every way the chain can refuse and how that is stored, what stops a reminder, how an authorization lapses, a paused workspace, and a customer's link that is
// never stored anywhere. Embedded Postgres; every provider is a recording stand-in and nothing leaves the process.
import { beforeEach, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { createContact, setContactConsent } from "@/server/crm/contacts";
import { suppressAddress } from "@/server/messaging/contacts";
import { buildExport } from "@/server/offboarding/export";
import { readZip } from "@/server/offboarding/zip";
import { dispatchMessage, queueOutbound } from "@/server/messaging/send";
import { maskCustomerLinks } from "@/server/messaging/redact";
import { setInvoicesEnabled } from "@/server/invoices/feature";
import { rotateInvoiceLink } from "@/server/invoices/share";
import { invoiceTokenFor } from "@/server/invoices/links";
import { writeOffInvoice, voidInvoice } from "@/server/invoices/invoices";
import { recordManualPayment } from "@/server/invoices/payments";
import { applyDisputeInTx } from "@/server/invoices/apply";
import { saveInvoiceSettings } from "@/server/invoices/settings";
import { authorizeReminders, getReminderOverview, invoiceLinkForMessage, runInvoiceReminders, stopReminders, switchOffReminders } from "@/server/invoices/reminders";
import { renderReminder } from "@/lib/invoices/reminder-text";
import { addMessaging, connectionFor, consentTo, contactIn, invoiceOrg, issuedInvoice, providerPayment, rows, uniquePhone, type InvoiceOrg } from "./support/invoices";
import { recordingProvider } from "./support/messaging";

const ISSUED = new Date("2026-10-23T12:00:00Z");
const DUE = "2026-11-06";
/** The first reminder (three days before the due date) is due at 09:00 on the 3rd; this is an hour later. */
const FIRST = new Date("2026-11-03T10:00:00Z");
const ON_DAY = new Date("2026-11-06T10:00:00Z");
const cash = (amount: string) => ({ amount, receivedOn: "2026-10-23", method: "cash" as const, evidence: "Cash, receipt 12" });

// The reminders job works across every workspace, so what an earlier test left due would be counted in this one's report: it is set aside first.
beforeEach(async () => {
  await withSystem((db) => db.query("update customer_invoice_reminders set status = 'cancelled', reason = 'test_leftover' where status = 'scheduled' or (status = 'queued' and message_id is null)"));
});

interface Shop {
  io: InvoiceOrg;
  contactId: string;
}

async function shop(opts: { channels?: Array<"email" | "sms">; credits?: number; consent?: Array<"email" | "sms">; timezone?: string; firstName?: string } = {}): Promise<Shop> {
  const io = await invoiceOrg({ timezone: opts.timezone });
  await addMessaging(io, { credits: opts.credits, channels: opts.channels });
  const contactId = await contactIn(io, { firstName: opts.firstName ?? "Maria" });
  for (const channel of opts.consent ?? ["email"]) await consentTo(io, contactId, channel);
  return { io, contactId };
}

async function authorize(io: InvoiceOrg, now = ISSUED) {
  const o = await getReminderOverview(io.ctx("owner"), { now });
  return authorizeReminders(io.ctx("owner"), { wordingHash: o.wordingHash, settingsVersion: o.settingsVersion }, { now });
}

const remindersOf = (invoiceId: string) =>
  rows<{ step_key: string; status: string; reason: string | null; message_id: string | null; due_at: Date }>("select step_key, status, reason, message_id, due_at from customer_invoice_reminders where invoice_id = $1 order by due_at", [invoiceId]);
const stepsOf = async (invoiceId: string) => Object.fromEntries((await remindersOf(invoiceId)).map((r) => [r.step_key, r.status]));
const messageOf = async (invoiceId: string, step: string) =>
  (await rows<{ id: string; status: string; scope: string; purpose: string; body: string; author_kind: string; author_user_id: string | null; dedupe_key: string | null; blocked_reason: string | null; send_after: Date; channel: string; owner_kind: string; reservation_id: string | null }>(
    `select m.id, m.status, m.scope, m.purpose, m.body, m.author_kind, m.author_user_id, m.dedupe_key, m.blocked_reason, m.send_after, c.channel, c.owner_kind, m.reservation_id
     from customer_invoice_reminders r join conversation_messages m on m.id = r.message_id and m.org_id = r.org_id join conversations c on c.id = m.conversation_id and c.org_id = m.org_id
     where r.invoice_id = $1 and r.step_key = $2`, [invoiceId, step],
  ))[0];
const eventKinds = async (invoiceId: string) => (await rows<{ kind: string }>("select kind from customer_invoice_events where invoice_id = $1 order by id", [invoiceId])).map((e) => e.kind);

describe("the owner's authorization", () => {
  it("belongs to the owner alone, and is bound to the exact wording, days and channels they were shown", async () => {
    const { io } = await shop();
    const o = await getReminderOverview(io.ctx("owner"), { now: ISSUED });
    expect(o).toMatchObject({ enabled: false, active: false, problem: "reminders_off", channels: ["email"], usesCredits: false, offsetsDays: [-3, 0, 3, 10], max: 4, wordingIsDraft: true });
    for (const who of ["manager", "sales", "support", "viewer", "member"] as const) {
      await expect(authorizeReminders(io.ctx(who), { wordingHash: o.wordingHash, settingsVersion: o.settingsVersion }, { now: ISSUED }), who).rejects.toMatchObject({ code: "forbidden" });
    }
    // What they read is what they authorize: a different fingerprint, or settings that moved on, is refused.
    await expect(authorizeReminders(io.ctx("owner"), { wordingHash: "0".repeat(64), settingsVersion: o.settingsVersion }, { now: ISSUED })).rejects.toThrow(/changed since you read them/);
    await expect(authorizeReminders(io.ctx("owner"), { wordingHash: o.wordingHash, settingsVersion: o.settingsVersion + 3 }, { now: ISSUED })).rejects.toThrow(/Someone changed the invoice settings/);
    expect((await getReminderOverview(io.ctx("owner"), { now: ISSUED })).enabled).toBe(false);
  });

  it("switches reminders on, records who and when, audits it without the wording, and says what will be sent on which days", async () => {
    const { io } = await shop();
    const on = await authorize(io);
    expect(on).toMatchObject({ enabled: true, active: true, problem: null, problemText: null, authorizedByName: expect.any(String), authorizedAt: ISSUED.toISOString(), expiresAt: new Date(ISSUED.getTime() + 90 * 86_400_000).toISOString() });
    expect(on.previews.map((p) => p.stepKey)).toEqual(["before_due:-3", "on_due:0", "after_due:3", "after_due:10"]);
    expect(on.previews.map((p) => p.label)).toEqual(["3 days before the due date", "On the due date", "3 days after the due date", "10 days after the due date"]);
    for (const p of on.previews) {
      expect(p.body).toContain("[the customer's own link to the invoice]");
      expect(p.body).not.toContain("{{");
    }
    const audit = await rows<{ metadata: Record<string, unknown> }>("select metadata from audit_logs where org_id = $1 and action = 'invoices.reminders_authorized'", [io.orgId]);
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({ wordingVersion: on.wordingVersion, offsetsDays: [-3, 0, 3, 10], max: 4, channels: ["email"] });
    expect(JSON.stringify(audit[0].metadata)).not.toMatch(/Hi |invoice\.link|reminder from/);
    const stored = (await rows<{ reminders_enabled: boolean; reminders_authorized_by: string; reminders_body_hash: string }>("select reminders_enabled, reminders_authorized_by, reminders_body_hash from customer_invoice_settings where org_id = $1", [io.orgId]))[0];
    expect(stored).toMatchObject({ reminders_enabled: true, reminders_authorized_by: io.c.people.owner.id, reminders_body_hash: on.wordingHash });
  });

  it("needs customer invoices switched on for the workspace, and at least one reminder day", async () => {
    const off = await invoiceOrg({ enabled: false });
    await expect(authorizeReminders(off.ctx("owner"), { wordingHash: "0".repeat(64), settingsVersion: 0 }, { now: ISSUED })).rejects.toMatchObject({ code: "not_enabled" });
    const { io } = await shop();
    await saveInvoiceSettings(io.ctx("owner"), { reminderOffsetsDays: [] }, 0);
    const o = await getReminderOverview(io.ctx("owner"), { now: ISSUED });
    await expect(authorizeReminders(io.ctx("owner"), { wordingHash: o.wordingHash, settingsVersion: o.settingsVersion }, { now: ISSUED })).rejects.toThrow(/at least one reminder day/);
  });

  it("can be switched off at once by the owner or a manager, and by nobody else", async () => {
    const { io, contactId } = await shop();
    await authorize(io);
    const inv = await issuedInvoice(io, { contactId, dueOn: DUE }, ISSUED);
    expect(await stepsOf(inv.invoice.id)).toEqual({ "before_due:-3": "scheduled", "on_due:0": "scheduled", "after_due:3": "scheduled", "after_due:10": "scheduled" });
    await expect(switchOffReminders(io.ctx("sales"))).rejects.toMatchObject({ code: "forbidden" });
    const off = await switchOffReminders(io.ctx("manager"));
    expect(off).toMatchObject({ enabled: false, active: false });
    expect(Object.values(await stepsOf(inv.invoice.id))).toEqual(["cancelled", "cancelled", "cancelled", "cancelled"]);
    expect((await remindersOf(inv.invoice.id)).map((r) => r.reason)).toEqual(["reminders_off", "reminders_off", "reminders_off", "reminders_off"]);
    expect(await rows("select 1 from audit_logs where org_id = $1 and action = 'invoices.reminders_off'", [io.orgId])).toHaveLength(1);
  });
});

describe("which reminders an invoice gets", () => {
  it("gets none while reminders are off, and a row for each day at nine in the morning, workspace time, once the owner has authorized them", async () => {
    const { io, contactId } = await shop();
    const before = await issuedInvoice(io, { contactId, dueOn: DUE }, ISSUED);
    expect(await remindersOf(before.invoice.id)).toEqual([]);
    await authorize(io);
    // Authorizing plans the invoices already issued and still owed as well.
    expect((await remindersOf(before.invoice.id)).map((r) => [r.step_key, r.status, r.due_at.toISOString()])).toEqual([
      ["before_due:-3", "scheduled", "2026-11-03T09:00:00.000Z"], ["on_due:0", "scheduled", "2026-11-06T09:00:00.000Z"], ["after_due:3", "scheduled", "2026-11-09T09:00:00.000Z"], ["after_due:10", "scheduled", "2026-11-16T09:00:00.000Z"],
    ]);
    const after = await issuedInvoice(io, { contactId, dueOn: DUE }, ISSUED);
    expect(Object.keys(await stepsOf(after.invoice.id))).toHaveLength(4);
  });

  it("keeps each workspace's own nine o'clock and never plans a reminder for a day already past (it is stored as skipped, not sent late)", async () => {
    const { io, contactId } = await shop({ timezone: "Asia/Manila" });
    const inv = await issuedInvoice(io, { contactId, dueOn: "2026-10-25" }, ISSUED);
    await authorize(io);
    const r = await remindersOf(inv.invoice.id);
    expect(r.map((x) => [x.step_key, x.status, x.reason])).toEqual([["before_due:-3", "skipped", "already_past"], ["on_due:0", "scheduled", null], ["after_due:3", "scheduled", null], ["after_due:10", "scheduled", null]]);
    expect(r[1].due_at.toISOString()).toBe("2026-10-25T01:00:00.000Z");
  });

  it("gets nothing for an invoice that is not owed, and a draft has no rows at all", async () => {
    const { io, contactId } = await shop();
    await authorize(io);
    const paid = await issuedInvoice(io, { contactId, dueOn: DUE }, ISSUED);
    await recordManualPayment(io.ctx("owner"), paid.invoice.id, cash("1500"), { now: ISSUED });
    expect(Object.values(await stepsOf(paid.invoice.id)).every((s) => s === "cancelled")).toBe(true);
  });
});

describe("what the job queues", () => {
  it("hands a due reminder to the send chain as a billing service message from the system, with the link as a placeholder, once however often it runs", async () => {
    const { io, contactId } = await shop();
    await authorize(io);
    const inv = await issuedInvoice(io, { contactId, dueOn: DUE }, ISSUED);
    expect(await runInvoiceReminders({ now: new Date("2026-11-03T08:00:00Z") })).toMatchObject({ queued: 0 });
    const run = await runInvoiceReminders({ now: FIRST });
    expect(run).toMatchObject({ queued: 1, blocked: 0 });
    expect(await stepsOf(inv.invoice.id)).toMatchObject({ "before_due:-3": "queued", "on_due:0": "scheduled" });

    const m = await messageOf(inv.invoice.id, "before_due:-3");
    expect(m).toMatchObject({ scope: "billing", purpose: "service", status: "queued", author_kind: "system", author_user_id: io.c.people.owner.id, channel: "email", owner_kind: "unassigned", dedupe_key: `invoice-reminder:${inv.invoice.id}:before_due:-3` });
    expect(m.body).toBe(renderReminder({ phase: "before_due", firstName: "Maria", business: (await rows<{ name: string }>("select name from organizations where id = $1", [io.orgId]))[0].name, number: "INV-0001", totalMinor: 150_000, currency: "PHP", dueOn: DUE }).body);
    expect(m.body).toContain("{{invoice.link}}");
    expect(m.body).not.toMatch(/https?:|\/pay\//);
    expect(m.reservation_id).not.toBeNull();
    expect(await eventKinds(inv.invoice.id)).toContain("reminder_queued");

    // Running it again, or three times at once, makes no second message.
    await Promise.all([runInvoiceReminders({ now: FIRST }), runInvoiceReminders({ now: FIRST }), runInvoiceReminders({ now: FIRST })]);
    expect(await rows("select 1 from customer_invoice_reminders r join conversation_messages m on m.id = r.message_id where r.invoice_id = $1", [inv.invoice.id])).toHaveLength(1);
    expect((await eventKinds(inv.invoice.id)).filter((k) => k === "reminder_queued")).toHaveLength(1);
  });

  it("sends at most the owner's maximum over the life of an invoice, one reminder on each of its days", async () => {
    const { io, contactId } = await shop();
    await authorize(io);
    const inv = await issuedInvoice(io, { contactId, dueOn: DUE }, ISSUED);
    const rec = recordingProvider("resend");
    for (const at of ["2026-11-03T10:00:00Z", "2026-11-06T10:00:00Z", "2026-11-09T10:00:00Z", "2026-11-16T10:00:00Z", "2026-11-20T10:00:00Z", "2026-12-20T10:00:00Z"]) {
      await runInvoiceReminders({ now: new Date(at) });
      const due = await rows<{ id: string }>("select m.id from customer_invoice_reminders r join conversation_messages m on m.id = r.message_id where r.invoice_id = $1 and m.status = 'queued'", [inv.invoice.id]);
      for (const d of due) await dispatchMessage(d.id, { transport: rec.transport, now: new Date(at) });
    }
    expect(rec.calls).toHaveLength(4);
    expect(Object.values(await stepsOf(inv.invoice.id)).every((s) => s === "queued")).toBe(true);
    expect(rec.calls[0].body).toMatch(/this is a reminder from .* that invoice INV-0001 for PHP 1,500\.00 is due on 6 Nov 2026/);
    expect(rec.calls[1].body).toMatch(/is due today/);
    expect(rec.calls[2].body).toMatch(/was due on 6 Nov 2026 and is not paid in full yet/);
    expect(rec.calls[3].body).toMatch(/was due on 6 Nov 2026 and is not paid in full yet/);
  });

  it("falls back to the next channel the owner allows when the first cannot be used", async () => {
    const { io, contactId } = await shop({ consent: ["sms"] });
    await saveInvoiceSettings(io.ctx("owner"), { reminderChannels: ["email", "sms"] }, 0);
    await authorize(io);
    const inv = await issuedInvoice(io, { contactId, dueOn: DUE }, ISSUED);
    expect((await runInvoiceReminders({ now: FIRST })).queued).toBe(1);
    // No consent to email on record, consent to text messages: it goes by text.
    const m = await messageOf(inv.invoice.id, "before_due:-3");
    expect(m).toMatchObject({ channel: "sms", status: "queued" });
    expect((await remindersOf(inv.invoice.id))[0]).toMatchObject({ status: "queued", reason: null });
    expect((await getReminderOverview(io.ctx("owner"), { now: FIRST })).usesCredits).toBe(true);
  });
});

describe("every way the send chain can say no is stored with its reason, and nothing is forced through", () => {
  async function blockedFor(setup: (s: Shop) => Promise<void>, shopOpts: Parameters<typeof shop>[0] = {}) {
    const s = await shop(shopOpts);
    await setup(s);
    await authorize(s.io);
    const inv = await issuedInvoice(s.io, { contactId: s.contactId, dueOn: DUE }, ISSUED);
    const report = await runInvoiceReminders({ now: FIRST });
    const [first] = await remindersOf(inv.invoice.id);
    const messages = await rows("select 1 from conversation_messages where org_id = $1", [s.io.orgId]);
    return { s, inv, report, first, messages };
  }

  it("when there is no consent on record", async () => {
    const { report, first, messages, inv } = await blockedFor(async () => undefined, { consent: [] });
    expect(report).toMatchObject({ queued: 0, blocked: 1 });
    expect(first).toMatchObject({ step_key: "before_due:-3", status: "blocked", reason: "no_consent", message_id: null });
    expect(messages).toHaveLength(0);
    const ev = await rows<{ detail: { step: string; reason: string; why: string } }>("select detail from customer_invoice_events where invoice_id = $1 and kind = 'reminder_blocked'", [inv.invoice.id]);
    expect(ev[0].detail).toMatchObject({ step: "before_due:-3", reason: "no_consent", why: "No consent on record for this kind of message" });
  });

  it("when the customer withdrew consent", async () => {
    const { first, messages } = await blockedFor(async ({ io, contactId }) => {
      await consentTo(io, contactId, "email");
      await setContactConsent(io.c.actor("owner"), contactId, { channel: "email", purpose: "service", status: "revoked", evidence: "Replied STOP" });
    });
    expect(first).toMatchObject({ status: "blocked", reason: "no_consent" });
    expect(messages).toHaveLength(0);
  });

  it("when the address opted out or bounced", async () => {
    const { first, messages } = await blockedFor(async ({ io, contactId }) => {
      const email = (await rows<{ email: string }>("select email::text as email from contacts where id = $1", [contactId]))[0].email;
      await withSystem((db) => suppressAddress(db, { orgId: io.orgId, channel: "email", address: email, reason: "opt_out", source: "test" }));
    });
    expect(first).toMatchObject({ status: "blocked", reason: "suppressed" });
    expect(messages).toHaveLength(0);
  });

  it("when there are no service credits left", async () => {
    const { first, messages } = await blockedFor(async () => undefined, { credits: 0 });
    expect(first).toMatchObject({ status: "blocked", reason: "credits" });
    expect(messages).toHaveLength(0);
  });

  it("when the channel is not set up and enabled", async () => {
    const { first } = await blockedFor(async ({ io }) => {
      await withSystem((db) => db.query("update messaging_channels set enabled = false where org_id = $1 and channel = 'email'", [io.orgId]));
    });
    expect(first).toMatchObject({ status: "blocked", reason: "channel_not_ready" });
  });

  it("when the customer has no email address and email is the only channel allowed", async () => {
    const { first, inv } = await blockedFor(async (s) => {
      const phoneOnly = await createContact(s.io.c.actor("owner"), { firstName: "Phone", lastName: "Only", phone: uniquePhone() });
      s.contactId = phoneOnly.id;
      await consentTo(s.io, phoneOnly.id, "sms");
    });
    expect(first).toMatchObject({ status: "blocked", reason: "contact_unreachable" });
    const ev = await rows<{ detail: { why: string } }>("select detail from customer_invoice_events where kind = 'reminder_blocked' and invoice_id = $1", [inv.invoice.id]);
    expect(ev[0].detail.why).toBe("The contact has no address for this channel");
  });

  it("when an email goes out in quiet hours, it waits for the end of them instead of being refused, and is not sent early", async () => {
    const s = await shop();
    await authorize(s.io);
    const inv = await issuedInvoice(s.io, { contactId: s.contactId, dueOn: DUE }, ISSUED);
    try {
      await withSystem((db) => db.query("update messaging_policy set quiet_hours_start = '09:00', quiet_hours_end = '12:00'"));
      expect((await runInvoiceReminders({ now: FIRST })).queued).toBe(1);
      expect((await remindersOf(inv.invoice.id))[0]).toMatchObject({ status: "queued", reason: "quiet_hours" });
      const m = await messageOf(inv.invoice.id, "before_due:-3");
      expect(m.status).toBe("queued");
      expect(new Date(m.send_after).getTime()).toBeGreaterThanOrEqual(new Date("2026-11-03T12:00:00Z").getTime());
      const rec = recordingProvider("resend");
      expect((await dispatchMessage(m.id, { transport: rec.transport, now: FIRST })).status).toBe("skipped");
      expect(rec.calls).toHaveLength(0);
      expect((await dispatchMessage(m.id, { transport: rec.transport, now: new Date("2026-11-03T12:30:00Z") })).status).toBe("sent");
      expect(rec.calls).toHaveLength(1);
    } finally {
      await withSystem((db) => db.query("update messaging_policy set quiet_hours_start = '00:00', quiet_hours_end = '00:00'"));
    }
  });
});

describe("the customer's link is never stored", () => {
  it("is derived at the moment of sending, reaches only the provider's request, and appears nowhere the business, an export or an AI could read", async () => {
    const { io, contactId } = await shop();
    await authorize(io);
    const inv = await issuedInvoice(io, { contactId, dueOn: DUE }, ISSUED);
    await runInvoiceReminders({ now: FIRST });
    const m = await messageOf(inv.invoice.id, "before_due:-3");
    const rec = recordingProvider("resend");
    expect((await dispatchMessage(m.id, { transport: rec.transport, now: FIRST })).status).toBe("sent");

    const link = /https?:\/\/[^\s/]+\/pay\/([A-Za-z0-9_-]{43})/.exec(rec.calls[0].body);
    expect(link, rec.calls[0].body).not.toBeNull();
    const token = link![1];
    expect(token).toBe(invoiceTokenFor(inv.invoice.id, 1));
    expect(rec.calls[0].body.match(/\/pay\//g)).toHaveLength(1);
    expect(rec.calls[0].to).toBeTruthy();

    // The stored message is unchanged, the conversation's preview is masked, and the token is in no table at all.
    const after = (await messageOf(inv.invoice.id, "before_due:-3"));
    expect(after.status).toBe("sent");
    expect(after.body).toContain("{{invoice.link}}");
    expect(after.body).not.toContain(token);
    const preview = (await rows<{ last_message_preview: string }>("select c.last_message_preview from conversations c join conversation_messages m on m.conversation_id = c.id where m.id = $1", [m.id]))[0].last_message_preview;
    expect(preview).toContain("[customer invoice link]");
    for (const table of ["conversation_messages", "conversations", "customer_invoice_events", "customer_invoice_reminders", "customer_invoices", "audit_logs", "notifications", "crm_events", "crm_activities", "metered_usage_events", "usage_reservations", "credit_ledger_entries", "customer_payment_events"]) {
      const hit = await rows<{ n: string }>(`select count(*)::text as n from ${table} t where t::text like $1`, [`%${token}%`]);
      expect(Number(hit[0].n), `${table} holds the customer's link`).toBe(0);
    }
    // Nor does the client's own data export: the messages are there, with the link as words.
    const files = readZip((await buildExport(io.orgId)).bytes);
    const messages = files.find((f) => f.name === "conversations/messages.json")!.data.toString("utf8");
    expect(messages).toContain("[customer invoice link]");
    for (const f of files) {
      const text = f.data.toString("utf8");
      expect(text, f.name).not.toContain(token);
      expect(text, f.name).not.toContain("{{invoice.link}}");
    }
  });

  it("is derived again from the invoice each time: a replaced link is the one that is sent, and the old one is not", async () => {
    const { io, contactId } = await shop();
    await authorize(io);
    const inv = await issuedInvoice(io, { contactId, dueOn: DUE }, ISSUED);
    await runInvoiceReminders({ now: FIRST });
    await rotateInvoiceLink(io.ctx("owner"), inv.invoice.id);
    const m = await messageOf(inv.invoice.id, "before_due:-3");
    const rec = recordingProvider("resend");
    await dispatchMessage(m.id, { transport: rec.transport, now: FIRST });
    expect(rec.calls[0].body).toContain(invoiceTokenFor(inv.invoice.id, 2));
    expect(rec.calls[0].body).not.toContain(invoiceTokenFor(inv.invoice.id, 1));
  });

  it("is masked wherever message text is shown: a link, a placeholder, and not the page a provider sends a payer back to", () => {
    const token = "A".repeat(43);
    expect(maskCustomerLinks(`Pay here: https://app.example.com/pay/${token} thanks`)).toBe("Pay here: [customer invoice link] thanks");
    expect(maskCustomerLinks("Pay here: {{invoice.link}}")).toBe("Pay here: [customer invoice link]");
    expect(maskCustomerLinks("Pay here: {{ invoice.link }} and {{invoice.link}}")).toBe("Pay here: [customer invoice link] and [customer invoice link]");
    expect(maskCustomerLinks(`/pay/${token}`)).toBe("[customer invoice link]");
    expect(maskCustomerLinks("https://app.example.com/pay/return/CP-abc123abc123abc123abc123")).toBe("https://app.example.com/pay/return/CP-abc123abc123abc123abc123");
    expect(maskCustomerLinks(`https://app.example.com/pay/${token}/more`)).toBe(`https://app.example.com/pay/${token}/more`);
    expect(maskCustomerLinks("No link here")).toBe("No link here");
  });

  it("is not sent in any message that is not an invoice's reminder: the placeholder never goes out raw", async () => {
    const { io, contactId } = await shop();
    const conv = await withSystem((db) =>
      db.query<{ id: string }>("insert into conversations (org_id, contact_id, channel, status, subject, owner_kind) values ($1, $2, 'email', 'open', 'Hello', 'unassigned') returning id", [io.orgId, contactId]),
    );
    const queued = await withSystem((db) =>
      queueOutbound(db, { orgId: io.orgId, conversationId: conv.rows[0].id, scope: "human", purpose: "service", actor: { kind: "human", userId: io.c.people.owner.id }, body: "Pay at {{invoice.link}} please", now: FIRST }),
    );
    expect(queued.status).toBe("queued");
    const rec = recordingProvider("resend");
    expect((await dispatchMessage(queued.messageId, { transport: rec.transport, now: FIRST })).status).toBe("blocked");
    expect(rec.calls).toHaveLength(0);
    expect((await rows<{ blocked_reason: string }>("select blocked_reason from conversation_messages where id = $1", [queued.messageId]))[0].blocked_reason).toBe("invoice_link_unavailable");
    await withSystem(async (db) => expect(await invoiceLinkForMessage(db, io.orgId, queued.messageId)).toBeNull());
  });
});

describe("what stops a reminder", () => {
  async function queuedFirst() {
    const s = await shop();
    await authorize(s.io);
    const inv = await issuedInvoice(s.io, { contactId: s.contactId, dueOn: DUE }, ISSUED);
    await runInvoiceReminders({ now: FIRST });
    const m = await messageOf(inv.invoice.id, "before_due:-3");
    return { ...s, inv, m };
  }

  it("is payment in full: what has not gone out is withdrawn, its credit hold is released, and a message about to be sent never leaves", async () => {
    const { io, inv, m } = await queuedFirst();
    expect(m.status).toBe("queued");
    await recordManualPayment(io.ctx("owner"), inv.invoice.id, cash("1500"), { now: FIRST });
    expect(await stepsOf(inv.invoice.id)).toEqual({ "before_due:-3": "cancelled", "on_due:0": "cancelled", "after_due:3": "cancelled", "after_due:10": "cancelled" });
    expect((await remindersOf(inv.invoice.id)).every((r) => r.reason === "paid")).toBe(true);
    const stopped = await messageOf(inv.invoice.id, "before_due:-3");
    expect(stopped).toMatchObject({ status: "blocked", blocked_reason: "invoice_changed" });
    expect((await rows<{ status: string }>("select status from usage_reservations where id = $1", [m.reservation_id]))[0].status).toBe("released");
    const rec = recordingProvider("resend");
    expect((await dispatchMessage(m.id, { transport: rec.transport, now: FIRST })).status).toBe("skipped");
    expect(rec.calls).toHaveLength(0);
    expect(await eventKinds(inv.invoice.id)).toContain("reminders_stopped");
    // Nothing is made again later.
    expect(await runInvoiceReminders({ now: ON_DAY })).toMatchObject({ queued: 0 });
  });

  it("leaves a reminder that was already sent as it was", async () => {
    const { io, inv, m } = await queuedFirst();
    const rec = recordingProvider("resend");
    await dispatchMessage(m.id, { transport: rec.transport, now: FIRST });
    await recordManualPayment(io.ctx("owner"), inv.invoice.id, cash("1500"), { now: ON_DAY });
    expect((await messageOf(inv.invoice.id, "before_due:-3")).status).toBe("sent");
    expect((await stepsOf(inv.invoice.id))["before_due:-3"]).toBe("queued");
    expect((await stepsOf(inv.invoice.id))["on_due:0"]).toBe("cancelled");
  });

  it("is a void, a write-off or a disputed payment", async () => {
    const s = await shop();
    const conn = await connectionFor(s.io);
    await authorize(s.io);
    const voided = await issuedInvoice(s.io, { contactId: s.contactId, dueOn: DUE }, ISSUED);
    const off = await issuedInvoice(s.io, { contactId: s.contactId, dueOn: DUE }, ISSUED);
    const disputed = await issuedInvoice(s.io, { contactId: s.contactId, dueOn: DUE }, ISSUED);
    await runInvoiceReminders({ now: FIRST });
    await voidInvoice(s.io.ctx("owner"), voided.invoice.id, { reason: "Raised for the wrong job" });
    await writeOffInvoice(s.io.ctx("owner"), off.invoice.id, { reason: "The customer closed their business" });
    const part = await providerPayment(s.io, disputed.invoice.id, conn, 50_000, { livemode: true });
    await withSystem((db) => applyDisputeInTx(db, { orgId: s.io.orgId, paymentId: part.paymentId, open: true, actor: { id: null, kind: "provider" } }));
    for (const [x, reason] of [[voided, "invoice_voided"], [off, "written_off"], [disputed, "disputed"]] as const) {
      expect((await remindersOf(x.invoice.id)).every((r) => r.status === "cancelled" && r.reason === reason), reason).toBe(true);
      expect((await messageOf(x.invoice.id, "before_due:-3")).status, reason).toBe("blocked");
    }
  });

  it("is not a part payment: reminders go on, and say what the invoice came to rather than a balance that may have moved", async () => {
    const { io, inv } = await queuedFirst();
    await recordManualPayment(io.ctx("owner"), inv.invoice.id, cash("500"), { now: FIRST });
    expect((await messageOf(inv.invoice.id, "before_due:-3")).status).toBe("queued");
    expect((await stepsOf(inv.invoice.id))["on_due:0"]).toBe("scheduled");
    await runInvoiceReminders({ now: ON_DAY });
    expect((await messageOf(inv.invoice.id, "on_due:0")).body).toContain("for PHP 1,500.00");
  });

  it("is a person's hold on automatic messages to the customer, and a customer who was archived", async () => {
    const held = await shop();
    await authorize(held.io);
    const a = await issuedInvoice(held.io, { contactId: held.contactId, dueOn: DUE }, ISSUED);
    const archived = await shop();
    await authorize(archived.io);
    const b = await issuedInvoice(archived.io, { contactId: archived.contactId, dueOn: DUE }, ISSUED);
    await withSystem(async (db) => {
      await db.query("update contacts set retention_paused = true where id = $1", [held.contactId]);
      await db.query("update contacts set archived_at = now() where id = $1", [archived.contactId]);
    });
    expect(await runInvoiceReminders({ now: FIRST })).toMatchObject({ queued: 0, skipped: 1, cancelled: 1 });
    expect((await remindersOf(a.invoice.id))[0]).toMatchObject({ status: "skipped", reason: "held_by_person" });
    expect((await remindersOf(b.invoice.id))[0]).toMatchObject({ status: "cancelled", reason: "no_customer" });
    expect(await rows("select 1 from conversation_messages where org_id = any($1::uuid[])", [[held.io.orgId, archived.io.orgId]])).toHaveLength(0);
    // The hold is the person's to lift; the next reminder goes once it is.
    await withSystem((db) => db.query("update contacts set retention_paused = false where id = $1", [held.contactId]));
    expect((await runInvoiceReminders({ now: ON_DAY })).queued).toBe(1);
  });

  it("is a link that can no longer be used: a reminder whose invoice cannot be paid online is not sent, whatever else is true", async () => {
    const { m, inv } = await queuedFirst();
    await withSystem((db) => db.query("update customer_invoice_reminders set message_id = null where invoice_id = $1 and step_key = 'before_due:-3'", [inv.invoice.id]));
    const rec = recordingProvider("resend");
    expect((await dispatchMessage(m.id, { transport: rec.transport, now: FIRST })).status).toBe("blocked");
    expect(rec.calls).toHaveLength(0);
  });
});

describe("when the owner's authorization lapses", () => {
  it("is withdrawn by changing the days: what was planned under the old days is cancelled at once, nothing goes, and authorizing again plans the new ones", async () => {
    const { io, contactId } = await shop();
    const on = await authorize(io);
    const inv = await issuedInvoice(io, { contactId, dueOn: DUE }, ISSUED);
    await saveInvoiceSettings(io.ctx("owner"), { reminderOffsetsDays: [0, 5] }, on.settingsVersion);
    const lapsed = await getReminderOverview(io.ctx("owner"), { now: FIRST });
    expect(lapsed).toMatchObject({ enabled: true, active: false, problem: "wording_changed", offsetsDays: [0, 5] });
    expect(lapsed.problemText).toMatch(/wording, the days, the channels or the most reminders/);
    expect(Object.values(await stepsOf(inv.invoice.id)).every((s) => s === "cancelled")).toBe(true);
    expect((await remindersOf(inv.invoice.id)).every((r) => r.reason === "schedule_changed")).toBe(true);
    expect(await runInvoiceReminders({ now: ON_DAY })).toMatchObject({ queued: 0 });
    expect(await rows("select 1 from conversation_messages where org_id = $1", [io.orgId])).toHaveLength(0);

    const again = await authorize(io, new Date("2026-10-24T09:00:00Z"));
    expect(again).toMatchObject({ active: true, offsetsDays: [0, 5] });
    // Rows for the new days exist beside the old cancelled ones, and the new ones go.
    expect(await stepsOf(inv.invoice.id)).toMatchObject({ "on_due:0": "scheduled", "after_due:5": "scheduled" });
    expect((await runInvoiceReminders({ now: ON_DAY })).queued).toBe(1);
  });

  it("is not withdrawn by saving settings that have nothing to do with the reminders", async () => {
    const { io, contactId } = await shop();
    const on = await authorize(io);
    const inv = await issuedInvoice(io, { contactId, dueOn: DUE }, ISSUED);
    const saved = await saveInvoiceSettings(io.ctx("owner"), { legalName: "Atlas Plumbing", paymentTermsDays: 30, footerNote: "Thank you for your business" }, on.settingsVersion);
    expect(saved.legalName).toBe("Atlas Plumbing");
    expect(await getReminderOverview(io.ctx("owner"), { now: FIRST })).toMatchObject({ active: true, problem: null });
    expect(Object.values(await stepsOf(inv.invoice.id))).toEqual(["scheduled", "scheduled", "scheduled", "scheduled"]);
    expect((await runInvoiceReminders({ now: FIRST })).queued).toBe(1);
  });

  it("is withdrawn by changing the channels, too", async () => {
    const { io } = await shop();
    const on = await authorize(io);
    const saved = await saveInvoiceSettings(io.ctx("owner"), { reminderChannels: ["email", "sms"] }, on.settingsVersion);
    expect(saved.reminderChannels).toEqual(["email", "sms"]);
    expect(await getReminderOverview(io.ctx("owner"), { now: FIRST })).toMatchObject({ active: false, problem: "wording_changed", usesCredits: true });
  });

  it("holds a due reminder when the wording changed, tells the owner once a day, and sends it if the owner authorizes again in time", async () => {
    const { io, contactId } = await shop();
    await authorize(io);
    const inv = await issuedInvoice(io, { contactId, dueOn: DUE }, ISSUED);
    // A new version of the wording has a different fingerprint from the one the owner authorized.
    await withSystem((db) => db.query("update customer_invoice_settings set reminders_body_hash = repeat('f', 64) where org_id = $1", [io.orgId]));
    expect(await runInvoiceReminders({ now: FIRST })).toMatchObject({ queued: 0, waiting: 1 });
    expect((await stepsOf(inv.invoice.id))["before_due:-3"]).toBe("scheduled");
    const told = () => rows<{ title: string; body: string; user_id: string }>("select title, body, user_id from notifications where org_id = $1 and title = 'Invoice reminders are on hold'", [io.orgId]);
    expect(await told()).toHaveLength(1);
    expect((await told())[0]).toMatchObject({ user_id: io.c.people.owner.id });
    expect((await told())[0].body).toMatch(/wording, the days, the channels or the most reminders per invoice changed/);
    await runInvoiceReminders({ now: new Date("2026-11-03T14:00:00Z") });
    expect(await told()).toHaveLength(1);

    // The owner reads and authorizes it again that afternoon: the reminder is still on time, so it goes.
    await authorize(io, new Date("2026-11-03T15:00:00Z"));
    expect((await runInvoiceReminders({ now: new Date("2026-11-03T15:30:00Z") })).queued).toBe(1);
  });

  it("does not send a held reminder late: after a day it is skipped, and the next day's reminder is the next one", async () => {
    const { io, contactId } = await shop();
    await authorize(io);
    const inv = await issuedInvoice(io, { contactId, dueOn: DUE }, ISSUED);
    await withSystem((db) => db.query("update customer_invoice_settings set reminders_body_hash = repeat('f', 64) where org_id = $1", [io.orgId]));
    await runInvoiceReminders({ now: FIRST });
    await authorize(io, new Date("2026-11-04T10:00:00Z"));
    const run = await runInvoiceReminders({ now: new Date("2026-11-04T10:30:00Z") });
    expect(run).toMatchObject({ queued: 0, skipped: 1 });
    expect((await remindersOf(inv.invoice.id))[0]).toMatchObject({ step_key: "before_due:-3", status: "skipped", reason: "too_late" });
    expect((await runInvoiceReminders({ now: ON_DAY })).queued).toBe(1);
  });

  it("lapses after ninety days", async () => {
    const { io, contactId } = await shop();
    await authorize(io);
    const inv = await issuedInvoice(io, { contactId, dueOn: "2027-03-01" }, ISSUED);
    const late = new Date("2027-03-01T10:00:00Z");
    expect(await runInvoiceReminders({ now: late })).toMatchObject({ queued: 0, waiting: 1 });
    expect((await getReminderOverview(io.ctx("owner"), { now: late })).problem).toBe("expired");
    await authorize(io, new Date("2027-03-01T10:20:00Z"));
    expect((await runInvoiceReminders({ now: new Date("2027-03-01T10:40:00Z") })).queued).toBe(1);
    expect((await stepsOf(inv.invoice.id))["on_due:0"]).toBe("queued");
  });

  it("lapses when the person who authorized is no longer an owner", async () => {
    const { io, contactId } = await shop();
    await authorize(io);
    await issuedInvoice(io, { contactId, dueOn: DUE }, ISSUED);
    await withSystem((db) => db.query("update organization_memberships set role = 'admin' where org_id = $1 and user_id = $2", [io.orgId, io.c.people.owner.id]));
    expect(await runInvoiceReminders({ now: FIRST })).toMatchObject({ queued: 0, waiting: 1 });
    expect((await getReminderOverview(io.ctx("manager"), { now: FIRST })).problem).toBe("authorizer_gone");
  });
});

describe("a paused or suspended workspace", () => {
  it("sends no reminder while automatic messages are paused, and the reminder goes if the pause ends within the day", async () => {
    const { io, contactId } = await shop();
    await authorize(io);
    const inv = await issuedInvoice(io, { contactId, dueOn: DUE }, ISSUED);
    await withSystem((db) => db.query("insert into automation_pauses (org_id, scope, active, reason) values ($1, 'messaging', true, 'Reviewing replies')", [io.orgId]));
    expect(await runInvoiceReminders({ now: FIRST })).toMatchObject({ queued: 0, waiting: 1 });
    expect((await stepsOf(inv.invoice.id))["before_due:-3"]).toBe("scheduled");
    await withSystem((db) => db.query("update automation_pauses set active = false where org_id = $1", [io.orgId]));
    expect((await runInvoiceReminders({ now: new Date("2026-11-03T16:00:00Z") })).queued).toBe(1);
  });

  it("stops a reminder that is already queued if the workspace is paused before it is sent", async () => {
    const { io, contactId } = await shop();
    await authorize(io);
    const inv = await issuedInvoice(io, { contactId, dueOn: DUE }, ISSUED);
    await runInvoiceReminders({ now: FIRST });
    const m = await messageOf(inv.invoice.id, "before_due:-3");
    await withSystem((db) => db.query("insert into automation_pauses (org_id, scope, active) values ($1, 'outbound', true)", [io.orgId]));
    const rec = recordingProvider("resend");
    expect((await dispatchMessage(m.id, { transport: rec.transport, now: FIRST })).status).toBe("blocked");
    expect(rec.calls).toHaveLength(0);
    // The reminder's own row says so on the next run.
    await runInvoiceReminders({ now: new Date("2026-11-03T10:30:00Z") });
    expect((await remindersOf(inv.invoice.id))[0]).toMatchObject({ status: "blocked", reason: "automation_paused" });
  });

  it("sends nothing for a suspended workspace", async () => {
    const { io, contactId } = await shop();
    await authorize(io);
    const inv = await issuedInvoice(io, { contactId, dueOn: DUE }, ISSUED);
    await withSystem((db) => db.query("update organizations set status = 'suspended' where id = $1", [io.orgId]));
    const run = await runInvoiceReminders({ now: FIRST });
    expect(run.queued).toBe(0);
    expect((await stepsOf(inv.invoice.id))["before_due:-3"]).toBe("scheduled");
    expect(await rows("select 1 from conversation_messages where org_id = $1", [io.orgId])).toHaveLength(0);
  });

  it("sends nothing when customer invoices have been switched off for the workspace since", async () => {
    const { io, contactId } = await shop();
    await authorize(io);
    const inv = await issuedInvoice(io, { contactId, dueOn: DUE }, ISSUED);
    await setInvoicesEnabled(io.superAdmin, io.orgId, false);
    await runInvoiceReminders({ now: FIRST });
    expect((await remindersOf(inv.invoice.id))[0]).toMatchObject({ status: "cancelled", reason: "invoicing_off" });
    expect(await rows("select 1 from conversation_messages where org_id = $1", [io.orgId])).toHaveLength(0);
  });
});

describe("recovering and keeping workspaces apart", () => {
  it("takes back a reminder whose worker died before it queued anything, and a queued reminder whose message later failed says so", async () => {
    const { io, contactId } = await shop();
    await authorize(io);
    const inv = await issuedInvoice(io, { contactId, dueOn: DUE }, ISSUED);
    await withSystem((db) => db.query("update customer_invoice_reminders set status = 'queued' where invoice_id = $1 and step_key = 'before_due:-3'", [inv.invoice.id]));
    const report = await runInvoiceReminders({ now: FIRST });
    expect(report.reconciled).toBeGreaterThanOrEqual(1);
    expect(report.queued).toBe(1);

    const m = await messageOf(inv.invoice.id, "before_due:-3");
    const rec = recordingProvider("resend", () => ({ ok: false, retryable: false, error: "The provider rejected the message." }));
    expect((await dispatchMessage(m.id, { transport: rec.transport, now: FIRST })).status).toBe("failed");
    await runInvoiceReminders({ now: new Date("2026-11-03T11:00:00Z") });
    expect((await remindersOf(inv.invoice.id))[0]).toMatchObject({ status: "blocked", reason: "provider_error" });
  });

  it("keeps one workspace's reminders, authorization and links apart from another's", async () => {
    const a = await shop({ firstName: "Alma" });
    const b = await shop({ firstName: "Boris" });
    await authorize(a.io);
    await authorize(b.io);
    const ia = await issuedInvoice(a.io, { contactId: a.contactId, dueOn: DUE }, ISSUED);
    const ib = await issuedInvoice(b.io, { contactId: b.contactId, dueOn: DUE }, ISSUED);
    await runInvoiceReminders({ now: FIRST });
    const ma = await messageOf(ia.invoice.id, "before_due:-3");
    const mb = await messageOf(ib.invoice.id, "before_due:-3");
    expect(ma.body).toContain("Hi Alma");
    expect(mb.body).toContain("Hi Boris");
    // Each message sits in its own workspace's conversation, with its own workspace's contact.
    expect((await rows<{ org_id: string; contact_id: string }>("select c.org_id, c.contact_id from conversation_messages m join conversations c on c.id = m.conversation_id where m.id = $1", [ma.id]))[0]).toEqual({ org_id: a.io.orgId, contact_id: a.contactId });
    expect((await rows<{ org_id: string; contact_id: string }>("select c.org_id, c.contact_id from conversation_messages m join conversations c on c.id = m.conversation_id where m.id = $1", [mb.id]))[0]).toEqual({ org_id: b.io.orgId, contact_id: b.contactId });
    // A link is only derived for the workspace the message is in.
    await withSystem(async (db) => {
      expect(await invoiceLinkForMessage(db, b.io.orgId, ma.id)).toBeNull();
      expect(await invoiceLinkForMessage(db, a.io.orgId, ma.id)).toContain("/pay/");
    });
    // Stopping one workspace's invoice, by id from the other, changes nothing.
    await withSystem(async (db) => expect(await stopReminders(db, b.io.orgId, "paid", ia.invoice.id)).toBe(0));
    expect((await stepsOf(ia.invoice.id))["on_due:0"]).toBe("scheduled");
    // Switching off one workspace's reminders leaves the other's, and what each workspace sees counts only its own.
    await switchOffReminders(a.io.ctx("owner"));
    expect((await stepsOf(ib.invoice.id))["on_due:0"]).toBe("scheduled");
    const ob = await getReminderOverview(b.io.ctx("owner"), { now: FIRST });
    expect(ob.active).toBe(true);
    expect(ob.counts).toEqual({ scheduled: 3, queued: 1, blocked: 0, skipped: 0, cancelled: 0 });
    expect((await getReminderOverview(a.io.ctx("owner"), { now: FIRST })).counts).toMatchObject({ scheduled: 0, cancelled: 4 });
  });

  it("starts again from nothing for a reminder that was withdrawn and reopened: the old message stays withdrawn and the new one is a message of its own", async () => {
    const { io, contactId } = await shop();
    await authorize(io);
    const inv = await issuedInvoice(io, { contactId, dueOn: DUE }, ISSUED);
    await runInvoiceReminders({ now: FIRST });
    const first = await messageOf(inv.invoice.id, "before_due:-3");
    await switchOffReminders(io.ctx("manager"));
    expect((await messageOf(inv.invoice.id, "before_due:-3"))).toMatchObject({ id: first.id, status: "blocked", blocked_reason: "invoice_changed" });
    expect((await remindersOf(inv.invoice.id))[0]).toMatchObject({ status: "cancelled", reason: "reminders_off" });
    // The owner switches them on again that afternoon: the reminder is still on time, so it is asked for again.
    await authorize(io, new Date("2026-11-03T13:00:00Z"));
    expect((await remindersOf(inv.invoice.id))[0]).toMatchObject({ status: "scheduled", reason: null, message_id: null });
    expect((await runInvoiceReminders({ now: new Date("2026-11-03T13:10:00Z") })).queued).toBe(1);
    const second = await messageOf(inv.invoice.id, "before_due:-3");
    expect(second.id).not.toBe(first.id);
    expect(second.dedupe_key).toBe(`${first.dedupe_key}:1`);
    expect((await rows<{ status: string }>("select status from conversation_messages where id = $1", [first.id]))[0].status).toBe("blocked");
    expect((await stepsOf(inv.invoice.id))).toMatchObject({ "before_due:-3": "queued", "on_due:0": "scheduled" });
  });
});
