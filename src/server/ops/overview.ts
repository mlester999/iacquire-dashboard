import "server-only";
import { listIncidentsForAgency, type IncidentRow } from "@/server/ops/incidents";
import { listJobRuns, type JobRunRow } from "@/server/ops/jobs";
import { notificationDeliveryStats } from "@/server/ops/notification-email";
import { observeSchedulerFreshness, type SchedulerFreshness } from "@/server/ops/scheduler";
import type { SessionUser } from "@/server/auth/service";

export interface OpsOverview {
  scheduler: SchedulerFreshness;
  jobs: JobRunRow[];
  incidents: IncidentRow[];
  openCritical: number;
  openWarning: number;
  deliveries: { sent24h: number; skipped24h: number; failed24h: number };
}

/** Everything the agency health page needs about scheduled work and incidents. Opening the page also checks the scheduler is alive. */
export async function getOpsOverview(user: SessionUser): Promise<OpsOverview> {
  const scheduler = await observeSchedulerFreshness();
  const [jobs, incidents, deliveries] = await Promise.all([listJobRuns(), listIncidentsForAgency(user), notificationDeliveryStats()]);
  const open = incidents.filter((i) => i.status !== "resolved");
  return {
    scheduler,
    jobs,
    incidents,
    openCritical: open.filter((i) => i.severity === "critical").length,
    openWarning: open.filter((i) => i.severity === "warning").length,
    deliveries,
  };
}
