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
  { name: "messagesDispatched", run: async () => (await dispatchDue()).attempted },
  { name: "websiteEnquiries", run: async () => (await processSubmissions()).processed },
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
  // Slower rhythms: each is skipped (returning 0) until enough time has passed since its last successful run.
  { name: "fairUseChecks", run: async () => ((await withinInterval("fairUseChecks", 60)) ? 0 : (await runFairUseChecks()).checked) },
  { name: "inactivityReview", run: async () => ((await withinInterval("inactivityReview", 360)) ? 0 : (await runInactivityReview()).notified) },
  { name: "offboardingReminders", run: async () => ((await withinInterval("offboardingReminders", 360)) ? 0 : await sendDeletionReminders()) },
];

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
