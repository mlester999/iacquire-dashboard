"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight, Building2, CheckCircle2, ClipboardCheck, LayoutGrid, List, Search, UserRound, Workflow, X } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { Badge, Card, EmptyState, Input, ProgressBar, Select } from "@/components/ui/primitives";
import { Tooltip } from "@/components/ui/overlays";
import { MetricCard } from "@/components/ui/workspace";
import { Button } from "@/components/ui/button";
import { SETUP_SERVICES } from "@/lib/setup";
import type { ClientSetupRow } from "@/server/setup/snapshots";
import { cn, formatDate, initials, relativeTime } from "@/lib/utils";

type StateKey = "not_started" | "awaiting_onboarding" | "in_setup" | "ready_for_review" | "activated" | "suspended";

const STATE: Record<StateKey, { label: string; tone: "neutral" | "warning" | "primary" | "violet" | "success" | "danger" }> = {
  not_started: { label: "Not started", tone: "neutral" },
  awaiting_onboarding: { label: "Awaiting onboarding", tone: "warning" },
  in_setup: { label: "In setup", tone: "primary" },
  ready_for_review: { label: "Final review", tone: "violet" },
  activated: { label: "Approved", tone: "success" },
  suspended: { label: "Suspended", tone: "danger" },
};

function stateOf(r: ClientSetupRow): StateKey {
  if (r.orgStatus === "suspended") return "suspended";
  if (!r.setup.started) return "not_started";
  if (r.setup.state === "activated") return "activated";
  if (r.setup.state === "ready_for_review") return "ready_for_review";
  if (!r.onboardingCompletedAt) return "awaiting_onboarding";
  return "in_setup";
}

const HEALTH = {
  healthy: { label: "Healthy", tone: "success" as const },
  issue: { label: "Needs attention", tone: "danger" as const },
  partial: { label: "Partly connected", tone: "warning" as const },
  not_connected: { label: "Not connected", tone: "neutral" as const },
};

type Sort = "attention" | "newest" | "name" | "progress_asc" | "progress_desc" | "activity" | "blocked";

function healthDetail(r: ClientSetupRow) {
  const h = r.health;
  return [
    `AI employees online: ${h.agentsOnline} of ${h.agentsEnabled}`,
    `CRM: ${h.ghl ?? "not mapped"}`,
    `Calendar: ${h.calendar && h.calendar !== "not_configured" ? h.calendar : "not connected"}`,
    `n8n: ${h.n8n ?? "not configured"}`,
    h.failedChecks ? `${h.failedChecks} failing readiness check${h.failedChecks === 1 ? "" : "s"}` : null,
    h.failingAgents ? `${h.failingAgents} AI employee${h.failingAgents === 1 ? "" : "s"} failing` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function ClientsTable({ rows, timeZone }: { rows: ClientSetupRow[]; timeZone: string }) {
  const reduce=useReducedMotion();
  const [view,setView]=React.useState<"grid"|"table">("grid");
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

  const counts = React.useMemo(() => {
    const c: Record<StateKey, number> = { not_started: 0, awaiting_onboarding: 0, in_setup: 0, ready_for_review: 0, activated: 0, suspended: 0 };
    rows.forEach((r) => (c[stateOf(r)] += 1));
    return c;
  }, [rows]);

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

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: "Client workspaces", value: rows.length,icon:Building2,tone:"blue" as const },
          { label: "Taking shape", value: counts.in_setup + counts.awaiting_onboarding + counts.not_started,icon:Workflow,tone:"violet" as const },
          { label: "Final review", value: counts.ready_for_review,icon:ClipboardCheck,tone:"amber" as const },
          { label: "Approved", value: counts.activated,icon:CheckCircle2,tone:"green" as const },
        ].map((s) => (
          <MetricCard key={s.label} label={s.label} value={s.value} icon={<s.icon className="size-4"/>} tone={s.tone}/>
        ))}
      </div>

      <Card className="p-3 sm:p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
            <Input aria-label="Search clients" className="pl-9" placeholder="Search companies or contacts…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:flex">
            <Select aria-label="Filter by state" className="lg:w-44" value={state} onChange={(e) => setState(e.target.value as "all" | StateKey)}>
              <option value="all">All states</option>
              {(Object.keys(STATE) as StateKey[]).map((k) => (
                <option key={k} value={k}>
                  {STATE[k].label} ({counts[k]})
                </option>
              ))}
            </Select>
            <Select aria-label="Filter by responsible team member" className="lg:w-44" value={owner} onChange={(e) => setOwner(e.target.value)}>
              <option value="all">Anyone responsible</option>
              <option value="none">Unassigned</option>
              {owners.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </Select>
            <Select aria-label="Sort clients" className="col-span-2 sm:col-span-1 lg:w-48" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              <option value="attention">Needs attention first</option>
              <option value="newest">Newest first</option>
              <option value="name">Name A–Z</option>
              <option value="progress_asc">Setup: least complete</option>
              <option value="progress_desc">Setup: most complete</option>
              <option value="blocked">Most blocked steps</option>
              <option value="activity">Recent activity</option>
            </Select>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2" role="group" aria-label="Quick filters">
          {(
            [
              ["action", "Waiting on client"],
              ["blocked", "Has blocked steps"],
              ["issue", "Integration issues"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              aria-pressed={needs[k]}
              onClick={() => setNeeds({ ...needs, [k]: !needs[k] })}
              className={cn("h-8 rounded-full border px-3 text-[12.5px] font-medium transition", needs[k] ? "border-primary/30 bg-primary-soft text-primary-ink" : "border-line bg-surface text-muted hover:text-ink")}
            >
              {label}
            </button>
          ))}
          {filtering && (
            <button type="button" onClick={reset} className="inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-[12.5px] text-muted hover:text-ink">
              <X className="size-3.5" /> Clear
            </button>
          )}
          <span className="ml-auto text-[12.5px] text-muted" aria-live="polite">
            {list.length} of {rows.length}
          </span>
          <div role="group" aria-label="Client directory display" className="hidden rounded-xl bg-surface-2 p-1 md:flex"><Button variant={view==="grid"?"secondary":"ghost"} size="icon-sm" aria-label="Company card view" aria-pressed={view==="grid"} onClick={()=>setView("grid")}><LayoutGrid className="size-4"/></Button><Button variant={view==="table"?"secondary":"ghost"} size="icon-sm" aria-label="Client table view" aria-pressed={view==="table"} onClick={()=>setView("table")}><List className="size-4"/></Button></div>
        </div>
      </Card>

      {list.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Search className="size-5" />}
            title="No clients match"
            description="Try a different search or clear the filters."
            action={
              <button type="button" onClick={reset} className="text-[13.5px] font-medium text-primary hover:underline">
                Clear filters
              </button>
            }
          />
        </Card>
      ) : (
        <>
          {/* Desktop table */}
          <Card className={cn("overflow-hidden",view==="table"?"hidden md:block":"hidden")}>
            <div className="scrollbar-thin overflow-x-auto">
              <table className="w-full min-w-[1040px] text-left text-[13.5px]">
                <thead className="border-b border-line bg-surface-2/60 text-[12px] font-medium text-muted">
                  <tr>
                    <th scope="col" className="px-5 py-3 font-medium">Company</th>
                    <th scope="col" className="px-3 py-3 font-medium">Registration / onboarding</th>
                    <th scope="col" className="px-3 py-3 font-medium">Setup</th>
                    <th scope="col" className="px-3 py-3 font-medium">State</th>
                    <th scope="col" className="px-3 py-3 text-center font-medium">Client actions</th>
                    <th scope="col" className="px-3 py-3 text-center font-medium">Outstanding / blocked</th>
                    <th scope="col" className="px-3 py-3 font-medium">Responsible</th>
                    <th scope="col" className="px-3 py-3 font-medium">Integrations</th>
                    <th scope="col" className="px-3 py-3 font-medium">Support</th>
                    <th scope="col" className="px-5 py-3 font-medium">Latest update</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {list.map((r) => {
                    const s = STATE[stateOf(r)];
                    return (
                      <tr key={r.id} className="group transition hover:bg-surface-2/50">
                        <td className="px-5 py-3.5">
                          <Link href={`/admin/clients/${r.id}/setup`} className="font-medium text-ink hover:text-primary">
                            {r.name}
                          </Link>
                          <div className="text-[12px] text-faint">
                            {r.slug}
                            {r.isDemo && <span className="ml-1 text-violet-ink">· demo</span>}
                          </div>
                          <p className="mt-1 text-[12px] text-muted">{r.contact?.name ?? "Owner invitation pending"}</p>
                          {r.contact && <p className="text-[11.5px] text-muted">{r.contact.email}</p>}
                        </td>
                        <td className="whitespace-nowrap px-3 py-3.5 text-ink-2"><p>{formatDate(r.createdAt, timeZone)}</p><p className="mt-1 text-[12px] text-muted">{r.onboardingCompletedAt ? `Submitted ${formatDate(r.onboardingCompletedAt, timeZone)}` : "Not submitted"}</p></td>
                        <td className="px-3 py-3.5">
                          <SetupCell r={r} />
                        </td>
                        <td className="px-3 py-3.5">
                          <Badge tone={s.tone}>{s.label}</Badge>
                        </td>
                        <td className="px-3 py-3.5 text-center">{r.setup.clientActions ? <Badge tone="warning">{r.setup.clientActions}</Badge> : <span className="text-faint">—</span>}</td>
                        <td className="px-3 py-3.5 text-center"><span className="text-ink-2">{r.setup.outstanding} open</span>{r.setup.blocked > 0 && <Tooltip content={r.setup.blockers.join(" · ")}><span className="mt-1 block"><Badge tone="danger">{r.setup.blocked} blocked</Badge></span></Tooltip>}</td>
                        <td className="px-3 py-3.5 text-ink-2">{r.responsible ? r.responsible.name : <span className="text-faint">Unassigned</span>}</td>
                        <td className="px-3 py-3.5">
                          <HealthCell r={r} />
                        </td>
                        <td className="px-3 py-3.5"><Link href="/admin/support" className="text-primary hover:underline">{r.openTickets} open</Link></td>
                        <td className="whitespace-nowrap px-5 py-3.5 text-ink-2">
                          <span className="flex items-center justify-between gap-3">
                            {r.lastActivityAt ? relativeTime(r.lastActivityAt) : <span className="text-faint">None yet</span>}
                            <Link href={`/admin/clients/${r.id}/setup`} aria-label={`Open setup for ${r.name}`} className="flex size-7 items-center justify-center rounded-lg text-faint transition hover:bg-surface-2 hover:text-primary">
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

          {/* Mobile cards */}
          <ul className={view==="grid"?"grid gap-4 sm:grid-cols-2 xl:grid-cols-3":"space-y-3 md:hidden"}>
            {list.map((r) => {
              const s = STATE[stateOf(r)];
              return (
                <motion.li key={r.id} initial={reduce?false:{opacity:0,y:8}} animate={{opacity:1,y:0}} transition={{duration:.2}}>
                  <Link href={`/admin/clients/${r.id}`} className="group flex h-full flex-col rounded-2xl border border-line bg-surface p-5 shadow-soft transition hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-card active:scale-[0.99]">
                    <div className="flex items-start justify-between gap-3">
                      <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-primary/15 to-violet/15 text-sm font-semibold text-primary-ink">{initials(r.name)}</span>
                      <Badge tone={s.tone}>{s.label}</Badge>
                    </div>
                    <div className="mt-4 flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-[17px] font-semibold leading-snug tracking-tight text-ink">{r.name}</p>
                        <p className="text-[12px] text-faint">
                          {r.onboardingCompletedAt ? `Onboarded ${formatDate(r.onboardingCompletedAt, timeZone)}` : "Onboarding not submitted"}
                        </p>
                        <p className="mt-1 truncate text-[12px] text-muted">{r.contact?.name ?? "Owner invitation pending"}</p>
                      </div>
                    </div>
                    <div className="mt-5 rounded-xl bg-surface-2/60 p-3">
                      <p className="mb-2 text-[11.5px] font-medium text-muted">Setup journey · {r.setup.outstanding} steps remaining</p>
                      <SetupCell r={r} />
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2 text-[12.5px]">
                      {r.setup.clientActions > 0 && <Badge tone="warning">{r.setup.clientActions} waiting on client</Badge>}
                      {r.setup.blocked > 0 && <Badge tone="danger">{r.setup.blocked} blocked</Badge>}
                      <HealthCell r={r} />
                      <span className="text-muted">{r.setup.outstanding} steps open · {r.openTickets} support issues</span>
                    </div>
                    {r.services.length>0&&<div className="mt-4 flex flex-wrap gap-1.5">{r.services.map(key=><span key={key} className="rounded-md border border-line bg-surface-2/60 px-2 py-1 text-[10.5px] font-medium text-muted">{SETUP_SERVICES.find(s=>s.key===key)?.label??key}</span>)}</div>}
                    <p className="mt-3 flex items-center gap-1.5 text-[12px] text-muted">
                      <UserRound className="size-3.5" /> {r.responsible ? r.responsible.name : "Unassigned"} · {r.lastActivityAt ? `active ${relativeTime(r.lastActivityAt)}` : "no activity yet"}
                    </p>
                    <div className="mt-auto flex items-center justify-between border-t border-line pt-4 text-[12.5px] font-medium text-primary"><span>Open client workspace</span><ArrowRight className="size-4 transition group-hover:translate-x-0.5"/></div>
                  </Link>
                </motion.li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

function SetupCell({ r }: { r: ClientSetupRow }) {
  if (!r.setup.started) return <span className="text-[12.5px] text-faint">Checklist not started</span>;
  if (r.setup.percent === null) return <span className="text-[12.5px] text-faint">No required steps</span>;
  return (
    <div className="flex min-w-[130px] items-center gap-2.5">
      <ProgressBar value={r.setup.percent} tone={r.setup.percent === 100 ? "success" : "primary"} className="h-1.5 flex-1" label={`${r.name} setup progress`} />
      <span className="w-14 shrink-0 text-right text-[12.5px] tabular-nums text-ink-2">
        {r.setup.percent}% <span className="text-faint">· {r.setup.completed}/{r.setup.total}</span>
      </span>
    </div>
  );
}

function HealthCell({ r }: { r: ClientSetupRow }) {
  const h = HEALTH[r.health.level];
  return (
    <Tooltip content={healthDetail(r)}>
      <span className="inline-flex flex-col items-start gap-1">
        <Badge tone={h.tone}>
          {r.health.level === "issue" && <AlertTriangle className="size-3" />}
          {h.label}
        </Badge>
        <span className="text-[11.5px] text-muted">CRM {r.health.ghl ?? "not mapped"} · AI {r.health.agentsOnline}/{r.health.agentsEnabled}</span>
        <span className="text-[11.5px] text-muted">n8n {r.health.n8n ?? "not configured"}</span>
      </span>
    </Tooltip>
  );
}
