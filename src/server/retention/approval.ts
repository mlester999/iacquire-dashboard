import "server-only";
import crypto from "node:crypto";
import type { Queryable } from "@/server/db";
import type { Channel } from "@/lib/messaging";
import type { ProgramStep } from "@/lib/retention";
import { partnerFirstAgentSql } from "@/server/workforce/partner-runtime";

/** What the owner approves is exactly this: who gets it, under what purpose, when, and the words. Any change to it withdraws the approval. */
export function programHash(p: { kind: string; trigger: string; purpose: string; steps: ProgramStep[]; businessHoursOnly: boolean; inactiveDays: number | null }): string {
  const canonical = JSON.stringify([p.kind, p.trigger, p.purpose, p.businessHoursOnly, p.inactiveDays, p.steps.map((s) => [s.key, s.delayDays, s.body.trim()])]);
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

const RETENTION_EFFECT = /^retention:([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i;

/** The program's standing authorization covers this tenant, recipient, actor and exact saved step. */
export async function retentionMessageApproved(db: Queryable, input: {
  effectKey: string;
  orgId: string;
  contactId: string;
  agentId: string | null;
  approvalId: string | null;
  purpose?: "service" | "marketing";
  dispatchMessageId?: string;
  now: Date;
}): Promise<boolean> {
  const effect = RETENTION_EFFECT.exec(input.effectKey);
  if (!effect || !input.agentId || !input.approvalId || !input.purpose) return false;

  const { rows } = await db.query<{
    kind: string;
    trigger: string;
    purpose: "service" | "marketing";
    steps: ProgramStep[];
    business_hours_only: boolean;
    inactive_days: number | null;
    approved_hash: string;
    step_key: string;
  }>(
    `select p.kind, p.trigger, p.purpose, p.steps, p.business_hours_only, p.inactive_days, p.approved_hash, s.step_key
       from retention_steps s
       join retention_enrollments e on e.id = s.enrollment_id and e.org_id = s.org_id
       join retention_programs p on p.id = e.program_id and p.org_id = e.org_id
       join approval_requests a on a.id = p.approval_id and a.org_id = p.org_id
      where s.id = $1 and s.org_id = $2 and s.status = 'queued' and s.due_at <= $7
        and s.message_id is not distinct from $8::uuid
        and e.contact_id = $3 and e.status = 'active'
        and p.enabled and p.approved_hash = p.content_hash and p.purpose = $6
        and (${partnerFirstAgentSql("p.org_id", "crm_manager")}) = $5
        and a.id = $4 and a.kind = 'standing_authorization' and a.status = 'approved'
        and (a.expires_at is null or a.expires_at > $7)
        and a.target_type = 'standing_authorization' and a.target_id = 'retention:' || p.kind
        and a.action->>'scope' = a.target_id and a.decided_by = p.approved_by`,
    [effect[1], input.orgId, input.contactId, input.approvalId, input.agentId, input.purpose, input.now.toISOString(), input.dispatchMessageId ?? null],
  );
  const program = rows[0];
  return Boolean(program && program.steps.some((step) => step.key === program.step_key) && program.approved_hash === programHash({
    ...program,
    businessHoursOnly: program.business_hours_only,
    inactiveDays: program.inactive_days,
  }));
}

/** A person can approve one persisted feedback draft and its associated survey request. */
export async function feedbackDraftApproved(db: Queryable, input: {
  orgId: string;
  conversationId: string;
  contactId: string;
  channel: Channel;
  agentId: string | null;
  approvalId: string | null;
  messageId: string | undefined;
  effectKey: string;
  now: Date;
}): Promise<boolean> {
  if (!input.messageId || !input.agentId || !input.approvalId || !RETENTION_EFFECT.test(input.effectKey)) return false;
  const { rows } = await db.query(
    `select 1
       from conversation_messages m
       join approval_requests a on a.org_id = m.org_id and a.agent_instance_id = m.agent_id
       join crm_review_requests r on r.org_id = m.org_id and r.message_id = m.id
      where m.id = $1 and m.org_id = $2 and m.conversation_id = $3 and m.agent_id = $4
        and m.dedupe_key = $5 and m.author_kind = 'ai' and m.direction = 'outbound'
        and m.scope = 'retention' and m.purpose = 'service'
        and (m.status = 'draft' or (m.status = 'sending' and m.approval_id = a.id))
        and a.id = $6 and a.kind = 'follow_up_message' and a.status = 'approved'
        and a.target_type = 'conversation' and a.target_id = m.conversation_id::text
        and a.action->>'messageId' = m.id::text and a.decided_by is not null and a.decided_at is not null
        and (a.expires_at is null or a.expires_at > $9)
        and r.contact_id = $7 and r.channel = $8 and r.requested_via = 'program'
        and r.kind = 'survey' and r.status = 'queued' and r.expires_at > $9`,
    [input.messageId, input.orgId, input.conversationId, input.agentId, input.effectKey, input.approvalId, input.contactId, input.channel, input.now.toISOString()],
  );
  return rows.length > 0;
}
