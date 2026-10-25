"use client";

import * as React from "react";
import { CALL_CLASSES, CALL_CLASS_LABELS } from "@/lib/missed-calls/state";
import { LEAD_LABELS, LEAD_LABEL_TEXT } from "@/lib/lead-scoring/types";
import { AlertTriangle, Copy, RefreshCw, Zap } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { CHANNEL_LABELS } from "@/lib/messaging";
import { idleLabel } from "@/lib/inbox";
import { EMPTY_FILTER } from "@/lib/crm/filters";
import { CREATED_VIA, CREATED_VIA_LABELS } from "@/lib/crm/types";
import { CALL_TRIGGER_STATUSES, CONVERSATION_IDLE_HOURS, TRIGGERS, TRIGGER_TYPES, type TriggerConfig, type TriggerFilters, type TriggerType, type ValidationIssue } from "@/lib/crm/workflow/spec";
import { CALL_STATUS_LABELS } from "@/components/crm/calls/model";
import { Choice, MultiPick, SinglePick, Toggle, WeekdayPick } from "@/components/crm/workflows/pickers";
import { ConditionsEditor } from "@/components/crm/workflows/step-panel";
import type { EditorOptions } from "@/components/crm/workflows/types";

/** Contact details whose changes a "Contact details changed" trigger can watch, as the contact record reports them. */
export const CHANGED_FIELD_CHOICES: Array<{ key: string; label: string }> = [
  { key: "firstName", label: "First name" }, { key: "lastName", label: "Last name" }, { key: "email", label: "Email" }, { key: "phone", label: "Phone" },
  { key: "leadStatus", label: "Lead status" }, { key: "leadScore", label: "Lead score" }, { key: "source", label: "Lead source" }, { key: "preferredChannel", label: "Preferred channel" },
  { key: "city", label: "City" }, { key: "region", label: "Region" }, { key: "country", label: "Country" }, { key: "postalCode", label: "Postal code" },
  { key: "addressLine1", label: "Address" }, { key: "timezone", label: "Time zone" }, { key: "preferredLanguage", label: "Language" },
];

const GROUPS = ["Contacts", "Deals", "Appointments", "Tasks", "Conversations", "Growth", "Other"] as const;

export interface TriggerPanelProps {
  trigger: TriggerConfig;
  options: EditorOptions;
  issues: ValidationIssue[];
  readOnly: boolean;
  /** The published version's inbound URL, when the server has one to show. */
  inboundUrl: string | null;
  /** A URL exists but this person may not see it (it starts runs, so only people who can change the workflow do). */
  inboundHidden?: boolean;
  onChange: (t: TriggerConfig) => void;
}

/** What starts the workflow: the event (or schedule, or webhook), its filters, who it runs for, and whether a contact can go through again. */
export function TriggerPanel({ trigger, options, issues, readOnly, inboundUrl, inboundHidden = false, onChange }: TriggerPanelProps) {
  const spec = TRIGGERS[trigger.type];
  const errorAt = (path: string) => issues.find((i) => i.path === path || i.path?.startsWith(`${path}.`))?.message ?? null;
  const general = issues.filter((i) => !i.path || !TRIGGER_PATHS.some((p) => i.path!.startsWith(p)));
  const filters = trigger.filters ?? {};
  const setFilter = <K extends keyof TriggerFilters>(key: K, value: TriggerFilters[K] | undefined) => {
    const next: TriggerFilters = { ...filters };
    const empty = value === undefined || (Array.isArray(value) && !value.length);
    if (empty) delete next[key];
    else next[key] = value;
    onChange({ ...trigger, filters: Object.keys(next).length ? next : undefined });
  };
  const changeType = (type: TriggerType) => {
    const s = TRIGGERS[type];
    // Keep only what the new trigger understands.
    const kept: TriggerFilters = {};
    for (const k of s.filters) if (filters[k] !== undefined) (kept as Record<string, unknown>)[k] = filters[k];
    onChange({
      type,
      ...(Object.keys(kept).length ? { filters: kept } : {}),
      ...(s.carries.contact !== "never" && trigger.contactFilter ? { contactFilter: trigger.contactFilter } : {}),
      ...(s.carries.contact !== "never" && trigger.reentry ? { reentry: trigger.reentry } : {}),
      ...(type === "schedule" ? { schedule: trigger.schedule ?? { frequency: "daily", time: "09:00" } } : {}),
      ...(type === "inbound_webhook" ? { inbound: trigger.inbound ?? { nonce: newNonce(), match: "email_or_phone", createContact: false } } : {}),
    });
  };
  const stagesIn = (pipelineId?: string) =>
    options.pipelines.filter((p) => !pipelineId || p.id === pipelineId).flatMap((p) => p.stages.map((s) => ({ id: s.id, label: s.name, hint: pipelineId ? undefined : p.name })));

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3">
        <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-ink text-surface dark:bg-ink dark:text-bg"><Zap className="size-4" aria-hidden /></span>
        <div className="min-w-0">
          <p className="text-[12px] font-semibold uppercase tracking-wider text-faint">Trigger</p>
          <h3 className="text-[16px] font-semibold text-ink">{spec.label}</h3>
          <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{spec.description}</p>
        </div>
      </div>
      {general.length > 0 && (
        <ul className="space-y-1.5" aria-label="Problems with the trigger">
          {general.map((i, n) => (
            <li key={`${i.code}-${n}`} className={cn("flex gap-2 rounded-xl px-3 py-2 text-[13px]", i.level === "error" ? "bg-danger-soft text-danger-ink" : "bg-warning-soft text-warning-ink")}>
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />{i.message}
            </li>
          ))}
        </ul>
      )}

      <fieldset disabled={readOnly} className="min-w-0 space-y-4">
        <legend className="sr-only">Trigger settings</legend>
        <Field label="Starts when" htmlFor="wf-trigger-type" error={errorAt("trigger.type")}>
          <Select id="wf-trigger-type" value={trigger.type} onChange={(e) => changeType(e.target.value as TriggerType)}>
            {GROUPS.map((g) => (
              <optgroup key={g} label={g}>
                {TRIGGER_TYPES.filter((t) => TRIGGERS[t].group === g).map((t) => <option key={t} value={t}>{TRIGGERS[t].label}</option>)}
              </optgroup>
            ))}
          </Select>
        </Field>

        {spec.filters.includes("createdVia") && (
          <Field label="Only when created via" optional error={errorAt("trigger.filters.createdVia")} hint="None chosen means any way.">
            <MultiPick id="wf-tr-via" label="Created via" options={CREATED_VIA.map((v) => ({ id: v, label: CREATED_VIA_LABELS[v] }))} value={filters.createdVia ?? []} onChange={(v) => setFilter("createdVia", v as TriggerFilters["createdVia"])} empty="" />
          </Field>
        )}
        {spec.filters.includes("changedFields") && (
          <Field label="Only when these change" optional error={errorAt("trigger.filters.changedFields")} hint="None chosen means any change.">
            <MultiPick
              id="wf-tr-changed"
              label="Changed fields"
              max={30}
              options={[...CHANGED_FIELD_CHOICES.map((c) => ({ id: c.key, label: c.label })), ...options.contactFields.map((f) => ({ id: `cf:${f.key}`, label: f.label, hint: "custom" }))]}
              value={filters.changedFields ?? []}
              onChange={(v) => setFilter("changedFields", v)}
              empty=""
            />
          </Field>
        )}
        {spec.filters.includes("tagIds") && (
          <Field label={trigger.type === "contact.tag_removed" ? "Only these tags removed" : "Only these tags added"} optional error={errorAt("trigger.filters.tagIds")} hint="None chosen means any tag.">
            <MultiPick id="wf-tr-tags" label="Tags" max={20} options={options.tags.map((t) => ({ id: t.id, label: t.name, color: t.color }))} value={filters.tagIds ?? []} onChange={(v) => setFilter("tagIds", v)} empty="There are no tags yet." />
          </Field>
        )}
        {spec.filters.includes("assigneeIds") && (
          <Field label={spec.entity === "task" ? "Only tasks for" : "Only when assigned to"} optional error={errorAt("trigger.filters.assigneeIds")} hint="None chosen means anyone.">
            <MultiPick id="wf-tr-assignees" label="People" options={options.members.map((m) => ({ id: m.id, label: m.name }))} value={filters.assigneeIds ?? []} onChange={(v) => setFilter("assigneeIds", v)} empty="There's nobody to choose." />
          </Field>
        )}
        {spec.filters.includes("pipelineId") && (
          <Field label="Pipeline" htmlFor="wf-tr-pipe" optional error={errorAt("trigger.filters.pipelineId")}>
            <SinglePick
              id="wf-tr-pipe"
              value={filters.pipelineId}
              onChange={(v) => {
                const next: TriggerFilters = { ...filters, pipelineId: v ?? undefined };
                // Stages from another pipeline no longer apply.
                if (v) {
                  const ok = new Set(stagesIn(v).map((s) => s.id));
                  if (next.stageIds) next.stageIds = next.stageIds.filter((s) => ok.has(s));
                  if (next.fromStageIds) next.fromStageIds = next.fromStageIds.filter((s) => ok.has(s));
                }
                for (const k of ["pipelineId", "stageIds", "fromStageIds"] as const) if (!next[k] || (Array.isArray(next[k]) && !(next[k] as string[]).length)) delete next[k];
                onChange({ ...trigger, filters: Object.keys(next).length ? next : undefined });
              }}
              options={options.pipelines.map((p) => ({ id: p.id, label: p.name }))}
              placeholder="Any pipeline"
            />
          </Field>
        )}
        {spec.filters.includes("stageIds") && (
          <Field label={trigger.type === "opportunity.stage_changed" ? "Moved into" : "In stage"} optional error={errorAt("trigger.filters.stageIds")} hint="None chosen means any stage.">
            <MultiPick id="wf-tr-stages" label="Stages" options={stagesIn(filters.pipelineId)} value={filters.stageIds ?? []} onChange={(v) => setFilter("stageIds", v)} empty="There are no stages yet." />
          </Field>
        )}
        {spec.filters.includes("fromStageIds") && (
          <Field label="Moved out of" optional error={errorAt("trigger.filters.fromStageIds")} hint="None chosen means any stage.">
            <MultiPick id="wf-tr-from" label="Stages" options={stagesIn(filters.pipelineId)} value={filters.fromStageIds ?? []} onChange={(v) => setFilter("fromStageIds", v)} empty="There are no stages yet." />
          </Field>
        )}
        {spec.filters.includes("calendarIds") && (
          <Field label="Calendars" optional error={errorAt("trigger.filters.calendarIds")} hint="None chosen means any calendar.">
            <MultiPick id="wf-tr-cal" label="Calendars" options={options.calendars.map((c) => ({ id: c.id, label: c.name }))} value={filters.calendarIds ?? []} onChange={(v) => setFilter("calendarIds", v)} empty="There are no calendars yet." />
          </Field>
        )}
        {spec.filters.includes("appointmentTypeIds") && (
          <Field label="Appointment types" optional error={errorAt("trigger.filters.appointmentTypeIds")} hint="None chosen means any type.">
            <MultiPick
              id="wf-tr-types"
              label="Appointment types"
              options={options.appointmentTypes.filter((t) => !filters.calendarIds?.length || (t.calendarId && filters.calendarIds.includes(t.calendarId))).map((t) => ({ id: t.id, label: t.name, hint: options.calendars.find((c) => c.id === t.calendarId)?.name }))}
              value={filters.appointmentTypeIds ?? []}
              onChange={(v) => setFilter("appointmentTypeIds", v)}
              empty="There are no appointment types yet."
            />
          </Field>
        )}
        {spec.filters.includes("formIds") && (
          <Field label="Forms" optional error={errorAt("trigger.filters.formIds")} hint="None chosen means any form or survey.">
            <MultiPick
              id="wf-tr-forms"
              label="Forms"
              options={(options.forms ?? []).map((f) => ({ id: f.id, label: f.name, hint: f.status === "published" ? undefined : "Not live" }))}
              value={filters.formIds ?? []}
              onChange={(v) => setFilter("formIds", v)}
              empty="There are no forms yet. Build one in CRM → Forms."
            />
          </Field>
        )}
        {spec.filters.includes("channels") && (
          <Field label="Channels" optional error={errorAt("trigger.filters.channels")} hint="None chosen means any channel.">
            <MultiPick id="wf-tr-channels" label="Channels" options={(["sms", "whatsapp", "email"] as const).map((c) => ({ id: c, label: CHANNEL_LABELS[c] }))} value={filters.channels ?? []} onChange={(v) => setFilter("channels", v as TriggerFilters["channels"])} empty="" />
          </Field>
        )}
        {spec.filters.includes("idleHours") && (
          <Field label="Quiet for" error={errorAt("trigger.filters.idleHours")} hint="Starts once for each time you choose, when an open conversation has had no message for that long. A customer who writes again starts the count over.">
            <MultiPick id="wf-tr-idle" label="Quiet for" options={CONVERSATION_IDLE_HOURS.map((h) => ({ id: String(h), label: idleLabel(h) }))} value={(filters.idleHours ?? []).map(String)} onChange={(v) => setFilter("idleHours", v.map(Number))} empty="" />
          </Field>
        )}
        {spec.filters.includes("callStatuses") && (
          <Field label="Only calls that ended as" optional error={errorAt("trigger.filters.callStatuses")} hint="None chosen means however the call ended. For missed calls choose No answer, Busy and Voicemail.">
            <MultiPick id="wf-tr-call-status" label="How the call ended" options={CALL_TRIGGER_STATUSES.map((s) => ({ id: s, label: CALL_STATUS_LABELS[s] }))} value={filters.callStatuses ?? []} onChange={(v) => setFilter("callStatuses", v as TriggerFilters["callStatuses"])} empty="" />
          </Field>
        )}
        {spec.filters.includes("callClasses") && (
          <Field label="Only these missed calls" optional error={errorAt("trigger.filters.callClasses")} hint="None chosen means every kind of missed call.">
            <MultiPick id="wf-tr-call-class" label="Kind of missed call" options={CALL_CLASSES.map((c) => ({ id: c, label: CALL_CLASS_LABELS[c] }))} value={filters.callClasses ?? []} onChange={(v) => setFilter("callClasses", v as TriggerFilters["callClasses"])} empty="" />
          </Field>
        )}
        {spec.filters.includes("leadLabels") && (
          <Field label="Only when the lead is" optional error={errorAt("trigger.filters.leadLabels")} hint="None chosen means whatever the new label is.">
            <MultiPick id="wf-tr-lead-label" label="Lead label" options={LEAD_LABELS.map((l) => ({ id: l, label: LEAD_LABEL_TEXT[l] }))} value={filters.leadLabels ?? []} onChange={(v) => setFilter("leadLabels", v as TriggerFilters["leadLabels"])} empty="" />
          </Field>
        )}
        {spec.filters.includes("callDirections") && (
          <Field label="Direction" optional error={errorAt("trigger.filters.callDirections")} hint="None chosen means incoming and outgoing calls.">
            <MultiPick id="wf-tr-call-direction" label="Direction" options={[{ id: "inbound", label: "Incoming" }, { id: "outbound", label: "Outgoing" }]} value={filters.callDirections ?? []} onChange={(v) => setFilter("callDirections", v as TriggerFilters["callDirections"])} empty="" />
          </Field>
        )}
        {spec.filters.includes("consentPurpose") && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Purpose" htmlFor="wf-tr-purpose" optional>
              <Select id="wf-tr-purpose" value={filters.consentPurpose ?? ""} onChange={(e) => setFilter("consentPurpose", (e.target.value || undefined) as TriggerFilters["consentPurpose"])}>
                <option value="">Service or marketing</option>
                <option value="service">Service</option>
                <option value="marketing">Marketing</option>
              </Select>
            </Field>
            <Field label="Change" htmlFor="wf-tr-consent" optional>
              <Select id="wf-tr-consent" value={filters.consentStatus ?? ""} onChange={(e) => setFilter("consentStatus", (e.target.value || undefined) as TriggerFilters["consentStatus"])}>
                <option value="">Given or withdrawn</option>
                <option value="granted">Given</option>
                <option value="revoked">Withdrawn</option>
              </Select>
            </Field>
          </div>
        )}
        {spec.filters.includes("ignoreOptOutKeywords") && (
          <Toggle id="wf-tr-optout" label="Ignore STOP and START messages" hint="Opt-out keywords are handled by iAcquire itself and don't start this workflow." checked={filters.ignoreOptOutKeywords !== false} onChange={(v) => setFilter("ignoreOptOutKeywords", v ? undefined : false)} />
        )}

        {trigger.type === "schedule" && (
          <>
            <Field label="Repeats" htmlFor="wf-tr-freq" error={errorAt("trigger.schedule.frequency")}>
              <Choice<"daily" | "weekly">
                name="wf-tr-freq"
                label="How often"
                value={trigger.schedule?.frequency ?? "daily"}
                onChange={(frequency) => onChange({ ...trigger, schedule: { frequency, time: trigger.schedule?.time ?? "09:00", ...(frequency === "weekly" ? { weekdays: trigger.schedule?.weekdays?.length ? trigger.schedule.weekdays : [1] } : {}) } })}
                options={[{ value: "daily", label: "Every day" }, { value: "weekly", label: "On chosen days" }]}
              />
            </Field>
            {trigger.schedule?.frequency === "weekly" && (
              <Field label="Days" error={errorAt("trigger.schedule.weekdays")}>
                <WeekdayPick label="Days" value={trigger.schedule.weekdays ?? []} onChange={(weekdays) => onChange({ ...trigger, schedule: { ...trigger.schedule!, weekdays } })} />
              </Field>
            )}
            <Field label="At" htmlFor="wf-tr-time" error={errorAt("trigger.schedule.time")} hint="In your workspace's time zone.">
              <Input id="wf-tr-time" type="time" className="w-36" value={trigger.schedule?.time ?? "09:00"} onChange={(e) => onChange({ ...trigger, schedule: { frequency: trigger.schedule?.frequency ?? "daily", ...trigger.schedule, time: e.target.value } })} />
            </Field>
            <p className="text-[13px] leading-relaxed text-muted">A scheduled run has no contact, so steps that need one (tags, messages) are refused when you check the workflow.</p>
          </>
        )}

        {trigger.type === "inbound_webhook" && (
          <>
            <Field label="Match the body to a contact" htmlFor="wf-tr-match" error={errorAt("trigger.inbound.match")}>
              <Select id="wf-tr-match" value={trigger.inbound?.match ?? "email_or_phone"} onChange={(e) => onChange({ ...trigger, inbound: { nonce: trigger.inbound?.nonce ?? newNonce(), createContact: e.target.value === "none" ? false : trigger.inbound?.createContact ?? false, match: e.target.value as "email_or_phone" | "none" } })}>
                <option value="email_or_phone">By its email or phone fields</option>
                <option value="none">Don&apos;t match (no contact)</option>
              </Select>
            </Field>
            <Toggle
              id="wf-tr-create"
              label="Add a new contact when nobody matches"
              disabled={trigger.inbound?.match === "none"}
              checked={!!trigger.inbound?.createContact}
              onChange={(v) => onChange({ ...trigger, inbound: { nonce: trigger.inbound?.nonce ?? newNonce(), match: trigger.inbound?.match ?? "email_or_phone", createContact: v } })}
            />
            <div className="space-y-2 rounded-2xl border border-line bg-surface-2/50 p-3">
              <p className="text-[14px] font-medium text-ink-2">Private URL</p>
              {inboundUrl ? (
                <div className="flex items-center gap-2">
                  <Input readOnly aria-label="Inbound webhook URL" value={inboundUrl} className="font-mono text-[12px]" onFocus={(e) => e.currentTarget.select()} />
                  <Button variant="secondary" size="icon-sm" aria-label="Copy URL" onClick={() => navigator.clipboard?.writeText(inboundUrl).then(() => toast.success("Copied."), () => toast.error("Couldn't copy. Select the URL and copy it."))}><Copy className="size-4" /></Button>
                </div>
              ) : inboundHidden ? (
                <p className="text-[13px] text-muted">Only people who can change this workflow can see its URL.</p>
              ) : (
                <p className="text-[13px] text-muted">The URL appears here once a version with this trigger is published.</p>
              )}
              <Button variant="ghost" size="sm" onClick={() => onChange({ ...trigger, inbound: { match: trigger.inbound?.match ?? "email_or_phone", createContact: !!trigger.inbound?.createContact, nonce: newNonce() } })}>
                <RefreshCw className="size-4" aria-hidden />New URL on next publish
              </Button>
              <p className="text-[12px] leading-relaxed text-muted">The URL is the key: anyone who has it can start this workflow, so give it only to the system that calls it. Generating a new URL and publishing stops the old one working. Calls are limited per minute and by the workflow&apos;s hourly limit, and an Idempotency-Key header makes a retried call start nothing new.</p>
            </div>
          </>
        )}

        {spec.carries.contact !== "never" && (
          <>
            <Field label="Only for contacts who match" optional error={errorAt("trigger.contactFilter")}>
              <ConditionsEditor
                id="wf-tr-filter"
                subject="contact"
                value={trigger.contactFilter ?? EMPTY_FILTER}
                onChange={(g) => onChange({ ...trigger, contactFilter: g.conditions.length ? g : undefined })}
                options={options}
                readOnly={readOnly}
                title="Which contacts this workflow runs for"
                emptyText="Every contact."
              />
            </Field>
            <Field label="Can a contact go through again?" htmlFor="wf-tr-reentry" error={errorAt("trigger.reentry")}>
              <Select id="wf-tr-reentry" value={trigger.reentry ?? "always"} onChange={(e) => onChange({ ...trigger, reentry: e.target.value === "always" ? undefined : (e.target.value as TriggerConfig["reentry"]) })}>
                <option value="always">Yes, every time it&apos;s triggered</option>
                <option value="not_while_active">Yes, but not while they&apos;re already in it</option>
                <option value="once">No, only once ever</option>
              </Select>
            </Field>
          </>
        )}
      </fieldset>
    </div>
  );
}

const TRIGGER_PATHS = ["trigger.type", "trigger.filters", "trigger.schedule", "trigger.inbound", "trigger.contactFilter", "trigger.reentry"];

/** A fresh secret-ish nonce for the inbound URL (the server derives the signed URL from it; it is not itself a secret). */
function newNonce(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[b & 63]).join("");
}
