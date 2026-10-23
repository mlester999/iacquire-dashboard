import "server-only";
import { withSystem } from "@/server/db";
import { env } from "@/server/env";
import { expireStaleReservations } from "@/server/billing/ledger";
import { dispatchDue } from "@/server/messaging/send";
import { processDueFollowUps } from "@/server/messaging/followups";
import { advanceEscalations } from "@/server/messaging/handoff";
import { respondToPending } from "@/server/messaging/responder";
import { scanInboxAttention } from "@/server/messaging/attention";
import { processMissedCalls } from "@/server/missed-calls/engine";
import { purgeExpiredPhase2Records } from "@/server/missed-calls/retention";
import { purgeExpiredWebChats } from "@/server/webchat/retention";
import { processDueSocialPosts, PUBLISH_BUDGET_MS } from "@/server/social/publisher";
import { checkAllAccounts, purgeSignInStates } from "@/server/social/accounts";
import { finishPendingMediaRemovals } from "@/server/social/media";
import { syncPostMetrics } from "@/server/social/analytics";
import { expireDueProposals, proposalHousekeeping } from "@/server/proposals/jobs";
import { runEsignSync } from "@/server/esign/maintenance";
import { processScoringQueue } from "@/server/lead-scoring/queue";
import { processSubmissions } from "@/server/websites/forms";
import { sendRenewalReminders } from "@/server/websites/domains";
import { checkLivePublications } from "@/server/websites/health";
import { runAllCollectors } from "@/server/ops/collectors";
import { escalateUnacknowledged } from "@/server/ops/incidents";
import { deliverNotificationEmails } from "@/server/ops/notification-email";
import { runJob } from "@/server/ops/jobs";
import { sendDueReminders } from "@/server/appointments/reminders";
import { expireBookingHolds } from "@/server/appointments/holds";
import { expireAllStaleApprovals } from "@/server/approvals/service";
import { enrollEligible, prepareDueSteps } from "@/server/retention/engine";
import { runFeedbackSla, runOutcomeNudge } from "@/server/reputation/jobs";
import { processReviewBatches } from "@/server/reputation/batch-job";
import { runReviewSync } from "@/server/reputation/sync";
import { runRenewalReminders } from "@/server/reputation/renewals";
import { purgeReputationRecords } from "@/server/reputation/housekeeping";
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
import { runSetupMaintenance } from "@/server/setup/startup";
import { purgeExpiredAqiTutorialEvents } from "@/server/aqi/retention";
import { sweepStudioEntitlements } from "@/server/automation-studio/lifecycle";
import { purgeExpiredBriefings, runDueBriefings } from "@/server/aqi/ops/briefings";
import { purgeExpiredOpsConversations } from "@/server/aqi/ops/conversations";
import { autoCloseResolvedRequests, runAttachmentCleanup, runResponseTargetCheck, runSupportEmails } from "@/server/support/jobs";
import { recoverExpiredWorkJobs } from "@/server/workforce/jobs";
import { runDueSchedules } from "@/server/workforce/schedules";
import { runDueTriggers } from "@/server/workforce/triggers";
import { releaseHeldProactiveReports, runProactiveBriefings } from "@/server/workforce/reports";
import { runCustomerPaymentReconcile } from "@/server/customer-payments/reconcile";
import { runInvoiceOverdueSweep } from "@/server/invoices/overdue";
import { runInvoiceRemindersJob } from "@/server/invoices/reminders";

export interface ScheduledJob {
  name: string;
  run: () => Promise<number>;
  /**
   * A slow rhythm: the job runs on a tick only if this many minutes have passed since its previous run started (see runJob). Absent
   * means it runs on every tick. The interval is an elapsed time, not a calendar slot, so it does not depend on a time zone.
   */
  everyMinutes?: number;
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
  // The inbox: customers who have waited for a reply are announced once each, and "went quiet" is announced to workflows that listen for it.
  { name: "inboxAttention", everyMinutes: 5, run: async () => { const r = await scanInboxAttention(); return r.notified + r.idle; } },
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
  // Reputation, internal only (nothing here writes to a customer). Low private feedback nobody acknowledged in the workspace's time is announced to the team once; and, only for
  // workspaces that switched it on, a daily notice counts finished appointments with no recorded outcome. Neither marks anything attended or contacts anyone.
  { name: "feedbackSla", everyMinutes: 15, run: () => runFeedbackSla() },
  { name: "appointmentOutcomeNudge", everyMinutes: 1440, run: () => runOutcomeNudge() },
  // Review request batches: an owner-approved ask to many customers, only in workspaces a Super Admin switched batches on for. Each approved batch starts (its approval is checked
  // against what would be sent now; any change stops it) and its customers are asked at the batch's pace, through the same checks as one review request. The messages it queues go
  // out in the dispatcher run straight after. Nothing happens for a batch nobody approved, and a staged start must name this job to run it.
  { name: "reviewRequestBatches", run: async () => { const r = await processReviewBatches(); return r.started + r.queued + r.excluded + r.failed + r.paused + r.stopped + r.completed; } },
  // Public reviews. Every hour the reviews of each connected review site (only in workspaces a Super Admin switched public reviews on for, and only where reading that site is
  // switched on for this deployment) are read into the mirror, and replies whose result is unknown are checked against the site. Nothing here posts a reply or writes to a customer.
  // Renewal reminders are a daily internal task and notice for the team, only for workspaces that switched them on. The daily clean-up removes old mirrors and finished sign-ins.
  // Like every job here they run only when the scheduler does, and in a staged start only when named in SCHEDULER_JOBS_ONLY.
  { name: "reviewSync", everyMinutes: 60, run: () => runReviewSync() },
  { name: "renewalReminders", everyMinutes: 1440, run: async () => (await runRenewalReminders()).tasks },
  { name: "reputationRetention", everyMinutes: 1440, run: async () => { const r = await purgeReputationRecords(); return r.signIns + r.disconnectedReviews + r.removedReviews + r.replyEvents; } },
  // Native CRM automation: the event outbox is handed to workflows, lead assignment, follow-ups and webhooks; then due workflow runs
  // advance (a message step queues its message, which the dispatcher right after sends in the same run).
  { name: "crmEventDispatch", run: async () => (await crmEventDispatch()).claimed },
  { name: "crmWorkflowRuns", run: async () => { const r = await processWorkflowRuns(); return r.claimed + r.scheduled; } },
  // Native form submissions become contacts, consent, tags, deals and form.submitted events (dispatched to workflows on the next run).
  { name: "crmFormSubmissions", run: async () => (await processFormSubmissions()).claimed },
  // Owner-approved campaigns: due ones start, and each queues at its approved pace through the same send rules (the dispatcher right after sends them).
  { name: "crmCampaigns", run: async () => { const r = await processCampaigns(); return r.queued + r.excluded + r.started + r.completed + r.stopped; } },
  // Missed-call recovery: callers who were missed are worked under their workspace's policy, a few at a time per workspace. A call-back task and a notice
  // are the team's part; a text is queued only through the ordinary send rules and goes out in the dispatcher run straight after (nothing leaves while a
  // provider's write switch is off). Policy off, which is the default, means nothing happens except that cases are watched and expired.
  // Lead scoring: contacts whose information changed are assessed again (debounced, a few per workspace per run, within a daily ceiling). Rules do the
  // scoring; a model is asked only for workspaces that switched signal extraction on, within their daily limit.
  { name: "leadScoreReassessment", run: async () => { const r = await processScoringQueue(); return r.claimed; } },
  { name: "phase2Retention", everyMinutes: 1440, run: async () => { const r = await purgeExpiredPhase2Records(); return r.cases + r.assessments + r.overrides + r.usage; } },
  { name: "webChatRetention", everyMinutes: 1440, run: async () => { const r = await purgeExpiredWebChats(); return r.anonymousChats + r.expiredChats; } },
  // Social media. The publisher takes over jobs a dead worker left, publishes approved posts that are due (real accounts only while META_SOCIAL_WRITES_ENABLED is
  // on; simulated ones reach nothing) and checks every post whose outcome was unknown. Account health and engagement numbers are read a few times a day.
  { name: "socialPublisher", run: async () => { const r = await processDueSocialPosts({ budgetMs: PUBLISH_BUDGET_MS }); return r.claimed + r.recovered + r.reconciled; } },
  { name: "socialAccountHealth", everyMinutes: 360, run: () => checkAllAccounts() },
  { name: "socialMetrics", everyMinutes: 360, run: () => syncPostMetrics({ budgetMs: 40_000 }) },
  // The sealed Pages and tokens of a sign-in nobody finished are cleared as soon as its ten minutes are up (the state is deleted a day later), and a removed
  // library file whose stored copy could not be deleted at the time is finished. Like every job here it runs only when the scheduler does, and in a staged start
  // only when named in SCHEDULER_JOBS_ONLY.
  { name: "socialCleanup", everyMinutes: 15, run: async () => { const r = await purgeSignInStates(); return r.cleared + r.deleted + (await finishPendingMediaRemovals()); } },
  // Proposals (only workspaces a Super Admin switched them on for). Sent proposals past their valid-until date, in the workspace's own calendar, are closed and their links stop
  // opening; the owner is warned two days ahead. The daily clean-up removes spent emailed codes, sessions and the outbox copies of code emails. Neither contacts a customer.
  { name: "proposalExpiry", everyMinutes: 60, run: async () => { const r = await expireDueProposals(); return r.expired + r.warned; } },
  { name: "proposalHousekeeping", everyMinutes: 1440, run: async () => { const r = await proposalHousekeeping(); return r.challenges + r.sessions + r.codeEmails; } },
  // Electronic signatures (only workspaces a Super Admin switched proposals AND signing on for, that are not paused, and whose connection works). Hands queued signing requests to
  // the client's own signing service, checks the ones whose answer was lost, reads the ones that are out when no notice came, fetches signed copies, withdraws what was
  // withdrawn and checks each key a few times a day. A real service is written to only while ESIGN_WRITES_ENABLED is true; the simulated one reaches nothing and does not exist
  // in production. Every tick, not hourly: a request waits for a pass, and the service takes a few seconds to make a document, so a slower rhythm would stretch one signing request
  // over many minutes. Its polling and key checks keep their own, slower pace inside the job.
  { name: "esignSync", run: async () => { const r = await runEsignSync(); return r.claimed + r.recovered + r.reconciled + r.polled + r.copies + r.cancelled + r.checked; } },
  { name: "missedCallRecovery", run: async () => { const r = await processMissedCalls(); return r.claimed + r.swept; } },
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
  { name: "supportAutoClose", everyMinutes: 60, run: () => autoCloseResolvedRequests() },
  { name: "supportAttachmentCleanup", everyMinutes: 60, run: () => runAttachmentCleanup() },
  // Slower rhythms: each runs only when `everyMinutes` have passed since its previous run started; the ticks in between record nothing.
  { name: "fairUseChecks", everyMinutes: 60, run: async () => (await runFairUseChecks()).checked },
  { name: "inactivityReview", everyMinutes: 360, run: async () => (await runInactivityReview()).notified },
  { name: "offboardingReminders", everyMinutes: 360, run: () => sendDeletionReminders() },
  // Workflow runs a stopped worker left behind go back to the queue, and runs whose step approval lapsed are cancelled.
  { name: "crmWorkflowRecovery", everyMinutes: 5, run: async () => { const r = await recoverAbandonedRuns(); return r.recovered + r.lapsed; } },
  // Automation Studio plan (after the workflow housekeeping above): a plan past due whose grace period ended expires, and workflows built in Automation Studio are paused while the
  // plan isn't active (nothing is deleted or failed; core CRM workflows and AI employees are never selected). Two indexed queries when
  // nothing in the portal uses the plan, so it runs on every tick.
  { name: "studioEntitlementSweep", run: async () => { const r = await sweepStudioEntitlements(); return r.expired + r.workflowsPaused; } },
  // WhatsApp templates are reviewed, paused and edited in Meta: mirror them every three hours (read-only towards Meta).
  { name: "whatsappTemplateSync", everyMinutes: 180, run: async () => (await syncAllWhatsappTemplates()).synced },
  // Setup Center evidence that changes inside the CRM (a Blueprint applied, a calendar activated, a sender's live test) completes the
  // matching setup steps within fifteen minutes. Recorded evidence only: no provider is contacted. The shared fleet-wide lease is what
  // keeps this to once per fifteen minutes when server boot maintenance and several scheduled ticks overlap; when the lease is held this
  // job returns 0 without touching the database. It has its own lease, so it does not also declare `everyMinutes`.
  { name: "setupEvidence", run: async () => { const r = await runSetupMaintenance(); return r.created + r.updated; } },
  // AQi tutorial analytics retention: bounded to 500 events per run, never deletes progress, and
  // keeps events for people still in progress. It runs only when an external scheduler calls the
  // tick endpoint; registering the job does not create a cron.
  { name: "aqiTutorialEventRetention", everyMinutes: 1440, run: async () => (await purgeExpiredAqiTutorialEvents()).deleted },
  // AQi Operations briefings and critical alerts. Nothing is generated for an administrator who has not opted in; each briefing is keyed
  // per person and local day (or incident), so running on every tick is cheap and can never duplicate. Not interval-gated: the daily
  // and weekly slots are decided per person, in their own time zone, inside the job.
  { name: "aqiOperationsBriefings", run: async () => { const r = await runDueBriefings(); return r.generated + r.suppressed + r.alerts; } },
  // Investigation history and stored briefings older than 180 days are removed, 100 of each at a time. Confirmed actions stay in
  // aqi_ops_actions and the audit log.
  { name: "aqiOperationsRetention", run: async () => (await purgeExpiredOpsConversations()) + (await purgeExpiredBriefings()) },
  // AI work recovery is a fast, idempotent sweep: a job whose worker lease expired is re-queued
  // (while attempts remain) or failed honestly. It never executes provider work inside the tick;
  // the dedicated workforce worker (scripts/workforce-worker.ts) runs queued jobs.
  { name: "aiWorkRecovery", everyMinutes: 5, run: async () => { const r = await recoverExpiredWorkJobs(); return r.retried + r.failed + r.cancelled; } },
  // Enabled workforce schedules create durable jobs only when the operator sets
  // WORKFORCE_SCHEDULES_ENABLED=true. The row switch and this global switch are both required;
  // the tick still never executes provider work itself.
  { name: "aiWorkSchedules", run: async () => (await runDueSchedules()).created },
  // Event triggers create durable jobs only when WORKFORCE_TRIGGERS_ENABLED=true. The trigger row
  // must also be enabled; both are required and neither runs provider work inside the tick.
  { name: "aiWorkTriggers", run: async () => (await runDueTriggers()).created },
  // A non-critical proactive report that arrived during quiet hours is released after they end.
  // This only delivers an existing, already-verified report; it never creates work.
  { name: "aiProactiveHeldReports", everyMinutes: 5, run: async () => {
    const r = await releaseHeldProactiveReports();
    return r.delivered + r.suppressed;
  } },
  // Opt-in daily/weekly briefings. WORKFORCE_BRIEFINGS_ENABLED is off by default, so registering
  // this job cannot start a briefing by itself. It never runs provider work.
  { name: "aiProactiveBriefings", everyMinutes: 5, run: async () => {
    const r = await runProactiveBriefings();
    return r.generated + r.suppressed + r.held + r.failed;
  } },
  // Customer payments (a business's own PayMongo account, for its own invoices). Deliveries that were received and never applied are applied again, stale checkouts are closed,
  // open checkouts are read back so a lost webhook still settles, each connection is checked once a day, and deal rules an interrupted payment skipped run now. No real provider
  // is contacted unless CUSTOMER_PAYMENTS_WRITES_ENABLED is on; nothing is sent to a customer. Like every job here it runs only when the scheduler does, and in a staged start
  // only when named in SCHEDULER_JOBS_ONLY.
  { name: "customerPaymentReconcile", everyMinutes: 15, run: () => runCustomerPaymentReconcile() },
  // Customer invoices. The overdue sweep notices an unpaid invoice past its due date (one history line, one notice to the owner and one announcement per invoice and due date) and
  // sends nothing to anyone. The reminders job takes the reminders that have come due and hands each to the consent-gated send chain (scope "billing"); it does nothing for a workspace
  // whose owner has not authorized the exact wording, and a reminder is never sent more than a day late. Like every job here they run only when the scheduler does, and in a staged
  // start only when named in SCHEDULER_JOBS_ONLY.
  { name: "invoiceOverdueSweep", everyMinutes: 60, run: async () => (await runInvoiceOverdueSweep()).marked },
  { name: "invoiceReminders", everyMinutes: 15, run: () => runInvoiceRemindersJob() },
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

/** The longest SCHEDULER_JOBS_ONLY a tick accepts. A list naming every job is about 950 characters, so this is generous; a longer value is a mistake, and is refused. */
export const SCHEDULER_JOBS_ONLY_MAX_LENGTH = 2000;

/**
 * The jobs a tick runs: all of them when SCHEDULER_JOBS_ONLY is unset (env() reads an empty value as unset, and nothing else), otherwise exactly the jobs it names
 * (comma separated, exact case-sensitive names, any order; the registry's order is kept and a name given twice runs once). This is what lets the scheduler be switched
 * on in stages instead of all at once. Whatever is not named does not run and leaves no heartbeat. It fails closed: one name that does not exist refuses the WHOLE list
 * (a valid name beside it does not run), and a value that names nothing (spaces, tabs, commas) or is over 2000 characters throws too, so a typo can never silently run
 * something other than what was approved and the tick endpoint answers 500 and runs nothing (with the reason in the scheduler's heartbeat). Because the check is here and
 * not in env(), a bad list stops the scheduler only; it cannot make the application's whole configuration invalid. Names are matched by membership in a Set, never as keys of an object, so `__proto__`, `constructor`
 * and the like are just unknown names. Unset runs every job only behind CRON_SECRET and SCHEDULER_ENABLED (see the tick route).
 */
export function activeJobs(all: readonly ScheduledJob[] = JOBS, only: string | undefined = env().SCHEDULER_JOBS_ONLY): readonly ScheduledJob[] {
  if (only === undefined) return all;
  if (only.length > SCHEDULER_JOBS_ONLY_MAX_LENGTH) throw new Error(`SCHEDULER_JOBS_ONLY is longer than ${SCHEDULER_JOBS_ONLY_MAX_LENGTH} characters (naming every job takes about 1000).`);
  const names = only.split(",").map((s) => s.trim()).filter(Boolean);
  if (!names.length) throw new Error("SCHEDULER_JOBS_ONLY is set but names no job. Unset it (or leave it empty) to run every job.");
  const known = new Set(all.map((j) => j.name));
  const unknown = [...new Set(names.filter((n) => !known.has(n)))];
  if (unknown.length) throw new Error(`SCHEDULER_JOBS_ONLY names a job that does not exist: ${unknown.join(", ")}.`);
  const wanted = new Set(names);
  return all.filter((j) => wanted.has(j.name));
}

/**
 * One pass over the jobs. `now` and `jobs` exist for tests (a simulated clock and a controlled job list); the endpoint passes neither, so it runs
 * activeJobs(). A job that was not due is reported as "skipped" (running: another tick holds it) and leaves no trace in its heartbeat.
 */
export async function runScheduledJobs(now?: Date, jobs: readonly ScheduledJob[] = activeJobs()): Promise<Record<string, number | string>> {
  const ran: Record<string, number | string> = {};
  const outcome = await runJob("tick", async () => {
    for (const job of jobs) {
      const r = await runJob(job.name, job.run, (n) => ({ processed: n }), { everyMinutes: job.everyMinutes, now });
      ran[job.name] = !r.ok ? "failed" : "skipped" in r ? "skipped" : r.value;
    }
    return ran;
  }, undefined, { now });
  if (!outcome.ok) ran.tick = "failed";
  return ran;
}
