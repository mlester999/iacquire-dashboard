import "server-only";
import { runMissedCallReviewJob } from "@/server/workforce/missed-call-review";
import { runLeadPriorityReviewJob } from "@/server/workforce/lead-priority-review";
import crypto from "node:crypto";
import { withSystem } from "@/server/db";
import {
  appendWorkEvent,
  claimWorkJob,
  finishWorkJob,
  getWorkJob,
  listRunnableWorkJobs,
  type WorkJobRow,
} from "@/server/workforce/jobs";
import { registerWorkJobController, unregisterWorkJobController } from "@/server/workforce/work-cancel";
import { runLeadResearchJob } from "@/server/leads/research-job";
import { runLeadGenerationReviewJob } from "@/server/workforce/lead-generation-review";
import { runProactiveReviewJob } from "@/server/workforce/proactive-review";
import { runCrmQualityReviewJob } from "@/server/workforce/crm-quality-review";
import { runPipelineReviewJob } from "@/server/workforce/pipeline-review";
import { runPipelineFollowUpDraftsJob } from "@/server/workforce/pipeline-followup-drafts";
import { runAppointmentReviewJob } from "@/server/workforce/appointment-review";
import { runPerformanceSnapshotJob } from "@/server/workforce/performance-snapshot";
import { runAppointmentAvailabilityJob } from "@/server/workforce/appointment-availability";

/**
 * Persistent worker entry points for AI work.
 *
 * A job is claimed with a lease before any provider call, so two workers cannot execute the same
 * job. The in-process `after()`/background kick makes normal use immediate; the scheduler tick and
 * `recoverExpiredWorkJobs` are the durable recovery path, independent of an open browser tab.
 */

type Handler = (job: WorkJobRow, context: { workerId: string; controller: AbortController }) => Promise<void>;

const HANDLERS: Record<string, Handler> = {
  lead_research: runLeadResearchJob,
  lead_generation_review: runLeadGenerationReviewJob,
  proactive_review: runProactiveReviewJob,
  crm_quality_review: runCrmQualityReviewJob,
  pipeline_review: runPipelineReviewJob,
  pipeline_followup_drafts: runPipelineFollowUpDraftsJob,
  missed_call_review: runMissedCallReviewJob,
  lead_priority_review: runLeadPriorityReviewJob,
  appointment_review: runAppointmentReviewJob,
  appointment_availability: runAppointmentAvailabilityJob,
  performance_snapshot: runPerformanceSnapshotJob,
};

function workerId() {
  return `worker-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
}

export function registerWorkHandler(capability: string, handler: Handler): void {
  if (!/^[a-z][a-z0-9_]{2,39}$/.test(capability)) throw new Error("Invalid work capability.");
  HANDLERS[capability] = handler;
}

/** Runs one job. Returns false when another worker holds it or it is no longer queued. */
export async function runWorkJob(jobId: string): Promise<boolean> {
  const initial = await withSystem(async (db) => {
    const { rows } = await db.query<{ id: string; org_id: string }>("select id, org_id from ai_work_jobs where id = $1", [jobId]);
    return rows[0] ?? null;
  });
  if (!initial) return false;

  const id = workerId();
  const claimed = await withSystem(async (db) => {
    const job = await claimWorkJob(db, { jobId, orgId: initial.org_id, workerId: id, leaseSeconds: 180 });
    if (!job) return null;
    await appendWorkEvent(db, {
      jobId: job.id,
      orgId: job.org_id,
      workerId: id,
      kind: "notice",
      stage: "preparing",
      message: "Work was claimed by a worker.",
      data: { attempt: job.attempts, capability: job.capability },
    });
    return job;
  });
  if (!claimed) return false;

  const controller = new AbortController();
  registerWorkJobController(claimed.id, controller);
  const runHandler = HANDLERS[claimed.capability];
  try {
    if (!runHandler) {
      await withSystem(async (db) => {
        await finishWorkJob(db, {
          jobId: claimed.id,
          orgId: claimed.org_id,
          workerId: id,
          status: "blocked",
          stage: "blocked",
          failureCode: "capability_unavailable",
          failureMessage: "No reviewed handler is registered for this capability.",
          event: {
            kind: "error",
            stage: "blocked",
            message: "No reviewed handler is registered for this capability, so nothing was executed.",
          },
        });
      });
      return true;
    }
    await runHandler(claimed, { workerId: id, controller });
    // A handler that returns without a final state must not leave a job looking busy forever.
    const current = await withSystem((db) => getWorkJob(db, claimed.org_id, claimed.id));
    if (current && current.status === "running") {
      await withSystem(async (db) => {
        await finishWorkJob(db, {
          jobId: claimed.id,
          orgId: claimed.org_id,
          workerId: id,
          status: "failed",
          stage: "failed",
          failureCode: "handler_incomplete",
          failureMessage: "The worker stopped without recording a final result.",
          event: {
            kind: "error",
            stage: "failed",
            message: "The worker stopped without recording a final result. No success was claimed.",
          },
        });
      });
    }
    return true;
  } catch (err) {
    const message = controller.signal.aborted
      ? "The work was stopped before it completed."
      : "The work stopped because of an unexpected error. No success was claimed.";
    const status = controller.signal.aborted ? "cancelled" : "failed";
    const stage = controller.signal.aborted ? "cancelled" : "failed";
    await withSystem(async (db) => {
      await finishWorkJob(db, {
        jobId: claimed.id,
        orgId: claimed.org_id,
        workerId: id,
        status,
        stage,
        failureCode: controller.signal.aborted ? "cancelled" : "worker_error",
        failureMessage: message,
        event: {
          kind: controller.signal.aborted ? "notice" : "error",
          stage,
          message,
          data: { error: err instanceof Error ? err.name : "unknown" },
        },
      });
    }).catch(() => undefined);
    console.error(`[iacquire] work job ${claimed.id} (${claimed.capability}) failed safely`);
    return true;
  } finally {
    unregisterWorkJobController(claimed.id, controller);
  }
}

/** Runs a small bounded batch of queued jobs. Used by the scheduler tick. */
export async function processQueuedWorkJobs(limit = 2): Promise<{ claimed: number; ran: number }> {
  const jobs = await listRunnableWorkJobs(limit);
  let ran = 0;
  for (const job of jobs) {
    const started = await runWorkJob(job.id);
    if (started) ran += 1;
  }
  return { claimed: jobs.length, ran };
}
