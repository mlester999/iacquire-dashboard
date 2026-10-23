import "server-only";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { sanitizeErrorText } from "@/lib/ops";
import { notifyOrgRoles } from "@/server/notifications";
import { releaseReservation } from "@/server/billing/ledger";
import { checkOrgAutomation } from "@/server/automation/gate";
import { contactAddress } from "@/server/messaging/contacts";
import { evaluateSend, queueOutbound } from "@/server/messaging/send";
import type { OrgContext } from "@/server/tenancy/context";
import type { CurrencyCode } from "@/lib/money";
import { stepKeyFor, stepLabel } from "@/lib/invoices/reminders";
import {
  AUTHORIZATION_PROBLEM_TEXT, decideReminder, planReminders, reminderReasonText, type AuthorizationProblem, type InvoiceFacts, type PlanOp, type ReminderRowStatus,
} from "@/lib/invoices/reminder-rules";
import {
  normalizeSetup, phaseOfStepKey, previewReminderBody, REMINDER_AUTHORIZATION_DAYS, REMINDER_CHANNEL_LABELS, REMINDER_CHANNELS, REMINDER_WORDING_VERSION, reminderAuthorizationHash,
  reminderTextProblem, renderReminder, type ReminderChannel,
} from "@/lib/invoices/reminder-text";
import { assertInvoicesAvailable } from "@/server/invoices/feature";
import { invoiceLinkUrl, tokenForStoredHash } from "@/server/invoices/links";
import { addInvoiceEvent, readSettings, toMinor, type SettingsRow } from "@/server/invoices/core";
import { currentAuthorizationProblem, setupOf } from "@/server/invoices/reminder-auth";

// Reminders about an unpaid invoice, through the same consent-gated send chain as every other message to a customer (src/server/messaging/send.ts, scope "billing").
//
//  * Off until the owner has authorized the exact wording, days, channels and maximum (authorizeReminders). The authorization is a fingerprint of all of those, so changing any
//    of them, a new version of the wording, the passage of 90 days or the authorizer leaving the owner's role puts the reminders on hold until it is given again.
//  * The text is fixed in code (src/lib/invoices/reminder-text.ts): no AI, nothing typed by a customer. Where the customer's link goes it holds {{invoice.link}}; the link is
//    derived again at the moment of sending (invoiceLinkForMessage) and exists only in the provider's request. It is never stored in a message, a log, an audit row or an export.
//  * A reminder stops when the invoice is paid, voided, written off or disputed, and one that has not gone out yet is withdrawn from the queue at that moment. Nothing is sent late.
//  * Every reminder ends with an outcome on its row: queued (handed to the send chain), blocked (with the chain's reason: no consent, opted out, no credits, channel not ready),
//    skipped or cancelled, each with a reason a person can read.

const CLAIM_LIMIT = 25;
const BACKFILL_LIMIT = 100;
const RESYNC_LIMIT = 500;
const STALE_CLAIM_MINUTES = 10;
const CHANNEL_ORDER: readonly ReminderChannel[] = REMINDER_CHANNELS;

// ---------------------------------------------------------------------------
// The link, derived at the moment of sending
// ---------------------------------------------------------------------------

/**
 * The customer's link for the reminder a queued message belongs to, for the provider call only. Null when the message is not an invoice reminder's, or its invoice can no
 * longer be paid online. The link is derived again from the invoice and checked against the stored hash (so a link made with a retired key still matches).
 */
export async function invoiceLinkForMessage(db: Queryable, orgId: string, messageId: string): Promise<string | null> {
  const { rows } = await db.query<{ invoice_id: string; status: string; payment_status: string; written_off_at: Date | null; balance_minor: string; public_token_version: number; public_token_hash: string | null }>(
    `select i.id as invoice_id, i.status, i.payment_status, i.written_off_at, i.balance_minor::text as balance_minor, i.public_token_version, i.public_token_hash
     from customer_invoice_reminders r join customer_invoices i on i.id = r.invoice_id and i.org_id = r.org_id where r.org_id = $1 and r.message_id = $2 limit 1`,
    [orgId, messageId],
  );
  const i = rows[0];
  if (!i || i.status !== "issued" || i.written_off_at || !["unpaid", "partially_paid"].includes(i.payment_status) || toMinor(i.balance_minor) <= 0) return null;
  const token = tokenForStoredHash(i.invoice_id, i.public_token_version, i.public_token_hash);
  return token ? invoiceLinkUrl(token) : null;
}

// ---------------------------------------------------------------------------
// Keeping an invoice's reminder rows in step with the invoice and the settings
// ---------------------------------------------------------------------------

interface InvoiceRowFacts {
  id: string;
  status: InvoiceFacts["status"];
  payment_status: InvoiceFacts["paymentStatus"];
  written_off_at: Date | null;
  balance_minor: string;
  due_on: string | null;
  contact_id: string | null;
}

const INVOICE_FACTS_SQL = `select id, status, payment_status, written_off_at, balance_minor::text as balance_minor, to_char(due_on, 'YYYY-MM-DD') as due_on, contact_id from customer_invoices`;

const factsOf = (i: InvoiceRowFacts, hasCustomer: boolean): InvoiceFacts => ({
  status: i.status, paymentStatus: i.payment_status, writtenOff: i.written_off_at !== null, balanceMinor: toMinor(i.balance_minor), dueOn: i.due_on, hasCustomer,
});

/** The customer is still one the business works with: not removed, not archived. */
async function customerExists(db: Queryable, orgId: string, contactId: string | null): Promise<boolean> {
  if (!contactId) return false;
  return (await db.query("select 1 from contacts where id = $1 and org_id = $2 and deleted_at is null and archived_at is null", [contactId, orgId])).rows.length > 0;
}

async function applyPlan(db: Queryable, orgId: string, invoiceId: string, ops: PlanOp[]): Promise<void> {
  for (const op of ops) {
    if (op.op === "insert") {
      await db.query(
        "insert into customer_invoice_reminders (org_id, invoice_id, step_key, due_at, status, reason) values ($1, $2, $3, $4, $5, $6) on conflict (invoice_id, step_key) do nothing",
        [orgId, invoiceId, op.stepKey, op.dueAt, op.status, op.reason],
      );
    } else if (op.op === "reopen") {
      // The message it once had (if any) was withdrawn when it was cancelled, so it starts again from nothing.
      await db.query("update customer_invoice_reminders set status = 'scheduled', reason = null, message_id = null, due_at = $4 where invoice_id = $1 and org_id = $2 and step_key = $3 and status = 'cancelled'", [invoiceId, orgId, op.stepKey, op.dueAt]);
    } else {
      await db.query("update customer_invoice_reminders set status = 'cancelled', reason = $4 where invoice_id = $1 and org_id = $2 and step_key = $3 and status = 'scheduled'", [invoiceId, orgId, op.stepKey, op.reason]);
    }
  }
}

/**
 * Makes an invoice's reminder rows match the invoice and the workspace's settings: a row for each planned day (one already past is stored as skipped, never sent late),
 * scheduled rows withdrawn for an invoice that can no longer be reminded about or when reminders are off. Safe to run again at any time.
 */
export async function syncInvoiceReminders(db: Queryable, orgId: string, invoiceId: string, now = new Date()): Promise<{ inserted: number; cancelled: number }> {
  const inv = (await db.query<InvoiceRowFacts>(`${INVOICE_FACTS_SQL} where id = $1 and org_id = $2`, [invoiceId, orgId])).rows[0];
  if (!inv) return { inserted: 0, cancelled: 0 };
  const settings = await readSettings(db, orgId);
  const tz = (await db.query<{ timezone: string }>("select timezone from organizations where id = $1", [orgId])).rows[0]?.timezone ?? "UTC";
  const existing = (await db.query<{ step_key: string; status: ReminderRowStatus; reason: string | null }>("select step_key, status, reason from customer_invoice_reminders where invoice_id = $1 and org_id = $2 for update", [invoiceId, orgId])).rows;
  const ops = planReminders({
    remindersEnabled: settings.remindersEnabled, offsetsDays: settings.reminderOffsetsDays, max: settings.reminderMax, tz, now, invoice: factsOf(inv, await customerExists(db, orgId, inv.contact_id)),
    existing: existing.map((e) => ({ stepKey: e.step_key, status: e.status, reason: e.reason })),
  });
  await applyPlan(db, orgId, invoiceId, ops);
  return { inserted: ops.filter((o) => o.op === "insert" || o.op === "reopen").length, cancelled: ops.filter((o) => o.op === "cancel").length };
}

/**
 * Stops the reminders of one invoice (or, without an invoice, of the whole workspace): rows still scheduled are cancelled, and a reminder already handed to the send chain
 * that has not gone out yet is withdrawn and its credit hold released. A reminder that was sent stays as it is. Returns how many were stopped.
 */
export async function stopReminders(db: Queryable, orgId: string, reason: string, invoiceId?: string): Promise<number> {
  const scheduled = invoiceId
    ? await db.query("update customer_invoice_reminders set status = 'cancelled', reason = $2 where org_id = $1 and invoice_id = $3 and status = 'scheduled'", [orgId, reason, invoiceId])
    : await db.query("update customer_invoice_reminders set status = 'cancelled', reason = $2 where org_id = $1 and status = 'scheduled'", [orgId, reason]);
  let stopped = scheduled.rowCount ?? 0;
  const queued = invoiceId
    ? await db.query<{ id: string; message_id: string }>("select id, message_id from customer_invoice_reminders where org_id = $1 and invoice_id = $2 and status = 'queued' and message_id is not null", [orgId, invoiceId])
    : await db.query<{ id: string; message_id: string }>("select id, message_id from customer_invoice_reminders where org_id = $1 and status = 'queued' and message_id is not null", [orgId]);
  for (const r of queued.rows) {
    // The dispatcher claims a message with the same status check, so exactly one side wins: a message already on its way is not withdrawn.
    const m = (await db.query<{ reservation_id: string | null }>(
      "update conversation_messages set status = 'blocked', blocked_reason = 'invoice_changed', status_detail = 'Stopped before sending.' where id = $1 and org_id = $2 and status in ('draft', 'queued') returning reservation_id",
      [r.message_id, orgId],
    )).rows[0];
    if (!m) continue;
    if (m.reservation_id) await releaseReservation(db, { orgId, reservationId: m.reservation_id, reason: `Stopped: ${reason}` });
    await db.query("update customer_invoice_reminders set status = 'cancelled', reason = $2 where id = $1", [r.id, reason]);
    stopped += 1;
  }
  if (stopped && invoiceId) await addInvoiceEvent(db, orgId, invoiceId, "reminders_stopped", { id: null, kind: "system" }, { reason, count: stopped });
  return stopped;
}

// ---------------------------------------------------------------------------
// The owner's authorization
// ---------------------------------------------------------------------------

export interface ReminderPreview {
  stepKey: string;
  label: string;
  subject: string;
  /** The text a customer reads, with the customer's own link shown as words. */
  body: string;
}

export interface ReminderOverview {
  enabled: boolean;
  /** The reminders go out now (switched on and the authorization covers what would be sent). */
  active: boolean;
  problem: AuthorizationProblem | null;
  problemText: string | null;
  authorizedAt: string | null;
  authorizedByName: string | null;
  expiresAt: string | null;
  wordingVersion: string;
  /** Nobody has approved this wording yet except the owner who authorizes it: counsel has not reviewed it. */
  wordingIsDraft: boolean;
  /** What the owner authorizes: send it back with the authorization. */
  wordingHash: string;
  settingsVersion: number;
  offsetsDays: number[];
  max: number;
  channels: ReminderChannel[];
  channelLabels: string[];
  /** A text message or WhatsApp message uses the business's prepaid service credits. */
  usesCredits: boolean;
  previews: ReminderPreview[];
  counts: Record<ReminderRowStatus, number>;
}

/** What the reminders will say, for the days the settings call for, on a made-up invoice (it is labelled as an example by the screen). */
export function previewsFor(s: SettingsRow, business: string, currency: CurrencyCode): ReminderPreview[] {
  const setup = normalizeSetup(setupOf(s));
  return setup.offsetsDays.slice(0, setup.max).map((offset) => {
    const key = stepKeyFor(offset);
    const r = renderReminder({ phase: phaseOfStepKey(key) ?? "on_due", firstName: "Maria", business, number: `${s.numberPrefix}0001`, totalMinor: 150_000, currency, dueOn: "2026-11-06" });
    return { stepKey: key, label: stepLabel(offset), subject: r.subject, body: previewReminderBody(r.body) };
  });
}

export async function getReminderOverview(ctx: OrgContext, deps: { now?: Date } = {}): Promise<ReminderOverview> {
  if (!ctx.can("invoices.view")) throw new AppError("forbidden", "Your role can't see invoices.");
  const now = deps.now ?? new Date();
  return withUser(ctx.user.id, async (db) => {
    await assertInvoicesAvailable(db, ctx);
    const s = await readSettings(db, ctx.org.orgId);
    const org = (await db.query<{ name: string }>("select name from organizations where id = $1", [ctx.org.orgId])).rows[0];
    const who = s.remindersAuthorizedBy ? (await db.query<{ full_name: string }>("select full_name from users where id = $1", [s.remindersAuthorizedBy])).rows[0] : undefined;
    const counts = { scheduled: 0, queued: 0, blocked: 0, skipped: 0, cancelled: 0 } as Record<ReminderRowStatus, number>;
    for (const r of (await db.query<{ status: ReminderRowStatus; n: number }>("select status, count(*)::int as n from customer_invoice_reminders where org_id = $1 group by status", [ctx.org.orgId])).rows) counts[r.status] = r.n;
    const problem = await currentAuthorizationProblem(db, ctx.org.orgId, s, now);
    const authorizedAt = s.remindersAuthorizedAt ? new Date(s.remindersAuthorizedAt) : null;
    return {
      enabled: s.remindersEnabled, active: s.remindersEnabled && problem === null, problem, problemText: problem ? AUTHORIZATION_PROBLEM_TEXT[problem] : null, authorizedAt: s.remindersAuthorizedAt,
      authorizedByName: who?.full_name ?? null, expiresAt: authorizedAt ? new Date(authorizedAt.getTime() + REMINDER_AUTHORIZATION_DAYS * 86_400_000).toISOString() : null,
      wordingVersion: REMINDER_WORDING_VERSION, wordingIsDraft: REMINDER_WORDING_VERSION.startsWith("draft"), wordingHash: reminderAuthorizationHash(setupOf(s)), settingsVersion: s.version,
      offsetsDays: normalizeSetup(setupOf(s)).offsetsDays, max: s.reminderMax, channels: normalizeSetup(setupOf(s)).channels, channelLabels: normalizeSetup(setupOf(s)).channels.map((c) => REMINDER_CHANNEL_LABELS[c]),
      usesCredits: s.reminderChannels.some((c) => c !== "email"), previews: previewsFor(s, s.legalName ?? org?.name ?? "Your business", s.defaultCurrency ?? "PHP"), counts,
    };
  });
}

export interface AuthorizeInput {
  /** The fingerprint the owner was shown (ReminderOverview.wordingHash). A change since then means they did not read what would be sent. */
  wordingHash: string;
  settingsVersion: number;
}

/**
 * The owner authorizes the reminders in exactly the wording, days, channels and maximum they were shown. Switching them on is the owner's alone; it takes effect for invoices
 * already issued and still owed as well (only reminders still in the future are scheduled: nothing is sent late), and the authorization lapses by itself after 90 days or if
 * any of what was authorized changes.
 */
export async function authorizeReminders(ctx: OrgContext, input: AuthorizeInput, deps: { now?: Date } = {}): Promise<ReminderOverview> {
  if (!ctx.can("invoices.settings")) throw new AppError("forbidden", "Only the business owner can authorize invoice reminders.");
  const now = deps.now ?? new Date();
  await withSystem(async (db) => {
    await assertInvoicesAvailable(db, ctx);
    await db.query("insert into customer_invoice_settings (org_id, version) values ($1, 0) on conflict (org_id) do nothing", [ctx.org.orgId]);
    const s = await readSettings(db, ctx.org.orgId);
    if (s.version !== input.settingsVersion) throw new AppError("conflict", "Someone changed the invoice settings. Read the reminders again before you authorize them.");
    const hash = reminderAuthorizationHash(setupOf(s));
    if (hash !== input.wordingHash) throw new AppError("conflict", "The wording, the days or the channels changed since you read them. Read the reminders again before you authorize them.");
    const setup = normalizeSetup(setupOf(s));
    if (!setup.offsetsDays.length) throw new AppError("invalid_input", "Choose at least one reminder day before you authorize reminders.");
    // Every wording the product could send must pass its own checks; a reminder that fails them is never queued, so an authorization for it would promise nothing.
    for (const offset of setup.offsetsDays) {
      const phase = phaseOfStepKey(stepKeyFor(offset));
      const problem = phase ? reminderTextProblem(renderReminder({ phase, firstName: "Maria", business: "Business", number: "INV-0001", totalMinor: 100, currency: "PHP", dueOn: "2026-11-06" }).body) : "Unknown reminder.";
      if (problem) throw new AppError("internal", problem);
    }
    const saved = await db.query(
      `update customer_invoice_settings set reminders_enabled = true, reminders_authorized_by = $2, reminders_authorized_at = $3, reminders_body_hash = $4, version = version + 1, updated_by = $2
       where org_id = $1 and version = $5 returning version`,
      [ctx.org.orgId, ctx.user.id, now, hash, input.settingsVersion],
    );
    if (!saved.rows[0]) throw new AppError("conflict", "Someone changed the invoice settings. Read the reminders again before you authorize them.");
    await recordAudit({
      orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "invoices.reminders_authorized", targetType: "customer_invoice_settings", targetId: ctx.org.orgId, result: "success",
      metadata: { wordingVersion: REMINDER_WORDING_VERSION, wordingFingerprint: hash, offsetsDays: setup.offsetsDays, max: setup.max, channels: setup.channels },
    }, db);
    // Invoices already issued and still owed get their reminders from now on.
    const open = await db.query<{ id: string }>(
      `select id from customer_invoices where org_id = $1 and status = 'issued' and payment_status in ('unpaid', 'partially_paid') and written_off_at is null and due_on is not null order by due_on limit ${RESYNC_LIMIT}`,
      [ctx.org.orgId],
    );
    for (const r of open.rows) await syncInvoiceReminders(db, ctx.org.orgId, r.id, now);
  });
  return getReminderOverview(ctx, { now });
}

/** Switches the reminders off at once. The owner and managers may: stopping a message to customers should never be hard. Scheduled reminders are cancelled and anything queued but not sent is withdrawn. */
export async function switchOffReminders(ctx: OrgContext): Promise<ReminderOverview> {
  if (!ctx.can("invoices.send") && !ctx.can("invoices.settings")) throw new AppError("forbidden", "Only the business owner or a manager can switch invoice reminders off.");
  await withSystem(async (db) => {
    await assertInvoicesAvailable(db, ctx);
    await db.query("update customer_invoice_settings set reminders_enabled = false, version = version + 1, updated_by = $2 where org_id = $1 and reminders_enabled", [ctx.org.orgId, ctx.user.id]);
    const stopped = await stopReminders(db, ctx.org.orgId, "reminders_off");
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "invoices.reminders_off", targetType: "customer_invoice_settings", targetId: ctx.org.orgId, result: "success", metadata: { stopped } }, db);
  });
  return getReminderOverview(ctx);
}

/**
 * Called when the settings that make up the authorization are changed (the days, the maximum, the channels). The authorization no longer covers what would be sent, so what is
 * scheduled or queued under the old setup is withdrawn now, and the owner is told to authorize again. Returns true when something was withdrawn.
 */
export async function withdrawForChangedSetup(db: Queryable, orgId: string, before: SettingsRow, after: SettingsRow): Promise<boolean> {
  if (!before.remindersEnabled) return false;
  if (reminderAuthorizationHash(setupOf(before)) === reminderAuthorizationHash(setupOf(after))) return false;
  await stopReminders(db, orgId, "schedule_changed");
  return true;
}

// ---------------------------------------------------------------------------
// The scheduled job
// ---------------------------------------------------------------------------

export interface RemindersReport {
  reconciled: number;
  scheduled: number;
  queued: number;
  blocked: number;
  waiting: number;
  skipped: number;
  cancelled: number;
}

interface Claimed {
  id: string;
  org_id: string;
  invoice_id: string;
  step_key: string;
  due_at: Date;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

async function reconcile(now: Date): Promise<number> {
  return withSystem(async (db) => {
    // A claim whose worker died before it queued anything goes back to be claimed again.
    const back = await db.query("update customer_invoice_reminders set status = 'scheduled' where status = 'queued' and message_id is null and updated_at < $1::timestamptz - make_interval(mins => $2::int)", [now.toISOString(), STALE_CLAIM_MINUTES]);
    // A queued reminder whose message was stopped or failed after it was queued says so.
    const ended = await db.query(
      `update customer_invoice_reminders r set status = 'blocked', reason = coalesce(m.blocked_reason, 'provider_error')
       from conversation_messages m where m.id = r.message_id and m.org_id = r.org_id and r.status = 'queued' and m.status in ('failed', 'blocked')`,
    );
    return (back.rowCount ?? 0) + (ended.rowCount ?? 0);
  });
}

/** Invoices that are owed and have no reminder rows at all (issued before reminders were on, or by a path that did not plan them) get them now. */
async function backfill(now: Date): Promise<number> {
  return withSystem(async (db) => {
    const { rows } = await db.query<{ id: string; org_id: string }>(
      `select i.id, i.org_id from customer_invoices i
       join customer_invoice_settings s on s.org_id = i.org_id and s.reminders_enabled
       join org_features f on f.org_id = i.org_id and f.feature = 'invoices' and f.enabled
       where i.status = 'issued' and i.payment_status in ('unpaid', 'partially_paid') and i.written_off_at is null and i.due_on is not null and i.contact_id is not null
         and not exists (select 1 from customer_invoice_reminders r where r.invoice_id = i.id)
       order by i.due_on limit ${BACKFILL_LIMIT}`,
    );
    let n = 0;
    for (const r of rows) n += (await syncInvoiceReminders(db, r.org_id, r.id, now)).inserted;
    return n;
  });
}

async function claim(now: Date, limit: number): Promise<Claimed[]> {
  return withSystem(async (db) =>
    (await db.query<Claimed>(
      `update customer_invoice_reminders set status = 'queued' where id in (
         select r.id from customer_invoice_reminders r where r.status = 'scheduled' and r.due_at <= $1 order by r.updated_at, r.due_at limit $2 for update skip locked)
       returning id, org_id, invoice_id, step_key, due_at`,
      [now.toISOString(), limit],
    )).rows,
  );
}

type Outcome = "queued" | "blocked" | "waiting" | "skipped" | "cancelled" | "gone";

async function conversationFor(db: Queryable, orgId: string, contactId: string, channel: ReminderChannel, subject: string): Promise<string> {
  const existing = (await db.query<{ id: string }>(
    "select id from conversations where org_id = $1 and contact_id = $2 and channel = $3 and status <> 'closed' order by last_message_at desc nulls last, created_at limit 1", [orgId, contactId, channel],
  )).rows[0];
  if (existing) return existing.id;
  // A new conversation is the team's, not an AI employee's: a customer who answers a bill reaches a person.
  return (await db.query<{ id: string }>(
    `insert into conversations (org_id, contact_id, channel, status, subject, owner_kind) values ($1, $2, $3, 'open', $4, 'unassigned')
     on conflict (org_id, contact_id, channel, thread_key) do update set updated_at = now() returning id`,
    [orgId, contactId, channel, subject.slice(0, 300)],
  )).rows[0].id;
}

interface QueueResult {
  status: "queued" | "blocked";
  reason: string | null;
  detail: string | null;
  messageId?: string;
  channel?: ReminderChannel;
}

/** Hands the reminder to the send chain on the first allowed channel the customer can be reached on. The chain decides every rule; this only chooses where to try. */
async function queueOnChannels(
  db: Queryable,
  p: { orgId: string; contactId: string; invoiceId: string; dedupeKey: string; channels: readonly ReminderChannel[]; authorizerId: string | null; render: () => { subject: string; body: string }; now: Date },
): Promise<QueueResult> {
  // The reason shown is the first channel's: the one the business would most expect to have worked.
  const refusals: Array<{ reason: string; detail: string }> = [];
  const note = (reason: string, detail: string) => {
    if (!refusals.length) refusals.push({ reason, detail });
  };
  const text = p.render();
  for (const channel of CHANNEL_ORDER.filter((c) => p.channels.includes(c))) {
    if (!(await contactAddress(db, p.orgId, p.contactId, channel))) {
      note("contact_unreachable", `There is no ${channel === "email" ? "email address" : "phone number"} on file for this customer, so a ${REMINDER_CHANNEL_LABELS[channel].toLowerCase()} reminder cannot go to them.`);
      continue;
    }
    await db.query("savepoint invoice_reminder_channel");
    try {
      const conversationId = await conversationFor(db, p.orgId, p.contactId, channel, text.subject);
      const send = { orgId: p.orgId, conversationId, scope: "billing" as const, purpose: "service" as const, actor: { kind: "system" as const, userId: p.authorizerId }, body: text.body, now: p.now, businessHoursOnly: false };
      const decision = await evaluateSend(db, send);
      // "Not yet" (quiet hours) is fine: the message is queued for the next window. Anything else is final for this channel.
      const waiting = !decision.allow && Boolean(decision.retryAt) && !decision.permanent;
      if (!decision.allow && !waiting) {
        await db.query("rollback to savepoint invoice_reminder_channel");
        await db.query("release savepoint invoice_reminder_channel");
        note(decision.reason, decision.detail);
        continue;
      }
      const queued = await queueOutbound(db, { ...send, dedupeKey: p.dedupeKey });
      if (queued.status !== "queued") {
        await db.query("rollback to savepoint invoice_reminder_channel");
        await db.query("release savepoint invoice_reminder_channel");
        note(queued.reason ?? "blocked", queued.detail ?? "The message could not be queued.");
        continue;
      }
      await db.query("release savepoint invoice_reminder_channel");
      return { status: "queued", reason: decision.allow ? null : decision.reason, detail: null, messageId: queued.messageId, channel };
    } catch (e) {
      await db.query("rollback to savepoint invoice_reminder_channel");
      await db.query("release savepoint invoice_reminder_channel");
      throw e;
    }
  }
  const why = refusals[0] ?? { reason: "no_channel_allowed", detail: "No channel is allowed for reminders." };
  return { status: "blocked", reason: why.reason, detail: why.detail };
}

async function notifyAuthorizationNeeded(db: Queryable, orgId: string, problem: AuthorizationProblem, now: Date): Promise<void> {
  await notifyOrgRoles(db, orgId, ["owner"], {
    kind: "payment_review_needed", severity: "warning", title: "Invoice reminders are on hold",
    body: `${AUTHORIZATION_PROBLEM_TEXT[problem]} No reminder goes to your customers until you authorize them again.`, link: "/invoices/settings", dedupeKey: `invoice-reminders-auth:${orgId}:${day(now)}`,
  });
}

/** Everything about one claimed reminder, decided and done in one transaction. */
async function processReminder(c: Claimed, now: Date): Promise<Outcome> {
  return withSystem(async (db): Promise<Outcome> => {
    // The invoice is locked first, like every other writer of its money, then the reminder.
    const inv = (await db.query<InvoiceRowFacts & { currency: CurrencyCode; total_minor: string; number: string | null; bill_from: { name?: string } }>(
      `select id, status, payment_status, written_off_at, balance_minor::text as balance_minor, to_char(due_on, 'YYYY-MM-DD') as due_on, contact_id, currency, total_minor::text as total_minor, number, bill_from
       from customer_invoices where id = $1 and org_id = $2 for update`,
      [c.invoice_id, c.org_id],
    )).rows[0];
    const row = (await db.query<{ status: ReminderRowStatus; message_id: string | null }>("select status, message_id from customer_invoice_reminders where id = $1 and org_id = $2 for update", [c.id, c.org_id])).rows[0];
    // Someone else (a payment, a void, another worker) already settled it.
    if (!inv || !row || row.status !== "queued" || row.message_id) return "gone";

    const finish = async (status: "scheduled" | "skipped" | "cancelled" | "blocked" | "queued", reason: string | null, messageId: string | null = null) => {
      await db.query("update customer_invoice_reminders set status = $2, reason = $3, message_id = $4 where id = $1", [c.id, status, reason, messageId]);
    };
    const settings = await readSettings(db, c.org_id);
    const enabledFeature = (await db.query("select 1 from org_features where org_id = $1 and feature = 'invoices' and enabled", [c.org_id])).rows.length > 0;
    const hasCustomer = await customerExists(db, c.org_id, inv.contact_id);
    // A person's own hold on automatic messages to this customer (set during a dispute, say) covers a reminder as much as any other automatic message.
    const customerHeld = hasCustomer && Boolean((await db.query<{ held: boolean }>("select retention_paused as held from contacts where id = $1 and org_id = $2", [inv.contact_id, c.org_id])).rows[0]?.held);
    const planned = new Set(normalizeSetup(setupOf(settings)).offsetsDays.slice(0, settings.reminderMax).map(stepKeyFor));
    const alreadyQueued = Number((await db.query<{ n: string }>("select count(*)::text as n from customer_invoice_reminders where invoice_id = $1 and org_id = $2 and status = 'queued' and id <> $3", [c.invoice_id, c.org_id, c.id])).rows[0].n);
    const authorization = await currentAuthorizationProblem(db, c.org_id, settings, now);
    let runnable = true;
    for (const scope of ["messaging", "outbound"] as const) if (!(await checkOrgAutomation(db, c.org_id, scope)).allowed) runnable = false;
    const decision = decideReminder({
      now, dueAt: new Date(c.due_at), invoice: factsOf(inv, hasCustomer), invoicingEnabled: enabledFeature, remindersEnabled: settings.remindersEnabled, stepStillPlanned: planned.has(c.step_key),
      customerHeld, authorization, workspaceRunnable: runnable, alreadyQueued, max: settings.reminderMax,
    });

    if (decision.action === "wait") {
      await finish("scheduled", null);
      if (decision.reason === "authorization_needed" && authorization) await notifyAuthorizationNeeded(db, c.org_id, authorization, now);
      return "waiting";
    }
    if (decision.action === "cancel" || decision.action === "skip") {
      await finish(decision.action === "cancel" ? "cancelled" : "skipped", decision.reason);
      await addInvoiceEvent(db, c.org_id, c.invoice_id, "reminder_not_sent", { id: null, kind: "system" }, { step: c.step_key, reason: decision.reason });
      return decision.action === "cancel" ? "cancelled" : "skipped";
    }

    const phase = phaseOfStepKey(c.step_key);
    const contact = (await db.query<{ first: string | null }>("select coalesce(nullif(first_name, ''), nullif(split_part(display_name, ' ', 1), '')) as first from contacts where id = $1 and org_id = $2", [inv.contact_id, c.org_id])).rows[0];
    if (!phase || !inv.contact_id || !inv.due_on || !inv.number) {
      await finish("cancelled", "invoice_changed");
      return "cancelled";
    }
    const render = () => {
      const r = renderReminder({ phase, firstName: contact?.first ?? null, business: inv.bill_from?.name ?? "", number: inv.number as string, totalMinor: toMinor(inv.total_minor), currency: inv.currency, dueOn: inv.due_on as string });
      const problem = reminderTextProblem(r.body);
      if (problem) throw new AppError("internal", problem);
      return r;
    };
    // One message per reminder: the key names the invoice and the day. A reminder that was withdrawn and later reopened asks again under the next number, because the key of the
    // withdrawn message is spent.
    const base = `invoice-reminder:${c.invoice_id}:${c.step_key}`;
    const spent = Number((await db.query<{ n: string }>("select count(*)::text as n from conversation_messages where org_id = $1 and (dedupe_key = $2 or dedupe_key like $2 || ':%')", [c.org_id, base])).rows[0].n);
    const result = await queueOnChannels(db, {
      orgId: c.org_id, contactId: inv.contact_id, invoiceId: c.invoice_id, dedupeKey: spent ? `${base}:${spent}` : base, channels: settings.reminderChannels, authorizerId: settings.remindersAuthorizedBy, render, now,
    });
    if (result.status === "blocked") {
      await finish("blocked", result.reason);
      await addInvoiceEvent(db, c.org_id, c.invoice_id, "reminder_blocked", { id: null, kind: "system" }, { step: c.step_key, reason: result.reason, why: reminderReasonText(result.reason).slice(0, 200) });
      return "blocked";
    }
    await finish("queued", result.reason, result.messageId ?? null);
    await addInvoiceEvent(db, c.org_id, c.invoice_id, "reminder_queued", { id: null, kind: "system" }, { step: c.step_key, channel: result.channel ?? null, waiting: result.reason });
    return "queued";
  });
}

/**
 * The scheduled job. Brings stuck reminders back, plans any invoice that has none, then takes the reminders that have come due and decides each one. It sends nothing itself:
 * a reminder that may go is queued through the send chain, and the dispatcher sends it. Runs only when the scheduler does, and in a staged start only when SCHEDULER_JOBS_ONLY
 * names it (invoiceReminders). A reminder that cannot be processed because of an unexpected fault goes back to be tried again on the next run.
 */
export async function runInvoiceReminders(opts: { now?: Date; limit?: number } = {}): Promise<RemindersReport> {
  const now = opts.now ?? new Date();
  const out: RemindersReport = { reconciled: 0, scheduled: 0, queued: 0, blocked: 0, waiting: 0, skipped: 0, cancelled: 0 };
  out.reconciled = await reconcile(now);
  out.scheduled = await backfill(now);
  for (const c of await claim(now, Math.min(100, opts.limit ?? CLAIM_LIMIT))) {
    try {
      const o = await processReminder(c, now);
      if (o !== "gone") out[o] += 1;
    } catch (e) {
      // Nothing it did is kept. It is put back, and tried again after the claim goes stale; the failure is logged without any customer detail.
      console.error("[iacquire] an invoice reminder could not be processed", { error: sanitizeErrorText(e, 120) });
    }
  }
  return out;
}

/** The number the scheduler's heartbeat records: what the run changed. */
export async function runInvoiceRemindersJob(): Promise<number> {
  const r = await runInvoiceReminders();
  return r.reconciled + r.scheduled + r.queued + r.blocked + r.skipped + r.cancelled;
}

