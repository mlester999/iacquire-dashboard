import "server-only";
import crypto from "node:crypto";
import { AGENT_BY_KEY, type AgentRoleKey } from "@/lib/agents";
import type { WorkforceChatAssignment } from "@/lib/workforce-chat-assignment";
import { capabilityDefinition } from "@/lib/workforce-capabilities";
import { AppError } from "@/server/errors";
import { dispatchCapabilityJob } from "@/server/workforce/capability-dispatch";
import { appendWorkEvent } from "@/server/workforce/jobs";
import { recordAudit } from "@/server/audit";
import type { OrgContext } from "@/server/tenancy/context";

export interface WorkforceChatHandoffInput {
  sourceRole: AgentRoleKey;
  sourceAgentId: string;
  sourceConversationId: string;
  sourceMessageId: string;
  targetRole: AgentRoleKey;
  assignment: WorkforceChatAssignment;
}

/**
 * Creates one permitted, tenant-scoped employee job and a linked target chat notice.
 * The target role is explicit; capability permissions and readiness are rechecked by the shared
 * dispatcher before any job is created.
 */
export async function createWorkforceChatHandoff(ctx: OrgContext, input: WorkforceChatHandoffInput) {
  const { targetRole, assignment } = input;
  const definition = capabilityDefinition(assignment.capability);
  if (
    input.sourceRole === targetRole
    || !definition
    || !definition.allowedRoles.includes(targetRole)
    || (definition.risk !== "read_only" && definition.key !== "pipeline_followup_drafts")
  ) {
    throw new AppError("forbidden", "That employee handoff is not available.");
  }

  const source = AGENT_BY_KEY[input.sourceRole];
  const target = AGENT_BY_KEY[targetRole];
  const idempotencyKey = `chat-handoff:${input.sourceMessageId}`;
  let targetConversationId: string | null = null;
  const dispatched = await dispatchCapabilityJob(ctx, {
    agentRole: targetRole,
    capability: assignment.capability,
    title: assignment.title,
    input: {
      ...assignment.input,
      handoff: {
        sourceRole: input.sourceRole,
        sourceAgentId: input.sourceAgentId,
        sourceConversationId: input.sourceConversationId,
        sourceMessageId: input.sourceMessageId,
      },
    },
    idempotencyKey,
    deferKick: true,
    onDispatch: async (db, job) => {
      const clientMessageId = `handoff:${input.sourceMessageId}`;
      const existingConversation = await db.query<{ id: string }>(
        `select c.id from chat_conversations c
          join chat_messages m on m.conversation_id = c.id and m.org_id = c.org_id
         where c.org_id = $1 and c.agent_instance_id = $2 and c.user_id = $3 and c.deleted_at is null
           and m.client_message_id = $4 and m.work_job_id = $5
         limit 1`,
        [ctx.org.orgId, job.agentId, ctx.user.id, clientMessageId, job.jobId],
      );
      let conversationId = existingConversation.rows[0]?.id ?? null;
      if (!conversationId) {
        const { rows } = await db.query<{ id: string }>(
          `insert into chat_conversations (org_id, agent_instance_id, user_id, title, hermes_session_id)
           values ($1, $2, $3, $4, $5) returning id`,
          [ctx.org.orgId, job.agentId, ctx.user.id, `Handoff: ${assignment.title}`.slice(0, 120), `iaq-${crypto.randomUUID()}`],
        );
        conversationId = rows[0].id;
        const notice = `Task routed from ${source.shortName} to ${target.shortName}. Requested work: ${assignment.title}. Supported scope: ${assignment.acknowledgement}`;
        await db.query(
          `insert into chat_messages (conversation_id, org_id, role, content, status, work_job_id, client_message_id)
           values ($1, $2, 'notice', $3, 'complete', $4, $5)`,
          [conversationId, ctx.org.orgId, notice, job.jobId, clientMessageId],
        );
        await db.query("update chat_conversations set last_message_at = now() where id = $1 and org_id = $2", [conversationId, ctx.org.orgId]);
      }

      const { rows: jobs } = await db.query<{ conversation_id: string | null; status: string; lease_owner: string | null; lease_active: boolean }>(
        `select conversation_id, status, lease_owner,
                (lease_owner is not null and lease_expires_at is not null and lease_expires_at > now()) as lease_active
           from ai_work_jobs where id = $1 and org_id = $2 for update`,
        [job.jobId, ctx.org.orgId],
      );
      if (!jobs[0]) throw new AppError("not_found", "The handed-off work job could not be found.");
      if (jobs[0].conversation_id && jobs[0].conversation_id !== conversationId) {
        throw new AppError("conflict", "The handed-off work is already linked to a different conversation.");
      }
      if (!jobs[0].conversation_id) {
        await db.query("update ai_work_jobs set conversation_id = $2 where id = $1 and org_id = $3", [job.jobId, conversationId, ctx.org.orgId]);
      }

      const eventExists = await db.query<{ id: string }>(
        `select id from ai_work_events where org_id = $1 and job_id = $2 and kind = 'notice'
           and data->>'sourceMessageId' = $3 limit 1`,
        [ctx.org.orgId, job.jobId, input.sourceMessageId],
      );
      if (!eventExists.rows[0]) {
        if (jobs[0].status !== "running" || (jobs[0].lease_active && jobs[0].lease_owner)) {
          await appendWorkEvent(db, {
            jobId: job.jobId,
            orgId: ctx.org.orgId,
            workerId: jobs[0].status === "running" ? jobs[0].lease_owner ?? undefined : undefined,
            kind: "notice",
            message: `The user handed this work from ${source.shortName} to ${target.shortName}.`,
            data: {
              handoff: true,
              sourceRole: input.sourceRole,
              sourceAgentId: input.sourceAgentId,
              sourceConversationId: input.sourceConversationId,
              sourceMessageId: input.sourceMessageId,
              targetRole,
              targetConversationId: conversationId,
            },
          });
        }
        await recordAudit({
          orgId: ctx.org.orgId,
          actorUserId: ctx.user.id,
          actorKind: "user",
          action: "workforce.employee_handoff_created",
          targetType: "ai_work_job",
          targetId: job.jobId,
          result: "success",
          metadata: {
            sourceRole: input.sourceRole,
            sourceConversationId: input.sourceConversationId,
            sourceMessageId: input.sourceMessageId,
            targetRole,
            capability: assignment.capability,
          },
        }, db);
      }
      targetConversationId = conversationId;
    },
  });

  if (!targetConversationId) throw new AppError("internal", "The employee handoff could not be recorded.");
  return { jobId: dispatched.jobId, targetAgentId: dispatched.agentId, targetConversationId, targetRole };
}
