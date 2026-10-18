import "server-only";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyUser } from "@/server/notifications";
import { assertCan, auditActor, crmRead, crmWrite, systemActor, type CrmActor } from "@/server/crm/actor";
import { emitEvent, recordActivity } from "@/server/crm/events";
import { compileContactFilter, type CompileContext } from "@/server/crm/filter-sql";
import { loadCustomFieldMetas, parseFilterOrThrow } from "@/server/crm/directory";
import { countConditions, EMPTY_FILTER, isGroup, parseFilter, type FilterGroup } from "@/lib/crm/filters";
import { workingIntervals, type DayOverride, type WeeklyRule } from "@/lib/calendars/slots";

/**
 * Lead assignment: rules that give new contacts and deals an owner.
 *
 *  - Rules belong to one kind of record (contacts or deals) and run in order (position): the first active rule whose conditions match the
 *    record decides. Conditions are a Smart List filter compiled by the CRM filter compiler. For a deal they are checked against the deal's
 *    contact (a deal without a contact matches only a rule with no conditions).
 *  - Strategies: round_robin (the member assigned least recently), weighted (a deterministic weighted round robin: the member whose
 *    (assigned_count + 1) / weight is smallest, so over time each member's share follows their weight and turns interleave), priority (the
 *    available member with the highest priority; equal priorities take turns), keep_existing_owner (keep the owner; an unowned deal goes to
 *    its contact's owner and an unowned contact to its primary company's owner).
 *  - Members can be paused. With "respect working hours" only members working right now (their availability hours, in their own time zone,
 *    with day exceptions) who accept new work are considered. When nobody is available the record stays unassigned or goes to a fallback person.
 *  - A record that already has an owner is never reassigned, unless the rule explicitly allows it (reassignOwned).
 *  - Concurrency: the rule row is locked (select … for update) for the whole decision, and the member's counters are updated in the same
 *    transaction, so two workers routing two leads at once always see each other's turn. The record row is locked too.
 *  - Idempotency: one decision per record and triggering event (crm_assignment_history is unique on org, entity, record and event), so a
 *    redelivered event returns the earlier decision and changes nothing.
 *
 * `reassignOwned` has no column of its own: it is kept next to the filter in `conditions` ({ op, conditions, reassignOwned }). The filter
 * parser ignores it, so the filter stays a plain Smart List filter everywhere it is compiled.
 */

export type AssignmentEntity = "contact" | "opportunity";
export const ASSIGNMENT_ENTITIES: readonly AssignmentEntity[] = ["contact", "opportunity"];
export type AssignmentStrategy = "round_robin" | "weighted" | "priority" | "keep_existing_owner";
export const ASSIGNMENT_STRATEGIES: readonly AssignmentStrategy[] = ["round_robin", "weighted", "priority", "keep_existing_owner"];
export type AssignmentOutcome = "assigned" | "kept_owner" | "fallback" | "unassigned";

export const MAX_RULE_MEMBERS = 50;
export const MAX_RULES_PER_ENTITY = 50;

export interface AssignmentResult {
  /** What happened. "skipped": the rule didn't apply (switched off, conditions don't match, record gone) and nothing was recorded. */
  status: AssignmentOutcome | "skipped";
  userId: string | null;
  ruleId: string | null;
  reason: string;
  /** This event was already decided earlier; the earlier decision is returned and nothing changed. */
  duplicate: boolean;
  historyId: number | null;
}

/** The fields of a CRM outbox event this module reads. The event dispatcher's row type (CrmEventRow) satisfies it. */
export interface AssignmentEvent {
  id: number;
  orgId: string;
  type: string;
  entityType: string;
  entityId: string | null;
  contactId: string | null;
  payload: Record<string, unknown>;
  depth: number;
}

// ---------------------------------------------------------------------------
// Pure rules (exported for tests)
// ---------------------------------------------------------------------------

export interface AssignmentCandidate {
  userId: string;
  weight: number;
  priority: number;
  assignedCount: number;
  /** Epoch ms, or null when never assigned by this rule. */
  lastAssignedAt: number | null;
}

const lastOf = (c: AssignmentCandidate) => (c.lastAssignedAt === null ? -Infinity : c.lastAssignedAt);
/** Least recently assigned first (never assigned before anyone), then by id so the order is fully deterministic. */
const byRecency = (a: AssignmentCandidate, b: AssignmentCandidate) => lastOf(a) - lastOf(b) || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0);

/** Chooses the member for a strategy from the members who are available. Deterministic for the same input. */
export function pickMember(strategy: Exclude<AssignmentStrategy, "keep_existing_owner">, candidates: AssignmentCandidate[]): AssignmentCandidate | null {
  if (!candidates.length) return null;
  const list = [...candidates];
  if (strategy === "round_robin") return list.sort(byRecency)[0];
  if (strategy === "priority") return list.sort((a, b) => b.priority - a.priority || byRecency(a, b))[0];
  // Weighted: the smallest virtual finish time (count + 1) / weight, compared as integers (no floating point). Ties go to the member who waited longest.
  return list.sort((a, b) => (a.assignedCount + 1) * b.weight - (b.assignedCount + 1) * a.weight || byRecency(a, b))[0];
}

export interface WorkingHost {
  timezone: string;
  rules: WeeklyRule[];
  overrides: DayOverride[];
}

/** Whether a person is inside their working hours at this instant (weekly hours in their own time zone, with day exceptions). */
export function isWorkingAt(host: WorkingHost, now: Date): boolean {
  const t = now.getTime();
  return workingIntervals({ from: t, to: t + 60_000, timeZone: host.timezone, rules: host.rules, overrides: host.overrides }).some((i) => i.start <= t && i.end > t);
}

/** The stored conditions as a filter plus the reassignment switch kept beside it. A malformed value reads as "no conditions, don't reassign". */
export function readConditions(raw: unknown): { filter: FilterGroup; reassignOwned: boolean; valid: boolean } {
  const reassignOwned = Boolean(raw && typeof raw === "object" && (raw as { reassignOwned?: unknown }).reassignOwned === true);
  try {
    return { filter: parseFilter(raw ?? EMPTY_FILTER), reassignOwned, valid: true };
  } catch {
    return { filter: EMPTY_FILTER, reassignOwned, valid: false };
  }
}

function usesIsMe(group: FilterGroup): boolean {
  return group.conditions.some((c) => (isGroup(c) ? usesIsMe(c) : c.op === "is_me"));
}

// ---------------------------------------------------------------------------
// Shared reads
// ---------------------------------------------------------------------------

/** SQL that is true when membership m (joined to users u) may own contacts: an active member who can see contacts (as assertAssignable). */
const CAN_OWN = `(m.status = 'active' and u.status = 'active' and (m.role = 'owner' or coalesce(
  (select o.effect = 'grant' from member_permission_overrides o where o.org_id = m.org_id and o.user_id = m.user_id and o.permission = 'contacts.view'),
  exists (select 1 from role_permissions rp where rp.role = m.role and rp.permission = 'contacts.view'))))`;

async function personWhoCanOwn(db: Queryable, orgId: string, userId: string): Promise<{ id: string; name: string } | null> {
  const { rows } = await db.query<{ id: string; name: string }>(
    `select u.id, coalesce(nullif(u.full_name, ''), u.email::text) as name from organization_memberships m join users u on u.id = m.user_id
     where m.org_id = $1 and m.user_id = $2 and ${CAN_OWN}`,
    [orgId, userId],
  );
  return rows[0] ?? null;
}

/**
 * Whether iAcquire's own CRM owns these records (as assertNativeOwner decides, without throwing). Assignment changes only native records and
 * sends nothing outside, so a provider switch in progress doesn't hold it back.
 */
async function nativeOwns(db: Queryable, orgId: string, capability: "contacts" | "opportunities"): Promise<boolean> {
  const { rows } = await db.query<{ mode: string; provider: string | null }>(
    `select w.mode, p.provider from crm_workspaces w left join crm_capability_providers p on p.org_id = w.org_id and p.capability = $2 where w.org_id = $1`,
    [orgId, capability],
  );
  const w = rows[0];
  // A workspace without a CRM row has never been set up for another provider: the native CRM is the default.
  if (!w) return true;
  const owner = w.mode === "hybrid" ? (w.provider ?? "native") : w.mode;
  return owner === "native";
}

async function orgActor(db: Queryable, orgId: string): Promise<CrmActor> {
  const { rows } = await db.query<{ name: string; timezone: string }>("select name, timezone from organizations where id = $1", [orgId]);
  return systemActor({ id: orgId, name: rows[0]?.name ?? "", timezone: rows[0]?.timezone ?? "UTC" }, "Lead assignment");
}

/** Whether a record matches a filter. Conditions are compiled against the contact (for a deal: the deal's contact). */
async function recordMatches(db: Queryable, actor: CrmActor, filter: FilterGroup, entity: AssignmentEntity, record: { id: string; contactId: string | null }): Promise<boolean> {
  if (countConditions(filter) === 0) return true;
  const contactId = entity === "contact" ? record.id : record.contactId;
  if (!contactId) return false;
  const params: unknown[] = [actor.orgId];
  const ctx: CompileContext = { params, userId: null, timezone: actor.timezone, customFields: await loadCustomFieldMetas(db, actor.orgId) };
  const expr = compileContactFilter(filter, ctx);
  params.push(contactId);
  const { rows } = await db.query(`select 1 from contacts c where c.org_id = $1 and c.id = $${params.length} and c.deleted_at is null and ${expr}`, params);
  return rows.length > 0;
}

interface RuleRow {
  id: string;
  name: string;
  entity: AssignmentEntity;
  conditions: unknown;
  strategy: AssignmentStrategy;
  respect_working_hours: boolean;
  fallback: "unassigned" | "fallback_user";
  fallback_user_id: string | null;
  active: boolean;
}

interface MemberRow {
  user_id: string;
  name: string;
  weight: number;
  priority: number;
  paused: boolean;
  assigned_count: number;
  last_assigned_at: Date | null;
  can_own: boolean;
  timezone: string | null;
  accepting: boolean | null;
}

async function loadMembers(db: Queryable, orgId: string, ruleId: string): Promise<MemberRow[]> {
  const { rows } = await db.query<MemberRow>(
    `select am.user_id, coalesce(nullif(u.full_name, ''), u.email::text) as name, am.weight, am.priority, am.paused, am.assigned_count, am.last_assigned_at,
            ${CAN_OWN} as can_own, h.timezone, h.accepting
     from crm_assignment_members am
     join organization_memberships m on m.org_id = am.org_id and m.user_id = am.user_id
     join users u on u.id = am.user_id
     left join crm_host_settings h on h.org_id = am.org_id and h.user_id = am.user_id
     where am.rule_id = $1 and am.org_id = $2
     order by am.priority desc, lower(coalesce(nullif(u.full_name, ''), u.email::text))`,
    [ruleId, orgId],
  );
  return rows;
}

/** Working hours for these people, as availability works them out (a person's own exception for a day replaces the workspace-wide one). */
async function loadWorkingHosts(db: Queryable, orgId: string, members: MemberRow[], orgTimezone: string, now: Date): Promise<Map<string, WorkingHost>> {
  const ids = members.map((m) => m.user_id);
  const out = new Map<string, WorkingHost>();
  if (!ids.length) return out;
  const rules = await db.query<{ user_id: string; weekday: number; start_minute: number; end_minute: number }>(
    "select user_id, weekday, start_minute, end_minute from crm_availability_rules where org_id = $1 and user_id = any($2::uuid[])",
    [orgId, ids],
  );
  const day = now.toISOString().slice(0, 10);
  const overrides = await db.query<{ user_id: string | null; on_date: string; start_minute: number | null; end_minute: number | null }>(
    `select user_id, on_date::text as on_date, start_minute, end_minute from crm_availability_overrides
     where org_id = $1 and (user_id is null or user_id = any($2::uuid[])) and on_date between $3::date - 2 and $3::date + 2`,
    [orgId, ids, day],
  );
  for (const m of members) {
    const own = overrides.rows.filter((o) => o.user_id === m.user_id);
    const ownDates = new Set(own.map((o) => o.on_date));
    const all = [...own, ...overrides.rows.filter((o) => o.user_id === null && !ownDates.has(o.on_date))];
    out.set(m.user_id, {
      timezone: m.timezone ?? orgTimezone,
      rules: rules.rows.filter((r) => r.user_id === m.user_id).map((r) => ({ weekday: r.weekday, startMinute: r.start_minute, endMinute: r.end_minute })),
      overrides: all.map((o) => ({ date: o.on_date, startMinute: o.start_minute, endMinute: o.end_minute })),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

interface RecordRow {
  id: string;
  label: string;
  ownerId: string | null;
  contactId: string | null;
}

async function lockRecord(db: Queryable, orgId: string, entity: AssignmentEntity, id: string): Promise<RecordRow | null> {
  if (entity === "contact") {
    const { rows } = await db.query<{ id: string; display_name: string; email: string | null; phone: string | null; assigned_user_id: string | null }>(
      "select id, display_name, email::text as email, phone, assigned_user_id from contacts where id = $1 and org_id = $2 and deleted_at is null and archived_at is null for update",
      [id, orgId],
    );
    const r = rows[0];
    return r ? { id: r.id, label: r.display_name || r.email || r.phone || "A contact", ownerId: r.assigned_user_id, contactId: r.id } : null;
  }
  const { rows } = await db.query<{ id: string; name: string; assigned_user_id: string | null; contact_id: string | null }>(
    "select id, name, assigned_user_id, contact_id from crm_opportunities where id = $1 and org_id = $2 and provider = 'native' and archived_at is null for update",
    [id, orgId],
  );
  const r = rows[0];
  return r ? { id: r.id, label: r.name, ownerId: r.assigned_user_id, contactId: r.contact_id } : null;
}

const skipped = (ruleId: string | null, reason: string): AssignmentResult => ({ status: "skipped", userId: null, ruleId, reason, duplicate: false, historyId: null });

async function priorDecision(db: Queryable, orgId: string, entity: AssignmentEntity, entityId: string, eventId: number): Promise<AssignmentResult | null> {
  const { rows } = await db.query<{ id: string; rule_id: string | null; user_id: string | null; outcome: AssignmentOutcome; reason: string | null }>(
    "select id::text as id, rule_id, user_id, outcome, reason from crm_assignment_history where org_id = $1 and entity = $2 and entity_id = $3 and event_id = $4",
    [orgId, entity, entityId, eventId],
  );
  const r = rows[0];
  return r ? { status: r.outcome, userId: r.user_id, ruleId: r.rule_id, reason: r.reason ?? "", duplicate: true, historyId: Number(r.id) } : null;
}

const STRATEGY_PHRASE: Record<Exclude<AssignmentStrategy, "keep_existing_owner">, string> = {
  round_robin: "Round robin: the person assigned least recently",
  weighted: "Weighted round robin",
  priority: "Highest priority available",
};

/**
 * Applies one rule to one record inside the caller's transaction. The rule row is locked for the whole decision; the record row too.
 * `decisionEventId` makes the decision idempotent (one per record and event); only the dispatcher's auto-assignment sets it. `causedBy`
 * only carries the loop depth of the change.
 */
async function applyRule(
  db: Queryable,
  actor: CrmActor,
  input: { ruleId: string; entity: AssignmentEntity; entityId: string; causedBy: { eventId: number; depth: number } | null; decisionEventId: number | null; now: Date },
): Promise<AssignmentResult> {
  const { rows: ruleRows } = await db.query<RuleRow>(
    `select id, name, entity, conditions, strategy, respect_working_hours, fallback, fallback_user_id, active
     from crm_assignment_rules where id = $1 and org_id = $2 for update`,
    [input.ruleId, actor.orgId],
  );
  const rule = ruleRows[0];
  if (!rule) return skipped(null, "That assignment rule no longer exists.");
  if (rule.entity !== input.entity) throw new AppError("invalid_input", rule.entity === "contact" ? "That rule assigns contacts, not deals." : "That rule assigns deals, not contacts.");
  if (!rule.active) return skipped(rule.id, `The rule “${rule.name}” is switched off.`);

  const eventId = input.decisionEventId;
  if (eventId !== null) {
    const prior = await priorDecision(db, actor.orgId, input.entity, input.entityId, eventId);
    if (prior) return prior;
  }

  const record = await lockRecord(db, actor.orgId, input.entity, input.entityId);
  if (!record) return skipped(rule.id, input.entity === "contact" ? "The contact was archived or removed." : "The deal was archived or removed.");

  const cond = readConditions(rule.conditions);
  if (!cond.valid) return skipped(rule.id, `The rule “${rule.name}” has conditions that are no longer valid. Edit the rule to fix them.`);
  try {
    if (!(await recordMatches(db, actor, cond.filter, input.entity, record))) return skipped(rule.id, `The record doesn't match the conditions of “${rule.name}”.`);
  } catch (err) {
    if (err instanceof AppError) return skipped(rule.id, `The rule “${rule.name}” has conditions that are no longer valid (${err.message}).`);
    throw err;
  }

  const record_ = async (outcome: AssignmentOutcome, userId: string | null, reason: string) => {
    const { rows } = await db.query<{ id: string }>(
      `insert into crm_assignment_history (org_id, rule_id, entity, entity_id, user_id, outcome, reason, event_id) values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (org_id, entity, entity_id, event_id) where event_id is not null do nothing returning id::text as id`,
      [actor.orgId, rule.id, input.entity, record.id, userId, outcome, reason.slice(0, 300), eventId],
    );
    return rows[0] ? Number(rows[0].id) : null;
  };

  // An owned record keeps its owner unless the rule explicitly reassigns owned records (never under keep_existing_owner).
  if (record.ownerId && (rule.strategy === "keep_existing_owner" || !cond.reassignOwned)) {
    const owner = await personWhoCanOwn(db, actor.orgId, record.ownerId);
    const reason = `Kept: already owned by ${owner?.name ?? "a teammate"}.`;
    const historyId = await record_("kept_owner", record.ownerId, reason);
    return { status: "kept_owner", userId: record.ownerId, ruleId: rule.id, reason, duplicate: false, historyId };
  }

  let target: { userId: string; name: string; memberPick: boolean } | null = null;
  let reason = "";
  if (rule.strategy === "keep_existing_owner") {
    const linked = await linkedOwner(db, actor.orgId, input.entity, record);
    if (linked) {
      target = { userId: linked.id, name: linked.name, memberPick: false };
      reason = input.entity === "opportunity" ? `Given to the contact's owner, ${linked.name}.` : `Given to the company's owner, ${linked.name}.`;
    } else {
      reason = input.entity === "opportunity" ? "The deal's contact has no owner who can take it." : "The contact's company has no owner who can take it.";
    }
  } else {
    const members = await loadMembers(db, actor.orgId, rule.id);
    const orgTz = actor.timezone;
    const hosts = rule.respect_working_hours ? await loadWorkingHosts(db, actor.orgId, members, orgTz, input.now) : null;
    const counts = { paused: 0, away: 0, notAccepting: 0, gone: 0 };
    const available: Array<AssignmentCandidate & { name: string }> = [];
    for (const m of members) {
      if (!m.can_own) counts.gone++;
      else if (m.paused) counts.paused++;
      else if (hosts && m.accepting === false) counts.notAccepting++;
      else if (hosts && !isWorkingAt(hosts.get(m.user_id) ?? { timezone: orgTz, rules: [], overrides: [] }, input.now)) counts.away++;
      else available.push({ userId: m.user_id, name: m.name, weight: m.weight, priority: m.priority, assignedCount: m.assigned_count, lastAssignedAt: m.last_assigned_at ? new Date(m.last_assigned_at).getTime() : null });
    }
    const pick = pickMember(rule.strategy, available) as (AssignmentCandidate & { name: string }) | null;
    if (pick) {
      target = { userId: pick.userId, name: pick.name, memberPick: true };
      reason = `${STRATEGY_PHRASE[rule.strategy]} (${available.length} of ${members.length} available): ${pick.name}.`;
    } else {
      const why = [
        counts.paused && `${counts.paused} paused`,
        counts.away && `${counts.away} outside working hours`,
        counts.notAccepting && `${counts.notAccepting} not accepting new work`,
        counts.gone && `${counts.gone} no longer able to own records`,
      ].filter(Boolean);
      reason = members.length ? `Nobody was available${why.length ? ` (${why.join(", ")})` : ""}.` : "The rule has no members.";
    }
  }

  let outcome: AssignmentOutcome = "assigned";
  if (!target) {
    const fallback = rule.fallback === "fallback_user" && rule.fallback_user_id ? await personWhoCanOwn(db, actor.orgId, rule.fallback_user_id) : null;
    if (fallback) {
      target = { userId: fallback.id, name: fallback.name, memberPick: false };
      outcome = "fallback";
      reason = `${reason} Given to the fallback person, ${fallback.name}.`;
    } else {
      outcome = "unassigned";
      reason = `${reason} ${rule.fallback === "fallback_user" ? "The fallback person can no longer own records, so it" : "It"} stays unassigned.`;
    }
  }

  if (!target) {
    const historyId = await record_("unassigned", null, reason);
    return { status: "unassigned", userId: null, ruleId: rule.id, reason, duplicate: false, historyId };
  }
  if (target.userId === record.ownerId) {
    const historyId = await record_("kept_owner", target.userId, `Kept: the rule chose the current owner, ${target.name}.`);
    return { status: "kept_owner", userId: target.userId, ruleId: rule.id, reason: `Kept: the rule chose the current owner, ${target.name}.`, duplicate: false, historyId };
  }

  const historyId = await record_(outcome, target.userId, reason);
  if (eventId !== null && historyId === null) {
    // Another worker decided this event first (only possible without the rule lock, kept as a guard): report its decision.
    return (await priorDecision(db, actor.orgId, input.entity, record.id, eventId)) ?? skipped(rule.id, "Already decided.");
  }
  if (target.memberPick) {
    await db.query(
      "update crm_assignment_members set assigned_count = assigned_count + 1, last_assigned_at = clock_timestamp() where rule_id = $1 and user_id = $2 and org_id = $3",
      [rule.id, target.userId, actor.orgId],
    );
  }
  await writeOwner(db, actor, input.entity, record, target, { ruleId: rule.id, ruleName: rule.name, eventKey: eventId !== null ? String(eventId) : `h${historyId}`, causedBy: input.causedBy });
  return { status: outcome, userId: target.userId, ruleId: rule.id, reason, duplicate: false, historyId };
}

async function linkedOwner(db: Queryable, orgId: string, entity: AssignmentEntity, record: RecordRow): Promise<{ id: string; name: string } | null> {
  let ownerId: string | null = null;
  if (entity === "opportunity") {
    if (!record.contactId) return null;
    const { rows } = await db.query<{ assigned_user_id: string | null }>("select assigned_user_id from contacts where id = $1 and org_id = $2 and deleted_at is null", [record.contactId, orgId]);
    ownerId = rows[0]?.assigned_user_id ?? null;
  } else {
    const { rows } = await db.query<{ owner_user_id: string | null }>(
      `select co.owner_user_id from crm_contact_companies cc join crm_companies co on co.id = cc.company_id and co.org_id = cc.org_id and co.deleted_at is null
       where cc.org_id = $1 and cc.contact_id = $2 and cc.is_primary limit 1`,
      [orgId, record.id],
    );
    ownerId = rows[0]?.owner_user_id ?? null;
  }
  return ownerId ? personWhoCanOwn(db, orgId, ownerId) : null;
}

async function writeOwner(
  db: Queryable,
  actor: CrmActor,
  entity: AssignmentEntity,
  record: RecordRow,
  target: { userId: string; name: string },
  meta: { ruleId: string; ruleName: string; eventKey: string; causedBy: { eventId: number; depth: number } | null },
) {
  const summary = `Assigned to ${target.name} by the rule “${meta.ruleName}”`;
  if (entity === "contact") {
    await db.query("update contacts set assigned_user_id = $3, version = version + 1 where id = $1 and org_id = $2", [record.id, actor.orgId, target.userId]);
    await emitEvent(db, actor, {
      type: "contact.assigned", entityType: "contact", entityId: record.id, contactId: record.id,
      payload: { from: record.ownerId, to: target.userId, ruleId: meta.ruleId, via: "assignment_rule" },
      dedupeKey: `contact.assigned:${record.id}:rule:${meta.ruleId}:${meta.eventKey}`, causedBy: meta.causedBy,
    });
    await recordActivity(db, actor, { kind: "contact.assigned", summary, contactId: record.id, metadata: { from: record.ownerId, to: target.userId, ruleId: meta.ruleId } });
    await notifyUser(db, target.userId, actor.orgId, {
      kind: "crm_assigned", severity: "info", title: `New contact assigned to you: ${record.label}`.slice(0, 200), body: `The assignment rule “${meta.ruleName}” chose you.`,
      link: `/crm/contacts/${record.id}`, dedupeKey: `crm-rule-assigned:contact:${record.id}:${meta.eventKey}`,
    });
    return;
  }
  const { rows } = await db.query<{ version: number }>("update crm_opportunities set assigned_user_id = $3, version = version + 1 where id = $1 and org_id = $2 returning version", [record.id, actor.orgId, target.userId]);
  await emitEvent(db, actor, {
    type: "opportunity.updated", entityType: "opportunity", entityId: record.id, contactId: record.contactId,
    payload: { changed: ["ownerId"], from: record.ownerId, to: target.userId, ruleId: meta.ruleId, via: "assignment_rule" },
    dedupeKey: `opportunity.updated:${record.id}:v${rows[0].version}`, causedBy: meta.causedBy,
  });
  await recordActivity(db, actor, { kind: "opportunity.assigned", summary, opportunityId: record.id, contactId: record.contactId, metadata: { from: record.ownerId, to: target.userId, ruleId: meta.ruleId } });
  await notifyUser(db, target.userId, actor.orgId, {
    kind: "crm_assigned", severity: "info", title: `New deal assigned to you: ${record.label}`.slice(0, 200), body: `The assignment rule “${meta.ruleName}” chose you.`,
    link: `/crm/opportunities/${record.id}`, dedupeKey: `crm-rule-assigned:opportunity:${record.id}:${meta.eventKey}`,
  });
}

// ---------------------------------------------------------------------------
// Entry points for the event dispatcher and workflow steps
// ---------------------------------------------------------------------------

/**
 * Event dispatcher subscriber: routes a new contact (contact.created) or deal (opportunity.created) through the workspace's active rules,
 * first match wins. Runs in the dispatcher's per-event transaction. Contacts created by a spreadsheet import are left alone (the import
 * wizard sets their owner, and routing thousands of rows one notification at a time would surprise people). Never throws for an
 * expected situation, so one bad rule cannot hold the event back; a rule whose conditions stopped compiling is skipped.
 */
export async function autoAssignForEvent(db: Queryable, event: AssignmentEvent, opts: { now?: Date } = {}): Promise<AssignmentResult | null> {
  if (event.type !== "contact.created" && event.type !== "opportunity.created") return null;
  const entity: AssignmentEntity = event.type === "contact.created" ? "contact" : "opportunity";
  if (!event.entityId) return null;
  if (entity === "contact" && event.payload?.via === "import") return null;
  if (!(await nativeOwns(db, event.orgId, entity === "contact" ? "contacts" : "opportunities"))) return null;
  const prior = await priorDecision(db, event.orgId, entity, event.entityId, event.id);
  if (prior) return prior;
  const { rows: rules } = await db.query<{ id: string; conditions: unknown }>(
    "select id, conditions from crm_assignment_rules where org_id = $1 and entity = $2 and active order by position, created_at, id",
    [event.orgId, entity],
  );
  if (!rules.length) return null;
  const actor = await orgActor(db, event.orgId);
  const { rows: rec } = await db.query<{ contact_id: string | null }>(
    entity === "contact"
      ? "select id as contact_id from contacts where id = $1 and org_id = $2 and deleted_at is null and archived_at is null"
      : "select contact_id from crm_opportunities where id = $1 and org_id = $2 and provider = 'native' and archived_at is null",
    [event.entityId, event.orgId],
  );
  if (!rec[0]) return null;
  for (const r of rules) {
    const cond = readConditions(r.conditions);
    if (!cond.valid) continue;
    let matches = false;
    try {
      matches = await recordMatches(db, actor, cond.filter, entity, { id: event.entityId, contactId: rec[0].contact_id });
    } catch (err) {
      if (err instanceof AppError) continue;
      throw err;
    }
    if (!matches) continue;
    const result = await applyRule(db, actor, { ruleId: r.id, entity, entityId: event.entityId, causedBy: { eventId: event.id, depth: event.depth }, decisionEventId: event.id, now: opts.now ?? new Date() });
    // The rule may have been switched off between the list and the lock: try the next one.
    if (result.status === "skipped") continue;
    return result;
  }
  return null;
}

/**
 * Workflow step "assign through a rule": applies one named rule to one record in the caller's transaction (the run step's), using the
 * rule's conditions, strategy, working hours and fallback. Every call decides afresh, so it is never answered with the dispatcher's
 * auto-assignment for the same event (or another step's decision); the step's own transaction and run log keep it from happening twice.
 * `causedBy` only carries the loop depth.
 */
export async function assignWithRule(
  db: Queryable,
  actor: CrmActor,
  input: { ruleId: string; entity: AssignmentEntity; entityId: string; causedBy?: { eventId: number; depth: number } | null; now?: Date },
): Promise<AssignmentResult> {
  assertCan(actor, "contacts.assign", "Assigning records through a rule needs the assign permission.");
  if (!ASSIGNMENT_ENTITIES.includes(input.entity)) throw new AppError("invalid_input", "Choose contacts or deals.");
  if (!(await nativeOwns(db, actor.orgId, input.entity === "contact" ? "contacts" : "opportunities"))) {
    return skipped(input.ruleId, input.entity === "contact" ? "Contacts are managed in GoHighLevel for this workspace." : "Deals are managed in GoHighLevel for this workspace.");
  }
  return applyRule(db, actor, { ruleId: input.ruleId, entity: input.entity, entityId: input.entityId, causedBy: input.causedBy ?? null, decisionEventId: null, now: input.now ?? new Date() });
}

// ---------------------------------------------------------------------------
// Managing rules
// ---------------------------------------------------------------------------

export interface AssignmentMemberInput {
  userId: string;
  weight?: number;
  priority?: number;
  paused?: boolean;
}

export interface AssignmentRuleInput {
  name: string;
  entity: AssignmentEntity;
  conditions?: unknown;
  strategy: AssignmentStrategy;
  respectWorkingHours?: boolean;
  fallback?: "unassigned" | "fallback_user";
  fallbackUserId?: string | null;
  reassignOwned?: boolean;
  active?: boolean;
  members?: AssignmentMemberInput[];
}

export interface AssignmentMemberView {
  userId: string;
  name: string;
  weight: number;
  priority: number;
  paused: boolean;
  lastAssignedAt: string | null;
  /** Decisions that gave this person a record through this rule in the last 30 days. */
  assigned30d: number;
  canOwn: boolean;
  accepting: boolean;
  hasWorkingHours: boolean;
  workingNow: boolean;
}

export interface AssignmentRuleView {
  id: string;
  name: string;
  entity: AssignmentEntity;
  conditions: FilterGroup;
  conditionsValid: boolean;
  strategy: AssignmentStrategy;
  respectWorkingHours: boolean;
  fallback: "unassigned" | "fallback_user";
  fallbackUser: { id: string; name: string } | null;
  reassignOwned: boolean;
  position: number;
  active: boolean;
  members: AssignmentMemberView[];
  decisions30d: Record<AssignmentOutcome, number>;
  /** It has made decisions, so it is kept for the history (switch it off instead of deleting it). */
  hasHistory: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Rules are configuration for routing records to people: the assign permission manages them; an agency support session may look. */
function assertCanViewRules(actor: CrmActor) {
  if (actor.can("contacts.assign")) return;
  if (actor.kind === "agency" && actor.can("crm.view")) return;
  assertCan(actor, "contacts.assign", "Lead assignment rules need the assign permission.");
}

export async function listAssignmentRules(actor: CrmActor, opts: { now?: Date } = {}): Promise<AssignmentRuleView[]> {
  assertCanViewRules(actor);
  const now = opts.now ?? new Date();
  return crmRead(actor, async (db) => {
    const { rows } = await db.query<RuleRow & { position: number; created_at: Date; updated_at: Date; fallback_name: string | null }>(
      `select r.id, r.name, r.entity, r.conditions, r.strategy, r.respect_working_hours, r.fallback, r.fallback_user_id, r.active, r.position, r.created_at, r.updated_at,
              coalesce(nullif(fu.full_name, ''), fu.email::text) as fallback_name
       from crm_assignment_rules r left join users fu on fu.id = r.fallback_user_id
       where r.org_id = $1 order by r.entity, r.position, r.created_at, r.id`,
      [actor.orgId],
    );
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const members = await db.query<MemberRow & { rule_id: string }>(
      `select am.rule_id, am.user_id, coalesce(nullif(u.full_name, ''), u.email::text) as name, am.weight, am.priority, am.paused, am.assigned_count, am.last_assigned_at,
              ${CAN_OWN} as can_own, h.timezone, h.accepting
       from crm_assignment_members am
       join organization_memberships m on m.org_id = am.org_id and m.user_id = am.user_id
       join users u on u.id = am.user_id
       left join crm_host_settings h on h.org_id = am.org_id and h.user_id = am.user_id
       where am.org_id = $1 and am.rule_id = any($2::uuid[])
       order by am.priority desc, lower(coalesce(nullif(u.full_name, ''), u.email::text))`,
      [actor.orgId, ids],
    );
    const stats = await db.query<{ rule_id: string; user_id: string | null; outcome: AssignmentOutcome; n: string }>(
      `select rule_id, user_id, outcome, count(*)::text as n from crm_assignment_history
       where org_id = $1 and rule_id = any($2::uuid[]) and created_at > $3::timestamptz - interval '30 days' group by rule_id, user_id, outcome`,
      [actor.orgId, ids, now.toISOString()],
    );
    const used = await db.query<{ rule_id: string }>("select distinct rule_id from crm_assignment_history where org_id = $1 and rule_id = any($2::uuid[])", [actor.orgId, ids]);
    const withHistory = new Set(used.rows.map((u) => u.rule_id));
    const orgTz = actor.timezone;
    const hosts = await loadWorkingHosts(db, actor.orgId, members.rows, orgTz, now);
    return rows.map((r) => {
      const cond = readConditions(r.conditions);
      const decisions: Record<AssignmentOutcome, number> = { assigned: 0, kept_owner: 0, fallback: 0, unassigned: 0 };
      for (const s of stats.rows.filter((x) => x.rule_id === r.id)) decisions[s.outcome] += Number(s.n);
      return {
        id: r.id, name: r.name, entity: r.entity, conditions: cond.filter, conditionsValid: cond.valid, strategy: r.strategy, respectWorkingHours: r.respect_working_hours,
        fallback: r.fallback, fallbackUser: r.fallback_user_id ? { id: r.fallback_user_id, name: r.fallback_name ?? "Teammate" } : null, reassignOwned: cond.reassignOwned,
        position: r.position, active: r.active, decisions30d: decisions, hasHistory: withHistory.has(r.id), createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
        members: members.rows.filter((m) => m.rule_id === r.id).map((m) => {
          const host = hosts.get(m.user_id);
          return {
            userId: m.user_id, name: m.name, weight: m.weight, priority: m.priority, paused: m.paused,
            lastAssignedAt: m.last_assigned_at ? new Date(m.last_assigned_at).toISOString() : null,
            assigned30d: stats.rows.filter((s) => s.rule_id === r.id && s.user_id === m.user_id && (s.outcome === "assigned" || s.outcome === "fallback")).reduce((n, s) => n + Number(s.n), 0),
            canOwn: m.can_own, accepting: m.accepting !== false, hasWorkingHours: Boolean(host?.rules.length), workingNow: host ? isWorkingAt(host, now) : false,
          };
        }),
      };
    });
  });
}

interface CleanRule {
  name: string;
  entity: AssignmentEntity;
  stored: Record<string, unknown>;
  strategy: AssignmentStrategy;
  respectWorkingHours: boolean;
  fallback: "unassigned" | "fallback_user";
  fallbackUserId: string | null;
  active: boolean;
  members: Array<{ userId: string; weight: number; priority: number; paused: boolean }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validates a rule completely before anything is written: name, filter (compiled once), strategy, members who can own records, fallback. */
async function cleanRule(db: Queryable, actor: CrmActor, input: AssignmentRuleInput): Promise<CleanRule> {
  const name = (input.name ?? "").replace(/\s+/g, " ").trim();
  if (!name) throw new AppError("invalid_input", "Give the rule a name.");
  if (name.length > 80) throw new AppError("invalid_input", "Keep the rule name under 80 characters.");
  if (!ASSIGNMENT_ENTITIES.includes(input.entity)) throw new AppError("invalid_input", "Choose whether the rule assigns contacts or deals.");
  if (!ASSIGNMENT_STRATEGIES.includes(input.strategy)) throw new AppError("invalid_input", "Choose how the rule picks a person.");
  const filter = parseFilterOrThrow(input.conditions ?? EMPTY_FILTER);
  if (usesIsMe(filter)) throw new AppError("invalid_input", "“Owner is me” can't be used in a rule, because a rule works for the whole team. Choose people by name instead.");
  // Compile once so a broken filter is refused now rather than silently never matching later.
  compileContactFilter(filter, { params: [actor.orgId], userId: null, timezone: actor.timezone, customFields: await loadCustomFieldMetas(db, actor.orgId) });

  const members: CleanRule["members"] = [];
  const seen = new Set<string>();
  for (const m of input.members ?? []) {
    if (!m || typeof m.userId !== "string" || !UUID.test(m.userId)) throw new AppError("invalid_input", "Choose team members from the list.");
    if (seen.has(m.userId)) continue;
    seen.add(m.userId);
    const weight = m.weight ?? 1;
    const priority = m.priority ?? 50;
    if (!Number.isInteger(weight) || weight < 1 || weight > 100) throw new AppError("invalid_input", "A weight is a whole number from 1 to 100.");
    if (!Number.isInteger(priority) || priority < 0 || priority > 100) throw new AppError("invalid_input", "A priority is a whole number from 0 to 100.");
    if (!(await personWhoCanOwn(db, actor.orgId, m.userId))) throw new AppError("invalid_input", "Every member must be an active teammate who can see contacts.");
    members.push({ userId: m.userId, weight, priority, paused: m.paused === true });
  }
  if (members.length > MAX_RULE_MEMBERS) throw new AppError("invalid_input", `A rule can have at most ${MAX_RULE_MEMBERS} members.`);
  if (input.strategy !== "keep_existing_owner" && !members.length) throw new AppError("invalid_input", "Add at least one team member for the rule to choose from.");

  const fallback = input.fallback === "fallback_user" ? "fallback_user" : "unassigned";
  let fallbackUserId: string | null = null;
  if (fallback === "fallback_user") {
    if (!input.fallbackUserId || !UUID.test(input.fallbackUserId)) throw new AppError("invalid_input", "Choose who gets the record when nobody is available.");
    if (!(await personWhoCanOwn(db, actor.orgId, input.fallbackUserId))) throw new AppError("invalid_input", "The fallback person must be an active teammate who can see contacts.");
    fallbackUserId = input.fallbackUserId;
  }
  const reassignOwned = input.strategy !== "keep_existing_owner" && input.reassignOwned === true;
  return {
    name, entity: input.entity, strategy: input.strategy, respectWorkingHours: input.respectWorkingHours === true, fallback, fallbackUserId, active: input.active !== false, members,
    stored: { op: filter.op, conditions: filter.conditions, ...(reassignOwned ? { reassignOwned: true } : {}) },
  };
}

/**
 * Members who join a rule (or come back from a pause) start level with the others under the weighted strategy: their counter is brought up
 * to the same share as the member furthest behind, so they don't receive a long run of records to "catch up".
 */
async function syncMembers(db: Queryable, orgId: string, ruleId: string, members: CleanRule["members"]) {
  const { rows: existing } = await db.query<{ user_id: string; weight: number; assigned_count: number; paused: boolean }>(
    "select user_id, weight, assigned_count, paused from crm_assignment_members where rule_id = $1 and org_id = $2 for update",
    [ruleId, orgId],
  );
  const keep = new Set(members.map((m) => m.userId));
  const gone = existing.filter((e) => !keep.has(e.user_id)).map((e) => e.user_id);
  if (gone.length) await db.query("delete from crm_assignment_members where rule_id = $1 and org_id = $2 and user_id = any($3::uuid[])", [ruleId, orgId, gone]);
  const active = existing.filter((e) => keep.has(e.user_id) && !e.paused);
  const minShare = active.length ? Math.min(...active.map((e) => e.assigned_count / e.weight)) : 0;
  for (const m of members) {
    const prev = existing.find((e) => e.user_id === m.userId);
    const joining = !prev || (prev.paused && !m.paused);
    const level = Math.floor(minShare * m.weight);
    await db.query(
      `insert into crm_assignment_members (org_id, rule_id, user_id, weight, priority, paused, assigned_count) values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (rule_id, user_id) do update set weight = excluded.weight, priority = excluded.priority, paused = excluded.paused,
         assigned_count = case when $8::boolean then greatest(crm_assignment_members.assigned_count, excluded.assigned_count) else crm_assignment_members.assigned_count end`,
      [orgId, ruleId, m.userId, m.weight, m.priority, m.paused, joining ? level : 0, joining],
    );
  }
}

export async function createAssignmentRule(actor: CrmActor, input: AssignmentRuleInput): Promise<{ id: string }> {
  assertCan(actor, "contacts.assign", "Lead assignment rules need the assign permission.");
  return crmWrite(actor, async (db) => {
    const r = await cleanRule(db, actor, input);
    // Serialize rule creation per workspace and record kind so positions stay unique.
    await db.query("select id from crm_assignment_rules where org_id = $1 and entity = $2 for update", [actor.orgId, r.entity]);
    const { rows: count } = await db.query<{ n: string; next: number }>(
      "select count(*)::text as n, coalesce(max(position) + 1, 0) as next from crm_assignment_rules where org_id = $1 and entity = $2",
      [actor.orgId, r.entity],
    );
    if (Number(count[0].n) >= MAX_RULES_PER_ENTITY) throw new AppError("conflict", `A workspace can have at most ${MAX_RULES_PER_ENTITY} rules for each kind of record.`);
    const { rows } = await db.query<{ id: string }>(
      `insert into crm_assignment_rules (org_id, name, entity, conditions, strategy, respect_working_hours, fallback, fallback_user_id, position, active, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
      [actor.orgId, r.name, r.entity, JSON.stringify(r.stored), r.strategy, r.respectWorkingHours, r.fallback, r.fallbackUserId, Number(count[0].next), r.active, actor.userId],
    );
    await syncMembers(db, actor.orgId, rows[0].id, r.members);
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.assignment_rule_created", targetType: "crm_assignment_rule", targetId: rows[0].id, result: "success", metadata: { entity: r.entity, strategy: r.strategy, members: r.members.length } }, db);
    return { id: rows[0].id };
  });
}

export async function updateAssignmentRule(actor: CrmActor, id: string, input: AssignmentRuleInput): Promise<void> {
  assertCan(actor, "contacts.assign", "Lead assignment rules need the assign permission.");
  await crmWrite(actor, async (db) => {
    const { rows } = await db.query<{ entity: AssignmentEntity }>("select entity from crm_assignment_rules where id = $1 and org_id = $2 for update", [id, actor.orgId]);
    if (!rows[0]) throw new AppError("not_found", "That rule no longer exists.");
    const r = await cleanRule(db, actor, input);
    if (r.entity !== rows[0].entity) throw new AppError("invalid_input", "A rule keeps the kind of record it assigns. Create a new rule for the other kind.");
    await db.query(
      `update crm_assignment_rules set name = $3, conditions = $4, strategy = $5, respect_working_hours = $6, fallback = $7, fallback_user_id = $8, active = $9
       where id = $1 and org_id = $2`,
      [id, actor.orgId, r.name, JSON.stringify(r.stored), r.strategy, r.respectWorkingHours, r.fallback, r.fallbackUserId, r.active],
    );
    await syncMembers(db, actor.orgId, id, r.members);
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.assignment_rule_updated", targetType: "crm_assignment_rule", targetId: id, result: "success", metadata: { strategy: r.strategy, members: r.members.length, active: r.active } }, db);
  });
}

export async function setAssignmentRuleActive(actor: CrmActor, id: string, active: boolean): Promise<void> {
  assertCan(actor, "contacts.assign", "Lead assignment rules need the assign permission.");
  await crmWrite(actor, async (db) => {
    const { rows } = await db.query<{ id: string }>("update crm_assignment_rules set active = $3 where id = $1 and org_id = $2 returning id", [id, actor.orgId, active]);
    if (!rows[0]) throw new AppError("not_found", "That rule no longer exists.");
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: active ? "crm.assignment_rule_activated" : "crm.assignment_rule_paused", targetType: "crm_assignment_rule", targetId: id, result: "success" }, db);
  });
}

/** Moves a rule one place up or down among the rules for the same kind of record. Rules are evaluated in this order. */
export async function moveAssignmentRule(actor: CrmActor, id: string, direction: "up" | "down"): Promise<{ moved: boolean }> {
  assertCan(actor, "contacts.assign", "Lead assignment rules need the assign permission.");
  return crmWrite(actor, async (db) => {
    const { rows: one } = await db.query<{ entity: AssignmentEntity }>("select entity from crm_assignment_rules where id = $1 and org_id = $2", [id, actor.orgId]);
    if (!one[0]) throw new AppError("not_found", "That rule no longer exists.");
    const { rows } = await db.query<{ id: string }>(
      "select id from crm_assignment_rules where org_id = $1 and entity = $2 order by position, created_at, id for update",
      [actor.orgId, one[0].entity],
    );
    const order = rows.map((r) => r.id);
    const i = order.indexOf(id);
    const j = direction === "up" ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= order.length) return { moved: false };
    [order[i], order[j]] = [order[j], order[i]];
    for (const [pos, ruleId] of order.entries()) await db.query("update crm_assignment_rules set position = $3 where id = $1 and org_id = $2 and position is distinct from $3", [ruleId, actor.orgId, pos]);
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.assignment_rule_reordered", targetType: "crm_assignment_rule", targetId: id, result: "success", metadata: { direction } }, db);
    return { moved: true };
  });
}

/**
 * Deletes a rule that has never decided anything, with its members. A rule that has made decisions is kept, because the assignment
 * history is append-only and names the rule behind each decision: switch it off instead.
 */
export async function deleteAssignmentRule(actor: CrmActor, id: string): Promise<void> {
  assertCan(actor, "contacts.assign", "Lead assignment rules need the assign permission.");
  await crmWrite(actor, async (db) => {
    const { rows: found } = await db.query<{ id: string }>("select id from crm_assignment_rules where id = $1 and org_id = $2 for update", [id, actor.orgId]);
    if (!found[0]) throw new AppError("not_found", "That rule no longer exists.");
    const used = await db.query("select 1 from crm_assignment_history where org_id = $1 and rule_id = $2 limit 1", [actor.orgId, id]);
    if (used.rows[0]) throw new AppError("conflict", "This rule has already assigned records, so it is kept for the history. Switch it off instead.");
    const { rows } = await db.query<{ name: string; entity: AssignmentEntity }>("delete from crm_assignment_rules where id = $1 and org_id = $2 returning name, entity", [id, actor.orgId]);
    if (!rows[0]) throw new AppError("not_found", "That rule no longer exists.");
    const { rows: rest } = await db.query<{ id: string }>("select id from crm_assignment_rules where org_id = $1 and entity = $2 order by position, created_at, id for update", [actor.orgId, rows[0].entity]);
    for (const [pos, r] of rest.entries()) await db.query("update crm_assignment_rules set position = $3 where id = $1 and org_id = $2 and position is distinct from $3", [r.id, actor.orgId, pos]);
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.assignment_rule_deleted", targetType: "crm_assignment_rule", targetId: id, result: "success", metadata: { name: rows[0].name } }, db);
  });
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export interface AssignmentDecisionView {
  id: number;
  at: string;
  entity: AssignmentEntity;
  entityId: string;
  recordLabel: string | null;
  /** The record still exists and is not archived. */
  recordLive: boolean;
  ruleId: string | null;
  ruleName: string | null;
  userId: string | null;
  userName: string | null;
  outcome: AssignmentOutcome;
  reason: string;
  eventId: number | null;
}

/** Automatic assignment decisions, newest first: for one record, or the workspace's most recent. */
export async function listAssignmentHistory(actor: CrmActor, q: { entity?: AssignmentEntity; entityId?: string; limit?: number } = {}): Promise<AssignmentDecisionView[]> {
  assertCan(actor, "contacts.view");
  if (q.entity && !ASSIGNMENT_ENTITIES.includes(q.entity)) throw new AppError("invalid_input", "Choose contacts or deals.");
  if (q.entityId && !UUID.test(q.entityId)) throw new AppError("invalid_input", "That record isn't valid.");
  const limit = Math.min(200, Math.max(1, q.limit ?? 50));
  const seeDeals = actor.can("sales.view");
  return crmRead(actor, async (db) => {
    const { rows } = await db.query<{
      id: string; created_at: Date; entity: AssignmentEntity; entity_id: string; rule_id: string | null; rule_name: string | null; user_id: string | null; user_name: string | null;
      outcome: AssignmentOutcome; reason: string | null; event_id: string | null; contact_label: string | null; contact_live: boolean | null; deal_label: string | null; deal_live: boolean | null;
    }>(
      `select h.id::text as id, h.created_at, h.entity, h.entity_id, h.rule_id, r.name as rule_name, h.user_id, coalesce(nullif(u.full_name, ''), u.email::text) as user_name,
              h.outcome, h.reason, h.event_id::text as event_id,
              case when h.entity = 'contact' then coalesce(nullif(c.display_name, ''), c.email::text, c.phone) end as contact_label,
              case when h.entity = 'contact' then (c.id is not null and c.deleted_at is null and c.archived_at is null) end as contact_live,
              case when h.entity = 'opportunity' then o.name end as deal_label,
              case when h.entity = 'opportunity' then (o.id is not null and o.archived_at is null) end as deal_live
       from crm_assignment_history h
       left join crm_assignment_rules r on r.id = h.rule_id and r.org_id = h.org_id
       left join users u on u.id = h.user_id
       left join contacts c on h.entity = 'contact' and c.id = h.entity_id and c.org_id = h.org_id
       left join crm_opportunities o on h.entity = 'opportunity' and o.id = h.entity_id and o.org_id = h.org_id
       where h.org_id = $1 and ($2::text is null or h.entity = $2) and ($3::uuid is null or h.entity_id = $3) and ($4::boolean or h.entity = 'contact')
       order by h.created_at desc, h.id desc limit $5`,
      [actor.orgId, q.entity ?? null, q.entityId ?? null, seeDeals, limit],
    );
    return rows.map((r) => ({
      id: Number(r.id), at: new Date(r.created_at).toISOString(), entity: r.entity, entityId: r.entity_id,
      recordLabel: r.entity === "contact" ? r.contact_label : r.deal_label, recordLive: Boolean(r.entity === "contact" ? r.contact_live : r.deal_live),
      ruleId: r.rule_id, ruleName: r.rule_name, userId: r.user_id, userName: r.user_name, outcome: r.outcome, reason: r.reason ?? "", eventId: r.event_id ? Number(r.event_id) : null,
    }));
  });
}
