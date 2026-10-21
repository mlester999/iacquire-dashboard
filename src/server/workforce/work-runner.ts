import "server-only";
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
        await finishWorkJob(db, { jobId: claimed.id, orgId: claimed.org_id, status: "blocked", stage: "blocked", failureCode: "capability_unavailable", failureMessage: "No reviewed handler is registered for this capability." });
        await appendWorkEvent(db, {
          jobId: claimed.id, orgId: claimed.org_id, kind: "error", stage: "blocked", message: "No reviewed handler is registered for this capability, so nothing was executed.",
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
          status: "failed",
          stage: "failed",
          failureCode: "handler_incomplete",
          failureMessage: "The worker stopped without recording a final result.",
        });
        await appendWorkEvent(db, {
          jobId: claimed.id, orgId: claimed.org_id, kind: "error", stage: "failed", message: "The worker stopped without recording a final result. No success was claimed.",
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
        status,
        stage,
        failureCode: controller.signal.aborted ? "cancelled" : "worker_error",
        failureMessage: message,
      });
      await appendWorkEvent(db, {
        jobId: claimed.id, orgId: claimed.org_id, kind: controller.signal.aborted ? "notice" : "error", stage, message,
        data: { error: err instanceof Error ? err.name : "unknown" },
      });
    }).catch(() => undefined);
    console.error(`[iacquire] work job ${claimed.id} (${claimed.capability}) failed safely`);
    return true;
  } finally {
    unregisterWorkJobController(claimed.id, controller);
  }
}

/** Starts work after the response without blocking it. The scheduler tick remains the recovery path. */
export function kickWorkJob(jobId: string): void {
  void runWorkJob(jobId).catch((err) => {
    console.error(`[iacquire] could not start work job ${jobId}: ${err instanceof Error ? err.name : "unknown"}`);
  });
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
