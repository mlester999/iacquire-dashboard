import Link from "next/link";
import { ArrowRight, Camera, LayoutTemplate, Send } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, ProgressBar } from "@/components/ui/primitives";
import { formatDate } from "@/lib/utils";
import { CRM_MODE_LABELS, type CrmMode } from "@/lib/crm/types";
import type { ApplicationStatus } from "@/lib/crm/blueprints/types";
import type { ApplicationSummary } from "@/lib/crm/blueprints/views";
import type { SessionUser } from "@/server/auth/service";
import { withSystem } from "@/server/db";
import { toPublicError } from "@/server/errors";
import { canBlueprint, canDoBlueprint } from "@/server/crm/blueprints/access";
import { listApplications } from "@/server/crm/blueprints/library";
import { getBlueprintChecklistForOrg } from "@/server/crm/blueprints/checklist";
import { APPLICATION_STATUS_LABELS } from "@/components/crm/blueprints/setup-screen";

export interface ClientBlueprintRow {
  applicationId: string;
  blueprintId: string;
  name: string;
  version: number;
  latestVersion: number | null;
  status: ApplicationStatus;
  via: "agency" | "onboarding";
  appliedAt: string;
  /**
   * Part of the latest published version isn't applied here yet: a newer version, or sections a section-limited update left out. It is
   * never pushed: the agency reviews it for this client.
   */
  updateAvailable: boolean;
}

export interface ClientBlueprintCardData {
  orgId: string;
  mode: CrmMode;
  switching: boolean;
  blueprints: ClientBlueprintRow[];
  checklist: { done: number; total: number; pending: string[] } | null;
  canApply: boolean;
  /** The dry run only (staff who design): a newer version can be previewed for this client, not applied. */
  canPreview?: boolean;
  canCapture: boolean;
  /** Set when the Blueprint details couldn't be read; the rest of the client page still works. */
  error: string | null;
}

/**
 * One row per Blueprint: its newest live application (or the newest one when every application was undone), newest first.
 * An update is offered only for a live application: as listApplications works it out (a newer version, or sections a section-limited update
 * left out), or, for rows it didn't work out, when a newer version is published.
 */
export function blueprintRows(apps: readonly ApplicationSummary[]): ClientBlueprintRow[] {
  // Live means what the apply engine counts as live (LIVE_STATUSES): a partly undone application is no longer the one an update builds on.
  const live = (a: ApplicationSummary) => a.status === "applied" || a.status === "partially_applied";
  const byBlueprint = new Map<string, ApplicationSummary>();
  for (const a of [...apps].sort((x, y) => (x.createdAt < y.createdAt ? 1 : x.createdAt > y.createdAt ? -1 : 0))) {
    const seen = byBlueprint.get(a.blueprintId);
    if (!seen || (!live(seen) && live(a))) byBlueprint.set(a.blueprintId, a);
  }
  return [...byBlueprint.values()]
    .sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1))
    .map((a) => ({
      applicationId: a.id,
      blueprintId: a.blueprintId,
      name: a.blueprintName,
      version: a.version,
      latestVersion: a.latestVersion,
      status: a.status,
      via: a.requestedVia,
      appliedAt: a.createdAt,
      updateAvailable: live(a) && (a.updateAvailable ?? (a.latestVersion !== null && a.latestVersion > a.version)),
    }));
}

/** What the client page's Blueprint card shows. The caller (the client page) has already checked this person may see this client. */
export async function loadClientBlueprintCard(user: SessionUser, orgId: string): Promise<ClientBlueprintCardData | null> {
  if (!canBlueprint(user, "crm.blueprints.view")) return null;
  const canApply = canDoBlueprint(user, "apply");
  const canCapture = canDoBlueprint(user, "capture");
  const canPreview = canDoBlueprint(user, "review_update");
  const ws = await withSystem((db) => db.query<{ mode: CrmMode; switching: boolean }>("select mode, switching from crm_workspaces where org_id = $1", [orgId]));
  const mode = ws.rows[0]?.mode ?? "native";
  const base = { orgId, mode, switching: ws.rows[0]?.switching ?? false, canApply, canPreview, canCapture };
  try {
    const [apps, checklist] = await Promise.all([listApplications(user, { orgId }), getBlueprintChecklistForOrg(orgId)]);
    return {
      ...base,
      blueprints: blueprintRows(apps.filter((a) => a.orgId === orgId)),
      checklist: checklist.total ? { done: checklist.done, total: checklist.total, pending: checklist.items.filter((i) => i.status === "pending").map((i) => i.label) } : null,
      error: null,
    };
  } catch (err) {
    return { ...base, blueprints: [], checklist: null, error: toPublicError(err).message };
  }
}

export async function ClientBlueprintCard({ user, orgId, timeZone }: { user: SessionUser; orgId: string; timeZone: string }) {
  const data = await loadClientBlueprintCard(user, orgId);
  return data ? <ClientBlueprintCardView data={data} timeZone={timeZone} /> : null;
}

/** The client page's "CRM Blueprint" card: the CRM mode, what was applied (and whether an update is waiting), and the setup checklist. */
export function ClientBlueprintCardView({ data, timeZone }: { data: ClientBlueprintCardData; timeZone: string }) {
  const { orgId } = data;
  const checklistHref = `/admin/clients/${orgId}/crm/settings/blueprints`;
  const ghl = data.mode === "ghl";
  const pct = data.checklist ? Math.round((data.checklist.done / data.checklist.total) * 100) : 0;
  return (
    <Card>
      <CardHeader className="flex-wrap">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary-ink"><LayoutTemplate className="size-4" aria-hidden /></span>
          <div className="min-w-0">
            <CardTitle>CRM Blueprint</CardTitle>
            <CardDescription>
              CRM mode: {CRM_MODE_LABELS[data.mode]?.label ?? data.mode}
              {data.switching ? " (switching providers)" : ""}
              {ghl ? ". Blueprints apply to iAcquire Native CRM only." : data.mode === "hybrid" ? ". Sections GoHighLevel owns are left out when a Blueprint is applied." : "."}
            </CardDescription>
          </div>
        </div>
        {!ghl && (data.canApply || data.canCapture) && (
          <div className="flex flex-wrap items-center gap-2">
            {/* The library opens filtered for this client: every Apply goes to this client's preview. */}
            {data.canApply && <ButtonLink href={`/admin/crm-blueprints?client=${orgId}`} size="sm" variant="secondary"><Send className="size-3.5" aria-hidden /> Apply a Blueprint</ButtonLink>}
            {/* Capture copies this client's own configuration (never contacts, messages or credentials) into a new draft. */}
            {data.canCapture && <ButtonLink href={`/admin/crm-blueprints?capture=${orgId}`} size="sm" variant="secondary"><Camera className="size-3.5" aria-hidden /> Capture as Blueprint</ButtonLink>}
          </div>
        )}
      </CardHeader>
      <CardContent className="grid gap-5 md:grid-cols-2">
        {data.error ? (
          <p role="alert" className="text-[13px] text-danger-ink md:col-span-2">Blueprint details couldn&apos;t be loaded: {data.error}</p>
        ) : (
          <>
            <div className="min-w-0">
              <p className="text-[12px] font-semibold uppercase tracking-[0.1em] text-muted">Applied</p>
              {data.blueprints.length === 0 ? (
                <p className="mt-1.5 text-[13px] text-muted">{ghl ? "None. This client's CRM configuration lives in GoHighLevel." : "No Blueprint applied. The client's CRM is set up by hand."}</p>
              ) : (
                <ul className="mt-1.5 divide-y divide-line">
                  {data.blueprints.map((b) => {
                    const s = APPLICATION_STATUS_LABELS[b.status];
                    return (
                      <li key={b.blueprintId} className="flex flex-wrap items-start justify-between gap-2 py-2 first:pt-0 last:pb-0">
                        <span className="min-w-0">
                          <span className="block text-[13px] font-medium text-ink">{b.name}</span>
                          <span className="block text-[12px] text-muted">
                            Version {b.version} · {formatDate(b.appliedAt, timeZone)} · {b.via === "onboarding" ? "at onboarding" : "by the agency"}
                          </span>
                          {b.updateAvailable && (
                            <span className="mt-1 flex flex-wrap items-center gap-2 text-[12px]">
                              <Badge tone="primary" className="h-5 px-2 text-[12px]">
                                {b.latestVersion !== null && b.latestVersion > b.version ? `Version ${b.latestVersion} available` : `Rest of version ${b.latestVersion ?? b.version} to apply`}
                              </Badge>
                              {(data.canApply || data.canPreview) && (
                                <Link href={`/admin/crm-blueprints/${b.blueprintId}/apply?client=${orgId}`} className="inline-flex min-h-11 items-center font-medium text-primary underline-offset-2 hover:underline sm:min-h-0">
                                  {data.canApply ? "Review update" : "Preview the update"}
                                </Link>
                              )}
                            </span>
                          )}
                        </span>
                        <Badge tone={s.tone}>{s.label}</Badge>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <div className="min-w-0">
              <p className="text-[12px] font-semibold uppercase tracking-[0.1em] text-muted">Setup checklist</p>
              {data.checklist ? (
                <div className="mt-1.5 space-y-2">
                  <p className="text-[13px] text-ink-2">{data.checklist.done} of {data.checklist.total} done</p>
                  <ProgressBar value={pct} tone={pct === 100 ? "success" : "primary"} label={`Setup checklist: ${data.checklist.done} of ${data.checklist.total} done`} />
                  {data.checklist.pending.length > 0 && (
                    <ul className="space-y-0.5 text-[12.5px] text-muted">
                      {data.checklist.pending.slice(0, 3).map((p) => <li key={p}>{p}</li>)}
                      {data.checklist.pending.length > 3 && <li>and {data.checklist.pending.length - 3} more</li>}
                    </ul>
                  )}
                </div>
              ) : (
                <p className="mt-1.5 text-[13px] text-muted">{data.blueprints.length ? "Nothing left to connect, assign or approve." : "Appears once a Blueprint is applied."}</p>
              )}
              {!ghl && (
                <Link href={checklistHref} className="mt-2 inline-flex min-h-11 items-center gap-1 text-[13px] font-medium text-primary underline-offset-2 hover:underline sm:min-h-0">
                  Open the checklist<ArrowRight className="size-3.5" aria-hidden />
                </Link>
              )}
              {!ghl && <p className="text-[12px] text-faint">Opens the client&apos;s CRM with a recorded support session.</p>}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
