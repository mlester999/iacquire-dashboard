"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, CircleDashed, ExternalLink, Landmark, Loader2, PlugZap, ShieldAlert, ShieldCheck } from "lucide-react";
import { checkPaymentProviderAction } from "@/app/(admin)/admin/finance-actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/primitives";
import { StatusPill } from "@/components/ui/status";
import { CopyTextButton } from "@/components/ui/copy-button";
import { BILLING_SETTING_NOTES, MODE_LABEL, MODE_NOTE, VERCEL_STEPS, type Mode } from "@/lib/payment-providers/readiness";
import type { PaymentHealth, ProviderHealth } from "@/server/billing/provider-health";
import { formatDateTime } from "@/lib/utils";

// Billing, Payment providers: where a Super Admin sees whether PayMongo and PayPal can take a payment, and what to do next. It shows facts the server checked (a setting is "set" or
// "missing", never its value) and offers one action, "Check connection", a read-only call that charges nothing. There is deliberately no field for a key: keys live in Vercel's
// environment, which this page names variable by variable. It is a view of the server's answer, so the buyer's checkout and the Purchase intents screen say the same thing.

const MODE_PILL: Record<Mode, "primary" | "warning"> = { test: "primary", live: "warning" };

function CheckResult({ health }: { health: ProviderHealth }) {
  const c = health.check;
  if (!c) return <p className="text-[13px] leading-relaxed text-muted">The connection has not been checked yet.</p>;
  return (
    <div className="space-y-1">
      <p className="flex flex-wrap items-center gap-2 text-[14px] text-ink">
        {c.ok && !c.stale ? <CheckCircle2 className="size-4 shrink-0 text-success-ink" aria-hidden /> : <AlertTriangle className="size-4 shrink-0 text-warning-ink" aria-hidden />}
        <span className="font-medium">{c.stale ? "Checked before the configuration changed" : c.ok ? "Connection verified" : "Check did not pass"}</span>
        <span className="text-[12px] text-muted">{formatDateTime(c.at, "UTC")} UTC · {MODE_LABEL[c.mode].toLowerCase()}</span>
      </p>
      <p className="text-[13px] leading-relaxed text-ink-2">{c.stale ? "A key, the mode, a payment method or the webhook setting changed since, so this result no longer counts. Run the check again." : c.text}</p>
      {c.eventsMissing.length > 0 && <p className="text-[13px] leading-relaxed text-warning-ink">The webhook is missing: {c.eventsMissing.join(", ")}.</p>}
      {c.message && <p className="text-[12px] leading-relaxed text-muted">{c.message}</p>}
    </div>
  );
}

function ProviderCard({ health, canManage }: { health: ProviderHealth; canManage: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [announce, setAnnounce] = React.useState<string | null>(null);
  const r = health.readiness;
  const run = async () => {
    setBusy(true);
    setAnnounce(null);
    try {
      const res = await checkPaymentProviderAction(health.provider);
      if (!res.ok) {
        toast.error(res.error);
        setAnnounce(res.error);
        return;
      }
      setAnnounce(res.data.text);
      toast[res.data.outcome === "verified" ? "success" : "error"](res.data.outcome === "verified" ? "Connection verified." : res.data.text);
      router.refresh();
    } catch {
      toast.error("The check could not be run. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const headingId = `provider-${health.provider}`;
  return (
    <Card role="region" aria-labelledby={headingId}>
      <CardHeader>
        <div className="w-full">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <span className={`flex size-9 shrink-0 items-center justify-center rounded-xl ${r.tone === "success" ? "bg-success-soft text-success-ink" : r.tone === "warning" ? "bg-warning-soft text-warning-ink" : "bg-surface-2 text-ink-2"}`}><Landmark className="size-4" aria-hidden /></span>
            <div className="min-w-0">
              <h2 id={headingId} className="text-[16px] font-semibold tracking-tight text-ink">{health.label}</h2>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <StatusPill tone={r.tone}>{r.label}</StatusPill>
                {health.mode && <StatusPill tone={MODE_PILL[health.mode]} dot={false}>{MODE_LABEL[health.mode]}</StatusPill>}
              </div>
            </div>
          </div>
          {canManage && (
            <Button type="button" variant="secondary" onClick={() => void run()} disabled={busy} aria-describedby={`${headingId}-check`}>
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <PlugZap className="size-4" aria-hidden />}
              {busy ? "Checking…" : "Check connection"}
            </Button>
          )}
        </div>
        <p className="mt-3 text-[14px] leading-relaxed text-muted">{r.next}</p>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {health.mode && (
          <p className={`rounded-xl px-3.5 py-2.5 text-[13px] leading-relaxed ${health.mode === "live" ? "bg-warning-soft text-warning-ink" : "bg-surface-2 text-ink-2"}`}>
            {health.mode === "live" ? <ShieldAlert className="mr-1.5 inline size-4 align-text-bottom" aria-hidden /> : <ShieldCheck className="mr-1.5 inline size-4 align-text-bottom" aria-hidden />}
            {MODE_NOTE[health.mode]}
          </p>
        )}

        <div id={`${headingId}-check`} aria-live="polite" className="rounded-xl border border-line p-3.5">
          <p className="mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-muted">Connection check</p>
          <CheckResult health={health} />
          {announce && <p className="sr-only">{announce}</p>}
          <p className="mt-2 text-[12px] leading-relaxed text-muted">The check asks {health.label} a read-only question with the saved credentials: nothing is created and nothing is charged.</p>
        </div>

        <section aria-label={`${health.label} settings`}>
          <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted">Settings to add in Vercel</p>
          <ul className="divide-y divide-line rounded-xl border border-line">
            {health.envVars.map((v) => (
              <li key={v.name} className="flex flex-col gap-1 px-3.5 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-[14px] text-ink">
                    <code className="break-all rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[13px]">{v.name}</code>
                    {!v.required && <span className="text-[12px] text-muted">optional</span>}
                    {v.shown && <span className="text-[12px] text-muted">now: {v.shown}</span>}
                  </p>
                  <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{v.label}. {v.note}</p>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-muted">Where: {v.where}</p>
                </div>
                <span className="shrink-0 sm:pt-0.5">
                  <StatusPill tone={v.set ? "success" : v.required ? "warning" : "neutral"} size="sm">{v.set ? "Set" : v.required ? "Missing" : "Not set"}</StatusPill>
                </span>
              </li>
            ))}
            {health.exchangeRate && (
              <li className="flex flex-col gap-1 px-3.5 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                <div className="min-w-0">
                  <p className="text-[14px] font-medium text-ink">USD to PHP exchange rate</p>
                  <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{BILLING_SETTING_NOTES.rate}</p>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-muted">
                    {health.exchangeRate.set ? `PHP ${health.exchangeRate.usdPhpRate} per USD${health.exchangeRate.source ? `, ${health.exchangeRate.source}` : ""}${health.exchangeRate.updatedAt ? `, set ${formatDateTime(health.exchangeRate.updatedAt, "UTC")} UTC` : ""}.` : "No rate is set, so the price cannot be converted for PayMongo."}{" "}
                    <Link href="/admin/billing?tab=rates" className="font-medium text-primary hover:underline">Set it in Rates &amp; payments</Link>
                  </p>
                </div>
                <span className="shrink-0 sm:pt-0.5"><StatusPill tone={health.exchangeRate.set ? "success" : "warning"} size="sm">{health.exchangeRate.set ? "Set" : "Missing"}</StatusPill></span>
              </li>
            )}
          </ul>
          <details className="mt-3 rounded-xl border border-line">
            <summary className="flex min-h-11 cursor-pointer items-center px-3.5 text-[14px] font-medium text-ink">How to add them in Vercel</summary>
            <ol className="list-decimal space-y-1.5 pb-3 pl-9 pr-3.5 text-[13px] leading-relaxed text-ink-2">
              {VERCEL_STEPS.map((s) => <li key={s}>{s}</li>)}
            </ol>
          </details>
        </section>

        <section aria-label={`${health.label} webhook`} className="space-y-3">
          <p className="text-[12px] font-semibold uppercase tracking-wide text-muted">Webhook: how {health.label} tells this site a payment happened</p>
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2">
            <code className="min-w-0 flex-1 break-all text-[12.5px] text-ink">{health.webhook.url}</code>
            <CopyTextButton text={health.webhook.url} label="Copy" />
          </div>
          {!health.webhook.reachableByProvider && (
            <p role="alert" className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning-soft px-3.5 py-2.5 text-[13px] leading-relaxed text-warning-ink">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>This address is not a public https address, so {health.label} cannot call it. Set APP_URL to the live site address (https, a real domain) and redeploy before registering the webhook.</span>
            </p>
          )}
          <p className="text-[13px] leading-relaxed text-ink-2">{health.webhook.where}</p>
          <ul className="space-y-1.5 text-[13px] leading-relaxed text-ink-2">
            {health.webhook.events.map((e) => (
              <li key={e.name} className="flex flex-wrap items-baseline gap-x-2">
                <code className="break-all rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[12.5px]">{e.name}</code>
                <span className="text-[12px] font-medium text-muted">{e.required ? "required" : "recommended"}</span>
                <span className="basis-full text-muted sm:basis-auto">{e.why}</span>
              </li>
            ))}
          </ul>
          <p className="text-[13px] leading-relaxed text-ink-2">{health.webhook.testHow}</p>
          <p className="text-[13px] leading-relaxed text-ink-2">
            {health.webhook.lastNotice
              ? <>Last notice received from {health.label}: <strong className="font-medium text-ink">{health.webhook.lastNotice.type}</strong>, {formatDateTime(health.webhook.lastNotice.at, "UTC")} UTC ({health.webhook.lastNotice.outcome}).</>
              : <>No notice from {health.label} has reached this site yet. That is expected before the first test payment.</>}
            {health.webhook.refusedLast7Days > 0 && <span className="text-warning-ink"> {health.webhook.refusedLast7Days} notice{health.webhook.refusedLast7Days === 1 ? " was" : "s were"} refused in the last 7 days: check the webhook secret.</span>}
          </p>
        </section>

        {!health.available && health.blockedReason && (
          <p role="status" className="flex items-start gap-2 rounded-xl bg-surface-2 px-3.5 py-2.5 text-[13px] leading-relaxed text-ink-2">
            <CircleDashed className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
            <span><strong className="font-medium text-ink">Buyers are not offered {health.label}.</strong> {health.blockedReason}</span>
          </p>
        )}
        <a href={health.docsUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-8 items-center gap-1.5 text-[13px] font-medium text-primary hover:underline">
          {health.label}&apos;s own guide <ExternalLink className="size-3.5" aria-hidden />
        </a>
      </CardContent>
    </Card>
  );
}

export function PaymentProvidersPanel({ health, canManage }: { health: PaymentHealth; canManage: boolean }) {
  const c = health.checkout;
  return (
    <div className="space-y-5">
      <Card role="region" aria-labelledby="checkout-summary">
        <CardHeader>
          <div className="flex w-full flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 id="checkout-summary" className="text-[16px] font-semibold tracking-tight text-ink">Online checkout for purchases</h2>
              <p className="mt-1.5 text-[14px] leading-relaxed text-muted">{c.headline}</p>
            </div>
            <StatusPill tone={c.state === "open_live" ? "warning" : c.state === "open_test" ? "success" : c.state === "blocked" ? "warning" : "neutral"}>
              {c.state === "off" ? "Off" : c.state === "blocked" ? "On, but blocked" : c.state === "open_live" ? "Open (live)" : "Open (test mode)"}
            </StatusPill>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 text-[13px] leading-relaxed text-ink-2">
          <p>
            Real-money checkout needs three things: a provider that passed its connection check with live credentials, the payment and tax review confirmed
            {health.liveReviewConfirmedAt ? ` (confirmed ${formatDateTime(health.liveReviewConfirmedAt, "UTC")} UTC)` : " (not confirmed yet)"}, and online checkout switched on in{" "}
            <Link href="/admin/purchase-intents" className="font-medium text-primary hover:underline">Purchase intents</Link>.
          </p>
          <p className="text-muted">{BILLING_SETTING_NOTES.review}</p>
          <p className="text-muted">
            Webhook addresses are built from this site&apos;s address ({health.site.url}).
            {!health.site.publicHttps && " It is not a public https address, so a provider cannot call it yet."}
          </p>
        </CardContent>
      </Card>
      {health.providers.map((p) => <ProviderCard key={p.provider} health={p} canManage={canManage} />)}
    </div>
  );
}
