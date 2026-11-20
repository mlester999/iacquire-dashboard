import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/primitives";
import { formatDateTime } from "@/lib/utils";
import type { GrowthPartnerOperations, PartnerOperationsJob } from "@/server/admin/growth-partner-operations";

function JobList({ title, jobs, timeZone, empty }: {
  title: string; jobs: PartnerOperationsJob[]; timeZone: string; empty: string;
}) {
  return (
    <div className="min-w-0 space-y-2">
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      {jobs.length === 0
        ? <p className="text-sm text-muted">{empty}</p>
        : <ul className="divide-y divide-line rounded-xl border border-line px-3">
          {jobs.map((job) => (
            <li key={job.id} className="space-y-1 py-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium text-ink">{job.capability}</span>
                <Badge tone={job.status === "failed" ? "danger" : job.status === "blocked" || job.label === "Recovery pending" ? "warning" : "neutral"}>{job.label}</Badge>
              </div>
              <p className="text-xs text-muted">
                {job.finishedAt ? `Ended ${formatDateTime(job.finishedAt, timeZone)}` : job.startedAt ? `Started ${formatDateTime(job.startedAt, timeZone)}` : `Created ${formatDateTime(job.createdAt, timeZone)}`}
                {" · "}Attempts {job.attempts}/{job.maxAttempts}
              </p>
            </li>
          ))}
        </ul>}
    </div>
  );
}

export function GrowthPartnerOperationsPanel({ operations, timeZone }: {
  operations: GrowthPartnerOperations; timeZone: string;
}) {
  const bound = operations.state === "runtime_bound";
  return (
    <Card aria-label="Growth Partner schedules and executions">
      <CardHeader>
        <div>
          <CardTitle>Schedules and executions</CardTitle>
          {bound && <CardDescription>Current Growth Partner runtime · Times shown in {timeZone}.</CardDescription>}
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {!bound ? (
          <p className="text-sm text-muted">
            {operations.state === "identity_missing" ? "No Growth Partner has been provisioned for this workspace." : "The Growth Partner identity has no bound runtime yet."}
          </p>
        ) : (
          <>
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-ink">Schedules</h3>
                <div className="flex flex-wrap gap-2">
                  <Badge tone={operations.tickEnabled ? "neutral" : "warning"}>Scheduler tick {operations.tickEnabled ? "enabled" : "off"}</Badge>
                  <Badge tone={operations.schedulesEnabled ? "neutral" : "warning"}>Schedule processing {operations.schedulesEnabled ? "enabled" : "off"}</Badge>
                </div>
              </div>
              {!operations.tickIncludesSchedules && (
                <p className="text-xs text-muted">The configured scheduler allowlist excludes the Growth Partner schedule job.</p>
              )}
              {operations.schedules.length === 0 ? (
                <p className="text-sm text-muted">No schedules are saved for this runtime.</p>
              ) : (
                <ul aria-label={`Up to ${operations.scheduleLimit} saved schedules`} className="divide-y divide-line rounded-xl border border-line px-3">
                  {operations.schedules.map((schedule) => (
                    <li key={schedule.id} className="space-y-1 py-2.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-sm font-medium text-ink">{schedule.capability}</span>
                        <Badge tone={schedule.enabled ? "neutral" : "warning"}>{schedule.enabled ? "Enabled" : "Paused"}</Badge>
                      </div>
                      <p className="text-xs text-muted">
                        {schedule.enabled && `Next saved occurrence ${formatDateTime(schedule.nextRunAt, timeZone)} · `}
                        {schedule.lastQueuedAt ? `Last queued ${formatDateTime(schedule.lastQueuedAt, timeZone)}` : "No queued occurrence recorded"}
                        {schedule.lastJob && ` · Last job: ${schedule.lastJob}`}
                      </p>
                      {schedule.lastSkip && (
                        <p className="text-xs text-muted">{schedule.lastSkipAt && `${formatDateTime(schedule.lastSkipAt, timeZone)} · `}{schedule.lastSkip}</p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="grid gap-5 lg:grid-cols-2">
              <JobList title={`Pending work · up to ${operations.jobLimit}`} jobs={operations.pending} timeZone={timeZone} empty="No pending work is recorded." />
              <JobList title={`Recent job outcomes · up to ${operations.jobLimit}`} jobs={operations.outcomes} timeZone={timeZone} empty="No job outcomes are recorded." />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
