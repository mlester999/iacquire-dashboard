"use client";

import * as React from "react";
import { AlertTriangle, CheckCircle2, Circle, Loader2 } from "lucide-react";
import { Badge, ProgressBar } from "@/components/ui/primitives";
import { cn, formatTime } from "@/lib/utils";
import { WIZARD_STEPS, type WizardStepKey } from "@/lib/crm/provider-switch";
import type { SwitchPreview, SwitchStepView, SwitchVerification } from "@/server/crm/provider-switch";
import { RelativeTime } from "@/components/crm/relative-time";

// Presentational pieces of the Settings → CRM Provider wizard. Every number comes from the server; nothing here estimates.

export const num = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v.toLocaleString("en-US"));
export const ownerName = (p: "native" | "ghl") => (p === "native" ? "iAcquire" : "GoHighLevel");

const JOB_STATUS: Record<string, { label: string; tone: "neutral" | "primary" | "success" | "warning" | "danger" }> = {
  fetching: { label: "Reading GoHighLevel", tone: "primary" },
  validating: { label: "Dry run", tone: "primary" },
  validated: { label: "Checked", tone: "primary" },
  importing: { label: "Importing", tone: "primary" },
  completed: { label: "Imported", tone: "success" },
  failed: { label: "Stopped", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  rolling_back: { label: "Undoing", tone: "warning" },
  rolled_back: { label: "Undone", tone: "neutral" },
};

export function OwnerBadge({ owner }: { owner: "native" | "ghl" }) {
  return owner === "native" ? <Badge tone="primary">iAcquire</Badge> : <Badge tone="warning">GoHighLevel</Badge>;
}

/** The wizard's seven steps, with the current one marked (aria-current) and the finished ones checked. */
export function Stepper({ current }: { current: WizardStepKey }) {
  const at = WIZARD_STEPS.findIndex((s) => s.key === current);
  return (
    <ol aria-label="Switch steps" className="grid grid-cols-2 gap-1.5 sm:grid-cols-4 lg:grid-cols-7">
      {WIZARD_STEPS.map((s, i) => {
        const done = i < at;
        const now = i === at;
        return (
          <li key={s.key} aria-current={now ? "step" : undefined}
            className={cn("flex min-h-11 items-center gap-2 rounded-xl border px-2.5 py-1.5 text-[12.5px] sm:min-h-9", now ? "border-primary/40 bg-primary-soft font-medium text-primary-ink" : done ? "border-line bg-surface text-ink-2" : "border-line bg-surface-2/40 text-muted")}>
            {done ? <CheckCircle2 className="size-3.5 shrink-0 text-success-ink" aria-hidden /> : <Circle className={cn("size-3.5 shrink-0", now ? "text-primary" : "text-faint")} aria-hidden />}
            <span className="tabular-nums">{i + 1}.</span>
            <span className="truncate">{s.label}</span>
            {done && <span className="sr-only">(done)</span>}
          </li>
        );
      })}
    </ol>
  );
}

/** Per capability: who owns it now and after, what each side holds, and what depends on it. */
export function PreviewTable({ preview }: { preview: SwitchPreview }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-line">
      <table className="w-full min-w-[760px] text-[13px]">
        <caption className="sr-only">What changes for each capability</caption>
        <thead className="border-b border-line bg-surface-2/60 text-[12px] text-muted">
          <tr>
            <th scope="col" className="px-3 py-2 text-left font-medium">Capability</th>
            <th scope="col" className="px-3 py-2 text-left font-medium">Owner now → after</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">In iAcquire</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">In GoHighLevel</th>
            <th scope="col" className="px-3 py-2 text-left font-medium">Depends on it</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {preview.capabilities.map((c) => (
            <tr key={c.capability} className={cn(!c.moves && "text-muted")}>
              <th scope="row" className="px-3 py-2 text-left font-medium text-ink">
                {c.label}
                {c.notes.map((n) => <span key={n} className="mt-0.5 block text-[12px] font-normal text-muted">{n}</span>)}
              </th>
              <td className="whitespace-nowrap px-3 py-2">
                {c.moves ? <span className="inline-flex items-center gap-1.5"><OwnerBadge owner={c.from} />→<OwnerBadge owner={c.to} /></span> : <span className="inline-flex items-center gap-1.5"><OwnerBadge owner={c.from} /><span className="text-[12px]">stays</span></span>}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{c.native ? `${num(c.native.count)} ${c.native.noun}` : "—"}</td>
              <td className="px-3 py-2 text-right tabular-nums">
                {c.ghl ? (c.ghl.status === "ok" ? `${c.ghl.countKind === "at_least" ? "at least " : ""}${num(c.ghl.count)}` : <span className="text-warning-ink">{c.ghl.status === "forbidden" ? "No access" : "Couldn't read"}</span>) : <span className="text-faint">not read</span>}
              </td>
              <td className="px-3 py-2 text-[12px] text-ink-2">{c.dependencies.length ? c.dependencies.map((d) => `${d.label}: ${num(d.count)}`).join(" · ") : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The earliest time a switch's steps were read from GoHighLevel (what the import holds is GoHighLevel as of then), or null. */
export function readTimeOf(steps: Array<{ fetchedAt?: string | null; readAt?: string | null }>): string | null {
  const times = steps.map((s) => s.fetchedAt ?? s.readAt ?? null).filter((t): t is string => !!t).sort();
  return times[0] ?? null;
}

/** The migration steps of a switch, with live progress. */
export function StepsTable({ steps, timezone, onRetry, retry, busy, readRest = [], onReadRest }: {
  steps: SwitchStepView[];
  timezone: string;
  onRetry?: (entity: SwitchStepView["entity"]) => void;
  retry: string[];
  busy?: (key: string) => boolean;
  /** Imported steps whose rest can be read from GoHighLevel (what was created there after the read). */
  readRest?: string[];
  onReadRest?: (entity: SwitchStepView["entity"]) => void;
}) {
  if (!steps.length) return <p className="rounded-xl border border-dashed border-line px-3 py-3 text-[13px] text-ink-2">Nothing is imported in this switch: it moves ownership only.</p>;
  return (
    <div className="overflow-x-auto rounded-xl border border-line">
      <table className="w-full min-w-[720px] text-[13px]">
        <caption className="sr-only">Migration steps</caption>
        <thead className="border-b border-line bg-surface-2/60 text-[12px] text-muted">
          <tr>
            <th scope="col" className="px-3 py-2 text-left font-medium">Step</th>
            <th scope="col" className="px-3 py-2 text-left font-medium">Status</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Read</th>
            <th scope="col" className="px-3 py-2 text-left font-medium">Dry run / result</th>
            <th scope="col" className="px-3 py-2 text-right font-medium"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {steps.map((s) => {
            const st = s.status ? JOB_STATUS[s.status] ?? { label: s.status, tone: "neutral" as const } : { label: "Not started", tone: "neutral" as const };
            const pct = s.progress && s.progress.total ? Math.round((s.progress.done / s.progress.total) * 100) : null;
            const imported = s.outcome.created + s.outcome.updated;
            return (
              <tr key={s.entity}>
                <th scope="row" className="px-3 py-2 text-left font-medium text-ink">{s.label}</th>
                <td className="px-3 py-2">
                  <Badge tone={st.tone}>{["fetching", "validating", "importing", "rolling_back"].includes(s.status ?? "") && <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />}{st.label}</Badge>
                  {s.progress && <div className="mt-1.5 w-40"><ProgressBar value={pct ?? 0} label={`${s.label}: ${num(s.progress.done)} of ${num(s.progress.total)}`} /><span className="text-[12px] text-muted">{num(s.progress.done)} of {num(s.progress.total)}</span></div>}
                  {s.waitingUntil && <span className="mt-1 block text-[12px] text-muted">Waiting for GoHighLevel until {formatTime(s.waitingUntil, timezone)}</span>}
                  {s.error && <span className="mt-1 block text-[12px] text-danger-ink">{s.error}</span>}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {num(s.totalRows)}{s.sourceTotal !== null && <span className="block text-[12px] text-muted">of {num(s.sourceTotal)}</span>}
                  {s.fetchedAt && <span className={cn("block text-[12px]", s.stale ? "text-warning-ink" : "text-muted")}>read <RelativeTime iso={s.fetchedAt} timezone={timezone} />{s.stale ? " (too old to cut over)" : ""}</span>}
                </td>
                <td className="px-3 py-2 text-[12px] text-ink-2">
                  {s.status === "completed" || s.status === "rolled_back" || s.status === "rolling_back" || imported > 0
                    ? `${num(s.outcome.created)} added · ${num(s.outcome.updated)} matched · ${num(s.outcome.skipped)} skipped · ${num(s.outcome.needsReview)} for review · ${num(s.outcome.failed)} not imported${s.outcome.rolledBack ? ` · ${num(s.outcome.rolledBack)} undone` : ""}`
                    : s.status === "validated"
                      ? `${num(s.planned.create)} to add · ${num(s.planned.update)} to match · ${num(s.planned.skip)} to skip · ${num(s.planned.review)} for review · ${num(s.planned.invalid)} invalid`
                      : "—"}
                </td>
                <td className="px-3 py-2 text-right">
                  {onRetry && retry.includes(s.entity) && (
                    <button type="button" onClick={() => onRetry(s.entity)} disabled={busy?.(`retry-${s.entity}`)} className="inline-flex min-h-11 items-center rounded-lg border border-line px-2.5 text-[12.5px] font-medium text-ink hover:bg-surface-2 sm:min-h-9">Read again</button>
                  )}
                  {onReadRest && readRest.includes(s.entity) && (
                    <button type="button" onClick={() => onReadRest(s.entity)} disabled={busy?.(`rest-${s.entity}`)} aria-label={`Read the rest of the ${s.label.toLowerCase()} from GoHighLevel`}
                      className="inline-flex min-h-11 items-center rounded-lg border border-line px-2.5 text-[12.5px] font-medium text-ink hover:bg-surface-2 sm:min-h-9">Read the rest</button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The destination check: GoHighLevel's count against what was read and what became of it, plus sample checks. */
export function VerificationTable({ verification, timezone }: { verification: SwitchVerification; timezone?: string }) {
  return (
    <div className="space-y-3">
      {verification.steps.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full min-w-[760px] text-[13px]">
            <caption className="sr-only">Verification per step</caption>
            <thead className="border-b border-line bg-surface-2/60 text-[12px] text-muted">
              <tr>
                <th scope="col" className="px-3 py-2 text-left font-medium">Step</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">In GoHighLevel</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">GoHighLevel now</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Read</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Mapped</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Skipped</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Failed</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">For review</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Now in iAcquire</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Samples OK</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {verification.steps.map((s) => (
                <tr key={s.entity}>
                  <th scope="row" className="px-3 py-2 text-left font-medium text-ink">{s.label}</th>
                  <td className="px-3 py-2 text-right tabular-nums">{s.sourceCountKind === "at_least" ? "at least " : ""}{num(s.sourceCount)}</td>
                  <td className={cn("px-3 py-2 text-right tabular-nums", (s.recount?.more ?? 0) > 0 && "text-warning-ink")}>
                    {!s.recount ? "—" : s.recount.status === "ok" ? `${s.recount.countKind === "at_least" ? "at least " : ""}${num(s.recount.count)}` : <span className="text-warning-ink">Couldn&rsquo;t recount</span>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{num(s.staged)}{s.readAt && <span className="block text-[12px] text-muted"><RelativeTime iso={s.readAt} timezone={timezone} /></span>}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{num(s.mapped)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{num(s.skipped)}</td>
                  <td className={cn("px-3 py-2 text-right tabular-nums", s.failed > 0 && "text-danger-ink")}>{num(s.failed)}</td>
                  <td className={cn("px-3 py-2 text-right tabular-nums", s.needsReview > 0 && "text-warning-ink")}>{num(s.needsReview)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{num(s.destinationCount)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{s.samples.checked ? `${num(s.samples.passed)} of ${num(s.samples.checked)}` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {verification.ok ? (
        <p className="flex items-center gap-2 text-[13px] text-success-ink">
          <CheckCircle2 className="size-4" aria-hidden />
          {verification.steps.length
            ? <>Every record read {readTimeOf(verification.steps) ? <RelativeTime iso={readTimeOf(verification.steps)!} timezone={timezone} /> : "from GoHighLevel"} is accounted for, the samples match, and GoHighLevel held no more when it was recounted.</>
            : "Ownership is exactly what the cutover set; nothing was imported."}
        </p>
      ) : (
        <ul className="space-y-1 rounded-xl border border-warning/30 bg-warning-soft px-3 py-2 text-[13px] text-warning-ink">
          {verification.issues.map((i) => <li key={i} className="flex items-start gap-2"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />{i}</li>)}
        </ul>
      )}
    </div>
  );
}
