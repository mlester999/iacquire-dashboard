import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { recordAudit } from "@/server/audit";
import { AppError } from "@/server/errors";
import { createClientTenant } from "@/server/admin/tenants";
import type { SessionUser } from "@/server/auth/service";
import { demoIndustryLabel } from "@/lib/demo/industries";
import type { DemoEventKind } from "@/lib/demo/events";
import {
  accessOf, canTransition, cleanLine, cleanNote, effectiveStatus, MAX_NOTE_CHARS, MAX_REASON_CHARS, messageAllowance, messagesLeft, MIN_REASON_CHARS, planExtension, reopenTarget,
  windowIsOpen, type AccessState, type ProspectStatus,
} from "@/lib/demo/rules";
import { assertProspectsAccess } from "@/server/demo/access";
import { addEvent, factsOf, lockProspect, loadProspect, PROSPECT_COLUMNS, type ProspectRow } from "@/server/demo/core";
import { eraseProspectInTx, type ErasureCounts } from "@/server/demo/erase";
import { readDemoSettings } from "@/server/demo/settings";
import { usageToday, type DemoUsageDay } from "@/server/demo/usage";

// What the agency does with prospects. Every function starts by asking the database whether this person may (access.ts), reads or locks the prospect, applies the pure rules in
// src/lib/demo/rules.ts, writes the timeline and the audit trail, and returns a value for the screen. A person who may only view cannot change anything, and nobody here can make a
// prospect a user: convertProspect is the one door to a client workspace, it needs a Super Admin who may also create clients, and it calls createClientTenant like any other creation.
//
// Words a team member typed (a note, a reason) are kept on the prospect's timeline, where an erasure removes them. The audit trail holds ids, numbers and fixed words only.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const need = (id: unknown): string => {
  if (typeof id !== "string" || !UUID.test(id)) throw new AppError("not_found", "That prospect was not found.");
  return id;
};

const reasonOf = (raw: unknown): string => {
  const reason = cleanNote(raw, MAX_REASON_CHARS);
  if (reason.length < MIN_REASON_CHARS) throw new AppError("invalid_input", "Say why, in a few words. The reason is kept with the change.");
  if (reason.length > MAX_REASON_CHARS) throw new AppError("invalid_input", `The reason can be up to ${MAX_REASON_CHARS} characters.`);
  return reason;
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface ProspectListRow {
  id: string;
  name: string | null;
  email: string | null;
  business: string | null;
  industry: string | null;
  industryLabel: string | null;
  /** What the prospect is right now, from the clock: a window that has ended reads "expired" before the job says so. */
  status: ProspectStatus;
  access: AccessState;
  createdAt: string;
  verifiedAt: string | null;
  windowEndsAt: string | null;
  messagesUsed: number;
  messageAllowance: number;
  consultationRequestedAt: string | null;
  purchaseStartedAt: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  convertedOrgId: string | null;
  erased: boolean;
  /** The /get-started request of the same address, when there is one. */
  accessRequestId: string | null;
}

export interface ProspectListFilter {
  status?: ProspectStatus | "all";
  /** A user id, or "none" for prospects nobody follows. */
  owner?: string;
  search?: string;
  limit?: number;
  /** The last row of the previous page. */
  after?: { createdAt: string; id: string };
}

const iso = (d: Date | null) => (d === null ? null : new Date(d).toISOString());

function listRow(p: ProspectRow & { owner_name: string | null }, now: Date): ProspectListRow {
  const facts = factsOf(p);
  return {
    id: p.id,
    name: p.name,
    email: p.work_email,
    business: p.business_name,
    industry: p.industry,
    industryLabel: demoIndustryLabel(p.industry),
    status: effectiveStatus(facts, now),
    access: accessOf(facts, now),
    createdAt: new Date(p.created_at).toISOString(),
    verifiedAt: iso(p.verified_at),
    windowEndsAt: iso(p.window_ends_at),
    messagesUsed: p.messages_used,
    messageAllowance: messageAllowance(facts),
    consultationRequestedAt: iso(p.consultation_requested_at),
    purchaseStartedAt: iso(p.purchase_started_at),
    ownerUserId: p.owner_user_id,
    ownerName: p.owner_name,
    convertedOrgId: p.converted_org_id,
    erased: p.erased_at !== null,
    accessRequestId: p.access_request_id,
  };
}

export async function listProspects(user: Pick<SessionUser, "id" | "platformRole">, filter: ProspectListFilter = {}, now = new Date()): Promise<{ rows: ProspectListRow[]; hasMore: boolean }> {
  await assertProspectsAccess(user, "agency.prospects.view");
  const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 50), 1), 100);
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace("?", `$${params.length}`));
  };
  const status = filter.status && filter.status !== "all" ? filter.status : null;
  // An expired window counts as expired in the list even before the job has recorded it (the same reading the rules give everywhere), so the filter follows the clock too.
  if (status === "expired") {
    params.push(now.toISOString());
    where.push(`(p.status = 'expired' or (p.status = 'active' and p.window_ends_at <= $${params.length}::timestamptz))`);
  } else if (status === "active") {
    params.push(now.toISOString());
    where.push(`(p.status = 'active' and p.window_ends_at > $${params.length}::timestamptz)`);
  } else if (status) add("p.status = ?", status);
  if (filter.owner === "none") where.push("p.owner_user_id is null");
  else if (filter.owner && UUID.test(filter.owner)) add("p.owner_user_id = ?::uuid", filter.owner);
  const search = cleanLine(filter.search, 100).toLowerCase();
  if (search) add("position(? in lower(coalesce(p.name, '') || ' ' || coalesce(p.work_email, '') || ' ' || coalesce(p.business_name, ''))) > 0", search);
  if (filter.after && UUID.test(filter.after.id)) {
    params.push(filter.after.createdAt, filter.after.id);
    where.push(`(p.created_at, p.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(limit + 1);
  const { rows } = await withSystem((db) =>
    db.query<ProspectRow & { owner_name: string | null }>(
      `select ${PROSPECT_COLUMNS}, u.full_name as owner_name from demo_prospects p left join users u on u.id = p.owner_user_id
       ${where.length ? `where ${where.join(" and ")}` : ""} order by p.created_at desc, p.id desc limit $${params.length}`,
      params,
    ),
  );
  return { rows: rows.slice(0, limit).map((r) => listRow(r, now)), hasMore: rows.length > limit };
}

export interface ProspectEvent {
  id: string;
  at: string;
  kind: DemoEventKind;
  actorKind: "prospect" | "user" | "system";
  actorName: string | null;
  /** Numbers, switches and fixed words; plus a note's or a reason's text, which an erasure removes. */
  detail: Record<string, unknown>;
}

export interface ProspectDetail {
  prospect: ProspectListRow & {
    utm: Record<string, string>;
    consentAt: string | null;
    consentVersion: string | null;
    marketingOptIn: boolean;
    consultationDoneAt: string | null;
    extendedHours: number;
    extendedCount: number;
    extraMessages: number;
    messagesLeft: number;
    messageCount: number;
    erasedAt: string | null;
    conversionInProgress: boolean;
  };
  events: ProspectEvent[];
  /** What a Super Admin could still add to this prospect under the caps now in force. */
  extension: { hoursLeft: number; messagesLeft: number };
}

export async function getProspect(user: Pick<SessionUser, "id" | "platformRole">, id: string, now = new Date()): Promise<ProspectDetail> {
  await assertProspectsAccess(user, "agency.prospects.view");
  const prospectId = need(id);
  return withSystem(async (db) => {
    const row = (await db.query<ProspectRow & { owner_name: string | null }>(
      `select ${PROSPECT_COLUMNS}, u.full_name as owner_name from demo_prospects p left join users u on u.id = p.owner_user_id where p.id = $1`, [prospectId],
    )).rows[0];
    if (!row) throw new AppError("not_found", "That prospect was not found.");
    const events = await db.query<{ id: string; at: Date; kind: DemoEventKind; actor_kind: "prospect" | "user" | "system"; actor_name: string | null; detail: Record<string, unknown> }>(
      `select e.id::text as id, e.at, e.kind, e.actor_kind, u.full_name as actor_name, e.detail from demo_events e left join users u on u.id = e.actor_id
       where e.prospect_id = $1 order by e.id desc limit 500`,
      [prospectId],
    );
    const count = (await db.query<{ n: number }>("select count(*)::int as n from demo_messages where prospect_id = $1", [prospectId])).rows[0].n;
    const { settings } = await readDemoSettings(db);
    return {
      prospect: {
        ...listRow(row, now),
        utm: row.utm,
        consentAt: iso(row.consent_at),
        consentVersion: row.consent_version,
        marketingOptIn: row.marketing_opt_in,
        consultationDoneAt: iso(row.consultation_done_at),
        extendedHours: row.extended_hours,
        extendedCount: row.extended_count,
        extraMessages: row.extra_messages,
        messagesLeft: messagesLeft(factsOf(row)),
        messageCount: count,
        erasedAt: iso(row.erased_at),
        conversionInProgress: row.conversion_claimed_at !== null && row.converted_org_id === null,
      },
      events: events.rows.map((e) => ({ id: e.id, at: new Date(e.at).toISOString(), kind: e.kind, actorKind: e.actor_kind, actorName: e.actor_name, detail: e.detail })),
      extension: {
        hoursLeft: Math.max(0, settings.maxExtensionHours - row.extended_hours),
        messagesLeft: Math.max(0, settings.maxExtraMessages - row.extra_messages),
      },
    };
  });
}

export interface TranscriptRead {
  prospectId: string;
  lines: Array<{ id: string; seq: number; role: "user" | "assistant" | "system"; employeeRole: string | null; body: string; state: string | null; at: string }>;
}

/** The prospect's conversation, for a person allowed to read it. Every read is recorded on the prospect's timeline and in the audit trail (who, when, how many lines; never the text). */
export async function readTranscript(user: SessionUser, id: string): Promise<TranscriptRead> {
  await assertProspectsAccess(user, "agency.prospects.view");
  const prospectId = need(id);
  return withSystem(async (db) => {
    const p = await loadProspect(db, prospectId);
    if (!p) throw new AppError("not_found", "That prospect was not found.");
    const { rows } = await db.query<{ id: string; seq: number; role: "user" | "assistant" | "system"; employee_role: string | null; body: string; state: string | null; created_at: Date }>(
      "select id::text as id, seq, role, employee_role, body, state, created_at from demo_messages where prospect_id = $1 order by seq limit 400", [prospectId],
    );
    await addEvent(db, prospectId, "transcript_viewed", { kind: "user", id: user.id }, { lines: rows.length });
    await recordAudit({ actorUserId: user.id, actorKind: "agency", action: "demo.transcript_viewed", targetType: "demo_prospect", targetId: prospectId, result: "success", metadata: { lines: rows.length } }, db);
    return { prospectId, lines: rows.map((m) => ({ id: m.id, seq: m.seq, role: m.role, employeeRole: m.employee_role, body: m.body, state: m.state, at: new Date(m.created_at).toISOString() })) };
  });
}

export interface ProspectExport {
  exportedAt: string;
  prospect: {
    name: string | null;
    email: string | null;
    business: string | null;
    industry: string | null;
    requestedAt: string;
    confirmedAt: string | null;
    windowEndsAt: string | null;
    messagesUsed: number;
    status: ProspectStatus;
    campaign: Record<string, string>;
    consent: { at: string | null; noticeVersion: string | null; marketingOptIn: boolean };
  };
  timeline: Array<{ at: string; kind: DemoEventKind; actor: "the prospect" | "a team member" | "the system"; detail: Record<string, unknown> }>;
  conversation: Array<{ at: string; from: "prospect" | "assistant"; text: string }>;
}

/**
 * Everything held about one prospect, for the person to take away when they ask what we keep (a Super Admin runs it for them). Their details, what they agreed to, the timeline
 * (including the notes the team wrote about them) and their conversation; not the keyed hashes, which mean nothing to them. Recorded in the audit trail with counts only.
 */
export async function exportProspect(user: SessionUser, id: string, now = new Date()): Promise<ProspectExport> {
  await assertProspectsAccess(user, "agency.prospects.manage");
  const prospectId = need(id);
  return withSystem(async (db) => {
    const p = await loadProspect(db, prospectId);
    if (!p) throw new AppError("not_found", "That prospect was not found.");
    if (p.erased_at) throw new AppError("conflict", "This prospect's details were erased, so there is nothing to export.");
    const events = await db.query<{ at: Date; kind: DemoEventKind; actor_kind: "prospect" | "user" | "system"; detail: Record<string, unknown> }>(
      "select at, kind, actor_kind, detail from demo_events where prospect_id = $1 order by id", [prospectId],
    );
    const lines = await db.query<{ created_at: Date; role: "user" | "assistant" | "system"; body: string }>(
      "select created_at, role, body from demo_messages where prospect_id = $1 and role <> 'system' and state is distinct from 'failed' order by seq", [prospectId],
    );
    await audit(db, user, "demo.exported", prospectId, { events: events.rows.length, lines: lines.rows.length });
    return {
      exportedAt: now.toISOString(),
      prospect: {
        name: p.name, email: p.work_email, business: p.business_name, industry: demoIndustryLabel(p.industry), requestedAt: new Date(p.created_at).toISOString(), confirmedAt: iso(p.verified_at),
        windowEndsAt: iso(p.window_ends_at), messagesUsed: p.messages_used, status: p.status, campaign: p.utm,
        consent: { at: iso(p.consent_at), noticeVersion: p.consent_version, marketingOptIn: p.marketing_opt_in },
      },
      timeline: events.rows.map((e) => ({ at: new Date(e.at).toISOString(), kind: e.kind, actor: e.actor_kind === "prospect" ? "the prospect" : e.actor_kind === "user" ? "a team member" : "the system", detail: e.detail })),
      conversation: lines.rows.map((m) => ({ at: new Date(m.created_at).toISOString(), from: m.role === "user" ? "prospect" : "assistant", text: m.body })),
    };
  });
}

export interface ProspectsSummary {
  total: number;
  byStatus: Record<string, number>;
  today: DemoUsageDay;
  caps: { dailyStartCap: number; dailyMessageCap: number };
}

export async function prospectsSummary(user: Pick<SessionUser, "id" | "platformRole">, now = new Date()): Promise<ProspectsSummary> {
  await assertProspectsAccess(user, "agency.prospects.view");
  return withSystem(async (db) => {
    const { rows } = await db.query<{ status: string; n: number }>(
      // A window that ended counts as expired here too, so the numbers match the list.
      `select case when status = 'active' and window_ends_at <= $1::timestamptz then 'expired' else status end as status, count(*)::int as n from demo_prospects group by 1`,
      [now.toISOString()],
    );
    const byStatus: Record<string, number> = {};
    for (const r of rows) byStatus[r.status] = r.n;
    const { settings } = await readDemoSettings(db);
    return { total: rows.reduce((n, r) => n + r.n, 0), byStatus, today: await usageToday(db, now), caps: { dailyStartCap: settings.dailyStartCap, dailyMessageCap: settings.dailyMessageCap } };
  });
}

/** The people a prospect can be assigned to: active agency accounts that may see prospects. */
export async function assignableOwners(user: Pick<SessionUser, "id" | "platformRole">): Promise<Array<{ id: string; name: string }>> {
  await assertProspectsAccess(user, "agency.prospects.view");
  const { rows } = await withSystem((db) =>
    db.query<{ id: string; full_name: string }>(
      "select u.id, u.full_name from users u where u.status = 'active' and u.platform_role <> 'none' and coalesce(app.user_has_agency_permission(u.id, 'agency.prospects.view'), false) order by lower(u.full_name), u.id",
    ),
  );
  return rows.map((r) => ({ id: r.id, name: r.full_name }));
}

// ---------------------------------------------------------------------------
// Changing
// ---------------------------------------------------------------------------

/** Locks the prospect and runs the change in one transaction after the permission check. */
async function change<T>(user: SessionUser, id: string, fn: (db: Queryable, p: ProspectRow) => Promise<T>): Promise<T> {
  await assertProspectsAccess(user, "agency.prospects.manage");
  const prospectId = need(id);
  return withSystem(async (db) => {
    const p = await lockProspect(db, prospectId);
    if (!p) throw new AppError("not_found", "That prospect was not found.");
    return fn(db, p);
  });
}

const audit = (db: Queryable, user: SessionUser, action: string, targetId: string, metadata: Record<string, unknown> = {}) =>
  recordAudit({ actorUserId: user.id, actorKind: "agency", action, targetType: "demo_prospect", targetId, result: "success", metadata }, db);

export interface ExtendInput {
  hours: unknown;
  extraMessages: unknown;
  reason: unknown;
}

/**
 * Gives a prospect more time, more messages, or both: at most the totals in the settings across the prospect's whole life, a reason is required, and an ended window opens again
 * from now. The reason is kept on the timeline and the numbers in the audit trail.
 */
export async function extendDemo(user: SessionUser, id: string, input: ExtendInput, now = new Date()): Promise<{ windowEndsAt: Date; extraMessages: number; reactivated: boolean }> {
  return change(user, id, async (db, p) => {
    const { settings } = await readDemoSettings(db);
    const planned = planExtension(
      { status: p.status, verifiedAt: p.verified_at, windowEndsAt: p.window_ends_at, extendedHours: p.extended_hours, extendedCount: p.extended_count, extraMessages: p.extra_messages, erasedAt: p.erased_at },
      input,
      { maxExtensionHours: settings.maxExtensionHours, maxExtraMessages: settings.maxExtraMessages },
      now,
    );
    if (!planned.ok) throw new AppError("invalid_input", planned.message);
    const plan = planned.plan;
    const status: ProspectStatus = plan.reactivates ? "active" : p.status;
    await db.query(
      "update demo_prospects set window_ends_at = $2::timestamptz, extended_hours = $3, extended_count = $4, extra_messages = $5, status = $6 where id = $1",
      [p.id, plan.windowEndsAt.toISOString(), plan.extendedHours, plan.extendedCount, plan.extraMessages, status],
    );
    const hours = plan.extendedHours - p.extended_hours;
    const messages = plan.extraMessages - p.extra_messages;
    await addEvent(db, p.id, "extended", { kind: "user", id: user.id }, { hours, extraMessages: messages, reason: plan.reason, windowEndsAt: plan.windowEndsAt.toISOString() }, now);
    await audit(db, user, "demo.extended", p.id, { hours, extraMessages: messages, extendedHours: plan.extendedHours, extraMessagesTotal: plan.extraMessages, reactivated: plan.reactivates });
    return { windowEndsAt: plan.windowEndsAt, extraMessages: plan.extraMessages, reactivated: plan.reactivates };
  });
}

/** Ends the demo window now. The conversation stays readable; extending it opens the window again from that moment. */
export async function expireNow(user: SessionUser, id: string, reasonInput: unknown, now = new Date()): Promise<void> {
  return change(user, id, async (db, p) => {
    const reason = reasonOf(reasonInput);
    if (p.erased_at || !p.verified_at || !windowIsOpen(p.window_ends_at ? new Date(p.window_ends_at) : null, now)) throw new AppError("conflict", "This demo window is not open.");
    const status = p.status === "active" ? "expired" : p.status;
    await db.query("update demo_prospects set window_ends_at = $2::timestamptz, status = $3 where id = $1", [p.id, now.toISOString(), status]);
    await addEvent(db, p.id, "expired", { kind: "user", id: user.id }, { early: true, reason }, now);
    await audit(db, user, "demo.expired_early", p.id);
  });
}

async function endAccess(db: Queryable, prospectId: string, now: Date): Promise<void> {
  await db.query("update demo_sessions set revoked_at = $2::timestamptz where prospect_id = $1 and revoked_at is null", [prospectId, now.toISOString()]);
  await db.query("delete from demo_verifications where prospect_id = $1 and consumed_at is null", [prospectId]);
}

function assertCanMove(p: ProspectRow, to: ProspectStatus): void {
  if (p.erased_at) throw new AppError("conflict", "This prospect's details were erased.");
  if (p.status === to) throw new AppError("conflict", `This prospect is already ${to === "blocked" ? "blocked" : "marked as not a fit"}.`);
  if (!canTransition(p.status, to)) throw new AppError("conflict", p.status === "converted" ? "This prospect is already a client." : "That change is not possible from where this prospect is.");
}

/** Blocks a prospect: their sessions and links stop working, the chat refuses them, and registering again is answered like anyone else's but sends nothing. */
export async function blockProspect(user: SessionUser, id: string, reasonInput: unknown, now = new Date()): Promise<void> {
  return change(user, id, async (db, p) => {
    const reason = reasonOf(reasonInput);
    assertCanMove(p, "blocked");
    await db.query("update demo_prospects set status = 'blocked' where id = $1", [p.id]);
    await endAccess(db, p.id, now);
    await addEvent(db, p.id, "blocked", { kind: "user", id: user.id }, { from: p.status, reason }, now);
    await audit(db, user, "demo.blocked", p.id, { from: p.status });
  });
}

/** Marks a prospect as not a fit (their access stops like a block's, but it says no more than that). */
export async function declineProspect(user: SessionUser, id: string, reasonInput: unknown, now = new Date()): Promise<void> {
  return change(user, id, async (db, p) => {
    const reason = reasonOf(reasonInput);
    assertCanMove(p, "declined");
    await db.query("update demo_prospects set status = 'declined' where id = $1", [p.id]);
    await endAccess(db, p.id, now);
    await addEvent(db, p.id, "declined", { kind: "user", id: user.id }, { from: p.status, reason }, now);
    await audit(db, user, "demo.declined", p.id, { from: p.status });
  });
}

/** Lets a blocked or declined prospect back: to what they had reached, or to the state their window says. They get no new link: they ask for one on the demo page. */
export async function reopenProspect(user: SessionUser, id: string, now = new Date()): Promise<{ status: ProspectStatus }> {
  return change(user, id, async (db, p) => {
    if (p.erased_at) throw new AppError("conflict", "This prospect's details were erased.");
    if (p.status !== "blocked" && p.status !== "declined") throw new AppError("conflict", "Only a blocked prospect, or one marked as not a fit, can be reopened.");
    const to = reopenTarget(factsOf(p), now);
    await db.query("update demo_prospects set status = $2 where id = $1", [p.id, to]);
    await addEvent(db, p.id, "reopened", { kind: "user", id: user.id }, { from: p.status, to }, now);
    await audit(db, user, "demo.reopened", p.id, { from: p.status, to });
    return { status: to };
  });
}

/** Assigns the prospect to a team member who may see prospects, or to nobody. */
export async function assignOwner(user: SessionUser, id: string, ownerUserId: string | null, now = new Date()): Promise<void> {
  return change(user, id, async (db, p) => {
    if (p.erased_at) throw new AppError("conflict", "This prospect's details were erased.");
    if (ownerUserId !== null) {
      if (!UUID.test(ownerUserId)) throw new AppError("invalid_input", "Choose a team member from the list.");
      const ok = (await db.query<{ ok: boolean }>(
        "select coalesce(app.user_has_agency_permission(u.id, 'agency.prospects.view'), false) as ok from users u where u.id = $1 and u.status = 'active'", [ownerUserId],
      )).rows[0];
      if (!ok?.ok) throw new AppError("invalid_input", "That person cannot follow demo prospects up.");
    }
    if (p.owner_user_id === ownerUserId) return;
    await db.query("update demo_prospects set owner_user_id = $2 where id = $1", [p.id, ownerUserId]);
    await addEvent(db, p.id, "assigned", { kind: "user", id: user.id }, { ownerUserId }, now);
    await audit(db, user, "demo.assigned", p.id, { ownerUserId });
  });
}

/** A note on the prospect's timeline. */
export async function addNote(user: SessionUser, id: string, textInput: unknown, now = new Date()): Promise<void> {
  return change(user, id, async (db, p) => {
    if (p.erased_at) throw new AppError("conflict", "This prospect's details were erased.");
    const text = cleanNote(textInput, MAX_NOTE_CHARS);
    if (!text) throw new AppError("invalid_input", "Write the note first.");
    if (text.length > MAX_NOTE_CHARS) throw new AppError("invalid_input", `A note can be up to ${MAX_NOTE_CHARS} characters.`);
    await addEvent(db, p.id, "note", { kind: "user", id: user.id }, { note: text }, now);
    await audit(db, user, "demo.noted", p.id);
  });
}

/** Records that the consultation the prospect asked for was held. */
export async function markConsultationDone(user: SessionUser, id: string, now = new Date()): Promise<void> {
  return change(user, id, async (db, p) => {
    if (p.erased_at) throw new AppError("conflict", "This prospect's details were erased.");
    if (!p.consultation_requested_at) throw new AppError("conflict", "This prospect has not asked for a consultation.");
    if (p.consultation_done_at) return;
    await db.query("update demo_prospects set consultation_done_at = $2::timestamptz where id = $1", [p.id, now.toISOString()]);
    await addEvent(db, p.id, "consultation_done", { kind: "user", id: user.id }, {}, now);
    await audit(db, user, "demo.consultation_done", p.id);
  });
}

/** Erases a prospect's details and conversation because they asked. See erase.ts for what goes and what stays. */
export async function eraseProspect(user: SessionUser, id: string, reasonInput: unknown, now = new Date()): Promise<ErasureCounts> {
  return change(user, id, async (db, p) => {
    reasonOf(reasonInput);
    if (p.erased_at) throw new AppError("conflict", "This prospect's details were already erased.");
    const counts = await eraseProspectInTx(db, p.id, { kind: "user", id: user.id }, "request", now);
    return counts as ErasureCounts;
  });
}

export interface ConvertInput {
  /** The workspace name; defaults to the business name the prospect gave. */
  name?: unknown;
  /** Where the owner's invitation goes; defaults to the address the prospect confirmed. */
  ownerEmail?: unknown;
  timezone?: unknown;
}

const CLAIM_HOLD_MS = 15 * 60_000;

/**
 * Turns a confirmed prospect into a client workspace, on purpose. Needs agency.prospects.manage AND the permission to create clients (createClientTenant checks it again), and
 * does exactly what creating a client by hand does: a workspace in "invited" status, six AI employees that need setting up, and an invitation to the owner's address, which is how
 * the account comes to exist. The prospect's conversation is not copied anywhere: the workspace gets a name, an owner address, an industry label and a time zone, and nothing else.
 *
 * Two Super Admins pressing the button at once make one workspace: the first claims the prospect before anything is created, the second is refused. If the workspace is made but
 * the prospect cannot be marked afterwards, the claim stays (so a second workspace is never made by accident) and the error names the workspace.
 */
export async function convertProspect(user: SessionUser, id: string, input: ConvertInput = {}, now = new Date()): Promise<{ orgId: string; inviteLink: string; emailDelivery: Awaited<ReturnType<typeof createClientTenant>>["emailDelivery"] }> {
  await assertProspectsAccess(user, "agency.prospects.manage");
  const prospectId = need(id);
  // Reading the creating permission before the claim, so a refusal leaves the prospect alone.
  const mayCreate = (await withSystem((db) => db.query<{ ok: boolean }>("select coalesce(app.user_has_agency_permission($1, 'agency.clients.create'), false) as ok", [user.id]))).rows[0]?.ok;
  if (!mayCreate) throw new AppError("forbidden", "Your role does not allow creating client workspaces.");

  const claimed = await withSystem(async (db) => {
    const p = await lockProspect(db, prospectId);
    if (!p) throw new AppError("not_found", "That prospect was not found.");
    if (p.erased_at) throw new AppError("conflict", "This prospect's details were erased, so there is nothing to convert.");
    if (p.status === "converted" || p.converted_org_id) throw new AppError("conflict", "This prospect is already a client.");
    if (!p.verified_at || p.status === "blocked" || p.status === "declined" || p.status === "unverified") {
      throw new AppError("conflict", p.verified_at ? "Reopen this prospect before turning them into a client." : "This prospect has not confirmed their address, so the invitation could not be trusted.");
    }
    const holding = p.conversion_claimed_at && now.getTime() - new Date(p.conversion_claimed_at).getTime() < CLAIM_HOLD_MS;
    if (holding) throw new AppError("conflict", "A workspace is already being made for this prospect.");
    await db.query("update demo_prospects set conversion_claimed_at = $2::timestamptz, conversion_claimed_by = $3 where id = $1", [p.id, now.toISOString(), user.id]);
    return p;
  });

  const name = cleanLine(input.name ?? claimed.business_name, 120);
  const ownerEmail = typeof input.ownerEmail === "string" && input.ownerEmail.trim() ? input.ownerEmail.trim() : (claimed.work_email as string);
  const timezone = typeof input.timezone === "string" && input.timezone.trim() ? input.timezone.trim().slice(0, 64) : undefined;
  let created: Awaited<ReturnType<typeof createClientTenant>>;
  try {
    created = await createClientTenant(user, {
      name,
      ownerEmail,
      industry: demoIndustryLabel(claimed.industry) ?? "",
      ...(timezone ? { timezone } : {}),
      crmMode: "native",
      blueprint: null,
    });
  } catch (err) {
    // Nothing was made: the claim is given back so another try is possible.
    await withSystem((db) => db.query("update demo_prospects set conversion_claimed_at = null, conversion_claimed_by = null where id = $1 and converted_org_id is null", [prospectId])).catch(() => undefined);
    throw err;
  }

  try {
    await withSystem(async (db) => {
      await lockProspect(db, prospectId);
      await db.query(
        `update demo_prospects set status = 'converted', converted_org_id = $2, converted_at = $3::timestamptz, conversion_claimed_at = null, conversion_claimed_by = null where id = $1`,
        [prospectId, created.orgId, now.toISOString()],
      );
      await endAccess(db, prospectId, now);
      await addEvent(db, prospectId, "converted", { kind: "user", id: user.id }, { orgId: created.orgId }, now);
      await recordAudit({ orgId: created.orgId, actorUserId: user.id, actorKind: "agency", action: "demo.converted", targetType: "demo_prospect", targetId: prospectId, result: "success", metadata: { orgId: created.orgId } }, db);
    });
  } catch {
    await recordAudit({ orgId: created.orgId, actorUserId: user.id, actorKind: "agency", action: "demo.convert_unrecorded", targetType: "demo_prospect", targetId: prospectId, result: "failure", metadata: { orgId: created.orgId } }).catch(() => undefined);
    throw new AppError("internal", `The workspace was created (${created.orgId}) but the prospect could not be marked as converted. Do not convert again; ask an engineer to link them.`);
  }
  // The invitation email is sent by createClientTenant like for any client; whether it left is reported, so a person can send the link themselves if it did not.
  return { orgId: created.orgId, inviteLink: created.inviteLink, emailDelivery: created.emailDelivery };
}
