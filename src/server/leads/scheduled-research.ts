import "server-only";
import crypto from "node:crypto";
import type { Queryable } from "@/server/db";
import { appendWorkEvent, createWorkJob } from "@/server/workforce/jobs";
import { parseResearchAssignment } from "@/lib/research-intent";
import { targetingSchema } from "@/lib/leads-targeting";
import { consumeRateLimitInTx, RATE_LIMITS } from "@/server/security/rate-limit";

/**
 * Creates the real research request and durable job for an owner-approved Lead Hunter schedule.
 *
 * This is deliberately a server-side helper, not a provider call. The scheduler tick calls it while
 * holding the schedule row, then wakes the worker. The research handler performs the existing run
 * gate, provider work and evidence writes. The schedule switch and the operator switch are both
 * checked before this function is reached.
 */

export interface ScheduledResearchInput {
  orgId: string;
  agentId: string;
  requestedBy: string | null;
  scheduleId: string;
  slot: string;
  payload: Record<string, unknown>;
}

export async function createScheduledResearchJob(
  db: Queryable,
  input: ScheduledResearchInput,
): Promise<{ jobId: string; requestId: string; created: boolean } | { skipped: string }> {
  const prompt = typeof input.payload.prompt === "string" ? input.payload.prompt.trim() : "";
  const assignment = parseResearchAssignment(prompt);
  if (!assignment || assignment.missing.length || !assignment.target || !assignment.location || !assignment.quantity) {
    return { skipped: "invalid_research_assignment" };
  }

  // The schedule's saved prompt is the authority; the target/location/quantity are re-derived here
  // rather than trusted from a stale client payload.
  const cleanPrompt = `Find ${assignment.quantity} ${assignment.target} in ${assignment.location}`.slice(0, 1000);
  const rate = await consumeRateLimitInTx(db, RATE_LIMITS.researchByOrg, input.orgId);
  if (!rate.allowed) return { skipped: "research_rate_limited" };

  const prior = await db.query<{ id: string; work_job_id: string | null }>(
    `select id, work_job_id from lead_research_requests
      where org_id = $1 and criteria->>'scheduleId' = $2 and criteria->>'scheduleSlot' = $3
      limit 1`,
    [input.orgId, input.scheduleId, input.slot],
  );
  if (prior.rows[0]?.work_job_id) return { jobId: prior.rows[0].work_job_id, requestId: prior.rows[0].id, created: false };

  const targetingRow = await db.query<{ criteria: unknown }>("select criteria from lead_targeting_profiles where org_id = $1", [input.orgId]);
  const parsedTargeting = targetingSchema.safeParse(targetingRow.rows[0]?.criteria ?? {});
  const targeting = parsedTargeting.success ? parsedTargeting.data : targetingSchema.parse({});
  const criteria = { ...targeting, scheduleId: input.scheduleId, scheduleSlot: input.slot, scheduled: true };
  const requestId = prior.rows[0]?.id ?? crypto.randomUUID();

  if (!prior.rows[0]) {
    await db.query(
      `insert into lead_research_requests (id, org_id, requested_by, prompt, campaign_type, criteria, status)
       values ($1, $2, $3, $4, 'business', $5::jsonb, 'queued')`,
      [requestId, input.orgId, input.requestedBy, cleanPrompt, JSON.stringify(criteria)],
    );
  }

  const job = await createWorkJob(db, {
    orgId: input.orgId,
    agentId: input.agentId,
    requestedBy: input.requestedBy,
    capability: "lead_research",
    title: cleanPrompt,
    idempotencyKey: `schedule:${input.scheduleId}:${input.slot}`,
    input: { requestId, prompt: cleanPrompt, campaignType: "business", criteria, origin: "schedule" },
  });
  await db.query("update lead_research_requests set work_job_id = $3 where id = $1 and org_id = $2", [requestId, input.orgId, job.id]);
  await appendWorkEvent(db, {
    jobId: job.id,
    orgId: input.orgId,
    kind: "notice",
    message: "Created by an enabled, owner-authorized lead research schedule.",
    data: { scheduleId: input.scheduleId, requestId },
  });
  return { jobId: job.id, requestId, created: job.created };
}
