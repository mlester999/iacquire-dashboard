import "server-only";
import { withSystem } from "@/server/db";
import { expireStaleReservations } from "@/server/billing/ledger";
import { dispatchDue } from "@/server/messaging/send";
import { processDueFollowUps } from "@/server/messaging/followups";
import { advanceEscalations } from "@/server/messaging/handoff";
import { respondToPending } from "@/server/messaging/responder";
import { processSubmissions } from "@/server/websites/forms";
import { sendRenewalReminders } from "@/server/websites/domains";
import { checkLivePublications } from "@/server/websites/health";
import { runAllCollectors } from "@/server/ops/collectors";
import { escalateUnacknowledged } from "@/server/ops/incidents";
import { deliverNotificationEmails } from "@/server/ops/notification-email";
import { runJob, withinInterval } from "@/server/ops/jobs";
import { sendDueReminders } from "@/server/appointments/reminders";
import { expireBookingHolds } from "@/server/appointments/holds";
import { expireAllStaleApprovals } from "@/server/approvals/service";
import { enrollEligible, prepareDueSteps } from "@/server/retention/engine";
import { runFairUseChecks } from "@/server/fairuse/service";
import { runInactivityReview } from "@/server/inactivity/service";
import { sendDeletionReminders } from "@/server/offboarding/service";
import { processImports } from "@/server/crm/imports";
import { processProviderSwitches } from "@/server/crm/provider-switch";
import { emitTaskDueEvents, sendTaskReminders } from "@/server/crm/tasks";
import { crmEventDispatch } from "@/server/crm/dispatch";
import { processWorkflowRuns, recoverAbandonedRuns } from "@/server/crm/workflows/runner";
import { deliverDueWebhooks } from "@/server/crm/webhooks";
import { syncDueConnections, writeBackDue } from "@/server/calendars/sync";
import { syncAllWhatsappTemplates } from "@/server/messaging/whatsapp-templates";
import { processCampaigns } from "@/server/crm/campaigns/job";
import { processFormSubmissions } from "@/server/crm/forms/process";
import { reconcileAllSetupInstances } from "@/server/setup/automation";
import { purgeExpiredAqiTutorialEvents } from "@/server/aqi/retention";
import { autoCloseResolvedRequests, runAttachmentCleanup, runResponseTargetCheck, runSupportEmails } from "@/server/support/jobs";

export interface ScheduledJob {
  name: string;
  run: () => Promise<number>;
}

/**
 * Every scheduled job, in the order they run. Each is idempotent and safe to run twice, so overlapping ticks cannot double-act,
 * and each is isolated: one that fails is recorded and the rest still run. Later work (retention, appointment reconciliation,
 * inactivity review, offboarding) registers here so it shares the same heartbeats and failure handling.
 */
export const JOBS: ScheduledJob[] = [
  { name: "expiredReservations", run: () => withSystem((db) => expireStaleReservations(db)) },
  { name: "escalationsOpened", run: () => advanceEscalations() },
  { name: "followUpsPrepared", run: async () => (await processDueFollowUps()).processed },
  { name: "repliesChecked", run: async () => (await respondToPending()).checked },
  { name: "approvalExpiry", run: () => expireAllStaleApprovals() },
  { name: "bookingHolds", run: () => expireBookingHolds() },
  // Connected calendars: busy times are read before anything is offered or written, and bookings are written before reminders go out,
  // so a reminder can carry the meeting link the calendar provider just created. Both stop when CALENDAR_SYNC_DISABLED is set.
  { name: "calendarBusySync", run: async () => (await syncDueConnections()).synced },
  { name: "calendarWriteBack", run: async () => { const r = await writeBackDue(); return r.written + r.deleted; } },
  // Reminders are queued here and sent by the dispatcher straight after, in the same run.
  { name: "appointmentReminders", run: async () => { const r = await sendDueReminders(); return r.queued + r.blocked; } },
  {
    name: "retentionPrograms",
    run: async () => {
      const e = await enrollEligible();
      const r = await prepareDueSteps();
      return e.enrolled + r.queued + r.blocked;
    },
  },
  // Native CRM automation: the event outbox is handed to workflows, lead assignment, follow-ups and webhooks; then due workflow runs
  // advance (a message step queues its message, which the dispatcher right after sends in the same run).
  { name: "crmEventDispatch", run: async () => (await crmEventDispatch()).claimed },
  { name: "crmWorkflowRuns", run: async () => { const r = await processWorkflowRuns(); return r.claimed + r.scheduled; } },
  // Native form submissions become contacts, consent, tags, deals and form.submitted events (dispatched to workflows on the next run).
  { name: "crmFormSubmissions", run: async () => (await processFormSubmissions()).claimed },
  // Owner-approved campaigns: due ones start, and each queues at its approved pace through the same send rules (the dispatcher right after sends them).
  { name: "crmCampaigns", run: async () => { const r = await processCampaigns(); return r.queued + r.excluded + r.started + r.completed + r.stopped; } },
  { name: "messagesDispatched", run: async () => (await dispatchDue()).attempted },
  // Signed outbound webhooks: event subscriptions and workflow webhook steps (three-phase delivery with retries; old history is pruned).
  { name: "crmWebhookDeliveries", run: () => deliverDueWebhooks() },
  { name: "websiteEnquiries", run: async () => (await processSubmissions()).processed },
  // Native CRM: imports move forward a chunk at a time (never in one long request), and task reminders go out once each.
  { name: "crmImports", run: async () => (await processImports()).advanced },
  // CRM provider switches: a cutover starts each migration step in order once the one before it is imported, verifies and completes; a
  // rollback undoes the steps newest first and restores the owners. Runs whether or not anyone has the wizard open.
  { name: "crmProviderSwitches", run: () => processProviderSwitches() },
  { name: "crmTaskReminders", run: async () => (await sendTaskReminders()).sent + (await emitTaskDueEvents()).emitted },
  { name: "domainRenewals", run: () => sendRenewalReminders() },
  { name: "websiteHealth", run: async () => (await checkLivePublications()).checked },
  { name: "notificationEmails", run: async () => (await deliverNotificationEmails()).queued },
  {
    name: "incidentChecks",
    run: async () => {
      const results = await runAllCollectors();
      const failed = results.filter((r) => "error" in r).length;
      if (failed === results.length) throw new Error("every health check failed to run");
      return results.reduce((n, r) => n + ("error" in r ? 0 : r.observed), 0);
    },
  },
  { name: "incidentEscalations", run: () => escalateUnacknowledged() },
  // Support & Requests: response-target notices and escalation flags, support emails (and their retries), auto-closing resolved requests
  // and removing files nobody sent. Targets, auto-close and retention do nothing until the Super Admin turns them on.
  { name: "supportResponseTargets", run: () => runResponseTargetCheck() },
  { name: "supportEmails", run: () => runSupportEmails() },
  { name: "supportAutoClose", run: async () => ((await withinInterval("supportAutoClose", 60)) ? 0 : await autoCloseResolvedRequests()) },
  { name: "supportAttachmentCleanup", run: async () => ((await withinInterval("supportAttachmentCleanup", 60)) ? 0 : await runAttachmentCleanup()) },
  // Slower rhythms: each is skipped (returning 0) until enough time has passed since its last successful run.
  { name: "fairUseChecks", run: async () => ((await withinInterval("fairUseChecks", 60)) ? 0 : (await runFairUseChecks()).checked) },
  { name: "inactivityReview", run: async () => ((await withinInterval("inactivityReview", 360)) ? 0 : (await runInactivityReview()).notified) },
  { name: "offboardingReminders", run: async () => ((await withinInterval("offboardingReminders", 360)) ? 0 : await sendDeletionReminders()) },
  // Workflow runs a stopped worker left behind go back to the queue, and runs whose step approval lapsed are cancelled.
  { name: "crmWorkflowRecovery", run: async () => { if (await withinInterval("crmWorkflowRecovery", 5)) return 0; const r = await recoverAbandonedRuns(); return r.recovered + r.lapsed; } },
  // WhatsApp templates are reviewed, paused and edited in Meta: mirror them every three hours (read-only towards Meta).
  { name: "whatsappTemplateSync", run: async () => ((await withinInterval("whatsappTemplateSync", 180)) ? 0 : (await syncAllWhatsappTemplates()).synced) },
  // Setup Center evidence that changes inside the CRM (a Blueprint applied, a calendar activated, a sender's live test) completes the
  // matching setup steps within fifteen minutes. Recorded evidence only: no provider is contacted.
  { name: "setupEvidence", run: async () => ((await withinInterval("setupEvidence", 15)) ? 0 : await reconcileAllSetupInstances()) },
  // AQi tutorial analytics retention: bounded to 500 events per run, never deletes progress, and
  // keeps events for people still in progress. It runs only when an external scheduler calls the
  // tick endpoint; registering the job does not create a cron.
  { name: "aqiTutorialEventRetention", run: async () => ((await withinInterval("aqiTutorialEventRetention", 1440)) ? 0 : (await purgeExpiredAqiTutorialEvents()).deleted) },
];

/**
 * One scheduler tick at a time. Vercel Cron (or any external scheduler) can overlap a slow run; this lease row makes a second
 * invocation return without doing any work. It is not based on `last_finished_at` alone: a crashed run is reclaimable after five
 * minutes, while a normal run is finished and reclaimable after thirty seconds. The individual jobs are already idempotent.
 */
export async function claimSchedulerTick(): Promise<boolean> {
  const { rows } = await withSystem((db) =>
    db.query<{ job_name: string }>(
      `insert into worker_job_runs (job_name, last_started_at, last_finished_at)
       values ('scheduler_tick', now(), null)
       on conflict (job_name) do update
         set last_started_at = now(), last_finished_at = null
         where (worker_job_runs.last_finished_at is not null and worker_job_runs.last_finished_at < now() - interval '30 seconds')
            or worker_job_runs.last_started_at < now() - interval '5 minutes'
       returning job_name`,
    ),
  );
  return rows.length > 0;
}

/** Releases the tick lease. Best effort: a failure here is reclaimed by the five-minute stale-run rule. */
export async function finishSchedulerTick(ok: boolean, error: string | null = null): Promise<void> {
  await withSystem((db) =>
    db.query(
      `update worker_job_runs set last_finished_at = now(),
         last_success_at = case when $1 then now() else last_success_at end,
         last_failure_at = case when $1 then last_failure_at else now() end,
         consecutive_failures = case when $1 then 0 else consecutive_failures + 1 end,
         last_error = case when $1 then null else $2 end
       where job_name = 'scheduler_tick'`,
      [ok, error],
    ),
  ).catch(() => undefined);
}

export async function runScheduledJobs(): Promise<Record<string, number | string>> {
  const ran: Record<string, number | string> = {};
  const outcome = await runJob("tick", async () => {
    for (const job of JOBS) {
      const r = await runJob(job.name, job.run, (n) => ({ processed: n }));
      ran[job.name] = r.ok ? r.value : "failed";
    }
    return ran;
  });
  if (!outcome.ok) ran.tick = "failed";
  return ran;
}
