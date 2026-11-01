"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, ChevronDown, Circle, CircleAlert, Clock, Hourglass, Loader2, MinusCircle, XCircle } from "lucide-react";
import { dismissCalendarNoticeAction, getLaunchReadinessAction, runLaunchIntentAction } from "@/app/actions/launch-readiness";
import { pollIntervalMs, updatedAgoText, useLiveLaunch } from "@/components/setup/use-live-launch";
import { Badge, Select } from "@/components/ui/primitives";
import { Button, ButtonLink } from "@/components/ui/button";
import { ITEM_STATE_LABEL, actionKind, type ItemOwner, type ItemState, type LaunchAction, type LaunchControl, type LaunchIntent, type LaunchIntentParams, type LaunchItem, type LaunchReadiness, type LaunchStage, type LaunchState, type LaunchStep, type StageState, type StepState } from "@/lib/launch-readiness";
import { cn } from "@/lib/utils";

const ANCHOR_BUTTON = "inline-flex h-11 select-none items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-line-strong bg-transparent px-3 text-[14px] font-medium text-ink transition hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:h-8";
// A button that is busy stays focusable (aria-disabled, not disabled), so keyboard focus is not thrown to the page; the class says it is off.
const BUSY = "aria-disabled:cursor-not-allowed aria-disabled:opacity-50";
const OWNER_LABEL: Record<ItemOwner, string> = { you: "You", iacquire: "iAcquire", system: "Automatic, nothing needed from you" };
type Tone = "neutral" | "primary" | "success" | "warning" | "danger" | "violet";
const STATE_TONE: Record<LaunchState, Tone> = {
  not_started: "neutral", questionnaire_submitted: "primary", provisioning: "primary", action_required: "warning", ready_for_review: "violet", ready_to_launch: "success",
};
const ITEM_TONE: Record<ItemState, Tone> = { done: "success", in_progress: "primary", action_required: "warning", awaiting_review: "violet", failed: "danger", not_applicable: "neutral" };
const STEP_LABEL: Record<StepState, string> = { done: "Complete", in_progress: "In progress", action_required: "Action required", awaiting_review: "Waiting for review", not_applicable: "Not applicable" };
const STEP_TONE: Record<StepState, Tone> = { done: "success", in_progress: "primary", action_required: "warning", awaiting_review: "violet", not_applicable: "neutral" };
const STAGE_TEXT: Record<StageState, string> = { done: "Done", in_progress: "Working", pending: "Waiting", action_required: "Needs attention", failed: "Failed" };

/**
 * Where the questionnaire opens for a line that links to it, so the person lands on the one question that is missing instead of at the saved position. Each id is a real question
 * (a test checks them against the questionnaire); a line that is not here opens the questionnaire where they left off.
 */
export const QUESTION_FOR_ITEM: Record<string, string> = {
  "profile.timezone": "a.timezone",
  "calendar.question": "b.appointments",
  "calendar.host": "d.appt_host",
  "integrations.email": "c.email_sender",
  "integrations.whatsapp": "c.whatsapp_number",
};

/** The questionnaire is opened with a way back, so finishing a step returns the person to Setup instead of leaving them to find it. */
export function questionnaireHref(itemKey: string): string {
  const question = QUESTION_FOR_ITEM[itemKey];
  return `/onboarding?${question ? `question=${question}&` : ""}return=/setup`;
}

function ItemIcon({ state, quiet = false }: { state: ItemState; quiet?: boolean }) {
  const cls = "size-4";
  switch (state) {
    case "done": return <CheckCircle2 aria-hidden className={cn(cls, "text-success-ink")} />;
    case "in_progress": return <Clock aria-hidden className={cn(cls, "text-primary")} />;
    case "action_required": return <CircleAlert aria-hidden className={cn(cls, quiet ? "text-muted" : "text-warning-ink")} />;
    case "awaiting_review": return <Hourglass aria-hidden className={cn(cls, "text-violet-ink")} />;
    case "failed": return <XCircle aria-hidden className={cn(cls, "text-danger-ink")} />;
    case "not_applicable": return <MinusCircle aria-hidden className={cn(cls, "text-muted")} />;
  }
}

function StageIcon({ state }: { state: StageState }) {
  const cls = "size-3.5";
  switch (state) {
    case "done": return <CheckCircle2 aria-hidden className={cn(cls, "text-success-ink")} />;
    case "in_progress": return <Clock aria-hidden className={cn(cls, "text-primary")} />;
    case "action_required": return <CircleAlert aria-hidden className={cn(cls, "text-warning-ink")} />;
    case "failed": return <XCircle aria-hidden className={cn(cls, "text-danger-ink")} />;
    case "pending": return <Circle aria-hidden className={cn(cls, "text-muted")} />;
  }
}

type Notice = { ok: boolean; text: string };
type Audience = "client" | "agency";

/**
 * `preview` is for the design preview page only: the buttons say so and run nothing. `calendarNotice` is the one-time message a Google or Microsoft sign-in left for this page; it
 * is shown once and the server is told to forget it, so reloading the page does not show it again. `audience` is who is looking: the client (the default) gets the buttons that run a
 * step; iAcquire's staff get a read-only view with only the links that are theirs. A null `readiness` is a read that failed: the panel says so and offers to try again.
 */
export function LaunchReadinessPanel({ readiness, preview = false, calendarNotice = null, audience = "client" }: { readiness: LaunchReadiness | null; preview?: boolean; calendarNotice?: Notice | null; audience?: Audience }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [running, setRunning] = React.useState<LaunchIntent | null>(null);
  const [notice, setNotice] = React.useState<Notice | null>(calendarNotice);
  const hadCalendarNotice = calendarNotice !== null;
  React.useEffect(() => {
    if (hadCalendarNotice && !preview) void dismissCalendarNoticeAction();
  }, [hadCalendarNotice, preview]);

  // The state is read again by itself (never estimated from elapsed time) and drawn from the hook's state, so the rest of the page is not re-run. A staff member looking at a client has no
  // workspace of their own to ask about, so that view does not poll.
  const live = useLiveLaunch({ initial: readiness, fetcher: getLaunchReadinessAction, enabled: !preview && audience === "client" });
  const current = live.readiness;

  function run(intent: LaunchIntent, params?: LaunchIntentParams) {
    if (preview) {
      setNotice({ ok: true, text: "Design preview: nothing runs here." });
      return;
    }
    if (pending) return;
    setRunning(intent);
    setNotice(null);
    startTransition(async () => {
      const res = await runLaunchIntentAction(intent, params);
      setNotice(res.ok ? { ok: res.data.ok, text: res.data.message } : { ok: false, text: res.error });
      setRunning(null);
      void live.refresh();
      router.refresh();
    });
  }

  if (!current) return <LaunchUnavailable busy={live.refreshing} failedAgain={live.connection !== "ok"} onRetry={() => void live.refresh()} />;

  const tone = STATE_TONE[current.state];
  const done = current.state === "ready_to_launch";
  return (
    <section aria-labelledby="launch-readiness-title" data-state={current.state} data-audience={audience} className="mx-auto mb-6 max-w-6xl overflow-hidden rounded-[26px] border border-line bg-surface p-5 shadow-sm sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-semibold uppercase tracking-[.16em] text-primary">Launch readiness</p>
          <h2 id="launch-readiness-title" className="mt-1 text-[23px] font-semibold tracking-tight text-ink">{current.headline}</h2>
          <p className="mt-1 max-w-2xl text-[14px] leading-relaxed text-muted">{current.detail}</p>
        </div>
        <div className="text-right">
          <Badge tone={tone}>{current.label}</Badge>
          <p className="mt-2 text-[28px] font-semibold leading-none tracking-tight text-ink">{current.percent}%</p>
          <p className="mt-1 text-[12px] text-muted">{current.passed} of {current.total} checks passed</p>
        </div>
      </div>
      <LaunchProgress readiness={current} tone={done ? "success" : current.state === "action_required" ? "warning" : "primary"} />

      {audience === "client" && !preview && <LiveStatus syncedAt={live.syncedAt} connection={live.connection} polling={pollIntervalMs(current) !== null} />}

      {/* What the person just did, said out loud. The announcement below is separate: it speaks only when the launch state itself changed. */}
      <div role="status" aria-live="polite" className={cn("mt-3 text-[14px] leading-relaxed", notice ? (notice.ok ? "text-success-ink" : "text-warning-ink") : "sr-only")}>{notice?.text ?? ""}</div>
      <div data-testid="launch-announcement" aria-live="polite" aria-atomic="true" className="sr-only">{live.announcement}</div>

      <div className="mt-5 grid gap-3">
        {current.steps.map((step) => (
          <StepCard key={step.key} step={step} audience={audience} busy={pending} running={running} onRun={run} />
        ))}
      </div>

      {current.controls && current.controls.length > 0 && <ControlsCard controls={current.controls} ready={done} audience={audience} />}
    </section>
  );
}

/** Shown when the page could not read the launch status. It says so, in an alert, and lets the person ask again; nothing about the state is guessed. */
function LaunchUnavailable({ busy, failedAgain, onRetry }: { busy: boolean; failedAgain: boolean; onRetry: () => void }) {
  return (
    <section aria-labelledby="launch-unavailable-title" data-state="unavailable" className="mx-auto mb-6 max-w-6xl rounded-[26px] border border-line bg-surface p-5 shadow-sm sm:p-7">
      <div role="alert">
        <h2 id="launch-unavailable-title" className="text-[18px] font-semibold tracking-tight text-ink">We couldn&apos;t read your launch status just now</h2>
        <p className="mt-1 max-w-2xl text-[14px] leading-relaxed text-muted">
          Your setup has not changed and nothing was lost. The checklist below still works.{failedAgain ? " We tried again and still couldn't read it. Please try once more in a moment." : ""}
        </p>
      </div>
      <Button type="button" size="sm" variant="secondary" className={cn("mt-3", BUSY)} aria-disabled={busy || undefined} aria-busy={busy || undefined} onClick={() => { if (!busy) onRetry(); }}>
        {busy && <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />}Try again
      </Button>
    </section>
  );
}

/** The percent bar. Its own markup (not the shared bar) so it can say, in words, how many checks stand behind the number. */
function LaunchProgress({ readiness, tone }: { readiness: LaunchReadiness; tone: "primary" | "warning" | "success" }) {
  const pct = Math.max(0, Math.min(100, readiness.percent));
  const fill = { primary: "bg-primary", warning: "bg-warning", success: "bg-success" }[tone];
  const track = { primary: "bg-primary-soft", warning: "bg-warning-soft", success: "bg-success-soft" }[tone];
  return (
    <div
      className={cn("mt-4 h-2 w-full overflow-hidden rounded-full", track)}
      role="progressbar"
      aria-label="Launch readiness"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={`${Math.round(pct)} percent, ${readiness.passed} of ${readiness.total} checks passed`}
    >
      <div className={cn("h-full rounded-full transition-[width] duration-700 ease-out motion-reduce:transition-none", fill)} style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * "Updated 12 s ago" and the offline or could-not-refresh notice. It keeps its own clock so the seconds tick here and nowhere else, and it is not a live region: a counter that
 * spoke every second would drown out everything that matters.
 */
function LiveStatus({ syncedAt, connection, polling }: { syncedAt: number; connection: "ok" | "error" | "offline"; polling: boolean }) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className="mt-2 text-[12px] text-muted">
      {connection === "offline" && (
        <p data-testid="launch-connection" className="mb-1 rounded-lg border border-warning/40 bg-warning-soft/60 px-3 py-2 text-[13px] text-warning-ink">You appear to be offline. What you see is the last thing we read, and it updates when you are back online.</p>
      )}
      {connection === "error" && (
        <p data-testid="launch-connection" className="mb-1 rounded-lg border border-warning/40 bg-warning-soft/60 px-3 py-2 text-[13px] text-warning-ink">We couldn&apos;t refresh just now. What you see is the last thing we read, and we will keep trying.</p>
      )}
      <p data-testid="launch-updated">{updatedAgoText(syncedAt, now)}{polling ? "" : ". Nothing changes by itself from here."}</p>
    </div>
  );
}

type RunIntent = (intent: LaunchIntent, params?: LaunchIntentParams) => void;

function StepCard({ step, audience, busy, running, onRun }: { step: LaunchStep; audience: Audience; busy: boolean; running: LaunchIntent | null; onRun: RunIntent }) {
  const needsLook = step.state === "action_required" || step.state === "in_progress" || step.state === "awaiting_review";
  // A step the person opened stays open however its state moves while they read it. A step they closed stays closed only in the state they closed it in: once it changes, the default
  // applies again, so a step that comes to need them is never left hidden.
  const [chosen, setChosen] = React.useState<{ open: boolean; at: StepState } | null>(null);
  if (chosen && !chosen.open && chosen.at !== step.state) setChosen(null);
  const open = chosen ? chosen.open : needsLook;
  return (
    <details
      open={open}
      data-step={step.key}
      data-state={step.state}
      onToggle={(e) => {
        const now = e.currentTarget.open;
        if (now !== open) setChosen({ open: now, at: step.state });
      }}
      className="group rounded-2xl border border-line bg-surface-2/40 p-4"
    >
      <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center justify-between gap-2 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary [&::-webkit-details-marker]:hidden">
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
          <ItemRow key={item.key} item={item} audience={audience} busy={busy} running={running} onRun={onRun} />
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
      <Button size="sm" variant="secondary" className={BUSY} disabled={!pick} aria-disabled={busy || undefined} onClick={() => { if (!busy) onRun("assign_host", { userId: pick }); }}>
        {busy && running === "assign_host" && <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />}Make them the host
      </Button>
    </div>
  );
}

/** A route handler (the provider sign-in start) is not a page: a plain link makes the browser load it, where the app's own link would try to render it. */
function ActionLink({ href, label, name, describedBy }: { href: string; label: string; name: string; describedBy?: string }) {
  return href.startsWith("/api/")
    ? <a href={href} aria-label={name} aria-describedby={describedBy} className={ANCHOR_BUTTON}>{label}</a>
    : <ButtonLink href={href} size="sm" variant="outline" aria-label={name} aria-describedby={describedBy}>{label}</ButtonLink>;
}

/** What a provider sign-in link does, said before it is pressed: it leaves for Google or Microsoft and comes back to this page. */
function signInProvider(href: string): string | null {
  const m = /^\/api\/crm\/calendar-oauth\/(google|microsoft)\/start/.exec(href);
  return m ? (m[1] === "google" ? "Google" : "Microsoft") : null;
}

/** Whether a link is one staff may follow: iAcquire's own screens. A client's screen (their settings, their calendar) is not theirs to open. */
const isAgencyLink = (href: string) => href.startsWith("/admin/");

function ActionControl({ item, action, audience, busy, running, onRun }: { item: LaunchItem; action: LaunchAction; audience: Audience; busy: boolean; running: LaunchIntent | null; onRun: RunIntent }) {
  const hintId = React.useId();
  const name = `${action.label}: ${item.label}`;
  if (action.intent) {
    if (audience === "agency") return null;
    const intent = action.intent;
    return (
      <Button size="sm" variant="secondary" className={BUSY} aria-label={name} aria-disabled={busy || undefined} aria-busy={(busy && running === intent) || undefined} onClick={() => { if (!busy) onRun(intent, action.params); }}>
        {busy && running === intent && <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />}{action.label}
      </Button>
    );
  }
  if (!action.href) return null;
  if (audience === "agency" && !isAgencyLink(action.href)) return null;
  const provider = actionKind(action) === "external" ? signInProvider(action.href) : null;
  const href = action.href === "/onboarding" ? questionnaireHref(item.key) : action.href;
  return (
    <>
      <ActionLink href={href} label={action.label} name={name} describedBy={provider ? hintId : undefined} />
      {provider && <p id={hintId} className="basis-full text-[12px] text-muted">This opens {provider}. You come back here afterwards.</p>}
    </>
  );
}

/** One employee's path, in words: each stage says what it is and whether it has happened, so no state rests on a colour or an icon alone. */
function StageStepper({ label, stages }: { label: string; stages: LaunchStage[] }) {
  return (
    <ol aria-label={`${label} setup stages`} className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
      {stages.map((s) => (
        <li key={s.key} data-stage={s.key} data-state={s.state} className="flex items-center gap-1.5 text-[12px]">
          <StageIcon state={s.state} />
          <span className="font-medium text-ink-2">{s.label}</span>
          <span className="sr-only">: </span>
          <span className="text-muted">{STAGE_TEXT[s.state]}</span>
        </li>
      ))}
    </ol>
  );
}

function ItemRow({ item, audience, busy, running, onRun }: { item: LaunchItem; audience: Audience; busy: boolean; running: LaunchIntent | null; onRun: RunIntent }) {
  const action = item.action;
  // A line that is not required and is waiting on a choice is information, not work: it never reads as "Action required" and never counts as such.
  const optionalOpen = !item.required && item.state === "action_required";
  return (
    <li data-item={item.key} data-state={item.state} className="flex flex-wrap items-start gap-3 rounded-xl border border-line bg-surface px-3 py-2.5">
      <span className="mt-0.5"><ItemIcon state={item.state} quiet={optionalOpen} /></span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[14px] font-medium text-ink">{item.label}</span>
          {optionalOpen ? <Badge tone="outline">Optional, your choice</Badge> : <Badge tone={ITEM_TONE[item.state]}>{ITEM_STATE_LABEL[item.state]}</Badge>}
          {!item.required && item.state !== "not_applicable" && !optionalOpen && <Badge tone="outline">Optional</Badge>}
          {item.stalled && <Badge tone="warning">Taking longer than expected</Badge>}
        </div>
        <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{item.detail}</p>
        {item.stages && item.stages.length > 0 && <StageStepper label={item.label} stages={item.stages} />}
        {item.guidance && item.guidance.length > 0 && item.state !== "done" && (
          <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-[12px] leading-relaxed text-muted" aria-label="What this involves">
            {item.guidance.map((line) => <li key={line}>{line}</li>)}
          </ul>
        )}
        {item.state !== "done" && item.state !== "not_applicable" && !(item.state === "in_progress" && item.owner === "you") && <p className="mt-0.5 text-[12px] text-muted">Next move: {OWNER_LABEL[item.owner]}</p>}
      </div>
      {action && <ActionControl item={item} action={action} audience={audience} busy={busy} running={running} onRun={onRun} />}
      {audience === "client" && item.hostChoices && item.hostChoices.length > 0 && <HostPicker choices={item.hostChoices} busy={busy} running={running} onRun={onRun} />}
    </li>
  );
}

/**
 * The customer-facing switches and the screen where each one is flipped. They are links and nothing else: no button here turns anything on, and every one that is off says it stays off
 * until the person turns it on. Staff see the same list read-only.
 */
function ControlsCard({ controls, ready, audience }: { controls: LaunchControl[]; ready: boolean; audience: Audience }) {
  return (
    <section aria-labelledby="launch-controls-title" data-ready={ready} className="mt-5 rounded-2xl border border-line bg-surface-2/40 p-4">
      <h3 id="launch-controls-title" className="text-[14px] font-semibold text-ink">Customer-facing switches</h3>
      <p className="mt-0.5 text-[12px] text-muted">
        {ready ? "Every check has passed. Each switch below stays off until you turn it on yourself." : "Nothing here is switched on by this setup. Each switch stays off until you turn it on yourself."}
      </p>
      <ul className="mt-3 grid gap-2">
        {controls.map((c) => (
          <li key={c.key} data-control={c.key} data-on={c.on} className="flex flex-wrap items-start gap-3 rounded-xl border border-line bg-surface px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[14px] font-medium text-ink">{c.label}</span>
                <Badge tone={c.on ? "success" : "neutral"}>{c.on ? "On" : "Off until you turn it on"}</Badge>
              </div>
              <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{c.detail}</p>
            </div>
            {audience === "client" && <ActionLink href={c.href} label="Open" name={`Open ${c.label}`} />}
          </li>
        ))}
      </ul>
    </section>
  );
}
