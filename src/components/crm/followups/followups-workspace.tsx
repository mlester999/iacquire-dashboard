"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, CalendarClock, CircleSlash, Clock, Coins, Info, Mail, MessageCircle, MessageSquareText, Send, ShieldCheck, StopCircle, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Field, Input, Select } from "@/components/ui/primitives";
import { Switch } from "@/components/ui/overlays";
import { cn, formatDateTime } from "@/lib/utils";
import { RelativeTime } from "@/components/crm/relative-time";
import { formatUsd } from "@/lib/billing";
import { BLOCK_REASON_LABELS, CHANNEL_LABELS, MESSAGE_STATUS_LABELS, type Channel, type CustomFollowUp, type FollowUpPreset, type MessageStatus } from "@/lib/messaging";
import { ConfirmDialog, PageTitle, ReadOnlyNotice, useCrmAction } from "@/components/crm/ui";
import { saveFollowUpSettingsAction, stopContactFollowUpsAction } from "@/app/actions/crm-followups";
import {
  CUSTOM_CHANNELS, customFollowUpIssues, effectiveDays, estimateSequenceMicros, FOLLOW_UP_STYLES, MAX_GAP_DAYS, maxCustomAttempts, minGapDays, previewSchedule, sameCustomFollowUp,
} from "@/components/crm/followups/sequence";
import type { CrmScope } from "@/server/crm/page";
import type { FollowUpUpcomingView, FollowUpWorkspaceView } from "@/server/messaging/followups";

const CHANNEL_ICON: Record<Channel, React.ComponentType<{ className?: string }>> = { sms: MessageSquareText, whatsapp: MessageCircle, email: Mail };
const CHANNEL_CHOICE: Record<CustomFollowUp["channel"], string> = { same: "The channel they wrote on", sms: "SMS", whatsapp: "WhatsApp", email: "Email" };

/** Why a sequence or a step stopped, in plain words. Falls back to the send rule chain's own labels. */
const REASON_LABELS: Record<string, string> = {
  ...BLOCK_REASON_LABELS,
  customer_replied: "They replied",
  customer_booked: "They booked",
  customer_opted_out: "They opted out",
  consent_invalid: "Consent was withdrawn",
  human_took_over: "A person took over",
  budget_exhausted: "Credits or the spending limit ran out",
  automation_paused: "Automation was paused",
  contact_merged: "The contact was merged",
  privacy_request: "Privacy request",
  stopped_by_team: "Stopped by your team",
  followups_turned_off: "Follow-ups were switched off",
  followup_limit: "30-day follow-up limit reached",
  plan_closed: "The sequence had already ended",
  awaiting_approval: "Waiting for approval",
  preferred_channel_unreachable: "No address on the preferred channel, so it used theirs",
  window_expired: "The time window passed",
  conversation_closed: "The conversation was closed",
};
const reasonLabel = (r: string | null | undefined) => (r ? (REASON_LABELS[r] ?? r.replace(/_/g, " ")) : "");

function daysText(days: number[]): string {
  if (!days.length) return "No follow-ups";
  const list = days.length === 1 ? `day ${days[0]}` : `days ${days.slice(0, -1).join(", ")} and ${days[days.length - 1]}`;
  return `${days.length} follow-up${days.length === 1 ? "" : "s"}: ${list}`;
}

interface Draft {
  preset: FollowUpPreset;
  attempts: string;
  gaps: string[];
  channel: CustomFollowUp["channel"];
  businessHoursOnly: boolean;
}

function initialDraft(data: FollowUpWorkspaceView): Draft {
  const c = data.custom;
  const minGap = minGapDays(data.limits);
  const attempts = Math.max(1, Math.min(c?.attempts ?? 3, Math.max(1, maxCustomAttempts(data.limits))));
  const gaps = Array.from({ length: attempts }, (_, i) => String(c?.daysBetween[Math.min(i, (c?.daysBetween.length ?? 1) - 1)] ?? (i === 0 ? Math.max(1, minGap) : Math.max(3, minGap))));
  return { preset: data.preset, attempts: String(attempts), gaps, channel: c?.channel ?? "same", businessHoursOnly: c?.businessHoursOnly ?? true };
}

const toCustom = (d: Draft): CustomFollowUp => {
  const attempts = Number(d.attempts);
  return { attempts, daysBetween: d.gaps.slice(0, Math.max(1, attempts || 1)).map((g) => Number(g)), channel: d.channel, businessHoursOnly: d.businessHoursOnly };
};

export function FollowUpsWorkspace({ scope, data, nowIso, canConfigure, inboxLinks }: { scope: CrmScope; data: FollowUpWorkspaceView; nowIso: string; canConfigure: boolean; inboxLinks: boolean }) {
  const { run, busy } = useCrmAction();
  const [draft, setDraft] = React.useState<Draft>(() => initialDraft(data));
  const [confirmOff, setConfirmOff] = React.useState(false);
  const [stopping, setStopping] = React.useState<FollowUpUpcomingView | null>(null);
  const ids = React.useId();
  const limits = data.limits;
  const maxAttempts = maxCustomAttempts(limits);
  const minGap = minGapDays(limits);

  const custom = toCustom(draft);
  const issues = draft.preset === "custom" ? customFollowUpIssues(custom, limits) : [];
  const previewCustom = draft.preset === "custom" ? (issues.length ? null : custom) : data.custom;
  const preview = draft.preset === "custom" && issues.length ? null : previewSchedule({ preset: draft.preset, custom: previewCustom, limits, start: new Date(nowIso), timeZone: data.timezone, businessHours: data.businessHours });
  const stepCount = preview?.steps.length ?? 0;
  const dirty = draft.preset !== data.preset || (draft.preset === "custom" && !sameCustomFollowUp(custom, data.custom));
  const noBusinessHours = !Object.keys(data.businessHours).length;

  const setAttempts = (raw: string) => {
    const digits = raw.replace(/\D/g, "").slice(0, 2);
    setDraft((d) => {
      const n = Math.min(10, Number(digits) || 0);
      const gaps = n > 0 ? Array.from({ length: n }, (_, i) => d.gaps[i] ?? d.gaps[d.gaps.length - 1] ?? String(minGap)) : d.gaps;
      return { ...d, attempts: digits, gaps };
    });
  };

  async function save() {
    const out = await run(
      "save",
      () => saveFollowUpSettingsAction(scope.orgId, { preset: draft.preset, custom: draft.preset === "custom" ? custom : undefined }),
      (r) => (draft.preset === "off" ? `Follow-ups are off.${r.stoppedPlans ? ` ${r.stoppedPlans} running ${r.stoppedPlans === 1 ? "sequence was" : "sequences were"} stopped.` : ""}` : "Follow-up style saved. New sequences use it."),
    );
    if (out) setConfirmOff(false);
  }

  // One row per person: their next step, and how many are left after it.
  const people = React.useMemo(() => {
    const byContact = new Map<string, { next: FollowUpUpcomingView; remaining: number }>();
    for (const u of data.upcoming) {
      const cur = byContact.get(u.contactId);
      if (!cur) byContact.set(u.contactId, { next: u, remaining: 1 });
      else cur.remaining += 1;
    }
    return [...byContact.values()];
  }, [data.upcoming]);

  return (
    <div className="space-y-8">
      <PageTitle
        title="Follow-up sequences"
        description="When your AI employee has answered someone and they go quiet, it follows up a few times, spaced out, and stops the moment they reply, book, opt out or a person takes over. One allowance per person across SMS, WhatsApp and email."
      />
      {!canConfigure && <ReadOnlyNotice>{scope.agency ? "You can see follow-ups in this support session. The workspace's owner or a manager changes them." : "Only owners and managers can change how follow-ups work."}</ReadOnlyNotice>}

      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: "In a sequence now", value: data.stats.active, icon: Users },
          { label: "Started, last 30 days", value: data.stats.started30d, icon: CalendarClock },
          { label: "Follow-ups sent, last 30 days", value: data.stats.sent30d, icon: Send },
          { label: "Stopped, last 30 days", value: data.stats.stopped30d, icon: CircleSlash },
        ].map((s) => (
          <Card key={s.label} className="p-4">
            <dt className="flex items-center gap-1.5 text-[13px] text-muted"><s.icon className="size-3.5" aria-hidden />{s.label}</dt>
            <dd className="mt-1 text-[22px] font-semibold tabular-nums tracking-[-0.02em] text-ink">{s.value.toLocaleString("en-US")}</dd>
          </Card>
        ))}
      </dl>
      {(data.stats.stopReasons.length > 0 || data.stats.notStarted30d > 0 || data.stats.awaitingApproval > 0) && (
        <p className="-mt-5 text-[13px] leading-relaxed text-muted">
          {data.stats.stopReasons.length > 0 && <>Why sequences stopped: {data.stats.stopReasons.map((r) => `${reasonLabel(r.reason)} (${r.count})`).join(", ")}. </>}
          {data.stats.notStarted30d > 0 && <>{data.stats.notStarted30d} {data.stats.notStarted30d === 1 ? "person was" : "people were"} not followed up because they had already received the 30-day maximum. </>}
          {data.stats.awaitingApproval > 0 && <>{data.stats.awaitingApproval} follow-up {data.stats.awaitingApproval === 1 ? "message is" : "messages are"} waiting for approval in the Approval Center.</>}
        </p>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Follow-up style</CardTitle>
              <CardDescription>Applies to sequences that start after you save. Balanced is the default.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div role="radiogroup" aria-label="Follow-up style" className="grid gap-2 sm:grid-cols-2">
              {FOLLOW_UP_STYLES.map((s) => {
                const days = s.value === "custom" ? (data.custom ? effectiveDays("custom", data.custom, limits) : []) : effectiveDays(s.value, null, limits);
                return (
                  <button
                    key={s.value}
                    type="button"
                    role="radio"
                    aria-checked={draft.preset === s.value}
                    disabled={!canConfigure}
                    onClick={() => setDraft((d) => ({ ...d, preset: s.value }))}
                    className={cn(
                      "rounded-2xl border p-3 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-default",
                      draft.preset === s.value ? "border-primary bg-primary-soft/50" : "border-line bg-surface enabled:hover:border-line-strong",
                    )}
                  >
                    <span className="flex flex-wrap items-center gap-2 text-[14px] font-semibold text-ink">
                      {s.label}
                      {s.value === "balanced" && <Badge tone="neutral">Default</Badge>}
                      {data.preset === s.value && <Badge tone="success">Current</Badge>}
                    </span>
                    <span className="mt-1 block text-[13px] leading-relaxed text-muted">{s.description}</span>
                    {s.value !== "off" && (s.value !== "custom" || data.custom) && <span className="mt-1.5 block text-[12px] text-faint">With iAcquire&apos;s limits: {daysText(days)}</span>}
                  </button>
                );
              })}
            </div>

            {draft.preset === "custom" && (
              <fieldset disabled={!canConfigure} className="space-y-4 rounded-2xl border border-line p-4">
                <legend className="px-1 text-[14px] font-semibold text-ink">Your sequence</legend>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Number of follow-ups" htmlFor={`${ids}-attempts`} hint={`1 to ${maxAttempts}, iAcquire's limit.`}>
                    <Input id={`${ids}-attempts`} inputMode="numeric" value={draft.attempts} onChange={(e) => setAttempts(e.target.value)} />
                  </Field>
                  <Field label="Send on" htmlFor={`${ids}-channel`}>
                    <Select id={`${ids}-channel`} value={draft.channel} onChange={(e) => setDraft((d) => ({ ...d, channel: e.target.value as CustomFollowUp["channel"] }))}>
                      {CUSTOM_CHANNELS.map((c) => <option key={c} value={c}>{CHANNEL_CHOICE[c]}</option>)}
                    </Select>
                  </Field>
                </div>
                <div>
                  <p className="text-[14px] font-medium text-ink-2">Days to wait before each follow-up</p>
                  <p className="text-[13px] text-muted">Counted from the previous message. Whole days from {minGap} to {MAX_GAP_DAYS}.</p>
                  <ol className="mt-2 grid gap-2 sm:grid-cols-2">
                    {draft.gaps.slice(0, Math.max(1, Math.min(10, Number(draft.attempts) || 1))).map((g, i) => (
                      <li key={i} className="flex items-center gap-2 text-[14px]">
                        <label htmlFor={`${ids}-gap-${i}`} className="w-28 shrink-0 text-muted">Follow-up {i + 1}</label>
                        <Input
                          id={`${ids}-gap-${i}`}
                          inputMode="numeric"
                          className="w-20"
                          value={g}
                          onChange={(e) => {
                            const v = e.target.value.replace(/\D/g, "").slice(0, 2);
                            setDraft((d) => ({ ...d, gaps: d.gaps.map((x, j) => (j === i ? v : x)) }));
                          }}
                        />
                        <span className="text-muted">{g === "1" ? "day" : "days"} later</span>
                      </li>
                    ))}
                  </ol>
                </div>
                <label className="flex items-start justify-between gap-3 rounded-xl border border-line p-3 text-[14px]">
                  <span>
                    <span className="block font-medium text-ink">Only during business hours</span>
                    <span className="block text-[13px] text-muted">Off: any time outside quiet hours ({limits.quietHoursStart}–{limits.quietHoursEnd}).</span>
                  </span>
                  <Switch checked={draft.businessHoursOnly} onCheckedChange={(v) => setDraft((d) => ({ ...d, businessHoursOnly: v }))} aria-label="Only during business hours" />
                </label>
                {draft.channel === "whatsapp" && (
                  <p className="flex items-start gap-2 rounded-xl bg-warning-soft p-2.5 text-[13px] text-warning-ink">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                    WhatsApp only allows free-form messages within {limits.whatsappWindowHours} hours of the customer&apos;s last message, so later follow-ups on WhatsApp are blocked and recorded as such.
                  </p>
                )}
                {issues.length > 0 && (
                  <ul role="alert" className="list-disc space-y-0.5 rounded-xl bg-danger-soft py-2.5 pl-7 pr-3 text-[13px] text-danger-ink">
                    {issues.map((i) => <li key={i}>{i}</li>)}
                  </ul>
                )}
              </fieldset>
            )}

            {canConfigure && (
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  loading={busy("save")}
                  disabled={!dirty || issues.length > 0}
                  onClick={() => (draft.preset === "off" && data.preset !== "off" && data.stats.active > 0 ? setConfirmOff(true) : save())}
                >
                  Save follow-up style
                </Button>
                {dirty && <Button variant="ghost" onClick={() => setDraft(initialDraft(data))}>Discard changes</Button>}
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <div>
                <CardTitle className="flex items-center gap-2"><CalendarClock className="size-4" aria-hidden />Preview</CardTitle>
                <CardDescription>If someone stopped replying {formatDateTime(nowIso, data.timezone)} ({data.timezone}).</CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              {draft.preset === "off" ? (
                <p className="text-[14px] text-muted">No follow-ups are sent.</p>
              ) : !preview ? (
                <p className="text-[14px] text-muted">Fix the sequence to see its schedule.</p>
              ) : !preview.steps.length ? (
                <p className="text-[14px] text-muted">iAcquire&apos;s limits don&apos;t allow any follow-ups at the moment.</p>
              ) : (
                <ol className="space-y-2.5">
                  {preview.steps.map((s) => (
                    <li key={s.step} className="flex items-start gap-3">
                      <span aria-hidden className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary-soft text-[12px] font-semibold text-primary-ink">{s.step}</span>
                      <span className="min-w-0 text-[14px]">
                        <span className="block font-medium text-ink">Day {s.day}: {formatDateTime(s.sendAt, data.timezone)}</span>
                        {s.held && <span className="block text-[12px] text-muted">Due {formatDateTime(s.dueAt, data.timezone)}, held for {preview.businessHoursOnly ? "quiet or business hours" : "quiet hours"}</span>}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
              {draft.preset !== "off" && (
                <p className="mt-3 text-[12px] leading-relaxed text-faint">
                  Sent on {preview?.channel && preview.channel !== "same" ? CHANNEL_LABELS[preview.channel] : "the channel they wrote on"}. Times use your workspace&apos;s time zone; quiet hours follow the customer&apos;s own when we know it.
                  {noBusinessHours && preview?.businessHoursOnly ? " No business hours are set, so “business hours” means any time outside quiet hours." : ""}
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle className="flex items-center gap-2"><Coins className="size-4" aria-hidden />Cost per person</CardTitle>
                <CardDescription>From the usage rates iAcquire published for each channel&apos;s provider. Only follow-ups actually sent are charged; a reply stops the rest.</CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              <ul className="divide-y divide-line">
                {data.channels.map((c) => {
                  const Icon = CHANNEL_ICON[c.channel];
                  const one = estimateSequenceMicros(c.clientMicrosPerUnit, c.channel, data.businessName, 1);
                  const all = estimateSequenceMicros(c.clientMicrosPerUnit, c.channel, data.businessName, stepCount);
                  const chosen = draft.preset === "custom" && draft.channel === c.channel;
                  return (
                    <li key={c.channel} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-[14px]">
                      <span className="flex min-w-0 items-center gap-2">
                        <Icon className="size-4 text-muted" aria-hidden />
                        <span className="font-medium text-ink">{CHANNEL_LABELS[c.channel]}</span>
                        <span className="text-[12px] text-faint">{c.providerLabel}</span>
                        {!c.enabled && <Badge tone="neutral">Off</Badge>}
                        {chosen && <Badge tone="primary">Chosen</Badge>}
                      </span>
                      {one === null ? (
                        <span className="text-[13px] text-muted">Rate not published</span>
                      ) : (
                        <span className="text-right tabular-nums">
                          <span className="block text-ink">{formatUsd(one, { precise: true })} each</span>
                          {stepCount > 0 && <span className="block text-[12px] text-muted">{formatUsd(all ?? 0, { precise: true })} for all {stepCount}</span>}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
              <p className="mt-2 text-[12px] leading-relaxed text-faint">SMS is priced per segment of the standard follow-up text. Without a published rate nothing is estimated, and messages on that channel are held until iAcquire publishes one.</p>
            </CardContent>
          </Card>

          <div className="rounded-2xl bg-surface-2 p-4 text-[13px] leading-relaxed text-muted">
            <p className="flex items-center gap-1.5 font-medium text-ink"><ShieldCheck className="size-3.5" aria-hidden />iAcquire&apos;s safety limits always apply</p>
            <p className="mt-1">
              At most {limits.maxAttempts} follow-ups per sequence and {limits.maxPer30Days} per person in 30 days across all channels, at least {limits.minHoursBetween} hours apart, never during quiet hours ({limits.quietHoursStart}–{limits.quietHoursEnd}), never without consent, and never after a reply, an opt-out, a booking or a person taking over.
            </p>
          </div>
        </div>
      </div>

      <section aria-labelledby={`${ids}-upcoming`} className="space-y-3">
        <div>
          <h3 id={`${ids}-upcoming`} className="text-[15px] font-semibold text-ink">Coming up</h3>
          <p className="text-[13px] text-muted">Who gets a follow-up next. Each one is checked again against every rule at the moment it is due.</p>
        </div>
        {!data.canSeePeople ? (
          <ReadOnlyNotice>Who is in a sequence is visible to people who can see every conversation.</ReadOnlyNotice>
        ) : !people.length ? (
          <Card><EmptyState compact icon={<Clock className="size-5" />} title="Nobody is due a follow-up" description="When your AI employee answers someone and they go quiet, their sequence appears here." /></Card>
        ) : (
          <ul className="divide-y divide-line rounded-2xl border border-line bg-surface">
            {people.map(({ next, remaining }) => {
              const Icon = CHANNEL_ICON[next.channel];
              const waitingApproval = next.status === "queued" && next.messageStatus === "draft";
              return (
                <li key={next.contactId} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <Link href={`${scope.base}/contacts/${next.contactId}`} className="text-[14px] font-medium text-ink hover:text-primary">{next.contactName}</Link>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[13px] text-muted">
                      <span className="inline-flex items-center gap-1"><Icon className="size-3.5" aria-hidden />{CHANNEL_LABELS[next.channel]}</span>
                      <span>Follow-up {next.stepNumber} of {next.maxAttempts}</span>
                      <span>{next.status === "scheduled" ? `due ${formatDateTime(next.dueAt, scope.timezone)}` : waitingApproval ? "waiting for approval" : `queued${next.sendAfter ? ` for ${formatDateTime(next.sendAfter, scope.timezone)}` : ""}`}</span>
                      {remaining > 1 && <span>· {remaining - 1} more after this</span>}
                    </p>
                  </div>
                  {inboxLinks && <Link href={`/inbox?conversation=${next.conversationId}`} className="text-[13px] font-medium text-muted underline-offset-2 hover:text-ink hover:underline">Conversation</Link>}
                  {canConfigure && (
                    <Button variant="secondary" size="sm" onClick={() => setStopping(next)}><StopCircle className="size-3.5" aria-hidden />Stop follow-ups</Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {data.canSeePeople && (
        <section aria-labelledby={`${ids}-history`} className="space-y-3">
          <div>
            <h3 id={`${ids}-history`} className="text-[15px] font-semibold text-ink">Delivery history</h3>
            <p className="text-[13px] text-muted">Follow-ups from the last 30 days: what was sent and delivered, and what was held back and why.</p>
          </div>
          {!data.history.length ? (
            <Card><EmptyState compact icon={<Send className="size-5" />} title="No follow-ups in the last 30 days" /></Card>
          ) : (
            <ul className="divide-y divide-line rounded-2xl border border-line bg-surface">
              {data.history.map((h) => {
                const Icon = CHANNEL_ICON[h.channel];
                const status = h.messageStatus && h.stepStatus === "sent" ? (h.messageStatus as MessageStatus) : null;
                return (
                  <li key={h.stepId} className="grid gap-1 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-4">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link href={`${scope.base}/contacts/${h.contactId}`} className="text-[14px] font-medium text-ink hover:text-primary">{h.contactName}</Link>
                        {status ? (
                          <Badge tone={status === "failed" ? "danger" : status === "delivered" || status === "read" ? "success" : "primary"}>{MESSAGE_STATUS_LABELS[status] ?? status}</Badge>
                        ) : (
                          <Badge tone={h.stepStatus === "blocked" ? "warning" : "neutral"}>{h.stepStatus === "blocked" ? "Not sent" : h.stepStatus === "cancelled" ? "Cancelled" : "Skipped"}</Badge>
                        )}
                      </div>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[13px] text-muted">
                        <span className="inline-flex items-center gap-1"><Icon className="size-3.5" aria-hidden />{CHANNEL_LABELS[h.channel]}</span>
                        <span>Follow-up {h.stepNumber}</span>
                        {h.stepStatus !== "sent" && h.reason && <span>· {reasonLabel(h.reason)}</span>}
                        {status === "failed" && h.messageDetail && <span>· {h.messageDetail}</span>}
                        {inboxLinks && h.conversationId && <Link href={`/inbox?conversation=${h.conversationId}`} className="font-medium underline-offset-2 hover:text-ink hover:underline">Open conversation</Link>}
                      </p>
                    </div>
                    <RelativeTime iso={h.at} timezone={scope.timezone} className="text-[12px] text-faint sm:text-right" />
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      <p className="flex items-start gap-2 text-[13px] leading-relaxed text-muted">
        <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        Follow-ups go out under the AI employee that answered, through the same checks as every message: its mode (a draft for approval when it asks first), consent, opt-outs, quiet hours, credits and pauses.
      </p>

      <ConfirmDialog
        open={confirmOff}
        onOpenChange={setConfirmOff}
        title="Switch follow-ups off?"
        description={`${data.stats.active} ${data.stats.active === 1 ? "person is" : "people are"} in a sequence now. Their remaining follow-ups are cancelled, including any waiting for approval. Nothing new starts until you choose a style again.`}
        confirmLabel="Switch off and stop them"
        danger
        loading={busy("save")}
        onConfirm={save}
      />
      <ConfirmDialog
        open={!!stopping}
        onOpenChange={(o) => !o && setStopping(null)}
        title={`Stop follow-ups for ${stopping?.contactName ?? "this person"}?`}
        description="Their remaining follow-ups are cancelled, including one waiting for approval. A new sequence can start only after the AI employee answers them again."
        confirmLabel="Stop follow-ups"
        danger
        loading={busy("stop")}
        onConfirm={async () => {
          if (stopping && (await run("stop", () => stopContactFollowUpsAction(scope.orgId, stopping.contactId), "Follow-ups stopped."))) setStopping(null);
        }}
      />
    </div>
  );
}
