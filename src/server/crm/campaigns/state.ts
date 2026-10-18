import "server-only";
import type { Queryable } from "@/server/db";
import { recordAudit } from "@/server/audit";
import { notifyOrgRoles } from "@/server/notifications";
import { releaseReservation } from "@/server/billing/ledger";
import { RECIPIENT_STATUSES, iso, type CampaignRow, type RecipientStatus } from "@/server/crm/campaigns/rules";

// Campaign state shared by the service and the sending job: the counts kept on the campaign row, the notice explaining why it stopped or
// went back to draft, withdrawing an approval that no longer matches what would be sent, and holding or releasing the messages a campaign
// queued that have not left yet.

export interface CampaignCounts {
  total: number;
  pending: number;
  /** Pending people the send rules asked to wait (quiet hours, business hours, spacing between messages). */
  waiting: number;
  excluded: number;
  queued: number;
  sent: number;
  delivered: number;
  failed: number;
  bounced: number;
  unsubscribed: number;
  /** Why people were left out, by reason code. */
  reasons: Record<string, number>;
  /** Why sends failed, by reason. */
  failures: Record<string, number>;
}

export type NoticeCode =
  | "paused" | "credits" | "budget" | "channel" | "price" | "template_changed" | "approval_void" | "too_large" | "provider" | "list_unavailable"
  | "returned" | "workspace_paused" | "missing_values";

export interface CampaignNotice {
  code: NoticeCode;
  detail: string;
  at: string;
}

export const EMPTY_COUNTS: CampaignCounts = { total: 0, pending: 0, waiting: 0, excluded: 0, queued: 0, sent: 0, delivered: 0, failed: 0, bounced: 0, unsubscribed: 0, reasons: {}, failures: {} };

/** Messages a paused campaign queued but that have not left wait here (dispatchDue only takes messages that are due). */
export const HELD_UNTIL = new Date("9999-01-01T00:00:00.000Z");

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const tally = (v: unknown): Record<string, number> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) if (k.length <= 120 && num(n) > 0) out[k] = num(n);
  return out;
};

export function readCounts(raw: unknown): CampaignCounts {
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    total: num(o.total), pending: num(o.pending), waiting: num(o.waiting), excluded: num(o.excluded), queued: num(o.queued), sent: num(o.sent), delivered: num(o.delivered),
    failed: num(o.failed), bounced: num(o.bounced), unsubscribed: num(o.unsubscribed), reasons: tally(o.reasons), failures: tally(o.failures),
  };
}

const NOTICE_CODES = new Set<NoticeCode>(["paused", "credits", "budget", "channel", "price", "template_changed", "approval_void", "too_large", "provider", "list_unavailable", "returned", "workspace_paused", "missing_values"]);

export function readNotice(raw: unknown): CampaignNotice | null {
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).notice : null;
  if (typeof o !== "object" || o === null) return null;
  const n = o as Record<string, unknown>;
  if (typeof n.code !== "string" || !NOTICE_CODES.has(n.code as NoticeCode) || typeof n.detail !== "string") return null;
  return { code: n.code as NoticeCode, detail: n.detail.slice(0, 400), at: typeof n.at === "string" ? n.at : new Date(0).toISOString() };
}

const readDate = (raw: unknown, key: string): Date | null => {
  const v = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)[key] : null;
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
export const readWaitUntil = (raw: unknown) => readDate(raw, "waitUntil");
export const readReconciledAt = (raw: unknown) => readDate(raw, "reconciledAt");

/** Recounts the recipients and stores the counts, keeping the notice and the job's bookkeeping unless told otherwise. */
export async function refreshCounts(db: Queryable, c: Pick<CampaignRow, "id" | "org_id" | "counts">, patch: { notice?: CampaignNotice | null; waitUntil?: Date | null; reconciledAt?: Date } = {}): Promise<CampaignCounts> {
  const { rows } = await db.query<{ status: RecipientStatus; waiting: boolean; reason: string | null; n: string }>(
    `select status, (status = 'pending' and coalesce(reason, '') like 'waiting:%') as waiting, case when status in ('excluded', 'failed') then reason end as reason, count(*)::text as n
     from crm_campaign_recipients where campaign_id = $1 and org_id = $2 group by 1, 2, 3`,
    [c.id, c.org_id],
  );
  const counts: CampaignCounts = { ...EMPTY_COUNTS, reasons: {}, failures: {} };
  for (const r of rows) {
    const n = Number(r.n);
    counts.total += n;
    if ((RECIPIENT_STATUSES as readonly string[]).includes(r.status)) counts[r.status] += n;
    if (r.waiting) counts.waiting += n;
    if (r.status === "excluded") counts.reasons[r.reason ?? "unknown"] = (counts.reasons[r.reason ?? "unknown"] ?? 0) + n;
    if (r.status === "failed") counts.failures[r.reason ?? "unknown"] = (counts.failures[r.reason ?? "unknown"] ?? 0) + n;
  }
  // The row is re-read so bookkeeping written earlier in this transaction is kept.
  const cur = (await db.query<{ counts: Record<string, unknown> }>("select counts from crm_campaigns where id = $1 and org_id = $2", [c.id, c.org_id])).rows[0]?.counts ?? c.counts;
  const prev = typeof cur === "object" && cur !== null ? cur : {};
  const next: Record<string, unknown> = { ...counts };
  const n = patch.notice === undefined ? readNotice(prev) : patch.notice;
  if (n) next.notice = n;
  const wait = patch.waitUntil === undefined ? readWaitUntil(prev) : patch.waitUntil;
  if (wait) next.waitUntil = wait.toISOString();
  const reconciled = patch.reconciledAt ?? readReconciledAt(prev);
  if (reconciled) next.reconciledAt = reconciled.toISOString();
  await db.query("update crm_campaigns set counts = $3::jsonb where id = $1 and org_id = $2", [c.id, c.org_id, JSON.stringify(next)]);
  c.counts = next;
  return counts;
}

/** Sets (or clears) the notice without recounting. */
export async function setNotice(db: Queryable, c: Pick<CampaignRow, "id" | "org_id" | "counts">, n: CampaignNotice | null, extra: { waitUntil?: Date | null } = {}) {
  const cur = (await db.query<{ counts: Record<string, unknown> }>("select counts from crm_campaigns where id = $1 and org_id = $2", [c.id, c.org_id])).rows[0]?.counts ?? c.counts;
  const prev = typeof cur === "object" && cur !== null ? { ...cur } : {};
  if (n) prev.notice = n;
  else delete prev.notice;
  if (extra.waitUntil === null) delete prev.waitUntil;
  else if (extra.waitUntil) prev.waitUntil = extra.waitUntil.toISOString();
  await db.query("update crm_campaigns set counts = $3::jsonb where id = $1 and org_id = $2", [c.id, c.org_id, JSON.stringify(prev)]);
  c.counts = prev;
}

export const notice = (code: NoticeCode, detail: string, at = new Date()): CampaignNotice => ({ code, detail: detail.slice(0, 400), at: at.toISOString() });

/**
 * Withdraws the owner's approval of a campaign (or the request for it): what it covered no longer matches what would be sent. The approval
 * record stays for the history, marked cancelled with the reason, and can never be used again.
 */
export async function voidApproval(db: Queryable, c: Pick<CampaignRow, "id" | "org_id" | "approval_id">, why: string, actorUserId: string | null): Promise<boolean> {
  if (!c.approval_id) return false;
  const res = await db.query(
    `update approval_requests set status = 'cancelled', execution_status = case when status = 'approved' then 'blocked' else execution_status end, execution_detail = $3
     where id = $1 and org_id = $2 and status in ('pending', 'approved')`,
    [c.approval_id, c.org_id, why.slice(0, 1000)],
  );
  if (!res.rowCount) return false;
  await db.query("insert into approval_events (approval_id, org_id, actor_user_id, actor_kind, event, note) values ($1, $2, $3, $4, 'cancelled', $5)", [
    c.approval_id, c.org_id, actorUserId, actorUserId ? "user" : "system", why.slice(0, 1000),
  ]);
  return true;
}

/** The campaign's messages that are queued but have not left (or been claimed for sending). */
const QUEUED_OF_CAMPAIGN = `
  from crm_campaign_recipients r where r.campaign_id = $1 and r.org_id = $2 and r.status = 'queued' and r.message_id is not null
    and m.id = r.message_id and m.org_id = r.org_id and m.status = 'queued'`;

/**
 * Holds the messages a campaign queued that have not left yet, and gives back their credit holds. They stay queued (so nothing is sent twice
 * and the dedupe key stays theirs) and are released on resume, when every send rule is checked again before they go.
 */
export async function holdQueuedMessages(db: Queryable, c: Pick<CampaignRow, "id" | "org_id">): Promise<number> {
  const { rows } = await db.query<{ id: string; reservation_id: string | null }>(
    `update conversation_messages m set send_after = $3, status_detail = 'Held: the campaign is paused.' ${QUEUED_OF_CAMPAIGN} returning m.id, m.reservation_id`,
    [c.id, c.org_id, HELD_UNTIL.toISOString()],
  );
  for (const m of rows) {
    if (m.reservation_id) await releaseReservation(db, { orgId: c.org_id, reservationId: m.reservation_id, reason: "Campaign paused" });
  }
  return rows.length;
}

/** Lets held messages go again (on resume). The dispatcher re-checks every rule and takes a fresh credit hold for each. */
export async function releaseHeldMessages(db: Queryable, c: Pick<CampaignRow, "id" | "org_id">, now: Date): Promise<number> {
  const res = await db.query(
    `update conversation_messages m set send_after = $3, status_detail = null ${QUEUED_OF_CAMPAIGN} and m.send_after >= $4`,
    [c.id, c.org_id, now.toISOString(), HELD_UNTIL.toISOString()],
  );
  return res.rowCount;
}

/** Stops the messages a cancelled campaign queued that have not left: they are recorded as not sent and their credit holds released. */
export async function blockQueuedMessages(db: Queryable, c: Pick<CampaignRow, "id" | "org_id">): Promise<number> {
  const { rows } = await db.query<{ id: string; reservation_id: string | null }>(
    `update conversation_messages m set status = 'blocked', blocked_reason = 'campaign_cancelled', status_detail = 'Not sent: the campaign was cancelled.' ${QUEUED_OF_CAMPAIGN}
     returning m.id, m.reservation_id`,
    [c.id, c.org_id],
  );
  for (const m of rows) {
    if (m.reservation_id) await releaseReservation(db, { orgId: c.org_id, reservationId: m.reservation_id, reason: "Campaign cancelled" });
  }
  return rows.length;
}

/**
 * Stops a sending (or scheduled) campaign so nothing more is queued, with the reason shown on it. Owners hear about it: a campaign that
 * stopped by itself (credits, the channel, a changed template) needs a person's decision. `hold` also holds what it queued and hasn't sent
 * (used when the wording or the approval no longer stands; messages already paid for by credit still go when credits ran out).
 */
export async function stopCampaign(db: Queryable, c: CampaignRow, n: CampaignNotice, opts: { notify?: boolean; hold?: boolean } = {}): Promise<void> {
  await db.query("update crm_campaigns set status = 'paused' where id = $1 and org_id = $2 and status in ('scheduled', 'sending')", [c.id, c.org_id]);
  c.status = "paused";
  if (opts.hold) await holdQueuedMessages(db, c);
  await setNotice(db, c, n, { waitUntil: null });
  await recordAudit({ orgId: c.org_id, actorKind: "system", action: "crm.campaign_stopped", targetType: "crm_campaign", targetId: c.id, result: "success", metadata: { code: n.code } }, db);
  if (opts.notify !== false) {
    const kind = n.code === "credits" ? "billing_credits_exhausted" : n.code === "budget" ? "billing_budget_warning" : "message_blocked";
    await notifyOrgRoles(db, c.org_id, ["owner", "admin"], {
      kind, severity: "warning", title: `Campaign “${c.name.slice(0, 80)}” stopped`, body: n.detail, link: `/crm/campaigns/${c.id}`, dedupeKey: `campaign-stopped:${c.id}:${n.code}:${iso(c.started_at) ?? "pre"}:${n.at.slice(0, 13)}`,
    });
  }
}
