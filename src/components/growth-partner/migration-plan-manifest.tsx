import { AGENT_BY_KEY } from "@/lib/agents";
import { formatDateTime, sentenceCase } from "@/lib/utils";
import type { MigrationPlanManifest, MigrationPlanStatus } from "@/server/admin/growth-partner-migration-plan";

const DISPOSITION = {
  propose_disabled_replacement: "Proposed disabled replacement",
  retain_legacy: "Keep on previous profile",
  keep_paused: "Keep paused",
} satisfies Record<MigrationPlanManifest["schedules"][number]["disposition"], string>;

export const PLAN_STATUS = {
  pending_review: "Waiting for owner review",
  approved: "Preparation approved",
  declined: "Declined",
  withdrawn: "Withdrawn",
  superseded: "Replaced",
} satisfies Record<MigrationPlanStatus, string>;

export function MigrationPlanManifestView({ manifest }: { manifest: MigrationPlanManifest }) {
  return (
    <div className="space-y-4 text-sm">
      <div className="space-y-1">
        <h4 className="font-semibold text-ink">Business Brain version {manifest.businessBrain.version}</h4>
        <p className="text-muted">{manifest.businessBrain.active ? "Active snapshot" : "Saved draft"} · {sentenceCase(manifest.businessBrain.source)} · {manifest.companyKnowledge.length} approved company knowledge sections · {manifest.reviewedSources.length} reviewed retained snapshots</p>
        {(manifest.companyKnowledge.length > 0 || manifest.reviewedSources.length > 0) && (
          <details className="rounded-xl border border-line p-3 text-xs text-muted">
            <summary className="cursor-pointer font-medium text-ink">Reviewed source references</summary>
            <ul className="mt-2 space-y-1">
              {manifest.companyKnowledge.map((source) => <li key={source.section}>{sentenceCase(source.section)} · Version {source.version}</li>)}
              {manifest.reviewedSources.map((source) => (
                <li key={source.id}>
                  {sentenceCase(source.type)} · {source.previousRole ? AGENT_BY_KEY[source.previousRole].shortName : "Shared workspace"} · <span className="break-all font-mono">{source.id}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <div className="space-y-1">
        <h4 className="font-semibold text-ink">Previous profile settings</h4>
        <ul className="grid gap-1 text-xs text-muted sm:grid-cols-2">
          {manifest.retainedProfiles.map((profile) => (
            <li key={profile.role}>{AGENT_BY_KEY[profile.role].shortName} · {profile.enabled ? "Enabled" : "Disabled"} · {profile.hasAppliedConfiguration ? "Applied configuration recorded" : "No applied configuration"}</li>
          ))}
        </ul>
      </div>
      <div className="space-y-1">
        <h4 className="font-semibold text-ink">Proposed schedule mapping</h4>
        {manifest.schedules.length === 0 ? <p className="text-muted">No previous profile schedules are saved.</p> : (
          <ul className="divide-y divide-line rounded-xl border border-line px-3">
            {manifest.schedules.map((schedule) => (
              <li key={schedule.id} className="space-y-1 py-2.5">
                <p className="font-medium text-ink">{schedule.capabilityLabel} · {DISPOSITION[schedule.disposition]}</p>
                <p className="text-xs text-muted">
                  {AGENT_BY_KEY[schedule.legacyRole].shortName} · {schedule.recurrence
                    ? `${sentenceCase(schedule.recurrence.kind)} at ${schedule.recurrence.localTime}${schedule.recurrence.kind === "weekly" ? ` on ${schedule.recurrence.weekdays.join(", ")}` : ""}`
                    : `Every ${schedule.intervalMinutes} minutes`}
                  {" · "}{schedule.timezone}
                </p>
                {schedule.disposition !== "keep_paused" && <p className="text-xs text-muted">Next recorded occurrence {formatDateTime(schedule.nextRunAt, schedule.timezone)}.</p>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
