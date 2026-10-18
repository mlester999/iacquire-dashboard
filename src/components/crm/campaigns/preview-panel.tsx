"use client";

import * as React from "react";
import { AlertTriangle, BadgeDollarSign, Clock, Loader2, ShieldAlert, Users } from "lucide-react";
import { Card } from "@/components/ui/primitives";
import { CHANNEL_LABELS, type Channel } from "@/lib/messaging";
import { cn } from "@/lib/utils";
import type { CampaignPreview } from "@/server/crm/campaigns";
import { money, reasonLabel } from "@/components/crm/campaigns/parts";

const n = (v: number) => v.toLocaleString("en-US");

/** How long sending everyone takes at the pace, roughly (the dispatcher and quiet hours can make it longer, never shorter). */
function paceText(eligible: number, rate: number): string {
  if (!eligible) return `At most ${n(rate)} a minute.`;
  const minutes = Math.ceil(eligible / rate);
  const span = minutes < 2 ? "about a minute" : minutes < 90 ? `about ${minutes} minutes` : `about ${Math.round(minutes / 60)} hours`;
  return `At most ${n(rate)} a minute: ${span} for everyone it reaches now, longer if quiet hours or business hours pause it.`;
}

/**
 * The live preview: who on the list it reaches right now, who is left out and why (counts only), what it costs at the published rate, and
 * the rules every message is held to. Problems stop approval; warnings don't.
 */
export function PreviewPanel({ preview, channel, ratePerMinute, loading, error }: { preview: CampaignPreview | null; channel: Channel; ratePerMinute: number; loading?: boolean; error?: string | null }) {
  const label = CHANNEL_LABELS[channel];
  if (!preview) {
    return (
      <Card className="p-5">
        <p className="flex items-center gap-2 text-[13px] text-muted">{loading ? <><Loader2 className="size-4 animate-spin" aria-hidden />Working out who it reaches…</> : error ?? "Choose a Smart List and a message to see who it reaches."}</p>
      </Card>
    );
  }
  const excludedTotal = preview.exclusions.reduce((s, e) => s + e.count, 0);
  const total = preview.list?.total ?? 0;
  const est = preview.estimate;
  return (
    <div className="space-y-3" aria-busy={loading || undefined}>
      <div aria-live="polite" className="sr-only">{loading ? "Updating the preview" : preview.eligible !== null ? `${n(preview.eligible)} people can receive it now` : ""}</div>
      {error && <p className="rounded-xl bg-danger-soft px-3 py-2 text-[12.5px] text-danger-ink" role="alert">{error}</p>}

      <Card className="p-4">
        <h3 className="flex items-center gap-2 text-[13.5px] font-semibold text-ink"><Users className="size-4 text-muted" aria-hidden />Who it reaches{loading && <Loader2 className="ml-auto size-3.5 animate-spin text-muted" aria-label="Updating" />}</h3>
        {preview.list ? (
          <>
            <p className="mt-2 text-[28px] font-semibold leading-none tracking-[-0.03em] tabular-nums text-ink">{n(preview.eligible ?? 0)}</p>
            <p className="mt-1 text-[12.5px] text-muted">of {n(total)} {total === 1 ? "person" : "people"} on “{preview.list.name}” can receive it right now.</p>
            {excludedTotal > 0 && (
              <div className="mt-3">
                <p className="text-[12px] font-semibold uppercase tracking-wider text-faint">Left out ({n(excludedTotal)})</p>
                <ul className="mt-1.5 space-y-1.5">
                  {preview.exclusions.map((e) => (
                    <li key={e.reason} className="text-[12.5px]">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-ink-2">{reasonLabel(e.reason, channel)}</span>
                        <span className="tabular-nums text-muted">{n(e.count)}</span>
                      </div>
                      <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-surface-3" aria-hidden><div className="h-full rounded-full bg-ink/25" style={{ width: `${total ? Math.max(2, (e.count / total) * 100) : 0}%` }} /></div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="mt-3 text-[12px] leading-relaxed text-muted">
              Campaigns only reach people who agreed to receive marketing by {label}. Consent, opt-outs and addresses are checked again for each person when their message is queued, and once more right before it&apos;s sent. Counts only: nobody is listed here.
            </p>
          </>
        ) : (
          <p className="mt-2 text-[12.5px] text-muted">Choose a Smart List to see who it reaches.</p>
        )}
      </Card>

      <Card className="p-4">
        <h3 className="flex items-center gap-2 text-[13.5px] font-semibold text-ink"><BadgeDollarSign className="size-4 text-muted" aria-hidden />Estimated cost</h3>
        {est ? (
          est.rate ? (
            <>
              <p className="mt-2 text-[22px] font-semibold tabular-nums text-ink">{money(est.costMicros)}</p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
                {n(est.units)} {est.unitLabel.toLowerCase()} at {money(est.rate.clientMicrosPerUnit)} each, the rate iAcquire published for {est.providerLabel} (rate v{est.rate.version}).
                {est.unit === "sms_segment" && ` About ${est.unitsPerMessage} segment${est.unitsPerMessage === 1 ? "" : "s"} per text with sample details; real names can change it.`}
              </p>
            </>
          ) : (
            <>
              <p className="mt-2 text-[15px] font-semibold text-ink">Price not published</p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-muted">iAcquire hasn&apos;t published a rate for {est.unitLabel.toLowerCase()} through {est.providerLabel}, so there is no estimate and nothing can be sent until there is.</p>
            </>
          )
        ) : (
          <p className="mt-2 text-[12.5px] text-muted">Shown once the list and message are chosen.</p>
        )}
        {preview.credits && preview.credits.status !== "unknown" && (
          <p className={cn("mt-2 rounded-xl px-3 py-2 text-[12.5px]", preview.credits.status === "enough" ? "bg-success-soft text-success-ink" : "bg-warning-soft text-warning-ink")}>
            {preview.credits.status === "enough"
              ? `Your service credits cover it${preview.credits.availableMicros !== null ? ` (${money(preview.credits.availableMicros)} available)` : ""}.`
              : preview.credits.status === "short"
                ? `Not enough service credits for everyone${preview.credits.shortByMicros !== null ? `: about ${money(preview.credits.shortByMicros)} short` : ""}. It stops when credits run out.`
                : `It would pass the monthly spending limit${preview.credits.budgetLimitMicros !== null ? ` of ${money(preview.credits.budgetLimitMicros)}` : ""}, so it would stop partway.`}
          </p>
        )}
      </Card>

      <Card className="p-4">
        <h3 className="flex items-center gap-2 text-[13.5px] font-semibold text-ink"><Clock className="size-4 text-muted" aria-hidden />When and how it sends</h3>
        <ul className="mt-2 space-y-1.5 text-[12.5px] leading-relaxed text-ink-2">
          <li><span className="text-muted">Starts: </span>{preview.schedule.label}</li>
          <li><span className="text-muted">Pace: </span>{paceText(preview.eligible ?? 0, ratePerMinute)}</li>
          <li>
            <span className="text-muted">Quiet hours: </span>
            {preview.policy.quietStart === preview.policy.quietEnd ? "none set" : `nothing is sent between ${preview.policy.quietStart} and ${preview.policy.quietEnd} in each person's time zone`}
            {preview.policy.businessHoursSet ? ", and only during your business hours." : "."}
          </li>
          <li><span className="text-muted">Frequency: </span>each person gets at most {preview.policy.maxPerContact30d} program or campaign messages in 30 days, at least {preview.policy.minHoursBetween} hours apart.</li>
          <li>
            <span className="text-muted">Opting out: </span>
            {channel === "email" ? "every email carries a one-click unsubscribe link and header." : channel === "sms" ? "the text tells people to reply STOP; a STOP reply opts them out at once." : "people can opt out by replying STOP; WhatsApp sends the Meta-approved template’s wording."}
          </li>
        </ul>
      </Card>

      {preview.problems.length > 0 && (
        <div className="rounded-2xl border border-danger/25 bg-danger-soft p-3" role="status">
          <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-danger-ink"><ShieldAlert className="size-4" aria-hidden />Before it can be approved</p>
          <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[12.5px] leading-relaxed text-danger-ink">{preview.problems.map((p) => <li key={p}>{p}</li>)}</ul>
        </div>
      )}
      {preview.warnings.length > 0 && (
        <div className="rounded-2xl border border-warning/30 bg-warning-soft p-3">
          <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-warning-ink"><AlertTriangle className="size-4" aria-hidden />Worth knowing</p>
          <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[12.5px] leading-relaxed text-warning-ink">{preview.warnings.map((p) => <li key={p}>{p}</li>)}</ul>
        </div>
      )}
    </div>
  );
}
