"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight, CheckCircle2, ChevronRight, CircleAlert, CircleDashed, Clock, ExternalLink, Loader2, RefreshCw, Send, ShieldCheck, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, ProgressBar, Select } from "@/components/ui/primitives";
import { PageTitle, ReadOnlyNotice } from "@/components/crm/ui";
import { cn, formatDateTime } from "@/lib/utils";
import { CRM_NAV } from "@/lib/crm/nav";
import { CRM_MODE_LABELS } from "@/lib/crm/types";
import {
  CALENDAR_SOURCES,
  CALENDAR_SOURCE_LABEL,
  CRM_SETUP_STATUS_LABEL,
  CRM_SETUP_STATUS_TONE,
  GUIDE_CHANNELS,
  GUIDE_CHANNEL_LABEL,
  buildCrmSetupSteps,
  effectiveAnswers,
  guideProgress,
  resolveGuideStep,
  type CalendarSource,
  type CrmSetupAnswers,
  type CrmSetupLink,
  type CrmSetupStatus,
  type CrmSetupStep,
  type CrmSetupStepKey,
  type GuideChannel,
} from "@/lib/onboarding/crm-setup";
import { createGuideAutosave, type GuideAutosave, type GuidePatch } from "@/lib/onboarding/crm-setup-autosave";
import { chooseInitialCrmProviderAction, recheckCrmSetupAction, requestCrmSetupReviewAction, saveCrmSetupGuideAction } from "@/app/actions/crm-setup";
import type { CrmSetupGuideData } from "@/server/setup/crm-guide";
import type { CrmScope } from "@/server/crm/page";

const STATUS_ICON: Record<CrmSetupStatus, React.ComponentType<{ className?: string }>> = {
  not_started: CircleDashed,
  in_progress: Clock,
  needs_client_action: UserRound,
  needs_agency_action: ShieldCheck,
  configured: CheckCircle2,
  verified: CheckCircle2,
  failed: CircleAlert,
};

function StatusBadge({ status }: { status: CrmSetupStatus }) {
  const Icon = STATUS_ICON[status];
  return (
    <Badge tone={CRM_SETUP_STATUS_TONE[status]} className="gap-1">
      <Icon className="size-3" aria-hidden />
      {CRM_SETUP_STATUS_LABEL[status]}
    </Badge>
  );
}

const NAV = CRM_NAV.flatMap((s) => s.items);

/** Where a step's link goes for this viewer, or null when they can't open it (the label is still shown). */
function hrefFor(link: CrmSetupLink, scope: CrmScope): string | null {
  if (link.portal) {
    if (!scope.agency) return link.path;
    // The agency's own view of the client's Setup Center; other portal pages belong to the client.
    return link.path === "/setup" && scope.orgId ? `/admin/clients/${scope.orgId}/setup` : null;
  }
  const nav = NAV.find((i) => i.path === link.path);
  if (nav && !scope.can[nav.permission]) return null;
  return `${scope.base}${link.path}`;
}

type SaveState = "idle" | "saving" | "saved" | "error";

/**
 * CRM → Setup guide. One step per screen; the step and answers autosave, and the guide reopens exactly where the person left off. Statuses
 * come from the workspace's real records (recomputed here as questions are answered), never from what was typed.
 */
export function CrmSetupGuide({ scope, data }: { scope: CrmScope; data: CrmSetupGuideData }) {
  const router = useRouter();
  const editable = data.canEdit && !scope.readOnly;
  const [answers, setAnswers] = React.useState<CrmSetupAnswers>(data.answers);
  const steps = React.useMemo(() => buildCrmSetupSteps(data.facts, answers), [data.facts, answers]);
  const [currentKey, setCurrentKey] = React.useState<CrmSetupStepKey>(data.currentStep);
  const current = steps.find((s) => s.key === currentKey) ?? steps.find((s) => s.key === resolveGuideStep(currentKey, steps.map((x) => x.key))) ?? steps[0];
  const index = steps.indexOf(current);
  const progress = guideProgress(steps);

  // Autosave: answers wait a moment (typing a choice twice saves once), a change of step saves at once. Saves run one at a time, each with
  // the revision the previous save or guide action returned (src/lib/onboarding/crm-setup-autosave.ts), so only a real change from another
  // tab or person is reported as one.
  const [saveState, setSaveState] = React.useState<SaveState>("idle");
  const [saver] = React.useState(() =>
    createGuideAutosave({
      revision: data.revision,
      save: async (body) => {
        const res = await saveCrmSetupGuideAction(scope.orgId, body);
        return res.ok ? { ok: true, revision: res.data.revision, staleBase: res.data.staleBase } : { ok: false, error: res.error };
      },
      onState: setSaveState,
      onError: (message) => toast.error(message),
      onStale: () => toast.info("This guide was also changed in another window. Your answer was saved; refresh to see everything up to date."),
    }),
  );
  const queue = React.useCallback((patch: GuidePatch, delay: number) => {
    if (editable) saver.queue(patch, delay);
  }, [editable, saver]);
  React.useEffect(() => {
    const out = () => void saver.flush();
    window.addEventListener("pagehide", out);
    return () => {
      window.removeEventListener("pagehide", out);
      void saver.flush();
    };
  }, [saver]);

  const go = (key: CrmSetupStepKey) => {
    setCurrentKey(key);
    queue({ currentStep: key }, 0);
    if (typeof window !== "undefined") document.getElementById("crm-setup-step")?.focus({ preventScroll: false });
  };
  const answer = (patch: CrmSetupAnswers) => {
    setAnswers((a) => ({ ...a, ...patch }));
    queue({ answers: patch }, 400);
  };

  return (
    <div>
      <PageTitle
        title="CRM setup guide"
        description="Set up your CRM one step at a time. Each step's status comes from what is really in your workspace: something is verified only after a live test or a check of the real records passes, never because a key or an answer was entered."
        actions={<SaveIndicator state={saveState} editable={editable} onRetry={() => void saver.flush()} />}
      />
      {!editable && <div className="mb-4"><ReadOnlyNotice>{scope.agency ? (scope.readOnly ? "This support session is read-only. A super admin's write session can help answer the guide's questions." : "You can view this guide.") : "You can follow the guide. Owners and admins answer its questions."}</ReadOnlyNotice></div>}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="min-w-48 flex-1">
          <ProgressBar value={progress.total ? Math.round((progress.done / progress.total) * 100) : 0} tone={progress.done === progress.total ? "success" : "primary"} label={`${progress.done} of ${progress.total} steps done`} />
        </div>
        <p className="text-[12.5px] text-muted">
          {progress.done} of {progress.total} steps done · {progress.verified} verified
        </p>
      </div>

      {/* Phones: one compact step picker instead of the rail. */}
      <div className="mb-4 lg:hidden">
        <label className="sr-only" htmlFor="crm-setup-jump">Go to step</label>
        <Select id="crm-setup-jump" value={current.key} onChange={(e) => go(e.target.value as CrmSetupStepKey)}>
          {steps.map((s, i) => (
            <option key={s.key} value={s.key}>{`${i + 1}. ${s.title} — ${CRM_SETUP_STATUS_LABEL[s.status]}`}</option>
          ))}
        </Select>
      </div>

      <div className="grid gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
        <nav aria-label="Setup steps" className="hidden lg:block">
          <ol className="space-y-1">
            {steps.map((s, i) => (
              <li key={s.key}>
                <button
                  type="button"
                  onClick={() => go(s.key)}
                  aria-current={s.key === current.key ? "step" : undefined}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] transition-colors",
                    s.key === current.key ? "bg-surface-2 font-medium text-ink" : "text-ink-2 hover:bg-surface-2",
                  )}
                >
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-line text-[11px] tabular-nums">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate">{s.title}</span>
                  <StepDot status={s.status} />
                </button>
              </li>
            ))}
          </ol>
        </nav>

        <Card>
          <CardContent className="space-y-5 p-5 sm:p-6">
            <div id="crm-setup-step" tabIndex={-1} className="space-y-2 outline-none">
              <p className="text-[11.5px] font-medium uppercase tracking-[0.08em] text-muted">Step {index + 1} of {steps.length}</p>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-[18px] font-semibold tracking-[-0.02em] text-ink">{current.title}</h3>
                <StatusBadge status={current.status} />
              </div>
              <p className="text-[13px] leading-relaxed text-muted">{current.intro}</p>
            </div>

            <div className="rounded-xl border border-line bg-surface-2 px-4 py-3" aria-live="polite">
              <p className="text-[11.5px] font-medium text-muted">What we found</p>
              <p className="mt-1 text-[13.5px] leading-relaxed text-ink">{current.summary}</p>
              {current.next && <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-2">Next: {current.next}</p>}
            </div>

            <StepQuestions step={current} data={data} answers={answers} editable={editable} onAnswer={answer} scope={scope} saver={saver} onProviderChosen={() => router.refresh()} />

            {current.key === "verify" && <RecheckButton scope={scope} enabled={editable} onDone={() => router.refresh()} />}
            {current.key === "review" && <ReviewHandOff scope={scope} data={data} saver={saver} onDone={() => router.refresh()} />}

            {current.links.length > 0 && (
              <div>
                <p className="mb-1.5 text-[11.5px] font-medium text-muted">Where to do it</p>
                <ul className="flex flex-wrap gap-2">
                  {current.links.map((l) => {
                    const href = hrefFor(l, scope);
                    return (
                      <li key={l.path}>
                        {href ? (
                          <Link href={href} className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-line bg-surface px-3 text-[13px] font-medium text-ink hover:bg-surface-2 sm:min-h-9">
                            {l.label}
                            <ChevronRight className="size-3.5" aria-hidden />
                          </Link>
                        ) : (
                          <span className="inline-flex min-h-11 items-center rounded-xl border border-dashed border-line px-3 text-[13px] text-muted sm:min-h-9" title="Your access doesn't include this screen.">{l.label}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4">
              <Button variant="secondary" onClick={() => index > 0 && go(steps[index - 1].key)} disabled={index === 0}>
                <ArrowLeft className="size-4" aria-hidden />
                Back
              </Button>
              {index < steps.length - 1 && (
                <Button onClick={() => go(steps[index + 1].key)}>
                  Next: {steps[index + 1].title}
                  <ArrowRight className="size-4" aria-hidden />
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function StepDot({ status }: { status: CrmSetupStatus }) {
  const Icon = STATUS_ICON[status];
  const color = { neutral: "text-muted", primary: "text-primary", success: "text-success", warning: "text-warning", danger: "text-danger", violet: "text-violet" }[CRM_SETUP_STATUS_TONE[status]];
  return (
    <span className={cn("flex shrink-0 items-center", color)} title={CRM_SETUP_STATUS_LABEL[status]}>
      <Icon className="size-4" aria-hidden />
      <span className="sr-only">{CRM_SETUP_STATUS_LABEL[status]}</span>
    </span>
  );
}

function SaveIndicator({ state, editable, onRetry }: { state: SaveState; editable: boolean; onRetry: () => void }) {
  if (!editable) return null;
  if (state === "saving") return <span className="inline-flex items-center gap-1.5 text-[12.5px] text-muted" role="status"><Loader2 className="size-3.5 animate-spin" aria-hidden />Saving…</span>;
  if (state === "error") {
    return (
      <span className="inline-flex items-center gap-2 text-[12.5px] text-danger" role="status">
        Couldn&apos;t save
        <Button size="sm" variant="secondary" onClick={onRetry}>Try again</Button>
      </span>
    );
  }
  return <span className="text-[12.5px] text-muted" role="status">{state === "saved" ? "All changes saved" : "Saves as you go"}</span>;
}

function Choice({ name, checked, onChange, disabled, label, hint, type = "radio" }: { name: string; checked: boolean; onChange: () => void; disabled: boolean; label: string; hint?: string; type?: "radio" | "checkbox" }) {
  return (
    <label className={cn("flex min-h-11 cursor-pointer items-start gap-2.5 rounded-xl border px-3 py-2.5 text-[13px]", checked ? "border-primary bg-primary-soft/40" : "border-line bg-surface", disabled && "cursor-default opacity-70")}>
      <input type={type} name={name} className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]" checked={checked} onChange={onChange} disabled={disabled} />
      <span className="min-w-0">
        <span className="block font-medium text-ink">{label}</span>
        {hint && <span className="mt-0.5 block text-[12px] leading-relaxed text-muted">{hint}</span>}
      </span>
    </label>
  );
}

function StepQuestions({ step, data, answers, editable, onAnswer, scope, saver, onProviderChosen }: {
  step: CrmSetupStep;
  data: CrmSetupGuideData;
  answers: CrmSetupAnswers;
  editable: boolean;
  onAnswer: (patch: CrmSetupAnswers) => void;
  scope: CrmScope;
  saver: GuideAutosave;
  onProviderChosen: () => void;
}) {
  const a = effectiveAnswers(data.facts, answers);
  return (
    <>
      {step.questions.includes("provider") && <ProviderChoice data={data} scope={scope} saver={saver} onChosen={onProviderChosen} />}
      {step.key === "provider" && !data.facts.provider.canChoose && data.facts.provider.lockedReason && (
        <p className="text-[12.5px] leading-relaxed text-muted">{data.facts.provider.lockedReason}</p>
      )}
      {step.questions.includes("appointments") && (
        <fieldset className="space-y-2">
          <legend className="mb-1 text-[13px] font-medium text-ink">Do customers book appointments with you?</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            <Choice name="appointments" checked={a.appointments === true} onChange={() => onAnswer({ appointments: true })} disabled={!editable} label="Yes, they book appointments" />
            <Choice name="appointments" checked={a.appointments === false} onChange={() => onAnswer({ appointments: false })} disabled={!editable} label="No, we don't take appointments" hint="The calendar and scheduling steps are skipped." />
          </div>
          {answers.appointments === undefined && data.facts.prefill.appointments !== null && <p className="text-[12px] text-muted">From your company onboarding answers.</p>}
        </fieldset>
      )}
      {step.questions.includes("calendarSource") && (
        <fieldset className="space-y-2">
          <legend className="mb-1 text-[13px] font-medium text-ink">Which calendar do you use?</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {CALENDAR_SOURCES.map((s: CalendarSource) => (
              <Choice key={s} name="calendarSource" checked={a.calendarSource === s} onChange={() => onAnswer({ calendarSource: s })} disabled={!editable} label={CALENDAR_SOURCE_LABEL[s]} />
            ))}
          </div>
        </fieldset>
      )}
      {step.questions.includes("channels") && (
        <fieldset className="space-y-2">
          <legend className="mb-1 text-[13px] font-medium text-ink">Which channels will you use with customers?</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {GUIDE_CHANNELS.map((c: GuideChannel) => {
              const on = (a.channels ?? []).includes(c);
              return (
                <Choice
                  key={c}
                  type="checkbox"
                  name={`channel-${c}`}
                  checked={on}
                  disabled={!editable}
                  label={GUIDE_CHANNEL_LABEL[c]}
                  onChange={() => onAnswer({ channels: on ? (a.channels ?? []).filter((x) => x !== c) : [...(a.channels ?? []), c] })}
                />
              );
            })}
          </div>
          {answers.channels === undefined && data.facts.prefill.channels.length > 0 && <p className="text-[12px] text-muted">From your company onboarding answers.</p>}
        </fieldset>
      )}
    </>
  );
}

function ProviderChoice({ data, scope, saver, onChosen }: { data: CrmSetupGuideData; scope: CrmScope; saver: GuideAutosave; onChosen: () => void }) {
  const current = data.facts.mode === "ghl" ? "ghl" : "native";
  const [picked, setPicked] = React.useState<"native" | "ghl">(current);
  const [busy, setBusy] = React.useState(false);
  const can = data.canChooseProvider && !scope.readOnly;
  const save = async () => {
    setBusy(true);
    // In the save queue, so the revision the choice returns is the one the next autosave sends.
    const res = await saver.action(() => chooseInitialCrmProviderAction(scope.orgId, picked), (r) => (r.ok ? r.data.revision : null));
    setBusy(false);
    if (!res.ok) return void toast.error(res.error);
    toast.success(res.data.changed ? `Your CRM is now ${CRM_MODE_LABELS[res.data.mode].label}.` : "Choice saved.");
    onChosen();
  };
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-[13px] font-medium text-ink">Which CRM should hold your records?</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        <Choice name="provider" checked={picked === "native"} onChange={() => setPicked("native")} disabled={!can} label={`${CRM_MODE_LABELS.native.label} (recommended)`} hint={CRM_MODE_LABELS.native.description} />
        <Choice name="provider" checked={picked === "ghl"} onChange={() => setPicked("ghl")} disabled={!can} label={CRM_MODE_LABELS.ghl.label} hint="Only if you already run your business in GoHighLevel. iAcquire connects your location; nothing is connected until it is verified." />
      </div>
      {can ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={save} loading={busy} disabled={picked === current && Boolean(data.facts.provider.chosenAt)}>
            {picked === current ? "Confirm this choice" : `Switch to ${CRM_MODE_LABELS[picked].label}`}
          </Button>
          <p className="text-[12px] text-muted">You can choose freely until the CRM holds records. After that, changes go through CRM Provider settings.</p>
        </div>
      ) : (
        <p className="text-[12px] text-muted">{data.facts.provider.canChoose ? "Only the workspace owner can choose the CRM provider." : ""}</p>
      )}
    </fieldset>
  );
}

function RecheckButton({ scope, enabled, onDone }: { scope: CrmScope; enabled: boolean; onDone: () => void }) {
  const [busy, setBusy] = React.useState(false);
  if (!enabled) return null;
  const run = async () => {
    setBusy(true);
    const res = await recheckCrmSetupAction(scope.orgId);
    setBusy(false);
    if (!res.ok) return void toast.error(res.error);
    toast.success(res.data.completed.length ? `Checked. Now complete: ${res.data.completed.join(", ")}.` : "Checked against your workspace's current records.");
    onDone();
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="secondary" onClick={run} loading={busy}>
        <RefreshCw className="size-4" aria-hidden />
        Check again
      </Button>
      <p className="text-[12px] text-muted">Uses what is already recorded; it never contacts a provider or sends anything.</p>
    </div>
  );
}

function ReviewHandOff({ scope, data, saver, onDone }: { scope: CrmScope; data: CrmSetupGuideData; saver: GuideAutosave; onDone: () => void }) {
  const [busy, setBusy] = React.useState(false);
  if (!data.canRequestReview || scope.readOnly) return null;
  const state = data.facts.setup.state;
  if (state === "activated" || state === "ready_for_review") return null;
  const run = async () => {
    setBusy(true);
    const res = await saver.action(() => requestCrmSetupReviewAction(scope.orgId), (r) => (r.ok ? r.data.revision : null));
    setBusy(false);
    if (!res.ok) return void toast.error(res.error);
    toast.success("iAcquire has been told. They'll review everything before activation.");
    onDone();
  };
  return (
    <div className="space-y-2 rounded-xl border border-line px-4 py-3">
      <p className="text-[13px] leading-relaxed text-ink-2">When you&apos;ve done your part, tell iAcquire. Their team runs the final checks and approves activation; nothing is switched on from here.</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={run} loading={busy}>
          <Send className="size-4" aria-hidden />
          Tell iAcquire we&apos;re ready
        </Button>
        {data.facts.setup.readyRequestedAt && <span className="text-[12px] text-muted">Last told {formatDateTime(data.facts.setup.readyRequestedAt, scope.timezone)}.</span>}
        <Link href="/setup" className="inline-flex items-center gap-1 text-[12.5px] font-medium text-primary underline-offset-2 hover:underline">
          Setup Center <ExternalLink className="size-3.5" aria-hidden />
        </Link>
      </div>
    </div>
  );
}
