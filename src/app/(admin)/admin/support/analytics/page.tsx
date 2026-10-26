import Link from "next/link";
import { Lock } from "lucide-react";
import { requireAgency } from "@/server/tenancy/context";
import { loadAgencySupportCaps } from "@/server/support/access";
import { listAgencyFilterOptions } from "@/server/support/directory";
import { supportAnalytics, type AnalyticsFilters } from "@/server/support/analytics";
import { AppError } from "@/server/errors";
import { SupportSubnav } from "@/components/admin/support/subnav";
import { AnalyticsView } from "@/components/admin/support/analytics-view";
import { Card, EmptyState, Input, Label, Select } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { ALL_CATEGORIES, PRIORITIES, REQUEST_TYPES, REQUEST_TYPE_LABELS, TICKET_STATUSES, categoryLabel, statusLabelForAgency } from "@/lib/support/lifecycle";
import { sentenceCase } from "@/lib/utils";

export const metadata = { title: "Request analytics" };

type Params = Record<string, string | undefined>;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function SupportAnalyticsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const user = await requireAgency();
  const p = await searchParams;
  const caps = await loadAgencySupportCaps(user.id);
  const header = (
    <div className="min-w-0">
      <p className="text-[12px] font-semibold uppercase tracking-wide text-muted">Agency client care</p>
      <h1 className="mt-1 text-[26px] font-semibold tracking-[-0.04em] text-ink">Request analytics</h1>
      <p className="mt-1 max-w-2xl text-[14px] leading-relaxed text-muted">How quickly clients are helped, what they ask about, and where the team&apos;s time goes.</p>
    </div>
  );
  if (!caps["agency.support.analytics"]) {
    return (
      <div className="module-stack">
        {header}
        <SupportSubnav active="requests" caps={caps} />
        <Card><EmptyState icon={<Lock className="size-5" />} title="Support analytics isn't part of your role" description="A Super Admin can give you access from Agency team. Until then you can keep working in Requests." action={<Link href="/admin/support" className="text-[14px] font-medium text-primary-ink hover:underline">Back to Requests</Link>} /></Card>
      </div>
    );
  }
  const filters: AnalyticsFilters = {
    from: p.from || undefined, to: p.to || undefined, orgId: ID.test(p.org ?? "") ? p.org : undefined, category: p.category || undefined,
    requestType: (p.type || undefined) as AnalyticsFilters["requestType"], status: (p.status || undefined) as AnalyticsFilters["status"], priority: (p.priority || undefined) as AnalyticsFilters["priority"],
    assigneeId: p.assignee === "unassigned" || ID.test(p.assignee ?? "") ? p.assignee : undefined,
  };
  const options = await listAgencyFilterOptions(user);
  let data: Awaited<ReturnType<typeof supportAnalytics>> | null = null;
  let problem: string | null = null;
  try {
    data = await supportAnalytics(user, filters);
  } catch (error) {
    if (error instanceof AppError && (error.code === "invalid_input")) problem = error.message;
    else throw error;
  }
  return (
    <div className="module-stack">
      {header}
      <SupportSubnav active="analytics" caps={caps} />
      <Card className="p-4">
        <form method="get" action="/admin/support/analytics" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Analytics filters">
          <div className="space-y-1.5"><Label htmlFor="a-from">From</Label><Input id="a-from" type="date" name="from" defaultValue={data?.range.from ?? p.from ?? ""} /></div>
          <div className="space-y-1.5"><Label htmlFor="a-to">To</Label><Input id="a-to" type="date" name="to" defaultValue={data?.range.to ?? p.to ?? ""} /></div>
          <div className="space-y-1.5"><Label htmlFor="a-org">Client</Label><Select id="a-org" name="org" defaultValue={filters.orgId ?? ""}><option value="">All clients</option>{options.clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></div>
          <div className="space-y-1.5"><Label htmlFor="a-assignee">Assigned to</Label><Select id="a-assignee" name="assignee" defaultValue={filters.assigneeId ?? ""}><option value="">Anyone</option><option value="unassigned">Unassigned</option>{options.staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></div>
          <div className="space-y-1.5"><Label htmlFor="a-type">Type</Label><Select id="a-type" name="type" defaultValue={filters.requestType ?? ""}><option value="">Every type</option>{REQUEST_TYPES.map((t) => <option key={t} value={t}>{REQUEST_TYPE_LABELS[t].label}</option>)}</Select></div>
          <div className="space-y-1.5"><Label htmlFor="a-cat">Topic</Label><Select id="a-cat" name="category" defaultValue={filters.category ?? ""}><option value="">Every topic</option>{ALL_CATEGORIES.map((c) => <option key={c} value={c}>{categoryLabel(c)}</option>)}</Select></div>
          <div className="space-y-1.5"><Label htmlFor="a-pri">Priority</Label><Select id="a-pri" name="priority" defaultValue={filters.priority ?? ""}><option value="">Every priority</option>{PRIORITIES.map((x) => <option key={x} value={x}>{sentenceCase(x)}</option>)}</Select></div>
          <div className="space-y-1.5"><Label htmlFor="a-status">Status</Label><Select id="a-status" name="status" defaultValue={filters.status ?? ""}><option value="">Every status</option>{TICKET_STATUSES.map((x) => <option key={x} value={x}>{statusLabelForAgency(x)}</option>)}</Select></div>
          <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-4"><Button type="submit" variant="brand">Apply filters</Button><Link href="/admin/support/analytics" className="inline-flex min-h-11 items-center rounded-xl px-3 text-[14px] font-medium text-ink-2 hover:bg-surface-2">Reset</Link></div>
        </form>
      </Card>
      {problem && <p role="alert" className="rounded-xl border border-danger/25 bg-danger-soft px-4 py-3 text-[14px] text-danger-ink">{problem}</p>}
      {data && <AnalyticsView data={data} filterQuery={{ orgId: filters.orgId }} />}
    </div>
  );
}
