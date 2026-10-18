"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, BarChart3, CheckCircle2, Search } from "lucide-react";
import { Badge, Card, EmptyState, Input } from "@/components/ui/primitives";
import { Segmented, Tooltip } from "@/components/ui/overlays";
import { CRM_MODE_LABELS } from "@/lib/crm/types";
import { cn, relativeTime } from "@/lib/utils";
import type { AgencyOpsRow, AgencyOpsSummary } from "@/server/crm/reports/agency";

const n = (v: number) => v.toLocaleString("en-US");

function Tile({ label, value, sub, tone }: { label: string; value: number; sub?: string; tone?: "danger" | "warning" }) {
  return (
    <Card className="p-4">
      <p className="text-[12.5px] font-medium text-muted">{label}</p>
      <p className={cn("mt-1 text-[22px] font-semibold tracking-[-0.03em] tabular-nums", value && tone === "danger" ? "text-danger-ink" : value && tone === "warning" ? "text-warning-ink" : "text-ink")}>{n(value)}</p>
      {sub && <p className="text-[12px] text-faint">{sub}</p>}
    </Card>
  );
}

/** A count that reads as a problem only when it isn't zero. */
function Num({ value, tone = "danger", label }: { value: number; tone?: "danger" | "warning"; label?: string }) {
  if (!value) return <span className="text-faint" aria-label={label ? `${label}: none` : undefined}>0</span>;
  return <span className={cn("font-medium tabular-nums", tone === "danger" ? "text-danger-ink" : "text-warning-ink")} aria-label={label ? `${label}: ${value}` : undefined}>{n(value)}</span>;
}

function Breakdown({ items }: { items: Array<[string, number]> }) {
  const shown = items.filter(([, v]) => v > 0);
  if (!shown.length) return null;
  return <span className="mt-0.5 block text-[11.5px] leading-snug text-muted">{shown.map(([k, v]) => `${n(v)} ${k}`).join(" · ")}</span>;
}

function ModeCell({ r }: { r: AgencyOpsRow }) {
  return (
    <div>
      <Badge tone={r.mode === "native" ? "primary" : r.mode === "ghl" ? "warning" : "violet"}>{CRM_MODE_LABELS[r.mode].label}</Badge>
      {r.mode === "hybrid" && <span className="mt-0.5 block text-[11.5px] text-muted">{r.ghlCapabilities ? `${n(r.ghlCapabilities)} on GoHighLevel` : "All on iAcquire"}</span>}
    </div>
  );
}

/**
 * The agency's cross-client operational report. Counts and flags only, never client records. Each client links to its workspace, where
 * opening records still needs a support session.
 */
export function AgencyOpsReport({ summary, superAdmin }: { summary: AgencyOpsSummary; superAdmin: boolean }) {
  const [view, setView] = React.useState<"attention" | "all">(summary.totals.needingAttention ? "attention" : "all");
  const [query, setQuery] = React.useState("");
  const t = summary.totals;
  const q = query.trim().toLowerCase();
  const rows = summary.rows.filter((r) => (view === "all" || r.attention) && (!q || r.name.toLowerCase().includes(q)));

  return (
    <div className="space-y-5">
      <div>
        <Link href="/admin/crm" className="inline-flex min-h-11 items-center gap-1.5 text-[13px] font-medium text-muted hover:text-ink sm:min-h-8"><ArrowLeft className="size-4" aria-hidden />Client CRMs</Link>
        <h1 className="mt-1 text-[22px] font-semibold tracking-[-0.03em] text-ink">CRM operations</h1>
        <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-muted">
          What is failing, waiting or needs support across {superAdmin ? "every client" : "the clients assigned to you"}. Counts and flags only: no contact details, messages or amounts.
          Opening a client&rsquo;s records still needs a support session, which the client can see.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <Tile label="Clients" value={t.clients} sub={`${n(t.byMode.native)} iAcquire · ${n(t.byMode.ghl)} GoHighLevel · ${n(t.byMode.hybrid)} hybrid`} />
        <Tile label="Need attention" value={t.needingAttention} tone="warning" />
        <Tile label="Failed integrations" value={t.failedIntegrations} tone="danger" />
        <Tile label="Automation gave up" value={t.deadRuns + t.deadLetters} tone="danger" sub="Runs and events, 30 days" />
        <Tile label="Setup items open" value={t.setupPending} />
        <Tile label="Low credit balance" value={t.lowBalance} tone="warning" sub="Clients" />
        <Tile label="Open escalations" value={t.openEscalations} tone="warning" />
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Segmented
          id="ops-view"
          ariaLabel="Which clients"
          size="sm"
          value={view}
          onChange={setView}
          options={[{ value: "attention", label: `Needs attention (${n(t.needingAttention)})` }, { value: "all", label: `All clients (${n(t.clients)})` }]}
        />
        <div className="relative w-full sm:w-64">
          <label htmlFor="ops-search" className="sr-only">Find a client</label>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <Input id="ops-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a client" className="pl-9" autoComplete="off" />
        </div>
      </div>

      {!summary.rows.length ? (
        <Card><EmptyState icon={<BarChart3 className="size-5" />} title="No client workspaces" description={superAdmin ? "Client workspaces appear here once they exist." : "Clients assigned to you appear here."} /></Card>
      ) : !rows.length ? (
        <Card>
          <EmptyState
            compact
            icon={view === "attention" && !q ? <CheckCircle2 className="size-5" /> : <Search className="size-5" />}
            title={view === "attention" && !q ? "Nothing needs attention" : "No clients match"}
            description={view === "attention" && !q ? "No failures, stuck work, low balances or open escalations were recorded for your clients." : "Try another name, or show all clients."}
          />
        </Card>
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="scrollbar-thin overflow-x-auto">
            <table className="w-full min-w-[68rem] text-[13px]">
              <caption className="sr-only">CRM operations by client</caption>
              <thead className="border-b border-line bg-surface-2/60 text-[12px] text-muted">
                <tr>
                  <th scope="col" className="sticky left-0 z-10 bg-surface-2 px-4 py-2.5 text-left font-medium">Client</th>
                  <th scope="col" className="px-3 py-2.5 text-left font-medium">CRM</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">Failed integrations</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">Setup open</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">Automation</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">Event backlog</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">Form failures</th>
                  <th scope="col" className="px-3 py-2.5 text-left font-medium">Billing</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">Support</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">Last 30 days</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.orgId} className="align-top hover:bg-surface-2/40">
                    <th scope="row" className="sticky left-0 z-10 bg-surface px-4 py-2.5 text-left font-medium">
                      <Link href={`/admin/clients/${r.orgId}/crm`} className="text-ink hover:text-primary">{r.name}</Link>
                      <span className="mt-0.5 flex flex-wrap items-center gap-1">
                        {r.attention && <Badge tone="warning" className="h-5 px-2 text-[11px]"><AlertTriangle className="size-3" aria-hidden />Attention</Badge>}
                        {r.status !== "active" && <Badge tone="neutral" className="h-5 px-2 text-[11px] capitalize">{r.status}</Badge>}
                      </span>
                    </th>
                    <td className="px-3 py-2.5"><ModeCell r={r} /></td>
                    <td className="px-3 py-2.5 text-right">
                      <Num value={r.integrations.total} label="Failed integrations" />
                      <Breakdown items={[["checks", r.integrations.checks], ["channels", r.integrations.channels], ["calendars", r.integrations.calendars], ["voice", r.integrations.voice]]} />
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {n(r.setup.pending)}
                      {r.setup.blocked > 0 && <span className="mt-0.5 block text-[11.5px] text-danger-ink">{n(r.setup.blocked)} blocked</span>}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <Num value={r.automation.deadRuns + r.automation.deadLetters + r.automation.deadWebhooks} label="Automation gave up" />
                      <Breakdown items={[["runs gave up", r.automation.deadRuns], ["runs failed", r.automation.failedRuns], ["events gave up", r.automation.deadLetters], ["webhooks gave up", r.automation.deadWebhooks]]} />
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {n(r.automation.backlog)}
                      {r.automation.oldestPendingMinutes !== null && (
                        <span className={cn("mt-0.5 block text-[11.5px]", r.automation.oldestPendingMinutes > 15 ? "text-danger-ink" : "text-muted")}>
                          oldest {r.automation.oldestPendingMinutes < 60 ? `${r.automation.oldestPendingMinutes} min` : `${n(Math.floor(r.automation.oldestPendingMinutes / 60))} h`}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right"><Num value={r.formFailures} label="Form failures" /></td>
                    <td className="px-3 py-2.5">
                      {r.billing.exhausted ? <Badge tone="danger">Out of credits</Badge> : r.billing.lowBalance ? <Badge tone="warning">Low balance</Badge> : <span className="text-faint">OK</span>}
                      {r.billing.uncollectedEvents > 0 && <span className="mt-0.5 block text-[11.5px] text-warning-ink">{n(r.billing.uncollectedEvents)} uncollected</span>}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <Tooltip content="Open human escalations · support tickets">
                        <span tabIndex={0} className="rounded outline-offset-2 focus-visible:outline-2 focus-visible:outline-primary">
                          <Num value={r.support.openEscalations} tone="warning" label="Open escalations" /> · <span className="tabular-nums">{n(r.support.openTickets)}</span>
                        </span>
                      </Tooltip>
                      {r.support.urgentEscalations > 0 && <span className="mt-0.5 block text-[11.5px] text-danger-ink">{n(r.support.urgentEscalations)} urgent</span>}
                    </td>
                    <td className="px-3 py-2.5 text-right text-[12px] leading-relaxed text-muted">
                      <span className="block"><span className="tabular-nums text-ink">{n(r.activity.newContacts)}</span> contacts</span>
                      <span className="block"><span className="tabular-nums text-ink">{n(r.activity.formSubmissions)}</span> form entries · <span className="tabular-nums text-ink">{n(r.activity.bookings)}</span> bookings</span>
                      <span className="block"><span className="tabular-nums text-ink">{n(r.activity.dealsWon)}</span> deals won</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      <p className="text-[12px] text-faint" suppressHydrationWarning>
        Computed {relativeTime(summary.generatedAt)}. Failed integrations: recorded connection checks in error, messaging channels whose last test failed, calendars in error or needing
        reconnecting, and voice providers in error. Automation counts exclude test runs. A credit balance counts as low at or below the client&rsquo;s own low-balance setting.
      </p>
    </div>
  );
}
