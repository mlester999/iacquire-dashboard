"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowUpRight, BadgeCheck, CircleAlert, Coins, Gauge, Hourglass, Receipt, ShieldCheck, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input, ProgressBar } from "@/components/ui/primitives";
import { Switch } from "@/components/ui/overlays";
import { approveProviderFeeAction, startTopUpAction, updateBillingSettingsAction } from "@/app/actions/billing";
import { UNIT_LABELS, formatUsd } from "@/lib/billing";
import { formatDateTime, formatNumber, sentenceCase } from "@/lib/utils";
import type { BillingOverview } from "@/server/billing/service";

const LEDGER_LABEL: Record<string, string> = {
  credits_granted: "Credits added",
  usage_consumed: "Usage",
  reservation_held: "Held for work in progress",
  reservation_released: "Hold released",
  refund: "Refund",
  reversal: "Reversal",
  adjustment: "Adjustment by iAcquire",
  reconciliation: "Reconciliation",
};

const PAYMENT_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = { paid: "success", pending: "warning", failed: "danger", mismatch: "danger", refunded: "neutral", partially_refunded: "neutral", expired: "neutral", cancelled: "neutral", disputed: "danger" };

export function BillingWorkspace({
  overview,
  canTopUp,
  canConfigure,
  isOwner,
  canSeePayments,
  timeZone,
  returned,
  legacy,
}: {
  overview: BillingOverview;
  canTopUp: boolean;
  canConfigure: boolean;
  isOwner: boolean;
  canSeePayments: boolean;
  timeZone: string;
  returned: "success" | "cancelled" | null;
  legacy: { setupFeeLabel: string; setupStatus: string; activation: string; invoiceUrl: string | null; receiptUrl: string | null; serviceTerms: string | null };
}) {
  const o = overview;
  const hasHistory = o.recentLedger.length > 0;
  const exhausted = o.availableMicros <= 0 && hasHistory;
  const noCreditsYet = o.availableMicros <= 0 && !hasHistory;
  const low = !exhausted && !noCreditsYet && o.availableMicros <= o.budget.lowBalanceMicros;
  return (
    <div className="space-y-6">
      {returned === "success" && (
        <p role="status" className="flex items-start gap-2 rounded-2xl bg-primary-soft p-4 text-[13.5px] text-primary-ink">
          <Hourglass className="mt-0.5 size-4 shrink-0" /> We&apos;re confirming your payment with PayMongo. Credits appear here only after PayMongo confirms it, usually within a minute. Returning to this page doesn&apos;t add credits by itself.
        </p>
      )}
      {returned === "cancelled" && <p role="status" className="rounded-2xl bg-surface-2 p-4 text-[13.5px] text-ink-2">Checkout was cancelled. You weren&apos;t charged.</p>}

      <section className="relative overflow-hidden rounded-[26px] bg-[#11192c] p-5 text-white sm:p-8" aria-label="Service credits">
        <div aria-hidden className="pointer-events-none absolute -right-20 -top-24 size-96 rounded-full bg-blue-500/15 blur-3xl" />
        <div className="relative grid gap-8 lg:grid-cols-[1.2fr_1fr]">
          <div>
            <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[.18em] text-blue-200"><Wallet className="size-3.5" /> Prepaid service credits</p>
            <p className="mt-3 text-[44px] font-semibold leading-none tracking-[-.05em] tabular-nums sm:text-[56px]">{formatUsd(o.availableMicros)}</p>
            <p className="mt-2 text-[13px] text-slate-300">
              available to spend{o.reservedMicros > 0 ? ` · ${formatUsd(o.reservedMicros)} held for work in progress` : ""}
            </p>
            {noCreditsYet && <p role="status" className="mt-4 rounded-xl bg-white/10 p-3 text-[13px] text-slate-100">You haven&apos;t added service credits yet. Anything that costs usage, like AI replies and follow-ups, stays paused until you do. Your records and conversations are unaffected.</p>}
            {(exhausted || low) && (
              <p role="status" className="mt-4 flex items-start gap-2 rounded-xl bg-white/10 p-3 text-[13px] text-amber-100">
                <CircleAlert className="mt-0.5 size-4 shrink-0" />
                {exhausted ? "Credits have run out, so new chargeable work is paused. Your leads, conversations and records are safe and urgent escalations still appear." : "Credits are running low. Add more so replies and follow-ups can continue."}
              </p>
            )}
            <dl className="mt-5 grid grid-cols-3 gap-4 text-[12px] text-slate-300">
              <div>
                <dt>This month</dt>
                <dd className="mt-1 text-[16px] font-semibold text-white tabular-nums">{formatUsd(o.budget.monthSpendMicros)}</dd>
              </div>
              <div>
                <dt>Burn rate</dt>
                <dd className="mt-1 text-[16px] font-semibold text-white tabular-nums">{o.burn.perDayMicros > 0 ? `${formatUsd(o.burn.perDayMicros)}/day` : "No history"}</dd>
              </div>
              <div>
                <dt>Estimated runway</dt>
                <dd className="mt-1 text-[16px] font-semibold text-white tabular-nums">{o.burn.daysRemaining === null ? "—" : `${formatNumber(o.burn.daysRemaining)} days`}</dd>
              </div>
            </dl>
            <p className="mt-3 text-[11.5px] text-slate-400">{o.burn.perDayMicros > 0 ? `Estimated from the last ${o.burn.basisDays} days of recorded usage.` : "An estimate appears once usage has been recorded."}</p>
          </div>
          <TopUp presets={o.payments.presetsUsd} min={o.payments.minUsd} max={o.payments.maxUsd} enabled={canTopUp && o.payments.canTopUp} blockedReason={canTopUp ? o.payments.blockedReason : "Only owners and managers can add credits."} />
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-[1.1fr_.9fr]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <div>
                <CardTitle className="flex items-center gap-2"><Gauge className="size-4" /> Usage this month</CardTitle>
                <CardDescription>What your workspace consumed and what it cost. Every line is a real recorded event.</CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              {o.usageByUnit.length ? (
                <ul className="divide-y divide-line">
                  {o.usageByUnit.map((u) => (
                    <li key={u.unitType} className="flex items-center justify-between gap-3 py-2.5 text-[13.5px]">
                      <span>{UNIT_LABELS[u.unitType] ?? sentenceCase(u.unitType)}</span>
                      <span className="flex items-baseline gap-3 tabular-nums">
                        <span className="text-muted">{formatNumber(Math.round(u.quantity))}</span>
                        <strong>{formatUsd(u.chargedMicros)}</strong>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="rounded-xl bg-surface-2 p-4 text-[13px] text-muted">No chargeable usage has been recorded this month.</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle className="flex items-center gap-2"><Coins className="size-4" /> Credit activity</CardTitle>
                <CardDescription>Credits added, spent and released, newest first.</CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              {o.recentLedger.length ? (
                <ul className="divide-y divide-line">
                  {o.recentLedger.map((l) => (
                    <li key={l.id} className="flex items-center justify-between gap-3 py-2.5 text-[13px]">
                      <span className="min-w-0">
                        <span className="block font-medium">{LEDGER_LABEL[l.kind] ?? sentenceCase(l.kind)}</span>
                        <span className="block truncate text-[12px] text-muted">{formatDateTime(l.createdAt, timeZone)}{l.memo ? ` · ${l.memo}` : ""}</span>
                      </span>
                      <span className={`shrink-0 font-semibold tabular-nums ${l.deltaMicros > 0 ? "text-success-ink" : l.deltaMicros < 0 ? "text-ink" : "text-muted"}`}>{l.deltaMicros === 0 ? "—" : `${l.deltaMicros > 0 ? "+" : "−"}${formatUsd(Math.abs(l.deltaMicros))}`}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="rounded-xl bg-surface-2 p-4 text-[13px] text-muted">No credit activity yet. Add credits to let your AI team send replies and follow-ups.</p>
              )}
            </CardContent>
          </Card>

          {canSeePayments && (
            <Card>
              <CardHeader>
                <div>
                  <CardTitle className="flex items-center gap-2"><Receipt className="size-4" /> Payments</CardTitle>
                  <CardDescription>Payments are confirmed by PayMongo, never by this page.</CardDescription>
                </div>
              </CardHeader>
              <CardContent>
                {o.recentPayments.length ? (
                  <ul className="divide-y divide-line">
                    {o.recentPayments.map((p) => (
                      <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-[13px]">
                        <span className="min-w-0">
                          <span className="block font-medium">{p.description}</span>
                          <span className="block text-[12px] text-muted">{p.referenceNumber} · {formatDateTime(p.paidAt ?? p.createdAt, timeZone)}</span>
                        </span>
                        <span className="flex items-center gap-2">
                          <strong className="tabular-nums">{formatUsd(p.usdMicros)}</strong>
                          <Badge tone={PAYMENT_TONE[p.status] ?? "neutral"}>{sentenceCase(p.status)}</Badge>
                          {p.checkoutUrl && <a href={p.checkoutUrl} rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[12px] font-medium text-primary">Continue <ArrowUpRight className="size-3" /></a>}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="rounded-xl bg-surface-2 p-4 text-[13px] text-muted">No payments yet.</p>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <SpendingControls overview={o} canConfigure={canConfigure} />

          <Card>
            <CardHeader>
              <div>
                <CardTitle className="flex items-center gap-2"><ShieldCheck className="size-4" /> How you&apos;re charged</CardTitle>
                <CardDescription>No monthly platform fee. You pay once for setup, then only for what you use.</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 text-[13px] leading-relaxed text-ink-2">
              <p><strong className="text-ink">Setup:</strong> {legacy.setupFeeLabel} one time. Status: {sentenceCase(legacy.setupStatus)}.</p>
              <p><strong className="text-ink">Usage:</strong> the provider&apos;s wholesale cost plus {((o.rates.markupBps - 10000) / 100).toFixed(0)}% (rate v{o.rates.version}). Fixed provider fees, taxes and payment processing charges are never marked up.</p>
              <p><strong className="text-ink">Credits</strong> are prepaid, non-transferable service credits, not a cash balance. They are used only for the services above.</p>
              <p>
                <strong className="text-ink">Optional:</strong> <Link href="/maintenance" className="font-medium text-primary hover:underline">managed maintenance</Link> and <Link href="/add-ons" className="font-medium text-primary hover:underline">custom projects</Link> are separate and always your choice.
              </p>
              {o.rates.unitRates.length > 0 ? (
                <table className="mt-2 w-full text-left text-[12.5px]">
                  <caption className="sr-only">Published unit rates</caption>
                  <thead className="text-muted"><tr><th className="py-1 font-medium">Unit</th><th className="py-1 text-right font-medium">Your rate</th></tr></thead>
                  <tbody>{o.rates.unitRates.map((r) => <tr key={`${r.provider}-${r.unitType}`} className="border-t border-line"><td className="py-1.5">{r.unitLabel}</td><td className="py-1.5 text-right tabular-nums">{formatUsd(r.clientMicrosPerUnit, { precise: true })}</td></tr>)}</tbody>
                </table>
              ) : (
                <p className="rounded-xl bg-surface-2 p-3 text-[12.5px] text-muted">Per-unit rates are published once iAcquire has measured real provider costs. Until then each usage line above shows exactly what was charged.</p>
              )}
              <p className="rounded-xl bg-surface-2 p-3 text-[12.5px] text-muted">Auto-recharge is off. {o.autoRecharge.reason}</p>
            </CardContent>
          </Card>

          <ProviderFees fees={o.providerFees} isOwner={isOwner} />

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Setup invoice &amp; terms</CardTitle>
                <CardDescription>Shared by the iAcquire team when available.</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="space-y-2 text-[13px]">
              <Badge tone={legacy.setupStatus === "paid" || legacy.setupStatus === "waived" ? "success" : "warning"}>Setup: {sentenceCase(legacy.setupStatus)}</Badge>{" "}
              <Badge tone={legacy.activation === "active" ? "success" : legacy.activation === "suspended" ? "danger" : "neutral"}>Activation: {sentenceCase(legacy.activation)}</Badge>
              <div className="flex flex-wrap gap-3 pt-2">
                {legacy.invoiceUrl ? <a href={legacy.invoiceUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-primary hover:underline">Setup invoice</a> : <span className="text-muted">No invoice shared yet.</span>}
                {legacy.receiptUrl && <a href={legacy.receiptUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-primary hover:underline">Payment receipt</a>}
              </div>
              {legacy.serviceTerms && <p className="whitespace-pre-wrap pt-2 leading-relaxed text-ink-2">{legacy.serviceTerms}</p>}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function TopUp({ presets, min, max, enabled, blockedReason }: { presets: readonly number[]; min: number; max: number; enabled: boolean; blockedReason: string | null }) {
  const [custom, setCustom] = React.useState("");
  const [busy, setBusy] = React.useState<number | "custom" | null>(null);
  async function go(amount: number, key: number | "custom") {
    setBusy(key);
    const result = await startTopUpAction(amount);
    if (!result.ok) {
      setBusy(null);
      toast.error(result.error);
      return;
    }
    window.location.assign(result.data.checkoutUrl);
  }
  const customAmount = Number(custom);
  const customValid = Number.isInteger(customAmount) && customAmount >= min && customAmount <= max;
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
      <h2 className="text-[14px] font-semibold">Add service credits</h2>
      <p className="mt-1 text-[12.5px] leading-relaxed text-slate-300">You&apos;ll pay on PayMongo&apos;s secure page. Credits are added after PayMongo confirms the payment.</p>
      <div className="mt-4 grid grid-cols-3 gap-2">
        {presets.map((amount) => (
          <button key={amount} type="button" disabled={!enabled || busy !== null} onClick={() => go(amount, amount)} className="min-h-12 rounded-xl border border-white/15 bg-white/5 text-[15px] font-semibold transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50">
            {busy === amount ? "Opening…" : `$${amount}`}
          </button>
        ))}
      </div>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (customValid) void go(customAmount, "custom");
        }}
      >
        <label className="sr-only" htmlFor="custom-topup">Custom amount in US dollars</label>
        <input id="custom-topup" inputMode="numeric" pattern="[0-9]*" placeholder={`Custom, $${min}–$${max}`} value={custom} disabled={!enabled || busy !== null} onChange={(event) => setCustom(event.target.value.replace(/[^0-9]/g, ""))} className="h-11 min-w-0 flex-1 rounded-xl border border-white/15 bg-white/5 px-3 text-[14px] text-white placeholder:text-slate-400 disabled:opacity-50" />
        <Button type="submit" variant="brand" disabled={!enabled || !customValid || busy !== null} loading={busy === "custom"}>Add</Button>
      </form>
      {!enabled && blockedReason && <p role="status" className="mt-3 text-[12.5px] leading-relaxed text-amber-100">{blockedReason}</p>}
    </div>
  );
}

function SpendingControls({ overview, canConfigure }: { overview: BillingOverview; canConfigure: boolean }) {
  const router = useRouter();
  const b = overview.budget;
  const [budget, setBudget] = React.useState(b.monthlyBudgetMicros ? String(b.monthlyBudgetMicros / 1_000_000) : "");
  const [warn, setWarn] = React.useState(String(b.warnAtPercent));
  const [low, setLow] = React.useState(String(b.lowBalanceMicros / 1_000_000));
  const [hardStop, setHardStop] = React.useState(b.hardStop);
  const [saving, setSaving] = React.useState(false);
  const pct = b.monthlyBudgetMicros ? Math.min(100, (b.monthSpendMicros / b.monthlyBudgetMicros) * 100) : 0;
  async function save() {
    setSaving(true);
    const result = await updateBillingSettingsAction({ monthlyBudgetUsd: budget.trim() === "" ? null : Number(budget), warnAtPercent: Number(warn), lowBalanceUsd: Number(low), hardStop });
    setSaving(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success("Spending limits saved.");
    router.refresh();
  }
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-2"><BadgeCheck className="size-4" /> Spending limits</CardTitle>
          <CardDescription>Keep automated spending inside a budget you set.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {b.monthlyBudgetMicros ? (
          <div>
            <div className="mb-1.5 flex justify-between text-[12.5px]"><span>{formatUsd(b.monthSpendMicros)} of {formatUsd(b.monthlyBudgetMicros)}</span><span className="text-muted">{Math.round(pct)}%</span></div>
            <ProgressBar value={pct} tone={pct >= 100 ? "danger" : pct >= b.warnAtPercent ? "warning" : "primary"} label="Monthly budget used" />
          </div>
        ) : (
          <p className="rounded-xl bg-surface-2 p-3 text-[12.5px] text-muted">No monthly limit is set. Spending is still capped by your credit balance.</p>
        )}
        <Field label="Monthly spending limit (USD)" htmlFor="budget-limit" hint="Leave empty for no monthly limit.">
          <Input id="budget-limit" inputMode="decimal" value={budget} disabled={!canConfigure} onChange={(event) => setBudget(event.target.value.replace(/[^0-9.]/g, ""))} placeholder="No limit" />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Warn me at (%)" htmlFor="budget-warn">
            <Input id="budget-warn" inputMode="numeric" value={warn} disabled={!canConfigure} onChange={(event) => setWarn(event.target.value.replace(/[^0-9]/g, ""))} />
          </Field>
          <Field label="Low-balance alert (USD)" htmlFor="budget-low">
            <Input id="budget-low" inputMode="decimal" value={low} disabled={!canConfigure} onChange={(event) => setLow(event.target.value.replace(/[^0-9.]/g, ""))} />
          </Field>
        </div>
        <label className="flex items-center justify-between gap-3 rounded-xl border border-line p-3 text-[13px]">
          <span>
            <span className="block font-medium">Stop chargeable work at the limit</span>
            <span className="block text-[12px] text-muted">Recommended. Messages and follow-ups pause until you raise the limit.</span>
          </span>
          <Switch checked={hardStop} disabled={!canConfigure} onCheckedChange={setHardStop} aria-label="Stop chargeable work at the monthly limit" />
        </label>
        {canConfigure ? <Button onClick={save} loading={saving}>Save limits</Button> : <p className="text-[12px] text-muted">Only owners and managers can change spending limits.</p>}
      </CardContent>
    </Card>
  );
}

function ProviderFees({ fees, isOwner }: { fees: BillingOverview["providerFees"]; isOwner: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  async function approve(id: string) {
    setBusy(id);
    const result = await approveProviderFeeAction(id);
    setBusy(null);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success("Fee approved.");
    router.refresh();
  }
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Provider fees</CardTitle>
          <CardDescription>Fixed charges from providers, billed at cost and shown separately from usage.</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {fees.length ? (
          <ul className="divide-y divide-line">
            {fees.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-[13px]">
                <span className="min-w-0">
                  <span className="block font-medium">{f.description}</span>
                  <span className="block text-[12px] text-muted">{f.provider} · {sentenceCase(f.recurrence)}</span>
                </span>
                <span className="flex items-center gap-2">
                  <strong className="tabular-nums">{formatUsd(f.amountMicros)}</strong>
                  {f.status === "disclosed" ? (
                    isOwner ? <Button size="sm" variant="soft" loading={busy === f.id} onClick={() => approve(f.id)}>Approve</Button> : <Badge tone="warning">Awaiting owner</Badge>
                  ) : (
                    <Badge tone={f.status === "billed" || f.status === "approved" ? "success" : "neutral"}>{sentenceCase(f.status)}</Badge>
                  )}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-xl bg-surface-2 p-3 text-[12.5px] text-muted">No provider fees. Anything such as a number rental or sender registration is disclosed here and needs your approval before it&apos;s billed.</p>
        )}
      </CardContent>
    </Card>
  );
}
