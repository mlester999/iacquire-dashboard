"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, ChevronDown, CircleAlert, Clock, Hourglass, MinusCircle, XCircle } from "lucide-react";
import { dismissCalendarNoticeAction, runLaunchIntentAction } from "@/app/actions/launch-readiness";
import { Badge, ProgressBar, Select } from "@/components/ui/primitives";
import { Button, ButtonLink } from "@/components/ui/button";
import { ITEM_STATE_LABEL, type ItemOwner, type ItemState, type LaunchIntent, type LaunchIntentParams, type LaunchItem, type LaunchReadiness, type LaunchState, type LaunchStep, type StepState } from "@/lib/launch-readiness";
import { cn } from "@/lib/utils";

const ANCHOR_BUTTON = "inline-flex h-11 select-none items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-line-strong bg-transparent px-3 text-[14px] font-medium text-ink transition hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:h-8";
const OWNER_LABEL: Record<ItemOwner, string> = { you: "You", iacquire: "iAcquire", system: "Automatic" };
type Tone = "neutral" | "primary" | "success" | "warning" | "danger" | "violet";
const STATE_TONE: Record<LaunchState, Tone> = {
  not_started: "neutral", questionnaire_submitted: "primary", provisioning: "primary", action_required: "warning", ready_for_review: "violet", ready_to_launch: "success",
};
const ITEM_TONE: Record<ItemState, Tone> = { done: "success", in_progress: "primary", action_required: "warning", awaiting_review: "violet", failed: "danger", not_applicable: "neutral" };
const STEP_LABEL: Record<StepState, string> = { done: "Complete", in_progress: "In progress", action_required: "Action required", awaiting_review: "Waiting for review", not_applicable: "Not applicable" };
const STEP_TONE: Record<StepState, Tone> = { done: "success", in_progress: "primary", action_required: "warning", awaiting_review: "violet", not_applicable: "neutral" };

function ItemIcon({ state }: { state: ItemState }) {
  const cls = "size-4";
  switch (state) {
    case "done": return <CheckCircle2 aria-hidden className={cn(cls, "text-success-ink")} />;
    case "in_progress": return <Clock aria-hidden className={cn(cls, "text-primary")} />;
    case "action_required": return <CircleAlert aria-hidden className={cn(cls, "text-warning-ink")} />;
    case "awaiting_review": return <Hourglass aria-hidden className={cn(cls, "text-violet-ink")} />;
    case "failed": return <XCircle aria-hidden className={cn(cls, "text-danger-ink")} />;
    case "not_applicable": return <MinusCircle aria-hidden className={cn(cls, "text-muted")} />;
  }
}

/** How often the page re-reads the workspace while setup is running by itself. The state is always the stored one; this only asks for it again. */
const REFRESH_MS = 10_000;

type Notice = { ok: boolean; text: string };

/**
 * `preview` is for the design preview page only: the buttons say so and run nothing. `calendarNotice` is the one-time message a Google or Microsoft sign-in left for this page; it
 * is shown once and the server is told to forget it, so reloading the page does not show it again.
 */
export function LaunchReadinessPanel({ readiness, preview = false, calendarNotice = null }: { readiness: LaunchReadiness; preview?: boolean; calendarNotice?: Notice | null }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [running, setRunning] = React.useState<LaunchIntent | null>(null);
  const [notice, setNotice] = React.useState<Notice | null>(calendarNotice);
  const hadCalendarNotice = calendarNotice !== null;
  React.useEffect(() => {
    if (hadCalendarNotice && !preview) void dismissCalendarNoticeAction();
  }, [hadCalendarNotice, preview]);

  // While setup is working by itself, ask for the stored state again. Nothing is estimated from elapsed time.
  const waiting = readiness.state === "provisioning" && !preview;
  React.useEffect(() => {
    if (!waiting) return;
    const id = window.setInterval(() => { if (document.visibilityState === "visible") router.refresh(); }, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [waiting, router]);

  function run(intent: LaunchIntent, params?: LaunchIntentParams) {
    if (preview) {
      setNotice({ ok: true, text: "Design preview: nothing runs here." });
      return;
    }
    setRunning(intent);
    setNotice(null);
    startTransition(async () => {
      const res = await runLaunchIntentAction(intent, params);
      setNotice(res.ok ? { ok: res.data.ok, text: res.data.message } : { ok: false, text: res.error });
      setRunning(null);
      router.refresh();
    });
  }

  const tone = STATE_TONE[readiness.state];
  const done = readiness.state === "ready_to_launch";
  return (
    <section aria-labelledby="launch-readiness-title" data-state={readiness.state} className="mx-auto mb-6 max-w-6xl overflow-hidden rounded-[26px] border border-line bg-surface p-5 shadow-sm sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-semibold uppercase tracking-[.16em] text-primary">Launch readiness</p>
          <h2 id="launch-readiness-title" className="mt-1 text-[23px] font-semibold tracking-tight text-ink">{readiness.headline}</h2>
          <p className="mt-1 max-w-2xl text-[14px] leading-relaxed text-muted">{readiness.detail}</p>
        </div>
        <div className="text-right">
          <Badge tone={tone}>{readiness.label}</Badge>
          <p className="mt-2 text-[28px] font-semibold leading-none tracking-tight text-ink" aria-label={`${readiness.percent} percent`}>{readiness.percent}%</p>
          <p className="mt-1 text-[12px] text-muted">{readiness.passed} of {readiness.total} checks passed</p>
        </div>
      </div>
      <ProgressBar value={readiness.percent} tone={done ? "success" : readiness.state === "action_required" ? "warning" : "primary"} className="mt-4" label="Launch readiness" />

      <div role="status" aria-live="polite" className={cn("mt-3 text-[14px] leading-relaxed", notice ? (notice.ok ? "text-success-ink" : "text-warning-ink") : "sr-only")}>{notice?.text ?? ""}</div>

      <div className="mt-5 grid gap-3">
        {readiness.steps.map((step) => (
          <StepCard key={step.key} step={step} busy={pending} running={running} onRun={run} />
        ))}
      </div>
    </section>
  );
}

type RunIntent = (intent: LaunchIntent, params?: LaunchIntentParams) => void;

function StepCard({ step, busy, running, onRun }: { step: LaunchStep; busy: boolean; running: LaunchIntent | null; onRun: RunIntent }) {
  const open = step.state === "action_required" || step.state === "in_progress" || step.state === "awaiting_review";
  return (
    <details open={open} data-step={step.key} data-state={step.state} className="group rounded-2xl border border-line bg-surface-2/40 p-4">
      <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center justify-between gap-2">
        <span className="min-w-0">
          <span className="block text-[14px] font-semibold text-ink">{step.title}</span>
          <span className="block text-[12px] text-muted">{step.summary}</span>
        </span>
        <span className="flex items-center gap-2">
          <Badge tone={STEP_TONE[step.state]}>{STEP_LABEL[step.state]}</Badge>
          <ChevronDown aria-hidden className="size-4 text-muted transition-transform group-open:rotate-180" />
        </span>
      </summary>
      <ul className="mt-3 grid gap-2">
        {step.items.map((item) => (
          <ItemRow key={item.key} item={item} busy={busy} running={running} onRun={onRun} />
        ))}
      </ul>
    </details>
  );
}

/** The people the client may choose as the host. Nothing is selected until they choose: a host is never picked for them. The server checks the person again. */
function HostPicker({ choices, busy, running, onRun }: { choices: Array<{ id: string; name: string }>; busy: boolean; running: LaunchIntent | null; onRun: RunIntent }) {
  const [pick, setPick] = React.useState("");
  const id = React.useId();
  return (
    <div className="flex w-full flex-wrap items-center gap-2 pt-1">
      <label htmlFor={id} className="sr-only">Choose who takes appointments</label>
      <div className="min-w-0 flex-1 sm:max-w-xs">
        <Select id={id} value={pick} onChange={(e) => setPick(e.target.value)}>
          <option value="">Choose a person</option>
          {choices.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      </div>
      <Button size="sm" variant="secondary" loading={busy && running === "assign_host"} disabled={busy || !pick} onClick={() => onRun("assign_host", { userId: pick })}>Make them the host</Button>
    </div>
  );
}

function ItemRow({ item, busy, running, onRun }: { item: LaunchItem; busy: boolean; running: LaunchIntent | null; onRun: RunIntent }) {
  const action = item.action;
  return (
    <li data-item={item.key} data-state={item.state} className="flex flex-wrap items-start gap-3 rounded-xl border border-line bg-surface px-3 py-2.5">
      <span className="mt-0.5"><ItemIcon state={item.state} /></span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[14px] font-medium text-ink">{item.label}</span>
          <Badge tone={ITEM_TONE[item.state]}>{ITEM_STATE_LABEL[item.state]}</Badge>
          {!item.required && item.state !== "not_applicable" && <Badge tone="outline">Optional</Badge>}
        </div>
        <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{item.detail}</p>
        {item.guidance && item.guidance.length > 0 && item.state !== "done" && (
          <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-[12px] leading-relaxed text-muted" aria-label="What this involves">
            {item.guidance.map((line) => <li key={line}>{line}</li>)}
          </ul>
        )}
        {item.state !== "done" && item.state !== "not_applicable" && !(item.state === "in_progress" && item.owner === "you") && <p className="mt-0.5 text-[12px] text-muted">Next move: {OWNER_LABEL[item.owner]}</p>}
      </div>
      {action?.intent && (
        <Button size="sm" variant="secondary" loading={busy && running === action.intent} disabled={busy} onClick={() => onRun(action.intent as LaunchIntent, action.params)}>{action.label}</Button>
      )}
      {action?.href && !action.intent && (
        // A route handler (the provider sign-in start) is not a page: a plain link makes the browser load it, where the app's own link would try to render it.
        action.href.startsWith("/api/")
          ? <a href={action.href} className={ANCHOR_BUTTON}>{action.label}</a>
          : <ButtonLink href={action.href} size="sm" variant="outline">{action.label}</ButtonLink>
      )}
      {item.hostChoices && item.hostChoices.length > 0 && <HostPicker choices={item.hostChoices} busy={busy} running={running} onRun={onRun} />}
    </li>
  );
}
