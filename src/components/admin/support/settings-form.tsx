"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { BellRing, CalendarClock, Check, ClipboardCheck, Clock3, FileUp, HeartHandshake, Plus, RotateCcw, Sparkles, Timer, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/primitives";
import { Switch } from "@/components/ui/overlays";
import { Notice, Panel, SaveBar, SettingRow } from "@/components/settings/panel";
import { setNotificationRuleAction, updateSettingsAction } from "@/app/actions/support-agency";
import {
  DELIVERY_MODES, MODE_LABELS, PRIORITIES, REQUEST_TYPES, REQUEST_TYPE_LABELS, SUPPORT_EVENTS, SUPPORT_EVENT_INFO, WEEKDAYS, WEEKDAY_LABELS,
  type BusinessHours, type DeliveryMode, type RequestType, type SupportEvent, type TicketPriority, type Weekday,
} from "@/lib/support/lifecycle";
import { describeTarget, type TargetMinutes } from "@/lib/support/sla";
import { sentenceCase } from "@/lib/utils";
import type { SupportSettings } from "@/server/support/settings";

type Windows = Array<[string, string]>;
interface Form {
  timezone: string;
  hours: Record<Weekday, Windows>;
  holidays: string[];
  targetsEnabled: boolean;
  showTargetsToClients: boolean;
  businessHoursOnly: boolean;
  first: Record<TicketPriority, string>;
  follow: Record<TicketPriority, string>;
  approachingPercent: string;
  overdueEscalationMinutes: string;
  reopenWindowDays: string;
  autoCloseResolvedDays: string;
  maxAttachmentMb: string;
  maxAttachmentsPerMessage: string;
  stagedUploadTtlHours: string;
  attachmentRetentionDays: string;
  defaultPriority: Record<RequestType, TicketPriority>;
  aiAssistEnabled: boolean;
  projectReviewTargetHours: string;
  showProjectTargetsToClients: boolean;
  projectPrerequisitesEnabled: boolean;
  surveysEnabled: boolean;
  surveyDelayHours: string;
}

const hoursOf = (b: BusinessHours): Record<Weekday, Windows> => Object.fromEntries(WEEKDAYS.map((d) => [d, (b[d] ?? []) as Windows])) as Record<Weekday, Windows>;
const mins = (t: TargetMinutes): Record<TicketPriority, string> => Object.fromEntries(PRIORITIES.map((p) => [p, t[p] ? String(t[p]) : ""])) as Record<TicketPriority, string>;
const toForm = (s: SupportSettings): Form => ({
  timezone: s.timezone, hours: hoursOf(s.businessHours), holidays: s.holidays, targetsEnabled: s.targetsEnabled, showTargetsToClients: s.showTargetsToClients, businessHoursOnly: s.businessHoursOnly,
  first: mins(s.firstResponseMinutes), follow: mins(s.followUpMinutes), approachingPercent: String(s.approachingPercent), overdueEscalationMinutes: s.overdueEscalationMinutes ? String(s.overdueEscalationMinutes) : "",
  reopenWindowDays: String(s.reopenWindowDays), autoCloseResolvedDays: s.autoCloseResolvedDays ? String(s.autoCloseResolvedDays) : "", maxAttachmentMb: String(s.maxAttachmentMb),
  maxAttachmentsPerMessage: String(s.maxAttachmentsPerMessage), stagedUploadTtlHours: String(s.stagedUploadTtlHours), attachmentRetentionDays: s.attachmentRetentionDays ? String(s.attachmentRetentionDays) : "",
  defaultPriority: s.defaultPriority, aiAssistEnabled: s.aiAssistEnabled,
  projectReviewTargetHours: s.projectReviewTargetHours ? String(s.projectReviewTargetHours) : "", showProjectTargetsToClients: s.showProjectTargetsToClients, projectPrerequisitesEnabled: s.projectPrerequisitesEnabled,
  surveysEnabled: s.surveysEnabled, surveyDelayHours: String(s.surveyDelayHours),
});

const num = (v: string) => (v.trim() === "" ? null : Number(v));

function targetsPatch(t: Record<TicketPriority, string>) {
  return Object.fromEntries(PRIORITIES.map((p) => [p, num(t[p])]));
}

/** Time zones the browser knows, with a few common ones first so the list is easy to use. */
function zones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf("timeZone");
  } catch {
    return ["UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Europe/London", "Europe/Berlin", "Asia/Manila", "Asia/Singapore", "Australia/Sydney"];
  }
}

export function SettingsForm({ settings, rules, emailMode, canEdit }: {
  settings: SupportSettings;
  rules: Array<{ event: SupportEvent; mode: DeliveryMode }>;
  emailMode: "capture" | "resend";
  canEdit: boolean;
}) {
  const router = useRouter();
  const [saved, setSaved] = React.useState(settings);
  const [form, setForm] = React.useState<Form>(() => toForm(settings));
  const [pending, setPending] = React.useState(false);
  const [modes, setModes] = React.useState(() => Object.fromEntries(rules.map((r) => [r.event, r.mode])) as Record<SupportEvent, DeliveryMode>);
  const [savingRule, setSavingRule] = React.useState<SupportEvent | null>(null);
  const [newHoliday, setNewHoliday] = React.useState("");
  const original = React.useMemo(() => JSON.stringify(toForm(saved)), [saved]);
  const dirty = JSON.stringify(form) !== original;
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));
  const tzList = React.useMemo(() => zones(), []);
  const cfg = { hours: Object.fromEntries(WEEKDAYS.filter((d) => form.hours[d].length).map((d) => [d, form.hours[d]])) as BusinessHours, businessHoursOnly: form.businessHoursOnly };

  const save = async () => {
    setPending(true);
    const res = await updateSettingsAction({
      timezone: form.timezone,
      businessHours: Object.fromEntries(WEEKDAYS.filter((d) => form.hours[d].length).map((d) => [d, form.hours[d]])),
      holidays: form.holidays,
      targetsEnabled: form.targetsEnabled,
      showTargetsToClients: form.showTargetsToClients,
      businessHoursOnly: form.businessHoursOnly,
      firstResponseMinutes: targetsPatch(form.first),
      followUpMinutes: targetsPatch(form.follow),
      approachingPercent: Number(form.approachingPercent),
      overdueEscalationMinutes: num(form.overdueEscalationMinutes),
      reopenWindowDays: Number(form.reopenWindowDays),
      autoCloseResolvedDays: num(form.autoCloseResolvedDays),
      maxAttachmentMb: Number(form.maxAttachmentMb),
      maxAttachmentsPerMessage: Number(form.maxAttachmentsPerMessage),
      stagedUploadTtlHours: Number(form.stagedUploadTtlHours),
      attachmentRetentionDays: num(form.attachmentRetentionDays),
      defaultPriority: form.defaultPriority,
      aiAssistEnabled: form.aiAssistEnabled,
      projectReviewTargetHours: num(form.projectReviewTargetHours),
      showProjectTargetsToClients: form.showProjectTargetsToClients,
      projectPrerequisitesEnabled: form.projectPrerequisitesEnabled,
      surveysEnabled: form.surveysEnabled,
      surveyDelayHours: Number(form.surveyDelayHours),
    }, saved.revision);
    setPending(false);
    if (!res.ok) {
      toast.error(res.error);
      if (res.code === "conflict") router.refresh();
      return;
    }
    setSaved(res.data);
    setForm(toForm(res.data));
    toast.success("Support settings saved");
  };

  const changeRule = async (event: SupportEvent, mode: DeliveryMode) => {
    const before = modes[event];
    setModes((m) => ({ ...m, [event]: mode }));
    setSavingRule(event);
    const res = await setNotificationRuleAction(event, mode);
    setSavingRule(null);
    if (!res.ok) {
      setModes((m) => ({ ...m, [event]: before }));
      toast.error(res.error);
      return;
    }
    toast.success(`${SUPPORT_EVENT_INFO[event].label}: ${MODE_LABELS[mode].toLowerCase()}`);
  };

  const TargetInput = ({ kind, p }: { kind: "first" | "follow"; p: TicketPriority }) => {
    const v = form[kind][p];
    const n = Number(v);
    return (
      <div className="min-w-0">
        <Input type="number" inputMode="numeric" min={1} max={43200} aria-label={`${kind === "first" ? "First response" : "Follow-up"} target for ${p} priority, in minutes`} disabled={!canEdit} placeholder="None" value={v}
          onChange={(e) => setForm((f) => ({ ...f, [kind]: { ...f[kind], [p]: e.target.value } }))} />
        <p className="mt-1 h-4 truncate text-[11.5px] text-muted">{v && Number.isFinite(n) && n > 0 ? describeTarget(n, cfg) : "No target"}</p>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {!canEdit && <Notice tone="neutral" icon={<Check />} role="status">You can see these settings, but only a Super Admin can change them.</Notice>}

      <Panel icon={<Timer />} title="Response expectations" description="What the team aims for, and whether clients are told. Targets are tracked only when you turn them on, and clients see a sentence only if you choose to show it. Nothing is promised that isn't configured here."
        footer={canEdit ? <SaveBar dirty={dirty} pending={pending} onSave={() => void save()} onReset={() => setForm(toForm(saved))} /> : undefined}>
        <div className="space-y-3">
          <SettingRow as="label" icon={<Timer />} title="Track response targets" description="Starts a response clock on each request and raises notices when a reply is due soon or overdue.">
            <Switch checked={form.targetsEnabled} disabled={!canEdit} onCheckedChange={(v) => set("targetsEnabled", v)} aria-label="Track response targets" />
          </SettingRow>
          <SettingRow as="label" icon={<Check />} title="Show expected response times to clients" description={<>Clients see a sentence such as &ldquo;We aim to reply within 1 business day.&rdquo; An acknowledgement is never worded as a reply.</>}>
            <Switch checked={form.showTargetsToClients} disabled={!canEdit || !form.targetsEnabled} onCheckedChange={(v) => set("showTargetsToClients", v)} aria-label="Show expected response times to clients" />
          </SettingRow>
        </div>

        <div className="mt-6">
          <h3 className="text-[13.5px] font-semibold text-ink">Targets by priority</h3>
          <p className="mt-1 text-[12.5px] text-muted">In minutes of support time{form.businessHoursOnly ? " (opening hours only)" : " (around the clock)"}. Leave a priority empty for no target.</p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-[13px]"><caption className="sr-only">Response targets by priority</caption>
              <thead><tr className="text-[11.5px] uppercase tracking-wide text-muted"><th scope="col" className="w-32 py-2 pr-3 font-medium">Priority</th><th scope="col" className="py-2 pr-3 font-medium">First reply</th><th scope="col" className="py-2 font-medium">Later replies</th></tr></thead>
              <tbody className="divide-y divide-line">{PRIORITIES.map((p) => (<tr key={p}><th scope="row" className="py-3 pr-3 align-top font-medium text-ink">{sentenceCase(p)}</th><td className="py-3 pr-3 align-top"><TargetInput kind="first" p={p} /></td><td className="py-3 align-top"><TargetInput kind="follow" p={p} /></td></tr>))}</tbody>
            </table>
          </div>
        </div>

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5"><Label htmlFor="s-approach">Warn when this much of the target has passed</Label><div className="flex items-center gap-2"><Input id="s-approach" type="number" min={50} max={95} className="w-24" disabled={!canEdit} value={form.approachingPercent} onChange={(e) => set("approachingPercent", e.target.value)} /><span className="text-[13px] text-muted">%</span></div></div>
          <div className="space-y-1.5"><Label htmlFor="s-esc">Escalate when overdue by</Label><div className="flex items-center gap-2"><Input id="s-esc" type="number" min={1} max={43200} className="w-28" disabled={!canEdit} placeholder="Off" value={form.overdueEscalationMinutes} onChange={(e) => set("overdueEscalationMinutes", e.target.value)} /><span className="text-[13px] text-muted">minutes (empty = never)</span></div><p className="text-[12px] text-muted">Flags the request for managers. It doesn&apos;t change the priority.</p></div>
        </div>
      </Panel>

      <Panel icon={<CalendarClock />} title="Support hours" description="Used to count response targets. Outside these hours the clock doesn't run."
        footer={canEdit ? <SaveBar dirty={dirty} pending={pending} onSave={() => void save()} onReset={() => setForm(toForm(saved))} /> : undefined}>
        <div className="space-y-4">
          <SettingRow as="label" icon={<Clock3 />} title="Count opening hours only" description="Off means targets run around the clock, weekends and holidays included.">
            <Switch checked={form.businessHoursOnly} disabled={!canEdit} onCheckedChange={(v) => set("businessHoursOnly", v)} aria-label="Count opening hours only" />
          </SettingRow>
          <div className="space-y-1.5 sm:max-w-sm"><Label htmlFor="s-tz">Time zone</Label>
            <Select id="s-tz" disabled={!canEdit} value={form.timezone} onChange={(e) => set("timezone", e.target.value)}>{[...new Set([form.timezone, ...tzList])].map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}</Select></div>
          <fieldset disabled={!canEdit || !form.businessHoursOnly} className="space-y-2 disabled:opacity-60">
            <legend className="mb-1 text-[13px] font-medium text-ink-2">Weekly opening hours</legend>
            {WEEKDAYS.map((d) => {
              const w = form.hours[d];
              return (
                <div key={d} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line bg-surface px-3 py-2.5">
                  <span className="w-24 text-[13.5px] font-medium text-ink">{WEEKDAY_LABELS[d]}</span>
                  {w.length === 0 ? <span className="text-[13px] text-muted">Closed</span> : w.map((win, i) => (
                    <span key={i} className="inline-flex items-center gap-1.5">
                      <Input type="time" aria-label={`${WEEKDAY_LABELS[d]} opens`} className="w-[7.5rem]" value={win[0]} onChange={(e) => setForm((f) => ({ ...f, hours: { ...f.hours, [d]: f.hours[d].map((x, j) => (j === i ? [e.target.value, x[1]] : x)) as Windows } }))} />
                      <span className="text-muted">to</span>
                      <Input type="time" aria-label={`${WEEKDAY_LABELS[d]} closes`} className="w-[7.5rem]" value={win[1]} onChange={(e) => setForm((f) => ({ ...f, hours: { ...f.hours, [d]: f.hours[d].map((x, j) => (j === i ? [x[0], e.target.value] : x)) as Windows } }))} />
                      <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${WEEKDAY_LABELS[d]} window ${i + 1}`} onClick={() => setForm((f) => ({ ...f, hours: { ...f.hours, [d]: f.hours[d].filter((_, j) => j !== i) } }))}><Trash2 className="size-4" /></Button>
                    </span>
                  ))}
                  {w.length < 3 && <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={() => setForm((f) => ({ ...f, hours: { ...f.hours, [d]: [...f.hours[d], w.length ? ["13:00", "17:00"] : ["09:00", "17:00"]] as Windows } }))}><Plus className="size-3.5" aria-hidden /> {w.length ? "Add window" : "Open"}</Button>}
                </div>
              );
            })}
          </fieldset>
          <div>
            <h3 className="text-[13.5px] font-semibold text-ink">Holidays</h3>
            <p className="mt-1 text-[12.5px] text-muted">Days with no support hours, in the time zone above.</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {form.holidays.map((h) => <span key={h} className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 py-1 pl-3 pr-1 text-[12.5px] ring-1 ring-inset ring-line">{h}<button type="button" disabled={!canEdit} aria-label={`Remove ${h}`} className="grid size-6 place-items-center rounded-full hover:bg-surface-3" onClick={() => set("holidays", form.holidays.filter((x) => x !== h))}><Trash2 className="size-3" /></button></span>)}
              {form.holidays.length === 0 && <span className="text-[13px] text-muted">None added.</span>}
            </div>
            {canEdit && <div className="mt-2 flex items-center gap-2"><Input type="date" aria-label="Add a holiday" className="w-44" value={newHoliday} onChange={(e) => setNewHoliday(e.target.value)} /><Button type="button" variant="secondary" size="sm" disabled={!newHoliday || form.holidays.includes(newHoliday)} onClick={() => { set("holidays", [...form.holidays, newHoliday].sort()); setNewHoliday(""); }}><Plus className="size-3.5" aria-hidden /> Add</Button></div>}
          </div>
        </div>
      </Panel>

      <Panel icon={<BellRing />} tone="violet" title="Notifications" description="Choose how each update is delivered. Each change saves immediately. People are only ever told about requests they're entitled to see, and internal notes never appear in any notification.">
        <div className="space-y-3">
          <Notice tone={emailMode === "capture" ? "warning" : "success"} icon={<BellRing />} role="status">
            {emailMode === "capture"
              ? "This server is in email capture mode: email notifications are recorded but not sent to anyone. In-app notifications work normally."
              : "Email is delivered through the connected email provider. A message is recorded as â€œsentâ€ once the provider accepts it; that is not a delivery receipt."}
          </Notice>
          <div className="overflow-x-auto rounded-2xl border border-line">
            <table className="w-full min-w-[640px] text-left text-[13px]"><caption className="sr-only">How each support update is delivered</caption>
              <thead className="bg-surface-2/60 text-[11.5px] uppercase tracking-wide text-muted"><tr><th scope="col" className="px-4 py-2.5 font-medium">Update</th><th scope="col" className="px-4 py-2.5 font-medium">Who is told</th><th scope="col" className="w-44 px-4 py-2.5 font-medium">Delivery</th></tr></thead>
              <tbody className="divide-y divide-line">{SUPPORT_EVENTS.map((e) => (
                <tr key={e}><th scope="row" className="px-4 py-3 align-top font-medium text-ink">{SUPPORT_EVENT_INFO[e].label}</th><td className="px-4 py-3 align-top text-muted">{SUPPORT_EVENT_INFO[e].recipients}</td>
                  <td className="px-4 py-3 align-top"><Select aria-label={`Delivery for: ${SUPPORT_EVENT_INFO[e].label}`} disabled={!canEdit || savingRule === e} value={modes[e]} onChange={(ev) => void changeRule(e, ev.target.value as DeliveryMode)}>{DELIVERY_MODES.map((m) => <option key={m} value={m}>{MODE_LABELS[m]}</option>)}</Select></td></tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      </Panel>

      <Panel icon={<RotateCcw />} tone="success" title="Reopening, closing and defaults" description="How long a client can reopen a resolved request, when resolved requests close on their own, and the priority new requests start with."
        footer={canEdit ? <SaveBar dirty={dirty} pending={pending} onSave={() => void save()} onReset={() => setForm(toForm(saved))} /> : undefined}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5"><Label htmlFor="s-reopen">Clients can reopen a resolved request for</Label><div className="flex items-center gap-2"><Input id="s-reopen" type="number" min={0} max={365} className="w-24" disabled={!canEdit} value={form.reopenWindowDays} onChange={(e) => set("reopenWindowDays", e.target.value)} /><span className="text-[13px] text-muted">days (0 = never)</span></div></div>
          <div className="space-y-1.5"><Label htmlFor="s-auto">Close resolved requests automatically after</Label><div className="flex items-center gap-2"><Input id="s-auto" type="number" min={1} max={90} className="w-24" disabled={!canEdit} placeholder="Never" value={form.autoCloseResolvedDays} onChange={(e) => set("autoCloseResolvedDays", e.target.value)} /><span className="text-[13px] text-muted">days (empty = never)</span></div></div>
          {REQUEST_TYPES.map((t) => (
            <div key={t} className="space-y-1.5"><Label htmlFor={`s-pri-${t}`}>Starting priority for {REQUEST_TYPE_LABELS[t].label.toLowerCase()}</Label>
              <Select id={`s-pri-${t}`} disabled={!canEdit} value={form.defaultPriority[t]} onChange={(e) => set("defaultPriority", { ...form.defaultPriority, [t]: e.target.value as TicketPriority })}>{PRIORITIES.map((p) => <option key={p} value={p}>{sentenceCase(p)}</option>)}</Select></div>
          ))}
        </div>
        <p className="mt-3 text-[12px] text-muted">Clients never set the priority; the team does. A client&apos;s own description of impact is shown to the team separately.</p>
      </Panel>

      <Panel icon={<FileUp />} tone="warning" title="Attachments" description="Files are stored privately, checked against their real content, and downloaded rather than opened in the portal. There is no virus-scanning service connected, so only non-executable document and image types are accepted."
        footer={canEdit ? <SaveBar dirty={dirty} pending={pending} onSave={() => void save()} onReset={() => setForm(toForm(saved))} /> : undefined}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5"><Label htmlFor="s-mb">Largest file</Label><div className="flex items-center gap-2"><Input id="s-mb" type="number" min={1} max={10} className="w-24" disabled={!canEdit} value={form.maxAttachmentMb} onChange={(e) => set("maxAttachmentMb", e.target.value)} /><span className="text-[13px] text-muted">MB (up to 10)</span></div></div>
          <div className="space-y-1.5"><Label htmlFor="s-files">Files per message</Label><Input id="s-files" type="number" min={1} max={10} className="w-24" disabled={!canEdit} value={form.maxAttachmentsPerMessage} onChange={(e) => set("maxAttachmentsPerMessage", e.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor="s-ttl">Remove files that were never sent after</Label><div className="flex items-center gap-2"><Input id="s-ttl" type="number" min={1} max={168} className="w-24" disabled={!canEdit} value={form.stagedUploadTtlHours} onChange={(e) => set("stagedUploadTtlHours", e.target.value)} /><span className="text-[13px] text-muted">hours</span></div></div>
          <div className="space-y-1.5"><Label htmlFor="s-ret">Delete files of closed requests after</Label><div className="flex items-center gap-2"><Input id="s-ret" type="number" min={30} max={3650} className="w-28" disabled={!canEdit} placeholder="Keep" value={form.attachmentRetentionDays} onChange={(e) => set("attachmentRetentionDays", e.target.value)} /><span className="text-[13px] text-muted">days (empty = keep)</span></div></div>
        </div>
      </Panel>

      <Panel icon={<ClipboardCheck />} tone="primary" title="Custom projects" description="Two switches for custom projects, both off until you choose. Nothing here prices a project, charges anyone or detects a payment: a person writes down what they checked."
        footer={canEdit ? <SaveBar dirty={dirty} pending={pending} onSave={() => void save()} onReset={() => setForm(toForm(saved))} /> : undefined}>
        <SettingRow as="label" icon={<ClipboardCheck />} title="Ask for the agreement and the payment before work starts" description="When a client accepts a quote, the project asks for the written agreement and, if the quote has payment terms, the payment to be confirmed by a person. Work can't start until they are confirmed or waived with a reason.">
          <Switch checked={form.projectPrerequisitesEnabled} disabled={!canEdit} onCheckedChange={(v) => set("projectPrerequisitesEnabled", v)} aria-label="Ask for the agreement and the payment before work starts" />
        </SettingRow>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5"><Label htmlFor="s-ptarget">Aim to look at a new project request or change request within</Label><div className="flex items-center gap-2"><Input id="s-ptarget" type="number" min={1} max={720} className="w-24" disabled={!canEdit} placeholder="Two days" value={form.projectReviewTargetHours} onChange={(e) => set("projectReviewTargetHours", e.target.value)} /><span className="text-[13px] text-muted">hours</span></div><p className="text-[12px] text-muted">Leave empty for the default of two days. The team is told when a review passes its time.</p></div>
          <SettingRow as="label" icon={<Clock3 />} title="Tell clients this target" description="Shows the sentence on a new project request. Needs a target above.">
            <Switch checked={form.showProjectTargetsToClients} disabled={!canEdit} onCheckedChange={(v) => set("showProjectTargetsToClients", v)} aria-label="Tell clients the project review target" />
          </SettingRow>
        </div>
      </Panel>

      <Panel icon={<HeartHandshake />} tone="violet" title="Satisfaction survey" description="One short question after a request is resolved. Off until you choose; it appears inside the client's own request, never by email or text, and only the person who opened the request can answer it."
        footer={canEdit ? <SaveBar dirty={dirty} pending={pending} onSave={() => void save()} onReset={() => setForm(toForm(saved))} /> : undefined}>
        <SettingRow as="label" icon={<HeartHandshake />} title="Ask how it went after a request is resolved" description="Shows a one-to-five rating, whether the reply helped and an optional comment on the resolved request. A request is asked once; an answered survey never changes.">
          <Switch checked={form.surveysEnabled} disabled={!canEdit} onCheckedChange={(v) => set("surveysEnabled", v)} aria-label="Ask how it went after a request is resolved" />
        </SettingRow>
        <div className="mt-4 max-w-sm space-y-1.5"><Label htmlFor="s-sdelay">Show the survey after</Label><div className="flex items-center gap-2"><Input id="s-sdelay" type="number" min={0} max={720} className="w-24" disabled={!canEdit || !form.surveysEnabled} value={form.surveyDelayHours} onChange={(e) => set("surveyDelayHours", e.target.value)} /><span className="text-[13px] text-muted">hours</span></div><p className="text-[12px] text-muted">The request is already resolved; this leaves time for the customer to reply first. It stays open for 14 days.</p></div>
      </Panel>

      <Panel icon={<Sparkles />} tone="violet" title="AI help" description="Optional help for clients writing a request and for the team reading one: clearer wording, summaries, reply drafts. It uses the AI connection already set up in Integrations, only ever suggests, and never sends, closes, assigns or promises anything."
        footer={canEdit ? <SaveBar dirty={dirty} pending={pending} onSave={() => void save()} onReset={() => setForm(toForm(saved))} /> : undefined}>
        <SettingRow as="label" icon={<Sparkles />} title="Allow AI help on requests" description="Turn this off to remove every AI button from the request pages.">
          <Switch checked={form.aiAssistEnabled} disabled={!canEdit} onCheckedChange={(v) => set("aiAssistEnabled", v)} aria-label="Allow AI help on requests" />
        </SettingRow>
      </Panel>
    </div>
  );
}

