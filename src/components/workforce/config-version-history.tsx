"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { toast } from "sonner";
import {
  ChevronDown,
  History,
  Info,
  Pencil,
  RotateCcw,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { InfoChip, StatusPill } from "@/components/ui/status";
import { FilterTabs, Notice } from "@/components/settings/panel";
import { NotificationTimestamp } from "@/components/notifications/notification-visuals";
import { rollbackAction } from "@/app/actions/workforce";
import {
  configRiskLabel,
  configVersionSourceLabel,
  configVersionStatus,
  type NotificationTone,
} from "@/lib/notification-presentation";
import { diffAgentSettings, LENGTH_COPY, TONE_COPY, type AgentSettings, type AgentSettingsChange } from "@/lib/agent-settings";
import { agentToolLabel } from "@/lib/agent-tools";
import { cn, formatDateTime } from "@/lib/utils";

export interface ConfigVersion {
  id: string;
  version: number;
  summary: string;
  status: string;
  source: string;
  change_request: string | null;
  risk_flags: string[];
  policy_version: string | null;
  created_at: string;
  applied_at: string | null;
  decided_at: string | null;
  created_by: string | null;
  decided_by: string | null;
  created_by_name: string | null;
  decided_by_name: string | null;
  /** Stored membership/platform role of the author, when it can be resolved. */
  created_by_role?: string | null;
  /** Stored membership/platform role of the reviewer, when it can be resolved. */
  decided_by_role?: string | null;
  settings: AgentSettings | null;
}

type Filter = "all" | "pending_agency_review" | "rejected";

const TILE: Record<NotificationTone, string> = {
  neutral: "border-line bg-surface-2 text-ink-2",
  primary: "border-primary/20 bg-primary-soft text-primary-ink",
  success: "border-success/25 bg-success-soft text-success-ink",
  warning: "border-warning/30 bg-warning-soft text-warning-ink",
  danger: "border-danger/25 bg-danger-soft text-danger-ink",
  violet: "border-violet/25 bg-violet-soft text-violet-ink",
};

/**
 * Legacy internal saves were persisted as `client_edit`. Label them from the authenticated workspace
 * context without changing the stored source, which remains visible in the details panel.
 */
function historySourceLabel(source: string, isInternalWorkspace: boolean): string {
  if (isInternalWorkspace && (source === "client_edit" || source === "agency")) return "Internal edit";
  return configVersionSourceLabel(source);
}

/** A verified stored role, worded safely for clients. Agency roles are not disguised as clients. */
function actorRoleLabel(role: string | null | undefined, isInternalWorkspace: boolean): string | null {
  if (!role) return null;
  if (role === "owner" || role === "admin" || role === "member") return role.slice(0, 1).toUpperCase() + role.slice(1);
  if (role === "agency_super_admin") return "Super Admin";
  if (role === "agency_manager") return "Agency Manager";
  if (role === "agency_staff") return isInternalWorkspace ? "Agency Staff" : "iAcquire team";
  return role.replaceAll("_", " ");
}

function statusLabel(status: string, isInternalWorkspace: boolean): string {
  if (status === "pending_agency_review") return isInternalWorkspace ? "Awaiting internal review" : "Awaiting review";
  return configVersionStatus(status).label;
}

function decisionLabel(status: string): string {
  if (status === "applied") return "Approved and applied";
  if (status === "rejected") return "Not approved";
  if (status === "pending_agency_review") return "Waiting for a reviewer";
  if (status === "superseded") return "Replaced by a newer version";
  if (status === "draft") return "Saved draft, not submitted";
  return "No decision recorded";
}

function versionCardTone(status: string): string {
  if (status === "applied") return "border-success/30";
  if (status === "pending_agency_review" || status === "pending_approval") return "border-warning/35";
  if (status === "rejected") return "border-danger/25";
  if (status === "draft") return "border-primary/25";
  return "border-line";
}

/** Show the same human words the configuration form uses, not the stored enum value. */
function diffValue(change: AgentSettingsChange, raw: string): string {  if (change.key === "tone") return TONE_COPY[raw as keyof typeof TONE_COPY]?.label ?? raw;
  if (change.key === "replyLength") return LENGTH_COPY[raw as keyof typeof LENGTH_COPY]?.label ?? raw;
  if (change.key === "disabledTools" && raw !== "None") {
    return raw
      .split(", ")
      .filter(Boolean)
      .map((tool) => agentToolLabel(tool))
      .join(", ");
  }
  return raw;
}

function startingSettings(settings: AgentSettings): Array<[string, string]> {
  const out: Array<[string, string]> = [
    ["Name", settings.displayName || "Not set"],
    ["Tone", TONE_COPY[settings.tone]?.label ?? settings.tone],
    ["Reply length", LENGTH_COPY[settings.replyLength]?.label ?? settings.replyLength],
    ["Language", settings.language],
    ["Approval preference", settings.approvalPreference === "always" ? "Ask before any action" : "Ask for high-impact actions"],
  ];
  if (settings.disabledTools.length) out.push(["Tools switched off", settings.disabledTools.join(", ")]);
  return out;
}

/**
 * A readable activity history of an AI employee's configuration. Every card is built from the saved
 * version row: no review decision, author, timestamp or changed field is inferred. Where two stored
 * settings snapshots exist, real field differences are shown; where they do not, the recorded summary
 * is shown instead, clearly labelled.
 */
export function ConfigVersionHistory({
  versions,
  role,
  timeZone,
  initialNow,
  isInternalWorkspace = false,
  draftVersion = null,
  canEdit = false,
  onEdit,
}: {
  versions: ConfigVersion[];
  role: string;
  timeZone: string;
  initialNow: number;
  /** Legacy internal saves were persisted as client_edit; label them from authenticated workspace context. */
  isInternalWorkspace?: boolean;
  /** The unapplied version currently open in Configure, if any. */
  draftVersion?: number | null;
  canEdit?: boolean;
  onEdit?: (versionId: string) => void;
}) {
  const router = useRouter();
  const reduced = useReducedMotion();
  const [filter, setFilter] = React.useState<Filter>("all");
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState<ConfigVersion | null>(null);
  const [pending, setPending] = React.useState(false);
  const [now, setNow] = React.useState(initialNow);

  React.useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(clock);
  }, []);

  // The page is ordered newest first. Keep the full list's neighbours so filtering never changes what
  // a version is compared with.
  const previous = React.useMemo(() => {
    const map = new Map<string, ConfigVersion>();
    for (let index = 0; index < versions.length; index += 1) {
      const older = versions[index + 1];
      if (older) map.set(versions[index].id, older);
    }
    return map;
  }, [versions]);

  const active = versions.find((version) => version.status === "applied") ?? null;
  const pendingCount = versions.filter((version) => version.status === "pending_agency_review").length;
  const rejectedCount = versions.filter((version) => version.status === "rejected").length;
  const latestPendingVersion = versions.reduce((max, version) => (version.status === "pending_agency_review" ? Math.max(max, version.version) : max), 0);
  const visible = versions.filter((version) => filter === "all" || version.status === filter);

  if (!versions.length) {
    return (
      <Card>
        <CardContent className="py-4">
          <EmptyState
            icon={<History className="size-5" />}
            title="No configuration versions yet"
            description="The first saved configuration will appear here with its source, author and status."
            compact
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden" data-aqi-target="workforce.employee.history">
      <CardHeader>
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2">
            <History className="size-4" aria-hidden /> Version history
          </CardTitle>
          <CardDescription>Every saved configuration, why it changed and who decided it. Restoring an older version creates a new version.</CardDescription>
        </div>
      </CardHeader>

      <div className="flex flex-wrap items-center gap-2 border-y border-line bg-surface-2/35 px-5 py-3">
        {active && (
          <StatusPill tone="success" size="sm">
            Active v{active.version}
          </StatusPill>
        )}
        {pendingCount > 0 && (
          <StatusPill tone="warning" size="sm">
            {pendingCount} awaiting review
          </StatusPill>
        )}
        {rejectedCount > 0 && (
          <StatusPill tone="danger" size="sm">
            {rejectedCount} not approved
          </StatusPill>
        )}
        <InfoChip icon={<Info aria-hidden />}>{versions.length} recorded</InfoChip>
        <span className="ml-auto text-[12px] text-muted">
          Latest change <NotificationTimestamp value={versions[0].created_at} timeZone={timeZone} now={now} className="ml-1 align-middle" />
        </span>
      </div>

      {(pendingCount > 0 || rejectedCount > 0) && (
        <div className="border-b border-line px-5 py-3">
          <FilterTabs
            label="Filter versions"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All versions", count: versions.length },
              ...(pendingCount ? [{ value: "pending_agency_review" as const, label: "Awaiting review", count: pendingCount }] : []),
              ...(rejectedCount ? [{ value: "rejected" as const, label: "Not approved", count: rejectedCount }] : []),
            ]}
          />
        </div>
      )}

      <CardContent className="space-y-3 pt-4">
        {visible.length === 0 ? (
          <EmptyState icon={<History className="size-5" />} title="Nothing in this filter" description="Clear the filter to see the full version history." compact />
        ) : (
          <ol className="space-y-3">
            {visible.map((version) => {
              const status = configVersionStatus(version.status);
              const previousVersion = previous.get(version.id) ?? null;
              const isInitial = version.version === 1;
              const diffs = version.settings && previousVersion?.settings ? diffAgentSettings(previousVersion.settings, version.settings) : [];
              const hasSnapshot = Boolean(version.settings);
              const comparison = previousVersion ? `Compared with v${previousVersion.version}` : null;
              const panelId = `version-${version.id}-details`;
              const open = expanded === version.id;
              const riskCount = version.risk_flags.length;
              return (
                <li key={version.id}>
                  <article
                    className={cn(
                      "relative overflow-hidden rounded-2xl border bg-surface transition-colors",
                      versionCardTone(version.status),
                      version.status === "pending_agency_review" && "bg-warning-soft/20",
                      version.status === "rejected" && "bg-danger-soft/10",
                      version.status === "superseded" && "bg-surface-2/20",
                    )}
                  >
                    {status.active && <span aria-hidden className="absolute inset-x-0 top-0 h-[2px] bg-success" />}
                    <div className="flex gap-3.5 p-4 sm:p-5">
                      <div role="group"
                        className={cn(
                          "flex size-11 shrink-0 flex-col items-center justify-center rounded-xl border text-center shadow-soft",
                          TILE[status.tone],
                        )}
                        aria-label={`Version ${version.version}`}
                      >
                        <span className="text-[12px] font-semibold uppercase leading-none tracking-[.14em] opacity-80">Ver</span>
                        <span className="mt-0.5 text-[18px] font-semibold leading-none tabular-nums">{version.version}</span>
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <h3 className="text-[14px] font-semibold tracking-tight text-ink">Configuration version {version.version}</h3>
                            <StatusPill tone={status.tone} size="sm">
                              {statusLabel(version.status, isInternalWorkspace)}
                            </StatusPill>
                            <Badge tone="outline" className="h-5 px-2 text-[12px]">
                              {historySourceLabel(version.source, isInternalWorkspace)}
                            </Badge>
                            {version.version === draftVersion && (
                              <Badge tone="primary" className="h-5 px-2 text-[12px]">
                                Editing now
                              </Badge>
                            )}
                          </div>
                          <NotificationTimestamp value={version.created_at} timeZone={timeZone} now={now} />
                        </div>

                        <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] text-muted">
                          <UserRound className="size-3.5 shrink-0 text-faint" aria-hidden />
                          {version.created_by_name ? (
                            <span>
                              Saved by <span className="font-medium text-ink-2">{version.created_by_name}</span>
                            </span>
                          ) : version.created_by ? (
                            <span>Saved by a teammate whose profile isn&apos;t visible in this workspace</span>
                          ) : (
                            <span>Saved automatically</span>
                          )}
                          {actorRoleLabel(version.created_by_role, isInternalWorkspace) && (
                            <>
                              <span aria-hidden className="text-faint">·</span>
                              <span>{actorRoleLabel(version.created_by_role, isInternalWorkspace)}</span>
                            </>
                          )}
                          <span aria-hidden className="text-faint">·</span>
                          <span>{status.description}</span>
                        </p>

                        {version.change_request && (
                          <p className="mt-2.5 line-clamp-2 rounded-lg border-l-2 border-primary/30 bg-primary-soft/25 px-2.5 py-1.5 text-[13px] leading-relaxed text-ink-2">
                            <span className="font-medium text-ink">Requested change:</span> “{version.change_request}”
                          </p>
                        )}

                        <div className="mt-3 rounded-xl border border-line/80 bg-surface-2/40 p-3">
                          <div className="flex flex-wrap items-baseline justify-between gap-2">
                            <p className="text-[12px] font-semibold uppercase tracking-[.14em] text-muted">Changes</p>
                            {comparison && <span className="text-[12px] text-faint">{comparison}</span>}
                          </div>
                          {isInitial ? (
                            <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">Initial configuration for this employee.</p>
                          ) : diffs.length > 0 ? (
                            <>
                              <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
                                {diffs.slice(0, 4).map((change) => (
                                  <li key={change.key} className="flex min-w-0 items-start gap-2 text-[13px]">
                                    <span aria-hidden className="mt-[7px] size-1.5 shrink-0 rounded-full bg-primary" />
                                    <span className="truncate font-medium text-ink-2">{change.label}</span>
                                  </li>
                                ))}
                              </ul>
                              {diffs.length > 4 && (
                                <p className="mt-1.5 text-[12px] text-muted">
                                  +{diffs.length - 4} more {diffs.length - 4 === 1 ? "field" : "fields"}
                                </p>
                              )}
                            </>
                          ) : hasSnapshot && previousVersion?.settings ? (
                            <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">No stored setting values changed from the previous version.</p>
                          ) : (
                            <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
                              {hasSnapshot
                                ? "A field-level comparison isn't available for this version because the earlier snapshot is outside the retained history."
                                : "This version has no readable settings snapshot. Its recorded summary is shown in the details."}
                            </p>
                          )}
                          {diffs.length === 0 && version.summary && (
                            <p className="mt-1.5 line-clamp-2 text-[12px] leading-relaxed text-muted">{version.summary}</p>
                          )}
                        </div>

                        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                          <button
                            type="button"
                            aria-expanded={open}
                            aria-controls={panelId}
                            onClick={() => setExpanded(open ? null : version.id)}
                            className="inline-flex min-h-8 items-center gap-1.5 rounded-lg px-1.5 text-[12px] font-semibold text-primary transition-colors hover:bg-primary-soft"
                          >
                            {open ? "Hide details" : diffs.length ? "View changes" : "View details"}
                            <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} aria-hidden />
                          </button>
                          <div className="flex flex-wrap items-center gap-2">
                            {riskCount > 0 && (
                              <span className="inline-flex items-center gap-1 text-[12px] text-warning-ink">
                                <ShieldCheck className="size-3.5" aria-hidden /> {riskCount} safety {riskCount === 1 ? "flag" : "flags"}
                              </span>
                            )}
                            {version.status === "superseded" && (
                              <Button size="sm" variant="secondary" onClick={() => setConfirm(version)}>
                                <RotateCcw className="size-3.5" aria-hidden /> Restore this version
                              </Button>
                            )}
                            {canEdit && onEdit && ["pending_agency_review", "rejected", "draft"].includes(version.status) && (
                              latestPendingVersion > version.version && version.status !== "pending_agency_review" ? (
                                <span className="text-[12px] text-muted">A newer version is awaiting review. Revise that version instead.</span>
                              ) : (
                                <Button
                                  size="sm"
                                  variant={version.status === "rejected" ? "secondary" : "brand"}
                                  onClick={() => onEdit(version.id)}
                                >
                                  <Pencil className="size-3.5" aria-hidden />
                                  {version.status === "rejected" ? `Revise v${version.version}` : `Continue editing v${version.version}`}
                                </Button>
                              )
                            )}
                          </div>
                        </div>
                      </div>
                    </div>

                    <AnimatePresence initial={false}>
                      {open && (
                        <motion.div
                          id={panelId}
                          role="region"
                          aria-label={`Version ${version.version} details`}
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          exit={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
                          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                          className="overflow-hidden border-t border-line bg-surface-2/30"
                        >
                          <div className="space-y-5 px-4 py-4 sm:px-5">
                            <div className="grid gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
                              <div>
                                <p className="text-[12px] font-semibold uppercase tracking-[.14em] text-muted">Version record</p>
                                <dl className="mt-2 grid gap-x-5 gap-y-2.5 sm:grid-cols-2">
                                  <Meta label="Created" value={formatDateTime(version.created_at, timeZone)} />
                                  <Meta label="Applied" value={version.applied_at ? formatDateTime(version.applied_at, timeZone) : "Not applied"} />
                                  <Meta
                                    label="Decision recorded by"
                                    value={
                                      <>
                                        {version.decided_by_name ??
                                          (version.decided_by ? "A reviewer whose profile isn't visible in this workspace" : "No decision recorded")}
                                        {actorRoleLabel(version.decided_by_role, isInternalWorkspace) && (
                                          <span className="text-muted"> · {actorRoleLabel(version.decided_by_role, isInternalWorkspace)}</span>
                                        )}
                                      </>
                                    }
                                  />
                                  <Meta label="Decision" value={decisionLabel(version.status)} />
                                  <Meta label="Decision time" value={version.decided_at ? formatDateTime(version.decided_at, timeZone) : "No decision recorded"} />
                                  <Meta
                                    label="Recorded source"
                                    value={
                                      <>
                                        {historySourceLabel(version.source, isInternalWorkspace)}
                                        {version.source && (
                                          <code className="ml-1.5 rounded bg-surface-3 px-1 py-0.5 font-mono text-[12px] text-muted">{version.source}</code>
                                        )}
                                      </>
                                    }
                                  />
                                  <Meta label="Policy version" value={version.policy_version ?? "Not recorded"} />
                                  <div className="sm:col-span-2">
                                    <dt className="text-[12px] font-medium uppercase tracking-[.1em] text-faint">Version ID</dt>
                                    <dd className="mt-0.5 break-all font-mono text-[12px] text-muted">{version.id}</dd>
                                  </div>
                                </dl>
                              </div>

                              <Notice
                                tone={riskCount > 0 || version.status === "pending_agency_review" ? "warning" : "neutral"}
                                icon={<ShieldCheck className="size-4" />}
                                title="Safety review"
                              >
                                {riskCount > 0 ? (
                                  <div>
                                    <p>This version was held because these patterns were detected:</p>
                                    <ul className="mt-1.5 flex flex-wrap gap-1.5">
                                      {version.risk_flags.map((flag) => (
                                        <li key={flag}>
                                          <StatusPill tone="warning" size="sm">
                                            {configRiskLabel(flag)}
                                          </StatusPill>
                                        </li>
                                      ))}
                                    </ul>
                                  </div>
                                ) : (
                                  <p>No safety flags were recorded when this version was saved.</p>
                                )}
                                {version.status === "pending_agency_review" && (
                                  <p className="mt-1.5 text-[12px]">
                                    It cannot be applied until {isInternalWorkspace ? "an authorized internal reviewer" : "an iAcquire reviewer"} approves it.
                                  </p>
                                )}
                                {version.status === "rejected" && (
                                  <p className="mt-1.5 text-[12px]">It was reviewed and not applied. The previous configuration stayed active.</p>
                                )}
                              </Notice>
                            </div>

                            {isInitial && version.settings && (
                              <div>
                                <p className="text-[12px] font-semibold uppercase tracking-[.14em] text-muted">Starting settings</p>
                                <dl className="mt-2 grid gap-x-5 gap-y-2 rounded-xl border border-line bg-surface p-3.5 sm:grid-cols-2">
                                  {startingSettings(version.settings).map(([label, value]) => (
                                    <div key={label}>
                                      <dt className="text-[12px] font-medium uppercase tracking-[.1em] text-faint">{label}</dt>
                                      <dd className="mt-0.5 text-[13px] text-ink-2">{value}</dd>
                                    </div>
                                  ))}
                                </dl>
                              </div>
                            )}

                            {diffs.length > 0 && (
                              <div>
                                <div className="flex flex-wrap items-baseline justify-between gap-2">
                                  <p className="text-[12px] font-semibold uppercase tracking-[.14em] text-muted">Field-by-field</p>
                                  {previousVersion && <span className="text-[12px] text-faint">v{previousVersion.version} → v{version.version}</span>}
                                </div>
                                <ul className="mt-2 divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
                                  {diffs.map((change) => (
                                    <li key={change.key} className="grid gap-2.5 p-3.5 sm:grid-cols-[minmax(120px,0.35fr)_minmax(0,1fr)]">
                                      <p className="text-[13px] font-semibold text-ink">{change.label}</p>
                                      <div className="grid gap-2 sm:grid-cols-2">
                                        <div className="rounded-lg border border-line/70 bg-surface-2/40 p-2">
                                          <p className="text-[12px] font-semibold uppercase tracking-[.12em] text-faint">Before</p>
                                          <p className="scrollbar-thin mt-1 max-h-36 overflow-y-auto whitespace-pre-wrap break-words text-[12px] leading-relaxed text-muted">
                                            {diffValue(change, change.before)}
                                          </p>
                                        </div>
                                        <div className="rounded-lg border border-primary/15 bg-primary-soft/30 p-2">
                                          <p className="text-[12px] font-semibold uppercase tracking-[.12em] text-primary-ink">After</p>
                                          <p className="scrollbar-thin mt-1 max-h-36 overflow-y-auto whitespace-pre-wrap break-words text-[12px] leading-relaxed text-ink-2">
                                            {diffValue(change, change.after)}
                                          </p>
                                        </div>
                                      </div>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}

                            {version.change_request && (
                              <div>
                                <p className="text-[12px] font-semibold uppercase tracking-[.14em] text-muted">Requested change</p>
                                <blockquote className="scrollbar-thin mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-line bg-surface p-3 text-[13px] leading-relaxed text-ink-2">
                                  {version.change_request}
                                </blockquote>
                              </div>
                            )}

                            <div>
                              <p className="text-[12px] font-semibold uppercase tracking-[.14em] text-muted">Recorded summary</p>
                              <p className="scrollbar-thin mt-1.5 max-h-56 overflow-y-auto whitespace-pre-line break-words rounded-xl border border-line bg-surface p-3 text-[13px] leading-relaxed text-ink-2">
                                {version.summary || "No summary was recorded with this version."}
                              </p>
                            </div>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </article>
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>

      <Dialog
        open={Boolean(confirm)}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={`Restore version ${confirm?.version}?`}
        description={
          pendingCount > 0
            ? "Restoring creates a new version and supersedes the change that is waiting for review. The row stays in history with its proposed settings preserved."
            : "The current settings stay in history, so you can switch back later. The restore is saved as a new version."
        }
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              loading={pending}
              onClick={async () => {
                if (!confirm) return;
                setPending(true);
                const result = await rollbackAction(role, confirm.id);
                setPending(false);
                if (!result.ok) return toast.error(result.error);
                toast.success(`Restored as v${result.data.version}`);
                setConfirm(null);
                router.refresh();
              }}
            >
              <RotateCcw className="size-4" aria-hidden /> Restore
            </Button>
          </>
        }
      />
    </Card>
  );
}

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[12px] font-medium uppercase tracking-[.1em] text-faint">{label}</dt>
      <dd className="mt-0.5 text-[13px] leading-relaxed text-ink-2">{value}</dd>
    </div>
  );
}
