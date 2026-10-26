import "server-only";
import crypto from "node:crypto";
import { withSystem, type Queryable } from "@/server/db";
import { systemActor } from "@/server/crm/actor";
import { emitEvent } from "@/server/crm/events";
import { notifyOrgRoles } from "@/server/notifications";
import { scoreLead } from "@/lib/lead-scoring/engine";
import { ENGINE_VERSION, type AiSignals, type LeadLabel, type ScoreResult } from "@/lib/lead-scoring/types";
import { extractSignals, type ExtractionDeps, type ExtractionResult } from "@/server/lead-scoring/ai";
import type { ModelGateReason } from "@/server/llm/gate";
import { loadLeadFacts, recentInbound } from "@/server/lead-scoring/facts";
import { getProfile } from "@/server/lead-scoring/profile";

// One assessment of one contact. Three phases so a slow model call never holds a database transaction open: read the facts (and the customer's recent
// messages if extraction is on), extract signals, then score and write under a lock on the contact. The write refuses to replace a newer snapshot with
// an older one, writes nothing when the result is the same as the current assessment, and never overwrites a person's override.

// `aiSkipped` says why the model was not asked although extraction is on (the workspace is not active, is paused, or has no credit); the rules scored on their own.
export type AssessOutcome =
  | { outcome: "created"; assessmentId: string; label: LeadLabel; score: number | null; previousLabel: LeadLabel | null; labelChanged: boolean; aiSkipped?: ModelGateReason }
  | { outcome: "unchanged"; aiSkipped?: ModelGateReason }
  | { outcome: "stale" | "disabled" | "missing" };

export interface AssessOptions {
  now?: Date;
  trigger?: string;
  ai?: ExtractionDeps;
}

interface CurrentRow {
  id: string; seq: number; label: LeadLabel; score: number | null; inputs_hash: string; facts_as_of: Date; created_at: Date; ai_signals: AiSignals | null; ai_status: string;
}

const hashOf = (result: ScoreResult, profileVersion: number, aiStatus: string) =>
  crypto.createHash("sha256").update(`${ENGINE_VERSION}|${profileVersion}|${aiStatus}|${result.fingerprint}`).digest("hex");

export async function assessContact(orgId: string, contactId: string, opts: AssessOptions = {}): Promise<AssessOutcome> {
  const now = opts.now ?? new Date();

  // Phase 1: what is known right now.
  const read = await withSystem(async (db) => {
    const profile = await getProfile(db, orgId);
    if (!profile.enabled) return { disabled: true as const };
    const facts = await loadLeadFacts(db, orgId, contactId, now);
    if (!facts) return { missing: true as const };
    const prev = (await db.query<CurrentRow>(
      "select id, seq, label, score, inputs_hash, facts_as_of, created_at, ai_signals, ai_status from lead_score_assessments where contact_id = $1 and org_id = $2 and is_current",
      [contactId, orgId],
    )).rows[0] ?? null;
    const messages = profile.aiExtractionEnabled ? await recentInbound(db, orgId, contactId, now) : [];
    return { profile, facts, prev, messages };
  });
  if ("disabled" in read) return { outcome: "disabled" };
  if ("missing" in read) return { outcome: "missing" };
  const { profile, facts, prev, messages } = read;

  // Phase 2: signals from the customer's messages, only when there is something new to read.
  let ai: AiSignals | null = null;
  let aiStatus: "not_used" | "used" | "fallback" | "failed" | "skipped_limit" = "not_used";
  let aiModel: string | null = null;
  let aiSkipped: ModelGateReason | undefined;
  if (profile.aiExtractionEnabled && messages.length) {
    const newest = messages[messages.length - 1].at;
    if (prev?.ai_signals && prev.ai_status === "used" && newest.getTime() <= new Date(prev.facts_as_of).getTime()) {
      ai = prev.ai_signals;
      aiStatus = "used";
    } else {
      const r: ExtractionResult = await extractSignals(orgId, messages, { enabled: true, dailyLimit: profile.aiDailyLimit }, now, opts.ai);
      aiStatus = r.status;
      if (r.status === "fallback" && r.reason !== "no_model") aiSkipped = r.reason;
      if (r.status === "used") {
        ai = r.signals;
        aiModel = r.model;
      } else if (prev?.ai_signals && prev.ai_status === "used") {
        // The model was not available this time; what it said before about the same customer is still the best evidence of what they asked for.
        ai = prev.ai_signals;
      }
    }
  }

  // Phase 3: the score is a pure function of the facts; only then do we take the lock.
  const result = scoreLead({ ...facts, ai }, profile);
  const inputsHash = hashOf(result, profile.version, ai ? "ai" : "rules");

  return withSystem(async (db) => {
    await db.query("select 1 from contacts where id = $1 and org_id = $2 and deleted_at is null for update", [contactId, orgId]);
    const cur = (await db.query<CurrentRow>(
      "select id, seq, label, score, inputs_hash, facts_as_of, created_at, ai_signals, ai_status from lead_score_assessments where contact_id = $1 and org_id = $2 and is_current for update",
      [contactId, orgId],
    )).rows[0] ?? null;
    // An older snapshot never replaces a newer one: another worker finished a later assessment while this one was reading or waiting on the model.
    if (cur && new Date(cur.facts_as_of).getTime() > now.getTime()) return { outcome: "stale" as const };
    const override = await activeOverride(db, orgId, contactId, now);
    if (cur && cur.inputs_hash === inputsHash) {
      await db.query("update contacts set priority_evaluated_at = $3 where id = $1 and org_id = $2", [contactId, orgId, now]);
      await bumpUsage(db, orgId, now, 0);
      return { outcome: "unchanged" as const, ...(aiSkipped ? { aiSkipped } : {}) };
    }

    const seq = (cur?.seq ?? 0) + 1;
    if (cur) await db.query("update lead_score_assessments set is_current = false where id = $1", [cur.id]);
    const ins = await db.query<{ id: string }>(
      `insert into lead_score_assessments (org_id, contact_id, seq, score, label, rule_points, ai_points, factors, missing, dimensions, known_signals, summary, next_action, engine_version,
         profile_version, inputs_hash, facts_as_of, trigger, ai_signals, ai_status, ai_model, is_current)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, $13::jsonb, $14, $15, $16, $17, $18, $19::jsonb, $20, $21, true) returning id`,
      [
        orgId, contactId, seq, result.score, result.label, Math.round(result.rulePoints), Math.round(result.aiPoints), JSON.stringify(result.factors), JSON.stringify(result.missing),
        JSON.stringify(result.dimensions), result.knownSignals, result.summary.slice(0, 400), JSON.stringify(result.nextAction), ENGINE_VERSION, profile.version, inputsHash, now,
        (opts.trigger ?? "reassessment").slice(0, 60), ai ? JSON.stringify(ai) : null, aiStatus, aiModel,
      ],
    );
    const id = ins.rows[0].id;
    // The contact carries the current priority. A person's override stays in force; the engine's latest view is still stored and shown beside it.
    if (override) {
      await db.query("update contacts set priority_assessment_id = $3, priority_evaluated_at = $4 where id = $1 and org_id = $2", [contactId, orgId, id, now]);
    } else {
      await db.query(
        "update contacts set priority_score = $3, priority_label = $4, priority_source = 'engine', priority_assessment_id = $5, priority_evaluated_at = $6, priority_reason = $7 where id = $1 and org_id = $2",
        [contactId, orgId, result.score, result.label, id, now, result.summary.slice(0, 240)],
      );
    }
    await bumpUsage(db, orgId, now, 1);

    const previousLabel = cur?.label ?? null;
    const labelChanged = previousLabel !== result.label;
    const org = (await db.query<{ name: string; timezone: string }>("select name, timezone from organizations where id = $1", [orgId])).rows[0];
    const actor = systemActor({ id: orgId, name: org?.name, timezone: org?.timezone }, "Lead scoring");
    const base = { assessmentId: id, seq, score: result.score, label: result.label, previousScore: cur?.score ?? null, previousLabel, overridden: Boolean(override) };
    await emitEvent(db, actor, { type: "lead.score_updated", entityType: "contact", entityId: contactId, contactId, payload: base, dedupeKey: `lead.score_updated:${id}` });
    if (labelChanged) await emitEvent(db, actor, { type: "lead.label_changed", entityType: "contact", entityId: contactId, contactId, payload: base, dedupeKey: `lead.label_changed:${id}` });
    const scored = result.label !== "insufficient_data";
    if (scored && (previousLabel === null || previousLabel === "insufficient_data")) {
      await emitEvent(db, actor, { type: "lead.qualification_completed", entityType: "contact", entityId: contactId, contactId, payload: base, dedupeKey: `lead.qualification_completed:${id}` });
    }
    if (result.label === "hot" && previousLabel !== "hot") {
      await emitEvent(db, actor, { type: "lead.became_hot", entityType: "contact", entityId: contactId, contactId, payload: base, dedupeKey: `lead.became_hot:${id}` });
      // A notice only for a lead that turned hot, or a brand-new lead that arrived hot: a backfill of old contacts never floods the team.
      const fresh = now.getTime() - new Date(facts.contact.createdAt).getTime() < 24 * 3_600_000;
      if (!override && (previousLabel !== null || fresh)) {
        await notifyOrgRoles(db, orgId, ["owner", "admin"], {
          kind: "hot_lead_detected", severity: "info", title: "A lead just became hot", body: "Open the contact to see why and what to do next.", link: `/crm/contacts/${contactId}`,
          dedupeKey: `hot:${contactId}:${now.toISOString().slice(0, 10)}`,
        });
      }
    }
    return { outcome: "created" as const, assessmentId: id, label: result.label, score: result.score, previousLabel, labelChanged, ...(aiSkipped ? { aiSkipped } : {}) };
  });
}

/** The override in force for a contact, expiring it first if its time has passed. */
export async function activeOverride(db: Queryable, orgId: string, contactId: string, now: Date): Promise<{ id: string; label: LeadLabel; score: number | null; reason: string } | null> {
  const row = (await db.query<{ id: string; label: LeadLabel; score: number | null; reason: string; expires_at: Date | null }>(
    "select id, label, score, reason, expires_at from lead_score_overrides where contact_id = $1 and org_id = $2 and cleared_at is null for update",
    [contactId, orgId],
  )).rows[0];
  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() <= now.getTime()) {
    await db.query("update lead_score_overrides set cleared_at = $2, clear_reason = 'expired' where id = $1", [row.id, now]);
    // Back to the engine's latest assessment.
    await db.query(
      `update contacts c set priority_score = a.score, priority_label = a.label, priority_source = 'engine', priority_assessment_id = a.id, priority_reason = left(a.summary, 240)
       from lead_score_assessments a where c.id = $1 and c.org_id = $2 and a.contact_id = c.id and a.is_current`,
      [contactId, orgId],
    );
    return null;
  }
  return { id: row.id, label: row.label, score: row.score, reason: row.reason };
}

async function bumpUsage(db: Queryable, orgId: string, now: Date, assessments: number): Promise<void> {
  await db.query(
    "insert into lead_score_usage (org_id, day, assessments) values ($1, $2, $3) on conflict (org_id, day) do update set assessments = lead_score_usage.assessments + $3",
    [orgId, now.toISOString().slice(0, 10), assessments],
  );
}
