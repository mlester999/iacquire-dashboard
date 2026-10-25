"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowUpRight,
  BadgeCheck,
  CircleAlert,
  Coins,
  FileText,
  Gauge,
  Hourglass,
  Landmark,
  Minus,
  Percent,
  Plus,
  Receipt,
  ReceiptText,
  RotateCcw,
  Scale,
  ScrollText,
  ShieldCheck,
  Sparkles,
  Undo2,
  Wallet,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/button";
import { EmptyState, Field, Input, ProgressBar } from "@/components/ui/primitives";
import { Switch } from "@/components/ui/overlays";
import { InfoChip, StatusPill, type StatusTone } from "@/components/ui/status";
import { IconTile, Notice, Panel, SettingRow, type PanelTone } from "@/components/settings/panel";
import { approveProviderFeeAction, startTopUpAction, updateBillingSettingsAction } from "@/app/actions/billing";
import { UNIT_LABELS, formatUsd } from "@/lib/billing";
import { setupStatusCopy } from "@/lib/billing-clearance";
import { cn, formatDateTime, formatNumber, sentenceCase } from "@/lib/utils";
import type { BillingOverview } from "@/server/billing/service";

const LEDGER: Record<string, { label: string; icon: LucideIcon; tone: PanelTone }> = {
  credits_granted: { label: "Credits added", icon: Plus, tone: "success" },
  usage_consumed: { label: "Usage", icon: Zap, tone: "neutral" },
  reservation_held: { label: "Held for work in progress", icon: Hourglass, tone: "warning" },
  reservation_released: { label: "Hold released", icon: Undo2, tone: "neutral" },
  refund: { label: "Refund", icon: RotateCcw, tone: "violet" },
  reversal: { label: "Reversal", icon: Undo2, tone: "violet" },
  adjustment: { label: "Adjustment by iAcquire", icon: Scale, tone: "primary" },
  reconciliation: { label: "Reconciliation", icon: ReceiptText, tone: "primary" },
};

const PAYMENT_TONE: Record<string, StatusTone> = { paid: "success", pending: "warning", failed: "danger", mismatch: "danger", refunded: "neutral", partially_refunded: "neutral", expired: "neutral", cancelled: "neutral", disputed: "danger" };

const PROVIDERS: Record<string, string> = { ghl: "GoHighLevel", sms: "SMS", whatsapp: "WhatsApp", email: "Email", research: "Lead research", enrichment: "Enrichment" };

/** Ledger memos for metered usage are written as "provider unit_type"; show them as words. Human-written memos pass through untouched. */
function memoText(memo: string | null) {
  if (!memo) return null;
  if (!/^[a-z0-9]+( [a-z0-9_]+)?$/.test(memo)) return memo;
  const [provider, unit] = memo.split(" ");
  const left = PROVIDERS[provider] ?? (provider.length <= 4 ? provider.toUpperCase() : sentenceCase(provider));
  if (!unit) return left;
  return `${left} · ${UNIT_LABELS[unit] ?? sentenceCase(unit)}`;
}

const providerLabel = (p: string) => PROVIDERS[p] ?? sentenceCase(p);
const INITIAL_ROWS = 8;

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
  const setupCopy = setupStatusCopy(legacy.setupStatus);
  const hasHistory = o.recentLedger.length > 0;
  const exhausted = o.availableMicros <= 0 && hasHistory;
  const noCreditsYet = o.availableMicros <= 0 && !hasHistory;
  const low = !exhausted && !noCreditsYet && o.availableMicros <= o.budget.lowBalanceMicros;
  const [showAllLedger, setShowAllLedger] = React.useState(false);
  const [showAllPayments, setShowAllPayments] = React.useState(false);
  const ledger = showAllLedger ? o.recentLedger : o.recentLedger.slice(0, INITIAL_ROWS);
  const payments = showAllPayments ? o.recentPayments : o.recentPayments.slice(0, 6);
  const totalCharged = o.usageByUnit.reduce((sum, u) => sum + u.chargedMicros, 0);
  return (
    <div className="space-y-6">
      {returned === "success" && (
        <Notice tone="primary" icon={<Hourglass />} role="status">
          We&apos;re confirming your payment with PayMongo. Credits appear here only after PayMongo confirms it, usually within a minute. Returning to this page doesn&apos;t add credits by itself.
        </Notice>
      )}
      {returned === "cancelled" && (
        <Notice tone="neutral" icon={<CircleAlert />} role="status">
          Checkout was cancelled. You weren&apos;t charged.
        </Notice>
      )}

      <section className="workspace-hero workspace-hero-dark" aria-label="Service credits">
        <div className="relative grid gap-8 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <p className="hero-eyebrow">
                <span className="hero-module-icon" aria-hidden>
                  <Wallet />
                </span>
                Prepaid service credits
              </p>
              {exhausted && <StatusPill tone="danger" size="sm">Credits used up</StatusPill>}
              {low && <StatusPill tone="warning" size="sm">Running low</StatusPill>}
              {noCreditsYet && <StatusPill tone="neutral" size="sm">No credits yet</StatusPill>}
            </div>
            <p className="mt-4 text-[44px] font-semibold leading-none tracking-[-.05em] tabular-nums sm:text-[56px]">{formatUsd(o.availableMicros)}</p>
            <p className="hero-description mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[14px]">
              available to spend
              {o.reservedMicros > 0 && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--control-room-raised)] px-2.5 py-0.5 text-[12px] font-medium tabular-nums ring-1 ring-inset ring-current/15">
                  <Hourglass className="size-3" aria-hidden /> {formatUsd(o.reservedMicros)} held for work in progress
                </span>
              )}
            </p>
            {noCreditsYet && <HeroNotice icon={<Wallet />}>You haven&apos;t added service credits yet. Anything that costs usage, like AI replies and follow-ups, stays paused until you do. Your records and conversations are unaffected.</HeroNotice>}
            {(exhausted || low) && (
              <HeroNotice icon={<CircleAlert className="text-warning" />}>
                {exhausted ? "Credits have run out, so new chargeable work is paused. Your leads, conversations and records are safe and urgent escalations still appear." : "Credits are running low. Add more so replies and follow-ups can continue."}
              </HeroNotice>
            )}
            <dl className="mt-6 grid grid-cols-3 gap-2.5">
              <HeroStat label="This month" value={formatUsd(o.budget.monthSpendMicros)} />
              <HeroStat label="Burn rate" value={o.burn.perDayMicros > 0 ? `${formatUsd(o.burn.perDayMicros)}/day` : "No history"} />
              <HeroStat label="Est. runway" value={o.burn.daysRemaining === null ? "—" : `${formatNumber(o.burn.daysRemaining)} days`} />
            </dl>
            <p className="hero-description mt-3 text-[12px]">{o.burn.perDayMicros > 0 ? `Estimated from the last ${o.burn.basisDays} days of recorded usage.` : "An estimate appears once usage has been recorded."}</p>
          </div>
          <TopUp presets={o.payments.presetsUsd} min={o.payments.minUsd} max={o.payments.maxUsd} enabled={canTopUp && o.payments.canTopUp} blockedReason={canTopUp ? o.payments.blockedReason : "Only owners and managers can add credits."} />
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,.9fr)]">
        <div className="min-w-0 space-y-6">
          <Panel
            icon={<Gauge />}
            title="Usage this month"
            description="What your workspace consumed and what it cost. Every line is a real recorded event."
            aside={o.usageByUnit.length > 0 ? <InfoChip>{formatUsd(totalCharged)} charged</InfoChip> : undefined}
          >
            {o.usageByUnit.length ? (
              <ul className="divide-y divide-line">
                {o.usageByUnit.map((u) => {
                  const share = totalCharged > 0 ? (u.chargedMicros / totalCharged) * 100 : 0;
                  return (
                    <li key={u.unitType} className="py-3 first:pt-0 last:pb-0">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="min-w-0 text-[14px] font-medium text-ink">{UNIT_LABELS[u.unitType] ?? sentenceCase(u.unitType)}</span>
                        <strong className="shrink-0 text-[14px] font-semibold tabular-nums text-ink">{formatUsd(u.chargedMicros)}</strong>
                      </div>
                      <div className="mt-2 flex items-center gap-3">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3" aria-hidden>
                          <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(share, share > 0 ? 2 : 0)}%` }} />
                        </div>
                        <span className="w-28 shrink-0 text-right text-[12px] tabular-nums text-muted">{formatNumber(Math.round(u.quantity))} units</span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <EmptyState compact icon={<Gauge className="size-5" />} title="No usage yet this month" description="No chargeable usage has been recorded this month." />
            )}
          </Panel>

          <Panel
            icon={<Coins />}
            tone="success"
            title="Credit activity"
            description="Credits added, spent and released, newest first."
            aside={o.recentLedger.length > 0 ? <InfoChip>{o.recentLedger.length} entries</InfoChip> : undefined}
            flush
            footer={
              o.recentLedger.length > INITIAL_ROWS && (
                <Button variant="ghost" size="sm" className="w-full sm:w-auto" onClick={() => setShowAllLedger((v) => !v)} aria-expanded={showAllLedger}>
                  {showAllLedger ? "Show fewer entries" : `Show all ${o.recentLedger.length} entries`}
                </Button>
              )
            }
          >
            {o.recentLedger.length ? (
              <ul className="divide-y divide-line border-t border-line">
                {ledger.map((l) => {
                  const meta = LEDGER[l.kind] ?? { label: sentenceCase(l.kind), icon: ReceiptText, tone: "neutral" as PanelTone };
                  const memo = memoText(l.memo);
                  return (
                    <li key={l.id} className="management-row flex items-center gap-3.5 px-5 py-3 sm:px-6">
                      <IconTile icon={<meta.icon />} tone={meta.tone} size="sm" />
                      <div className="min-w-0 flex-1">
                        <p className="text-[14px] font-medium leading-snug text-ink">{meta.label}</p>
                        <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted">
                          <time dateTime={l.createdAt}>{formatDateTime(l.createdAt, timeZone)}</time>
                          {memo && <InfoChip className="max-w-full" >{memo}</InfoChip>}
                        </p>
                      </div>
                      {l.deltaMicros === 0 ? (
                        <InfoChip>No charge</InfoChip>
                      ) : (
                        <span className={cn("shrink-0 text-[14px] font-semibold tabular-nums", l.deltaMicros > 0 ? "text-success-ink" : "text-ink")}>
                          {l.deltaMicros > 0 ? "+" : "−"}
                          {formatUsd(Math.abs(l.deltaMicros))}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <EmptyState compact icon={<Coins className="size-5" />} title="No credit activity yet" description="Add credits to let your AI team send replies and follow-ups." className="border-t border-line" />
            )}
          </Panel>

          {canSeePayments && (
            <Panel
              icon={<Receipt />}
              tone="violet"
              title="Payments"
              description="Payments are confirmed by PayMongo, never by this page."
              aside={o.recentPayments.length > 0 ? <InfoChip>{o.recentPayments.length} payments</InfoChip> : undefined}
              flush
              footer={
                o.recentPayments.length > 6 && (
                  <Button variant="ghost" size="sm" className="w-full sm:w-auto" onClick={() => setShowAllPayments((v) => !v)} aria-expanded={showAllPayments}>
                    {showAllPayments ? "Show fewer payments" : `Show all ${o.recentPayments.length} payments`}
                  </Button>
                )
              }
            >
              {o.recentPayments.length ? (
                <ul className="divide-y divide-line border-t border-line">
                  {payments.map((p) => (
                    <li key={p.id} className="management-row flex flex-wrap items-center gap-x-3.5 gap-y-2.5 px-5 py-3.5 sm:px-6">
                      <div className="flex min-w-0 flex-1 basis-56 items-center gap-3.5">
                        <IconTile icon={<Receipt />} tone={PAYMENT_TONE[p.status] === "success" ? "success" : "neutral"} size="sm" />
                        <div className="min-w-0 flex-1">
                          <p className="break-words text-[14px] font-medium leading-snug text-ink">{p.description}</p>
                          <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted">
                            <InfoChip className="font-mono text-[12px]">{p.referenceNumber}</InfoChip>
                            <time dateTime={p.paidAt ?? p.createdAt}>{formatDateTime(p.paidAt ?? p.createdAt, timeZone)}</time>
                          </p>
                        </div>
                      </div>
                      <div className="ml-auto flex shrink-0 items-center gap-2.5">
                        <strong className="text-[14px] font-semibold tabular-nums text-ink">{formatUsd(p.usdMicros)}</strong>
                        <StatusPill tone={PAYMENT_TONE[p.status] ?? "neutral"}>{sentenceCase(p.status)}</StatusPill>
                        {p.checkoutUrl && (
                          <ButtonLink href={p.checkoutUrl} variant="soft" size="sm" rel="noopener noreferrer">
                            Continue <ArrowUpRight className="size-3.5" aria-hidden />
                          </ButtonLink>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState compact icon={<Receipt className="size-5" />} title="No payments yet" description="Payments you make appear here once PayMongo confirms them." className="border-t border-line" />
              )}
            </Panel>
          )}
        </div>

        <div className="min-w-0 space-y-6">
          <SpendingControls overview={o} canConfigure={canConfigure} />

          <Panel icon={<ShieldCheck />} title="How you're charged" description="No monthly platform fee. You pay once for setup, then only for what you use." bodyClassName="space-y-4">
            <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
              <ChargeRow icon={<Landmark />} title="Setup" aside={<><strong className="text-[14px] font-semibold tabular-nums text-ink">{legacy.setupFeeLabel}</strong><StatusPill tone={statusToneFor(legacy.setupStatus)}>{setupCopy.label}</StatusPill></>}>
                One time, paid once.
              </ChargeRow>
              <ChargeRow icon={<Percent />} title="Usage" aside={<InfoChip>Cost + {((o.rates.markupBps - 10000) / 100).toFixed(0)}%</InfoChip>}>
                The provider&apos;s wholesale cost plus {((o.rates.markupBps - 10000) / 100).toFixed(0)}% (rate v{o.rates.version}). Fixed provider fees, taxes and payment processing charges are never marked up.
              </ChargeRow>
              <ChargeRow icon={<Coins />} title="Credits">
                Credits are prepaid, non-transferable service credits, not a cash balance. They are used only for the services above.
              </ChargeRow>
              <ChargeRow icon={<Sparkles />} title="Optional">
                <Link href="/maintenance" className="font-medium text-primary hover:underline">Managed maintenance</Link> and <Link href="/add-ons" className="font-medium text-primary hover:underline">custom projects</Link> are separate and always your choice.
              </ChargeRow>
            </ul>
            {o.rates.unitRates.length > 0 ? (
              <div className="overflow-hidden rounded-2xl border border-line">
                <table className="w-full text-left text-[14px]">
                  <caption className="sr-only">Published unit rates</caption>
                  <thead className="bg-surface-2 text-[12px] uppercase tracking-[.08em] text-muted">
                    <tr>
                      <th scope="col" className="px-4 py-2.5 font-semibold">Unit</th>
                      <th scope="col" className="px-4 py-2.5 text-right font-semibold">Your rate</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {o.rates.unitRates.map((r) => (
                      <tr key={`${r.provider}-${r.unitType}`} className="transition-colors hover:bg-surface-2/60">
                        <td className="px-4 py-2.5 text-ink-2">{r.unitLabel}</td>
                        <td className="px-4 py-2.5 text-right font-medium tabular-nums text-ink">{formatUsd(r.clientMicrosPerUnit, { precise: true })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Notice tone="neutral" icon={<Receipt />}>
                Per-unit rates are published once iAcquire has measured real provider costs. Until then each usage line above shows exactly what was charged.
              </Notice>
            )}
            <Notice tone="neutral" icon={<RotateCcw />} title="Auto-recharge is off">
              {o.autoRecharge.reason}
            </Notice>
          </Panel>

          <ProviderFees fees={o.providerFees} isOwner={isOwner} />

          <Panel icon={<FileText />} title="Setup invoice & terms" description="Shared by the iAcquire team when available." bodyClassName="space-y-4">
            <div className="flex flex-wrap gap-2">
              <StatusPill tone={setupCopy.cleared ? "success" : "warning"}>Setup: {setupCopy.label}</StatusPill>
              <StatusPill tone={legacy.activation === "active" ? "success" : legacy.activation === "suspended" ? "danger" : "neutral"}>Activation: {sentenceCase(legacy.activation)}</StatusPill>
            </div>
            <p role="status" className="text-[13px] leading-relaxed text-muted">{setupCopy.detail}</p>
            <div className="flex flex-wrap gap-2">
              {legacy.invoiceUrl ? (
                <ButtonLink href={legacy.invoiceUrl} target="_blank" rel="noopener noreferrer" variant="secondary" size="sm">
                  <FileText className="size-3.5" aria-hidden /> Setup invoice
                </ButtonLink>
              ) : (
                <InfoChip icon={<FileText aria-hidden />}>No invoice shared yet</InfoChip>
              )}
              {legacy.receiptUrl && (
                <ButtonLink href={legacy.receiptUrl} target="_blank" rel="noopener noreferrer" variant="secondary" size="sm">
                  <Receipt className="size-3.5" aria-hidden /> Payment receipt
                </ButtonLink>
              )}
            </div>
            {legacy.serviceTerms && (
              <div className="rounded-2xl border border-line bg-surface-2/50 p-4">
                <p className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[.08em] text-muted">
                  <ScrollText className="size-3.5" aria-hidden /> Service terms
                </p>
                <p className="mt-2 whitespace-pre-wrap text-[14px] leading-relaxed text-ink-2">{legacy.serviceTerms}</p>
              </div>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

const statusToneFor = (s: string): StatusTone => (s === "paid" || s === "waived" ? "success" : s === "pending" ? "warning" : "neutral");

function ChargeRow({ icon, title, aside, children }: { icon: React.ReactNode; title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3.5 px-4 py-3.5">
      <IconTile icon={icon} tone="primary" size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
          <p className="text-[14px] font-semibold text-ink">{title}</p>
          {aside && <span className="flex shrink-0 items-center gap-2">{aside}</span>}
        </div>
        <p className="mt-1 text-[13px] leading-relaxed text-muted">{children}</p>
      </div>
    </li>
  );
}

function HeroNotice({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <p role="status" className="mt-4 flex items-start gap-2.5 rounded-2xl bg-[var(--control-room-raised)] p-3.5 text-[14px] leading-relaxed ring-1 ring-inset ring-current/15 [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0">
      {icon}
      <span>{children}</span>
    </p>
  );
}

function HeroStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-2xl bg-[var(--control-room-raised)]/70 p-3 ring-1 ring-inset ring-current/10">
      <dt className="hero-description text-[12px]">{label}</dt>
      <dd className="mt-1 truncate text-[15px] font-semibold tabular-nums sm:text-[16px]">{value}</dd>
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
    <div className="min-w-0 self-start rounded-2xl bg-[var(--control-room-raised)] p-5 ring-1 ring-inset ring-current/15">
      <div className="flex items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-[var(--control-room)] ring-1 ring-inset ring-current/15" aria-hidden>
          <Plus className="size-4" />
        </span>
        <div className="min-w-0">
          <h2 className="text-[14px] font-semibold">Add service credits</h2>
          <p className="hero-description mt-0.5 text-[13px] leading-relaxed">You&apos;ll pay on PayMongo&apos;s secure page. Credits are added after PayMongo confirms the payment.</p>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2">
        {presets.map((amount) => (
          <button key={amount} type="button" disabled={!enabled || busy !== null} onClick={() => go(amount, amount)} className="min-h-12 rounded-xl bg-[var(--control-room)] text-[15px] font-semibold tabular-nums ring-1 ring-inset ring-current/15 transition hover:ring-primary disabled:cursor-not-allowed disabled:opacity-50">
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
        <input id="custom-topup" inputMode="numeric" pattern="[0-9]*" placeholder={`Custom, $${min}–$${max}`} value={custom} disabled={!enabled || busy !== null} onChange={(event) => setCustom(event.target.value.replace(/[^0-9]/g, ""))} className="h-11 min-w-0 flex-1 rounded-xl bg-[var(--control-room)] px-3 text-[14px] ring-1 ring-inset ring-current/15 outline-none transition placeholder:text-current/50 focus:ring-2 focus:ring-primary disabled:opacity-50" />
        <Button type="submit" variant="brand" disabled={!enabled || !customValid || busy !== null} loading={busy === "custom"}>Add</Button>
      </form>
      {!enabled && blockedReason && (
        <p role="status" className="mt-3 flex items-start gap-2 text-[13px] leading-relaxed">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          {blockedReason}
        </p>
      )}
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
  const budgetTone: StatusTone = pct >= 100 ? "danger" : pct >= b.warnAtPercent ? "warning" : "success";
  return (
    <Panel
      icon={<BadgeCheck />}
      title="Spending limits"
      description="Keep automated spending inside a budget you set."
      bodyClassName="space-y-4"
      footer={
        canConfigure ? (
          <div className="flex justify-end">
            <Button onClick={save} loading={saving}>Save limits</Button>
          </div>
        ) : (
          <p className="flex items-center gap-2 text-[13px] text-muted">
            <ShieldCheck className="size-4 shrink-0" aria-hidden /> Only owners and managers can change spending limits.
          </p>
        )
      }
    >
      {b.monthlyBudgetMicros ? (
        <div className="rounded-2xl border border-line bg-surface-2/50 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[14px] text-muted">
              <span className="text-[18px] font-semibold tracking-tight text-ink tabular-nums">{formatUsd(b.monthSpendMicros)}</span> of {formatUsd(b.monthlyBudgetMicros)}
            </p>
            <StatusPill tone={budgetTone} size="sm">{Math.round(pct)}% used</StatusPill>
          </div>
          <ProgressBar className="mt-3" value={pct} tone={pct >= 100 ? "danger" : pct >= b.warnAtPercent ? "warning" : "primary"} label="Monthly budget used" />
        </div>
      ) : (
        <Notice tone="neutral" icon={<Wallet />} title="No monthly limit is set">
          Spending is still capped by your credit balance.
        </Notice>
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
      <SettingRow as="label" icon={<Minus />} tone={hardStop ? "primary" : "neutral"} title="Stop chargeable work at the limit" description="Recommended. Messages and follow-ups pause until you raise the limit.">
        <Switch checked={hardStop} disabled={!canConfigure} onCheckedChange={setHardStop} aria-label="Stop chargeable work at the monthly limit" />
      </SettingRow>
    </Panel>
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
    <Panel icon={<Landmark />} tone="warning" title="Provider fees" description="Fixed charges from providers, billed at cost and shown separately from usage." flush>
      {fees.length ? (
        <ul className="divide-y divide-line border-t border-line">
          {fees.map((f) => (
            <li key={f.id} className="management-row flex flex-wrap items-center gap-x-3 gap-y-2.5 px-5 py-3.5 sm:px-6">
              <div className="min-w-0 flex-1 basis-48">
                <p className="break-words text-[14px] font-medium leading-snug text-ink">{f.description}</p>
                <p className="mt-1.5 flex flex-wrap gap-1.5">
                  <InfoChip>{providerLabel(f.provider)}</InfoChip>
                  <InfoChip>{sentenceCase(f.recurrence)}</InfoChip>
                </p>
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-2.5">
                <strong className="text-[14px] font-semibold tabular-nums text-ink">{formatUsd(f.amountMicros)}</strong>
                {f.status === "disclosed" ? (
                  isOwner ? (
                    <Button size="sm" variant="soft" loading={busy === f.id} onClick={() => approve(f.id)}>Approve</Button>
                  ) : (
                    <StatusPill tone="warning">Awaiting owner</StatusPill>
                  )
                ) : (
                  <StatusPill tone={f.status === "billed" || f.status === "approved" ? "success" : "neutral"}>{sentenceCase(f.status)}</StatusPill>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState compact icon={<Landmark className="size-5" />} title="No provider fees" description="Anything such as a number rental or sender registration is disclosed here and needs your approval before it's billed." className="border-t border-line" />
      )}
    </Panel>
  );
}
