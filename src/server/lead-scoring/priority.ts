import "server-only";
import { z } from "zod";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import type { Queryable } from "@/server/db";
import { assertCan, auditActor, crmRead, crmWrite, type CrmActor } from "@/server/crm/actor";
import { emitEvent } from "@/server/crm/events";
import { assessContact } from "@/server/lead-scoring/service";
import { enqueueUnscored } from "@/server/lead-scoring/queue";
import type { AssessOutcome } from "@/server/lead-scoring/service";
import type { DimensionTotal, Factor, LeadLabel, MissingItem } from "@/lib/lead-scoring/types";

// What a person sees and does about a contact's priority: the current label with its reasons, the history, and the override a person can set
// (which the engine never writes over), plus a manual re-check and the workspace-level coverage.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const requireContact = (id: string) => {
  if (!UUID.test(id)) throw new AppError("not_found", "Contact not found.");
};

export interface AssessmentView {
  id: string;
  seq: number;
  score: number | null;
  label: LeadLabel;
  summary: string | null;
  factors: Factor[];
  missing: MissingItem[];
  dimensions: Record<string, DimensionTotal>;
  knownSignals: number;
  nextAction: { kind?: string; label?: string };
  aiStatus: string;
  rulePoints: number;
  aiPoints: number;
  engineVersion: string;
  profileVersion: number;
  trigger: string | null;
  evaluatedAt: string;
}

export interface PriorityView {
  contactId: string;
  score: number | null;
  label: LeadLabel | null;
  source: "engine" | "human" | null;
  reason: string | null;
  evaluatedAt: string | null;
  assessment: AssessmentView | null;
  override: { id: string; label: LeadLabel; score: number | null; reason: string; setBy: string | null; setAt: string; expiresAt: string | null } | null;
  /** When a person's override is in force: what the engine itself says, so nobody has to guess what was set aside. */
  engineSays: { label: LeadLabel; score: number | null } | null;
  recent: Array<{ seq: number; label: LeadLabel; score: number | null; at: string; trigger: string | null }>;
  lastChange: { from: LeadLabel | null; to: LeadLabel; at: string } | null;
  queued: boolean;
}

interface AssessmentRow {
  id: string; seq: number; score: number | null; label: LeadLabel; summary: string | null; factors: Factor[]; missing: MissingItem[]; dimensions: Record<string, DimensionTotal>;
  known_signals: number; next_action: { kind?: string; label?: string }; ai_status: string; rule_points: number; ai_points: number; engine_version: string; profile_version: number;
  trigger: string | null; created_at: Date;
}

const ASSESSMENT_COLUMNS = "id, seq, score, label, summary, factors, missing, dimensions, known_signals, next_action, ai_status, rule_points, ai_points, engine_version, profile_version, trigger, created_at";
const toAssessment = (a: AssessmentRow): AssessmentView => ({
  id: a.id, seq: a.seq, score: a.score, label: a.label, summary: a.summary, factors: a.factors, missing: a.missing, dimensions: a.dimensions, knownSignals: a.known_signals, nextAction: a.next_action,
  aiStatus: a.ai_status, rulePoints: a.rule_points, aiPoints: a.ai_points, engineVersion: a.engine_version, profileVersion: a.profile_version, trigger: a.trigger, evaluatedAt: iso(a.created_at)!,
});

export async function getPriority(actor: CrmActor, contactId: string): Promise<PriorityView> {
  assertCan(actor, "contacts.view");
  requireContact(contactId);
  return crmRead(actor, async (db) => {
    const c = (await db.query<{ priority_score: number | null; priority_label: LeadLabel | null; priority_source: "engine" | "human" | null; priority_reason: string | null; priority_evaluated_at: Date | null }>(
      "select priority_score, priority_label, priority_source, priority_reason, priority_evaluated_at from contacts where id = $1 and org_id = $2 and deleted_at is null", [contactId, actor.orgId],
    )).rows[0];
    if (!c) throw new AppError("not_found", "Contact not found.");
    const current = (await db.query<AssessmentRow>(`select ${ASSESSMENT_COLUMNS} from lead_score_assessments where contact_id = $1 and org_id = $2 and is_current`, [contactId, actor.orgId])).rows[0] ?? null;
    const override = (await db.query<{ id: string; label: LeadLabel; score: number | null; reason: string; set_at: Date; expires_at: Date | null; set_by_name: string | null }>(
      `select o.id, o.label, o.score, o.reason, o.set_at, o.expires_at, coalesce(nullif(u.full_name, ''), u.email::text) as set_by_name
       from lead_score_overrides o left join users u on u.id = o.set_by where o.contact_id = $1 and o.org_id = $2 and o.cleared_at is null`, [contactId, actor.orgId],
    )).rows[0] ?? null;
    const recent = (await db.query<{ seq: number; label: LeadLabel; score: number | null; created_at: Date; trigger: string | null }>(
      "select seq, label, score, created_at, trigger from lead_score_assessments where contact_id = $1 and org_id = $2 order by seq desc limit 8", [contactId, actor.orgId],
    )).rows;
    let lastChange: PriorityView["lastChange"] = null;
    for (let i = 0; i < recent.length; i += 1) {
      const next = recent[i + 1];
      if (!next || next.label !== recent[i].label) {
        lastChange = { from: next?.label ?? null, to: recent[i].label, at: iso(recent[i].created_at)! };
        break;
      }
    }
    const queued = (await db.query("select 1 from lead_score_queue where contact_id = $1 and org_id = $2", [contactId, actor.orgId])).rows.length > 0;
    return {
      contactId, score: c.priority_score, label: c.priority_label, source: c.priority_source, reason: c.priority_reason, evaluatedAt: iso(c.priority_evaluated_at),
      assessment: current ? toAssessment(current) : null,
      override: override ? { id: override.id, label: override.label, score: override.score, reason: override.reason, setBy: override.set_by_name, setAt: iso(override.set_at)!, expiresAt: iso(override.expires_at) } : null,
      engineSays: override && current ? { label: current.label, score: current.score } : null,
      recent: recent.map((r) => ({ seq: r.seq, label: r.label, score: r.score, at: iso(r.created_at)!, trigger: r.trigger })),
      lastChange, queued,
    };
  });
}

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

const overrideInput = z.strictObject({
  label: z.enum(["hot", "warm", "cold"]),
  score: z.number().int().min(0).max(100).nullable().optional(),
  reason: z.string().trim().min(3).max(300),
  expiresAt: z.string().datetime().nullable().optional(),
});
export type OverrideInput = z.infer<typeof overrideInput>;

const MAX_OVERRIDE_DAYS = 365;

/**
 * A person sets a contact's priority by hand. It stays until they clear it (or its date passes); the engine keeps assessing underneath and shows
 * what it would say, but never writes over it. The reason is required and kept with who set it and when.
 */
export async function setOverride(actor: CrmActor, contactId: string, raw: unknown, opts: { now?: Date } = {}): Promise<PriorityView> {
  assertCan(actor, "contacts.edit", "Changing a lead's priority needs permission to edit contacts.");
  requireContact(contactId);
  const parsed = overrideInput.safeParse(raw);
  if (!parsed.success) throw new AppError("invalid_input", parsed.error.issues[0]?.message ?? "Give a reason of at least three characters.");
  const now = opts.now ?? new Date();
  await crmWrite(actor, async (db) => {
    const r = await applyOverrideInTx(db, actor, contactId, parsed.data, now);
    if (!r.applied) throw new AppError("not_found", "Contact not found.");
  });
  return getPriority(actor, contactId);
}

/**
 * The override itself, inside the caller's transaction (a person's action and a workflow step both use it). With `keepPeople`, a teammate's override
 * that is still in force is left alone and nothing is written: automation never replaces what a person decided.
 */
export async function applyOverrideInTx(db: Queryable, actor: CrmActor, contactId: string, input: OverrideInput, now: Date, opts: { keepPeople?: boolean } = {}): Promise<{ applied: boolean; skipped?: "person_override" }> {
  const reason = input.reason.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  const expires = input.expiresAt ? new Date(input.expiresAt) : null;
  if (expires && (expires.getTime() <= now.getTime() || expires.getTime() > now.getTime() + MAX_OVERRIDE_DAYS * 86_400_000)) throw new AppError("invalid_input", "Choose an end date within the next year.");
  const c = (await db.query<{ priority_label: LeadLabel | null }>("select priority_label from contacts where id = $1 and org_id = $2 and deleted_at is null for update", [contactId, actor.orgId])).rows[0];
  if (!c) return { applied: false };
  if (opts.keepPeople) {
    const person = await db.query("select 1 from lead_score_overrides where contact_id = $1 and org_id = $2 and cleared_at is null and set_by is not null and (expires_at is null or expires_at > $3)", [contactId, actor.orgId, now]);
    if (person.rows.length) return { applied: false, skipped: "person_override" };
  }
  await db.query("update lead_score_overrides set cleared_at = $3, cleared_by = $4, clear_reason = 'replaced' where contact_id = $1 and org_id = $2 and cleared_at is null", [contactId, actor.orgId, now, actor.userId]);
  const ins = await db.query<{ id: string }>(
    "insert into lead_score_overrides (org_id, contact_id, label, score, reason, set_by, set_at, expires_at) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id",
    [actor.orgId, contactId, input.label, input.score ?? null, reason.slice(0, 300), actor.userId, now, expires],
  );
  await db.query(
    "update contacts set priority_label = $3, priority_score = $4, priority_source = 'human', priority_reason = $5, priority_evaluated_at = $6 where id = $1 and org_id = $2",
    [contactId, actor.orgId, input.label, input.score ?? null, `${actor.userId ? "Set by a teammate" : "Set by an automation"}: ${reason}`.slice(0, 240), now],
  );
  if (c.priority_label !== input.label) {
    await emitEvent(db, actor, { type: "lead.label_changed", entityType: "contact", entityId: contactId, contactId, payload: { label: input.label, previousLabel: c.priority_label, source: actor.userId ? "human" : "automation", overridden: true }, dedupeKey: `lead.label_changed:override:${ins.rows[0].id}` });
  }
  await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "lead_scoring.override_set", targetType: "contact", targetId: contactId, result: "success", metadata: { label: input.label, hasScore: input.score != null, expires: Boolean(expires), by: actor.userId ? "person" : "automation" } }, db);
  return { applied: true };
}

/** Returns the contact to the engine's latest assessment. */
export async function clearOverride(actor: CrmActor, contactId: string, opts: { now?: Date } = {}): Promise<PriorityView> {
  assertCan(actor, "contacts.edit", "Changing a lead's priority needs permission to edit contacts.");
  requireContact(contactId);
  const now = opts.now ?? new Date();
  await crmWrite(actor, async (db) => {
    const c = (await db.query<{ priority_label: LeadLabel | null }>("select priority_label from contacts where id = $1 and org_id = $2 and deleted_at is null for update", [contactId, actor.orgId])).rows[0];
    if (!c) throw new AppError("not_found", "Contact not found.");
    const cleared = await db.query<{ id: string }>("update lead_score_overrides set cleared_at = $3, cleared_by = $4, clear_reason = 'cleared_by_person' where contact_id = $1 and org_id = $2 and cleared_at is null returning id", [contactId, actor.orgId, now, actor.userId]);
    if (!cleared.rows[0]) throw new AppError("conflict", "There is no manual priority to clear.");
    const cur = (await db.query<{ id: string; score: number | null; label: LeadLabel; summary: string | null }>("select id, score, label, summary from lead_score_assessments where contact_id = $1 and org_id = $2 and is_current", [contactId, actor.orgId])).rows[0];
    if (cur) {
      await db.query(
        "update contacts set priority_score = $3, priority_label = $4, priority_source = 'engine', priority_assessment_id = $5, priority_reason = left($6, 240), priority_evaluated_at = $7 where id = $1 and org_id = $2",
        [contactId, actor.orgId, cur.score, cur.label, cur.id, cur.summary ?? "", now],
      );
      if (c.priority_label !== cur.label) {
        await emitEvent(db, actor, { type: "lead.label_changed", entityType: "contact", entityId: contactId, contactId, payload: { label: cur.label, previousLabel: c.priority_label, source: "engine", overridden: false }, dedupeKey: `lead.label_changed:clear:${cleared.rows[0].id}` });
      }
    } else {
      await db.query("update contacts set priority_score = null, priority_label = null, priority_source = null, priority_reason = null where id = $1 and org_id = $2", [contactId, actor.orgId]);
    }
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "lead_scoring.override_cleared", targetType: "contact", targetId: contactId, result: "success", metadata: {} }, db);
  });
  return getPriority(actor, contactId);
}

// ---------------------------------------------------------------------------
// Re-check now, backfill, coverage
// ---------------------------------------------------------------------------

/** A person (or a workflow step) asks for the contact to be assessed again right now. Limited to once a minute per contact so it can't be used to spend. */
export async function reassessNow(actor: CrmActor, contactId: string, opts: { now?: Date; trigger?: string } = {}): Promise<AssessOutcome> {
  assertCan(actor, "contacts.view");
  requireContact(contactId);
  const now = opts.now ?? new Date();
  const last = await crmRead(actor, async (db) => (await db.query<{ priority_evaluated_at: Date | null }>("select priority_evaluated_at from contacts where id = $1 and org_id = $2 and deleted_at is null", [contactId, actor.orgId])).rows[0]);
  if (!last) throw new AppError("not_found", "Contact not found.");
  if (last.priority_evaluated_at && now.getTime() - new Date(last.priority_evaluated_at).getTime() < 60_000) throw new AppError("rate_limited", "This lead was just assessed. Try again in a minute.");
  return assessContact(actor.orgId, contactId, { now, trigger: opts.trigger ?? "manual" });
}

/** Queues contacts that have never been assessed, a few hundred at a time. */
export async function backfillUnscored(actor: CrmActor, limit = 500): Promise<{ queued: number }> {
  assertCan(actor, "pipelines.manage", "Only a workspace owner or manager can score existing contacts.");
  return crmWrite(actor, async (db) => {
    const queued = await enqueueUnscored(db, actor.orgId, limit);
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "lead_scoring.backfill_requested", targetType: "lead_scoring_profile", targetId: actor.orgId, result: "success", metadata: { queued } }, db);
    return { queued };
  });
}

export interface ScoringStats {
  contacts: number;
  scored: number;
  byLabel: Record<LeadLabel, number>;
  overridden: number;
  queued: number;
  changedLast7Days: number;
  becameHotLast7Days: number;
  ai: { callsToday: number; failuresToday: number; assessmentsToday: number; estimatedInputTokens: number; estimatedOutputTokens: number; tokensAreEstimates: true };
  averageScore: number | null;
}

export async function scoringStats(actor: CrmActor, now = new Date()): Promise<ScoringStats> {
  assertCan(actor, "contacts.view");
  return crmRead(actor, async (db) => {
    const p = [actor.orgId];
    const labels = (await db.query<{ label: LeadLabel | null; n: string; avg: string | null; manual: string }>(
      "select priority_label as label, count(*)::text as n, avg(priority_score)::text as avg, count(*) filter (where priority_source = 'human')::text as manual from contacts where org_id = $1 and deleted_at is null group by 1", p,
    )).rows;
    const byLabel: Record<LeadLabel, number> = { hot: 0, warm: 0, cold: 0, insufficient_data: 0 };
    let contacts = 0, scored = 0, overridden = 0, sum = 0, nScored = 0;
    for (const r of labels) {
      const n = Number(r.n);
      contacts += n;
      overridden += Number(r.manual);
      if (r.label) {
        byLabel[r.label] = n;
        scored += n;
        if (r.avg !== null && r.label !== "insufficient_data") { sum += Number(r.avg) * n; nScored += n; }
      }
    }
    const queued = Number((await db.query<{ n: string }>("select count(*)::text as n from lead_score_queue where org_id = $1", p)).rows[0].n);
    const since = new Date(now.getTime() - 7 * 86_400_000);
    const changes = (await db.query<{ changed: string; hot: string }>(
      `select count(*) filter (where prev.label is distinct from a.label)::text as changed, count(*) filter (where a.label = 'hot' and prev.label is distinct from 'hot')::text as hot
       from lead_score_assessments a left join lead_score_assessments prev on prev.contact_id = a.contact_id and prev.seq = a.seq - 1 where a.org_id = $1 and a.created_at >= $2`, [actor.orgId, since],
    )).rows[0];
    const usage = (await db.query<{ ai_calls: number; ai_failures: number; assessments: number; input_tokens: number; output_tokens: number }>(
      "select ai_calls, ai_failures, assessments, input_tokens, output_tokens from lead_score_usage where org_id = $1 and day = $2", [actor.orgId, now.toISOString().slice(0, 10)],
    )).rows[0];
    return {
      contacts, scored, byLabel, overridden, queued, changedLast7Days: Number(changes.changed), becameHotLast7Days: Number(changes.hot),
      ai: { callsToday: usage?.ai_calls ?? 0, failuresToday: usage?.ai_failures ?? 0, assessmentsToday: usage?.assessments ?? 0, estimatedInputTokens: usage?.input_tokens ?? 0, estimatedOutputTokens: usage?.output_tokens ?? 0, tokensAreEstimates: true },
      averageScore: nScored ? Math.round(sum / nScored) : null,
    };
  });
}

