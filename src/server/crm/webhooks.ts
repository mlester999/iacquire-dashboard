import "server-only";
import crypto from "node:crypto";
import { z } from "zod";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyOrgRoles } from "@/server/notifications";
import { assertCan, auditActor, crmRead, crmWrite, type CrmActor } from "@/server/crm/actor";
import { decryptSecret, encryptSecret, randomToken } from "@/server/security/crypto";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { assertPublicHttps } from "@/server/calendars/adapters/http";
import { CalendarProviderError } from "@/server/calendars/adapters/types";
import { memberAccessColumns, permissionCheckFrom } from "@/server/crm/member-access";
import { UnsafeAddressError, pinnedHttps } from "@/server/security/pinned-https";
import { DELEGABLE_PERMISSION_INFO, isDelegablePermission, type Permission } from "@/lib/permissions";

// Signed outbound webhooks (CRM Settings → API & Webhooks, docs/crm-api.md).
//
//  * A subscription is an https address on the public internet, a set of event types from WEBHOOK_EVENTS and a signing secret that is
//    generated here, shown once, and stored encrypted (the application role cannot read the ciphertext column).
//  * The event dispatcher calls enqueueWebhookDeliveries(db, event) in the event's own transaction: one delivery row per matching active
//    subscription, unique per (subscription, event), so a redispatched event never queues twice.
//  * deliverDueWebhooks() runs from the scheduler tick. Like dispatchMessage it works in three phases: claim due rows in one transaction
//    (skip locked, attempt counted, lease on claimed_at) and build the envelope from the records as they are now; POST outside any
//    transaction with a timeout; record the result in a second transaction.
//  * A delivery is retried with growing delays while the receiver answers with an error or can't be connected to, up to MAX_ATTEMPTS, then
//    it is dead. When the outcome is unknown (no answer before the timeout, or the worker stopped mid-send) it is NOT retried automatically:
//    the receiver may have it. The delivery log offers Redeliver; every attempt carries the same event id so receivers can de-duplicate.
//  * After AUTO_DISABLE_AFTER failed attempts in a row a subscription is switched off and the owner and managers are told.
//  * Deliveries held back (a paused or switched-off subscription, a paused or suspended workspace) expire after HOLD_DAYS, so resuming a
//    webhook never floods the receiver with stale events; Redeliver still sends one on request.

export const WEBHOOK_API_VERSION = "2026-10-01";
export const SIGNATURE_HEADER = "iAcquire-Signature";
export const EVENT_ID_HEADER = "iAcquire-Event-Id";
export const MAX_ATTEMPTS = 8;
export const AUTO_DISABLE_AFTER = 25;
export const DELIVERY_TIMEOUT_MS = 10_000;
export const MAX_SUBSCRIPTIONS = 20;
/** A delivery still marked as sending after this long was interrupted. */
const LEASE_MINUTES = 5;
const BATCH = 10;
/** Kept for the delivery log, then pruned. */
export const HISTORY_DAYS = 30;
/** A delivery not sent within this many days of its event (because it was held back) is closed. The retry schedule ends well before. */
export const HOLD_DAYS = 3;

export const PING_EVENT_TYPE = "webhook.ping";
export const WORKFLOW_EVENT_TYPE = "workflow.webhook";

export interface WebhookEventInfo {
  type: string;
  group: "Contacts" | "Companies" | "Deals" | "Appointments" | "Tasks" | "Notes" | "Campaigns" | "Reviews" | "Calls";
  label: string;
}

/** The documented catalog: only event types the CRM emits today. Each payload carries the record as it is when the delivery is sent. */
export const WEBHOOK_EVENTS: readonly WebhookEventInfo[] = [
  { type: "contact.created", group: "Contacts", label: "Contact created" },
  { type: "contact.updated", group: "Contacts", label: "Contact details changed" },
  { type: "contact.assigned", group: "Contacts", label: "Contact assigned to someone" },
  { type: "contact.tag_added", group: "Contacts", label: "Tag added to a contact" },
  { type: "contact.tag_removed", group: "Contacts", label: "Tag removed from a contact" },
  { type: "contact.consent_changed", group: "Contacts", label: "Consent changed" },
  { type: "contact.merged", group: "Contacts", label: "Contacts merged" },
  { type: "contact.erased", group: "Contacts", label: "Contact erased" },
  // A processed submission to a native form or survey: data.object is { type: "form", id }, the context carries the submission's answers.
  { type: "form.submitted", group: "Contacts", label: "Form or survey submitted" },
  { type: "company.created", group: "Companies", label: "Company created" },
  { type: "company.updated", group: "Companies", label: "Company details changed" },
  { type: "opportunity.created", group: "Deals", label: "Deal created" },
  { type: "opportunity.updated", group: "Deals", label: "Deal details changed" },
  { type: "opportunity.stage_changed", group: "Deals", label: "Deal moved to another stage" },
  { type: "opportunity.won", group: "Deals", label: "Deal won" },
  { type: "opportunity.lost", group: "Deals", label: "Deal lost" },
  { type: "opportunity.reopened", group: "Deals", label: "Deal reopened" },
  { type: "opportunity.archived", group: "Deals", label: "Deal archived" },
  { type: "appointment.booked", group: "Appointments", label: "Appointment booked" },
  { type: "appointment.rescheduled", group: "Appointments", label: "Appointment rescheduled" },
  { type: "appointment.cancelled", group: "Appointments", label: "Appointment cancelled" },
  { type: "appointment.confirmed", group: "Appointments", label: "Appointment confirmed" },
  { type: "appointment.showed", group: "Appointments", label: "Customer showed up" },
  { type: "appointment.no_show", group: "Appointments", label: "Customer didn't show up" },
  { type: "task.created", group: "Tasks", label: "Task created" },
  { type: "task.completed", group: "Tasks", label: "Task completed" },
  { type: "note.added", group: "Notes", label: "Note added to a record" },
  { type: "campaign.sent", group: "Campaigns", label: "Campaign finished sending" },
  { type: "review.requested", group: "Reviews", label: "Review requested" },
  // Private feedback from a review request page: the rating, never the comment text.
  { type: "feedback.received", group: "Reviews", label: "Private feedback received" },
  { type: "call.completed", group: "Calls", label: "Call ended" },
];
const CATALOG = new Set(WEBHOOK_EVENTS.map((e) => e.type));
export const isWebhookEventType = (t: string) => CATALOG.has(t);

/**
 * What a delivery of each group exposes, as the permissions needed to see it in the CRM. Subscribing needs them, and so does every later
 * delivery: an event isn't queued for a subscription whose creator no longer holds them (a withdrawn permission, or they left).
 * A note's delivery carries the contact or deal it was added to.
 */
const GROUP_PERMISSIONS: Record<WebhookEventInfo["group"], Permission[]> = {
  Contacts: ["contacts.view"],
  Companies: ["companies.view"],
  Deals: ["sales.view"],
  Appointments: ["appointments.view"],
  Tasks: ["crm.view"],
  Notes: ["contacts.view", "sales.view"],
  Campaigns: ["campaigns.manage"],
  // Review requests and feedback are about one contact (the snapshot carries its id).
  Reviews: ["contacts.view"],
  Calls: ["calls.view", "contacts.view"],
};
const EVENT_GROUP = new Map(WEBHOOK_EVENTS.map((e) => [e.type, e.group]));
export const webhookEventPermissions = (type: string): Permission[] => GROUP_PERMISSIONS[EVENT_GROUP.get(type) ?? "Contacts"] ?? ["contacts.view"];
const permissionLabel = (p: Permission) => (isDelegablePermission(p) ? DELEGABLE_PERMISSION_INFO[p].label : p === "crm.view" ? "See the CRM" : p);

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

/** The signature header value: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>" keyed with the subscription's secret>. */
export function signWebhookPayload(secret: string, body: string, timestamp: number): string {
  const mac = crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

/**
 * How a receiver checks a delivery (the same code is in docs/crm-api.md): recompute the HMAC over the exact raw body, compare in constant
 * time, and refuse timestamps outside the tolerance so a captured request can't be replayed later.
 */
export function verifyWebhookSignature(input: { secret: string; body: string; header: string | null | undefined; toleranceSeconds?: number; now?: number }): boolean {
  const parts = new Map<string, string[]>();
  for (const piece of (input.header ?? "").split(",")) {
    const i = piece.indexOf("=");
    if (i <= 0) continue;
    const k = piece.slice(0, i).trim();
    parts.set(k, [...(parts.get(k) ?? []), piece.slice(i + 1).trim()]);
  }
  const t = Number(parts.get("t")?.[0]);
  if (!Number.isInteger(t)) return false;
  const now = Math.floor((input.now ?? Date.now()) / 1000);
  if (Math.abs(now - t) > (input.toleranceSeconds ?? 300)) return false;
  const expected = Buffer.from(crypto.createHmac("sha256", input.secret).update(`${t}.${input.body}`).digest("hex"));
  return (parts.get("v1") ?? []).some((sig) => {
    const got = Buffer.from(sig);
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  });
}

/** Seconds to wait after failed attempt n (1-based): 1 min, 4 min, 16 min, about 1 h, 4 h, 17 h, then daily. */
export function retryDelaySeconds(attempt: number): number {
  return Math.min(60 * 4 ** Math.max(0, attempt - 1), 86_400);
}

function newSecret() {
  const secret = `whsec_${randomToken(32)}`;
  return { secret, hint: `…${secret.slice(-4)}`, ciphertext: encryptSecret(secret) };
}

// ---------------------------------------------------------------------------
// Address checks (the SSRF guard)
// ---------------------------------------------------------------------------

/**
 * Accepts only https to a public host on port 443. The host name is resolved and every address must be public (no loopback, private,
 * link-local, metadata or carrier NAT ranges). Checked when the address is saved and again before every delivery, where the connection
 * itself is also pinned to addresses that pass this check (src/server/security/pinned-https.ts).
 */
export async function checkWebhookUrl(raw: string): Promise<string> {
  const bad = (msg: string) => new AppError("invalid_input", msg);
  let u: URL;
  try {
    u = new URL(String(raw ?? "").trim());
  } catch {
    throw bad("Enter the full address, starting with https://.");
  }
  if (u.protocol !== "https:") throw bad("Webhook addresses must start with https://.");
  if (u.username || u.password) throw bad("Remove the user name and password from the address. Use the signing secret to authenticate deliveries.");
  if (u.hash) throw bad("Remove the part of the address after #.");
  if (u.port && u.port !== "443") throw bad("Use the standard HTTPS port (443).");
  const url = u.toString();
  if (url.length > 500) throw bad("That address is too long (500 characters at most).");
  try {
    await assertPublicHttps(u);
  } catch (err) {
    if (err instanceof CalendarProviderError) {
      throw bad(err.code === "dns" ? "That server name couldn't be found. Check the address." : "That address is on a private, local or internal network. Webhooks can only go to public internet addresses.");
    }
    throw err;
  }
  return url;
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

export interface WebhookSubscriptionView {
  id: string;
  name: string;
  url: string;
  eventTypes: string[];
  secretHint: string;
  active: boolean;
  consecutiveFailures: number;
  disabledReason: string | null;
  createdAt: string;
  updatedAt: string;
  stats: { delivered24h: number; failed24h: number; queued: number; lastDeliveredAt: string | null };
}

const subscriptionInput = z.object({
  name: z.string().transform((s) => s.replace(/\s+/g, " ").trim()).pipe(z.string().min(1, "Name the webhook.").max(80, "Use a name of up to 80 characters.")),
  url: z.string().max(600, "That address is too long (500 characters at most)."),
  eventTypes: z.array(z.string()).min(1, "Choose at least one event.").max(50, "Choose at most 50 events."),
});
export type WebhookSubscriptionInput = z.input<typeof subscriptionInput>;

function checkEvents(types: string[]): string[] {
  const unique = [...new Set(types)];
  const unknown = unique.find((t) => !CATALOG.has(t));
  if (unknown) throw new AppError("invalid_input", `"${unknown.slice(0, 60)}" isn't an event iAcquire sends.`);
  return WEBHOOK_EVENTS.map((e) => e.type).filter((t) => unique.includes(t));
}

function assertMember(actor: CrmActor, what: string) {
  if (actor.kind !== "member") throw new AppError("forbidden", `Only people in this workspace can ${what}.`);
}

/** A subscription can't send out anything its creator couldn't see in the CRM. */
function assertMaySubscribe(actor: CrmActor, events: string[]) {
  const missing = [...new Set(events.flatMap((t) => webhookEventPermissions(t)).filter((p) => !actor.can(p)))];
  if (!missing.length) return;
  const groups = [...new Set(WEBHOOK_EVENTS.filter((e) => events.includes(e.type) && webhookEventPermissions(e.type).some((p) => missing.includes(p))).map((e) => e.group.toLowerCase()))];
  throw new AppError("forbidden", `A webhook can only send events about records you can see yourself. You can't subscribe to ${groups.join(", ")} events without “${missing.map(permissionLabel).join("”, “")}”.`);
}

const auditHost = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
};

/** The workspace's subscriptions with a 24-hour delivery summary. Members read under row-level security; the secret column isn't granted. */
export async function listWebhookSubscriptions(actor: CrmActor): Promise<WebhookSubscriptionView[]> {
  assertCan(actor, "crm.api.manage");
  return crmRead(actor, async (db) => {
    const { rows } = await db.query<{
      id: string; name: string; url: string; event_types: string[]; secret_hint: string; active: boolean; consecutive_failures: number; disabled_reason: string | null;
      created_at: Date; updated_at: Date; delivered24h: string; failed24h: string; queued: string; last_delivered_at: Date | null;
    }>(
      `select s.id, s.name, s.url, s.event_types, s.secret_hint, s.active, s.consecutive_failures, s.disabled_reason, s.created_at, s.updated_at,
              (select count(*) from crm_webhook_deliveries d where d.subscription_id = s.id and d.status = 'delivered' and d.delivered_at > now() - interval '24 hours')::text as delivered24h,
              (select count(*) from crm_webhook_deliveries d where d.subscription_id = s.id and d.status in ('failed', 'dead') and d.created_at > now() - interval '24 hours')::text as failed24h,
              (select count(*) from crm_webhook_deliveries d where d.subscription_id = s.id and d.status in ('pending', 'delivering', 'failed'))::text as queued,
              (select max(d.delivered_at) from crm_webhook_deliveries d where d.subscription_id = s.id) as last_delivered_at
       from crm_webhook_subscriptions s where s.org_id = $1 order by s.created_at`,
      [actor.orgId],
    );
    return rows.map((r) => ({
      id: r.id, name: r.name, url: r.url, eventTypes: r.event_types, secretHint: r.secret_hint, active: r.active, consecutiveFailures: r.consecutive_failures,
      disabledReason: r.disabled_reason, createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
      stats: { delivered24h: Number(r.delivered24h), failed24h: Number(r.failed24h), queued: Number(r.queued), lastDeliveredAt: r.last_delivered_at ? new Date(r.last_delivered_at).toISOString() : null },
    }));
  });
}

/** Creates a subscription. The signing secret is returned once; afterwards only its last characters are shown. */
export async function createWebhookSubscription(actor: CrmActor, input: WebhookSubscriptionInput): Promise<{ id: string; secret: string; secretHint: string }> {
  assertCan(actor, "crm.api.manage");
  assertMember(actor, "add webhooks");
  const parsed = subscriptionInput.parse(input);
  const url = await checkWebhookUrl(parsed.url);
  const events = checkEvents(parsed.eventTypes);
  assertMaySubscribe(actor, events);
  const s = newSecret();
  return crmWrite(actor, async (db) => {
    const count = await db.query<{ n: string }>("select count(*)::text as n from crm_webhook_subscriptions where org_id = $1", [actor.orgId]);
    if (Number(count.rows[0].n) >= MAX_SUBSCRIPTIONS) throw new AppError("conflict", `A workspace can have up to ${MAX_SUBSCRIPTIONS} webhooks. Delete one you no longer use first.`);
    const { rows } = await db.query<{ id: string }>(
      "insert into crm_webhook_subscriptions (org_id, name, url, event_types, secret_ciphertext, secret_hint, created_by) values ($1, $2, $3, $4, $5, $6, $7) returning id",
      [actor.orgId, parsed.name, url, events, s.ciphertext, s.hint, actor.userId],
    );
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.webhook_created", targetType: "crm_webhook_subscription", targetId: rows[0].id, result: "success", metadata: { host: auditHost(url), events } }, db);
    return { id: rows[0].id, secret: s.secret, secretHint: s.hint };
  });
}

export async function updateWebhookSubscription(actor: CrmActor, id: string, input: WebhookSubscriptionInput): Promise<void> {
  assertCan(actor, "crm.api.manage");
  assertMember(actor, "change webhooks");
  const parsed = subscriptionInput.parse(input);
  const url = await checkWebhookUrl(parsed.url);
  const events = checkEvents(parsed.eventTypes);
  assertMaySubscribe(actor, events);
  await crmWrite(actor, async (db) => {
    const { rows } = await db.query<{ url: string }>("select url from crm_webhook_subscriptions where id = $1 and org_id = $2 for update", [id, actor.orgId]);
    if (!rows[0]) throw new AppError("not_found", "Webhook not found.");
    await db.query("update crm_webhook_subscriptions set name = $3, url = $4, event_types = $5 where id = $1 and org_id = $2", [id, actor.orgId, parsed.name, url, events]);
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.webhook_updated", targetType: "crm_webhook_subscription", targetId: id, result: "success", metadata: { host: auditHost(url), urlChanged: rows[0].url !== url, events } }, db);
  });
}

/** Pauses or resumes. Resuming clears the failure count; deliveries already scheduled continue, events from the pause aren't queued. */
export async function setWebhookSubscriptionActive(actor: CrmActor, id: string, active: boolean): Promise<void> {
  assertCan(actor, "crm.api.manage");
  assertMember(actor, "pause or resume webhooks");
  await crmWrite(actor, async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `update crm_webhook_subscriptions set active = $3, consecutive_failures = case when $3 then 0 else consecutive_failures end,
         disabled_reason = case when $3 then null else 'Paused by ' || $4 end where id = $1 and org_id = $2 returning id`,
      [id, actor.orgId, active, actor.label.slice(0, 200)],
    );
    if (!rows[0]) throw new AppError("not_found", "Webhook not found.");
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: active ? "crm.webhook_resumed" : "crm.webhook_paused", targetType: "crm_webhook_subscription", targetId: id, result: "success" }, db);
  });
}

/** Pauses every outbound webhook of a workspace that is being closed (offboarding). The subscriptions and their logs stay for the export; nothing more is sent to those addresses. */
export async function pauseWorkspaceWebhooks(orgId: string, actorUserId: string): Promise<{ paused: number; failed: boolean }> {
  try {
    return await withSystem(async (db) => {
      const { rows } = await db.query<{ id: string }>("update crm_webhook_subscriptions set active = false, disabled_reason = 'The workspace was closed.' where org_id = $1 and active returning id", [orgId]);
      for (const r of rows) {
        await recordAudit({ orgId, actorUserId, actorKind: "agency", action: "crm.webhook_paused", targetType: "crm_webhook_subscription", targetId: r.id, result: "success", metadata: { why: "workspace_closed" } }, db);
      }
      return { paused: rows.length, failed: false };
    });
  } catch {
    return { paused: 0, failed: true };
  }
}

/** Deletes a subscription and its delivery log. Deliveries waiting to be sent are dropped. */
export async function deleteWebhookSubscription(actor: CrmActor, id: string): Promise<void> {
  assertCan(actor, "crm.api.manage");
  assertMember(actor, "delete webhooks");
  await crmWrite(actor, async (db) => {
    const { rows } = await db.query<{ url: string; name: string }>("delete from crm_webhook_subscriptions where id = $1 and org_id = $2 returning url, name", [id, actor.orgId]);
    if (!rows[0]) throw new AppError("not_found", "Webhook not found.");
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.webhook_deleted", targetType: "crm_webhook_subscription", targetId: id, result: "success", metadata: { host: auditHost(rows[0].url), name: rows[0].name } }, db);
  });
}

/** Replaces the signing secret. The old one stops working immediately; the new one is returned once. */
export async function rotateWebhookSecret(actor: CrmActor, id: string): Promise<{ secret: string; secretHint: string }> {
  assertCan(actor, "crm.api.manage");
  assertMember(actor, "change webhook secrets");
  const s = newSecret();
  return crmWrite(actor, async (db) => {
    const { rows } = await db.query<{ id: string }>("update crm_webhook_subscriptions set secret_ciphertext = $3, secret_hint = $4 where id = $1 and org_id = $2 returning id", [id, actor.orgId, s.ciphertext, s.hint]);
    if (!rows[0]) throw new AppError("not_found", "Webhook not found.");
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.webhook_secret_rotated", targetType: "crm_webhook_subscription", targetId: id, result: "success" }, db);
    return { secret: s.secret, secretHint: s.hint };
  });
}

// ---------------------------------------------------------------------------
// Delivery log
// ---------------------------------------------------------------------------

export type DeliveryStatus = "pending" | "delivering" | "delivered" | "failed" | "dead";

export interface WebhookDeliveryView {
  id: string;
  eventId: string;
  eventType: string;
  status: DeliveryStatus;
  attempts: number;
  responseStatus: number | null;
  lastError: string | null;
  createdAt: string;
  deliveredAt: string | null;
  nextAttemptAt: string | null;
}

/** The most recent deliveries for one subscription. Reads the event outbox, which only trusted code can, after the permission check. */
export async function listWebhookDeliveries(actor: CrmActor, subscriptionId: string, opts: { filter?: "all" | "failed" | "delivered"; limit?: number; cursor?: string | null } = {}): Promise<{ items: WebhookDeliveryView[]; nextCursor: string | null }> {
  assertCan(actor, "crm.api.manage");
  const limit = Math.min(100, Math.max(1, Math.trunc(opts.limit ?? 25)));
  const filter = opts.filter ?? "all";
  // The cursor is the last row's exact created_at (microseconds, as the database prints it) and id, so rows sharing a millisecond aren't skipped.
  let after: { at: string; id: string } | null = null;
  if (opts.cursor) {
    const [at, id] = opts.cursor.split("|");
    if (!at || !id || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)?$/.test(at) || !/^[0-9a-f-]{36}$/i.test(id)) throw new AppError("invalid_input", "That page of the delivery log doesn't exist.");
    after = { at, id };
  }
  return withSystem(async (db) => {
    const sub = await db.query("select 1 from crm_webhook_subscriptions where id = $1 and org_id = $2", [subscriptionId, actor.orgId]);
    if (!sub.rows.length) throw new AppError("not_found", "Webhook not found.");
    const { rows } = await db.query<{ id: string; event_id: string; type: string; status: DeliveryStatus; attempts: number; response_status: number | null; last_error: string | null; created_at: Date; created_key: string; delivered_at: Date | null; next_attempt_at: Date }>(
      `select d.id, d.event_id::text as event_id, e.type, d.status, d.attempts, d.response_status, d.last_error, d.created_at, d.created_at::text as created_key, d.delivered_at, d.next_attempt_at
       from crm_webhook_deliveries d join crm_events e on e.id = d.event_id
       where d.org_id = $1 and d.subscription_id = $2
         and ($3 = 'all' or ($3 = 'failed' and d.status in ('failed', 'dead')) or ($3 = 'delivered' and d.status = 'delivered'))
         and ($4::timestamptz is null or (d.created_at, d.id) < ($4::timestamptz, $5::uuid))
       order by d.created_at desc, d.id desc limit $6`,
      [actor.orgId, subscriptionId, filter, after?.at ?? null, after?.id ?? null, limit + 1],
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      nextCursor: rows.length > limit && last ? `${last.created_key}|${last.id}` : null,
      items: page.map((r) => ({
        id: r.id, eventId: `evt_${r.event_id}`, eventType: r.type, status: r.status, attempts: r.attempts, responseStatus: r.response_status, lastError: r.last_error,
        createdAt: new Date(r.created_at).toISOString(), deliveredAt: r.delivered_at ? new Date(r.delivered_at).toISOString() : null,
        nextAttemptAt: r.status === "pending" || r.status === "failed" ? new Date(r.next_attempt_at).toISOString() : null,
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// Queueing (called by the event dispatcher and the workflow engine, inside their transactions)
// ---------------------------------------------------------------------------

/** The fields of a crm_events row a delivery needs. CrmEventRow from the dispatcher has these and more. */
export interface WebhookSourceEvent {
  id: number;
  orgId: string;
  type: string;
}

/**
 * Queues one delivery per active subscription of the event's workspace that asked for this event type. Safe to call twice. A
 * subscription whose creator can no longer see what the event carries (see GROUP_PERMISSIONS) gets nothing, and owners and managers are
 * told once.
 */
export async function enqueueWebhookDeliveries(db: Queryable, event: WebhookSourceEvent): Promise<number> {
  if (!CATALOG.has(event.type)) return 0;
  const subs = await db.query<{ id: string; name: string; member_role: string | null; member_overrides: Record<string, unknown> | null }>(
    `select s.id, s.name, ${memberAccessColumns("s.org_id", "s.created_by")} from crm_webhook_subscriptions s where s.org_id = $1 and s.active and $2 = any(s.event_types)`,
    [event.orgId, event.type],
  );
  if (!subs.rows.length) return 0;
  const needs = webhookEventPermissions(event.type);
  const allowed: string[] = [];
  for (const sub of subs.rows) {
    const creator = permissionCheckFrom(sub.member_role, sub.member_overrides);
    if (creator && needs.every((p) => creator(p))) {
      allowed.push(sub.id);
      continue;
    }
    await notifyOrgRoles(db, event.orgId, ["owner", "admin"], {
      kind: "crm_webhook_failing",
      severity: "warning",
      title: `Webhook “${sub.name.slice(0, 60)}” isn't sending some events`,
      body: `The person who set it up ${creator ? "can no longer see" : "is no longer in the workspace, so it can't send"} ${EVENT_GROUP.get(event.type)?.toLowerCase() ?? "these"} events. Someone with that access can recreate it in CRM Settings, API & Webhooks.`,
      link: "/crm/settings/api",
      dedupeKey: `crm-webhook-withheld:${sub.id}:${EVENT_GROUP.get(event.type) ?? event.type}`,
    });
  }
  if (!allowed.length) return 0;
  const { rows } = await db.query<{ id: string }>(
    `insert into crm_webhook_deliveries (org_id, subscription_id, event_id)
     select $1, s, $2 from unnest($3::uuid[]) as s
     on conflict (subscription_id, event_id) do nothing returning id`,
    [event.orgId, event.id, allowed],
  );
  return rows.length;
}

export interface WorkflowWebhookResult {
  status: "queued" | "duplicate" | "blocked";
  deliveryId: string | null;
  detail: string;
}

const MAX_WORKFLOW_PAYLOAD = 12_000;

/**
 * The workflow engine's webhook step: queues `payload` for one subscription, delivered and retried like any event, with type
 * "workflow.webhook". The idempotency key makes a retried step queue nothing new. A paused or deleted subscription blocks the step.
 */
export async function enqueueWorkflowWebhook(db: Queryable, input: { orgId: string; subscriptionId: string; payload: Record<string, unknown>; idempotencyKey: string }): Promise<WorkflowWebhookResult> {
  if (!input.idempotencyKey || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200) throw new AppError("invalid_input", "A webhook step needs an idempotency key of 8 to 200 characters.");
  if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) throw new AppError("invalid_input", "A webhook step's payload must be an object.");
  const json = JSON.stringify(input.payload);
  if (json.length > MAX_WORKFLOW_PAYLOAD) throw new AppError("invalid_input", "This webhook payload is too large (12 KB at most).");
  const sub = await db.query<{ active: boolean; name: string }>("select active, name from crm_webhook_subscriptions where id = $1 and org_id = $2", [input.subscriptionId, input.orgId]);
  if (!sub.rows[0]) return { status: "blocked", deliveryId: null, detail: "This webhook no longer exists." };
  const dedupeKey = `${WORKFLOW_EVENT_TYPE}:${input.subscriptionId}:${input.idempotencyKey}`.slice(0, 300);
  const existing = await db.query<{ id: string }>(
    `select d.id from crm_events e join crm_webhook_deliveries d on d.event_id = e.id and d.subscription_id = $3
     where e.org_id = $1 and e.dedupe_key = $2`,
    [input.orgId, dedupeKey, input.subscriptionId],
  );
  if (existing.rows[0]) return { status: "duplicate", deliveryId: existing.rows[0].id, detail: "Already queued for this step." };
  if (!sub.rows[0].active) return { status: "blocked", deliveryId: null, detail: `The webhook “${sub.rows[0].name}” is paused.` };
  // The payload rides on an outbox row that is already marked dispatched, so the dispatcher never hands it to anything else.
  const ev = await db.query<{ id: string }>(
    `insert into crm_events (org_id, type, entity_type, entity_id, payload, dedupe_key, actor_kind, depth, dispatched_at)
     values ($1, $2, 'webhook_subscription', $3, $4, $5, 'workflow', 0, now())
     on conflict (org_id, dedupe_key) do nothing returning id`,
    [input.orgId, WORKFLOW_EVENT_TYPE, input.subscriptionId, json, dedupeKey],
  );
  const eventId = ev.rows[0]?.id ?? (await db.query<{ id: string }>("select id from crm_events where org_id = $1 and dedupe_key = $2", [input.orgId, dedupeKey])).rows[0].id;
  const d = await db.query<{ id: string }>(
    `insert into crm_webhook_deliveries (org_id, subscription_id, event_id) values ($1, $2, $3)
     on conflict (subscription_id, event_id) do nothing returning id`,
    [input.orgId, input.subscriptionId, eventId],
  );
  if (!d.rows[0]) {
    const again = await db.query<{ id: string }>("select id from crm_webhook_deliveries where subscription_id = $1 and event_id = $2", [input.subscriptionId, eventId]);
    return { status: "duplicate", deliveryId: again.rows[0]?.id ?? null, detail: "Already queued for this step." };
  }
  return { status: "queued", deliveryId: d.rows[0].id, detail: "Queued for delivery." };
}

// ---------------------------------------------------------------------------
// Envelopes: the record as it is when the delivery is sent, never secrets
// ---------------------------------------------------------------------------

const SECRETISH = /(password|secret|token|api[_-]?key|authorization|cookie|credential|signature|hash)/i;

/** Event context (what changed, from which stage, …) minus anything that looks like a secret, with sizes capped. */
function cleanContext(input: unknown, depth = 0): unknown {
  if (input === null || typeof input === "number" || typeof input === "boolean") return input;
  if (typeof input === "string") return input.slice(0, 500);
  if (depth > 3) return null;
  if (Array.isArray(input)) return input.slice(0, 50).map((v) => cleanContext(v, depth + 1));
  if (typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>).slice(0, 50)) if (!SECRETISH.test(k)) out[k] = cleanContext(v, depth + 1);
    return out;
  }
  return null;
}

const isoOrNull = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

async function snapshot(db: Queryable, orgId: string, entityType: string, id: string | null, eventType: string): Promise<Record<string, unknown> | null> {
  if (!id) return null;
  const gone = { type: entityType, id, deleted: true };
  if (eventType === "contact.erased") return { type: "contact", id, erased: true };
  if (entityType === "contact") {
    const { rows } = await db.query<{
      id: string; display_name: string; first_name: string | null; last_name: string | null; email: string | null; phone: string | null; lead_status: string; lead_score: number | null;
      source: string; assigned_user_id: string | null; timezone: string | null; city: string | null; region: string | null; country: string | null; preferred_channel: string | null;
      created_at: Date; updated_at: Date; archived_at: Date | null; deleted_at: Date | null; tags: string[] | null;
    }>(
      `select c.id, c.display_name, c.first_name, c.last_name, c.email::text as email, c.phone, c.lead_status, c.lead_score, c.source, c.assigned_user_id, c.timezone, c.city, c.region,
              c.country, c.preferred_channel, c.created_at, c.updated_at, c.archived_at, c.deleted_at,
              (select array_agg(t.name::text order by lower(t.name::text)) from crm_contact_tags ct join crm_tags t on t.id = ct.tag_id where ct.contact_id = c.id) as tags
       from contacts c where c.id = $1 and c.org_id = $2`,
      [id, orgId],
    );
    const r = rows[0];
    if (!r || r.deleted_at) return gone;
    return {
      type: "contact", id: r.id, displayName: r.display_name, firstName: r.first_name, lastName: r.last_name, email: r.email, phone: r.phone, leadStatus: r.lead_status, leadScore: r.lead_score,
      source: r.source, ownerId: r.assigned_user_id, timezone: r.timezone, city: r.city, region: r.region, country: r.country, preferredChannel: r.preferred_channel, tags: r.tags ?? [],
      archived: Boolean(r.archived_at), createdAt: isoOrNull(r.created_at), updatedAt: isoOrNull(r.updated_at),
    };
  }
  if (entityType === "company") {
    const { rows } = await db.query<{ id: string; name: string; domain: string | null; website: string | null; industry: string | null; phone: string | null; email: string | null; city: string | null; country: string | null; owner_user_id: string | null; created_at: Date; updated_at: Date; archived_at: Date | null; deleted_at: Date | null }>(
      "select id, name, domain::text as domain, website, industry, phone, email::text as email, city, country, owner_user_id, created_at, updated_at, archived_at, deleted_at from crm_companies where id = $1 and org_id = $2",
      [id, orgId],
    );
    const r = rows[0];
    if (!r || r.deleted_at) return gone;
    return { type: "company", id: r.id, name: r.name, domain: r.domain, website: r.website, industry: r.industry, phone: r.phone, email: r.email, city: r.city, country: r.country, ownerId: r.owner_user_id, archived: Boolean(r.archived_at), createdAt: isoOrNull(r.created_at), updatedAt: isoOrNull(r.updated_at) };
  }
  if (entityType === "opportunity") {
    const { rows } = await db.query<{ id: string; name: string; status: string; pipeline_ref: string | null; stage_ref: string | null; stage_name: string | null; monetary_value: string | null; currency: string; contact_id: string | null; company_id: string | null; assigned_user_id: string | null; expected_close_date: string | null; lost_reason: string | null; created_at: Date; updated_at: Date; closed_at: Date | null; archived_at: Date | null }>(
      `select id, name, status, pipeline_ref::text as pipeline_ref, stage_ref::text as stage_ref, stage_name, monetary_value::text as monetary_value, currency, contact_id, company_id, assigned_user_id,
              expected_close_date::text as expected_close_date, lost_reason, created_at, updated_at, closed_at, archived_at
       from crm_opportunities where id = $1 and org_id = $2 and provider = 'native'`,
      [id, orgId],
    );
    const r = rows[0];
    if (!r) return gone;
    return {
      type: "opportunity", id: r.id, name: r.name, status: r.status, pipelineId: r.pipeline_ref, stageId: r.stage_ref, stageName: r.stage_name, value: r.monetary_value === null ? null : Number(r.monetary_value),
      currency: r.currency, contactId: r.contact_id, companyId: r.company_id, ownerId: r.assigned_user_id, expectedCloseDate: r.expected_close_date, lostReason: r.lost_reason,
      archived: Boolean(r.archived_at), createdAt: isoOrNull(r.created_at), updatedAt: isoOrNull(r.updated_at), closedAt: isoOrNull(r.closed_at),
    };
  }
  if (entityType === "appointment") {
    const { rows } = await db.query<{ id: string; title: string; status: string; start_at: Date; end_at: Date; calendar_ref: string | null; appointment_type_id: string | null; contact_id: string | null; booked_via: string | null; location: string | null; meeting_link: string | null; host_ids: string[] | null }>(
      `select a.id, a.title, a.status, a.start_at, a.end_at, a.calendar_ref, a.appointment_type_id, a.contact_id, a.booked_via, a.location, a.meeting_link,
              (select array_agg(h.user_id::text order by h.user_id) from crm_appointment_hosts h where h.appointment_id = a.id) as host_ids
       from appointment_refs a where a.id = $1 and a.org_id = $2 and a.provider = 'native'`,
      [id, orgId],
    );
    const r = rows[0];
    if (!r) return gone;
    return { type: "appointment", id: r.id, title: r.title, status: r.status === "noshow" ? "no_show" : r.status, startAt: isoOrNull(r.start_at), endAt: isoOrNull(r.end_at), calendarId: r.calendar_ref, appointmentTypeId: r.appointment_type_id, contactId: r.contact_id, hostIds: r.host_ids ?? [], bookedVia: r.booked_via, location: r.location, meetingLink: r.meeting_link };
  }
  if (entityType === "task") {
    const { rows } = await db.query<{ id: string; title: string; status: string; priority: string; due_at: Date | null; contact_id: string | null; company_id: string | null; opportunity_id: string | null; assigned_user_id: string | null; completed_at: Date | null; created_at: Date }>(
      "select id, title, status, priority, due_at, contact_id, company_id, opportunity_id, assigned_user_id, completed_at, created_at from tasks where id = $1 and org_id = $2",
      [id, orgId],
    );
    const r = rows[0];
    if (!r) return gone;
    return { type: "task", id: r.id, title: r.title, status: r.status, priority: r.priority, dueAt: isoOrNull(r.due_at), contactId: r.contact_id, companyId: r.company_id, opportunityId: r.opportunity_id, assigneeId: r.assigned_user_id, completedAt: isoOrNull(r.completed_at), createdAt: isoOrNull(r.created_at) };
  }
  if (entityType === "form") {
    const { rows } = await db.query<{ id: string; key: string; name: string; kind: string; purpose: string; status: string }>("select id, key, name, kind, purpose, status from crm_forms where id = $1 and org_id = $2", [id, orgId]);
    const r = rows[0];
    if (!r) return gone;
    return { type: "form", id: r.id, key: r.key, name: r.name, kind: r.kind, purpose: r.purpose, status: r.status };
  }
  if (entityType === "campaign") {
    const { rows } = await db.query<{ id: string; name: string; channel: string; status: string; started_at: Date | null; completed_at: Date | null }>(
      "select id, name, channel, status, started_at, completed_at from crm_campaigns where id = $1 and org_id = $2",
      [id, orgId],
    );
    const r = rows[0];
    if (!r) return gone;
    return { type: "campaign", id: r.id, name: r.name, channel: r.channel, status: r.status, startedAt: isoOrNull(r.started_at), completedAt: isoOrNull(r.completed_at) };
  }
  if (entityType === "review_request") {
    // Never the link's token (only its hash is stored, and that isn't sent either).
    const { rows } = await db.query<{ id: string; contact_id: string; channel: string; status: string; requested_via: string; appointment_id: string | null; opportunity_id: string | null; created_at: Date; sent_at: Date | null; opened_at: Date | null; clicked_at: Date | null; expires_at: Date }>(
      "select id, contact_id, channel, status, requested_via, appointment_id, opportunity_id, created_at, sent_at, opened_at, clicked_at, expires_at from crm_review_requests where id = $1 and org_id = $2",
      [id, orgId],
    );
    const r = rows[0];
    if (!r) return gone;
    return {
      type: "review_request", id: r.id, contactId: r.contact_id, channel: r.channel, status: r.status, via: r.requested_via, appointmentId: r.appointment_id, opportunityId: r.opportunity_id,
      createdAt: isoOrNull(r.created_at), sentAt: isoOrNull(r.sent_at), openedAt: isoOrNull(r.opened_at), reviewLinkClickedAt: isoOrNull(r.clicked_at), expiresAt: isoOrNull(r.expires_at),
    };
  }
  if (entityType === "customer_feedback") {
    // The rating and where it stands; the customer's comment stays in the CRM.
    const { rows } = await db.query<{ id: string; contact_id: string | null; review_request_id: string | null; rating: number | null; source: string; follow_up_status: string; received_at: Date }>(
      "select id, contact_id, review_request_id, rating, source, follow_up_status, received_at from customer_feedback where id = $1 and org_id = $2",
      [id, orgId],
    );
    const r = rows[0];
    if (!r) return gone;
    return { type: "customer_feedback", id: r.id, contactId: r.contact_id, reviewRequestId: r.review_request_id, rating: r.rating, source: r.source, followUpStatus: r.follow_up_status, receivedAt: isoOrNull(r.received_at) };
  }
  if (entityType === "call") {
    // What happened on the call; phone numbers, summaries, notes and recording or transcript references stay in the CRM.
    const { rows } = await db.query<{ id: string; provider: string; direction: string; status: string; contact_id: string | null; started_at: Date | null; ended_at: Date | null; duration_seconds: number | null; disposition: string | null; created_at: Date }>(
      "select id, provider, direction, status, contact_id, started_at, ended_at, duration_seconds, disposition, created_at from crm_call_records where id = $1 and org_id = $2",
      [id, orgId],
    );
    const r = rows[0];
    if (!r) return gone;
    return { type: "call", id: r.id, provider: r.provider, direction: r.direction, status: r.status, contactId: r.contact_id, startedAt: isoOrNull(r.started_at), endedAt: isoOrNull(r.ended_at), durationSeconds: r.duration_seconds, disposition: r.disposition, createdAt: isoOrNull(r.created_at) };
  }
  return { type: entityType, id };
}

interface EventRow { id: string; org_id: string; type: string; entity_type: string; entity_id: string | null; payload: Record<string, unknown>; occurred_at: Date }

async function buildEnvelope(db: Queryable, e: EventRow): Promise<string> {
  let data: unknown;
  if (e.type === PING_EVENT_TYPE) data = { message: "This is a test delivery from iAcquire. Answer with any 2xx status to confirm your endpoint works.", subscriptionId: e.entity_id };
  else if (e.type === WORKFLOW_EVENT_TYPE) data = e.payload;
  else data = { object: await snapshot(db, e.org_id, e.entity_type, e.entity_id, e.type), context: cleanContext(e.payload ?? {}) };
  return JSON.stringify({ id: `evt_${e.id}`, type: e.type, apiVersion: WEBHOOK_API_VERSION, occurredAt: new Date(e.occurred_at).toISOString(), orgId: e.org_id, data });
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

interface Prepared {
  deliveryId: string;
  orgId: string;
  subscriptionId: string;
  subscriptionName: string;
  url: string;
  secret: string | null;
  eventId: string;
  eventType: string;
  body: string;
  attempt: number;
}

export type AttemptResult =
  | { kind: "delivered"; status: number }
  /** The receiver answered with an error: it got the request and refused it. */
  | { kind: "rejected"; status: number; error: string }
  /** Never reached the receiver (address refused, DNS, connection refused, TLS). Safe to try again. */
  | { kind: "not_sent"; error: string }
  /** Sent, but no answer: the receiver may have processed it. */
  | { kind: "unknown"; error: string };

const NOT_SENT_CODES = new Set([
  "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/** Sorts a failed fetch into "never sent" (safe to retry) and "unknown outcome" (never retried automatically). */
export function classifyFetchFailure(err: unknown, timeoutMs: number): { kind: "not_sent" | "unknown"; error: string } {
  const name = err instanceof Error || (typeof err === "object" && err !== null && "name" in err) ? String((err as { name?: unknown }).name) : "";
  if (name === "TimeoutError" || name === "AbortError") return { kind: "unknown", error: `No answer within ${Math.round(timeoutMs / 1000)} seconds. The endpoint may have received it.` };
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur && typeof cur === "object"; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && NOT_SENT_CODES.has(code)) return { kind: "not_sent", error: `Couldn't connect to the endpoint (${code}).` };
    cur = (cur as { cause?: unknown }).cause;
  }
  return { kind: "unknown", error: "The connection failed while sending. The endpoint may have received it." };
}

/**
 * One delivery attempt. The address is checked (for a clear reason in the log), then sent through the pinned transport, whose connection
 * uses only addresses that passed the same check in its own lookup: a host that starts resolving to a private address between the two
 * (DNS rebinding) is refused, never connected to.
 */
async function attempt(p: Prepared): Promise<AttemptResult> {
  if (!p.secret) return { kind: "not_sent", error: "The signing secret couldn't be read. Roll the secret to fix this." };
  try {
    await checkWebhookUrl(p.url);
  } catch (err) {
    return { kind: "not_sent", error: err instanceof AppError ? err.message.slice(0, 280) : "The address was refused." };
  }
  const t = Math.floor(Date.now() / 1000);
  let res: { status: number };
  try {
    res = await pinnedHttps.post({
      url: p.url,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "iAcquire-Webhooks/1.0",
        [SIGNATURE_HEADER]: signWebhookPayload(p.secret, p.body, t),
        [EVENT_ID_HEADER]: `evt_${p.eventId}`,
        "iAcquire-Event-Type": p.eventType,
        "iAcquire-Delivery-Id": p.deliveryId,
        "iAcquire-Delivery-Attempt": String(p.attempt),
      },
      body: p.body,
      timeoutMs: DELIVERY_TIMEOUT_MS,
    });
  } catch (err) {
    if (err instanceof UnsafeAddressError) return { kind: "not_sent", error: "That address now points to a private, local or internal network, so nothing was sent." };
    return classifyFetchFailure(err, DELIVERY_TIMEOUT_MS);
  }
  if (res.status >= 200 && res.status < 300) return { kind: "delivered", status: res.status };
  const redirect = res.status >= 300 && res.status < 400 ? " Redirects aren't followed; use the final address." : "";
  return { kind: "rejected", status: res.status, error: `The endpoint answered HTTP ${res.status}.${redirect}` };
}

/** Builds what to send for deliveries just claimed (in the claim transaction, so the record is read as it is now). */
async function prepare(db: Queryable, claimed: Array<{ id: string; org_id: string; subscription_id: string; event_id: string; attempts: number }>): Promise<Prepared[]> {
  if (!claimed.length) return [];
  const subs = await db.query<{ id: string; name: string; url: string; secret_ciphertext: string }>("select id, name, url, secret_ciphertext from crm_webhook_subscriptions where id = any($1::uuid[])", [[...new Set(claimed.map((c) => c.subscription_id))]]);
  const events = await db.query<EventRow>("select id::text as id, org_id, type, entity_type, entity_id, payload, occurred_at from crm_events where id = any($1::bigint[])", [[...new Set(claimed.map((c) => c.event_id))]]);
  const out: Prepared[] = [];
  for (const c of claimed) {
    const s = subs.rows.find((x) => x.id === c.subscription_id);
    const e = events.rows.find((x) => x.id === String(c.event_id));
    if (!s || !e) continue;
    let secret: string | null = null;
    try {
      secret = decryptSecret(s.secret_ciphertext);
    } catch {
      secret = null;
    }
    out.push({ deliveryId: c.id, orgId: c.org_id, subscriptionId: s.id, subscriptionName: s.name, url: s.url, secret, eventId: String(c.event_id), eventType: e.type, body: await buildEnvelope(db, e), attempt: c.attempts });
  }
  return out;
}

async function bumpFailures(db: Queryable, orgId: string, subscriptionId: string, lastError: string) {
  const { rows } = await db.query<{ consecutive_failures: number; active: boolean; name: string }>(
    "update crm_webhook_subscriptions set consecutive_failures = consecutive_failures + 1 where id = $1 and org_id = $2 returning consecutive_failures, active, name",
    [subscriptionId, orgId],
  );
  const s = rows[0];
  if (!s || !s.active || s.consecutive_failures < AUTO_DISABLE_AFTER) return;
  const reason = `Turned off automatically after ${AUTO_DISABLE_AFTER} failed delivery attempts in a row. Last error: ${lastError}`.slice(0, 300);
  const off = await db.query<{ updated_at: Date }>("update crm_webhook_subscriptions set active = false, disabled_reason = $3 where id = $1 and org_id = $2 and active returning updated_at", [subscriptionId, orgId, reason]);
  if (!off.rows[0]) return;
  await notifyOrgRoles(db, orgId, ["owner", "admin"], {
    kind: "crm_webhook_failing",
    severity: "warning",
    title: `Webhook “${s.name.slice(0, 60)}” was turned off`,
    body: `${AUTO_DISABLE_AFTER} delivery attempts in a row failed (${lastError.slice(0, 160)}). Fix the endpoint, then resume the webhook in CRM Settings, API & Webhooks.`,
    link: "/crm/settings/api",
    dedupeKey: `crm-webhook-off:${subscriptionId}:${new Date(off.rows[0].updated_at).getTime()}`,
  });
  await recordAudit({ orgId, actorKind: "system", action: "crm.webhook_auto_disabled", targetType: "crm_webhook_subscription", targetId: subscriptionId, result: "failure", metadata: { failures: s.consecutive_failures } }, db);
}

export interface DeliveryOutcome {
  deliveryId: string;
  status: "delivered" | "retrying" | "failed";
  responseStatus: number | null;
  detail: string;
}

/** Records one attempt. Only the claim that made it can record it (status still delivering with the same attempt number). */
async function record(p: Prepared, r: AttemptResult): Promise<DeliveryOutcome> {
  const ping = p.eventType === PING_EVENT_TYPE;
  return withSystem(async (db) => {
    if (r.kind === "delivered") {
      const upd = await db.query("update crm_webhook_deliveries set status = 'delivered', delivered_at = now(), response_status = $3, last_error = null, claimed_at = null where id = $1 and status = 'delivering' and attempts = $2", [p.deliveryId, p.attempt, r.status]);
      if (upd.rowCount) await db.query("update crm_webhook_subscriptions set consecutive_failures = 0 where id = $1 and consecutive_failures <> 0", [p.subscriptionId]);
      return { deliveryId: p.deliveryId, status: "delivered", responseStatus: r.status, detail: `Delivered (HTTP ${r.status}).` };
    }
    const status = "status" in r ? r.status : null;
    const final = ping || r.kind === "unknown" || p.attempt >= MAX_ATTEMPTS;
    const error = (r.kind === "unknown" ? `${r.error} Not retried automatically; use Redeliver if it didn't arrive.` : final && !ping ? `${r.error} Gave up after ${p.attempt} attempts.` : r.error).slice(0, 300);
    const upd = await db.query(
      `update crm_webhook_deliveries set status = $3, response_status = $4, last_error = $5, claimed_at = null,
         next_attempt_at = case when $3 = 'failed' then now() + make_interval(secs => $6::int) else next_attempt_at end
       where id = $1 and status = 'delivering' and attempts = $2`,
      [p.deliveryId, p.attempt, final ? "dead" : "failed", status, error, retryDelaySeconds(p.attempt)],
    );
    if (upd.rowCount && !ping) await bumpFailures(db, p.orgId, p.subscriptionId, r.error);
    return { deliveryId: p.deliveryId, status: final ? "failed" : "retrying", responseStatus: status, detail: error };
  });
}

/**
 * Housekeeping before each run. Deliveries whose worker stopped mid-send have an unknown outcome: they are closed as failed, never resent
 * automatically. Deliveries held back for more than HOLD_DAYS are closed too.
 */
async function reconcileStale(): Promise<number> {
  return withSystem(async (db) => {
    const { rows } = await db.query<{ org_id: string; subscription_id: string; type: string }>(
      `with stale as (
         update crm_webhook_deliveries set status = 'dead', claimed_at = null,
           last_error = 'Interrupted while sending, so the outcome is unknown. Not retried automatically; use Redeliver if it didn''t arrive.'
         where status = 'delivering' and claimed_at < now() - make_interval(mins => $1::int) returning org_id, subscription_id, event_id)
       select s.org_id, s.subscription_id, e.type from stale s join crm_events e on e.id = s.event_id`,
      [LEASE_MINUTES],
    );
    for (const r of rows) if (r.type !== PING_EVENT_TYPE) await bumpFailures(db, r.org_id, r.subscription_id, "The delivery was interrupted.");
    // Held back too long (paused or switched-off webhook, paused or suspended workspace): closed rather than sent days late.
    const expired = await db.query(
      `update crm_webhook_deliveries set status = 'dead', claimed_at = null,
         last_error = 'Not sent within ' || $1::int || ' days because the webhook or the workspace''s automation was paused or off. Use Redeliver to send it now.'
       where id in (select id from crm_webhook_deliveries where status in ('pending', 'failed') and created_at < now() - make_interval(days => $1::int) limit 500)`,
      [HOLD_DAYS],
    );
    return rows.length + expired.rowCount;
  });
}

/** Removes delivery history older than HISTORY_DAYS, and the test pings and workflow payloads behind it (their outbox rows). */
export async function pruneWebhookHistory(): Promise<number> {
  return withSystem(async (db) => {
    const d = await db.query(
      `delete from crm_webhook_deliveries where id in (select id from crm_webhook_deliveries where status in ('delivered', 'dead') and created_at < now() - make_interval(days => $1::int) limit 500)`,
      [HISTORY_DAYS],
    );
    const e = await db.query(
      `delete from crm_events where id in (select id from crm_events where type = any($1::text[]) and occurred_at < now() - make_interval(days => $2::int) limit 500)`,
      [[PING_EVENT_TYPE, WORKFLOW_EVENT_TYPE], HISTORY_DAYS],
    );
    return d.rowCount + e.rowCount;
  });
}

/**
 * The scheduler job: sends due deliveries in small concurrent batches until nothing is due, `limit` attempts were made, or the time budget
 * is spent (the tick's 120 seconds are shared by every job). Deliveries of paused subscriptions, inactive workspaces, or while the agency
 * has paused automation, wait. Returns the number of attempts made.
 */
export async function deliverDueWebhooks(opts: { limit?: number; budgetMs?: number } = {}): Promise<number> {
  const limit = Math.max(1, opts.limit ?? 100);
  const budget = opts.budgetMs ?? 25_000;
  const started = Date.now();
  await reconcileStale();
  if (Math.random() < 0.05) await pruneWebhookHistory();
  let attempted = 0;
  while (attempted < limit && Date.now() - started < budget) {
    const batch = await withSystem(async (db) => {
      const { rows } = await db.query<{ id: string; org_id: string; subscription_id: string; event_id: string; attempts: number }>(
        `with due as (
           select d.id from crm_webhook_deliveries d
           join crm_webhook_subscriptions s on s.id = d.subscription_id and s.org_id = d.org_id
           join organizations o on o.id = d.org_id
           where d.status in ('pending', 'failed') and d.next_attempt_at <= now() and s.active and o.status not in ('suspended', 'archived')
             and not exists (select 1 from automation_pauses p join organizations po on po.id = p.org_id
                             where p.active and p.scope = 'agency' and (p.org_id = d.org_id or po.kind = 'agency'))
           order by d.next_attempt_at, d.id limit $1
           for update of d skip locked)
         update crm_webhook_deliveries d set status = 'delivering', claimed_at = now(), attempts = d.attempts + 1
         from due where d.id = due.id returning d.id, d.org_id, d.subscription_id, d.event_id::text as event_id, d.attempts`,
        [Math.min(BATCH, limit - attempted)],
      );
      return prepare(db, rows);
    });
    if (!batch.length) break;
    const results = await Promise.all(batch.map((p) => attempt(p)));
    for (let i = 0; i < batch.length; i++) await record(batch[i], results[i]);
    attempted += batch.length;
  }
  return attempted;
}

async function manualLimit(actor: CrmActor) {
  const rl = await consumeRateLimit(RATE_LIMITS.crmWebhookManualByOrg, actor.orgId);
  if (!rl.allowed) throw new AppError("rate_limited", "That's a lot of test sends and redeliveries. Try again a little later.", { retryAfterSeconds: rl.retryAfterSeconds });
}

/** Sends a "webhook.ping" event to the subscription right now (even while it is paused) and reports what the endpoint answered. */
export async function sendTestWebhook(actor: CrmActor, subscriptionId: string): Promise<DeliveryOutcome> {
  assertCan(actor, "crm.api.manage");
  assertMember(actor, "send test webhooks");
  await manualLimit(actor);
  const [p] = await withSystem(async (db) => {
    const sub = await db.query("select 1 from crm_webhook_subscriptions where id = $1 and org_id = $2", [subscriptionId, actor.orgId]);
    if (!sub.rows.length) throw new AppError("not_found", "Webhook not found.");
    const ev = await db.query<{ id: string }>(
      `insert into crm_events (org_id, type, entity_type, entity_id, payload, dedupe_key, actor_kind, actor_id, depth, dispatched_at)
       values ($1, $2, 'webhook_subscription', $3, '{}'::jsonb, $4, 'user', $5, 0, now()) returning id::text as id`,
      [actor.orgId, PING_EVENT_TYPE, subscriptionId, `${PING_EVENT_TYPE}:${crypto.randomUUID()}`, actor.userId],
    );
    const d = await db.query<{ id: string; org_id: string; subscription_id: string; event_id: string; attempts: number }>(
      `insert into crm_webhook_deliveries (org_id, subscription_id, event_id, status, attempts, claimed_at) values ($1, $2, $3, 'delivering', 1, now())
       returning id, org_id, subscription_id, event_id::text as event_id, attempts`,
      [actor.orgId, subscriptionId, ev.rows[0].id],
    );
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.webhook_test_sent", targetType: "crm_webhook_subscription", targetId: subscriptionId, result: "success" }, db);
    return prepare(db, d.rows);
  });
  return record(p, await attempt(p));
}

/** Sends a logged delivery again now, with the same event id, starting a fresh retry cycle if it fails. */
export async function redeliverWebhook(actor: CrmActor, deliveryId: string): Promise<DeliveryOutcome> {
  assertCan(actor, "crm.api.manage");
  assertMember(actor, "redeliver webhooks");
  await manualLimit(actor);
  const [p] = await withSystem(async (db) => {
    const cur = await db.query<{ status: DeliveryStatus }>("select status from crm_webhook_deliveries where id = $1 and org_id = $2 for update", [deliveryId, actor.orgId]);
    if (!cur.rows[0]) throw new AppError("not_found", "Delivery not found.");
    if (cur.rows[0].status === "delivering") throw new AppError("conflict", "This delivery is being sent right now. Refresh in a few seconds.");
    const d = await db.query<{ id: string; org_id: string; subscription_id: string; event_id: string; attempts: number }>(
      `update crm_webhook_deliveries set status = 'delivering', attempts = 1, claimed_at = now(), next_attempt_at = now(), last_error = null, response_status = null, delivered_at = null
       where id = $1 and org_id = $2 returning id, org_id, subscription_id, event_id::text as event_id, attempts`,
      [deliveryId, actor.orgId],
    );
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.webhook_redelivered", targetType: "crm_webhook_delivery", targetId: deliveryId, result: "success", metadata: { previousStatus: cur.rows[0].status } }, db);
    return prepare(db, d.rows);
  });
  if (!p) throw new AppError("not_found", "Delivery not found.");
  return record(p, await attempt(p));
}
