import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { assertCan, auditActor, crmRead, type CrmActor } from "@/server/crm/actor";
import { applySettingsPatch, DEFAULT_REPUTATION_SETTINGS, settingsPatchSchema, type ReputationSettings } from "@/lib/reputation/settings";
import type { ScoreThresholds } from "@/lib/reputation/scores";

interface Row {
  escalate_at_or_below: number;
  nps_detractor_max: number;
  acknowledge_within_hours: number;
  public_review_alert_at_or_below: number;
  ai_replies_enabled: boolean;
  reply_style_note: string | null;
  sla_reminders_enabled: boolean;
  outcome_nudges_enabled: boolean;
  renewal_reminders_enabled: boolean;
  version: number;
}

const toSettings = (r: Row): ReputationSettings => ({
  escalateAtOrBelow: r.escalate_at_or_below,
  npsDetractorMax: r.nps_detractor_max,
  acknowledgeWithinHours: r.acknowledge_within_hours,
  publicReviewAlertAtOrBelow: r.public_review_alert_at_or_below,
  aiRepliesEnabled: r.ai_replies_enabled,
  replyStyleNote: r.reply_style_note,
  slaRemindersEnabled: r.sla_reminders_enabled,
  outcomeNudgesEnabled: r.outcome_nudges_enabled,
  renewalRemindersEnabled: r.renewal_reminders_enabled,
  version: r.version,
  isDefault: false,
});

const COLUMNS = `escalate_at_or_below, nps_detractor_max, acknowledge_within_hours, public_review_alert_at_or_below, ai_replies_enabled, reply_style_note,
  sla_reminders_enabled, outcome_nudges_enabled, renewal_reminders_enabled, version`;

/** A workspace's settings, or the defaults when it never saved any. Reads the one workspace it is given. */
export async function loadSettings(db: Queryable, orgId: string): Promise<ReputationSettings> {
  const { rows } = await db.query<Row>(`select ${COLUMNS} from reputation_settings where org_id = $1`, [orgId]);
  return rows[0] ? toSettings(rows[0]) : { ...DEFAULT_REPUTATION_SETTINGS };
}

export const thresholdsOf = (s: ReputationSettings): ScoreThresholds => ({ escalateAtOrBelow: s.escalateAtOrBelow, npsDetractorMax: s.npsDetractorMax });

/** The workspace's settings for the Reviews screen. Anyone who can open contacts reads them. */
export async function getReputationSettings(actor: CrmActor): Promise<ReputationSettings> {
  assertCan(actor, "contacts.view");
  return crmRead(actor, (db) => loadSettings(db, actor.orgId));
}

/**
 * Changes the workspace's reputation settings. They decide what counts as low feedback from now on (feedback already received keeps the decision made when it arrived) and
 * which optional internal assists run, so an owner or manager in the client's own workspace changes them; iAcquire support can look but not change them. Two people
 * saving together cannot both win: the second is told to reload.
 */
export async function saveReputationSettings(actor: CrmActor, input: unknown, expectedVersion: number): Promise<ReputationSettings> {
  assertCan(actor, "reviews.manage", "Only owners and managers can change the reputation settings.");
  if (actor.kind !== "member" || !actor.userId) throw new AppError("forbidden", "The reputation settings are changed by someone in the client's own workspace. iAcquire support can look but not change them.");
  const parsed = settingsPatchSchema.safeParse(input);
  if (!parsed.success) throw new AppError("invalid_input", parsed.error.issues[0]?.message ?? "Check the settings.");
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) throw new AppError("invalid_input", "Reload the page and try again.");
  return withSystem(async (db) => {
    const cur = await loadSettings(db, actor.orgId);
    if (cur.version !== expectedVersion) throw new AppError("conflict", "Someone else changed these settings. Reload to see their changes, then try again.");
    const next = applySettingsPatch(cur, parsed.data);
    const saved = await db.query(
      `insert into reputation_settings (org_id, escalate_at_or_below, nps_detractor_max, acknowledge_within_hours, public_review_alert_at_or_below, ai_replies_enabled, reply_style_note,
         sla_reminders_enabled, outcome_nudges_enabled, renewal_reminders_enabled, version, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, $11)
       on conflict (org_id) do update set escalate_at_or_below = excluded.escalate_at_or_below, nps_detractor_max = excluded.nps_detractor_max,
         acknowledge_within_hours = excluded.acknowledge_within_hours, public_review_alert_at_or_below = excluded.public_review_alert_at_or_below, ai_replies_enabled = excluded.ai_replies_enabled,
         reply_style_note = excluded.reply_style_note, sla_reminders_enabled = excluded.sla_reminders_enabled, outcome_nudges_enabled = excluded.outcome_nudges_enabled,
         renewal_reminders_enabled = excluded.renewal_reminders_enabled, version = reputation_settings.version + 1, updated_by = excluded.updated_by, updated_at = now()
       where reputation_settings.version = $12
       returning version`,
      [actor.orgId, next.escalateAtOrBelow, next.npsDetractorMax, next.acknowledgeWithinHours, next.publicReviewAlertAtOrBelow, next.aiRepliesEnabled, next.replyStyleNote,
        next.slaRemindersEnabled, next.outcomeNudgesEnabled, next.renewalRemindersEnabled, actor.userId, expectedVersion],
    );
    // Two saves can pass the check above together; only one changes the row. The other changed nothing, so it must not say it did (or be audited as if).
    if (!saved.rows[0]) throw new AppError("conflict", "Someone else changed these settings. Reload to see their changes, then try again.");
    await recordAudit({
      orgId: actor.orgId, ...auditActor(actor), action: "reputation.settings_saved", targetType: "reputation_settings", targetId: actor.orgId, result: "success",
      metadata: {
        escalateAtOrBelow: next.escalateAtOrBelow, npsDetractorMax: next.npsDetractorMax, acknowledgeWithinHours: next.acknowledgeWithinHours, aiRepliesEnabled: next.aiRepliesEnabled,
        slaRemindersEnabled: next.slaRemindersEnabled, outcomeNudgesEnabled: next.outcomeNudgesEnabled, renewalRemindersEnabled: next.renewalRemindersEnabled,
        publicReviewAlertAtOrBelow: next.publicReviewAlertAtOrBelow,
      },
    }, db);
    return loadSettings(db, actor.orgId);
  });
}
