import "server-only";
import type { Queryable } from "@/server/db";
import { confirmedAnswers } from "@/lib/onboarding/engine";
import type { Answers } from "@/lib/onboarding/types";
import type { BusinessHours } from "@/lib/messaging";
import {
  answerPatchesFor, baselineOf, deriveMessaging, derivePreferences, deriveProfile, legacyBaseline, messagingAnswerPatches, parseProfileSnapshot,
  preferenceAnswerPatches, snapshotAfterSettings, snapshotWithExtras, MESSAGING_ANSWERS, MESSAGING_KEYS, PREFERENCE_ANSWERS, PREFERENCE_KEYS,
  type MessagingKey, type MessagingValues, type PreferenceKey, type PreferenceValues, type ProfileKey, type ProfileSnapshot, type ProfileValues,
} from "@/lib/onboarding/business-profile";
import { answerTimes, loadAnswerRows, toStored, type AnswerRow } from "@/server/onboarding/answers";

// The business profile has two editors, Settings > Business profile and the onboarding questionnaire, and they write the same columns (writeBusinessProfile in
// src/server/settings/service.ts). When Settings changes a fact, the answer it came from changes too, so the questionnaire shows what the workspace says and nobody is
// asked twice; and the snapshot of the last submission moves with it, so a later re-submission does not write that fact back from stale answers.
// Settings > Messaging (opening hours, reply hours, follow-up style) and Settings > AI preferences are two more of the same, and follow the same rule.

export interface SnapshotRow {
  snapshot: ProfileSnapshot | null;
  status: "draft" | "submitted" | null;
  submittedAt: Date | null;
}

/** The questionnaire's row for a workspace, locked for the rest of the transaction so a Settings edit and a submission cannot interleave. */
export async function lockOnboardingRow(db: Queryable, orgId: string): Promise<SnapshotRow> {
  const { rows } = await db.query<{ status: "draft" | "submitted"; submitted_at: Date | null; submitted_snapshot: unknown }>(
    "select status, submitted_at, submitted_snapshot from onboarding_responses where org_id = $1 for update",
    [orgId],
  );
  const r = rows[0];
  return { snapshot: r ? parseProfileSnapshot(r.submitted_snapshot) : null, status: r?.status ?? null, submittedAt: r?.submitted_at ? new Date(r.submitted_at) : null };
}

/** The moment up to which answer edits are known to be in the live workspace: the later of the last submission and the last Settings edit that left nothing waiting. */
export function appliedThrough(row: Pick<SnapshotRow, "snapshot" | "submittedAt">): number {
  const edited = row.snapshot?.appliedThrough ? Date.parse(row.snapshot.appliedThrough) : 0;
  return Math.max(row.submittedAt?.getTime() ?? 0, Number.isFinite(edited) ? edited : 0);
}

type Ctx = { org: { orgId: string }; user: { id: string } };
type StoredBefore = ReturnType<typeof toStored>;

/** The answers as the person currently has them: saved, not skipped, not empty. */
function currentAnswers(stored: StoredBefore): Answers {
  return Object.fromEntries(Object.entries(stored).filter(([, a]) => !a.skipped && a.value !== null && a.value !== undefined).map(([id, a]) => [id, a.value]));
}

/** Saves answers a Settings edit corresponds to, as the person's own, and says which ones actually differed. */
async function writePatches(db: Queryable, ctx: Ctx, stored: StoredBefore, patches: Array<{ id: string; value: unknown }>): Promise<string[]> {
  const changed = patches.filter((p) => {
    const was = stored[p.id];
    return !was || was.skipped || JSON.stringify(was.value) !== JSON.stringify(p.value);
  });
  for (const p of changed) {
    await db.query(
      `insert into onboarding_answers (org_id, question_id, value, skipped, source, needs_confirmation, answered_by) values ($1, $2, $3, false, 'user', false, $4)
       on conflict (org_id, question_id) do update set value = excluded.value, skipped = false, source = 'user', needs_confirmation = false, answered_by = excluded.answered_by`,
      [ctx.org.orgId, p.id, JSON.stringify(p.value), ctx.user.id],
    );
  }
  return changed.map((p) => p.id);
}

/**
 * Stores the snapshot after a Settings edit. A submission from before snapshots existed has none: what it applied is what the answers said, except for the answers edited since.
 * The applied-through moment moves forward only when nothing else was waiting in the questionnaire.
 */
async function writeSnapshot(db: Queryable, orgId: string, row: SnapshotRow, before: AnswerRow[], build: (prior: ProfileSnapshot, advanceTo: Date | null) => ProfileSnapshot): Promise<void> {
  if (row.status !== "submitted" || !row.submittedAt) return;
  const times = answerTimes(before);
  const prior = row.snapshot ?? { version: 1 as const, fields: legacyBaseline(deriveProfile(confirmedAnswers(toStored(before))), times, row.submittedAt.getTime()), appliedThrough: null };
  const through = appliedThrough({ snapshot: row.snapshot, submittedAt: row.submittedAt });
  const waiting = Object.values(times).some((t) => t > through);
  const now = (await db.query<{ t: Date }>("select now() as t")).rows[0].t;
  const next = build(prior, waiting ? null : new Date(now));
  await db.query("update onboarding_responses set submitted_snapshot = $2::jsonb where org_id = $1", [orgId, JSON.stringify(next)]);
}

/**
 * Brings the answers (and, for a workspace that has been submitted, the snapshot) in step with a Settings edit of `changed`, inside the caller's transaction. Does nothing
 * for a workspace whose questionnaire has not been started: its answers are prefilled from the profile when it is.
 */
export async function syncProfileToAnswers(
  db: Queryable,
  ctx: Ctx,
  input: { changed: readonly ProfileKey[]; values: ProfileValues },
): Promise<{ answered: string[] }> {
  if (!input.changed.length) return { answered: [] };
  const orgId = ctx.org.orgId;
  const row = await lockOnboardingRow(db, orgId);
  const before = await loadAnswerRows(db, orgId);
  if (!before.length) return { answered: [] };

  const storedBefore = toStored(before);
  const answered = await writePatches(db, ctx, storedBefore, answerPatchesFor(input.changed, input.values, currentAnswers(storedBefore)));
  if (row.status === "submitted" && row.submittedAt) {
    const after = deriveProfile(confirmedAnswers(toStored(await loadAnswerRows(db, orgId))));
    await writeSnapshot(db, orgId, row, before, (prior, advanceTo) => snapshotAfterSettings(prior, after, input.changed, { advanceTo }));
  }
  return { answered };
}

/**
 * Settings > Messaging changed the opening hours, the reply hours or the follow-up style: the answers they come from follow, so the questionnaire shows what the workspace says,
 * the snapshot moves with them so a later re-submission does not write the old answer back, and the opening-hours knowledge text is rewritten when nobody has edited it. Only
 * what the edit named is touched. A custom follow-up schedule has no answer and changes nothing here. Does nothing for a workspace whose questionnaire was not started.
 * Takes the questionnaire's row first, as a submission does.
 */
export async function syncMessagingToAnswers(
  db: Queryable,
  ctx: Ctx,
  input: { businessHours?: BusinessHours; replyBusinessHoursOnly?: boolean; followUpPreset?: string },
): Promise<{ answered: string[]; knowledge: { written: string[]; kept: string[] } }> {
  const knowledge = { written: [] as string[], kept: [] as string[] };
  const orgId = ctx.org.orgId;
  const row = await lockOnboardingRow(db, orgId);
  const before = await loadAnswerRows(db, orgId);
  if (!before.length) return { answered: [], knowledge };

  const storedBefore = toStored(before);
  const patches = messagingAnswerPatches(input, currentAnswers(storedBefore));
  const answered = await writePatches(db, ctx, storedBefore, patches);
  const after = await loadAnswerRows(db, orgId);
  const derived = deriveMessaging(confirmedAnswers(toStored(after)));
  const patched: Partial<MessagingValues> = {};
  for (const p of patches) patched[p.key] = derived[p.key];
  if (patches.length) await writeSnapshot(db, orgId, row, before, (prior, advanceTo) => snapshotWithExtras(prior, { messaging: patched }, { advanceTo }));

  // The knowledge text is the opening hours the client wrote down. It is written again only for a workspace that has been submitted (that is when it is first seeded) and only
  // when nobody has edited it since; employee-sync imports this file, so it is loaded when needed.
  if (row.status === "submitted" && answered.includes("a.hours")) {
    const answers = confirmedAnswers(toStored(after));
    const tz = (await db.query<{ timezone: string }>("select timezone from organizations where id = $1", [orgId])).rows[0]?.timezone;
    const { seedKnowledgeFromAnswers } = await import("@/server/onboarding/employee-sync");
    await seedKnowledgeFromAnswers(db, { orgId, userId: ctx.user.id }, { "a.hours": answers["a.hours"], ...(answers["a.timezone"] && tz ? { "a.timezone": tz } : {}) }, knowledge);
  }
  return { answered, knowledge };
}

/**
 * Settings > AI preferences changed these preferences: the answers they come from follow (the same way a Settings profile edit changes its answers), the snapshot moves with
 * them, and a re-submission writes a preference only when its answers changed. The hand-off preference has no answer to write. Does nothing for a workspace whose
 * questionnaire was not started. Takes the questionnaire's row first, as a submission does.
 */
export async function syncPreferencesToAnswers(
  db: Queryable,
  ctx: Ctx,
  input: { changed: readonly PreferenceKey[]; values: PreferenceValues },
): Promise<{ answered: string[] }> {
  if (!input.changed.length) return { answered: [] };
  const orgId = ctx.org.orgId;
  const row = await lockOnboardingRow(db, orgId);
  const before = await loadAnswerRows(db, orgId);
  if (!before.length) return { answered: [] };

  const storedBefore = toStored(before);
  const patches = preferenceAnswerPatches(input.changed, input.values, currentAnswers(storedBefore));
  const answered = await writePatches(db, ctx, storedBefore, patches);
  const derived = derivePreferences(confirmedAnswers(toStored(await loadAnswerRows(db, orgId))));
  const patched: Partial<PreferenceValues> = {};
  for (const p of patches) patched[p.key] = derived[p.key];
  if (patches.length) await writeSnapshot(db, orgId, row, before, (prior, advanceTo) => snapshotWithExtras(prior, { prefs: patched }, { advanceTo }));
  return { answered };
}

/**
 * What a submission has already applied for the messaging values and the preferences, key by key, from the snapshot of the last submission (or the answers' edit times for a
 * snapshot that does not hold a key). null for a first submission, which writes everything.
 */
export function submissionBaselines(
  row: Pick<SnapshotRow, "snapshot" | "submittedAt" | "status">,
  rows: AnswerRow[],
  derived: { messaging: MessagingValues; prefs: PreferenceValues },
): { messaging: Partial<MessagingValues>; prefs: Partial<PreferenceValues> } | null {
  if (row.status !== "submitted") return null;
  const times = answerTimes(rows);
  const at = row.submittedAt?.getTime() ?? 0;
  return {
    messaging: baselineOf<MessagingKey>(MESSAGING_KEYS, MESSAGING_ANSWERS, derived.messaging, row.snapshot?.messaging, times, at),
    prefs: baselineOf<PreferenceKey>(PREFERENCE_KEYS, PREFERENCE_ANSWERS, derived.prefs, row.snapshot?.prefs, times, at),
  };
}
