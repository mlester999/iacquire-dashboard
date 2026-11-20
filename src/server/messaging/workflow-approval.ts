import "server-only";
import type { Queryable } from "@/server/db";

const WORKFLOW_EFFECT = /^wf:([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}):([a-z0-9][a-z0-9_-]{0,39})(?::[0-9]+)?$/i;

/**
 * A workflow's owner approves its published version. Check that authorization only
 * for the recipient, sender, channel and approved template of the persisted run's
 * send step. A queued message must be the recorded result of that exact step visit.
 */
export async function workflowMessageApproved(db: Queryable, input: {
  orgId: string;
  contactId: string;
  channel: string;
  agentId: string | null;
  approvalId: string | null;
  purpose?: "service" | "marketing";
  effectKey: string;
  dispatchMessageId?: string;
}): Promise<boolean> {
  const effect = WORKFLOW_EFFECT.exec(input.effectKey);
  if (!effect || !input.agentId || !input.approvalId || !input.purpose) return false;

  const [, runId, stepKey] = effect;
  const { rows } = await db.query(
    `select 1
       from crm_workflow_runs r
       join crm_workflows w on w.id = r.workflow_id and w.org_id = r.org_id
       join crm_workflow_versions v on v.id = r.version_id and v.org_id = r.org_id and v.workflow_id = w.id
       join approval_requests a on a.id = v.approval_id and a.org_id = v.org_id
       join agent_instances agent on agent.id = $5 and agent.org_id = r.org_id
       cross join lateral jsonb_array_elements(v.steps) as step(definition)
       join crm_message_templates t on t.id::text = step.definition->'config'->>'templateId' and t.org_id = r.org_id
       join crm_message_template_versions tv on tv.org_id = t.org_id and tv.template_id = t.id and tv.version = t.approved_version
      where r.id = $1 and r.org_id = $2 and r.contact_id = $3 and r.started_via <> 'test'
        and w.status = 'active' and w.published_version_id = v.id
        and a.id = $4 and a.kind = 'workflow_activation' and a.status = 'approved'
        and (a.expires_at is null or a.expires_at > now())
        and a.target_type = 'crm_workflow_version' and a.target_id = v.id::text
        and a.action->>'workflowId' = w.id::text and a.action->>'versionId' = v.id::text
        and a.action->>'contentHash' = v.content_hash and v.approved_hash = v.content_hash
        and step.definition->>'key' = $6 and step.definition->>'kind' = 'send_message'
        and step.definition->'config'->>'sendAs' = agent.role_key
        and step.definition->'config'->>'channel' = $7
        and t.status = 'approved' and t.kind = 'template' and t.channel = $7
        and tv.content_hash = step.definition->'config'->>'contentHash'
        and (t.purpose = $8 or ($7 = 'whatsapp' and t.whatsapp_template_id is not null and $8 = 'marketing'))
        and (
          ($9::uuid is null and r.status = 'running' and r.current_step = $6 and r.claimed_at is not null)
          or ($9::uuid is not null and r.status <> 'cancelled' and exists (
            select 1 from crm_workflow_run_steps s
             where s.org_id = r.org_id and s.run_id = r.id and s.step_key = $6 and s.kind = 'send_message'
               and s.status = 'completed' and s.message_id = $9 and split_part(s.idempotency_key, '#', 1) = $10
          ))
        )`,
    [runId, input.orgId, input.contactId, input.approvalId, input.agentId, stepKey, input.channel, input.purpose, input.dispatchMessageId ?? null, input.effectKey],
  );
  return rows.length > 0;
}
