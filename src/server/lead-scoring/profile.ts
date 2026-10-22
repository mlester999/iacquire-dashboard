import "server-only";
import { z } from "zod";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { assertCan, auditActor, crmWrite, type CrmActor } from "@/server/crm/actor";
import { loadFieldDefinitions } from "@/server/crm/fields";
import {
  PRESET_KEYS, configProblems, criteriaConfigSchema, effectiveCriteria, fieldKeyOf, isProtectedField, type CriterionOverride, type PresetKey,
} from "@/lib/lead-scoring/criteria";
import type { EngineProfile } from "@/lib/lead-scoring/engine";

// A workspace's scoring profile: which criteria apply, how they are weighted, where Hot and Warm start, and whether a model may extract signals.
// Anyone who can see contacts reads it; owners and managers (pipelines.manage) change it. Every change is checked here, not only in the screen.

export interface ScoringProfile extends EngineProfile {
  enabled: boolean;
  aiExtractionEnabled: boolean;
  aiDailyLimit: number;
  debounceMinutes: number;
  version: number;
  updatedAt: string | null;
}

export const DEFAULT_PROFILE: ScoringProfile = {
  preset: "general", criteria: {}, hotMin: 70, warmMin: 40, minSignals: 3, enabled: true, aiExtractionEnabled: false, aiDailyLimit: 100, debounceMinutes: 10, version: 0, updatedAt: null,
};

interface ProfileRow {
  enabled: boolean; preset: PresetKey; criteria: Record<string, CriterionOverride>; hot_min: number; warm_min: number; min_signals: number; ai_extraction_enabled: boolean;
  ai_daily_limit: number; debounce_minutes: number; version: number; updated_at: Date;
}

export async function getProfile(db: Queryable, orgId: string): Promise<ScoringProfile> {
  const r = (await db.query<ProfileRow>("select enabled, preset, criteria, hot_min, warm_min, min_signals, ai_extraction_enabled, ai_daily_limit, debounce_minutes, version, updated_at from lead_scoring_profiles where org_id = $1", [orgId])).rows[0];
  if (!r) return { ...DEFAULT_PROFILE };
  return {
    enabled: r.enabled, preset: r.preset, criteria: r.criteria ?? {}, hotMin: r.hot_min, warmMin: r.warm_min, minSignals: r.min_signals, aiExtractionEnabled: r.ai_extraction_enabled,
    aiDailyLimit: r.ai_daily_limit, debounceMinutes: r.debounce_minutes, version: r.version, updatedAt: new Date(r.updated_at).toISOString(),
  };
}

export interface CriterionView {
  key: string;
  label: string;
  dimension: string;
  kind: "positive" | "penalty";
  weight: number;
  enabled: boolean;
  source: "rule" | "ai";
  params: Record<string, unknown>;
  /** A field the workspace has not created yet (so it can't score anyone). */
  fieldMissing: boolean;
}

/** The profile with every criterion that applies to it, for the settings screen. */
export async function readProfile(actor: CrmActor): Promise<{ profile: ScoringProfile; criteria: CriterionView[]; fields: Array<{ key: string; label: string; usable: boolean }> }> {
  assertCan(actor, "contacts.view");
  return withSystem(async (db) => {
    const profile = await getProfile(db, actor.orgId);
    const defs = await loadFieldDefinitions(db, actor.orgId, "contact");
    const have = new Set(defs.map((d) => d.key));
    const criteria = effectiveCriteria(profile.preset, profile.criteria).map((c) => ({
      key: c.def.key, label: c.def.label, dimension: c.def.dimension, kind: c.def.kind, weight: c.weight, enabled: c.enabled, source: c.def.source, params: c.params,
      fieldMissing: Boolean(fieldKeyOf(c.def.key)) && !have.has(fieldKeyOf(c.def.key)!),
    }));
    return { profile, criteria, fields: defs.map((d) => ({ key: d.key, label: d.label, usable: !isProtectedField(d.key, d.label) })) };
  });
}

const profileInput = z.strictObject({
  enabled: z.boolean().optional(),
  preset: z.enum(PRESET_KEYS).optional(),
  criteria: criteriaConfigSchema.optional(),
  hotMin: z.number().int().min(2).max(100).optional(),
  warmMin: z.number().int().min(1).max(99).optional(),
  minSignals: z.number().int().min(1).max(10).optional(),
  aiExtractionEnabled: z.boolean().optional(),
  aiDailyLimit: z.number().int().min(0).max(5000).optional(),
  debounceMinutes: z.number().int().min(1).max(1440).optional(),
  expectedVersion: z.number().int().min(0),
});
export type ProfileInput = z.infer<typeof profileInput>;

export async function saveProfile(actor: CrmActor, raw: unknown): Promise<ScoringProfile> {
  assertCan(actor, "pipelines.manage", "Only a workspace owner or manager can change how leads are scored.");
  const parsed = profileInput.safeParse(raw);
  if (!parsed.success) throw new AppError("invalid_input", parsed.error.issues[0]?.message ?? "Those settings aren't valid.");
  const input = parsed.data;
  return crmWrite(actor, async (db) => {
    await db.query("select 1 from lead_scoring_profiles where org_id = $1 for update", [actor.orgId]);
    const cur = await getProfile(db, actor.orgId);
    if (input.expectedVersion !== cur.version) throw new AppError("conflict", "These settings were changed by someone else. Reload and try again.");
    const next: ScoringProfile = {
      ...cur,
      enabled: input.enabled ?? cur.enabled,
      preset: input.preset ?? cur.preset,
      // A criteria object replaces the stored overrides; a preset change on its own keeps the workspace's own overrides.
      criteria: (input.criteria as Record<string, CriterionOverride> | undefined) ?? cur.criteria,
      hotMin: input.hotMin ?? cur.hotMin,
      warmMin: input.warmMin ?? cur.warmMin,
      minSignals: input.minSignals ?? cur.minSignals,
      aiExtractionEnabled: input.aiExtractionEnabled ?? cur.aiExtractionEnabled,
      aiDailyLimit: input.aiDailyLimit ?? cur.aiDailyLimit,
      debounceMinutes: input.debounceMinutes ?? cur.debounceMinutes,
    };
    if (next.warmMin >= next.hotMin) throw new AppError("invalid_input", "Hot must start above where Warm starts.");
    const problems = configProblems(next.preset, next.criteria);
    if (problems.length) throw new AppError("invalid_input", problems[0]);
    // A criterion on a custom field needs that field to exist, and a protected one never passes.
    const defs = await loadFieldDefinitions(db, actor.orgId, "contact");
    const have = new Map(defs.map((d) => [d.key, d]));
    for (const key of Object.keys(next.criteria)) {
      const fk = fieldKeyOf(key);
      if (!fk) continue;
      const def = have.get(fk);
      if (!def) throw new AppError("invalid_input", `There is no contact field "${fk}". Create it first, or remove the criterion.`);
      if (isProtectedField(def.key, def.label)) throw new AppError("invalid_input", `A field about "${def.label}" can't be used to score a lead.`);
    }
    await db.query(
      `insert into lead_scoring_profiles (org_id, enabled, preset, criteria, hot_min, warm_min, min_signals, ai_extraction_enabled, ai_daily_limit, debounce_minutes, version, updated_by)
       values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, 1, $11)
       on conflict (org_id) do update set enabled = excluded.enabled, preset = excluded.preset, criteria = excluded.criteria, hot_min = excluded.hot_min, warm_min = excluded.warm_min,
         min_signals = excluded.min_signals, ai_extraction_enabled = excluded.ai_extraction_enabled, ai_daily_limit = excluded.ai_daily_limit, debounce_minutes = excluded.debounce_minutes,
         version = lead_scoring_profiles.version + 1, updated_by = excluded.updated_by`,
      [actor.orgId, next.enabled, next.preset, JSON.stringify(next.criteria), next.hotMin, next.warmMin, next.minSignals, next.aiExtractionEnabled, next.aiDailyLimit, next.debounceMinutes, actor.userId],
    );
    const changed = (Object.keys(next) as Array<keyof ScoringProfile>).filter((k) => k !== "version" && k !== "updatedAt" && JSON.stringify(next[k]) !== JSON.stringify(cur[k]));
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "lead_scoring.profile_saved", targetType: "lead_scoring_profile", targetId: actor.orgId, result: "success", metadata: { changed } }, db);
    // New rules mean every contact's score may change: they are re-assessed, a few at a time, by the same queue as any other change.
    if (changed.length) await db.query(
      `insert into lead_score_queue (contact_id, org_id, trigger, not_before)
       select id, org_id, 'profile_changed', now() + interval '1 minute' from contacts where org_id = $1 and deleted_at is null and priority_label is not null
       on conflict (contact_id) do update set generation = lead_score_queue.generation + 1, trigger = excluded.trigger`,
      [actor.orgId],
    );
    return getProfile(db, actor.orgId);
  });
}
