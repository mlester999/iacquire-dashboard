import "server-only";
import type { Queryable } from "@/server/db";
import { confirmedAnswers } from "@/lib/onboarding/engine";
import { answerPatchesFor, deriveProfile, legacyBaseline, parseProfileSnapshot, snapshotAfterSettings, type ProfileKey, type ProfileSnapshot, type ProfileValues } from "@/lib/onboarding/business-profile";
import { answerTimes, loadAnswerRows, toStored } from "@/server/onboarding/answers";

// The business profile has two editors, Settings > Business profile and the onboarding questionnaire, and they write the same columns (writeBusinessProfile in
// src/server/settings/service.ts). When Settings changes a fact, the answer it came from changes too, so the questionnaire shows what the workspace says and nobody is
// asked twice; and the snapshot of the last submission moves with it, so a later re-submission does not write that fact back from stale answers.

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

/**
 * Brings the answers (and, for a workspace that has been submitted, the snapshot) in step with a Settings edit of `changed`, inside the caller's transaction. Does nothing
 * for a workspace whose questionnaire has not been started: its answers are prefilled from the profile when it is.
 */
export async function syncProfileToAnswers(
  db: Queryable,
  ctx: { org: { orgId: string }; user: { id: string } },
  input: { changed: readonly ProfileKey[]; values: ProfileValues },
): Promise<{ answered: string[] }> {
  if (!input.changed.length) return { answered: [] };
  const orgId = ctx.org.orgId;
  const row = await lockOnboardingRow(db, orgId);
  const before = await loadAnswerRows(db, orgId);
  if (!before.length) return { answered: [] };

  const storedBefore = toStored(before);
  const current = Object.fromEntries(Object.entries(storedBefore).filter(([, a]) => !a.skipped && a.value !== null && a.value !== undefined).map(([id, a]) => [id, a.value]));
  const patches = answerPatchesFor(input.changed, input.values, current).filter((p) => {
    const was = storedBefore[p.id];
    return !was || was.skipped || JSON.stringify(was.value) !== JSON.stringify(p.value);
  });
  for (const p of patches) {
    await db.query(
      `insert into onboarding_answers (org_id, question_id, value, skipped, source, needs_confirmation, answered_by) values ($1, $2, $3, false, 'user', false, $4)
       on conflict (org_id, question_id) do update set value = excluded.value, skipped = false, source = 'user', needs_confirmation = false, answered_by = excluded.answered_by`,
      [orgId, p.id, JSON.stringify(p.value), ctx.user.id],
    );
  }

  if (row.status === "submitted" && row.submittedAt) {
    const after = await loadAnswerRows(db, orgId);
    const derivedBefore = deriveProfile(confirmedAnswers(storedBefore));
    const derivedAfter = deriveProfile(confirmedAnswers(toStored(after)));
    // A submission from before snapshots existed has none: what it applied is what the answers said, except for the answers edited since.
    const prior = row.snapshot ?? { version: 1 as const, fields: legacyBaseline(derivedBefore, answerTimes(before), row.submittedAt.getTime()), appliedThrough: null };
    const times = answerTimes(before);
    const through = appliedThrough({ snapshot: row.snapshot, submittedAt: row.submittedAt });
    const waiting = Object.values(times).some((t) => t > through);
    const now = (await db.query<{ t: Date }>("select now() as t")).rows[0].t;
    const next = snapshotAfterSettings(prior, derivedAfter, input.changed, { advanceTo: waiting ? null : new Date(now) });
    await db.query("update onboarding_responses set submitted_snapshot = $2::jsonb where org_id = $1", [orgId, JSON.stringify(next)]);
  }
  return { answered: patches.map((p) => p.id) };
}
