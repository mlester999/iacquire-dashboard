import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyOrgRoles } from "@/server/notifications";
import { createApproval } from "@/server/approvals/service";
import { assertCan, auditActor, crmRead, crmWrite, type CrmActor } from "@/server/crm/actor";
import { assertNativeOwner } from "@/server/crm/workspace";
import {
  CAMPAIGN_COLUMNS, DEFAULT_RATE_PER_MINUTE, EXCLUSION_REASONS, MAX_RATE_PER_MINUTE, MAX_RECIPIENTS, MAX_SCHEDULE_AHEAD_MS, SCHEDULE_GRACE_MS, UUID_RE,
  bindingChanges, businessValuesNow, campaignApprovalHash, channelProblems, checkCredits, estimateCost, iso, loadAudienceList, loadCampaignTemplate, messageProblems, readBinding, readListFilter,
  sendingPolicy, summarizeAudience, templateProblems, wordingStillApproved,
  type ApprovalBinding, type AudienceSummary, type CampaignEstimate, type CampaignRow, type CampaignStatus, type CreditCheck, type ExclusionReason, type RecipientStatus,
  type SendingPolicy,
} from "@/server/crm/campaigns/rules";
import {
  blockQueuedMessages, holdQueuedMessages, notice, readCounts, readNotice, refreshCounts, releaseHeldMessages, setNotice, voidApproval,
  type CampaignCounts, type CampaignNotice,
} from "@/server/crm/campaigns/state";
import { currentBinding, returnToDraft, valuesChangedSinceApproval } from "@/server/crm/campaigns/job";
import type { CustomValueTokenDef } from "@/lib/messaging/tokens";
import { CHANNEL_LABELS, isChannel, type Channel } from "@/lib/messaging";
import { formatUsd } from "@/lib/billing";
import { formatDateTime } from "@/lib/utils";
import { zonedToInstant, isValidTimeZone } from "@/lib/calendars/slots";

// Compliant segmented campaigns (crm_campaigns, crm_campaign_recipients). A campaign is a Smart List (resolved when sending starts), one
// approved marketing template version, a channel, a schedule and a pace. It reaches only people who agreed to receive marketing on that
// channel, checked again for each person when their message is queued and once more right before it is sent.
//
//  * Drafts are prepared by people who can manage campaigns. The preview counts who would receive it now and who is left out, by reason
//    (counts only), and prices it at the provider's published rate (no published rate: no price, and it can't be sent).
//  * Sending needs the workspace owner's approval (campaign_activation, high risk: only the owner decides) of a fingerprint of exactly what
//    is sent: channel, Smart List and its filter, template version and its content hash, the linked WhatsApp template, schedule and pace.
//    Any change voids it. The owner can approve on the campaign itself or in the Approval Center; both run executeCampaignActivation.
//  * The job (./campaigns/job.ts) starts it, queues it at the approved pace through the normal outbound rules and records what happened.
//  * Pausing holds what it queued and hasn't sent; resuming (the owner's decision) re-checks the approval and wording; cancelling stops it.

export type { CampaignCounts, CampaignNotice } from "@/server/crm/campaigns/state";
export type { CampaignEstimate, CreditCheck, SendingPolicy, AudienceSummary, CampaignStatus, RecipientStatus, ExclusionReason } from "@/server/crm/campaigns/rules";
export { CAMPAIGN_STATUSES, EXCLUSION_REASONS, MAX_RATE_PER_MINUTE, DEFAULT_RATE_PER_MINUTE } from "@/server/crm/campaigns/rules";

export type ApprovalState = "none" | "pending" | "approved" | "expired" | "declined" | "withdrawn";

export interface CampaignListItem {
  id: string;
  name: string;
  channel: Channel;
  status: CampaignStatus;
  list: { id: string; name: string } | null;
  template: { id: string; name: string; version: number | null } | null;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdByName: string | null;
  ratePerMinute: number;
  counts: CampaignCounts;
  notice: CampaignNotice | null;
  approval: ApprovalState;
}

export interface CampaignApprovalInfo {
  id: string;
  state: ApprovalState;
  requestedByName: string | null;
  decidedByName: string | null;
  requestedAt: string;
  decidedAt: string | null;
  expiresAt: string | null;
  note: string | null;
  /** The fingerprint the request covers. */
  fingerprint: string | null;
}

/** What the preview showed when approval was requested or given (counts and price only). */
export interface StoredEstimate {
  at: string;
  total: number;
  eligible: number;
  excluded: Partial<Record<ExclusionReason, number>>;
  unitsPerMessage: number;
  costMicros: number | null;
  provider: string;
  rateVersion: number | null;
}

export interface CampaignDetail extends CampaignListItem {
  smartListId: string | null;
  templateId: string | null;
  templateVersion: number | null;
  approvalInfo: CampaignApprovalInfo | null;
  approvedHash: string | null;
  /** The exact wording the campaign sends (the frozen template version), placeholders included. */
  message: { name: string; version: number; subject: string | null; body: string; contentHash: string; whatsappTemplateId: string | null } | null;
  estimate: StoredEstimate | null;
  cancelledByName: string | null;
  /** The schedule as the workspace reads it (its time zone), for the builder. */
  scheduleLocal: { date: string; time: string } | null;
}

const one = <T>(rows: T[]) => rows[0];
const notFound = () => new AppError("not_found", "Campaign not found.");
const cleanName = (raw: string | undefined) => (raw ?? "").replace(/\s+/g, " ").trim();

function approvalStateOf(row: { status: string; expires_at: Date | null } | null | undefined, campaign: Pick<CampaignRow, "approved_hash" | "status">): ApprovalState {
  if (!row) return "none";
  if (row.status === "pending") return row.expires_at && new Date(row.expires_at).getTime() <= Date.now() ? "expired" : "pending";
  if (row.status === "expired") return "expired";
  if (row.status === "approved") return campaign.approved_hash ? "approved" : "withdrawn";
  if (row.status === "rejected" || row.status === "changes_requested") return "declined";
  return "withdrawn";
}

function readStoredEstimate(raw: unknown): StoredEstimate | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.at !== "string" || typeof o.total !== "number" || typeof o.eligible !== "number") return null;
  const excluded: Partial<Record<ExclusionReason, number>> = {};
  if (typeof o.excluded === "object" && o.excluded) {
    for (const [k, v] of Object.entries(o.excluded as Record<string, unknown>)) if ((EXCLUSION_REASONS as readonly string[]).includes(k) && typeof v === "number") excluded[k as ExclusionReason] = v;
  }
  return {
    at: o.at, total: o.total, eligible: o.eligible, excluded, unitsPerMessage: typeof o.unitsPerMessage === "number" ? o.unitsPerMessage : 1,
    costMicros: typeof o.costMicros === "number" ? o.costMicros : null, provider: typeof o.provider === "string" ? o.provider : "", rateVersion: typeof o.rateVersion === "number" ? o.rateVersion : null,
  };
}

function localSchedule(at: Date | null, timeZone: string): { date: string; time: string } | null {
  if (!at) return null;
  const tz = isValidTimeZone(timeZone) ? timeZone : "UTC";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** Viewing campaigns needs "Prepare campaigns" (the same rule as the row-level security policy). */
function assertCanView(actor: CrmActor) {
  assertCan(actor, "campaigns.manage", "Campaigns need the “Prepare campaigns” permission, which the owner or a manager can give you.");
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

interface ListRow extends CampaignRow {
  approval_status: string | null;
  approval_expires_at: Date | null;
  created_by_name: string | null;
}

async function loadNames(orgId: string, rows: CampaignRow[]) {
  const listIds = [...new Set(rows.map((r) => r.smart_list_id).filter((x): x is string => !!x))];
  const templateIds = [...new Set(rows.map((r) => r.template_id).filter((x): x is string => !!x))];
  // Trusted after the permission check: whoever prepares or approves a campaign must see which list and message it uses, even a teammate's private list.
  return withSystem(async (db) => {
    const lists = listIds.length ? (await db.query<{ id: string; name: string }>("select id, name from crm_smart_lists where org_id = $1 and id = any($2::uuid[])", [orgId, listIds])).rows : [];
    const templates = templateIds.length ? (await db.query<{ id: string; name: string }>("select id, name from crm_message_templates where org_id = $1 and id = any($2::uuid[])", [orgId, templateIds])).rows : [];
    return { lists: new Map(lists.map((l) => [l.id, l.name])), templates: new Map(templates.map((t) => [t.id, t.name])) };
  });
}

function toListItem(r: ListRow, names: { lists: Map<string, string>; templates: Map<string, string> }): CampaignListItem {
  return {
    id: r.id, name: r.name, channel: r.channel, status: r.status,
    list: r.smart_list_id ? { id: r.smart_list_id, name: names.lists.get(r.smart_list_id) ?? "Smart List" } : null,
    template: r.template_id ? { id: r.template_id, name: names.templates.get(r.template_id) ?? "Template", version: r.template_version } : null,
    scheduledAt: iso(r.scheduled_at), startedAt: iso(r.started_at), completedAt: iso(r.completed_at), createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!,
    createdByName: r.created_by_name, ratePerMinute: r.rate_per_minute, counts: readCounts(r.counts), notice: readNotice(r.counts),
    approval: approvalStateOf(r.approval_status ? { status: r.approval_status, expires_at: r.approval_expires_at } : null, r),
  };
}

const LIST_SQL = `
  select ${CAMPAIGN_COLUMNS.split(", ").map((c) => `k.${c}`).join(", ")}, a.status as approval_status, a.expires_at as approval_expires_at, nullif(u.full_name, '') as created_by_name
  from crm_campaigns k
  left join approval_requests a on a.id = k.approval_id and a.org_id = k.org_id
  left join users u on u.id = k.created_by`;

export async function listCampaigns(actor: CrmActor, opts: { status?: CampaignStatus } = {}): Promise<CampaignListItem[]> {
  assertCanView(actor);
  const rows = await crmRead(actor, async (db) =>
    (await db.query<ListRow>(`${LIST_SQL} where k.org_id = $1 and ($2::text is null or k.status = $2) order by coalesce(k.started_at, k.scheduled_at, k.updated_at) desc limit 300`, [actor.orgId, opts.status ?? null])).rows,
  );
  const names = await loadNames(actor.orgId, rows);
  return rows.map((r) => toListItem(r, names));
}

export async function getCampaign(actor: CrmActor, id: string): Promise<CampaignDetail> {
  assertCanView(actor);
  if (!UUID_RE.test(id)) throw notFound();
  const r = await crmRead(actor, async (db) => one((await db.query<ListRow>(`${LIST_SQL} where k.id = $1 and k.org_id = $2`, [id, actor.orgId])).rows));
  if (!r) throw notFound();
  const names = await loadNames(actor.orgId, [r]);
  return withSystem(async (db) => {
    const t = await loadCampaignTemplate(db, actor.orgId, r.template_id, r.template_version);
    const a = r.approval_id
      ? one((await db.query<{ id: string; status: string; expires_at: Date | null; created_at: Date; decided_at: Date | null; decision_note: string | null; action: Record<string, unknown>; req: string | null; dec: string | null }>(
          `select a.id, a.status, a.expires_at, a.created_at, a.decided_at, a.decision_note, a.action, nullif(ru.full_name, '') as req, nullif(du.full_name, '') as dec
           from approval_requests a left join users ru on ru.id = a.requested_by left join users du on du.id = a.decided_by where a.id = $1 and a.org_id = $2`,
          [r.approval_id, actor.orgId],
        )).rows)
      : undefined;
    const cancelledBy = r.cancelled_by ? one((await db.query<{ n: string | null }>("select nullif(full_name, '') as n from users where id = $1", [r.cancelled_by])).rows)?.n ?? null : null;
    return {
      ...toListItem(r, names),
      smartListId: r.smart_list_id, templateId: r.template_id, templateVersion: r.template_version, approvedHash: r.approved_hash,
      approvalInfo: a ? {
        id: a.id, state: approvalStateOf(a, r), requestedByName: a.req, decidedByName: a.dec, requestedAt: iso(a.created_at)!, decidedAt: iso(a.decided_at), expiresAt: iso(a.expires_at),
        note: a.decision_note, fingerprint: typeof a.action.hash === "string" ? a.action.hash : null,
      } : null,
      message: t?.version ? { name: t.name, version: t.version.number, subject: t.version.subject, body: t.version.body, contentHash: t.version.contentHash, whatsappTemplateId: t.whatsappTemplateId } : null,
      estimate: readStoredEstimate(r.estimate), cancelledByName: cancelledBy, scheduleLocal: localSchedule(r.scheduled_at, actor.timezone),
    };
  });
}

export interface RecipientRow {
  contactId: string;
  /** Null when the person looking can't open this contact (their access to contacts doesn't include it). */
  name: string | null;
  status: RecipientStatus;
  reason: string | null;
  /** When they wait for quiet hours, business hours or spacing, until when. */
  waitUntil: string | null;
  queuedAt: string | null;
  updatedAt: string;
  /** The conversation the message is in, when the person looking can open it. */
  conversationId: string | null;
}

export interface RecipientPage {
  rows: RecipientRow[];
  total: number;
  page: number;
  pageSize: number;
}

const RECIPIENT_FILTERS = ["all", "pending", "queued", "sent", "delivered", "failed", "bounced", "unsubscribed", "excluded"] as const;
export type RecipientFilter = (typeof RECIPIENT_FILTERS)[number];
export const isRecipientFilter = (v: unknown): v is RecipientFilter => typeof v === "string" && (RECIPIENT_FILTERS as readonly string[]).includes(v);

/**
 * The delivery log: each recipient's status and reason. Names come through the viewer's own access (row-level security), so nobody sees a
 * contact they couldn't open on the Contacts screen; without contact access the log shows statuses only.
 */
export async function listCampaignRecipients(actor: CrmActor, id: string, opts: { status?: RecipientFilter; page?: number; pageSize?: number } = {}): Promise<RecipientPage> {
  assertCanView(actor);
  if (!UUID_RE.test(id)) throw notFound();
  const pageSize = Math.min(100, Math.max(10, Math.trunc(opts.pageSize ?? 25)));
  const page = Math.max(1, Math.trunc(opts.page ?? 1));
  const status = opts.status && opts.status !== "all" ? opts.status : null;
  const names = actor.can("contacts.view");
  return crmRead(actor, async (db) => {
    const c = one((await db.query<{ id: string }>("select id from crm_campaigns where id = $1 and org_id = $2", [id, actor.orgId])).rows);
    if (!c) throw notFound();
    const total = Number(one((await db.query<{ n: string }>("select count(*)::text as n from crm_campaign_recipients where campaign_id = $1 and org_id = $2 and ($3::text is null or status = $3)", [id, actor.orgId, status])).rows).n);
    const { rows } = await db.query<{ contact_id: string; name: string | null; visible: boolean; status: RecipientStatus; reason: string | null; queued_at: Date | null; updated_at: Date; conversation_id: string | null }>(
      `select r.contact_id, ${names ? "nullif(btrim(k.display_name), '')" : "null::text"} as name, ${names ? "k.id is not null" : "false"} as visible, r.status, r.reason, r.queued_at, r.updated_at,
              ${actor.can("inbox.view") ? "m.conversation_id" : "null::uuid"} as conversation_id
       from crm_campaign_recipients r
       ${names ? "left join contacts k on k.id = r.contact_id and k.org_id = r.org_id" : ""}
       left join conversation_messages m on m.id = r.message_id and m.org_id = r.org_id
       where r.campaign_id = $1 and r.org_id = $2 and ($3::text is null or r.status = $3)
       order by r.updated_at desc, r.contact_id limit $4 offset $5`,
      [id, actor.orgId, status, pageSize, (page - 1) * pageSize],
    );
    return {
      rows: rows.map((r) => {
        const waiting = r.status === "pending" && r.reason?.startsWith("waiting:");
        const until = waiting ? r.reason!.split("|")[1] ?? null : null;
        return {
          contactId: r.contact_id, name: names ? (r.visible ? (r.name ?? "Unnamed contact") : "Removed contact") : null, status: r.status, reason: waiting ? r.reason!.split("|")[0] : r.reason, waitUntil: until && !Number.isNaN(Date.parse(until)) ? until : null,
          queuedAt: iso(r.queued_at), updatedAt: iso(r.updated_at)!, conversationId: r.conversation_id,
        };
      }),
      total, page, pageSize,
    };
  });
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

export type ScheduleInput = { mode: "now" } | { mode: "later"; date: string; time: string };

export interface CampaignInput {
  name?: string;
  channel?: string;
  smartListId?: string | null;
  templateId?: string | null;
  schedule?: ScheduleInput;
  ratePerMinute?: number;
}

/** When a scheduled campaign starts, from a date and time in the workspace's time zone. Null: as soon as the owner approves it. */
export function parseSchedule(input: ScheduleInput | undefined, timeZone: string, now = new Date()): Date | null {
  if (!input || input.mode === "now") return null;
  if (input.mode !== "later" || !/^\d{4}-\d{2}-\d{2}$/.test(input.date ?? "") || !/^\d{2}:\d{2}$/.test(input.time ?? "")) throw new AppError("invalid_input", "Choose the date and time it should start.");
  const [h, m] = input.time.split(":").map(Number);
  if (h > 23 || m > 59 || Number.isNaN(Date.parse(`${input.date}T00:00:00Z`))) throw new AppError("invalid_input", "Choose a real date and time.");
  const at = new Date(zonedToInstant(input.date, h * 60 + m, isValidTimeZone(timeZone) ? timeZone : "UTC"));
  if (at.getTime() < now.getTime() + 60_000) throw new AppError("invalid_input", "Choose a time at least a minute from now, or send it as soon as it's approved.");
  if (at.getTime() > now.getTime() + MAX_SCHEDULE_AHEAD_MS) throw new AppError("invalid_input", "Campaigns can be scheduled up to a year ahead.");
  return at;
}

function cleanRate(v: number | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  if (!Number.isInteger(v) || v < 1 || v > MAX_RATE_PER_MINUTE) throw new AppError("invalid_input", `Choose a pace between 1 and ${MAX_RATE_PER_MINUTE} messages a minute.`);
  return v;
}

/** A Smart List the actor may build a campaign on: a contact list shared with the team, or their own. */
async function usableList(db: Queryable, actor: CrmActor, id: string): Promise<string> {
  if (!UUID_RE.test(id)) throw new AppError("invalid_input", "Choose a Smart List from the list.");
  const l = await loadAudienceList(db, actor.orgId, id);
  if (!l || l.archived) throw new AppError("invalid_input", "That Smart List no longer exists.");
  if (l.visibility === "private" && l.ownerUserId !== actor.userId) throw new AppError("invalid_input", "That Smart List is private to someone else. Choose one shared with the team or one of your own.");
  if (l.filterError) throw new AppError("invalid_input", l.filterError);
  return l.id;
}

/** A template of this workspace for the channel; the campaign keeps its approved version (or its current one while it isn't approved). */
async function chosenTemplate(db: Queryable, orgId: string, id: string, channel: Channel): Promise<{ id: string; version: number }> {
  if (!UUID_RE.test(id)) throw new AppError("invalid_input", "Choose a message template from the list.");
  const t = await loadCampaignTemplate(db, orgId, id);
  if (!t || t.kind !== "template" || t.status === "archived") throw new AppError("invalid_input", "That message template no longer exists.");
  if (t.channel !== channel) throw new AppError("invalid_input", `That template is written for ${t.channel ? CHANNEL_LABELS[t.channel] : "another channel"}. Choose a ${CHANNEL_LABELS[channel]} template.`);
  return { id: t.id, version: t.approvedVersion ?? t.currentVersion };
}

async function lockOwn(db: Queryable, actor: CrmActor, id: string): Promise<CampaignRow> {
  if (!UUID_RE.test(id)) throw notFound();
  const c = one((await db.query<CampaignRow>(`select ${CAMPAIGN_COLUMNS} from crm_campaigns where id = $1 and org_id = $2 for update`, [id, actor.orgId])).rows);
  if (!c) throw notFound();
  return c;
}

function assertCanPrepare(actor: CrmActor) {
  assertCan(actor, "campaigns.manage", "Preparing campaigns needs the “Prepare campaigns” permission, which the owner or a manager can give you.");
  if (actor.kind !== "member" || !actor.userId) throw new AppError("forbidden", "Campaigns are prepared by people in the client's own workspace.");
}

export async function createCampaign(actor: CrmActor, input: CampaignInput): Promise<{ id: string }> {
  assertCanPrepare(actor);
  const name = cleanName(input.name);
  if (!name || name.length > 120) throw new AppError("invalid_input", "Name the campaign (up to 120 characters).");
  if (!isChannel(input.channel)) throw new AppError("invalid_input", "Choose the channel it sends on.");
  const channel = input.channel;
  const scheduledAt = parseSchedule(input.schedule, actor.timezone);
  const rate = cleanRate(input.ratePerMinute, DEFAULT_RATE_PER_MINUTE);
  return crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "contacts");
    const listId = input.smartListId ? await usableList(db, actor, input.smartListId) : null;
    const tpl = input.templateId ? await chosenTemplate(db, actor.orgId, input.templateId, channel) : null;
    const { rows } = await db.query<{ id: string }>(
      `insert into crm_campaigns (org_id, name, channel, smart_list_id, template_id, template_version, scheduled_at, rate_per_minute, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [actor.orgId, name, channel, listId, tpl?.id ?? null, tpl?.version ?? null, scheduledAt, rate, actor.userId],
    );
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.campaign_created", targetType: "crm_campaign", targetId: rows[0].id, result: "success", metadata: { channel } }, db);
    return { id: rows[0].id };
  });
}

export interface UpdateResult {
  /** The owner's approval (or the request for it) was withdrawn because what would be sent changed. */
  approvalWithdrawn: boolean;
}

/**
 * Changes a campaign that hasn't started. Changing anything the approval covers (channel, list, message, schedule, pace) withdraws an
 * approval or a pending request and puts it back to draft; renaming doesn't. A started campaign can't be changed: pause or cancel it.
 */
export async function updateCampaign(actor: CrmActor, id: string, input: CampaignInput & { expectedUpdatedAt?: string }): Promise<UpdateResult> {
  assertCanPrepare(actor);
  return crmWrite(actor, async (db) => {
    const c = await lockOwn(db, actor, id);
    if (input.expectedUpdatedAt && iso(c.updated_at) !== new Date(input.expectedUpdatedAt).toISOString()) {
      throw new AppError("conflict", "Someone else changed this campaign while you were editing. Reload to see their changes, then make yours again.");
    }
    if (c.started_at || ["sending", "completed", "cancelled"].includes(c.status)) {
      throw new AppError("conflict", c.status === "cancelled" ? "This campaign was cancelled. Duplicate it to prepare a new one." : "A campaign that has started can't be changed. Pause or cancel it, then duplicate it to send a changed version.");
    }
    const name = input.name !== undefined ? cleanName(input.name) : c.name;
    if (!name || name.length > 120) throw new AppError("invalid_input", "Name the campaign (up to 120 characters).");
    if (input.channel !== undefined && !isChannel(input.channel)) throw new AppError("invalid_input", "Choose the channel it sends on.");
    const channel: Channel = (input.channel as Channel | undefined) ?? c.channel;
    // A list the campaign already uses stays (even a teammate's private list); a newly chosen one must be one this person may use.
    const listId = input.smartListId === undefined || input.smartListId === c.smart_list_id ? c.smart_list_id : input.smartListId ? await usableList(db, actor, input.smartListId) : null;
    let templateId = c.template_id;
    let version = c.template_version;
    if (input.templateId !== undefined) {
      const tpl = input.templateId ? await chosenTemplate(db, actor.orgId, input.templateId, channel) : null;
      templateId = tpl?.id ?? null;
      version = tpl?.version ?? null;
    } else if (channel !== c.channel) {
      // A template is written for one channel: changing the channel clears it.
      templateId = null;
      version = null;
    }
    const scheduledAt = input.schedule !== undefined ? parseSchedule(input.schedule, actor.timezone) : c.scheduled_at;
    const rate = cleanRate(input.ratePerMinute, c.rate_per_minute);
    const covered =
      channel !== c.channel || listId !== c.smart_list_id || templateId !== c.template_id || version !== c.template_version || rate !== c.rate_per_minute ||
      iso(scheduledAt) !== iso(c.scheduled_at);
    let withdrawn = false;
    if (covered && c.status !== "draft") {
      withdrawn = await voidApproval(db, c, `${actor.label} changed the campaign after approval was requested, so this approval no longer applies.`, actor.userId);
    }
    await db.query(
      `update crm_campaigns set name = $3, channel = $4, smart_list_id = $5, template_id = $6, template_version = $7, scheduled_at = $8, rate_per_minute = $9,
         status = case when $10::boolean then 'draft' else status end, approved_hash = case when $10::boolean then null else approved_hash end
       where id = $1 and org_id = $2`,
      [c.id, actor.orgId, name, channel, listId, templateId, version, scheduledAt, rate, covered && c.status !== "draft"],
    );
    if (covered) await setNotice(db, c, withdrawn ? notice("approval_void", `Changed by ${actor.label} after approval was requested, so it needs approving again.`) : null, { waitUntil: null });
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.campaign_updated", targetType: "crm_campaign", targetId: c.id, result: "success", metadata: { approvalWithdrawn: withdrawn, covered } }, db);
    return { approvalWithdrawn: withdrawn };
  });
}

export async function duplicateCampaign(actor: CrmActor, id: string): Promise<{ id: string }> {
  assertCanPrepare(actor);
  const src = await crmRead(actor, async (db) => one((await db.query<CampaignRow>(`select ${CAMPAIGN_COLUMNS} from crm_campaigns where id = $1 and org_id = $2`, [id, actor.orgId])).rows));
  if (!src) throw notFound();
  return crmWrite(actor, async (db) => {
    // The copy starts as a fresh draft with the template's approved version now; the list is kept only if this person may use it.
    const list = src.smart_list_id ? await loadAudienceList(db, actor.orgId, src.smart_list_id) : null;
    const keepList = list && !list.archived && !list.filterError && (list.visibility === "team" || list.ownerUserId === actor.userId) ? list.id : null;
    const t = src.template_id ? await loadCampaignTemplate(db, actor.orgId, src.template_id) : null;
    const keepTemplate = t && t.kind === "template" && t.status !== "archived" && t.channel === src.channel ? t : null;
    const { rows } = await db.query<{ id: string }>(
      `insert into crm_campaigns (org_id, name, channel, smart_list_id, template_id, template_version, rate_per_minute, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [actor.orgId, `Copy of ${src.name}`.slice(0, 120), src.channel, keepList, keepTemplate?.id ?? null, keepTemplate ? keepTemplate.approvedVersion ?? keepTemplate.currentVersion : null, src.rate_per_minute, actor.userId],
    );
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.campaign_created", targetType: "crm_campaign", targetId: rows[0].id, result: "success", metadata: { channel: src.channel, copiedFrom: src.id } }, db);
    return { id: rows[0].id };
  });
}

// ---------------------------------------------------------------------------
// Preview: who it reaches, who is left out, what it costs
// ---------------------------------------------------------------------------

export interface DraftShape {
  channel: Channel;
  smartListId: string | null;
  templateId: string | null;
  templateVersion: number | null;
  scheduledAt: Date | null;
  ratePerMinute: number;
}

interface Assessment {
  problems: string[];
  warnings: string[];
  listName: string | null;
  audience: AudienceSummary | null;
  templateName: string | null;
  version: number | null;
  sample: { subject: string | null; body: string } | null;
  raw: { subject: string | null; body: string } | null;
  whatsappTemplate: { name: string; status: string } | null;
  estimate: CampaignEstimate | null;
  credits: CreditCheck | null;
  policy: SendingPolicy;
  binding: ApprovalBinding | null;
  hash: string | null;
  /** The workspace's configuration values (labels for explaining a change). */
  customValues: CustomValueTokenDef[];
}

/** Everything that decides whether this draft can be approved and what it would do, computed from native data now. */
async function assess(db: Queryable, orgId: string, timezone: string, d: DraftShape, now = new Date()): Promise<Assessment> {
  const problems: string[] = [];
  const warnings: string[] = [];
  try {
    await assertNativeOwner(db, orgId, "contacts");
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    problems.push(`Campaigns send to your iAcquire CRM contacts. ${err.message}`);
  }
  const channel = await channelProblems(db, orgId, d.channel);
  problems.push(...channel.problems);

  const list = await loadAudienceList(db, orgId, d.smartListId);
  if (!d.smartListId) problems.push("Choose the Smart List this campaign goes to.");
  else if (!list || list.archived) problems.push("The chosen Smart List no longer exists. Choose another.");
  else if (list.filterError) problems.push(list.filterError);

  const t = await loadCampaignTemplate(db, orgId, d.templateId, d.templateVersion);
  const tp = await templateProblems(db, orgId, t, d.channel);
  problems.push(...tp.problems);
  const mp = t?.version ? await messageProblems(db, orgId, t) : { problems: [], segments: 1, sample: null };
  problems.push(...mp.problems);

  let audience: AudienceSummary | null = null;
  if (list?.filter && !list.archived && !list.filterError) {
    audience = await summarizeAudience(db, orgId, timezone, list.filter, d.channel, t?.version?.tokens ?? []);
    if (audience.total > MAX_RECIPIENTS) problems.push(`This list has ${audience.total.toLocaleString("en-US")} people; one campaign goes to at most ${MAX_RECIPIENTS.toLocaleString("en-US")}. Narrow the list.`);
    else if (audience.eligible === 0) warnings.push("Nobody on this list can receive it right now: see who is left out and why. Consent is checked again when it sends.");
  }

  const estimate = audience ? await estimateCost(db, d.channel, channel.provider, audience.eligible, mp.segments) : null;
  if (estimate && !estimate.rate) problems.push(`iAcquire hasn't published a price for ${estimate.unitLabel.toLowerCase()} through ${estimate.providerLabel} yet, so this campaign can't be priced or sent.`);
  const credits = estimate ? await checkCredits(db, orgId, estimate.costMicros) : null;
  if (credits?.status === "short") warnings.push("There aren't enough service credits for everyone it would reach right now. It stops when credits run out; add credits first.");
  if (credits?.status === "over_budget") warnings.push("Sending to everyone would pass this workspace's monthly spending limit, so it would stop partway. Raise the limit or send to fewer people.");

  if (d.scheduledAt) {
    const at = new Date(d.scheduledAt).getTime();
    if (at < now.getTime() - SCHEDULE_GRACE_MS) problems.push("The scheduled time has passed. Choose a new time or send it as soon as it's approved.");
    else if (at > now.getTime() + MAX_SCHEDULE_AHEAD_MS) problems.push("Campaigns can be scheduled up to a year ahead.");
  }

  const policy = await sendingPolicy(db, orgId);
  // The business details and configuration values the wording uses are approved with it: a different value later voids the approval.
  const values = t?.version ? await businessValuesNow(db, orgId, t.version) : null;
  const binding: ApprovalBinding | null = list?.filter && t?.version && values && d.smartListId && d.templateId && d.templateVersion
    ? {
        channel: d.channel, smartListId: d.smartListId, filter: list.filter, templateId: d.templateId, templateVersion: d.templateVersion, templateContentHash: t.version.contentHash,
        whatsappTemplateId: d.channel === "whatsapp" ? t.whatsappTemplateId : null, scheduledAt: d.scheduledAt ? new Date(d.scheduledAt).toISOString() : null, ratePerMinute: d.ratePerMinute,
        businessValues: values.values,
      }
    : null;
  return {
    problems: [...new Set(problems)], warnings, listName: list?.name ?? null, audience, templateName: t?.name ?? null, version: t?.version?.number ?? null,
    sample: mp.sample, raw: t?.version ? { subject: t.version.subject, body: t.version.body } : null,
    whatsappTemplate: tp.whatsapp ? { name: tp.whatsapp.name, status: tp.whatsapp.status } : null,
    estimate, credits, policy, binding, hash: binding ? campaignApprovalHash(binding) : null, customValues: values?.customValues ?? [],
  };
}

const shapeOf = (c: CampaignRow): DraftShape => ({
  channel: c.channel, smartListId: c.smart_list_id, templateId: c.template_id, templateVersion: c.template_version, scheduledAt: c.scheduled_at, ratePerMinute: c.rate_per_minute,
});

export interface CampaignPreview {
  ready: boolean;
  problems: string[];
  warnings: string[];
  list: { name: string; total: number } | null;
  eligible: number | null;
  /** Counts only, by reason; never who. */
  exclusions: Array<{ reason: ExclusionReason; count: number }>;
  message: { templateName: string; version: number; subject: string | null; body: string; sampleSubject: string | null; sampleBody: string; whatsappTemplate: { name: string; status: string } | null } | null;
  estimate: CampaignEstimate | null;
  /** Amounts are shown only to people who can see usage; others see whether it is covered. */
  credits: { status: CreditCheck["status"]; availableMicros: number | null; shortByMicros: number | null; budgetLimitMicros: number | null } | null;
  policy: SendingPolicy;
  schedule: { at: string | null; label: string };
  /** The fingerprint an approval would cover; null until it is complete. */
  fingerprint: string | null;
  computedAt: string;
}

function toPreview(a: Assessment, d: DraftShape, actor: CrmActor, now: Date): CampaignPreview {
  const amounts = actor.can("usage.view");
  return {
    ready: a.problems.length === 0 && a.hash !== null,
    problems: a.problems, warnings: a.warnings,
    list: a.listName !== null && a.audience ? { name: a.listName, total: a.audience.total } : null,
    eligible: a.audience?.eligible ?? null,
    exclusions: a.audience ? (Object.entries(a.audience.excluded) as Array<[ExclusionReason, number]>).filter(([, n]) => n > 0).map(([reason, count]) => ({ reason, count })).sort((x, y) => y.count - x.count) : [],
    message: a.raw && a.templateName && a.version ? {
      templateName: a.templateName, version: a.version, subject: a.raw.subject, body: a.raw.body, sampleSubject: a.sample?.subject ?? null, sampleBody: a.sample?.body ?? a.raw.body, whatsappTemplate: a.whatsappTemplate,
    } : null,
    estimate: a.estimate,
    credits: a.credits ? {
      status: a.credits.status, availableMicros: amounts ? a.credits.availableMicros : null, shortByMicros: amounts ? a.credits.shortByMicros : null, budgetLimitMicros: amounts ? a.credits.budget?.limitMicros ?? null : null,
    } : null,
    policy: a.policy,
    schedule: { at: iso(d.scheduledAt), label: d.scheduledAt ? formatDateTime(d.scheduledAt, actor.timezone) : "As soon as the owner approves it" },
    fingerprint: a.hash,
    computedAt: now.toISOString(),
  };
}

/**
 * The live preview for the builder: either a saved campaign, or the unsaved form (its fields checked here the same way saving checks them).
 * Counts are of the whole workspace's list, read with trusted access after the permission check, and are counts only.
 */
export async function previewCampaign(actor: CrmActor, input: { campaignId?: string; draft?: CampaignInput }): Promise<CampaignPreview> {
  assertCanView(actor);
  const now = new Date();
  return withSystem(async (db) => {
    let d: DraftShape;
    if (input.campaignId) {
      if (!UUID_RE.test(input.campaignId)) throw notFound();
      const c = one((await db.query<CampaignRow>(`select ${CAMPAIGN_COLUMNS} from crm_campaigns where id = $1 and org_id = $2`, [input.campaignId, actor.orgId])).rows);
      if (!c) throw notFound();
      d = shapeOf(c);
    } else {
      const f = input.draft ?? {};
      if (!isChannel(f.channel)) throw new AppError("invalid_input", "Choose the channel it sends on.");
      let templateVersion: number | null = null;
      if (f.templateId) {
        const t = UUID_RE.test(f.templateId) ? await loadCampaignTemplate(db, actor.orgId, f.templateId) : null;
        templateVersion = t ? t.approvedVersion ?? t.currentVersion : null;
      }
      // The form is checked the way saving checks it; a problem with a field is shown with the rest, and nothing can be approved from it.
      const formProblems: string[] = [];
      let scheduledAt: Date | null = null;
      try {
        scheduledAt = parseSchedule(f.schedule, actor.timezone, now);
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        formProblems.push(err.message);
      }
      let rate = DEFAULT_RATE_PER_MINUTE;
      try {
        rate = cleanRate(f.ratePerMinute, DEFAULT_RATE_PER_MINUTE);
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        formProblems.push(err.message);
      }
      d = { channel: f.channel, smartListId: f.smartListId && UUID_RE.test(f.smartListId) ? f.smartListId : null, templateId: f.templateId && UUID_RE.test(f.templateId) ? f.templateId : null, templateVersion, scheduledAt, ratePerMinute: rate };
      if (formProblems.length) {
        const a = await assess(db, actor.orgId, actor.timezone, d, now);
        a.problems.unshift(...formProblems);
        a.hash = null;
        return toPreview(a, d, actor, now);
      }
    }
    return toPreview(await assess(db, actor.orgId, actor.timezone, d, now), d, actor, now);
  });
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

export interface ApprovalRequestResult {
  status: "requested" | "pending";
  approvalId: string;
}

function storedEstimate(a: Assessment, now: Date): StoredEstimate {
  return {
    at: now.toISOString(), total: a.audience?.total ?? 0, eligible: a.audience?.eligible ?? 0, excluded: a.audience?.excluded ?? {}, unitsPerMessage: a.estimate?.unitsPerMessage ?? 1,
    costMicros: a.estimate?.costMicros ?? null, provider: a.estimate?.provider ?? "", rateVersion: a.estimate?.rate?.version ?? null,
  };
}

/**
 * Asks the workspace owner to approve sending exactly what the person was shown (`fingerprint`). Nothing is requested when anything stops
 * the campaign, or when what would be sent has changed since the preview. The owner decides on the campaign or in the Approval Center.
 */
export async function requestCampaignApproval(actor: CrmActor, id: string, input: { fingerprint: string }): Promise<ApprovalRequestResult> {
  assertCanPrepare(actor);
  if (!/^[0-9a-f]{64}$/.test(input.fingerprint ?? "")) throw new AppError("invalid_input", "Open the preview first: the request covers exactly what it shows.");
  const now = new Date();
  return withSystem(async (db) => {
    const c = await lockOwn(db, actor, id);
    if (c.status !== "draft" && c.status !== "awaiting_approval") throw new AppError("conflict", c.status === "cancelled" ? "This campaign was cancelled." : "This campaign is already approved.");
    if (c.status === "awaiting_approval" && c.approval_id) {
      const a = one((await db.query<{ status: string; expires_at: Date | null }>("select status, expires_at from approval_requests where id = $1 and org_id = $2", [c.approval_id, actor.orgId])).rows);
      if (a && approvalStateOf(a, c) === "pending") return { status: "pending" as const, approvalId: c.approval_id };
    }
    const a = await assess(db, actor.orgId, actor.timezone, shapeOf(c), now);
    if (a.problems.length || !a.binding || !a.hash) throw new AppError("invalid_input", `It can't go for approval yet: ${a.problems[0] ?? "choose a Smart List and an approved message."}`);
    if (a.hash !== input.fingerprint) throw new AppError("conflict", "Something it would send changed since you looked (the list's filter or the message). Review the preview again, then request approval.");
    const prior = Number(one((await db.query<{ n: string }>("select count(*)::text as n from approval_requests where org_id = $1 and target_type = 'crm_campaign' and target_id = $2", [actor.orgId, c.id])).rows).n);
    const channelLabel = CHANNEL_LABELS[c.channel];
    const when = c.scheduled_at ? `starting ${formatDateTime(c.scheduled_at, actor.timezone)}` : "as soon as it is approved";
    const cost = a.estimate?.costMicros !== null && a.estimate?.costMicros !== undefined ? `about ${formatUsd(a.estimate.costMicros)} at the published rate` : "no published price";
    const approvalId = await createApproval(db, {
      orgId: actor.orgId, requestedBy: actor.userId, kind: "campaign_activation", risk: "high", actorKind: "user",
      title: `Send campaign “${c.name}” by ${channelLabel}`.slice(0, 200),
      action: {
        campaignId: c.id, hash: a.hash, binding: a.binding,
        summary: { list: a.listName, onList: a.audience?.total ?? 0, eligibleNow: a.audience?.eligible ?? 0, template: a.templateName, version: a.version, channel: c.channel, scheduledAt: iso(c.scheduled_at), ratePerMinute: c.rate_per_minute, costMicros: a.estimate?.costMicros ?? null },
      },
      targetType: "crm_campaign", targetId: c.id, targetLabel: c.name,
      reason: `${actor.label} prepared this campaign and asked for the owner's approval to send it.`,
      expectedEffect: [
        `Sends “${a.templateName}” (version ${a.version}) by ${channelLabel} to people on the Smart List “${a.listName}” who agreed to receive marketing on ${channelLabel}: ${(a.audience?.eligible ?? 0).toLocaleString("en-US")} of ${(a.audience?.total ?? 0).toLocaleString("en-US")} right now,`,
        `${when}, at most ${c.rate_per_minute} a minute (${cost}).`,
        "Consent, opt-outs, quiet hours, business hours, the frequency limit and credits are checked again for each person when it sends. Any change to the list's filter, the message, the business details or configuration values it uses, the schedule or the pace voids this approval.",
      ].join(" ").slice(0, 2000),
      idempotencyKey: `campaign-activation:${c.id}:${prior + 1}`,
    });
    if (!approvalId) throw new AppError("conflict", "An approval was just requested for this campaign. Reload to see it.");
    await db.query("update crm_campaigns set status = 'awaiting_approval', approval_id = $3, approved_hash = null, estimate = $4::jsonb where id = $1 and org_id = $2", [
      c.id, actor.orgId, approvalId, JSON.stringify(storedEstimate(a, now)),
    ]);
    await setNotice(db, c, null, { waitUntil: null });
    // The owner who requests it approves it straight away (the action does), so only a request from someone else notifies them.
    if (!actor.can("campaigns.send")) {
      await notifyOrgRoles(db, actor.orgId, ["owner"], {
        kind: "approval_requested", severity: "info", title: `Campaign “${c.name.slice(0, 80)}” needs your approval`,
        body: `${(a.audience?.eligible ?? 0).toLocaleString("en-US")} people by ${channelLabel}, ${when}.`, link: `/crm/campaigns/${c.id}`, dedupeKey: `campaign-approval:${approvalId}`,
      });
    }
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.campaign_approval_requested", targetType: "crm_campaign", targetId: c.id, approvalId, result: "success", metadata: { hash: a.hash, eligible: a.audience?.eligible ?? 0 } }, db);
    return { status: "requested" as const, approvalId };
  });
}

/**
 * The pending approval an owner is about to decide on the campaign itself, after checking it still covers what they were shown. The decision
 * is then made through the Approval Center's own decideApproval, so both places record and execute it the same way.
 */
export async function pendingApprovalFor(actor: CrmActor, id: string, fingerprint: string | null): Promise<string> {
  assertCan(actor, "campaigns.send", "Only the workspace owner approves sending a campaign.");
  if (actor.kind !== "member" || !actor.userId) throw new AppError("forbidden", "Only the workspace owner approves sending a campaign.");
  return withSystem(async (db) => {
    const c = await lockOwn(db, actor, id);
    if (c.status !== "awaiting_approval" || !c.approval_id) throw new AppError("conflict", "This campaign isn't waiting for approval.");
    const a = one((await db.query<{ status: string; expires_at: Date | null; action: Record<string, unknown> }>("select status, expires_at, action from approval_requests where id = $1 and org_id = $2", [c.approval_id, actor.orgId])).rows);
    const state = approvalStateOf(a, c);
    if (state === "expired") throw new AppError("conflict", "The approval request expired. Request approval again.");
    if (state !== "pending") throw new AppError("conflict", "This approval was already decided.");
    if (fingerprint !== null) {
      const cur = await currentBinding(db, c);
      if (a!.action.hash !== fingerprint || cur.hash !== fingerprint) throw new AppError("conflict", "What this campaign would send changed since you looked. Review it again before approving.");
    }
    return c.approval_id;
  });
}

export type ActivationOutcome = { status: "succeeded" | "failed" | "blocked"; detail: string };

/**
 * Runs when the owner approves a campaign_activation (src/server/approvals/service.ts). Re-checks everything against what the request covered:
 * the person deciding must be the owner, the campaign must still be waiting for this approval with the same fingerprint, and nothing may
 * stop it. Then it is scheduled. Anything else puts it back to draft with the reason and withdraws the approval: nothing is sent.
 */
export async function executeCampaignActivation(orgId: string, approvalId: string, action: Record<string, unknown>, actorUserId: string): Promise<ActivationOutcome> {
  const campaignId = typeof action.campaignId === "string" && UUID_RE.test(action.campaignId) ? action.campaignId : null;
  if (!campaignId) return { status: "failed", detail: "This approval doesn't name a campaign, so nothing will be sent." };
  const now = new Date();
  return withSystem(async (db): Promise<ActivationOutcome> => {
    const c = one((await db.query<CampaignRow>(`select ${CAMPAIGN_COLUMNS} from crm_campaigns where id = $1 and org_id = $2 for update`, [campaignId, orgId])).rows);
    if (!c) return { status: "blocked", detail: "The campaign no longer exists, so nothing will be sent." };
    if (c.approval_id !== approvalId || c.status !== "awaiting_approval") return { status: "blocked", detail: "The campaign was changed or cancelled after approval was requested, so nothing will be sent." };
    const back = async (detail: string) => {
      await returnToDraft(db, c, notice("approval_void", detail, now), actorUserId);
      await recordAudit({ orgId, actorUserId, actorKind: "user", action: "crm.campaign_approval_void", targetType: "crm_campaign", targetId: c.id, approvalId, result: "failure", metadata: { detail: detail.slice(0, 200) } }, db);
      return { status: "blocked" as const, detail };
    };
    const role = one((await db.query<{ role: string }>("select role from organization_memberships where org_id = $1 and user_id = $2 and status = 'active'", [orgId, actorUserId])).rows)?.role;
    if (role !== "owner") return back("Only the workspace owner can approve sending a campaign, so it went back to draft and nothing will be sent.");
    const org = one((await db.query<{ timezone: string }>("select timezone from organizations where id = $1", [orgId])).rows);
    const a = await assess(db, orgId, org?.timezone ?? "UTC", shapeOf(c), now);
    if (!a.hash || a.hash !== action.hash) {
      const changed = a.binding ? bindingChanges(readBinding(action.binding), a.binding, a.customValues) : ["the message"];
      return back(`${changed.join(", ").replace(/^./, (s) => s.toUpperCase())} changed after approval was requested, so it went back to draft and nothing will be sent. Review it and request approval again.`);
    }
    if (a.problems.length) return back(`It can't be sent: ${a.problems[0]} It went back to draft and nothing will be sent.`);
    await db.query("update crm_campaigns set status = 'scheduled', approved_hash = $3, estimate = $4::jsonb where id = $1 and org_id = $2", [c.id, orgId, a.hash, JSON.stringify(storedEstimate(a, now))]);
    await setNotice(db, c, null, { waitUntil: null });
    // Approved: it stands for as long as nothing it covers changes (the scheduler checks the fingerprint again when it starts).
    await db.query("update approval_requests set expires_at = null where id = $1 and org_id = $2 and status = 'approved'", [approvalId, orgId]);
    await recordAudit({ orgId, actorUserId, actorKind: "user", action: "crm.campaign_approved", targetType: "crm_campaign", targetId: c.id, approvalId, result: "success", metadata: { hash: a.hash, eligible: a.audience?.eligible ?? 0, scheduledAt: iso(c.scheduled_at) } }, db);
    const when = c.scheduled_at ? `It starts ${formatDateTime(c.scheduled_at, org?.timezone ?? "UTC")}` : "It starts within a minute";
    return { status: "succeeded", detail: `Approved. ${when}, at most ${c.rate_per_minute} messages a minute. Consent, opt-outs, quiet hours, the frequency limit and credits are checked for each person when it sends.` };
  });
}

/** Runs when the owner rejects or sends back a campaign_activation: the campaign goes back to draft with the owner's note. */
export async function releaseRejectedCampaignApproval(orgId: string, approvalId: string, action: Record<string, unknown>, actorUserId: string, note?: string | null): Promise<void> {
  const campaignId = typeof action.campaignId === "string" && UUID_RE.test(action.campaignId) ? action.campaignId : null;
  if (!campaignId) return;
  await withSystem(async (db) => {
    const c = one((await db.query<CampaignRow>(`select ${CAMPAIGN_COLUMNS} from crm_campaigns where id = $1 and org_id = $2 and approval_id = $3 and status = 'awaiting_approval' for update`, [campaignId, orgId, approvalId])).rows);
    if (!c) return;
    await db.query("update crm_campaigns set status = 'draft', approved_hash = null where id = $1 and org_id = $2", [c.id, orgId]);
    await setNotice(db, c, notice("returned", note ? `The owner sent it back: “${note.slice(0, 300)}”` : "The owner didn't approve it. Change it and request approval again."), { waitUntil: null });
    await recordAudit({ orgId, actorUserId, actorKind: "user", action: "crm.campaign_approval_declined", targetType: "crm_campaign", targetId: c.id, approvalId, result: "success" }, db);
  });
}

// ---------------------------------------------------------------------------
// Pause, resume, cancel
// ---------------------------------------------------------------------------

/** Stops queuing at once and holds what it queued and hasn't sent. Messages a provider already took can't be recalled. */
export async function pauseCampaign(actor: CrmActor, id: string): Promise<{ held: number }> {
  assertCanPrepare(actor);
  return crmWrite(actor, async (db) => {
    const c = await lockOwn(db, actor, id);
    if (c.status !== "scheduled" && c.status !== "sending") throw new AppError("conflict", c.status === "paused" ? "It's already paused." : "Only a scheduled or sending campaign can be paused.");
    await db.query("update crm_campaigns set status = 'paused' where id = $1 and org_id = $2", [c.id, actor.orgId]);
    const held = await holdQueuedMessages(db, c);
    await setNotice(db, c, notice("paused", `Paused by ${actor.label}.${held ? ` ${held.toLocaleString("en-US")} queued ${held === 1 ? "message is" : "messages are"} held.` : ""}`), { waitUntil: null });
    await refreshCounts(db, c);
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.campaign_paused", targetType: "crm_campaign", targetId: c.id, result: "success", metadata: { held } }, db);
    return { held };
  });
}

/**
 * Continues a paused campaign: the owner's decision, since it sends to people. The approval must still stand; a campaign that hasn't started
 * is checked against its fingerprint again, and one that has must still be sending the approved wording. Held messages are released and
 * are checked against every send rule again before they leave.
 */
export async function resumeCampaign(actor: CrmActor, id: string): Promise<{ status: "scheduled" | "sending"; released: number }> {
  assertCan(actor, "campaigns.send", "Resuming a campaign sends it to people, so only the workspace owner can do it.");
  if (actor.kind !== "member" || !actor.userId) throw new AppError("forbidden", "Only the workspace owner can resume a campaign.");
  const now = new Date();
  return crmWrite(actor, async (db) => {
    const c = await lockOwn(db, actor, id);
    if (c.status !== "paused") throw new AppError("conflict", "Only a paused campaign can be resumed.");
    const approval = c.approval_id ? one((await db.query<{ status: string; action: Record<string, unknown> }>("select status, action from approval_requests where id = $1 and org_id = $2", [c.approval_id, actor.orgId])).rows) : undefined;
    if (!approval || approval.status !== "approved" || !c.approved_hash) throw new AppError("conflict", "The approval of this campaign no longer stands. Cancel it and duplicate it to prepare it again.");
    const cur = await currentBinding(db, c);
    if (!c.started_at) {
      if (cur.hash !== c.approved_hash) {
        const changed = cur.binding ? bindingChanges(readBinding(approval.action.binding), cur.binding, cur.customValues) : ["the message"];
        await returnToDraft(db, c, notice("approval_void", `${changed.join(", ").replace(/^./, (s) => s.toUpperCase())} changed after it was approved, so it went back to draft. Review it and request approval again.`, now), actor.userId);
        await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.campaign_approval_void", targetType: "crm_campaign", targetId: c.id, result: "failure" }, db);
        return { status: "scheduled" as const, released: -1, why: null };
      }
    }
    const approved = readBinding(approval.action.binding);
    if (!cur.template || !approved?.templateContentHash || !wordingStillApproved(cur.template, approved.templateContentHash, approved.whatsappTemplateId ?? null)) {
      throw new AppError("conflict", "The message template was edited or is no longer approved, so this campaign's approved wording no longer stands. Cancel it and duplicate it to send the new wording after approval.");
    }
    // A started campaign sends the rest of its list with exactly the values the owner approved; a different one withdraws the approval.
    const drift = cur.binding ? valuesChangedSinceApproval(approved.businessValues, cur.binding.businessValues, cur.customValues) : null;
    if (drift) {
      await voidApproval(db, c, drift, actor.userId);
      await setNotice(db, c, notice("approval_void", drift, now), { waitUntil: null });
      await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.campaign_approval_void", targetType: "crm_campaign", targetId: c.id, result: "failure" }, db);
      return { status: "sending" as const, released: -1, why: drift };
    }
    const tp = await templateProblems(db, actor.orgId, cur.template, c.channel);
    if (tp.problems.length) throw new AppError("conflict", tp.problems[0]);
    const ch = await channelProblems(db, actor.orgId, c.channel);
    if (ch.problems.length) throw new AppError("conflict", ch.problems[0]);
    const next: "scheduled" | "sending" = c.started_at ? "sending" : "scheduled";
    await db.query("update crm_campaigns set status = $3 where id = $1 and org_id = $2", [c.id, actor.orgId, next]);
    const released = await releaseHeldMessages(db, c, now);
    await setNotice(db, c, null, { waitUntil: null });
    await refreshCounts(db, c);
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.campaign_resumed", targetType: "crm_campaign", targetId: c.id, approvalId: c.approval_id, result: "success", metadata: { released } }, db);
    return { status: next, released, why: null };
  }).then((r) => {
    if (r.released === -1) throw new AppError("conflict", r.why ?? "What this campaign would send changed after it was approved, so it went back to draft. Review it and request approval again.");
    return { status: r.status, released: r.released };
  });
}

/** Ends a campaign for good: nobody else is queued, what it queued and hasn't sent is stopped, and a pending or given approval is withdrawn. */
export async function cancelCampaign(actor: CrmActor, id: string): Promise<{ stopped: number }> {
  assertCanPrepare(actor);
  return crmWrite(actor, async (db) => {
    const c = await lockOwn(db, actor, id);
    if (c.status === "completed" || c.status === "cancelled") throw new AppError("conflict", c.status === "completed" ? "This campaign already finished." : "It's already cancelled.");
    await voidApproval(db, c, `Cancelled by ${actor.label}.`, actor.userId);
    await db.query("update crm_campaigns set status = 'cancelled', cancelled_by = $3, completed_at = case when started_at is not null then now() else completed_at end where id = $1 and org_id = $2", [c.id, actor.orgId, actor.userId]);
    await db.query("update crm_campaign_recipients set status = 'excluded', reason = 'campaign_cancelled', updated_at = now() where campaign_id = $1 and org_id = $2 and status = 'pending'", [c.id, actor.orgId]);
    const stopped = await blockQueuedMessages(db, c);
    await db.query("update crm_campaign_recipients set status = 'excluded', reason = 'campaign_cancelled', updated_at = now() where campaign_id = $1 and org_id = $2 and status = 'queued' and message_id in (select id from conversation_messages where org_id = $2 and blocked_reason = 'campaign_cancelled')", [c.id, actor.orgId]);
    await setNotice(db, c, null, { waitUntil: null });
    await refreshCounts(db, c);
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.campaign_cancelled", targetType: "crm_campaign", targetId: c.id, result: "success", metadata: { stopped, wasStatus: c.status } }, db);
    return { stopped };
  });
}

// ---------------------------------------------------------------------------
// Builder options
// ---------------------------------------------------------------------------

export interface BuilderOptions {
  lists: Array<{ id: string; name: string; visibility: "private" | "team"; mine: boolean; ownerName: string | null; filter: unknown; problem: string | null }>;
  templates: Array<{ id: string; name: string; channel: Channel; purpose: "service" | "marketing"; status: "draft" | "approved" | "archived"; approvedVersion: number | null; currentVersion: number; problem: string | null }>;
  channels: Record<Channel, { provider: string; problem: string | null }>;
  policy: SendingPolicy;
}

/** What the builder offers: contact Smart Lists the person may use, templates per channel (with why one can't be used), and each channel's state. */
export async function campaignBuilderOptions(actor: CrmActor): Promise<BuilderOptions> {
  assertCanView(actor);
  return withSystem(async (db) => {
    const lists = (await db.query<{ id: string; name: string; visibility: "private" | "team"; owner_user_id: string; owner_name: string | null; filter: unknown }>(
      `select l.id, l.name, l.visibility, l.owner_user_id, nullif(u.full_name, '') as owner_name, l.filter from crm_smart_lists l left join users u on u.id = l.owner_user_id
       where l.org_id = $1 and l.entity = 'contact' and l.archived_at is null and (l.visibility = 'team' or l.owner_user_id = $2) order by lower(l.name) limit 300`,
      [actor.orgId, actor.userId],
    )).rows;
    const outLists: BuilderOptions["lists"] = lists.map((l) => {
      const f = readListFilter(l.filter);
      return { id: l.id, name: l.name, visibility: l.visibility, mine: l.owner_user_id === actor.userId, ownerName: l.owner_name, filter: f.filter, problem: f.filterError };
    });
    const templates = (await db.query<{ id: string; name: string; channel: Channel; purpose: "service" | "marketing"; status: "draft" | "approved" | "archived"; approved_version: number | null; current_version: number }>(
      "select id, name, channel, purpose, status, approved_version, current_version from crm_message_templates where org_id = $1 and kind = 'template' and archived_at is null and channel is not null order by lower(name) limit 500",
      [actor.orgId],
    )).rows;
    const channels = {} as BuilderOptions["channels"];
    for (const ch of ["email", "sms", "whatsapp"] as const) {
      const p = await channelProblems(db, actor.orgId, ch);
      channels[ch] = { provider: p.provider, problem: p.problems[0] ?? null };
    }
    return {
      lists: outLists,
      templates: templates.map((t) => ({
        id: t.id, name: t.name, channel: t.channel, purpose: t.purpose, status: t.status, approvedVersion: t.approved_version, currentVersion: t.current_version,
        problem: t.status !== "approved" ? "Not approved yet" : t.purpose !== "marketing" ? "A service template" : null,
      })),
      channels,
      policy: await sendingPolicy(db, actor.orgId),
    };
  });
}

/** The campaign's template id and version for a test send, when the template still sends exactly that version. */
export async function testableTemplate(actor: CrmActor, id: string): Promise<{ templateId: string; channel: Channel }> {
  assertCanView(actor);
  return withSystem(async (db) => {
    if (!UUID_RE.test(id)) throw notFound();
    const c = one((await db.query<CampaignRow>(`select ${CAMPAIGN_COLUMNS} from crm_campaigns where id = $1 and org_id = $2`, [id, actor.orgId])).rows);
    if (!c) throw notFound();
    if (!c.template_id || !c.template_version) throw new AppError("invalid_input", "Choose the message first.");
    const t = await loadCampaignTemplate(db, actor.orgId, c.template_id, c.template_version);
    if (!t || t.status === "archived") throw new AppError("conflict", "The campaign's template no longer exists.");
    // A test sends the template's current wording: it must be the version this campaign sends, or the test would show something else.
    if (t.currentVersion !== c.template_version) throw new AppError("conflict", `The template has a newer version (v${t.currentVersion}) than this campaign sends (v${c.template_version}). Choose the template again, or test it from Templates.`);
    return { templateId: t.id, channel: c.channel };
  });
}
