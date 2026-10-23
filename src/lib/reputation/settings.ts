// A workspace's reputation settings: when low private feedback needs a person, how long the team has to acknowledge it, and what the optional assists do.
// Pure: the same checks run in the form and on the server. Every default below is a proposal until the owner of the product confirms it.
import { z } from "zod";
import { DEFAULT_THRESHOLDS, THRESHOLD_LIMITS } from "@/lib/reputation/scores";

export interface ReputationSettings {
  /** A one-to-five rating at or below this is low private feedback. */
  escalateAtOrBelow: number;
  /** A zero-to-ten score at or below this is low private feedback. */
  npsDetractorMax: number;
  /** Hours the team has to acknowledge low feedback before the owner and managers are reminded, once. */
  acknowledgeWithinHours: number;
  /** A public review at or below this many stars is announced to the team (used once public reviews are synced). */
  publicReviewAlertAtOrBelow: number;
  /** Off until someone turns it on. Even then a draft is a person-started assist, labelled AI-drafted, and a person approves and posts it. */
  aiRepliesEnabled: boolean;
  /** Plain guidance for the tone of drafted replies ("warm, short, no exclamation marks"). Never a claim or a price. */
  replyStyleNote: string | null;
  /** Remind the owner and managers once when low feedback has not been acknowledged in time. On unless switched off. */
  slaRemindersEnabled: boolean;
  /** A daily internal notice when finished appointments have no recorded outcome. Off until switched on: nothing is ever marked attended for anyone. */
  outcomeNudgesEnabled: boolean;
  version: number;
  /** True when nothing was ever saved for the workspace, so these are the defaults. */
  isDefault: boolean;
}

export const SETTING_LIMITS = {
  acknowledgeWithinHours: { min: 1, max: 168 },
  publicReviewAlertAtOrBelow: { min: 1, max: 4 },
  replyStyleNoteMax: 600,
} as const;

export const DEFAULT_REPUTATION_SETTINGS: ReputationSettings = {
  escalateAtOrBelow: DEFAULT_THRESHOLDS.escalateAtOrBelow,
  npsDetractorMax: DEFAULT_THRESHOLDS.npsDetractorMax,
  acknowledgeWithinHours: 24,
  publicReviewAlertAtOrBelow: 3,
  aiRepliesEnabled: false,
  replyStyleNote: null,
  slaRemindersEnabled: true,
  outcomeNudgesEnabled: false,
  version: 0,
  isDefault: true,
};

const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const whole = (min: number, max: number, what: string) =>
  z.number({ error: `${what} must be a whole number.` }).int({ error: `${what} must be a whole number.` }).min(min, { error: `${what} can't be lower than ${min}.` }).max(max, { error: `${what} can't be higher than ${max}.` });

/** What a person may change. Anything not named is left as it was; anything not listed here is refused. */
export const settingsPatchSchema = z.strictObject({
  escalateAtOrBelow: whole(THRESHOLD_LIMITS.escalateAtOrBelow.min, THRESHOLD_LIMITS.escalateAtOrBelow.max, "The star level for a follow-up").optional(),
  npsDetractorMax: whole(THRESHOLD_LIMITS.npsDetractorMax.min, THRESHOLD_LIMITS.npsDetractorMax.max, "The recommend-score level for a follow-up").optional(),
  acknowledgeWithinHours: whole(SETTING_LIMITS.acknowledgeWithinHours.min, SETTING_LIMITS.acknowledgeWithinHours.max, "The time to acknowledge").optional(),
  publicReviewAlertAtOrBelow: whole(SETTING_LIMITS.publicReviewAlertAtOrBelow.min, SETTING_LIMITS.publicReviewAlertAtOrBelow.max, "The star level for a public review alert").optional(),
  aiRepliesEnabled: z.boolean().optional(),
  replyStyleNote: z.string().max(4000).refine((s) => squash(s).length <= SETTING_LIMITS.replyStyleNoteMax, { error: `Keep the reply style note to ${SETTING_LIMITS.replyStyleNoteMax} characters.` }).nullable().optional(),
  slaRemindersEnabled: z.boolean().optional(),
  outcomeNudgesEnabled: z.boolean().optional(),
});
export type ReputationSettingsPatch = z.infer<typeof settingsPatchSchema>;

/** A style note as stored: one line of plain text, at most 600 characters, or nothing. */
export function cleanStyleNote(v: string | null | undefined): string | null {
  const s = squash(v ?? "").slice(0, SETTING_LIMITS.replyStyleNoteMax);
  return s || null;
}

/** The settings with a patch applied (already validated). Version and isDefault are the store's to change. */
export function applySettingsPatch(cur: ReputationSettings, patch: ReputationSettingsPatch): ReputationSettings {
  return {
    ...cur,
    escalateAtOrBelow: patch.escalateAtOrBelow ?? cur.escalateAtOrBelow,
    npsDetractorMax: patch.npsDetractorMax ?? cur.npsDetractorMax,
    acknowledgeWithinHours: patch.acknowledgeWithinHours ?? cur.acknowledgeWithinHours,
    publicReviewAlertAtOrBelow: patch.publicReviewAlertAtOrBelow ?? cur.publicReviewAlertAtOrBelow,
    aiRepliesEnabled: patch.aiRepliesEnabled ?? cur.aiRepliesEnabled,
    replyStyleNote: patch.replyStyleNote !== undefined ? cleanStyleNote(patch.replyStyleNote) : cur.replyStyleNote,
    slaRemindersEnabled: patch.slaRemindersEnabled ?? cur.slaRemindersEnabled,
    outcomeNudgesEnabled: patch.outcomeNudgesEnabled ?? cur.outcomeNudgesEnabled,
  };
}
