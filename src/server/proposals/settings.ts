import "server-only";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { assertCan, auditActor, crmRead, crmWrite, type CrmActor } from "@/server/crm/actor";
import { assertProposalsEnabled } from "@/server/proposals/features";
import { readSettings, type SettingsRow } from "@/server/proposals/core";
import { DOC_LIMITS } from "@/lib/proposals/doc";

export type ProposalSettings = SettingsRow;

export async function getProposalSettings(actor: CrmActor): Promise<ProposalSettings> {
  await assertProposalsEnabled(actor.orgId);
  assertCan(actor, "proposals.view", "Your role can't see proposals.");
  return crmRead(actor, (db) => readSettings(db, actor.orgId));
}

export interface SettingsPatch {
  aiDraftsEnabled?: boolean;
  approvalMode?: "ai_and_discounts" | "all";
  approvalOverMinor?: number | null;
  discountNeedsApproval?: boolean;
  twoPerson?: boolean;
  defaultValidityDays?: number | null;
  tagOnSendId?: string | null;
  stageOnSendId?: string | null;
  dealOnAccept?: "none" | "won_stage";
}

async function assertTag(db: Queryable, orgId: string, id: string) {
  if (!(await db.query("select 1 from crm_tags where id = $1 and org_id = $2", [id, orgId])).rows[0]) throw new AppError("invalid_input", "Choose one of your tags.");
}

/** A stage a sent proposal can move a deal into: an open stage of a live pipeline of this workspace. Moving a deal to Won or Lost is not something sending does. */
async function assertOpenStage(db: Queryable, orgId: string, id: string) {
  const { rows } = await db.query<{ kind: string }>(
    `select s.kind from crm_pipeline_stages s join crm_pipelines p on p.id = s.pipeline_id and p.org_id = s.org_id
     where s.id = $1 and s.org_id = $2 and s.archived_at is null and p.archived_at is null and p.provider = 'native'`, [id, orgId],
  );
  if (!rows[0]) throw new AppError("invalid_input", "Choose one of your pipeline stages.");
  if (rows[0].kind !== "open") throw new AppError("invalid_input", "Sending a proposal can only move a deal to an open stage, not to Won or Lost.");
}

/**
 * The workspace's rules for proposals. Only the owner changes them. Nothing here can let an AI draft go out without a person's approval, and nothing is on until the owner
 * turns it on. `expectedVersion` is the version the owner was looking at (0 when settings were never saved): two people cannot overwrite each other.
 */
export async function saveProposalSettings(actor: CrmActor, patch: SettingsPatch, expectedVersion: number): Promise<ProposalSettings> {
  await assertProposalsEnabled(actor.orgId);
  assertCan(actor, "proposals.settings", "Only the business owner can change the proposal settings.");
  if (patch.approvalMode !== undefined && patch.approvalMode !== "ai_and_discounts" && patch.approvalMode !== "all") throw new AppError("invalid_input", "Choose which proposals are reviewed.");
  if (patch.dealOnAccept !== undefined && patch.dealOnAccept !== "none" && patch.dealOnAccept !== "won_stage") throw new AppError("invalid_input", "Choose what happens to the deal when a proposal is accepted.");
  const over = patch.approvalOverMinor;
  if (over !== undefined && over !== null && (!Number.isSafeInteger(over) || over < 1 || over > DOC_LIMITS.maxMinor)) throw new AppError("invalid_input", "The approval amount must be a positive whole number of minor units, or empty.");
  const days = patch.defaultValidityDays;
  if (days !== undefined && days !== null && (!Number.isInteger(days) || days < 1 || days > 365)) throw new AppError("invalid_input", "A proposal can stay valid for 1 to 365 days.");
  return crmWrite(actor, async (db) => {
    const cur = await readSettings(db, actor.orgId);
    if (cur.version !== expectedVersion) throw new AppError("conflict", "Someone else changed these settings. Reload to see their changes, then try again.");
    const next: SettingsRow = {
      aiDraftsEnabled: patch.aiDraftsEnabled ?? cur.aiDraftsEnabled,
      approvalMode: patch.approvalMode ?? cur.approvalMode,
      approvalOverMinor: over !== undefined ? over : cur.approvalOverMinor,
      discountNeedsApproval: patch.discountNeedsApproval ?? cur.discountNeedsApproval,
      twoPerson: patch.twoPerson ?? cur.twoPerson,
      defaultValidityDays: days !== undefined ? days : cur.defaultValidityDays,
      tagOnSendId: patch.tagOnSendId !== undefined ? patch.tagOnSendId : cur.tagOnSendId,
      stageOnSendId: patch.stageOnSendId !== undefined ? patch.stageOnSendId : cur.stageOnSendId,
      dealOnAccept: patch.dealOnAccept ?? cur.dealOnAccept,
      version: cur.version,
    };
    if (next.tagOnSendId && next.tagOnSendId !== cur.tagOnSendId) await assertTag(db, actor.orgId, next.tagOnSendId);
    if (next.stageOnSendId && next.stageOnSendId !== cur.stageOnSendId) await assertOpenStage(db, actor.orgId, next.stageOnSendId);
    const saved = await db.query(
      `insert into proposal_settings (org_id, ai_drafts_enabled, approval_mode, approval_over_minor, discount_needs_approval, two_person, default_validity_days, tag_on_send_id, stage_on_send_id,
         deal_on_accept, version, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, $11)
       on conflict (org_id) do update set ai_drafts_enabled = excluded.ai_drafts_enabled, approval_mode = excluded.approval_mode, approval_over_minor = excluded.approval_over_minor,
         discount_needs_approval = excluded.discount_needs_approval, two_person = excluded.two_person, default_validity_days = excluded.default_validity_days,
         tag_on_send_id = excluded.tag_on_send_id, stage_on_send_id = excluded.stage_on_send_id, deal_on_accept = excluded.deal_on_accept,
         version = proposal_settings.version + 1, updated_by = excluded.updated_by, updated_at = now()
       where proposal_settings.version = $12
       returning version`,
      [actor.orgId, next.aiDraftsEnabled, next.approvalMode, next.approvalOverMinor, next.discountNeedsApproval, next.twoPerson, next.defaultValidityDays, next.tagOnSendId, next.stageOnSendId, next.dealOnAccept, actor.userId, expectedVersion],
    );
    // Two saves can pass the check above together; only one changes the row. The other changed nothing, so it must not say it did (or be audited as if).
    if (!saved.rows[0]) throw new AppError("conflict", "Someone else changed these settings. Reload to see their changes, then try again.");
    await recordAudit({
      orgId: actor.orgId, ...auditActor(actor), action: "proposals.settings_saved", targetType: "proposal_settings", targetId: actor.orgId, result: "success",
      metadata: { aiDraftsEnabled: next.aiDraftsEnabled, approvalMode: next.approvalMode, approvalOverMinor: next.approvalOverMinor, discountNeedsApproval: next.discountNeedsApproval, twoPerson: next.twoPerson, dealOnAccept: next.dealOnAccept },
    }, db);
    return readSettings(db, actor.orgId);
  });
}
