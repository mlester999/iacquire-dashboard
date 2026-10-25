import Link from "next/link";
import { ArrowRight, CalendarClock, CheckCircle2, CircleDashed, Clock, LayoutTemplate, MinusCircle } from "lucide-react";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, ProgressBar } from "@/components/ui/primitives";
import { PageTitle } from "@/components/crm/ui";
import { formatDate } from "@/lib/utils";
import { CRM_NAV } from "@/lib/crm/nav";
import { REQUIREMENT_INFO, type ApplicationStatus } from "@/lib/crm/blueprints/types";
import type { ChecklistItem, ChecklistStatus, SetupChecklist } from "@/lib/crm/blueprints/views";
import type { CrmScope } from "@/server/crm/page";

/** One application of a Blueprint to this workspace, as the client sees it (the library itself stays with the agency). */
export interface AppliedBlueprintView {
  id: string;
  name: string;
  version: number;
  status: ApplicationStatus;
  via: "agency" | "onboarding";
  appliedAt: string;
  rolledBackAt: string | null;
}

export interface DraftCalendarView {
  id: string;
  name: string;
  hosts: number;
}

export interface BlueprintSetupData {
  mode: "native" | "ghl" | "hybrid";
  applications: AppliedBlueprintView[];
  checklist: SetupChecklist;
  draftCalendars: DraftCalendarView[];
}

export const APPLICATION_STATUS_LABELS: Record<ApplicationStatus, { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  applied: { label: "Applied", tone: "success" },
  partially_applied: { label: "Applied in part", tone: "warning" },
  failed: { label: "Failed", tone: "danger" },
  rolled_back: { label: "Undone", tone: "neutral" },
  partially_rolled_back: { label: "Partly undone", tone: "neutral" },
};

export const CHECKLIST_STATUS: Record<ChecklistStatus, { label: string; tone: "success" | "warning" | "neutral" }> = {
  done: { label: "Done", tone: "success" },
  pending: { label: "To do", tone: "warning" },
  unavailable: { label: "Not available yet", tone: "neutral" },
};

const NAV_ITEMS = CRM_NAV.flatMap((s) => s.items).filter((i) => !i.external);

/** Where a checklist item is done: the CRM screen's name, and the link when this viewer can open that screen. */
export function placeFor(path: string | null, scope: Pick<CrmScope, "base" | "can">): { label: string; href: string | null } | null {
  if (!path) return null;
  const nav = NAV_ITEMS.find((i) => i.path === path);
  if (!nav) return { label: path, href: `${scope.base}${path}` };
  return { label: nav.label, href: scope.can[nav.permission] ? `${scope.base}${path}` : null };
}

/**
 * CRM Settings → Blueprints & setup. What was applied to this workspace from a CRM Blueprint, and the setup checklist that remains: each item
 * is "done" only on evidence in this workspace (a verified calendar, a connected sender, approved wording), never because a Blueprint was
 * applied, and capabilities iAcquire doesn't offer yet say so.
 */
export function BlueprintSetupScreen({ scope, data }: { scope: CrmScope; data: BlueprintSetupData }) {
  const { checklist } = data;
  const todo = checklist.items.filter((i) => i.status === "pending");
  const done = checklist.items.filter((i) => i.status === "done");
  const unavailable = checklist.items.filter((i) => i.status === "unavailable");
  const pct = checklist.total ? Math.round((checklist.done / checklist.total) * 100) : 0;

  return (
    <div>
      <PageTitle
        title="Blueprints & setup"
        description="What was copied into this CRM from a Blueprint, and what this workspace still has to connect, assign, fill in or approve before everything works. An item is marked done only when this workspace shows it."
      />

      {data.mode === "ghl" && (
        <p className="mb-4 rounded-xl border border-line bg-surface-2 px-3 py-2 text-[12.5px] leading-relaxed text-muted">
          This workspace uses GoHighLevel as its CRM, so Blueprints are not applied here.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader>
              <div className="min-w-0">
                <CardTitle>Setup checklist</CardTitle>
                <CardDescription>
                  {checklist.total
                    ? `${checklist.done} of ${checklist.total} done.`
                    : data.applications.length
                      ? "Nothing left to connect, assign or approve."
                      : "Appears once a Blueprint is applied to this workspace."}
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              {checklist.total > 0 && <ProgressBar value={pct} tone={pct === 100 ? "success" : "primary"} label={`Setup checklist: ${checklist.done} of ${checklist.total} done`} />}
              {checklist.items.length === 0 ? (
                <p className="text-[13px] text-muted">{data.applications.length ? "Everything this workspace's Blueprints need is in place." : "No Blueprint has been applied yet, so there is nothing to set up from one."}</p>
              ) : (
                <>
                  <ChecklistGroup title="To do" items={todo} scope={scope} />
                  <ChecklistGroup title="Done" items={done} scope={scope} />
                  <ChecklistGroup title="Not available yet" items={unavailable} scope={scope} />
                </>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="min-w-0 space-y-4">
          {data.draftCalendars.length > 0 && (
            <Card>
              <CardHeader>
                <div className="min-w-0">
                  <CardTitle>Draft calendars</CardTitle>
                  <CardDescription>They take no bookings until someone who manages calendars verifies and activates them.</CardDescription>
                </div>
              </CardHeader>
              <CardContent>
                <ul className="divide-y divide-line">
                  {data.draftCalendars.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0">
                      <span className="flex min-w-0 items-center gap-2">
                        <CalendarClock className="size-4 shrink-0 text-muted" aria-hidden />
                        <span className="min-w-0">
                          <span className="block truncate text-[13px] font-medium text-ink">{c.name}</span>
                          <span className="block text-[12px] text-muted">{c.hosts ? `${c.hosts} ${c.hosts === 1 ? "host" : "hosts"} assigned` : "No hosts assigned yet"}</span>
                        </span>
                      </span>
                      {scope.can["appointments.view"] ? (
                        <Link href={`${scope.base}/calendars/${c.id}`} className="inline-flex min-h-11 items-center gap-1 text-[12.5px] font-medium text-primary underline-offset-2 hover:underline sm:min-h-0">
                          Verify &amp; activate<ArrowRight className="size-3.5" aria-hidden />
                        </Link>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <div className="min-w-0">
                <CardTitle>Applied Blueprints</CardTitle>
                <CardDescription>Each one copied configuration into this workspace. Your team can change any of it; nothing here is kept in sync automatically.</CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              {data.applications.length === 0 ? (
                <EmptyState
                  icon={<LayoutTemplate className="size-5" />}
                  title="No Blueprint applied"
                  description={
                    scope.agency
                      ? "Apply one from CRM Blueprints in the agency console. Every change is previewed first, and nothing this team set up is replaced."
                      : "Your agency can apply a Blueprint to this workspace. They preview every change first, and nothing your team set up is replaced."
                  }
                  compact
                />
              ) : (
                <ul className="divide-y divide-line">
                  {data.applications.map((a) => {
                    const s = APPLICATION_STATUS_LABELS[a.status];
                    return (
                      <li key={a.id} className="flex flex-wrap items-start justify-between gap-2 py-2.5 first:pt-0 last:pb-0">
                        <span className="min-w-0">
                          <span className="block text-[13px] font-medium text-ink">{a.name}</span>
                          <span className="block text-[12px] text-muted">
                            Version {a.version} · {a.via === "onboarding" ? "During onboarding" : scope.agency ? "By the agency" : "By your agency"} · {formatDate(a.appliedAt, scope.timezone)}
                            {a.rolledBackAt ? ` · Undone ${formatDate(a.rolledBackAt, scope.timezone)}` : ""}
                          </span>
                        </span>
                        <Badge tone={s.tone}>{s.label}</Badge>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function ChecklistGroup({ title, items, scope }: { title: string; items: ChecklistItem[]; scope: CrmScope }) {
  if (!items.length) return null;
  return (
    <section aria-label={title}>
      <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.1em] text-muted">
        {title} <span className="font-normal">({items.length})</span>
      </h3>
      <ul className="space-y-2">
        {items.map((i) => <ChecklistRow key={i.key} item={i} scope={scope} />)}
      </ul>
    </section>
  );
}

function ChecklistRow({ item, scope }: { item: ChecklistItem; scope: CrmScope }) {
  const s = CHECKLIST_STATUS[item.status];
  const Icon = item.status === "done" ? CheckCircle2 : item.status === "pending" ? CircleDashed : MinusCircle;
  const place = item.status === "pending" ? placeFor(item.path, scope) : null;
  const owner = REQUIREMENT_INFO[item.key]?.owner;
  return (
    <li className="rounded-xl border border-line p-3" data-checklist-key={item.key} data-status={item.status}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2.5">
          <Icon className={item.status === "done" ? "mt-0.5 size-4 shrink-0 text-success" : item.status === "pending" ? "mt-0.5 size-4 shrink-0 text-warning" : "mt-0.5 size-4 shrink-0 text-faint"} aria-hidden />
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-ink">
              {item.label}
              {!item.required && <span className="ml-1.5 text-[12px] font-normal text-faint">Optional</span>}
            </p>
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted">{item.description}</p>
            {item.detail && <p className="mt-1 text-[12.5px] text-ink-2">{item.detail}</p>}
          </div>
        </div>
        <Badge tone={s.tone}>{s.label}</Badge>
      </div>
      {item.status === "pending" && (
        <div className="mt-2 pl-[26px] text-[12.5px]">
          {place?.href ? (
            <Link href={place.href} className="inline-flex min-h-11 items-center gap-1 font-medium text-primary underline-offset-2 hover:underline sm:min-h-0">
              Open {place.label}<ArrowRight className="size-3.5" aria-hidden />
            </Link>
          ) : place ? (
            <span className="text-muted">Done in {place.label}, by someone with access to it.</span>
          ) : item.key === "member_mapping" ? (
            <span className="text-muted">Chosen where each role is used: calendar hosts, assignment rule members and workflow steps.</span>
          ) : owner === "agency" ? (
            <span className="inline-flex items-center gap-1 text-muted"><Clock className="size-3.5" aria-hidden />{scope.agency ? "An agency task, done from the agency console." : "Your agency handles this."}</span>
          ) : (
            <span className="text-muted">{scope.agency ? "Done with the client." : "Ask your agency where this is done."}</span>
          )}
        </div>
      )}
    </li>
  );
}
