"use client";

import * as React from "react";
import Link from "next/link";
import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { Dialog, Segmented, Switch } from "@/components/ui/overlays";
import { cn } from "@/lib/utils";
import { createAppointmentTypeAction, updateAppointmentTypeAction } from "@/app/actions/crm-calendar-settings";
import { useCrmAction } from "@/components/crm/ui";
import { ColorPicker, LOCATION_INFO, SettingRow, useResetOnOpen } from "@/components/crm/scheduling/settings/shared";
import { QuestionsBuilder } from "@/components/crm/scheduling/settings/questions-builder";
import { checkTypeForm, typeFormFrom, type TypeForm, type TypeFormErrors } from "@/components/crm/scheduling/settings/forms";
import { durationLabel, type TimeUnit } from "@/components/crm/scheduling/settings/hours";
import type { AppointmentTypeView, CalendarView, LocationKind, MeetingProvider } from "@/server/calendars/setup";
import type { CrmScope } from "@/server/crm/page";

const INTERVALS = [5, 10, 15, 20, 30, 45, 60, 90, 120];
const UNITS: Array<{ value: TimeUnit; label: string }> = [{ value: "minutes", label: "minutes" }, { value: "hours", label: "hours" }, { value: "days", label: "days" }];
const PROVIDERS: Array<{ value: MeetingProvider; label: string }> = [
  { value: "none", label: "No automatic link" },
  { value: "google_meet", label: "Google Meet" },
  { value: "microsoft_teams", label: "Microsoft Teams" },
  { value: "custom_link", label: "The same link every time" },
];

/** Hosts whose connected calendar can add events, by provider; null when the viewer can't see other people's connections. */
export type MeetingSupport = Record<string, { google: boolean; microsoft: boolean }> | null;

/** Creates or edits an appointment type: timing, place, booking form, what happens after booking, and whether it shows on the page. */
export function TypeEditor({ open, onOpenChange, scope, calendar, type, meeting }: { open: boolean; onOpenChange: (o: boolean) => void; scope: CrmScope; calendar: CalendarView; type: AppointmentTypeView | null; meeting: MeetingSupport }) {
  const { run, busy } = useCrmAction();
  const [form, setForm] = React.useState<TypeForm>(() => typeFormFrom(type));
  const [tried, setTried] = React.useState(false);
  useResetOnOpen(open, () => {
    setForm(typeFormFrom(type));
    setTried(false);
  });
  const set = <K extends keyof TypeForm>(k: K, v: TypeForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const { errors, input } = checkTypeForm(form);
  const err = (k: keyof TypeFormErrors) => (tried ? errors[k] ?? null : null);
  const id = type ? `type-${type.id}` : "type-new";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTried(true);
    if (!input) {
      // Take the person to the first problem rather than leaving them to scroll for it.
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`#${id}-form [aria-invalid="true"], #${id}-form [role="alert"]`)?.scrollIntoView({ block: "center" }));
      return;
    }
    const ok = type
      ? await run("save", () => updateAppointmentTypeAction(scope.orgId, type.id, input), "Appointment type saved.")
      : await run("save", () => createAppointmentTypeAction(scope.orgId, calendar.id, input), "Appointment type created.");
    if (ok) onOpenChange(false);
  }

  const duration = Number(form.duration) || 0;
  const location = LOCATION_INFO[form.locationKind];
  const hosts = calendar.members.filter((m) => m.active);
  const providerKey = form.meetingProvider === "google_meet" ? "google" : form.meetingProvider === "microsoft_teams" ? "microsoft" : null;
  const ready = providerKey && meeting ? hosts.filter((h) => meeting[h.userId]?.[providerKey]) : [];

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={type ? `Edit ${type.name}` : "New appointment type"}
      description={`What customers can book on ${calendar.name}: how long it takes, where it happens and what you ask.`}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" form={`${id}-form`} loading={busy("save")}>{type ? "Save changes" : "Create type"}</Button>
        </>
      }
    >
      <form id={`${id}-form`} className="space-y-7" onSubmit={submit} noValidate>
        <Section title="Basics">
          <Field label="Name" htmlFor={`${id}-name`} error={err("name")}>
            <Input id={`${id}-name`} value={form.name} onChange={(e) => set("name", e.target.value)} maxLength={80} placeholder="30-minute consultation" aria-invalid={!!err("name") || undefined} autoFocus={!type} />
          </Field>
          <Field label="Description" htmlFor={`${id}-desc`} optional error={err("description")} hint="Shown to customers when they choose what to book.">
            <Textarea id={`${id}-desc`} rows={2} value={form.description} onChange={(e) => set("description", e.target.value)} maxLength={1000} />
          </Field>
          <ColorPicker label="Colour" name={`${id}-color`} value={form.color} onChange={(c) => set("color", c)} />
        </Section>

        <Section title="Timing">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Length" htmlFor={`${id}-dur`} error={err("duration")} hint={duration >= 5 ? durationLabel(duration) : "In minutes"}>
              <MinutesInput id={`${id}-dur`} value={form.duration} onChange={(v) => set("duration", v)} suffix="min" invalid={!!err("duration")} />
            </Field>
            <Field label="Start times every" htmlFor={`${id}-int`} error={err("interval")} hint="How often a new start time is offered.">
              <Select id={`${id}-int`} value={form.interval} onChange={(e) => set("interval", e.target.value)}>
                <option value="">Same as the length{duration >= 5 ? ` (${durationLabel(duration)})` : ""}</option>
                {[...new Set([...INTERVALS, ...(form.interval ? [Number(form.interval)] : [])])].sort((a, b) => a - b).map((m) => <option key={m} value={String(m)}>{durationLabel(m)}</option>)}
              </Select>
            </Field>
            <Field label="Buffer before" htmlFor={`${id}-bb`} error={err("bufferBefore")} hint="Free time kept before it, such as travel.">
              <MinutesInput id={`${id}-bb`} value={form.bufferBefore} onChange={(v) => set("bufferBefore", v)} suffix="min" invalid={!!err("bufferBefore")} />
            </Field>
            <Field label="Buffer after" htmlFor={`${id}-ba`} error={err("bufferAfter")} hint="Free time kept after it, such as notes.">
              <MinutesInput id={`${id}-ba`} value={form.bufferAfter} onChange={(v) => set("bufferAfter", v)} suffix="min" invalid={!!err("bufferAfter")} />
            </Field>
            <Field label="Minimum notice" htmlFor={`${id}-notice`} error={err("notice")} hint="Customers can't book sooner than this. Your team can.">
              <AmountWithUnit id={`${id}-notice`} value={form.notice} unit={form.noticeUnit} onValue={(v) => set("notice", v)} onUnit={(u) => set("noticeUnit", u)} invalid={!!err("notice")} label="Minimum notice" />
            </Field>
            <Field label="Bookable up to" htmlFor={`${id}-ahead`} error={err("daysAhead")} hint="How far ahead the calendar opens.">
              <MinutesInput id={`${id}-ahead`} value={form.daysAhead} onChange={(v) => set("daysAhead", v)} suffix="days ahead" invalid={!!err("daysAhead")} />
            </Field>
            <Field label="Daily limit per host" htmlFor={`${id}-limit`} optional error={err("dailyLimit")} hint="Leave empty for no limit.">
              <MinutesInput id={`${id}-limit`} value={form.dailyLimit} onChange={(v) => set("dailyLimit", v)} suffix="a day" invalid={!!err("dailyLimit")} placeholder="No limit" />
            </Field>
          </div>
          <div className="space-y-2">
            <p className="text-[14px] font-medium text-ink-2">Who attends</p>
            <Segmented id={`${id}-cap`} ariaLabel="Who attends" value={form.group ? "group" : "one"} onChange={(v) => set("group", v === "group")} options={[{ value: "one", label: "One customer" }, { value: "group", label: "Group session" }]} />
            {form.group && (
              <Field label="Places per session" htmlFor={`${id}-capn`} error={err("capacity")} hint="Several customers can book the same time until it's full.">
                <MinutesInput id={`${id}-capn`} value={form.capacity} onChange={(v) => set("capacity", v)} suffix="places" invalid={!!err("capacity")} />
              </Field>
            )}
            {type && (type.capacity > 1) !== form.group && <p className="text-[13px] text-muted">If upcoming appointments use this type, switching between one customer and a group isn&apos;t allowed. Create a new type instead.</p>}
          </div>
        </Section>

        <Section title="Where it happens">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Location" htmlFor={`${id}-loc`}>
              <Select id={`${id}-loc`} value={form.locationKind} onChange={(e) => set("locationKind", e.target.value as LocationKind)}>
                {(Object.keys(LOCATION_INFO) as LocationKind[]).map((k) => <option key={k} value={k}>{LOCATION_INFO[k].label}</option>)}
              </Select>
            </Field>
            {location.detailLabel && (
              <Field label={location.detailLabel} htmlFor={`${id}-locd`} optional error={err("locationDetail")}>
                <Input id={`${id}-locd`} value={form.locationDetail} onChange={(e) => set("locationDetail", e.target.value)} maxLength={300} placeholder={location.placeholder} />
              </Field>
            )}
          </div>
          {form.locationKind === "video" && (
            <fieldset className="space-y-2">
              <legend className="text-[14px] font-medium text-ink-2">Meeting link</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {PROVIDERS.map((p) => (
                  <label key={p.value} className={cn("flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-[14px] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-primary", form.meetingProvider === p.value ? "border-primary bg-primary-soft/40 text-ink" : "border-line text-ink-2 hover:bg-surface-2")}>
                    <input type="radio" name={`${id}-provider`} value={p.value} checked={form.meetingProvider === p.value} onChange={() => set("meetingProvider", p.value)} className="accent-primary" />
                    {p.label}
                  </label>
                ))}
              </div>
              {form.meetingProvider === "custom_link" && (
                <Field label="Link" htmlFor={`${id}-link`} error={err("meetingLink")} hint="Every booking gets this link, for example your Zoom personal room.">
                  <Input id={`${id}-link`} type="url" inputMode="url" value={form.meetingLink} onChange={(e) => set("meetingLink", e.target.value)} placeholder="https://" maxLength={500} aria-invalid={!!err("meetingLink") || undefined} />
                </Field>
              )}
              {providerKey && (
                <div className="flex gap-2.5 rounded-xl border border-line bg-surface-2 p-3 text-[13px] leading-relaxed text-ink-2">
                  <Info className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
                  <div className="min-w-0 space-y-1.5">
                    <p>
                      A {providerKey === "google" ? "Google Meet" : "Microsoft Teams"} link is only created when the host who takes the booking has a {providerKey === "google" ? "Google" : "Microsoft 365"} calendar
                      connected with permission to add events. Otherwise the booking still goes through without a link, and you&apos;ll need to send one yourself.
                    </p>
                    {meeting ? (
                      <ul className="flex flex-wrap gap-1.5" aria-label="Hosts who can create these links">
                        {hosts.map((h) => {
                          const ok = ready.some((r) => r.userId === h.userId);
                          return <li key={h.userId}><Badge tone={ok ? "success" : "neutral"}>{h.name}: {ok ? "ready" : "not connected"}</Badge></li>;
                        })}
                      </ul>
                    ) : null}
                    <Link href={`${scope.base}/calendar-connections`} className="inline-block font-medium text-primary hover:underline">Calendar connections</Link>
                  </div>
                </div>
              )}
            </fieldset>
          )}
        </Section>

        <Section title="Booking form" description="What customers fill in when they book.">
          <fieldset className="space-y-1">
            <legend className="text-[14px] font-medium text-ink-2">Contact details required</legend>
            <div className="flex flex-wrap gap-x-5">
              <label className="flex min-h-11 items-center gap-2 text-[14px] text-ink-2 sm:min-h-8">
                <input type="checkbox" className="size-4 accent-primary" checked={form.requireEmail} onChange={(e) => set("requireEmail", e.target.checked)} aria-invalid={!!err("contact") || undefined} />
                Email address
              </label>
              <label className="flex min-h-11 items-center gap-2 text-[14px] text-ink-2 sm:min-h-8">
                <input type="checkbox" className="size-4 accent-primary" checked={form.requirePhone} onChange={(e) => set("requirePhone", e.target.checked)} aria-invalid={!!err("contact") || undefined} />
                Phone number
              </label>
            </div>
            {err("contact") ? <p role="alert" className="text-[13px] text-danger-ink">{err("contact")}</p> : <p className="text-[13px] text-muted">At least one is required, so you can reach the person who booked.</p>}
          </fieldset>
          <div className="space-y-2">
            <p className="text-[14px] font-medium text-ink-2">Extra questions</p>
            {err("questions") && <p role="alert" className="text-[13px] text-danger-ink">{err("questions")}</p>}
            <QuestionsBuilder idPrefix={`${id}-q`} value={form.questions} onChange={(q) => set("questions", q)} showErrors={tried} />
          </div>
        </Section>

        <Section title="After booking">
          <SettingRow id={`${id}-confirm`} label="Confirm each booking yourself" hint="The time is held straight away, but the booking shows as waiting until someone on your team confirms it."
            control={<Switch id={`${id}-confirm`} checked={form.requiresConfirmation} onCheckedChange={(v) => set("requiresConfirmation", v)} aria-describedby={`${id}-confirm-hint`} />} />
          <Field label="Message after booking" htmlFor={`${id}-msg`} optional error={err("confirmationMessage")} hint={`${form.confirmationMessage.trim().length}/500. Shown to the customer once their booking goes through.`}>
            <Textarea id={`${id}-msg`} rows={3} value={form.confirmationMessage} onChange={(e) => set("confirmationMessage", e.target.value)} maxLength={500} placeholder="Thanks for booking. Please bring your latest bill." />
          </Field>
          <SettingRow id={`${id}-changes`} label="Customers can reschedule or cancel" hint="From the link they get when they book."
            control={<Switch id={`${id}-changes`} checked={form.allowCustomerChanges} onCheckedChange={(v) => set("allowCustomerChanges", v)} aria-describedby={`${id}-changes-hint`} />} />
          {form.allowCustomerChanges && (
            <Field label="Stop changes this long before the start" htmlFor={`${id}-cutoff`} error={err("cutoff")} hint={Number(form.cutoff) === 0 ? "0 lets them change it right up to the start." : "After that, they'll need to contact you to change it."}>
              <AmountWithUnit id={`${id}-cutoff`} value={form.cutoff} unit={form.cutoffUnit} onValue={(v) => set("cutoff", v)} onUnit={(u) => set("cutoffUnit", u)} invalid={!!err("cutoff")} label="Change cut-off" />
            </Field>
          )}
        </Section>

        <Section title="Booking page">
          <SettingRow id={`${id}-public`} label="Show on the booking page"
            hint={calendar.public ? "Customers can choose it on this calendar's public page. Hidden types can still be booked by your team." : "This calendar's booking page is off, so nobody sees it yet. Hidden types can still be booked by your team."}
            control={<Switch id={`${id}-public`} checked={form.isPublic} onCheckedChange={(v) => set("isPublic", v)} aria-describedby={`${id}-public-hint`} />} />
        </Section>
      </form>
    </Dialog>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-[14px] font-semibold text-ink">{title}</h3>
        {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function MinutesInput({ id, value, onChange, suffix, invalid, placeholder }: { id: string; value: string; onChange: (v: string) => void; suffix: string; invalid?: boolean; placeholder?: string }) {
  return (
    <div className="relative">
      <Input id={id} type="text" inputMode="numeric" pattern="[0-9]*" value={value} onChange={(e) => onChange(e.target.value.replace(/[^0-9]/g, "").slice(0, 5))} aria-invalid={invalid || undefined} placeholder={placeholder}
        className="pr-24" aria-describedby={`${id}-suffix`} />
      <span id={`${id}-suffix`} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[13px] text-faint">{suffix}</span>
    </div>
  );
}

function AmountWithUnit({ id, value, unit, onValue, onUnit, invalid, label }: { id: string; value: string; unit: TimeUnit; onValue: (v: string) => void; onUnit: (u: TimeUnit) => void; invalid?: boolean; label: string }) {
  return (
    <div className="flex gap-2">
      <Input id={id} type="text" inputMode="numeric" pattern="[0-9]*" className="min-w-0 flex-1" value={value} onChange={(e) => onValue(e.target.value.replace(/[^0-9]/g, "").slice(0, 5))} aria-invalid={invalid || undefined} />
      <div className="w-32 shrink-0">
        <label htmlFor={`${id}-unit`} className="sr-only">{label} unit</label>
        <Select id={`${id}-unit`} value={unit} onChange={(e) => onUnit(e.target.value as TimeUnit)}>
          {UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
        </Select>
      </div>
    </div>
  );
}
