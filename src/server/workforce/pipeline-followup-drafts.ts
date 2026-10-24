import "server-only";
import { canChat, type AgentStatus } from "@/lib/agents";
import { cleanText } from "@/lib/support/content";
import { recordAudit } from "@/server/audit";
import { withSystem, withUser } from "@/server/db";
import {
  appendWorkEvent,
  finishWorkJob,
  recordWorkStage,
  type WorkJobRow,
} from "@/server/workforce/jobs";
import { PIPELINE_REVIEW_CHECKS } from "@/server/workforce/pipeline-review";
import { publishReviewReport } from "@/server/workforce/reports";
import { reviewFinding, type ReviewFinding } from "@/server/workforce/read-only-review";

const CAPABILITY = "pipeline_followup_drafts";
const MAX_DRAFTS = 5;

interface PipelineDraftCandidate {
  opportunityId: string;
  opportunityName: string;
  conversationId: string;
  firstName: string | null;
  lastInboundId: string;
  existingMessageId: string | null;
  existingMessageStatus: string | null;
}

interface AgentRow { id: string; role_key: string; display_name: string; enabled: boolean; status: string; active_config_version_id: string | null }

function requestedLimit(input: Record<string, unknown>): number {
  const n = Number(input.limit);
  return Number.isInteger(n) && n >= 1 && n <= MAX_DRAFTS ? n : MAX_DRAFTS;
}

function safeFirstName(value: string | null): string | null {
  if (!value) return null;
  const name = cleanText(value, 40).trim();
  return /^[\p{L}\p{M}][\p{L}\p{M}'’-]{0,39}$/u.test(name) ? name : null;
}

function buildFollowUpDraft(candidate: PipelineDraftCandidate): string {
  const greeting = safeFirstName(candidate.firstName);
  return `${greeting ? `Hi ${greeting}` : "Hello"}, I’m checking in to see whether you have any questions or would like to discuss a next step. No pressure—let me know what would be helpful.`;
}

async function loadCandidates(orgId: string, agentId: string, limit: number): Promise<{ candidates: PipelineDraftCandidate[]; truncated: boolean }> {
  return withSystem(async (db) => {
    const { rows } = await db.query<PipelineDraftCandidate>(
      `with ranked as (
         select o.id as opportunity_id, o.name as opportunity_name,
                coalesce(o.stage_entered_at, o.remote_updated_at, o.updated_at) as stale_at,
                c.id as conversation_id, k.first_name,
                inbound.id as last_inbound_id,
                row_number() over (partition by c.id order by coalesce(o.stage_entered_at, o.remote_updated_at, o.updated_at), o.id) as conversation_rank,
                'workforce-sales-followup:' || o.id::text || ':' || inbound.id::text as expected_dedupe_key
           from crm_opportunities o
           join contacts k on k.id = o.contact_id and k.org_id = o.org_id and k.deleted_at is null
           join lateral (
             select c.id
               from conversations c
              where c.org_id = o.org_id and c.contact_id = k.id and c.ai_agent_id = $2
                and c.owner_kind = 'ai' and c.status = 'open'
              order by c.last_message_at desc nulls last, c.created_at desc, c.id
              limit 1
           ) c on true
           join lateral (
             select m.id, m.created_at from conversation_messages m
              where m.org_id = o.org_id and m.conversation_id = c.id and m.direction = 'inbound' and m.status = 'received'
              order by m.created_at desc, m.id desc limit 1
           ) inbound on true
          where o.org_id = $1 and o.status = 'open' and o.archived_at is null
            and coalesce(o.stage_entered_at, o.remote_updated_at, o.updated_at) < now() - interval '14 days'
            and not exists (
              select 1 from conversation_messages sent
               where sent.org_id = o.org_id and sent.conversation_id = c.id and sent.direction = 'outbound'
                 and (
                   (sent.status in ('draft', 'queued', 'sending') and sent.dedupe_key is distinct from
                     ('workforce-sales-followup:' || o.id::text || ':' || inbound.id::text))
                   or (sent.status in ('sent', 'delivered', 'read') and coalesce(sent.sent_at, sent.created_at) > inbound.created_at
                     and sent.dedupe_key is distinct from ('workforce-sales-followup:' || o.id::text || ':' || inbound.id::text))
                 )
            )
       ), chosen as (
         select * from ranked where conversation_rank = 1 order by stale_at asc, opportunity_id limit $3
       )
       select chosen.opportunity_id as "opportunityId", chosen.opportunity_name as "opportunityName",
              chosen.conversation_id as "conversationId", chosen.first_name as "firstName",
              chosen.last_inbound_id as "lastInboundId", existing.id as "existingMessageId",
              existing.status as "existingMessageStatus"
         from chosen
         left join lateral (
           select m.id, m.status from conversation_messages m
            where m.org_id = $1 and m.dedupe_key = chosen.expected_dedupe_key
            order by m.created_at desc, m.id desc limit 1
         ) existing on true
        order by chosen.stale_at asc, chosen.opportunity_id`,
      [orgId, agentId, limit + 1],
    );
    return { candidates: rows.slice(0, limit), truncated: rows.length > limit };
  });
}

async function requesterStillAuthorized(job: WorkJobRow): Promise<boolean> {
  if (!job.requested_by) return false;
  try {
    return await withUser(job.requested_by, async (db) => {
      const { rows } = await db.query<{ can_start: boolean; can_view_sales: boolean; can_reply: boolean }>(
        `select app.has_permission($1, 'agents.use') as can_start,
                app.has_permission($1, 'sales.view') as can_view_sales,
                app.has_permission($1, 'inbox.reply') as can_reply`,
        [job.org_id],
      );
      const row = rows[0];
      return Boolean(row?.can_start && row.can_view_sales && row.can_reply);
    });
  } catch {
    return false;
  }
}

async function blockJob(job: WorkJobRow, failureCode: string, message: string): Promise<void> {
  await withSystem(async (db) => {
    await finishWorkJob(db, { jobId: job.id, orgId: job.org_id, status: "blocked", stage: "blocked", failureCode, failureMessage: message });
    await appendWorkEvent(db, { jobId: job.id, orgId: job.org_id, kind: "error", stage: "blocked", message });
  });
}

async function saveDraft(job: WorkJobRow, agent: AgentRow, candidate: PipelineDraftCandidate, body: string) {
  const dedupeKey = `workforce-sales-followup:${candidate.opportunityId}:${candidate.lastInboundId}`;
  return withSystem(async (db) => {
    const inserted = await db.query<{ id: string }>(
      `insert into conversation_messages
         (org_id, conversation_id, direction, author_kind, agent_id, body, status, status_detail, blocked_reason, scope, dedupe_key)
       select $1, c.id, 'outbound', 'ai', $3, $4, 'draft',
              'Prepared by Sales Assistant for review. Not sent.', 'needs_approval', 'followup', $5
         from conversations c
        where c.id = $2 and c.org_id = $1 and c.ai_agent_id = $3 and c.owner_kind = 'ai' and c.status = 'open'
          and exists (
            select 1 from crm_opportunities o
             where o.id = $6 and o.org_id = $1 and o.contact_id = c.contact_id and o.status = 'open' and o.archived_at is null
               and coalesce(o.stage_entered_at, o.remote_updated_at, o.updated_at) < now() - interval '14 days'
          )
          and (select m.id from conversation_messages m where m.org_id = $1 and m.conversation_id = c.id
                and m.direction = 'inbound' and m.status = 'received' order by m.created_at desc, m.id desc limit 1) = $7
          and not exists (
            select 1 from conversation_messages sent
             where sent.org_id = $1 and sent.conversation_id = c.id and sent.direction = 'outbound'
               and (
                 (sent.status in ('draft', 'queued', 'sending') and sent.dedupe_key is distinct from $5)
                 or (sent.status in ('sent', 'delivered', 'read')
                   and coalesce(sent.sent_at, sent.created_at) > (select inbound.created_at from conversation_messages inbound where inbound.id = $7 and inbound.org_id = $1)
                   and sent.dedupe_key is distinct from $5)
               )
          )
       on conflict (org_id, dedupe_key) do nothing
       returning id`,
      [job.org_id, candidate.conversationId, agent.id, body, dedupeKey, candidate.opportunityId, candidate.lastInboundId],
    );
    if (inserted.rows[0]) {
      await recordAudit({
        orgId: job.org_id,
        actorKind: "agent",
        agentInstanceId: agent.id,
        action: "workforce.sales_followup_draft_prepared",
        targetType: "conversation_message",
        targetId: inserted.rows[0].id,
        result: "success",
        metadata: { capability: CAPABILITY, opportunityId: candidate.opportunityId, conversationId: candidate.conversationId, sent: false },
      }, db);
      return { id: inserted.rows[0].id, status: "draft", created: true };
    }

    const existing = await db.query<{ id: string; status: string }>(
      `select m.id, m.status from conversation_messages m
        join conversations c on c.id = m.conversation_id and c.org_id = m.org_id
       where m.org_id = $1 and m.dedupe_key = $2 and c.ai_agent_id = $3 and c.owner_kind = 'ai' and c.status = 'open'`,
      [job.org_id, dedupeKey, agent.id],
    );
    return existing.rows[0]
      ? { id: existing.rows[0].id, status: existing.rows[0].status, created: false }
      : null;
  });
}

export async function runPipelineFollowUpDraftsJob(
  job: WorkJobRow,
  context: { workerId: string; controller: AbortController },
): Promise<void> {
  const agent = await withSystem(async (db) => {
    const { rows } = await db.query<AgentRow>(
      `select id, role_key, display_name, enabled, status, active_config_version_id
         from agent_instances where id = $1 and org_id = $2`,
      [job.agent_instance_id, job.org_id],
    );
    return rows[0] ?? null;
  });
  if (!agent || agent.role_key !== "sales_assistant" || job.capability !== CAPABILITY) {
    await blockJob(job, "capability_not_allowed", "This employee's role cannot prepare sales follow-up drafts. Nothing was read or written.");
    return;
  }
  if (!agent.enabled || !agent.active_config_version_id || !canChat(agent.status as AgentStatus)) {
    await blockJob(job, "agent_unavailable", "The Sales Assistant is no longer configured and available. No follow-up draft was created.");
    return;
  }
  if (!await requesterStillAuthorized(job)) {
    await blockJob(job, "permission_revoked", "The requester no longer has permission to review sales and prepare message drafts. No draft was created.");
    return;
  }

  const limit = requestedLimit(job.input);
  const { candidates, truncated } = await loadCandidates(job.org_id, agent.id, limit);
  const eligible = candidates.filter((candidate) => !candidate.existingMessageId);
  const reused = candidates.filter((candidate) => candidate.existingMessageId && candidate.existingMessageStatus === "draft");
  const handled = candidates.filter((candidate) => candidate.existingMessageId && candidate.existingMessageStatus !== "draft");
  const draftByOpportunity = new Map<string, string>();

  if (context.controller.signal.aborted) throw new Error("work_cancelled");
  await withSystem((db) => recordWorkStage(db, {
    jobId: job.id,
    orgId: job.org_id,
    stage: "scanning",
    message: "Reviewing stale opportunities and the existing Sales Assistant conversations…",
    progress: { staleOpportunities: candidates.length, draftsToPrepare: eligible.length, priorDrafts: reused.length },
  }));
  for (const candidate of eligible) draftByOpportunity.set(candidate.opportunityId, buildFollowUpDraft(candidate));

  await withSystem((db) => recordWorkStage(db, {
    jobId: job.id,
    orgId: job.org_id,
    stage: "analyzing",
    message: "Preparing unsent drafts for Inbox review and checking for duplicate or changed conversations…",
    progress: { staleOpportunities: candidates.length, draftsToPrepare: eligible.length, priorDrafts: reused.length },
  }));

  const prepared: Array<{ opportunityId: string; opportunityName: string; conversationId: string; messageId: string; reused: boolean }> = [];
  for (const candidate of reused) {
    if (candidate.existingMessageId) prepared.push({
      opportunityId: candidate.opportunityId,
      opportunityName: candidate.opportunityName,
      conversationId: candidate.conversationId,
      messageId: candidate.existingMessageId,
      reused: true,
    });
  }
  for (const candidate of eligible) {
    if (context.controller.signal.aborted) throw new Error("work_cancelled");
    if (!await requesterStillAuthorized(job)) {
      await blockJob(job, "permission_revoked", "The requester's message or sales permission changed before the drafts were saved. No additional draft was created.");
      return;
    }
    const body = draftByOpportunity.get(candidate.opportunityId);
    if (!body) continue;
    const saved = await saveDraft(job, agent, candidate, body);
    if (saved?.status === "draft") prepared.push({
      opportunityId: candidate.opportunityId,
      opportunityName: candidate.opportunityName,
      conversationId: candidate.conversationId,
      messageId: saved.id,
      reused: !saved.created,
    });
  }

  const findings: ReviewFinding[] = [];
  for (const finding of await withSystem(async (db) => Promise.all(PIPELINE_REVIEW_CHECKS.map((check) => check(db, job))))) {
    if (finding && finding.count > 0) findings.push(finding);
  }
  for (const item of prepared) {
    findings.push(reviewFinding({
      key: `follow_up_draft_${item.opportunityId}`,
      severity: "info",
      title: `Follow-up draft prepared for ${cleanText(item.opportunityName, 120) || "an opportunity"}`,
      detail: `${item.reused ? "An existing" : "A new"} message draft is saved in the Inbox for review. It has not been sent. Check the conversation and use the normal approval flow before any message is queued.`,
      count: 1,
      evidenceHref: `/inbox?conversation=${encodeURIComponent(item.conversationId)}`,
      recommendedAction: "Review the unsent draft in Inbox. Any later send still requires human approval and the standard consent, availability and billing checks.",
      requiresApproval: true,
    }));
  }

  const staleSignals = findings.filter((finding) => !finding.key.startsWith("follow_up_draft_") && finding.count > 0).length;
  const draftCount = prepared.filter((item) => !item.reused).length;
  const summary = candidates.length
    ? `Sales pipeline review recorded ${staleSignals} other finding${staleSignals === 1 ? "" : "s"}; ${draftCount} new follow-up draft${draftCount === 1 ? " was" : "s were"} saved for review. No message was sent.${truncated ? ` Showing the first ${limit} matching opportunities.` : ""}`
    : "Sales pipeline review completed. No stale open opportunity had a current conversation this Sales Assistant handles, so no follow-up draft was created.";
  const limitations = "Only this workspace's persisted open opportunities and current Sales Assistant conversations were used. Draft wording is a neutral template with only a simple CRM first name; it does not infer or claim conversation facts. Drafts are saved unsent; a person must review and approve them, and the existing messaging service rechecks consent, channel status, quiet hours, ownership, credits and policy before sending. No customer was contacted.";

  await withSystem(async (db) => {
    await recordWorkStage(db, { jobId: job.id, orgId: job.org_id, stage: "preparing_results", message: "The pipeline findings and unsent Inbox drafts are ready for review." });
    const finished = await finishWorkJob(db, {
      jobId: job.id,
      orgId: job.org_id,
      status: "completed",
      stage: "completed",
      resultCount: draftCount,
      resultSummary: summary,
      result: {
        subject: "Sales pipeline and follow-up drafts",
        checkedAt: new Date().toISOString(),
        checksRun: PIPELINE_REVIEW_CHECKS.length + 1,
        findings,
        drafts: prepared.map((item) => ({ ...item, status: "draft", sent: false })),
        skippedAlreadyHandled: handled.length,
        limitations,
      },
    });
    if (!finished) throw new Error("work_finished_elsewhere");
    await appendWorkEvent(db, {
      jobId: job.id,
      orgId: job.org_id,
      kind: "notice",
      stage: "completed",
      message: summary,
      data: { drafts: draftCount, reusedDrafts: prepared.length - draftCount, messagesSent: 0, pipelineSignals: staleSignals },
    });
    await publishReviewReport(db, {
      job,
      agent,
      subject: "Sales pipeline and follow-up drafts",
      findings,
      metrics: [],
      limitations,
      checksRun: PIPELINE_REVIEW_CHECKS.length + 1,
    });
  });
}
