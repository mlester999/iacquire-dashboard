import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, Flame, UserCheck, Hourglass } from "lucide-react";
import { requireAgency } from "@/server/tenancy/context";
import { getAgencyRequest, listAgencyRequests } from "@/server/support/agency";
import { listAgencyFilterOptions } from "@/server/support/directory";
import { loadAgencySupportCaps } from "@/server/support/access";
import { AgencyWorkspace } from "@/components/admin/support/workspace";
import { SupportSubnav } from "@/components/admin/support/subnav";
import { queueHref, VIEWS, type QueueQuery, type View } from "@/components/admin/support/meta";
import { PRIORITIES, REQUEST_TYPES } from "@/lib/support/lifecycle";

export const metadata = { title: "Requests" };

type Params = Record<string, string | undefined>;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SORTS = ["priority", "latest", "oldest", "due"] as const;

function parse(p: Params): QueueQuery {
  const pick = (v: string | undefined, allowed: readonly string[]) => (v && allowed.includes(v) ? v : "");
  return {
    view: (VIEWS.some((v) => v.value === p.view) ? p.view : "active") as View,
    q: (p.q ?? "").slice(0, 100).trim(),
    status: "",
    requestType: pick(p.type, REQUEST_TYPES),
    category: /^[a-z_]{2,40}$/.test(p.category ?? "") ? (p.category as string) : "",
    priority: pick(p.priority, PRIORITIES),
    assignee: p.assignee === "me" || p.assignee === "unassigned" || ID.test(p.assignee ?? "") ? (p.assignee as string) : "",
    orgId: ID.test(p.org ?? "") ? (p.org as string) : "",
    sort: (SORTS as readonly string[]).includes(p.sort ?? "") ? (p.sort as QueueQuery["sort"]) : "priority",
    page: Math.max(1, Math.min(500, Number.parseInt(p.page ?? "1", 10) || 1)),
    ticket: ID.test(p.ticket ?? "") ? (p.ticket as string) : "",
  };
}

export default async function RequestsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const user = await requireAgency();
  const query = parse(await searchParams);
  const [list, options, caps, detail] = await Promise.all([
    listAgencyRequests(user, {
      view: query.view, q: query.q, requestType: (query.requestType || undefined) as never, category: query.category || undefined, priority: (query.priority || undefined) as never,
      assignee: query.assignee || undefined, orgId: query.orgId || undefined, sort: query.sort, page: query.page, pageSize: 25,
    }),
    listAgencyFilterOptions(user),
    loadAgencySupportCaps(user.id),
    query.ticket ? getAgencyRequest(user, query.ticket) : Promise.resolve(null),
  ]);
  if (query.ticket && !detail) notFound();
  const c = list.counts;
  const tiles = [
    { view: "unassigned" as const, label: "Needs an owner", value: c.unassigned, icon: UserCheck, tone: "text-violet-ink" },
    { view: "overdue" as const, label: "Overdue", value: c.overdue, icon: AlertTriangle, tone: "text-danger-ink" },
    { view: "escalated" as const, label: "Escalated", value: c.escalated, icon: Flame, tone: "text-danger-ink" },
    { view: "waiting_on_client" as const, label: "Waiting on client", value: c.waitingOnClient, icon: Hourglass, tone: "text-ink-2" },
  ];
  return (
    <div className="module-stack">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[12px] font-semibold uppercase tracking-wide text-muted">Agency client care</p>
          <h1 className="mt-1 text-[26px] font-semibold tracking-[-0.04em] text-ink">Requests</h1>
          <p className="mt-1 max-w-2xl text-[13.5px] leading-relaxed text-muted">Support requests, issue reports and feedback from your clients. Prioritise, assign, reply and resolve, with every client&apos;s conversation kept together.</p>
        </div>
        <ul className="flex flex-wrap gap-2" aria-label="Queue at a glance">
          {tiles.map((t) => (
            <li key={t.view}>
              <Link href={queueHref(query, { view: t.view, page: 1, ticket: "" })} className="flex min-h-11 items-center gap-2.5 rounded-xl border border-line bg-surface px-3 py-2 shadow-soft transition hover:border-line-strong hover:bg-surface-2">
                <t.icon className={`size-4 ${t.tone}`} aria-hidden />
                <span className="text-[18px] font-semibold tabular-nums leading-none text-ink">{t.value}</span>
                <span className="text-[12px] text-muted">{t.label}</span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
      <SupportSubnav active="requests" caps={caps} />
      <AgencyWorkspace list={list} query={query} options={options} initialDetail={detail} timeZone={user.timezone} meId={user.id} layout="split" />
    </div>
  );
}
