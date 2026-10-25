"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, BadgeCheck, Banknote, Building2, CalendarDays, Landmark, PiggyBank, Receipt, Scale, ShieldAlert, Trash2, Wallet } from "lucide-react";
import {
  addFinanceEntryAction, addProviderFeeAction, adjustCreditsAction, confirmLiveReviewAction, publishUnitRateAction, saveFinanceSettingsAction, setExchangeRateAction, voidFinanceEntryAction,
} from "@/app/(admin)/admin/finance-actions";
import { setAutoPastDueAction } from "@/app/(admin)/admin/billing/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { AvatarTile, InfoChip, StatusPill } from "@/components/ui/status";
import { Dialog, Segmented, Switch } from "@/components/ui/overlays";
import { MetricCard, SectionLabel } from "@/components/ui/workspace";
import { rateFieldHint, rateFieldLabel, ratePlaceholder, rateSanityNote, rateUnitLabel } from "@/lib/billing";
import { CATEGORIES, ENTRY_KINDS, KIND_HELP, KIND_LABEL, PERIOD_LABEL, signedUsd, type EntryKind, type PeriodKey } from "@/lib/finance";
import { formatDate, formatDateTime, sentenceCase } from "@/lib/utils";
import { PaymentsWorkspace } from "@/components/admin/payments-workspace";
import type { AgencyPaymentView, PaymentClientOption } from "@/server/billing/payments-view";
import type { FinancialReport } from "@/server/billing/finance";
import type { AgencyBillingOverview } from "@/server/billing/service";
import type { UnitRateRow } from "@/server/billing/rates";

type Tab = "statement" | "entries" | "payments" | "rates" | "clients";
const TABS: Array<{ value: Tab; label: string }> = [
  { value: "statement", label: "Statement" },
  { value: "entries", label: "Entries" },
  { value: "payments", label: "Payments" },
  { value: "rates", label: "Rates & payments" },
  { value: "clients", label: "Clients" },
];

const dollars = (micros: number) => signedUsd(micros);
const TH = "px-3 py-2.5 text-[12px] font-semibold uppercase tracking-wider text-muted";
const PROVIDER_LABEL: Record<string, string> = { ghl: "GoHighLevel", llm: "AI model", n8n: "n8n", research: "Research", enrichment: "Enrichment", internal: "Internal", paymongo: "PayMongo" };
const providerLabel = (p: string) => PROVIDER_LABEL[p] ?? sentenceCase(p);
/** Machine event names such as "checkout_session.payment.paid" read as a sentence. */
const readableEvent = (t: string) => sentenceCase(t.replace(/[._]+/g, " ").trim());
const OUTCOME_TONE = { error: "danger", rejected: "danger", ignored: "neutral" } as const;

function Line({ label, value, note, strong, negative, indent }: { label: React.ReactNode; value: number | null; note?: React.ReactNode; strong?: boolean; negative?: boolean; indent?: boolean }) {
  return (
    <tr className={strong ? "bg-surface-2/70" : undefined}>
      <th scope="row" className={`px-4 py-2.5 text-left text-[14px] ${strong ? "font-semibold" : "font-normal"} ${indent ? "pl-8! sm:pl-10!" : ""} sm:px-5`}>
        {label}
        {note && <span className="mt-0.5 block text-[12px] font-normal leading-relaxed text-muted">{note}</span>}
      </th>
      <td className={`whitespace-nowrap px-4 py-2.5 text-right text-[14px] tabular-nums sm:px-5 ${strong ? "font-semibold" : ""}`}>{value === null ? <span className="text-muted">Not set</span> : dollars(negative ? -Math.abs(value) : value)}</td>
    </tr>
  );
}

function SectionRow({ children }: { children: React.ReactNode }) {
  return (
    <tr>
      <th colSpan={2} scope="colgroup" className="bg-surface-2 px-4 py-2 text-left text-[12px] font-semibold uppercase tracking-wider text-muted sm:px-5">
        {children}
      </th>
    </tr>
  );
}

function Statement({ r }: { r: FinancialReport }) {
  const agency = r.scope === "agency";
  return (
    <div className="space-y-5">
      <Card className="overflow-hidden">
        <div className="overflow-x-auto" tabIndex={0}>
          <table className="w-full min-w-[28rem]">
            <caption className="sr-only">Financial statement for {r.period.label}. Each kind of figure is on its own line.</caption>
            <tbody className="divide-y divide-line">
              <SectionRow>Money received (cash, after refunds)</SectionRow>
              <Line label="Setup fees" value={r.received.setupMicros} indent />
              <Line label="Managed maintenance" value={r.received.maintenanceMicros} indent />
              <Line label="Custom projects" value={r.received.projectsMicros} indent />
              <Line label="Domains" value={r.received.domainsMicros} indent />
              <Line label="Refunds on those payments" value={r.received.refundedMicros} negative indent />
              <Line label="Net cash received" value={r.received.netMicros} strong note="Money in, before any cost. Not profit." />

              <SectionRow>Usage (income only once credits are consumed)</SectionRow>
              <Line label="Charged to clients" value={r.usage.chargedMicros} indent />
              <Line label="Provider cost of that usage" value={r.usage.providerCostMicros} negative indent />
              <Line label="Markup contribution" value={r.usage.grossMarkupContributionMicros} strong note="The 30% markup on usage, after provider cost. It is a contribution toward costs, not a profit." />
              {r.usage.uncollectedMicros > 0 && <Line label="Usage that could not be collected" value={r.usage.uncollectedMicros} indent note="Shown for reconciliation. The provider cost above was still paid, so this is a real cost, and the charge is not income." />}

              <SectionRow>Costs</SectionRow>
              <Line label="Payment processing fees" value={r.fees.knownMicros} negative indent note={r.fees.paymentsWithoutFee > 0 ? `${r.fees.paymentsWithoutFee} payment${r.fees.paymentsWithoutFee === 1 ? " has" : "s have"} no fee recorded yet, so this is understated.` : "Every payment in this period reported its fee."} />
              <Line label="Direct costs for clients" value={r.costs.directMicros} negative indent />
              {agency && <Line label="Agency overhead" value={r.costs.overheadMicros} negative indent />}

              {agency && r.distributable && (
                <>
                  <Line label="Result before set-asides" value={r.distributable.resultBeforeSetAsidesMicros} strong />
                  <SectionRow>Set aside</SectionRow>
                  <Line label="Tax set aside (entered)" value={r.tax.setAsideMicros} negative indent note={r.tax.configuredBps === null ? "No tax rate has been entered, so nothing is suggested. This is not tax advice." : `Suggested at ${(r.tax.configuredBps / 100).toFixed(1)}% of the result: ${dollars(r.tax.suggestedMicros ?? 0)}.`} />
                  <Line label="Reserve set aside (entered)" value={r.reserve.setAsideInPeriodMicros} negative indent note={`Recommended: ${dollars(r.reserve.recommendedMicros)} (${r.reserve.setupPayments} setup payment${r.reserve.setupPayments === 1 ? "" : "s"} × $${r.reserve.perSetupUsd}).`} />
                  {r.distributable.unfundedReserveMicros > 0 && <Line label="Recommended reserve not yet set aside" value={r.distributable.unfundedReserveMicros} negative indent />}
                  {r.distributable.unfundedTaxMicros > 0 && <Line label="Suggested tax not yet set aside" value={r.distributable.unfundedTaxMicros} negative indent />}
                  <Line label="Estimated available to distribute" value={r.distributable.estimateMicros} strong note="A planning estimate, not an accounting profit. It leaves out anything not entered above." />
                </>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-violet-soft text-violet-ink"><Wallet className="size-4" aria-hidden /></span>
            <div>
              <CardTitle>Held for clients: not income</CardTitle>
              <CardDescription>Prepaid credits clients have bought and not yet used are owed to them as service.</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2 pt-3">
          <InfoChip icon={<Wallet />}>Top-ups this period <strong className="font-semibold tabular-nums text-ink">{dollars(r.prepaid.topUpsMicros)}</strong></InfoChip>
          <InfoChip icon={<Scale />}>Held now <strong className="font-semibold tabular-nums text-ink">{dollars(r.prepaid.heldForClientsMicros)}</strong></InfoChip>
        </CardContent>
      </Card>

      {r.caveats.length > 0 && (
        <section aria-label="What this statement leaves out">
          <SectionLabel title="Read this before relying on the numbers" count={r.caveats.length} />
          <ul className="space-y-2">
            {r.caveats.map((c) => (
              <li key={c} className="flex items-start gap-2.5 rounded-xl border border-warning/25 bg-warning-soft px-3.5 py-3 text-[14px] leading-relaxed text-warning-ink"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />{c}</li>
            ))}
          </ul>
        </section>
      )}

      {agency && (
        <Card>
          <CardHeader>
            <div className="flex items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary-ink"><PiggyBank className="size-4" aria-hidden /></span>
              <div>
                <CardTitle>Operating reserve</CardTitle>
                <CardDescription>A planning reserve of ${r.reserve.perSetupUsd} from each setup payment, for future operating obligations. It isn&apos;t a customer charge.</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[["Recommended this period", r.reserve.recommendedMicros], ["Set aside (all time)", r.reserve.setAsideMicros], ["Used (all time)", r.reserve.usedMicros], ["Reserve balance", r.reserve.balanceMicros]].map(([label, value]) => (
                <div key={label as string} className="rounded-xl border border-line px-3.5 py-3"><dt className="text-[12px] text-muted">{label as string}</dt><dd className="mt-1 text-[18px] font-semibold tabular-nums">{dollars(value as number)}</dd></div>
              ))}
            </dl>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function EntryForm({ clients, onDone }: { clients: Array<{ orgId: string; name: string }>; onDone: () => void }) {
  const [kind, setKind] = React.useState<EntryKind>("overhead");
  const [category, setCategory] = React.useState(CATEGORIES.overhead[0]);
  const [amount, setAmount] = React.useState("");
  const [date, setDate] = React.useState(() => new Date().toISOString().slice(0, 10));
  const [orgId, setOrgId] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const changeKind = (k: EntryKind) => { setKind(k); setCategory(CATEGORIES[k][0]); if (k !== "direct_cost") setOrgId(""); };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const res = await addFinanceEntryAction({ kind, category, description, amountUsd: Number(amount), periodOn: date, orgId: orgId || null });
    setBusy(false);
    if (!res.ok) return void toast.error(res.error);
    toast.success("Entry recorded");
    setAmount(""); setDescription("");
    onDone();
  };
  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Field label="Kind" htmlFor="fe-kind" hint={KIND_HELP[kind]} className="sm:col-span-2 lg:col-span-4">
        <Select id="fe-kind" value={kind} onChange={(e) => changeKind(e.target.value as EntryKind)}>{ENTRY_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</Select>
      </Field>
      <Field label="Category" htmlFor="fe-cat"><Select id="fe-cat" value={category} onChange={(e) => setCategory(e.target.value)}>{CATEGORIES[kind].map((c) => <option key={c}>{c}</option>)}</Select></Field>
      <Field label="Amount (USD)" htmlFor="fe-amt"><Input id="fe-amt" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="150.00" /></Field>
      <Field label="Date it belongs to" htmlFor="fe-date"><Input id="fe-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      {kind === "direct_cost" ? (
        <Field label="Client" htmlFor="fe-org" optional hint="Leave blank if it isn't one client's."><Select id="fe-org" value={orgId} onChange={(e) => setOrgId(e.target.value)}><option value="">Not one client</option>{clients.map((c) => <option key={c.orgId} value={c.orgId}>{c.name}</option>)}</Select></Field>
      ) : <div className="hidden lg:block" />}
      <Field label="What it was for" htmlFor="fe-desc" className="sm:col-span-2 lg:col-span-4"><Textarea id="fe-desc" rows={2} maxLength={300} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      <div className="sm:col-span-2 lg:col-span-4 flex justify-end"><Button type="submit" variant="brand" loading={busy} disabled={!(Number(amount) > 0) || description.trim().length < 1}>Record entry</Button></div>
    </form>
  );
}

function Entries({ r, canManage }: { r: FinancialReport; canManage: boolean }) {
  const router = useRouter();
  const [voiding, setVoiding] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  return (
    <div className="space-y-5">
      {canManage && (
        <Card>
          <CardHeader><div><CardTitle>Record money spent or set aside</CardTitle><CardDescription>Entries are never edited or deleted. A mistake is voided with a reason and entered again, so the history stays honest.</CardDescription></div></CardHeader>
          <CardContent><EntryForm clients={r.clients} onDone={() => router.refresh()} /></CardContent>
        </Card>
      )}
      <Card>
        <CardHeader><div><CardTitle>Entries in {r.period.label.toLowerCase()}</CardTitle><CardDescription>{r.scope === "client_scope" ? "Costs belonging to clients in your access scope." : "Everything recorded for this period."}</CardDescription></div></CardHeader>
        <CardContent className="px-0 pb-0">
          {r.entries.length === 0 ? (
            <EmptyState compact icon={<Receipt />} title="No entries in this period" description="Costs, tax set-asides and reserve movements you record appear here." />
          ) : (
            <ul className="divide-y divide-line">
              {r.entries.map((e) => (
                <li key={e.id} className="management-row flex flex-wrap items-start gap-x-3 gap-y-2 px-5 py-3.5">
                  <div className="min-w-0 flex-1 basis-60">
                    <p className={`text-[14px] font-medium ${e.voided ? "text-muted line-through" : ""}`}>{e.description}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <InfoChip className="font-semibold text-ink">{KIND_LABEL[e.kind]}</InfoChip>
                      <InfoChip>{e.category}</InfoChip>
                      {e.orgName && <InfoChip icon={<Building2 />}>{e.orgName}</InfoChip>}
                      <InfoChip icon={<CalendarDays />}>{formatDate(e.periodOn, "UTC")}</InfoChip>
                      {e.voided && <StatusPill tone="warning" size="sm">Voided: {e.voidReason}</StatusPill>}
                    </div>
                  </div>
                  <span className={`text-[14px] font-semibold tabular-nums ${e.voided ? "text-muted line-through" : ""}`}>{dollars(e.amountMicros)}</span>
                  {canManage && !e.voided && <Button size="sm" variant="outline" aria-label={`Void entry: ${e.description}`} onClick={() => { setVoiding(e.id); setReason(""); }}><Trash2 className="size-3.5" aria-hidden />Void</Button>}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <Dialog
        open={voiding !== null}
        onOpenChange={(o) => !o && setVoiding(null)}
        size="sm"
        title="Void this entry?"
        description="It stays in the history, marked as voided with your reason, and no longer counts in any total."
        footer={<><Button variant="ghost" onClick={() => setVoiding(null)}>Cancel</Button><Button variant="danger" loading={busy} disabled={reason.trim().length < 3} onClick={async () => { setBusy(true); const res = await voidFinanceEntryAction(voiding!, reason); setBusy(false); if (!res.ok) return void toast.error(res.error); toast.success("Voided"); setVoiding(null); router.refresh(); }}>Void entry</Button></>}
      >
        <Field label="Why?" htmlFor="void-reason"><Textarea id="void-reason" rows={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </Dialog>
    </div>
  );
}

/** What stands under the rate field: what the number is for, and a warning (never a block) when a token rate looks like a price per single token or per million. */
function rateHint(unit: string, typed: string) {
  const hint = rateFieldHint(unit);
  const warning = rateSanityNote(unit, Number(typed));
  if (!hint && !warning) return undefined;
  return <>{hint}{warning && <span role="status" className="mt-1 block font-medium text-warning-ink">{warning}</span>}</>;
}

function Rates({ overview, rates, r, canManage }: { overview: AgencyBillingOverview; rates: UnitRateRow[]; r: FinancialReport; canManage: boolean }) {
  const router = useRouter();
  const [fx, setFx] = React.useState(overview.fx.usdPhpRate ? String(overview.fx.usdPhpRate) : "");
  const [fxSource, setFxSource] = React.useState("");
  const [tax, setTax] = React.useState(r.tax.configuredBps === null ? "" : String(r.tax.configuredBps / 100));
  const [reserve, setReserve] = React.useState(String(r.reserve.perSetupUsd));
  const [rate, setRate] = React.useState({ provider: "ghl", unit: "sms_segment", wholesale: "", note: "" });
  const [adj, setAdj] = React.useState({ orgId: "", delta: "", reason: "" });
  const [fee, setFee] = React.useState({ orgId: "", provider: "ghl", kind: "number_rental" as const, description: "", amount: "", recurrence: "monthly" as "one_time" | "monthly" | "annual" });
  const [busy, setBusy] = React.useState<string | null>(null);
  const act = async (key: string, fn: () => Promise<{ ok: boolean; error?: string }>, done: string) => {
    setBusy(key);
    const res = await fn();
    setBusy(null);
    if (!res.ok) return void toast.error(res.error ?? "That didn't work.");
    toast.success(done);
    router.refresh();
  };
  const pm = overview.paymongo;
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <div className="flex items-start gap-3">
            <span className={`flex size-9 shrink-0 items-center justify-center rounded-xl ${pm.configured && pm.webhookConfigured ? "bg-success-soft text-success-ink" : "bg-warning-soft text-warning-ink"}`}><Landmark className="size-4" aria-hidden /></span>
            <div>
              <CardTitle className="flex flex-wrap items-center gap-2">PayMongo <StatusPill tone={pm.configured ? (pm.webhookConfigured ? (pm.livemode ? "success" : "primary") : "warning") : "neutral"}>{pm.configured ? (pm.webhookConfigured ? (pm.livemode ? "Live keys" : "Test keys") : "Webhook missing") : "Not connected"}</StatusPill></CardTitle>
              <CardDescription>Checkout, refunds and webhooks. Live checkout stays off until the provider and the legal and tax treatment of prepaid credits have been reviewed.</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {pm.problems.length > 0 && <ul className="space-y-1.5">{pm.problems.map((p) => <li key={p} className="flex items-start gap-2.5 rounded-xl border border-warning/25 bg-warning-soft px-3.5 py-2.5 text-[14px] leading-relaxed text-warning-ink"><ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />{p}</li>)}</ul>}
          <label className="flex items-start justify-between gap-4 rounded-2xl border border-line p-4">
            <span>
              <span className="block text-[14px] font-medium">Live-payments review confirmed</span>
              <span className="mt-0.5 block text-[13px] leading-relaxed text-muted">{overview.liveReviewConfirmedAt ? `Confirmed ${formatDateTime(overview.liveReviewConfirmedAt, "UTC")}.` : "Not confirmed. Real-money checkout is blocked."} Only switch this on after the review is genuinely done.</span>
            </span>
            <Switch checked={Boolean(overview.liveReviewConfirmedAt)} disabled={!canManage || busy === "review"} aria-label="Live-payments review confirmed" onCheckedChange={(v) => void act("review", () => confirmLiveReviewAction(v), v ? "Recorded" : "Withdrawn")} />
          </label>
          {canManage && (
            <form className="grid gap-3 sm:grid-cols-[1fr_2fr_auto]" onSubmit={(e) => { e.preventDefault(); void act("fx", () => setExchangeRateAction(Number(fx), fxSource), "Rate saved"); }}>
              <Field label="PHP per USD" htmlFor="fx-rate" hint={overview.fx.updatedAt ? `Last set ${formatDateTime(overview.fx.updatedAt, "UTC")}` : "Not set. Checkout can't convert prices yet."}><Input id="fx-rate" inputMode="decimal" value={fx} onChange={(e) => setFx(e.target.value)} /></Field>
              <Field label="Where this rate came from" htmlFor="fx-src" hint={overview.fx.source ?? undefined}><Input id="fx-src" value={fxSource} onChange={(e) => setFxSource(e.target.value)} placeholder="e.g. BSP reference rate, 14 Oct" /></Field>
              <div className="flex items-end"><Button type="submit" variant="secondary" loading={busy === "fx"} disabled={!(Number(fx) > 0) || fxSource.trim().length < 3}>Save rate</Button></div>
            </form>
          )}
        </CardContent>
      </Card>

      {overview.planRenewals && (
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Maintenance plan renewals</CardTitle>
              <CardDescription>Plans are paid for and recorded by hand, so nothing renews itself. The team and the client&apos;s owner are reminded 7 days and 1 day before a plan&apos;s paid-through day, and the team is told when that day passes with no payment recorded.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <label className="flex items-start justify-between gap-4 rounded-2xl border border-line p-4">
              <span>
                <span className="block text-[14px] font-medium">Mark a plan past due automatically</span>
                <span className="mt-0.5 block text-[13px] leading-relaxed text-muted">
                  {overview.planRenewals.autoPastDue ? `On${overview.planRenewals.changedAt ? ` since ${formatDateTime(overview.planRenewals.changedAt, "UTC")}` : ""}.` : "Off, which is the default: the team is told, and nothing changes until someone records it."}{" "}
                  When on, a plan whose paid period ended {overview.planRenewals.minDaysOver} or more days ago with no payment recorded is marked past due, and its owner is told Automation Studio keeps working for {overview.planRenewals.graceDays} more days. Recording a payment before then brings the plan back to active. If none is recorded, the plan expires when that time is up and its Automation Studio workflows are paused (nothing is deleted).
                </span>
              </span>
              <Switch checked={overview.planRenewals.autoPastDue} disabled={!canManage || busy === "autopd"} aria-label="Mark a plan past due automatically" onCheckedChange={(v) => void act("autopd", () => setAutoPastDueAction(v), v ? "Switched on" : "Switched off")} />
            </label>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><div><CardTitle>Usage rates</CardTitle><CardDescription>What each provider charges us per unit, and what clients are charged: wholesale × {(overview.markupBps / 10000).toFixed(2)} (a {((overview.markupBps - 10000) / 100).toFixed(0)}% markup on eligible metered usage, not a {((overview.markupBps - 10000) / 100).toFixed(0)}% profit margin). Nothing can be billed on a unit until its rate is published.</CardDescription></div></CardHeader>
        <CardContent className="space-y-4 px-0 pb-0">
          {rates.length === 0 ? <EmptyState compact icon={<Scale />} title="No rates published yet" description="Measure the provider's real cost, then publish it. Until then, sending on that channel is refused because it couldn't be billed." /> : (
            <div className="overflow-x-auto" tabIndex={0}><table className="w-full min-w-[34rem] text-left text-[14px]"><caption className="sr-only">Published usage rates</caption><thead><tr className="border-y border-line bg-surface-2/60"><th scope="col" className={`${TH} px-5`}>Unit</th><th scope="col" className={TH}>Provider</th><th scope="col" className={`${TH} text-right`}>We pay</th><th scope="col" className={`${TH} text-right`}>Client pays</th><th scope="col" className={`${TH} px-5 text-right`}>Published</th></tr></thead>
              <tbody className="divide-y divide-line">{rates.map((x) => <tr key={`${x.provider}:${x.unitType}`} className="management-row"><th scope="row" className="px-5 py-3 font-medium">{x.label}</th><td className="px-3 py-3"><InfoChip>{providerLabel(x.provider)}</InfoChip></td><td className="px-3 py-3 text-right tabular-nums">${(x.wholesaleMicrosPerUnit / 1e6).toFixed(6)}</td><td className="px-3 py-3 text-right font-medium tabular-nums">${(x.clientMicrosPerUnit / 1e6).toFixed(6)}</td><td className="whitespace-nowrap px-5 py-3 text-right text-muted">{formatDate(x.publishedAt, "UTC")}</td></tr>)}</tbody></table></div>
          )}
          {canManage && (
            <form className="grid gap-3 border-t border-line p-5 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_2fr_auto]" onSubmit={(e) => { e.preventDefault(); void act("rate", () => publishUnitRateAction(rate.provider, rate.unit, Number(rate.wholesale), rate.note), "Rate published"); }}>
              <Field label="Provider" htmlFor="rate-prov"><Input id="rate-prov" value={rate.provider} onChange={(e) => setRate({ ...rate, provider: e.target.value })} /></Field>
              <Field label="Unit" htmlFor="rate-unit"><Select id="rate-unit" value={rate.unit} onChange={(e) => setRate({ ...rate, unit: e.target.value })}>{["sms_segment", "whatsapp_message", "email_send", "ai_tokens_in", "ai_tokens_out", "ai_research_call", "premium_api_call", "automation_execution", "other"].map((u) => <option key={u} value={u}>{rateUnitLabel(u)}</option>)}</Select></Field>
              <Field label={rateFieldLabel(rate.unit)} htmlFor="rate-w" hint={rateHint(rate.unit, rate.wholesale)}><Input id="rate-w" inputMode="decimal" value={rate.wholesale} onChange={(e) => setRate({ ...rate, wholesale: e.target.value })} placeholder={ratePlaceholder(rate.unit)} /></Field>
              <Field label="Where this came from" htmlFor="rate-note" optional><Input id="rate-note" value={rate.note} onChange={(e) => setRate({ ...rate, note: e.target.value })} placeholder="Provider invoice or price page" /></Field>
              <div className="flex items-end"><Button type="submit" variant="secondary" loading={busy === "rate"} disabled={!(Number(rate.wholesale) > 0)}>Publish</Button></div>
            </form>
          )}
        </CardContent>
      </Card>

      {canManage && (
        <div className="grid gap-5 xl:grid-cols-2">
          <Card>
            <CardHeader><div><CardTitle>Adjust a client&apos;s credits</CardTitle><CardDescription>A correction or goodwill credit. It is recorded in their ledger with your reason and can&apos;t push the balance below zero.</CardDescription></div></CardHeader>
            <CardContent>
              <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void act("adj", () => adjustCreditsAction(adj.orgId, Number(adj.delta), adj.reason), "Adjustment recorded"); }}>
                <Field label="Client" htmlFor="adj-org"><Select id="adj-org" value={adj.orgId} onChange={(e) => setAdj({ ...adj, orgId: e.target.value })}><option value="">Choose a client</option>{r.clients.map((c) => <option key={c.orgId} value={c.orgId}>{c.name}</option>)}</Select></Field>
                <Field label="Amount (USD, negative to remove)" htmlFor="adj-amt"><Input id="adj-amt" inputMode="decimal" value={adj.delta} onChange={(e) => setAdj({ ...adj, delta: e.target.value })} placeholder="25" /></Field>
                <Field label="Reason" htmlFor="adj-reason"><Input id="adj-reason" value={adj.reason} onChange={(e) => setAdj({ ...adj, reason: e.target.value })} /></Field>
                <Button type="submit" variant="secondary" loading={busy === "adj"} disabled={!adj.orgId || !Number(adj.delta) || adj.reason.trim().length < 3}>Record adjustment</Button>
              </form>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><div><CardTitle>Disclose a provider fee</CardTitle><CardDescription>Fixed provider charges such as a number rental are shown to the client separately and need their approval. They carry no markup.</CardDescription></div></CardHeader>
            <CardContent>
              <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void act("fee", () => addProviderFeeAction({ ...fee, amountUsd: Number(fee.amount) }), "Fee disclosed to the client"); }}>
                <Field label="Client" htmlFor="fee-org"><Select id="fee-org" value={fee.orgId} onChange={(e) => setFee({ ...fee, orgId: e.target.value })}><option value="">Choose a client</option>{r.clients.map((c) => <option key={c.orgId} value={c.orgId}>{c.name}</option>)}</Select></Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Kind" htmlFor="fee-kind"><Select id="fee-kind" value={fee.kind} onChange={(e) => setFee({ ...fee, kind: e.target.value as typeof fee.kind })}>{["number_rental", "sender_registration", "whatsapp_connection", "domain", "other"].map((k) => <option key={k} value={k}>{sentenceCase(k)}</option>)}</Select></Field>
                  <Field label="Repeats" htmlFor="fee-rec"><Select id="fee-rec" value={fee.recurrence} onChange={(e) => setFee({ ...fee, recurrence: e.target.value as typeof fee.recurrence })}><option value="one_time">Once</option><option value="monthly">Monthly</option><option value="annual">Yearly</option></Select></Field>
                </div>
                <Field label="Description" htmlFor="fee-desc"><Input id="fee-desc" value={fee.description} onChange={(e) => setFee({ ...fee, description: e.target.value })} placeholder="SMS number rental" /></Field>
                <Field label="Amount (USD)" htmlFor="fee-amt"><Input id="fee-amt" inputMode="decimal" value={fee.amount} onChange={(e) => setFee({ ...fee, amount: e.target.value })} /></Field>
                <Button type="submit" variant="secondary" loading={busy === "fee"} disabled={!fee.orgId || fee.description.trim().length < 3 || !(Number(fee.amount) > 0)}>Disclose fee</Button>
              </form>
            </CardContent>
          </Card>
          <Card className="xl:col-span-2">
            <CardHeader><div><CardTitle>Reserve and tax assumptions</CardTitle><CardDescription>Your own decisions; the portal assumes neither. Leave the tax rate empty if you haven&apos;t decided one.</CardDescription></div></CardHeader>
            <CardContent>
              <form className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]" onSubmit={(e) => { e.preventDefault(); void act("settings", () => saveFinanceSettingsAction({ setupReserveUsd: Number(reserve), taxSetAsideBps: tax.trim() === "" ? null : Math.round(Number(tax) * 100) }), "Saved"); }}>
                <Field label="Reserve per setup payment (USD)" htmlFor="set-res" hint="Recommended: $200."><Input id="set-res" inputMode="numeric" value={reserve} onChange={(e) => setReserve(e.target.value)} /></Field>
                <Field label="Tax set-aside rate (%)" htmlFor="set-tax" optional hint="Applied to the result before set-asides. Not tax advice."><Input id="set-tax" inputMode="decimal" value={tax} onChange={(e) => setTax(e.target.value)} placeholder="Not set" /></Field>
                <div className="flex items-end"><Button type="submit" variant="secondary" loading={busy === "settings"} disabled={!(Number(reserve) >= 0)}>Save</Button></div>
              </form>
            </CardContent>
          </Card>
        </div>
      )}

      {overview.unmatchedEvents.length > 0 && (
        <Card>
          <CardHeader><div><CardTitle>Payment notifications that need a look</CardTitle><CardDescription>Events PayMongo sent that were rejected, failed to process or aren&apos;t handled automatically. Check each against PayMongo.</CardDescription></div></CardHeader>
          <CardContent className="px-0 pb-0">
            <ul className="divide-y divide-line">{overview.unmatchedEvents.map((e) => <li key={e.id} className="management-row flex flex-wrap items-start gap-x-3 gap-y-2 px-5 py-3.5"><div className="min-w-0 flex-1 basis-60"><div className="flex flex-wrap items-center gap-2"><p className="text-[14px] font-medium">{readableEvent(e.eventType)}</p><InfoChip className="bg-transparent font-mono text-[12px] text-muted">{e.eventType}</InfoChip></div><p className="mt-1 text-[12px] leading-relaxed text-muted">{e.detail ?? "No detail recorded."}</p></div><div className="flex items-center gap-3"><StatusPill tone={OUTCOME_TONE[e.outcome as keyof typeof OUTCOME_TONE] ?? "neutral"} size="sm">{sentenceCase(e.outcome)}</StatusPill><time dateTime={e.receivedAt} className="whitespace-nowrap text-[12px] text-muted">{formatDateTime(e.receivedAt, "UTC")}</time></div></li>)}</ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Clients({ r, overview }: { r: FinancialReport; overview: AgencyBillingOverview }) {
  return (
    <div className="space-y-5">
      <Card className="overflow-hidden">
        <CardHeader><div><CardTitle>Client contribution</CardTitle><CardDescription>What each client brought in and cost for {r.period.label.toLowerCase()}. Overhead isn&apos;t shared out, so this is a contribution, not a profit.</CardDescription></div></CardHeader>
        <CardContent className="px-0 pb-0">
          {r.clients.length === 0 ? <EmptyState compact icon={<Banknote />} title="No clients to show" /> : (
            <div className="overflow-x-auto" tabIndex={0}><table className="w-full min-w-[44rem] text-left text-[14px]"><caption className="sr-only">Contribution by client</caption>
              <thead><tr className="border-y border-line bg-surface-2/60"><th scope="col" className={`${TH} px-5 text-left`}>Client</th><th scope="col" className={`${TH} text-right`}>Cash in</th><th scope="col" className={`${TH} text-right`}>Usage charged</th><th scope="col" className={`${TH} text-right`}>Provider cost</th><th scope="col" className={`${TH} text-right`}>Fees</th><th scope="col" className={`${TH} text-right`}>Direct costs</th><th scope="col" className={`${TH} px-5 text-right`}>Contribution</th></tr></thead>
              <tbody className="divide-y divide-line">{r.clients.map((c) => <tr key={c.orgId} className="management-row"><th scope="row" className="px-5 py-2.5 font-medium"><Link href={`/admin/clients/${c.orgId}`} className="flex min-w-0 items-center gap-2.5 hover:text-primary-ink"><AvatarTile name={c.name} size="sm" /><span className="truncate" title={c.name}>{c.name}</span></Link></th><td className="px-3 py-2.5 text-right tabular-nums">{dollars(c.receivedMicros - c.refundedMicros)}</td><td className="px-3 py-2.5 text-right tabular-nums">{dollars(c.usageChargedMicros)}</td><td className="px-3 py-2.5 text-right tabular-nums">{dollars(-c.providerCostMicros)}</td><td className="px-3 py-2.5 text-right tabular-nums">{dollars(-c.paymentFeesMicros)}</td><td className="px-3 py-2.5 text-right tabular-nums">{dollars(-c.directCostsMicros)}</td><td className={`px-5 py-2.5 text-right font-semibold tabular-nums ${c.contributionMicros < 0 ? "text-danger-ink" : ""}`}>{c.contributionMicros < 0 && <span className="sr-only">Negative </span>}{dollars(c.contributionMicros)}</td></tr>)}</tbody></table></div>
          )}
        </CardContent>
      </Card>
      {overview.reconciliationErrors.length > 0 && (
        <Card>
          <CardHeader><div><CardTitle className="flex items-center gap-2 text-danger-ink"><AlertTriangle className="size-4" aria-hidden />Credit ledgers that don&apos;t add up</CardTitle><CardDescription>The stored balance differs from the sum of the ledger. Review before relying on any figure for these clients.</CardDescription></div></CardHeader>
          <CardContent className="px-0 pb-0"><ul className="divide-y divide-line">{overview.reconciliationErrors.map((e) => <li key={e.orgId} className="management-row flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3 text-[14px]"><span className="flex min-w-0 flex-1 items-center gap-2.5 font-medium"><AvatarTile name={e.name} size="sm" /><span className="truncate" title={e.name}>{e.name}</span></span><span className="flex flex-wrap items-center gap-1.5"><InfoChip>Stored {dollars(e.balanceMicros)}</InfoChip><InfoChip>Ledger {dollars(e.ledgerBalanceMicros)}</InfoChip><StatusPill tone="danger" size="sm">Mismatch</StatusPill></span></li>)}</ul></CardContent>
        </Card>
      )}
    </div>
  );
}

export function FinanceWorkspace({ report, overview, rates, canManage, tab, period, payments = [], paymentClients = [], timeZone = "UTC" }: { report: FinancialReport; overview: AgencyBillingOverview; rates: UnitRateRow[]; canManage: boolean; tab: Tab; period: PeriodKey; payments?: AgencyPaymentView[]; paymentClients?: PaymentClientOption[]; timeZone?: string }) {
  const router = useRouter();
  const r = report;
  const go = (t: Tab, p: PeriodKey) => router.push(`/admin/billing?tab=${t}&period=${p}`);
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard label="Net cash received" value={dollars(r.received.netMicros)} detail="After refunds. Not profit." icon={<Banknote />} />
        <MetricCard label="Usage markup" value={dollars(r.usage.grossMarkupContributionMicros)} detail="A contribution after provider cost" icon={<BadgeCheck />} tone="violet" />
        <MetricCard label="Held for clients" value={dollars(r.prepaid.heldForClientsMicros)} detail="Prepaid credit, owed as service" icon={<Wallet />} tone="amber" />
        <MetricCard label={r.distributable ? "Estimated to distribute" : "Your clients' contribution"} value={r.distributable ? dollars(r.distributable.estimateMicros) : dollars(r.clients.reduce((n, c) => n + c.contributionMicros, 0))} detail={r.distributable ? "A planning estimate" : "Across assigned clients"} icon={<Scale />} tone="green" />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented id="finance-tab" ariaLabel="Section" size="sm" value={tab} onChange={(t) => go(t, period)} options={TABS.map((t) => ({ value: t.value, label: t.label }))} />
        <label className="flex items-center gap-2 text-[14px] text-muted">Period
          <Select aria-label="Reporting period" value={period} onChange={(e) => go(tab, e.target.value as PeriodKey)} className="w-44">{(Object.keys(PERIOD_LABEL) as PeriodKey[]).map((k) => <option key={k} value={k}>{PERIOD_LABEL[k]}</option>)}</Select>
        </label>
      </div>
      {tab === "statement" && <Statement r={r} />}
      {tab === "entries" && <Entries r={r} canManage={canManage} />}
      {tab === "payments" && <PaymentsWorkspace payments={payments} clients={paymentClients} canManage={canManage} timeZone={timeZone} />}
      {tab === "rates" && <Rates overview={overview} rates={rates} r={r} canManage={canManage} />}
      {tab === "clients" && <Clients r={r} overview={overview} />}
    </div>
  );
}
