"use client";

import * as React from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, Pencil, PlugZap, ShieldCheck, Sparkles, UserRound, Wrench } from "lucide-react";
import { AgentAvatar } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/primitives";
import { InfoChip, StatusPill } from "@/components/ui/status";
import { AGENT_BY_KEY } from "@/lib/agents";
import type { ReviewModel, ReviewRow } from "@/lib/onboarding/engine";
import { cn } from "@/lib/utils";

const HOURS_PART = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/;

/** Renders an answer value: facts joined with " · " or day-hour lists become chips instead of a run of text. */
function AnswerValue({ value }: { value: string }) {
  const lines = value.split("\n").filter(Boolean);
  const hours = value.split("; ");
  if (hours.length >= 2 && hours.every((h) => HOURS_PART.test(h.trim()))) {
    return (
      <span className="flex flex-wrap gap-1.5">
        {hours.map((h) => (
          <InfoChip key={h}>{h.trim()}</InfoChip>
        ))}
      </span>
    );
  }
  if (lines.length > 0 && lines.every((l) => { const p = l.split(" · "); return p.length >= 2 && !p[0].endsWith("?") && p.slice(1).every((x) => x.length <= 48); })) {
    return (
      <span className="flex flex-col gap-2">
        {lines.map((l) => {
          const [head, ...rest] = l.split(" · ");
          return (
            <span key={l} className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-medium text-ink">{head}</span>
              {rest.map((part) => (
                <InfoChip key={part}>{part}</InfoChip>
              ))}
            </span>
          );
        })}
      </span>
    );
  }
  return <>{value}</>;
}

const STATE_BADGE: Record<ReviewRow["state"], { label: string; tone: "neutral" | "warning" | "danger" | "success" } | null> = {
  answered: null,
  skipped: { label: "Skipped", tone: "neutral" },
  needs_confirmation: { label: "Check this", tone: "warning" },
  outstanding: { label: "Needs an answer", tone: "danger" },
};

export function ReviewPanel({
  review,
  loading,
  error,
  confirmed,
  submitting,
  alreadySubmitted,
  onRetry,
  onEdit,
  onConfirmChange,
  onSubmit,
  hideSubmit = false,
}: {
  review: ReviewModel | null;
  loading: boolean;
  error: string | null;
  confirmed: boolean;
  submitting: boolean;
  alreadySubmitted: boolean;
  onRetry: () => void;
  onEdit: (questionId: string) => void;
  onConfirmChange: (value: boolean) => void;
  onSubmit: () => void;
  hideSubmit?: boolean;
}) {
  if (loading && !review) {
    return (
      <div role="status" className="space-y-4" aria-busy="true" aria-label="Preparing your review">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (!review) {
    return (
      <div role="alert" className="rounded-2xl border border-danger/30 bg-danger-soft/50 p-5">
        <p className="text-[14px] font-medium text-danger-ink">{error ?? "We couldn't prepare your review."}</p>
        <Button className="mt-3" variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }

  const blockers = review.blockers.filter((b) => !b.startsWith("Confirm that you approve"));
  return (
    <div className="space-y-6">
      {blockers.length > 0 && (
        <div role="alert" className="rounded-2xl border border-warning/40 bg-warning-soft/60 p-4">
          <p className="flex items-center gap-2 text-[14px] font-semibold text-warning-ink">
            <AlertTriangle className="size-4" aria-hidden /> Before you can approve
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-6 text-[13.5px] text-ink-2">
            {blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </div>
      )}

      <section aria-labelledby="rv-answers" className="space-y-3">
        <h2 id="rv-answers" className="text-[15px] font-semibold">
          Your answers
        </h2>
        {review.sections.map((section) => (
          <details key={section.id} className="group overflow-hidden rounded-2xl border border-line bg-surface" open={section.rows.some((r) => (r.state === "outstanding" && r.required) || r.state === "needs_confirmation")}>
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3.5 text-[14px] font-medium focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary">
              <span className="flex min-w-0 items-center gap-2.5">
                <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-lg bg-primary-soft text-[11px] font-semibold text-primary">{section.id}</span>
                <span className="truncate">{section.title}</span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                {section.rows.some((r) => r.state === "needs_confirmation") && <StatusPill tone="warning" size="sm">Check</StatusPill>}
                <InfoChip className="hidden tabular-nums sm:inline-flex">{section.rows.filter((r) => r.state === "answered").length}/{section.rows.length} answered</InfoChip>
                <ChevronDown className="size-4 text-muted transition-transform group-open:rotate-180" aria-hidden />
              </span>
            </summary>
            <ul className="divide-y divide-line border-t border-line">
              {section.rows.map((row) => {
                // An optional question nobody answered is simply empty, not a problem.
                const badge = row.state === "outstanding" && !row.required ? null : STATE_BADGE[row.state];
                return (
                  <li key={row.questionId} className="flex items-start gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 text-[12px] font-medium uppercase tracking-wide text-muted">
                        {row.label}
                        {badge && <StatusPill tone={badge.tone} size="sm" className="normal-case tracking-normal">{badge.label}</StatusPill>}
                        {row.source && row.source !== "user" && row.source !== "prefill" && row.value && (
                          <StatusPill tone="violet" size="sm" dot={false} className="normal-case tracking-normal" icon={<Sparkles className="size-3" aria-hidden />}>
                            AI-suggested
                          </StatusPill>
                        )}
                      </p>
                      <div className="mt-1 whitespace-pre-line break-words text-[14px] leading-relaxed text-ink">{row.value ? <AnswerValue value={row.value} /> : <span className="text-muted">Not answered</span>}</div>
                    </div>
                    <Button type="button" variant="ghost" size="sm" onClick={() => onEdit(row.questionId)} aria-label={`Edit ${row.label}`}>
                      <Pencil className="size-3.5" /> Edit
                    </Button>
                  </li>
                );
              })}
            </ul>
          </details>
        ))}
      </section>

      <section aria-labelledby="rv-team" className="space-y-3">
        <h2 id="rv-team" className="text-[15px] font-semibold">
          How your six AI employees will be set up
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {review.employees.map((e) => (
            <div key={e.role} className="rounded-2xl border border-line bg-surface p-4">
              <div className="flex items-center gap-3">
                <AgentAvatar role={AGENT_BY_KEY[e.role]} size="md" />
                <div className="min-w-0">
                  <p className="text-[14px] font-semibold">{e.name}</p>
                  <p className="text-[12.5px] text-muted">{e.tagline}</p>
                </div>
              </div>
              {e.configuredFrom.length > 0 && <p className="mt-3 text-[12.5px] text-muted">Configured from: {e.configuredFrom.join("; ")}</p>}
              {e.gaps.map((g) => (
                <p key={g} className="mt-2 flex items-start gap-1.5 rounded-lg bg-warning-soft px-2.5 py-2 text-[12.5px] text-warning-ink">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  {g}
                </p>
              ))}
            </div>
          ))}
        </div>
        <p className="text-[12.5px] text-muted">Every employee starts in Approval required mode. Nothing goes autonomous until its connections are verified and an owner switches it on.</p>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section aria-labelledby="rv-msg" className="space-y-2">
          <h2 id="rv-msg" className="text-[15px] font-semibold">
            How messaging will work
          </h2>
          <dl className="divide-y divide-line rounded-2xl border border-line bg-surface">
            {review.messaging.map((m) => (
              <div key={m.label} className="px-4 py-3">
                <dt className="text-[12px] font-medium uppercase tracking-wide text-muted">{m.label}</dt>
                <dd className="mt-1 text-[14px] leading-relaxed">{m.value}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section aria-labelledby="rv-perm" className="space-y-2">
          <h2 id="rv-perm" className="text-[15px] font-semibold">
            Permissions this setup asks for
          </h2>
          <ul className="space-y-2 rounded-2xl border border-line bg-surface p-4">
            {review.permissions.map((p) => (
              <li key={p} className="flex items-start gap-2 text-[13.5px] leading-relaxed">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                {p}
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section aria-labelledby="rv-missing" className="space-y-2">
        <h2 id="rv-missing" className="text-[15px] font-semibold">
          Connections that aren&apos;t ready yet
        </h2>
        {review.missingConnections.length === 0 ? (
          <p className="flex items-center gap-2 rounded-2xl border border-success/30 bg-success-soft/50 p-4 text-[13.5px] text-success-ink">
            <CheckCircle2 className="size-4" aria-hidden /> Everything your answers need is connected and verified.
          </p>
        ) : (
          <ul className="divide-y divide-line rounded-2xl border border-line bg-surface">
            {review.missingConnections.map((m) => (
              <li key={m.key} className="flex items-start gap-3 px-4 py-3">
                <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-xl bg-warning-soft text-warning-ink"><PlugZap className="size-4" /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-[14px] font-medium">{m.label}</p>
                    <StatusPill tone="warning" size="sm">Not connected</StatusPill>
                  </div>
                  <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{m.why}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="text-[12.5px] text-muted">These are checked against your real workspace connections. Missing items don&apos;t block approval; they are tracked in your Setup Center.</p>
      </section>

      {review.optionalConnections.length > 0 && (
        <section aria-labelledby="rv-optional" className="space-y-2">
          <h2 id="rv-optional" className="text-[15px] font-semibold">
            Optional connections
          </h2>
          <ul className="divide-y divide-line rounded-2xl border border-line bg-surface">
            {review.optionalConnections.map((o) => (
              <li key={o.key} className="flex items-start gap-3 px-4 py-3">
                <span aria-hidden className={cn("grid size-9 shrink-0 place-items-center rounded-xl", o.state === "connected" ? "bg-success-soft text-success-ink" : "bg-surface-2 text-muted")}>
                  {o.state === "connected" ? <CheckCircle2 className="size-4" /> : <PlugZap className="size-4" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-[14px] font-medium">{o.label}</p>
                    <StatusPill tone={o.state === "connected" ? "success" : "neutral"} size="sm">{o.state === "connected" ? "Connected" : o.state === "waiting" ? "Waiting" : "Not connected"}</StatusPill>
                  </div>
                  <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{o.detail}</p>
                </div>
              </li>
            ))}
          </ul>
          <p className="text-[12.5px] text-muted">These are optional. Approving your setup does not depend on any of them.</p>
        </section>
      )}

      <section aria-labelledby="rv-tasks" className="space-y-2">
        <h2 id="rv-tasks" className="text-[15px] font-semibold">
          What needs a person
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {(["you", "iacquire"] as const).map((owner) => (
            <div key={owner} className="rounded-2xl border border-line bg-surface p-4">
              <p className="flex items-center gap-2 text-[13px] font-semibold">
                {owner === "you" ? <UserRound className="size-4 text-primary" aria-hidden /> : <Wrench className="size-4 text-violet" aria-hidden />}
                {owner === "you" ? "You" : "The iAcquire team"}
              </p>
              <ul className="mt-2 list-disc space-y-1.5 pl-5 text-[13.5px] leading-relaxed text-ink-2">
                {review.humanTasks
                  .filter((t) => t.owner === owner)
                  .map((t) => (
                    <li key={t.key}>{t.label}</li>
                  ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="rv-approve" className={cn("rounded-2xl border p-5", confirmed ? "border-primary/40 bg-primary-soft/40" : "border-line bg-surface")}>
        <h2 id="rv-approve" className="text-[15px] font-semibold">
          Approve this setup
        </h2>
        <label className="mt-3 flex cursor-pointer items-start gap-3 text-[14px] leading-relaxed">
          <input type="checkbox" className="mt-1 size-4 shrink-0 accent-[var(--primary)]" checked={confirmed} onChange={(e) => onConfirmChange(e.target.checked)} />
          <span>
            I&apos;ve reviewed these answers. I understand this prepares my AI employees and website draft, and that nothing contacts my customers, books appointments or goes live until each connection is verified and I turn it on.
          </span>
        </label>
        {alreadySubmitted && (
          <p className="mt-3 text-[13px] leading-relaxed text-muted">
            You&apos;ve approved a setup before. Approving again saves a new version of each employee&apos;s configuration, keeps the changes you made to individual employees, and leaves earlier versions available to restore.
          </p>
        )}
        {error && (
          <p role="alert" className="mt-3 text-[13px] text-danger-ink">
            {error}
          </p>
        )}
        {!hideSubmit && <Button className="mt-4 w-full sm:w-auto" variant="brand" size="lg" loading={submitting} disabled={blockers.length > 0 || !confirmed} onClick={onSubmit}>
          <Sparkles className="size-4" /> {alreadySubmitted ? "Approve and update my AI team" : "Approve and prepare my AI team"}
        </Button>}
        {blockers.length > 0 && <p className="mt-2 text-[12.5px] text-muted">Resolve the items above to continue.</p>}
      </section>
    </div>
  );
}
