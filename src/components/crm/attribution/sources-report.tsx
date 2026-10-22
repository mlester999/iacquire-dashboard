"use client";

import * as React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge, Field, Input, Select } from "@/components/ui/primitives";
import { SectionCard } from "@/components/crm/record-panels";
import { PageTitle, ReadOnlyNotice, useCrmAction } from "@/components/crm/ui";
import { addCostAction, removeCostAction } from "@/app/actions/attribution";
import { sourceLabel } from "@/lib/attribution/model";
import type { AttributionModel, AttributionReport, MoneyByCurrency } from "@/server/attribution/report";
import type { CostEntry } from "@/server/attribution/costs";
import type { CrmScope } from "@/server/crm/page";

// Where leads came from and what became of them. A figure appears only where its inputs exist; a blank says what is missing, in words. Deal value is deal
// value: it is never called revenue, because this platform does not record verified customer payments yet.

const fmt = (m: MoneyByCurrency[]) => (m.length === 0 ? "None" : m.map((x) => `${x.currency} ${x.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}`).join(" · "));

function Toolbar({ base, days, model }: { base: string; days: number; model: AttributionModel }) {
  const href = (d: number, m: AttributionModel) => `${base}/reports/sources?range=${d}&model=${m}`;
  const pill = (active: boolean) => `inline-flex min-h-11 items-center rounded-xl px-3 text-[13px] font-medium sm:min-h-9 ${active ? "bg-primary-soft text-primary-ink" : "text-ink-2 hover:bg-surface-2"}`;
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
      <nav aria-label="Period" className="flex gap-1">{[7, 30, 90, 365].map((d) => <Link key={d} href={href(d, model)} aria-current={days === d ? "page" : undefined} className={pill(days === d)}>{d === 365 ? "1 year" : `${d} days`}</Link>)}</nav>
      <nav aria-label="Credit each lead to" className="flex items-center gap-1">
        <span className="mr-1 text-[12.5px] text-muted">Credit each lead to its</span>
        <Link href={href(days, "first")} aria-current={model === "first" ? "page" : undefined} className={pill(model === "first")}>first touch</Link>
        <Link href={href(days, "latest")} aria-current={model === "latest" ? "page" : undefined} className={pill(model === "latest")}>latest touch</Link>
      </nav>
    </div>
  );
}

export function SourcesReport({ scope, days, model, report, costs, sources, canEnterCosts }: {
  scope: CrmScope; days: number; model: AttributionModel; report: AttributionReport; costs: CostEntry[]; sources: Array<{ source: string; label: string }>; canEnterCosts: boolean;
}) {
  const { run, busy } = useCrmAction();
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = React.useState({ source: "", campaign: "", periodStart: today, periodEnd: today, amount: "", currency: "USD", note: "" });
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const orgId = scope.orgId;

  async function add() {
    const amount = Number(form.amount);
    const ok = await run("cost", () => addCostAction(orgId, { ...form, campaign: form.campaign || null, note: form.note || null, amount: Number.isFinite(amount) ? amount : -1 }), "Cost saved");
    if (ok) setForm((f) => ({ ...f, amount: "", note: "" }));
  }

  const t = report.totals;
  return (
    <div className="space-y-6">
      <PageTitle title="Lead sources and ROI" description="Where your leads came from and what became of them. Figures are counted from your records; the ones that need an input nobody supplied are left blank, with the reason." />
      {scope.readOnly && <ReadOnlyNotice />}
      <Toolbar base={scope.base} days={days} model={model} />

      <section aria-label="Totals" className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {[["Leads", t.leads], ["Qualified", t.qualified], ["With an appointment", t.appointments], ["With a deal", t.opportunities], ["With a won deal", t.wonCount]].map(([label, n]) => (
          <div key={label as string} className="rounded-2xl border border-line bg-surface p-3"><p className="text-[12px] text-muted">{label}</p><p className="text-[22px] font-semibold tabular-nums text-ink">{n}</p></div>
        ))}
      </section>

      <SectionCard title="By source">
        {report.rows.length === 0 ? (
          <p className="text-[13px] text-muted">No leads were created in this period. When a visitor fills in a form, chats on your website or phones, the source is recorded here.</p>
        ) : (
          <div className="overflow-x-auto" role="region" aria-label="Leads by source" tabIndex={0}>
            <table className="w-full min-w-[860px] text-left text-[13px]">
              <caption className="sr-only">Leads by source, credited to each lead&apos;s {model} touch</caption>
              <thead className="text-[12px] text-muted">
                <tr>{["Source", "Leads", "Qualified", "Appointments", "Deals", "Won deals", "Won deal value", "Open deal value", "Cost", "Cost per lead", "Return on spend"].map((h) => <th key={h} scope="col" className="py-1.5 pr-3 font-medium">{h}</th>)}</tr>
              </thead>
              <tbody>
                {report.rows.map((r) => (
                  <tr key={r.source} className="border-t border-line align-top">
                    <th scope="row" className="py-2 pr-3 font-medium text-ink">
                      {r.label}
                      <span className="mt-0.5 flex flex-wrap gap-1 font-normal">
                        {r.known > 0 && <Badge tone="success">{r.known} recorded</Badge>}
                        {r.inferred > 0 && <Badge tone="warning">{r.inferred} inferred</Badge>}
                        {r.unknown > 0 && r.source !== "no-touch-recorded" && <Badge>{r.unknown} not recorded</Badge>}
                      </span>
                    </th>
                    <td className="py-2 pr-3 tabular-nums">{r.leads}</td>
                    <td className="py-2 pr-3 tabular-nums">{r.qualified}</td>
                    <td className="py-2 pr-3 tabular-nums">{r.appointments}</td>
                    <td className="py-2 pr-3 tabular-nums">{r.opportunities}</td>
                    <td className="py-2 pr-3 tabular-nums">{r.wonCount}</td>
                    <td className="py-2 pr-3">{fmt(r.wonValue)}</td>
                    <td className="py-2 pr-3">{fmt(r.openValue)}</td>
                    <td className="py-2 pr-3">{r.cost.length ? fmt(r.cost) : <span className="text-muted">Not entered</span>}</td>
                    <td className="py-2 pr-3">{r.costPerLead ? fmt([r.costPerLead]) : <span className="text-muted">{r.cost.length > 1 ? "Several currencies" : "Not shown"}</span>}</td>
                    <td className="py-2 pr-3">{r.returnOnSpend !== null ? `${Math.round(r.returnOnSpend * 100)}%` : <span className="text-muted" title={r.missing ?? undefined}>{r.missing ?? "Not shown"}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <ul className="mt-3 space-y-1 text-[12.5px] text-muted">{report.notes.map((n) => <li key={n}>{n}</li>)}</ul>
      </SectionCard>

      <SectionCard title="Campaign costs">
        <p className="mb-3 text-[12.5px] text-muted">Costs are what you enter by hand, for a source and a period. Nothing is fetched from an advertising account. Cost per lead uses a cost whose whole period sits inside the report&apos;s period.</p>
        {canEnterCosts ? (
          <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" onSubmit={(e) => { e.preventDefault(); void add(); }}>
            <Field label="Source" htmlFor="cost-source" hint="As it appears in the table, for example google.">
              <Input id="cost-source" list="cost-sources" value={form.source} onChange={(e) => set("source", e.target.value)} required />
              <datalist id="cost-sources">{sources.map((s) => <option key={s.source} value={s.source}>{s.label}</option>)}</datalist>
            </Field>
            <Field label="Campaign" htmlFor="cost-campaign" optional><Input id="cost-campaign" value={form.campaign} onChange={(e) => set("campaign", e.target.value)} /></Field>
            <Field label="First day" htmlFor="cost-start"><Input id="cost-start" type="date" value={form.periodStart} onChange={(e) => set("periodStart", e.target.value)} required /></Field>
            <Field label="Last day" htmlFor="cost-end"><Input id="cost-end" type="date" value={form.periodEnd} onChange={(e) => set("periodEnd", e.target.value)} required /></Field>
            <Field label="Amount spent" htmlFor="cost-amount"><Input id="cost-amount" type="number" step="0.01" min="0" inputMode="decimal" value={form.amount} onChange={(e) => set("amount", e.target.value)} required /></Field>
            <Field label="Currency" htmlFor="cost-currency"><Select id="cost-currency" value={form.currency} onChange={(e) => set("currency", e.target.value)}>{["USD", "PHP", "EUR", "GBP", "AUD", "CAD", "SGD"].map((c) => <option key={c}>{c}</option>)}</Select></Field>
            <Field label="Note" htmlFor="cost-note" optional className="sm:col-span-2"><Input id="cost-note" value={form.note} maxLength={300} onChange={(e) => set("note", e.target.value)} /></Field>
            <div className="sm:col-span-2 lg:col-span-4"><Button type="submit" variant="brand" loading={busy("cost")} disabled={!form.source.trim() || !form.amount}>Save cost</Button></div>
          </form>
        ) : (
          <p className="text-[12.5px] text-muted">Owners and managers enter campaign costs.</p>
        )}
        {costs.length > 0 && (
          <div className="mt-4 overflow-x-auto" role="region" aria-label="Entered campaign costs" tabIndex={0}>
            <table className="w-full min-w-[560px] text-left text-[13px]">
              <caption className="sr-only">Entered campaign costs</caption>
              <thead className="text-[12px] text-muted"><tr>{["Source", "Campaign", "Period", "Amount", "Note", ""].map((h, i) => <th key={i} scope="col" className="py-1.5 pr-3 font-medium">{h || <span className="sr-only">Remove</span>}</th>)}</tr></thead>
              <tbody>
                {costs.map((c) => (
                  <tr key={c.id} className="border-t border-line">
                    <th scope="row" className="py-2 pr-3 font-medium text-ink">{sourceLabel(c.source)}</th>
                    <td className="py-2 pr-3">{c.campaign ?? "—"}</td>
                    <td className="py-2 pr-3">{c.periodStart} to {c.periodEnd}</td>
                    <td className="py-2 pr-3 tabular-nums">{c.currency} {c.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                    <td className="py-2 pr-3 text-ink-2">{c.note ?? ""}</td>
                    <td className="py-2 text-right">{canEnterCosts && <Button variant="ghost" size="sm" className="min-h-11 sm:min-h-8" loading={busy(`rm-${c.id}`)} onClick={() => run(`rm-${c.id}`, () => removeCostAction(orgId, c.id), "Cost removed")}>Remove</Button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
