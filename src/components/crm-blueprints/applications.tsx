"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowUpRight, CircleAlert, ExternalLink, Eye, RotateCcw, Search, Send, ShieldCheck, Undo2 } from "lucide-react";
import { rollbackApplicationAction } from "@/app/actions/crm-blueprints";
import { ButtonLink, Button } from "@/components/ui/button";
import { Badge, Card, Input, Select } from "@/components/ui/primitives";
import { PageHero, SectionLabel } from "@/components/ui/workspace";
import { ConfirmDialog } from "@/components/crm/ui";
import { cn, formatDateTime } from "@/lib/utils";
import { APPLICATION_STATUSES, ASSET_SECTIONS, PLAN_ACTIONS, PLAN_ACTION_LABELS, type ApplicationStatus } from "@/lib/crm/blueprints/types";
import type { ApplicationDetail, ApplicationItemView, ApplicationSummary, RollbackResult, UpdateCandidate } from "@/lib/crm/blueprints/views";
import {
  APPLICATION_STATUS_LABEL, ApplicationStatusBadge, PlanActionBadge, RequirementList, When, bpHref, sectionLabel, useBlueprintAction,
} from "@/components/crm-blueprints/shared";

const STRATEGY_LABEL = { add_missing: "Add missing only", update_compatible: "Update compatible" } as const;
const MODE_LABEL = { initial: "First apply", update: "Update" } as const;

function countsLine(counts: ApplicationSummary["counts"]): string {
  const parts = PLAN_ACTIONS.filter((a) => (counts[a] ?? 0) > 0).map((a) => `${counts[a]} ${PLAN_ACTION_LABELS[a].toLowerCase()}`);
  return parts.length ? parts.join(" · ") : "No changes recorded";
}

/**
 * Part of the latest version is still to apply for this live application: as listApplications works it out (on the newest live application of
 * a Blueprint in a client, counting sections a section-limited update left out too), or, where it wasn't worked out, a newer published version.
 */
const updateAvailable = (a: ApplicationSummary) =>
  (a.status === "applied" || a.status === "partially_applied") && (a.updateAvailable ?? (a.latestVersion !== null && a.latestVersion > a.version));
/** "v3 available"; for an application of the latest version that left sections out, "Rest of v3 to apply". */
const updateLabel = (a: ApplicationSummary) => (a.latestVersion !== null && a.latestVersion > a.version ? `v${a.latestVersion} available` : `Rest of v${a.latestVersion ?? a.version} to apply`);

/**
 * Applications of Blueprints to clients: which client, which version, what happened, and whether a newer version could be reviewed.
 * `canPreview`: the person may run the dry run but not apply (agency staff who design); they get a "Preview the update" link instead.
 */
export function ApplicationsTable({ applications, canApply, canPreview = false, show = { client: true, blueprint: true }, caption }: {
  applications: ApplicationSummary[];
  canApply: boolean;
  canPreview?: boolean;
  show?: { client: boolean; blueprint: boolean };
  caption: string;
}) {
  const previewOnly = !canApply && canPreview;
  if (!applications.length) return <p className="rounded-xl border border-dashed border-line-strong px-4 py-8 text-center text-[14px] text-muted">No applications yet.</p>;
  return (
    <>
      <Card className="hidden overflow-hidden md:block">
        <div className="overflow-x-auto" tabIndex={0}>
          <table className="workspace-table w-full min-w-[860px] text-left text-[14px]">
            <caption className="sr-only">{caption}</caption>
            <thead>
              <tr>
                {show.client && <th scope="col" className="px-4 py-2.5">Client</th>}
                {show.blueprint && <th scope="col" className="px-4 py-2.5">Blueprint</th>}
                <th scope="col" className="px-4 py-2.5">Version</th>
                <th scope="col" className="px-4 py-2.5">Status</th>
                <th scope="col" className="px-4 py-2.5">What happened</th>
                <th scope="col" className="px-4 py-2.5">When</th>
                <th scope="col" className="px-4 py-2.5"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {applications.map((a) => (
                <tr key={a.id} className="border-t border-line align-top">
                  {show.client && <td className="px-4 py-3"><Link href={bpHref.client(a.orgId)} className="font-medium text-ink hover:underline">{a.orgName}</Link></td>}
                  {show.blueprint && <td className="px-4 py-3"><Link href={bpHref.detail(a.blueprintId)} className="font-medium text-ink hover:underline">{a.blueprintName}</Link></td>}
                  <td className="whitespace-nowrap px-4 py-3">
                    <span className="tabular-nums">v{a.version}</span>
                    {updateAvailable(a) && <Badge tone="primary" className="ml-2">{updateLabel(a)}</Badge>}
                  </td>
                  <td className="px-4 py-3"><ApplicationStatusBadge status={a.status} /><p className="mt-1 text-[12px] text-muted">{MODE_LABEL[a.mode]} · {STRATEGY_LABEL[a.strategy]}</p></td>
                  <td className="px-4 py-3 text-[13px] text-ink-2">{countsLine(a.counts)}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-[13px] text-muted"><When iso={a.createdAt} /><p className="text-[12px]">{a.requestedBy ?? "Agency"}{a.requestedVia === "onboarding" ? " · onboarding" : ""}</p></td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1.5">
                      {canApply && updateAvailable(a) && <ButtonLink href={bpHref.apply(a.blueprintId, a.orgId)} size="sm" variant="soft" aria-label={`Review the update of ${a.blueprintName} for ${a.orgName}`}>Review update</ButtonLink>}
                      {previewOnly && updateAvailable(a) && <ButtonLink href={bpHref.apply(a.blueprintId, a.orgId)} size="sm" variant="soft" aria-label={`Preview the update of ${a.blueprintName} for ${a.orgName}`}>Preview the update</ButtonLink>}
                      <ButtonLink href={bpHref.application(a.orgId, a.id)} size="sm" variant="ghost" aria-label={`Details of applying ${a.blueprintName} to ${a.orgName}`}>Details</ButtonLink>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <ul className="space-y-3 md:hidden" aria-label={caption}>
        {applications.map((a) => (
          <li key={a.id}>
            <Card className="p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  {show.client && <p className="truncate text-[14px] font-semibold text-ink">{a.orgName}</p>}
                  {show.blueprint && <p className={cn("truncate", show.client ? "text-[13px] text-muted" : "text-[14px] font-semibold text-ink")}>{a.blueprintName}</p>}
                </div>
                <ApplicationStatusBadge status={a.status} />
              </div>
              <p className="mt-2 text-[13px] text-ink-2">Version {a.version}{updateAvailable(a) ? ` · ${updateLabel(a)}` : ""} · {MODE_LABEL[a.mode]}</p>
              <p className="mt-1 text-[12px] text-muted">{countsLine(a.counts)}</p>
              <p className="mt-1 text-[12px] text-muted"><When iso={a.createdAt} />{a.requestedBy ? ` · ${a.requestedBy}` : ""}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <ButtonLink href={bpHref.application(a.orgId, a.id)} size="sm" variant="secondary">Details</ButtonLink>
                {canApply && updateAvailable(a) && <ButtonLink href={bpHref.apply(a.blueprintId, a.orgId)} size="sm" variant="soft">Review update</ButtonLink>}
                {previewOnly && updateAvailable(a) && <ButtonLink href={bpHref.apply(a.blueprintId, a.orgId)} size="sm" variant="soft">Preview the update</ButtonLink>}
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Clients that applied an earlier version. Nothing is pushed: each one is reviewed, previewed and confirmed separately. */
export function UpdateCandidates({ blueprintId, candidates, canApply, canPreview = false }: { blueprintId: string; candidates: UpdateCandidate[]; canApply: boolean; canPreview?: boolean }) {
  return (
    <section aria-label="Clients on an earlier version">
      <SectionLabel title="Clients on an earlier version" count={candidates.length}
        description="A newer version is never pushed. Review each client's update to see exactly what changes, what conflicts with their own edits, and choose which parts to take." />
      {candidates.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line-strong px-4 py-6 text-center text-[14px] text-muted">Every client that uses this Blueprint is on the latest version.</p>
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {candidates.map((c) => (
            <li key={c.orgId}>
              <Card className="flex h-full flex-col gap-2 p-4">
                <div className="flex items-start justify-between gap-2">
                  <Link href={bpHref.client(c.orgId)} className="truncate text-[14px] font-semibold text-ink hover:underline">{c.orgName}</Link>
                  <Badge tone="primary">v{c.appliedVersion} → v{c.latestVersion}</Badge>
                </div>
                <p className="text-[12px] text-muted">Last applied <When iso={c.lastAppliedAt} /></p>
                {c.changedSections.length > 0 && (
                  <ul className="flex flex-wrap gap-1.5" aria-label="Changed in the newer version">
                    {ASSET_SECTIONS.filter((s) => c.changedSections.includes(s)).map((s) => <li key={s} className="rounded-full bg-surface-2 px-2 py-0.5 text-[12px] font-medium text-ink-2">{sectionLabel(s)}</li>)}
                  </ul>
                )}
                <div className="mt-auto pt-2">
                  {canApply ? <ButtonLink href={bpHref.apply(blueprintId, c.orgId)} size="sm" variant="soft" aria-label={`Review the update for ${c.orgName}`}><Send className="size-3.5" /> Review update</ButtonLink>
                    : (
                      <div className="flex flex-wrap items-center gap-2">
                        {canPreview && <ButtonLink href={bpHref.apply(blueprintId, c.orgId)} size="sm" variant="soft" aria-label={`Preview the update for ${c.orgName}`}><Eye className="size-3.5" /> Preview the update</ButtonLink>}
                        <p className="text-[12px] text-muted">A super admin reviews and applies updates.</p>
                      </div>
                    )}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The applications history page
// ---------------------------------------------------------------------------

export function ApplicationsHistory({ applications, canApply, canPreview = false }: { applications: ApplicationSummary[]; canApply: boolean; canPreview?: boolean }) {
  const [q, setQ] = React.useState("");
  const [status, setStatus] = React.useState<ApplicationStatus | "all" | "updates">("all");
  const term = q.trim().toLowerCase();
  const list = applications.filter((a) => (!term || a.orgName.toLowerCase().includes(term) || a.blueprintName.toLowerCase().includes(term))
    && (status === "all" || (status === "updates" ? updateAvailable(a) : a.status === status)));
  const clients = new Set(applications.filter((a) => a.status === "applied" || a.status === "partially_applied").map((a) => a.orgId)).size;
  const updates = applications.filter(updateAvailable).length;
  return (
    <div className="module-stack">
      <PageHero eyebrow="CRM Blueprints" icon={<ShieldCheck className="size-5" />} title="Applications" tone="neutral"
        description="Every time a Blueprint was applied to a client: the version, what was created, updated, skipped or left for a decision, and the setup still open in that workspace. Only clients you can access are listed." />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Applications" value={applications.length} />
        <Stat label="Clients with a live Blueprint" value={clients} />
        <Stat label="Update available" value={updates} />
      </div>
      <div className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-3 shadow-soft sm:flex-row">
        <label className="relative flex-1">
          <span className="sr-only">Search applications</span>
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by client or Blueprint" className="pl-10" />
        </label>
        <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className="sm:w-56">
          <option value="all">All statuses</option>
          <option value="updates">Update available</option>
          {APPLICATION_STATUSES.map((s) => <option key={s} value={s}>{APPLICATION_STATUS_LABEL[s]}</option>)}
        </Select>
      </div>
      <p role="status" className="text-[12px] text-muted">{list.length} {list.length === 1 ? "application" : "applications"}</p>
      <ApplicationsTable applications={list} canApply={canApply} canPreview={canPreview} caption="Blueprint applications" />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return <div className="rounded-2xl border border-line bg-surface px-4 py-3 shadow-soft"><p className="text-[12px] font-medium text-muted">{label}</p><p className="mt-1 text-[26px] font-semibold tabular-nums tracking-[-0.03em] text-ink">{value}</p></div>;
}

// ---------------------------------------------------------------------------
// One application, and rolling it back
// ---------------------------------------------------------------------------

const OUTCOME_LABEL: Record<ApplicationItemView["outcome"], string> = { applied: "Done", skipped: "Left as is", failed: "Failed", rolled_back: "Rolled back", kept: "Kept" };
const OUTCOME_TONE: Record<ApplicationItemView["outcome"], "success" | "outline" | "danger" | "neutral" | "warning"> = { applied: "success", skipped: "outline", failed: "danger", rolled_back: "neutral", kept: "warning" };

export function ApplicationDetailView({ application: a, canApply, canPreview = false, timeZone, preview, sampleRollback }: {
  application: ApplicationDetail;
  /** Apply and roll back (super admins). */
  canApply: boolean;
  /** The dry run only (staff who design): a newer version can be previewed, not applied. */
  canPreview?: boolean;
  /** The signed-in person's time zone, so the server and the browser render the same times. */
  timeZone?: string;
  preview?: boolean;
  sampleRollback?: RollbackResult | null;
}) {
  const { run, busy } = useBlueprintAction(preview);
  const [confirming, setConfirming] = React.useState(false);
  const [result, setResult] = React.useState<RollbackResult | null>(sampleRollback ?? null);
  const [section, setSection] = React.useState<string>("all");
  const items = section === "all" ? a.items : a.items.filter((i) => i.section === section);
  const sections = ASSET_SECTIONS.filter((s) => a.items.some((i) => i.section === s));
  const created = a.items.filter((i) => i.action === "create" && i.outcome === "applied").length;
  const updated = a.items.filter((i) => i.action === "update" && i.outcome === "applied").length;

  const rollback = async () => {
    const res = await run("rollback", () => rollbackApplicationAction(a.orgId, a.id), (r) => r.kept.length ? `Rolled back ${r.rolledBack}; ${r.kept.length} kept with a reason.` : `Rolled back ${r.rolledBack}.`);
    if (res && typeof res === "object" && "rolledBack" in res) {
      setResult(res);
      setConfirming(false);
    }
  };

  return (
    <div className="module-stack">
      <PageHero eyebrow={`Applied to ${a.orgName}`} icon={<Send className="size-5" />} title={`${a.blueprintName} · version ${a.version}`} tone="neutral"
        description={<><ApplicationStatusBadge status={a.status} /> <span className="ml-1">{MODE_LABEL[a.mode]} · {STRATEGY_LABEL[a.strategy]} · {formatDateTime(a.createdAt, timeZone)}{a.requestedBy ? ` by ${a.requestedBy}` : ""}{a.requestedVia === "onboarding" ? " during onboarding" : ""}</span></>}
        action={<>
          <ButtonLink href={bpHref.clientCrm(a.orgId)} variant="secondary"><ExternalLink className="size-4" /> Open the client&apos;s CRM</ButtonLink>
          <ButtonLink href={bpHref.detail(a.blueprintId, "applications")} variant="ghost"><ArrowUpRight className="size-4" /> Blueprint</ButtonLink>
          {canApply && updateAvailable(a) && <ButtonLink href={bpHref.apply(a.blueprintId, a.orgId)} variant="soft">Review version {a.latestVersion}</ButtonLink>}
          {!canApply && canPreview && updateAvailable(a) && <ButtonLink href={bpHref.apply(a.blueprintId, a.orgId)} variant="soft"><Eye className="size-4" /> Preview version {a.latestVersion}</ButtonLink>}
          {canApply && a.canRollBack && !result && <Button variant="danger" onClick={() => setConfirming(true)}><Undo2 className="size-4" /> Roll back</Button>}
        </>} />

      {a.error && <p role="alert" className="flex gap-2 rounded-xl border border-danger/25 bg-danger-soft px-4 py-3 text-[14px] text-danger-ink"><CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />{a.error}</p>}
      {a.rolledBackAt && !result && <p className="rounded-xl border border-line bg-surface-2 px-4 py-3 text-[14px] text-ink-2">Rolled back {formatDateTime(a.rolledBackAt, timeZone)}. Records the client had changed or used since were kept.</p>}
      {/* canRollBack is only worked out for someone who may roll back (the same permission as applying). For anyone else it is false
          without a newer application having been looked for, so they are told who can roll back instead. */}
      {!a.canRollBack && !a.rolledBackAt && (a.status === "applied" || a.status === "partially_applied") && (
        <p className="rounded-xl border border-line bg-surface-2 px-4 py-3 text-[13px] text-muted">
          {canApply
            ? "Only the newest live application of a Blueprint in a workspace can be rolled back. A later application of this Blueprint exists for this client."
            : "Only an agency super admin can roll back an application."}
        </p>
      )}

      {result && (
        <Card className="p-5" aria-live="polite">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold text-ink"><RotateCcw className="size-4 text-primary" aria-hidden /> Rollback result</h2>
          <p className="mt-1 text-[14px] text-ink-2">{result.rolledBack} {result.rolledBack === 1 ? "change was" : "changes were"} undone. Status: {APPLICATION_STATUS_LABEL[result.status]}.</p>
          {result.kept.length > 0 && (
            <>
              <p className="mt-3 text-[14px] font-semibold text-ink">Kept, with the reason</p>
              <ul className="mt-1.5 divide-y divide-line overflow-hidden rounded-xl border border-line">
                {result.kept.map((k) => <li key={k.assetId} className="px-4 py-2.5"><p className="text-[14px] font-medium text-ink">{k.name}</p><p className="text-[12px] text-muted">{k.reason}</p></li>)}
              </ul>
            </>
          )}
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section aria-labelledby="bp-app-items" className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 id="bp-app-items" className="text-[17px] font-semibold tracking-[-0.025em] text-ink">What happened</h2>
              <p className="mt-1 text-[13px] text-muted">{created} created · {updated} updated · {a.items.length} items in all</p>
            </div>
            {sections.length > 1 && (
              <Select aria-label="Section" value={section} onChange={(e) => setSection(e.target.value)} className="w-56">
                <option value="all">All sections</option>
                {sections.map((s) => <option key={s} value={s}>{sectionLabel(s)}</option>)}
              </Select>
            )}
          </div>
          {items.length === 0 ? <p className="rounded-xl border border-dashed border-line-strong px-4 py-6 text-center text-[14px] text-muted">No items.</p> : (
            <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
              {items.map((i) => (
                <li key={i.assetId} className="flex flex-col gap-1.5 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className="break-words text-[14px] font-medium text-ink">{i.name}</p>
                    <p className="text-[12px] text-muted">{sectionLabel(i.section)} · <code className="font-mono">{i.assetId}</code></p>
                    {i.message && <p className="mt-1 text-[13px] text-ink-2">{i.message}</p>}
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-1.5"><PlanActionBadge action={i.action} /><Badge tone={OUTCOME_TONE[i.outcome]}>{OUTCOME_LABEL[i.outcome]}</Badge></div>
                </li>
              ))}
            </ul>
          )}
        </section>
        <aside aria-labelledby="bp-app-reqs" className="space-y-3">
          <h2 id="bp-app-reqs" className="text-[15px] font-semibold text-ink">Setup still open in this workspace</h2>
          <p className="text-[13px] leading-relaxed text-muted">Applying never completes these. The client&apos;s setup checklist marks each one done only on evidence in their workspace (a verified calendar, a connected sender, approved wording).</p>
          <RequirementList keys={a.requirements} compact />
        </aside>
      </div>

      <ConfirmDialog open={confirming} onOpenChange={setConfirming} title={`Roll back ${a.blueprintName} for ${a.orgName}?`} confirmLabel="Roll back" danger loading={busy("rollback")} onConfirm={() => void rollback()}
        description="This undoes what this application did, only where nothing was changed or used since.">
        <ul className="space-y-2 text-[13px] leading-relaxed text-ink-2">
          <li><strong className="font-semibold text-ink">Removed:</strong> records this application created that are unchanged and unused.</li>
          <li><strong className="font-semibold text-ink">Restored:</strong> records it updated, back to how they were, if nobody changed them since.</li>
          <li><strong className="font-semibold text-ink">Kept, with a reason:</strong> anything the client edited, tags on contacts, fields with values, pipelines or stages with deals, calendars with appointments, and folders that hold items.</li>
          <li><strong className="font-semibold text-ink">Never touched:</strong> contacts, companies, deals, conversations, appointments and everything the client created themselves.</li>
        </ul>
      </ConfirmDialog>
    </div>
  );
}
