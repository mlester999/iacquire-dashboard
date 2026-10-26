"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight, Ban, Building2, CheckCircle2, ClipboardCheck, Clock, LayoutGrid, LifeBuoy, List, Search, UserRound, Workflow, X } from "lucide-react";
import { Card, EmptyState, Input, ProgressBar, Select } from "@/components/ui/primitives";
import { Tooltip } from "@/components/ui/overlays";
import { MetricCard } from "@/components/ui/workspace";
import { Button } from "@/components/ui/button";
import type { ClientSetupRow } from "@/server/setup/snapshots";
import { cn, formatDate } from "@/lib/utils";
import { ClientCard, ConnectionChips, PendingOwner } from "@/components/admin/client-card";
import { AvatarTile, RelativeTime, StatusPill } from "@/components/ui/status";
import { countStates, HEALTH, plural, STATE, STATE_ORDER, stateOf, type StateKey } from "@/components/admin/client-state";

type Sort = "attention" | "newest" | "name" | "progress_asc" | "progress_desc" | "activity" | "blocked";

export function ClientsTable({ rows, timeZone }: { rows: ClientSetupRow[]; timeZone: string }) {
  const [view, setView] = React.useState<"grid" | "table">("grid");
  const [q, setQ] = React.useState("");
  const [state, setState] = React.useState<"all" | StateKey>("all");
  const [owner, setOwner] = React.useState("all");
  const [needs, setNeeds] = React.useState({ action: false, blocked: false, issue: false });
  const [sort, setSort] = React.useState<Sort>("attention");

  const owners = React.useMemo(() => {
    const m = new Map<string, string>();
    rows.forEach((r) => r.responsible && m.set(r.responsible.id, r.responsible.name));
    return [...m].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);

  const counts = React.useMemo(() => countStates(rows), [rows]);
  const needCounts = React.useMemo(
    () => ({
      action: rows.filter((r) => r.setup.clientActions > 0).length,
      blocked: rows.filter((r) => r.setup.blocked > 0).length,
      issue: rows.filter((r) => r.health.level === "issue").length,
    }),
    [rows],
  );

  const list = React.useMemo(() => {
    const term = q.trim().toLowerCase();
    const attention = (r: ClientSetupRow) => (r.health.level === "issue" ? 4 : 0) + (r.setup.blocked ? 3 : 0) + (r.setup.clientActions ? 1 : 0);
    const filtered = rows.filter((r) => {
      if (term && !`${r.name} ${r.slug} ${r.contact?.name ?? ""} ${r.contact?.email ?? ""}`.toLowerCase().includes(term)) return false;
      if (state !== "all" && stateOf(r) !== state) return false;
      if (owner === "none" ? r.responsible : owner !== "all" && r.responsible?.id !== owner) return false;
      if (needs.action && !r.setup.clientActions) return false;
      if (needs.blocked && !r.setup.blocked) return false;
      if (needs.issue && r.health.level !== "issue") return false;
      return true;
    });
    const t = (d: string | null) => (d ? new Date(d).getTime() : 0);
    return [...filtered].sort((a, b) => {
      switch (sort) {
        case "name":
          return a.name.localeCompare(b.name);
        case "newest":
          return t(b.createdAt) - t(a.createdAt);
        case "progress_asc":
          return (a.setup.percent ?? -1) - (b.setup.percent ?? -1);
        case "progress_desc":
          return (b.setup.percent ?? -1) - (a.setup.percent ?? -1);
        case "activity":
          return t(b.lastActivityAt) - t(a.lastActivityAt);
        case "blocked":
          return b.setup.blocked - a.setup.blocked;
        default:
          return attention(b) - attention(a) || t(b.createdAt) - t(a.createdAt);
      }
    });
  }, [rows, q, state, owner, needs, sort]);

  const filtering = q || state !== "all" || owner !== "all" || needs.action || needs.blocked || needs.issue;
  const reset = () => {
    setQ("");
    setState("all");
    setOwner("all");
    setNeeds({ action: false, blocked: false, issue: false });
  };

  const needAttention = rows.filter((r) => r.health.level === "issue" || r.setup.blocked > 0).length;
  const approvedShare = rows.length ? Math.round((counts.activated / rows.length) * 100) : 0;

  return (
    <div className="space-y-5" data-aqi-target="admin.clients.table">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard label="Client workspaces" value={rows.length} icon={<Building2 className="size-4" />} tone="blue" detail={needAttention ? `${needAttention} ${needAttention === 1 ? "needs" : "need"} attention` : "All clear"} />
        <MetricCard label="Taking shape" value={counts.in_setup + counts.awaiting_onboarding + counts.not_started} icon={<Workflow className="size-4" />} tone="violet" detail={`${counts.awaiting_onboarding} awaiting onboarding`} />
        <MetricCard label="Final review" value={counts.ready_for_review} icon={<ClipboardCheck className="size-4" />} tone="amber" detail={counts.ready_for_review ? "Ready for your approval" : "Nothing waiting"} />
        <MetricCard label="Approved" value={counts.activated} icon={<CheckCircle2 className="size-4" />} tone="green" detail={`${approvedShare}% of your clients`} />
      </div>

      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 p-3 sm:p-4 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-faint" />
            <Input aria-label="Search clients" className="h-11 rounded-2xl pl-10 sm:h-11" placeholder="Search companies or contacts…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-2 md:flex md:items-center">
            <Select aria-label="Filter by responsible team member" className="rounded-2xl sm:h-11 md:w-48" value={owner} onChange={(e) => setOwner(e.target.value)}>
              <option value="all">Any assignee</option>
              <option value="none">Unassigned</option>
              {owners.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </Select>
            <Select aria-label="Sort clients" className="rounded-2xl sm:h-11 md:w-52" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              <option value="attention">Needs attention first</option>
              <option value="newest">Newest first</option>
              <option value="name">Name A–Z</option>
              <option value="progress_asc">Setup: least complete</option>
              <option value="progress_desc">Setup: most complete</option>
              <option value="blocked">Most blocked steps</option>
              <option value="activity">Recent activity</option>
            </Select>
            <div role="group" aria-label="Client directory display" className="hidden rounded-2xl bg-surface-2 p-1 ring-1 ring-inset ring-line md:ml-auto md:flex lg:ml-0">
              <Button variant={view === "grid" ? "secondary" : "ghost"} size="icon-sm" className="rounded-xl" aria-label="Company card view" aria-pressed={view === "grid"} onClick={() => setView("grid")}>
                <LayoutGrid className="size-4" />
              </Button>
              <Button variant={view === "table" ? "secondary" : "ghost"} size="icon-sm" className="rounded-xl" aria-label="Client table view" aria-pressed={view === "table"} onClick={() => setView("table")}>
                <List className="size-4" />
              </Button>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-line bg-surface-2/40 px-3 py-3 sm:px-4">
          <div role="group" aria-label="Filter by state" className="relative scrollbar-thin -mx-1 flex max-w-full shrink-0 items-center gap-1.5 overflow-x-auto px-1 pb-1 sm:pb-0">
            {(["all", ...STATE_ORDER] as const)
              .filter((k) => k === "all" || counts[k] > 0 || state === k)
              .map((k) => {
                const active = state === k;
                const count = k === "all" ? rows.length : counts[k];
                return (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setState(k)}
                    className={cn(
                      "inline-flex h-9 shrink-0 items-center gap-2 rounded-full px-3.5 text-[14px] font-medium transition-colors duration-200",
                      active ? "bg-ink text-surface shadow-soft" : "text-ink-2 hover:bg-surface-3/70",
                    )}
                  >
                    {k === "all" ? "All clients" : STATE[k].label}
                    <span className={cn("grid h-5 min-w-5 place-items-center rounded-full px-1.5 text-[12px] font-semibold tabular-nums", active ? "bg-surface/20 text-surface" : "bg-surface text-muted ring-1 ring-inset ring-line")}>{count}</span>
                  </button>
                );
              })}
          </div>
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Quick filters">
            {(
              [
                ["action", "Waiting on client", Clock],
                ["blocked", "Has blocked steps", Ban],
                ["issue", "Integration issues", AlertTriangle],
              ] as const
            ).map(([k, label, Icon]) => (
              <button
                key={k}
                type="button"
                aria-pressed={needs[k]}
                onClick={() => setNeeds({ ...needs, [k]: !needs[k] })}
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium ring-1 ring-inset transition-colors duration-200",
                  needs[k] ? "bg-primary-soft text-primary-ink ring-primary/25" : "bg-surface text-muted ring-line-strong hover:text-ink",
                )}
              >
                <Icon className="size-3.5" aria-hidden />
                {label}
                <span className="tabular-nums opacity-70">{needCounts[k]}</span>
              </button>
            ))}
            {filtering && (
              <button type="button" onClick={reset} className="inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-[13px] text-muted hover:text-ink">
                <X className="size-3.5" /> Clear
              </button>
            )}
            <span className="ml-1 whitespace-nowrap text-[13px] tabular-nums text-muted" aria-live="polite">
              {list.length} of {rows.length}
            </span>
          </div>
        </div>
      </Card>

      {list.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Search className="size-5" />}
            title="No clients match"
            description="Try a different search or clear the filters."
            action={
              <button type="button" onClick={reset} className="text-[14px] font-medium text-primary hover:underline">
                Clear filters
              </button>
            }
          />
        </Card>
      ) : (
        <>
          {/* Desktop table */}
          <Card className={cn("overflow-hidden", view === "table" ? "hidden md:block" : "hidden")}>
            <div className="scrollbar-thin overflow-x-auto" tabIndex={0}>
              <table className="workspace-table w-full min-w-[960px] text-left text-[14px]">
                <thead className="border-b border-line bg-surface-2/60">
                  <tr>
                    <th scope="col" className="px-4 py-3.5 font-semibold">Company</th>
                    <th scope="col" className="px-2 py-3.5 font-semibold">Setup</th>
                    <th scope="col" className="px-2 py-3.5 font-semibold">State</th>
                    <th scope="col" className="px-2 py-3.5 font-semibold">Open work</th>
                    <th scope="col" className="px-2 py-3.5 font-semibold">Responsible</th>
                    <th scope="col" className="px-2 py-3.5 font-semibold">Connections</th>
                    <th scope="col" className="px-4 py-3.5 font-semibold">Latest update</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {list.map((r) => {
                    const s = STATE[stateOf(r)];
                    return (
                      <tr key={r.id} className="group">
                        <td className="min-w-[210px] max-w-[240px] px-4 py-4">
                          <div className="flex items-center gap-3">
                            <AvatarTile name={r.name} size="md" />
                            <div className="min-w-0">
                              <Link href={`/admin/clients/${r.id}`} title={r.name} className="line-clamp-2 break-words font-semibold leading-snug text-ink hover:text-primary">
                                {r.name}
                              </Link>
                              {r.contact ? <p className="mt-0.5 truncate text-[12px] text-muted" title={`${r.contact.name} · ${r.contact.email}`}>{r.contact.name} · {r.contact.email}</p> : <div className="mt-1.5"><PendingOwner /></div>}
                            </div>
                          </div>
                        </td>
                        <td className="px-2 py-4">
                          <SetupCell r={r} />
                        </td>
                        <td className="px-2 py-4">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <StatusPill tone={s.tone}>{s.label}</StatusPill>
                            {r.isDemo && <StatusPill tone="violet" size="sm" dot={false}>Demo</StatusPill>}
                          </div>
                          <p className="mt-1.5 whitespace-nowrap text-[12px] text-muted">{r.onboardingCompletedAt ? `Onboarded ${formatDate(r.onboardingCompletedAt, timeZone)}` : "Not onboarded yet"}</p>
                        </td>
                        <td className="whitespace-nowrap px-2 py-4">
                          <span className="font-semibold tabular-nums text-ink">{r.setup.outstanding} <span className="font-normal text-muted">open</span></span>
                          <div className="mt-1.5 flex flex-col items-start gap-1.5 empty:hidden">
                            {r.setup.clientActions > 0 && (
                              <StatusPill tone="warning" icon={<Clock className="size-3" aria-hidden />}>{r.setup.clientActions} waiting on client</StatusPill>
                            )}
                            {r.setup.blocked > 0 && (
                              <Tooltip content={r.setup.blockers.join(" · ")}>
                                <span>
                                  <StatusPill tone="danger" icon={<Ban className="size-3" aria-hidden />}>{r.setup.blocked} blocked</StatusPill>
                                </span>
                              </Tooltip>
                            )}
                            {r.openTickets > 0 && (
                              <Link href="/admin/support">
                                <StatusPill tone="primary" icon={<LifeBuoy className="size-3" aria-hidden />}>{plural(r.openTickets, "support issue")}</StatusPill>
                              </Link>
                            )}
                          </div>
                        </td>
                        <td className="px-2 py-4">
                          {r.responsible ? (
                            <span className="flex items-center gap-2 whitespace-nowrap text-ink-2">
                              <AvatarTile name={r.responsible.name} size="sm" />
                              {r.responsible.name}
                            </span>
                          ) : (
                            <span className="flex items-center gap-2 whitespace-nowrap text-faint">
                              <span aria-hidden className="grid size-7 place-items-center rounded-lg border border-dashed border-line-strong"><UserRound className="size-3.5" /></span>
                              Unassigned
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-4">
                          <HealthCell r={r} />
                        </td>
                        <td className="whitespace-nowrap py-4 pl-2.5 pr-3 text-ink-2">
                          <span className="flex items-center justify-between gap-1.5">
                            {r.lastActivityAt ? <RelativeTime value={r.lastActivityAt} /> : <span className="text-faint">None yet</span>}
                            <Link href={`/admin/clients/${r.id}`} aria-label={`Open ${r.name}`} className="flex size-6 shrink-0 items-center justify-center rounded-full text-faint ring-1 ring-inset ring-transparent transition hover:bg-primary hover:text-white">
                              <ArrowRight className="size-4" />
                            </Link>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Cards: the default directory on desktop and the only layout on mobile */}
          <ul className={view === "grid" ? cn("grid gap-5", list.length > 1 && "sm:grid-cols-2", list.length > 2 && "2xl:grid-cols-3") : "space-y-4 md:hidden"}>
            {list.map((r, i) => (
              <ClientCard key={r.id} r={r} timeZone={timeZone} index={i} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function SetupCell({ r }: { r: ClientSetupRow }) {
  if (!r.setup.started) return <span className="text-[13px] text-faint">Checklist not started</span>;
  if (r.setup.percent === null) return <span className="text-[13px] text-faint">No required steps</span>;
  return (
    <div className="flex min-w-[140px] items-center gap-2">
      <ProgressBar value={r.setup.percent} tone={r.setup.percent === 100 ? "success" : "primary"} className="h-2 min-w-12 flex-1" label={`${r.name} setup progress`} />
      <span className="shrink-0 whitespace-nowrap text-right text-[13px] tabular-nums text-ink-2">
        <span className="font-semibold">{r.setup.percent}%</span> <span className="text-faint">· {r.setup.completed}/{r.setup.total}</span>
      </span>
    </div>
  );
}

function HealthCell({ r }: { r: ClientSetupRow }) {
  const h = HEALTH[r.health.level];
  return (
    <div className="min-w-[128px] space-y-2">
      <StatusPill tone={h.tone} icon={r.health.level === "issue" ? <AlertTriangle className="size-3" aria-hidden /> : undefined}>
        {h.label}
      </StatusPill>
      <ConnectionChips r={r} compact />
      {r.health.failedChecks > 0 && (
        <div>
          <StatusPill tone="danger" size="sm" icon={<AlertTriangle className="size-3" aria-hidden />} className="max-w-full" >
            <span title={plural(r.health.failedChecks, "failing readiness check")}>{plural(r.health.failedChecks, "failing check")}</span>
          </StatusPill>
        </div>
      )}
    </div>
  );
}
