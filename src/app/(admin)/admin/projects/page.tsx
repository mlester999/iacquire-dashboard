import Link from "next/link";
import { Building2, ChevronRight, CircleDollarSign, FolderKanban, Layers, UserRound } from "lucide-react";
import { requireAgency } from "@/server/tenancy/context";
import { agencyProjectStats, listAgencyProjects, listProjectClients } from "@/server/projects/agency";
import { AdminPageHeader } from "@/components/admin/admin-shell";
import { Card, EmptyState } from "@/components/ui/primitives";
import { AvatarTile, InfoChip, StatusPill } from "@/components/ui/status";
import { PROJECT_STATUSES, PROJECT_STATUS_LABEL, PROJECT_STATUS_TONE, formatMoney } from "@/lib/projects";
import { relativeTime } from "@/lib/utils";

export const metadata = { title: "Custom projects" };

export default async function AdminProjectsPage({ searchParams }: { searchParams: Promise<{ status?: string; view?: string; org?: string }> }) {
  const { status, view, org } = await searchParams;
  const user = await requireAgency();
  const filter = status && (PROJECT_STATUSES as readonly string[]).includes(status) ? status : "all";
  const orgFilter = org && /^[0-9a-f-]{36}$/i.test(org) ? org : undefined;
  const [projects, stats, clients] = await Promise.all([
    listAgencyProjects(user, { status: filter, assignedToMe: view === "mine", needsReview: view === "review", orgId: orgFilter }),
    agencyProjectStats(user),
    listProjectClients(user),
  ]);
  const tabs: Array<{ key: string; label: string; href: string; active: boolean }> = [
    { key: "all", label: "All", href: "/admin/projects", active: filter === "all" && !view },
    { key: "review", label: "Needs review", href: "/admin/projects?view=review", active: view === "review" },
    { key: "mine", label: "Assigned to me", href: "/admin/projects?view=mine", active: view === "mine" },
  ];
  return (
    <div>
      <AdminPageHeader title="Custom projects" description="Project requests from client workspaces you work on: review, scope, quote, deliver and hand over." />
      <div className="mb-4 flex flex-wrap items-center gap-2 text-[13px]">
        {(["submitted", "under_review", "discovery_needed", "quote_preparing", "quote_sent", "awaiting_approval", "in_development", "testing", "ready_for_review"] as const).map((s) => (
          <Link key={s} href={`/admin/projects?status=${s}`} className={`inline-flex min-h-9 items-center rounded-full border px-3.5 py-1 transition ${filter === s ? "border-primary bg-primary-soft text-primary-ink" : "border-line bg-surface text-muted hover:text-ink"}`}>
            {PROJECT_STATUS_LABEL[s]} <span className="ml-1 tabular-nums text-faint">{stats[s] ?? 0}</span>
          </Link>
        ))}
      </div>
      <form action="/admin/projects" method="get" className="mb-4 flex flex-wrap items-center gap-2 text-[14px]">
        {filter !== "all" && <input type="hidden" name="status" value={filter} />}
        {view && <input type="hidden" name="view" value={view} />}
        <label htmlFor="client-filter" className="text-muted">
          Client
        </label>
        <select id="client-filter" name="org" defaultValue={orgFilter ?? ""} className="h-10 rounded-xl border border-line-strong bg-surface px-3 text-[14px] text-ink">
          <option value="">All clients</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button type="submit" className="h-10 rounded-xl border border-line bg-surface px-4 font-medium shadow-soft hover:bg-surface-2">
          Filter
        </button>
        {orgFilter && (
          <Link href="/admin/projects" className="text-primary hover:underline">
            Clear client
          </Link>
        )}
      </form>
      <div className="relative scrollbar-thin mb-4 flex gap-1 overflow-x-auto lg:flex-wrap lg:overflow-visible">
        {tabs.map((t) => (
          <Link key={t.key} href={t.href} className={`shrink-0 rounded-xl px-3 py-1.5 text-[14px] font-medium transition ${t.active ? "border border-line bg-surface text-ink shadow-soft" : "text-muted hover:text-ink"}`}>
            {t.label}
          </Link>
        ))}
        {filter !== "all" && (
          <Link href="/admin/projects" className="shrink-0 rounded-xl px-3 py-1.5 text-[14px] text-primary hover:underline">
            Clear status filter
          </Link>
        )}
      </div>
      {projects.length === 0 ? (
        <Card>
          <EmptyState icon={<FolderKanban className="size-5" />} title="Nothing here" description="No project requests match this view." />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line">
            {projects.map((p) => (
              <li key={p.id}>
                <Link href={`/admin/projects/${p.id}`} className="group flex flex-col gap-2.5 px-4 py-3.5 transition hover:bg-surface-2/60 md:flex-row md:items-center md:gap-4 md:px-5">
                  <span className="flex min-w-0 flex-1 items-center gap-3">
                    <AvatarTile name={p.orgName} />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 md:flex-nowrap">
                        <span className="shrink-0 rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[12px] text-muted ring-1 ring-inset ring-line">{p.ref}</span>
                        <span className="min-w-0 basis-full text-[14px] font-semibold leading-snug text-ink md:basis-auto md:truncate" title={p.title}>{p.title}</span>
                      </span>
                      <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <InfoChip icon={<Building2 />}>{p.orgName}</InfoChip>
                        <InfoChip icon={<Layers />}>{p.serviceName ?? "Custom project"}</InfoChip>
                        <InfoChip icon={<UserRound />} className={p.assignedToName ? "" : "text-muted"}>{p.assignedToName ?? "Unassigned"}</InfoChip>
                        {p.agreedPriceCents !== null && <InfoChip icon={<CircleDollarSign />} className="tabular-nums">{formatMoney(p.agreedPriceCents)}</InfoChip>}
                      </span>
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-1.5 pl-12 md:justify-end md:pl-0">
                    {p.openTasks > 0 && <StatusPill tone="warning" size="sm">{p.openTasks} to do</StatusPill>}
                    {p.openChanges > 0 && <StatusPill tone="primary" size="sm">{p.openChanges} change{p.openChanges === 1 ? "" : "s"} open</StatusPill>}
                    {p.quoteStatus === "sent" && <StatusPill tone="primary" size="sm">Quote out</StatusPill>}
                    <StatusPill tone={PROJECT_STATUS_TONE[p.status]}>{PROJECT_STATUS_LABEL[p.status]}</StatusPill>
                  </span>
                  <span className="flex items-center gap-1 pl-12 text-[12px] text-muted md:w-28 md:justify-end md:pl-0">
                    {relativeTime(p.lastActivityAt)}
                    <ChevronRight className="hidden size-4 text-faint transition group-hover:translate-x-0.5 group-hover:text-ink-2 md:block" />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
