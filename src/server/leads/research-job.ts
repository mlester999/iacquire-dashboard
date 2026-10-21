import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { env } from "@/server/env";
import { recordUsage } from "@/server/usage";
import { notifyOrgRoles } from "@/server/notifications";
import { buildRunInstructions, loadConnection, markAgentDegraded } from "@/server/workforce/service";
import {
  AgentRunNotReadyError,
  HermesError,
  startAgentRun,
  stopRun,
  streamRunEvents,
  type HermesConnection,
  type TokenUsage,
} from "@/server/integrations/hermes/client";
import {
  appendWorkEvent,
  finishWorkJob,
  getWorkJob,
  heartbeatWorkJob,
  recordWorkProgress,
  recordWorkStage,
  type WorkJobRow,
} from "@/server/workforce/jobs";
import { targetingSchema } from "@/lib/leads-targeting";
import {
  findLeadDuplicates,
  normalizeDomain,
  normalizeScore,
  parseResearchOutput,
  progressForTool,
  qualifyCandidate,
  researchPrompt,
  stageForTool,
} from "@/server/leads/research-contract";

/**
 * The Lead Hunter research handler.
 *
 * Real work only: every stage event is produced by a provider tool event or by server-side
 * qualification/duplicate work that actually ran. Counts are incremented from observed events and
 * persisted candidates. A failure, cancellation or missing capability is recorded as such; nothing
 * is inferred from the fact that a page is open or a timer elapsed.
 */

const STAGE_COPY: Record<string, string> = {
  searching: "Searching approved business sources…",
  reviewing: "Reviewing discovered company websites…",
  extracting: "Extracting prospect details from the pages that were read…",
  verifying: "Verifying information against the cited sources…",
  qualifying: "Qualifying candidates against your criteria…",
  checking_duplicates: "Checking candidate companies against existing CRM records…",
  preparing_results: "Research completed. Preparing qualified leads for review.",
};

interface ResearchSetup {
  requestId: string;
  conn: HermesConnection;
  instructions: string;
  configVersionId: string | null;
  memoryScope: string;
  input: string;
  agentRunId: string;
  hermesRunId: string | null;
}

class ResearchBlocked extends Error {}

const counter = (progress: Record<string, unknown>, key: string) => {
  const value = Number(progress[key]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
};

async function requestCancelled(jobId: string, orgId: string): Promise<boolean> {
  try {
    const { rows } = await withSystem((db) =>
      db.query<{ cancel_requested_at: Date | null }>("select cancel_requested_at from ai_work_jobs where id = $1 and org_id = $2", [jobId, orgId]),
    );
    return Boolean(rows[0]?.cancel_requested_at);
  } catch {
    return false;
  }
}

async function updateRequest(db: Queryable, orgId: string, requestId: string, status: string, failureReason: string | null, resultCount?: number) {
  await db.query(
    `update lead_research_requests
        set status = $3, failure_reason = $4, completed_at = case when $3 in ('completed','failed','cancelled') then now() else completed_at end
            ${resultCount === undefined ? "" : ", result_count = $5"}
      where id = $1 and org_id = $2`,
    resultCount === undefined ? [requestId, orgId, status, failureReason] : [requestId, orgId, status, failureReason, resultCount],
  );
}

async function updateAgentRun(
  db: Queryable,
  runId: string,
  status: "completed" | "failed" | "cancelled" | "timeout" | "interrupted",
  usage?: TokenUsage | null,
  errorCode?: string | null,
) {
  await db.query(
    `update agent_runs set status = $2, finished_at = now(),
            input_tokens = coalesce($3, input_tokens), output_tokens = coalesce($4, output_tokens),
            total_tokens = coalesce($5, total_tokens), error_code = coalesce($6, error_code)
      where id = $1`,
    [runId, status, usage?.inputTokens ?? null, usage?.outputTokens ?? null, usage?.totalTokens ?? null, errorCode ?? null],
  );
}

async function markRequestFailed(
  job: WorkJobRow,
  input: { status: "failed" | "blocked" | "cancelled"; code: string; message: string; requestId: string | null; agentRunId: string | null; usage?: TokenUsage | null },
) {
  await withSystem(async (db) => {
    const current = await getWorkJob(db, job.org_id, job.id);
    const effective = current?.status === "cancelled" ? "cancelled" : input.status;
    const stage = effective === "cancelled" ? "cancelled" : effective === "blocked" ? "blocked" : "failed";
    if (input.requestId) {
      await updateRequest(db, job.org_id, input.requestId, effective === "cancelled" ? "cancelled" : "failed", input.message);
    }
    if (input.agentRunId) {
      await updateAgentRun(db, input.agentRunId, effective === "cancelled" ? "cancelled" : effective === "blocked" ? "failed" : "failed", input.usage, input.code);
    }
    await finishWorkJob(db, {
      jobId: job.id,
      orgId: job.org_id,
      status: effective,
      stage,
      failureCode: input.code,
      failureMessage: input.message,
    });
    await appendWorkEvent(db, {
      jobId: job.id,
      orgId: job.org_id,
      kind: effective === "cancelled" ? "notice" : "error",
      stage,
      message: input.message,
      data: { code: input.code },
    });
  }).catch(() => undefined);
}

async function noteStage(job: WorkJobRow, stage: keyof typeof STAGE_COPY, progress?: Record<string, unknown>) {
  await withSystem((db) =>
    recordWorkStage(db, {
      jobId: job.id,
      orgId: job.org_id,
      stage: stage as never,
      message: STAGE_COPY[stage] ?? "Working…",
      progress,
    }),
  ).catch(async () => {
    if (await requestCancelled(job.id, job.org_id)) throw new Error("work_cancelled");
  });
}

async function noteProgress(job: WorkJobRow, counters: Record<string, number>, stage?: string) {
  const message = [
    counters.searches ? `${counters.searches} search ${counters.searches === 1 ? "query" : "queries"} completed` : null,
    counters.pagesReviewed ? `${counters.pagesReviewed} source ${counters.pagesReviewed === 1 ? "page" : "pages"} reviewed` : null,
  ].filter(Boolean).join(" · ");
  if (!message) return;
  await withSystem((db) =>
    recordWorkProgress(db, {
      jobId: job.id,
      orgId: job.org_id,
      message,
      progress: counters,
      data: stage ? { stage } : undefined,
    }),
  ).catch(() => undefined);
}

export async function runLeadResearchJob(job: WorkJobRow, context: { workerId: string; controller: AbortController }): Promise<void> {
  const requestId = typeof job.input.requestId === "string" ? job.input.requestId : null;
  if (!requestId) {
    await markRequestFailed(job, {
      status: "blocked",
      code: "invalid_job",
      message: "This research job has no linked request, so it cannot run.",
      requestId: null,
      agentRunId: null,
    });
    return;
  }

  let setup: ResearchSetup & { runId: string };
  let agentRunId: string | null = null;
  try {
    setup = await withSystem(async (db) => {
      const { rows } = await db.query<{
        prompt: string; criteria: unknown; campaign_type: "business" | "influencer"; status: string; work_job_id: string | null;
      }>(
        "select prompt, criteria, campaign_type, status, work_job_id from lead_research_requests where id = $1 and org_id = $2",
        [requestId, job.org_id],
      );
      const request = rows[0];
      if (!request) throw new AppError("not_found", "Research request not found.");
      if (request.work_job_id !== job.id) throw new AppError("conflict", "This research request is linked to a different work job.");
      // `waiting_for_agent` is included so a direct retry still reaches the shared run gate: the
      // gate itself refuses with the precise readiness reason and closes the stranded run row.
      if (!["queued", "waiting_for_agent", "running", "failed"].includes(request.status)) {
        throw new ResearchBlocked("This research request is no longer queued for work.");
      }
      const conn = await loadConnection(db, job.agent_instance_id);
      if (!conn) throw new ResearchBlocked("The Lead Hunter is not connected, so no research was started.");
      const runInstructions = await buildRunInstructions(db, job.org_id, job.agent_instance_id);
      if (!runInstructions.versionId) throw new ResearchBlocked("The Lead Hunter has no applied configuration, so no research was started.");
      const targeting = targetingSchema.safeParse(request.criteria);
      const input = researchPrompt(
        request.prompt,
        targeting.success ? targeting.data : targetingSchema.parse({}),
        request.campaign_type,
      );
      const idempotencyKey = `research:${requestId}:${job.id}:${job.attempts}`;
      const { rows: run } = await db.query<{ id: string }>(
        `insert into agent_runs (org_id, agent_instance_id, user_id, purpose, idempotency_key, status, config_version_id)
         values ($1, $2, $3, 'lead_research', $4, 'running', $5) returning id`,
        [job.org_id, job.agent_instance_id, job.requested_by, idempotencyKey, runInstructions.versionId],
      );
      await updateRequest(db, job.org_id, requestId, "running", null);
      await db.query("update lead_research_requests set agent_run_id = $3 where id = $1 and org_id = $2", [requestId, job.org_id, run[0].id]);
      await recordUsage(db, { orgId: job.org_id, userId: job.requested_by, agentId: job.agent_instance_id, kind: "lead_research" });
      await appendWorkEvent(db, {
        jobId: job.id,
        orgId: job.org_id,
        kind: "notice",
        stage: "preparing",
        message: "Research started. The Lead Hunter is preparing the assignment.",
      });
      return {
        requestId,
        conn,
        instructions: runInstructions.instructions,
        configVersionId: runInstructions.versionId,
        memoryScope: `iaq:${job.org_id}:lead_hunter`,
        input,
        runId: run[0].id,
        agentRunId: run[0].id,
        hermesRunId: null,
      };
    });
    agentRunId = setup.runId;
  } catch (err) {
    const blocked = err instanceof ResearchBlocked;
    await markRequestFailed(job, {
      status: blocked ? "blocked" : "failed",
      code: blocked ? "agent_unavailable" : "setup_failed",
      message: blocked ? err.message : "The research could not be prepared. No provider run was started.",
      requestId,
      agentRunId,
    });
    if (err instanceof HermesError && (err.kind === "unreachable" || err.kind === "auth_failed")) {
      await markAgentDegraded(job.agent_instance_id, err.message).catch(() => undefined);
    }
    return;
  }

  let hermesRunId: string;
  try {
    const started = await startAgentRun(job.agent_instance_id, job.org_id, setup.conn, {
      input: setup.input,
      instructions: setup.instructions,
      idempotencyKey: `research:${requestId}:${job.id}:${job.attempts}`,
      memoryScope: setup.memoryScope,
    });
    hermesRunId = started.runId;
    await withSystem((db) => db.query("update agent_runs set hermes_run_id = $2 where id = $1", [setup.runId, hermesRunId]));
  } catch (err) {
    const message = err instanceof AgentRunNotReadyError
      ? err.message
      : err instanceof HermesError && (err.kind === "unreachable" || err.kind === "auth_failed")
        ? "The Lead Hunter's Hermes connection is unavailable, so no research was started."
        : "The research run could not be started. No provider run was accepted.";
    if (err instanceof HermesError && (err.kind === "unreachable" || err.kind === "auth_failed")) {
      await markAgentDegraded(job.agent_instance_id, err.message).catch(() => undefined);
    }
    await markRequestFailed(job, {
      status: err instanceof AgentRunNotReadyError ? "blocked" : "failed",
      code: err instanceof AgentRunNotReadyError ? "agent_not_ready" : "run_not_started",
      message,
      requestId,
      agentRunId,
    });
    return;
  }

  const counters = {
    searches: counter(job.progress, "searches"),
    pagesReviewed: counter(job.progress, "pagesReviewed"),
  };
  let lastStage: string = job.stage ?? "preparing";
  let output = "";
  let streamed = "";
  let failure: string | null = null;
  let cancelled = false;
  let timedOut = false;
  let usage: TokenUsage | null = null;
  let approvalRequested = false;
  let lastCancelCheck = 0;
  let lastHeartbeat = Date.now();

  const timer = setTimeout(() => {
    timedOut = true;
    context.controller.abort();
  }, env().HERMES_RUN_TIMEOUT_MS);

  try {
    for await (const event of streamRunEvents(setup.conn, hermesRunId, context.controller.signal)) {
      if (event.type === "delta") {
        streamed += event.text;
      } else if (event.type === "tool_started" || event.type === "tool_completed") {
        const phase = event.type === "tool_started" ? "started" : "completed";
        const stage = stageForTool(event.tool, phase);
        if (stage && stage !== lastStage) {
          lastStage = stage;
          await noteStage(job, stage as keyof typeof STAGE_COPY, counters).catch(() => undefined);
        }
        const increment = progressForTool(event.tool, phase, event.type === "tool_completed" ? event.error : false);
        if (increment) {
          for (const [key, value] of Object.entries(increment)) counters[key as keyof typeof counters] += value;
          await noteProgress(job, counters, stage ?? undefined);
        }
      } else if (event.type === "approval_request") {
        // The research workflow has no human present to grant a shell approval. Stop rather than
        // auto-approving; the tool inventory should never expose an approval-gated tool anyway.
        approvalRequested = true;
        await stopRun(setup.conn, hermesRunId).catch(() => undefined);
        break;
      } else if (event.type === "completed") {
        output = event.output ?? streamed;
        usage = event.usage;
        break;
      } else if (event.type === "failed" || event.type === "interrupted") {
        failure = "The Lead Hunter couldn't complete this research.";
        usage = "usage" in event ? event.usage ?? null : null;
        break;
      } else if (event.type === "cancelled") {
        failure = "The research was stopped.";
        break;
      }

      const now = Date.now();
      if (now - lastCancelCheck > 1500) {
        lastCancelCheck = now;
        if (await requestCancelled(job.id, job.org_id)) {
          cancelled = true;
          await stopRun(setup.conn, hermesRunId).catch(() => undefined);
          context.controller.abort();
          break;
        }
      }
      if (now - lastHeartbeat > 20000) {
        lastHeartbeat = now;
        await withSystem((db) => heartbeatWorkJob(db, { jobId: job.id, workerId: context.workerId, leaseSeconds: 180 })).catch(() => undefined);
      }
    }
  } catch {
    if (cancelled || await requestCancelled(job.id, job.org_id)) cancelled = true;
    else failure = timedOut
      ? "The research took longer than the allowed run time and was stopped."
      : "The connection to the Lead Hunter dropped before the research finished.";
  } finally {
    clearTimeout(timer);
  }

  if (cancelled) {
    await markRequestFailed(job, {
      status: "cancelled",
      code: "cancelled",
      message: "The research was stopped. No further provider work was requested.",
      requestId,
      agentRunId: setup.runId,
      usage,
    });
    return;
  }
  if (approvalRequested) {
    await markRequestFailed(job, {
      status: "blocked",
      code: "approval_required",
      message: "The Lead Hunter requested a tool approval that this research workflow cannot grant. No action was taken.",
      requestId,
      agentRunId: setup.runId,
      usage,
    });
    return;
  }
  if (failure || !output) {
    const message = timedOut
      ? "The research took longer than the allowed run time and was stopped."
      : failure ?? "The research ended without a result.";
    await withSystem((db) => updateAgentRun(db, setup.runId, timedOut ? "timeout" : "failed", usage, "run_failed")).catch(() => undefined);
    await markRequestFailed(job, {
      status: "failed",
      code: timedOut ? "timeout" : "run_failed",
      message,
      requestId,
      agentRunId: setup.runId,
      usage,
    });
    return;
  }

  const parsed = parseResearchOutput(output);
  if (parsed.error) {
    await withSystem((db) => updateAgentRun(db, setup.runId, "completed", usage)).catch(() => undefined);
    await markRequestFailed(job, {
      status: "failed",
      code: "invalid_output",
      message: parsed.error,
      requestId,
      agentRunId: setup.runId,
      usage,
    });
    return;
  }

  try {
    await withSystem(async (db) => {
      await updateAgentRun(db, setup.runId, "completed", usage);
      await recordWorkStage(db, {
        jobId: job.id,
        orgId: job.org_id,
        stage: "qualifying",
        message: STAGE_COPY.qualifying,
        progress: counters,
      });

      await recordWorkStage(db, {
        jobId: job.id,
        orgId: job.org_id,
        stage: "checking_duplicates",
        message: STAGE_COPY.checking_duplicates,
        progress: { ...counters, candidates: parsed.leads.length },
      });
      const leadIds: string[] = [];
      let evidenceBacked = 0;
      let needsEvidence = 0;
      let duplicates = 0;
      for (const lead of parsed.leads) {
        const duplicate = await findLeadDuplicates(db, job.org_id, lead);
        const qualification = qualifyCandidate(lead, duplicate);
        const domain = normalizeDomain(lead.website);
        const { breakdown, total } = normalizeScore(lead.score, lead.evidence.length);
        // A retry after a crash must not create a second lead for a candidate this request already
        // persisted. Reuse the existing row and keep the same evidence/count semantics.
        const existingLead = await db.query<{ id: string }>(
          `select id from leads
            where org_id = $1 and research_request_id = $2 and lower(business_name) = lower($3)
              and coalesce(domain, '') = coalesce($4, '')
            limit 1`,
          [job.org_id, requestId, lead.business_name, domain],
        );
        if (existingLead.rows[0]) {
          leadIds.push(existingLead.rows[0].id);
          if (qualification.state === "evidence_backed") evidenceBacked += 1;
          else if (qualification.state === "needs_evidence") needsEvidence += 1;
          else duplicates += 1;
          continue;
        }
        const { rows } = await db.query<{ id: string }>(
          `insert into leads (org_id, research_request_id, business_name, website, domain, industry, location, source_platform,
             evidence, score, score_breakdown, qualification_summary, buying_signals, duplicate_status, duplicate_matches, public_contact)
           values ($1, $2, $3, $4, $5, $6, $7, 'lead_hunter', $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb)
           returning id`,
          [
            job.org_id,
            requestId,
            lead.business_name,
            lead.website ?? null,
            domain,
            lead.industry ?? null,
            lead.location ?? null,
            JSON.stringify(lead.evidence),
            total,
            JSON.stringify(breakdown),
            lead.qualification_summary ?? null,
            lead.buying_signals,
            duplicate.status,
            JSON.stringify(duplicate.matches),
            JSON.stringify(lead.public_contact ?? {}),
          ],
        );
        leadIds.push(rows[0].id);
        if (qualification.state === "evidence_backed") evidenceBacked += 1;
        else if (qualification.state === "needs_evidence") needsEvidence += 1;
        else duplicates += 1;
      }

      const rejectedNote = parsed.rejected
        ? `${parsed.rejected} result(s) were discarded because they didn't meet the evidence format.`
        : null;
      await recordWorkProgress(db, {
        jobId: job.id,
        orgId: job.org_id,
        message: `${parsed.leads.length} candidate${parsed.leads.length === 1 ? "" : "s"} extracted: ${evidenceBacked} evidence-backed, ${needsEvidence} need more evidence, ${duplicates} duplicate${duplicates === 1 ? "" : "s"} flagged.`,
        progress: { candidates: parsed.leads.length, evidenceBacked, needsEvidence, duplicates, rejected: parsed.rejected, ...counters },
      });
      await recordWorkStage(db, {
        jobId: job.id,
        orgId: job.org_id,
        stage: "preparing_results",
        message: STAGE_COPY.preparing_results,
      });
      const finished = await finishWorkJob(db, {
        jobId: job.id,
        orgId: job.org_id,
        status: "completed",
        stage: "completed",
        resultCount: leadIds.length,
        resultSummary: leadIds.length
          ? `Research completed. ${leadIds.length} lead${leadIds.length === 1 ? "" : "s"} prepared for review.`
          : "Research completed without evidence-backed candidates. No leads were invented to fill the request.",
        result: {
          requestId,
          leadIds,
          evidenceBacked,
          needsEvidence,
          duplicates,
          rejected: parsed.rejected,
          searches: counters.searches,
          pagesReviewed: counters.pagesReviewed,
          limitation: leadIds.length < parsed.leads.length ? "Some candidates were flagged as duplicates or lacked evidence." : null,
        },
      });
      // If a cancellation won the race, do not persist a "completed" request or any success claim.
      if (!finished) throw new Error("work_finished_elsewhere");
      await updateRequest(db, job.org_id, requestId, "completed", rejectedNote, leadIds.length);
      if (leadIds.length) {
        await notifyOrgRoles(db, job.org_id, ["owner", "admin"], {
          kind: "lead_awaiting_approval",
          severity: "info",
          title: `${leadIds.length} researched lead${leadIds.length === 1 ? "" : "s"} ready for review`,
          link: "/leads?tab=review",
        });
      }
      await appendWorkEvent(db, {
        jobId: job.id,
        orgId: job.org_id,
        kind: "notice",
        stage: "completed",
        message: leadIds.length
          ? `Research completed: ${leadIds.length} lead${leadIds.length === 1 ? "" : "s"} prepared for human review.`
          : "Research completed without candidates that met the evidence requirements.",
        data: { leadIds },
      });
    });
  } catch (err) {
    console.error(`[iacquire] research persistence failed: ${err instanceof Error ? err.name : "unknown"}`);
    await markRequestFailed(job, {
      status: "failed",
      code: "persistence_failed",
      message: "The research finished but its results could not be saved, so no success was claimed.",
      requestId,
      agentRunId: setup.runId,
      usage,
    });
  }
}

/** Exposed for the worker's capability registry and unit tests. */
export const LEAD_RESEARCH_CAPABILITY = "lead_research";
