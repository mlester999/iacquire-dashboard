import Link from "next/link";
import { FolderKanban } from "lucide-react";
import { requireAgency } from "@/server/tenancy/context";
import { agencyProjectStats, listAgencyProjects, listProjectClients } from "@/server/projects/agency";
import { AdminPageHeader } from "@/components/admin/admin-shell";
import { Badge, Card, EmptyState } from "@/components/ui/primitives";
import { ProjectStatusBadge } from "@/components/projects/common";
import { PROJECT_STATUSES, PROJECT_STATUS_LABEL, formatMoney } from "@/lib/projects";
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
      <div className="mb-4 flex flex-wrap items-center gap-2 text-[12.5px]">
        {(["submitted", "under_review", "discovery_needed", "quote_preparing", "quote_sent", "awaiting_approval", "in_development", "testing", "ready_for_review"] as const).map((s) => (
          <Link key={s} href={`/admin/projects?status=${s}`} className={`rounded-full border px-3 py-1 transition ${filter === s ? "border-primary bg-primary-soft text-primary-ink" : "border-line bg-surface text-muted hover:text-ink"}`}>
            {PROJECT_STATUS_LABEL[s]} <span className="ml-1 tabular-nums text-faint">{stats[s] ?? 0}</span>
          </Link>
        ))}
      </div>
      <form action="/admin/projects" method="get" className="mb-4 flex flex-wrap items-center gap-2 text-[13px]">
        {filter !== "all" && <input type="hidden" name="status" value={filter} />}
        {view && <input type="hidden" name="view" value={view} />}
        <label htmlFor="client-filter" className="text-muted">
          Client
        </label>
        <select id="client-filter" name="org" defaultValue={orgFilter ?? ""} className="h-9 rounded-xl border border-line-strong bg-surface px-3 text-[13px]">
          <option value="">All clients</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button type="submit" className="h-9 rounded-xl border border-line bg-surface px-3 font-medium shadow-soft hover:bg-surface-2">
          Filter
        </button>
        {orgFilter && (
          <Link href="/admin/projects" className="text-primary hover:underline">
            Clear client
          </Link>
        )}
      </form>
      <div className="scrollbar-thin mb-4 flex gap-1 overflow-x-auto">
        {tabs.map((t) => (
          <Link key={t.key} href={t.href} className={`shrink-0 rounded-xl px-3 py-1.5 text-[13px] font-medium transition ${t.active ? "border border-line bg-surface text-ink shadow-soft" : "text-muted hover:text-ink"}`}>
            {t.label}
          </Link>
        ))}
        {filter !== "all" && (
          <Link href="/admin/projects" className="shrink-0 rounded-xl px-3 py-1.5 text-[13px] text-primary hover:underline">
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
                <Link href={`/admin/projects/${p.id}`} className="flex flex-col gap-1 px-5 py-3.5 transition hover:bg-surface-2/60 md:flex-row md:items-center md:gap-4">
                  <span className="font-mono text-[12px] text-muted md:w-20">{p.ref}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-medium">{p.title}</span>
                    <span className="block text-[12px] text-muted">
                      {p.orgName} · {p.serviceName ?? "Custom project"} · {p.assignedToName ? `assigned to ${p.assignedToName}` : "unassigned"}
                      {p.agreedPriceCents !== null ? ` · agreed ${formatMoney(p.agreedPriceCents)}` : ""}
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-1.5">
                    {p.openTasks > 0 && <Badge tone="warning">{p.openTasks} to do</Badge>}
                    {p.quoteStatus === "sent" && <Badge tone="primary">Quote out</Badge>}
                    <ProjectStatusBadge status={p.status} />
                  </span>
                  <span className="text-[12px] text-faint md:w-24 md:text-right">{relativeTime(p.lastActivityAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
