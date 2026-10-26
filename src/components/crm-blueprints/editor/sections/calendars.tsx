"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, ChevronDown, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { isTimeZone } from "@/lib/crm/blueprints/schema";
import type { AppointmentTypeAsset, BookingQuestion, CalendarAsset, LocationKind, MeetingProvider, WeeklyHours } from "@/lib/crm/blueprints/types";
import { moveItem, newAppointmentType, updateAsset, withSection } from "@/components/crm-blueprints/editor/model";
import {
  AssetWorkspace, DetailCard, DetailHeader, FieldGrid, FolderSelect, IssueNotes, NumberInput, SectionNote, SlotChips, issuesOf, orNull, ownIssues, useAdder, useEditor,
} from "@/components/crm-blueprints/editor/parts";
import { ColorPicker, ToggleRow, clockToMinutes, minutesToClock } from "@/components/crm-blueprints/editor/inputs";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Monday first, as most businesses read their week. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const ASSIGNMENT_LABELS: Record<CalendarAsset["assignment"], { label: string; hint: string }> = {
  single: { label: "One person", hint: "Every appointment is with the same host." },
  round_robin: { label: "Round robin", hint: "Appointments are shared between the hosts." },
  collective: { label: "Everyone together", hint: "All hosts attend each appointment, so only times when everyone is free are offered." },
};
const LOCATION_LABELS: Record<LocationKind, string> = { phone: "Phone call", video: "Video call", in_person: "In person", custom: "Other", none: "Not specified" };
const PROVIDER_LABELS: Record<MeetingProvider, string> = { none: "No video link", google_meet: "Google Meet (host's Google account)", microsoft_teams: "Microsoft Teams (host's Microsoft account)", custom_link: "A fixed link" };

function timeZones(): string[] {
  try {
    const list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone");
    if (list?.length) return list;
  } catch {
    // Older runtimes: fall back to a typed time zone.
  }
  return [];
}

export function CalendarsSection() {
  const { content, edit, readOnly, remove, issues } = useEditor();
  const add = useAdder("calendars");
  const zones = React.useMemo(() => timeZones(), []);
  const items = content.assets.calendars.map((c) => ({ id: c.id, name: c.name, detail: `${c.types.length} appointment ${c.types.length === 1 ? "type" : "types"} · ${ASSIGNMENT_LABELS[c.assignment].label}` }));
  return (
    <>
      <AssetWorkspace
        section="calendars"
        title="Calendars & appointment types"
        intro="Booking calendars, the appointment types people book, and the working hours hosts start from."
        items={items}
        addLabel="Add calendar"
        onAdd={add.open}
        emptyText="Add the calendars this kind of business takes appointments on."
        canReorder
        onMove={(i, d) => edit((c) => withSection(c, "calendars", moveItem(c.assets.calendars, i, d)))}
      >
        {(id) => {
          const cal = content.assets.calendars.find((x) => x.id === id)!;
          const set = (patch: Partial<CalendarAsset>) => edit((c) => updateAsset(c, "calendars", id, (x) => ({ ...x, ...patch })));
          const tzUnknown = cal.timezone && !isTimeZone(cal.timezone);
          return (
            <DetailCard>
              <DetailHeader id={cal.id} title={cal.name} kind="Calendar" onRemove={() => remove(cal.id, cal.name)} />
              <SectionNote tone="warning">
                Calendars always arrive in a client&apos;s CRM as drafts and take no bookings until someone there assigns the hosts, checks the working
                hours, time zone, connected calendars and booking behaviour, and activates the calendar.
              </SectionNote>
              <IssueNotes issues={ownIssues(issues, cal.id)} />
              <FieldGrid>
                <Field label="Name" htmlFor="cal-name"><Input id="cal-name" value={cal.name} maxLength={80} disabled={readOnly} onChange={(e) => set({ name: e.target.value })} /></Field>
                <FolderSelect id="cal-folder" kind="calendar" value={cal.folder} onChange={(folder) => set({ folder })} />
              </FieldGrid>
              <Field label="Description" htmlFor="cal-desc" optional><Textarea id="cal-desc" rows={2} maxLength={500} value={cal.description ?? ""} disabled={readOnly} onChange={(e) => set({ description: orNull(e.target.value) })} /></Field>
              <FieldGrid>
                <Field label="Who takes appointments" htmlFor="cal-assign" hint={ASSIGNMENT_LABELS[cal.assignment].hint}>
                  <Select id="cal-assign" value={cal.assignment} disabled={readOnly} onChange={(e) => {
                    const assignment = e.target.value as CalendarAsset["assignment"];
                    set({ assignment, hosts: assignment === "single" ? cal.hosts.slice(0, 1) : cal.hosts });
                  }}>
                    {(Object.keys(ASSIGNMENT_LABELS) as Array<CalendarAsset["assignment"]>).map((a) => <option key={a} value={a}>{ASSIGNMENT_LABELS[a].label}</option>)}
                  </Select>
                </Field>
                {cal.assignment === "round_robin" && (
                  <Field label="Round robin" htmlFor="cal-rr" hint="Balanced gives each host a fair share; priority prefers hosts in their order.">
                    <Select id="cal-rr" value={cal.roundRobinMode} disabled={readOnly} onChange={(e) => set({ roundRobinMode: e.target.value as CalendarAsset["roundRobinMode"] })}>
                      <option value="balanced">Balanced</option>
                      <option value="priority">By priority</option>
                    </Select>
                  </Field>
                )}
              </FieldGrid>
              <SlotChips
                id="cal-hosts"
                label="Host roles"
                value={cal.hosts}
                max={cal.assignment === "single" ? 1 : 50}
                onChange={(hosts) => set({ hosts })}
                hint="Roles, never people: each client chooses who takes these appointments. Leave it empty to let each client pick its own hosts."
              />
              <Field label="Time zone" htmlFor="cal-tz" optional hint={tzUnknown ? "That isn't a time zone this browser knows." : "The working hours below are in this time zone. Leave it to use each client's own time zone."}>
                {zones.length ? (
                  <Select id="cal-tz" value={cal.timezone ?? ""} disabled={readOnly} onChange={(e) => set({ timezone: orNull(e.target.value) })}>
                    <option value="">Each client&apos;s own time zone</option>
                    {cal.timezone && !zones.includes(cal.timezone) && <option value={cal.timezone}>{cal.timezone}</option>}
                    {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}
                  </Select>
                ) : (
                  <Input id="cal-tz" value={cal.timezone ?? ""} placeholder="America/New_York" disabled={readOnly} onChange={(e) => set({ timezone: orNull(e.target.value.trim()) })} />
                )}
              </Field>
              <HoursEditor hours={cal.hours} onChange={(hours) => set({ hours })} readOnly={readOnly} />
              <Field label="Booking page introduction" htmlFor="cal-intro" optional><Textarea id="cal-intro" rows={2} maxLength={500} value={cal.bookingIntro ?? ""} disabled={readOnly} onChange={(e) => set({ bookingIntro: orNull(e.target.value) })} /></Field>
              <Field label="Colour" htmlFor="cal-color" optional><ColorPicker id="cal-color" label="Calendar colour" value={cal.color} nullable disabled={readOnly} onChange={(color) => set({ color })} /></Field>
              <TypesEditor calendar={cal} />
            </DetailCard>
          );
        }}
      </AssetWorkspace>
      {add.dialog}
    </>
  );
}

// ---------------------------------------------------------------------------
// Weekly hours
// ---------------------------------------------------------------------------

function HoursEditor({ hours, onChange, readOnly }: { hours: WeeklyHours[]; onChange: (h: WeeklyHours[]) => void; readOnly: boolean }) {
  const windowsOf = (day: number) => hours.map((h, i) => ({ h, i })).filter((x) => x.h.weekday === day);
  const setAt = (i: number, patch: Partial<WeeklyHours>) => onChange(hours.map((h, j) => (j === i ? { ...h, ...patch } : h)));
  const addWindow = (day: number) => {
    const existing = windowsOf(day).map((x) => x.h);
    const start = existing.length ? Math.min(1380, Math.max(...existing.map((h) => h.endMinute)) + 60) : 540;
    onChange([...hours, { weekday: day, startMinute: start, endMinute: Math.min(1440, start + 480) }]);
  };
  return (
    <fieldset className="space-y-2">
      <legend className="text-[14px] font-medium text-ink-2">Suggested working hours</legend>
      <p className="text-[13px] text-muted">Copied only to hosts who have no weekly hours yet, when the client assigns them and chooses to use these. Nobody&apos;s own hours are replaced.</p>
      <ul className="divide-y divide-line rounded-2xl border border-line">
        {WEEK_ORDER.map((day) => {
          const list = windowsOf(day);
          return (
            <li key={day} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-start">
              <span className="w-28 shrink-0 pt-2 text-[14px] font-medium text-ink">{WEEKDAYS[day]}</span>
              <div className="min-w-0 flex-1 space-y-2">
                {!list.length && <p className="pt-2 text-[13px] text-muted">Closed</p>}
                {list.map(({ h, i }) => {
                  const bad = h.endMinute <= h.startMinute;
                  return (
                    <div key={i} className="flex flex-wrap items-center gap-2">
                      <Input type="time" aria-label={`${WEEKDAYS[day]} from`} value={minutesToClock(h.startMinute)} disabled={readOnly} className="w-32"
                        onChange={(e) => { const m = clockToMinutes(e.target.value); if (m !== null && m <= 1439) setAt(i, { startMinute: m }); }} />
                      <span className="text-[14px] text-muted">to</span>
                      <Input type="time" aria-label={`${WEEKDAYS[day]} until`} value={minutesToClock(h.endMinute)} disabled={readOnly} className="w-32" aria-invalid={bad || undefined}
                        onChange={(e) => { const m = clockToMinutes(e.target.value); if (m !== null) setAt(i, { endMinute: m === 0 ? 1440 : m }); }} />
                      {bad && <span className="text-[12px] text-danger-ink" role="status">Ends before it starts</span>}
                      {!readOnly && <Button variant="ghost" size="icon-sm" aria-label={`Remove ${WEEKDAYS[day]} ${minutesToClock(h.startMinute)} window`} onClick={() => onChange(hours.filter((_, j) => j !== i))}><Trash2 className="size-4" /></Button>}
                    </div>
                  );
                })}
              </div>
              {!readOnly && <Button variant="ghost" size="sm" onClick={() => addWindow(day)} disabled={hours.length >= 50}><Plus className="size-3.5" aria-hidden />{list.length ? "Add hours" : "Open"}</Button>}
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Appointment types
// ---------------------------------------------------------------------------

function TypesEditor({ calendar }: { calendar: CalendarAsset }) {
  const { content, edit, readOnly, remove, issues } = useEditor();
  const [open, setOpen] = React.useState<string | null>(calendar.types[0]?.id ?? null);
  const setTypes = (types: AppointmentTypeAsset[]) => edit((c) => updateAsset(c, "calendars", calendar.id, (x) => ({ ...x, types })));
  const addType = () => {
    const names = new Set(calendar.types.map((t) => t.name.toLowerCase()));
    let n = calendar.types.length + 1;
    while (names.has(`appointment ${n}`)) n++;
    const t = newAppointmentType(content, calendar.id, `Appointment ${n}`);
    setTypes([...calendar.types, t]);
    setOpen(t.id);
  };
  return (
    <section aria-labelledby={`types-${calendar.id}`} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id={`types-${calendar.id}`} className="text-[14px] font-semibold text-ink">Appointment types</h4>
        {!readOnly && <Button variant="secondary" size="sm" onClick={addType} disabled={calendar.types.length >= 20}><Plus className="size-3.5" aria-hidden />Add type</Button>}
      </div>
      <ul className="space-y-2">
        {calendar.types.map((t, i) => {
          const expanded = open === t.id;
          const own = issuesOf(issues, t.id);
          return (
            <li key={t.id} className="rounded-2xl border border-line">
              <div className="flex items-center gap-1 pr-2">
                <button type="button" aria-expanded={expanded} aria-controls={`type-${t.id}`} onClick={() => setOpen(expanded ? null : t.id)} className="flex min-h-12 min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left">
                  <ChevronDown className={cn("size-4 shrink-0 text-muted transition-transform", expanded && "rotate-180")} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-medium text-ink">{t.name || "Untitled"}</span>
                    <span className="block truncate text-[12px] text-muted">{t.durationMinutes} min · {LOCATION_LABELS[t.locationKind]}{t.public ? "" : " · not on the booking page"}</span>
                  </span>
                  {own.some((x) => x.severity === "error") && <Badge tone="danger">To fix</Badge>}
                </button>
                {!readOnly && (
                  <>
                    <Button variant="ghost" size="icon-sm" onClick={() => setTypes(moveItem(calendar.types, i, -1))} disabled={i === 0} aria-label={`Move ${t.name} up`}><ArrowUp className="size-4" /></Button>
                    <Button variant="ghost" size="icon-sm" onClick={() => setTypes(moveItem(calendar.types, i, 1))} disabled={i === calendar.types.length - 1} aria-label={`Move ${t.name} down`}><ArrowDown className="size-4" /></Button>
                    <Button variant="ghost" size="icon-sm" onClick={() => remove(t.id, t.name)} disabled={calendar.types.length <= 1} aria-label={`Remove ${t.name}`}><Trash2 className="size-4" /></Button>
                  </>
                )}
              </div>
              {expanded && (
                <div id={`type-${t.id}`} className="space-y-4 border-t border-line p-3 sm:p-4">
                  <IssueNotes issues={own} />
                  <TypeForm calendarId={calendar.id} type={t} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function TypeForm({ calendarId, type: t }: { calendarId: string; type: AppointmentTypeAsset }) {
  const { edit, readOnly } = useEditor();
  const set = (patch: Partial<AppointmentTypeAsset>) => edit((c) => updateAsset(c, "calendars", calendarId, (x) => ({ ...x, types: x.types.map((y) => (y.id === t.id ? { ...y, ...patch } : y)) })));
  const f = (k: string) => `at-${t.id}-${k}`;
  return (
    <div className="space-y-4">
      <p className="text-[12px] text-muted">Reference <code className="font-mono">{t.id}</code></p>
      <FieldGrid>
        <Field label="Name" htmlFor={f("name")}><Input id={f("name")} value={t.name} maxLength={80} disabled={readOnly} onChange={(e) => set({ name: e.target.value })} /></Field>
        <Field label="Length" htmlFor={f("dur")}><NumberInput id={f("dur")} value={t.durationMinutes} min={5} max={720} suffix="minutes" disabled={readOnly} onChange={(v) => v !== null && set({ durationMinutes: v })} /></Field>
      </FieldGrid>
      <Field label="Description" htmlFor={f("desc")} optional><Textarea id={f("desc")} rows={2} maxLength={1000} value={t.description ?? ""} disabled={readOnly} onChange={(e) => set({ description: orNull(e.target.value) })} /></Field>
      <FieldGrid>
        <Field label="Start times every" htmlFor={f("int")} optional hint="Empty: every slot the length allows."><NumberInput id={f("int")} value={t.slotIntervalMinutes} min={5} max={240} nullable suffix="minutes" disabled={readOnly} onChange={(slotIntervalMinutes) => set({ slotIntervalMinutes })} /></Field>
        <Field label="Book at least" htmlFor={f("notice")} hint="How long before the start a booking must be made."><NumberInput id={f("notice")} value={t.minNoticeMinutes} min={0} max={43200} suffix="minutes ahead" disabled={readOnly} onChange={(v) => v !== null && set({ minNoticeMinutes: v })} /></Field>
        <Field label="Buffer before" htmlFor={f("bb")}><NumberInput id={f("bb")} value={t.bufferBeforeMinutes} min={0} max={240} suffix="minutes" disabled={readOnly} onChange={(v) => v !== null && set({ bufferBeforeMinutes: v })} /></Field>
        <Field label="Buffer after" htmlFor={f("ba")}><NumberInput id={f("ba")} value={t.bufferAfterMinutes} min={0} max={240} suffix="minutes" disabled={readOnly} onChange={(v) => v !== null && set({ bufferAfterMinutes: v })} /></Field>
        <Field label="Book up to" htmlFor={f("ahead")}><NumberInput id={f("ahead")} value={t.maxDaysAhead} min={1} max={365} suffix="days ahead" disabled={readOnly} onChange={(v) => v !== null && set({ maxDaysAhead: v })} /></Field>
        <Field label="At most per day" htmlFor={f("daily")} optional hint="Empty: no daily limit."><NumberInput id={f("daily")} value={t.dailyLimit} min={1} max={100} nullable disabled={readOnly} onChange={(dailyLimit) => set({ dailyLimit })} /></Field>
        <Field label="People per appointment" htmlFor={f("cap")}><NumberInput id={f("cap")} value={t.capacity} min={1} max={500} disabled={readOnly} onChange={(v) => v !== null && set({ capacity: v })} /></Field>
      </FieldGrid>
      <FieldGrid>
        <Field label="Where" htmlFor={f("loc")}>
          <Select id={f("loc")} value={t.locationKind} disabled={readOnly} onChange={(e) => set({ locationKind: e.target.value as LocationKind })}>
            {(Object.keys(LOCATION_LABELS) as LocationKind[]).map((k) => <option key={k} value={k}>{LOCATION_LABELS[k]}</option>)}
          </Select>
        </Field>
        <Field label="Location details" htmlFor={f("locd")} optional hint="General wording only (for example “At your home”). Each client's own address belongs in a configuration value.">
          <Input id={f("locd")} value={t.locationDetail ?? ""} maxLength={300} disabled={readOnly} onChange={(e) => set({ locationDetail: orNull(e.target.value) })} />
        </Field>
        <Field label="Video link" htmlFor={f("mp")} hint={t.meetingProvider === "google_meet" || t.meetingProvider === "microsoft_teams" ? "Each host connects their own account in the client's CRM; until then no link is created." : undefined}>
          <Select id={f("mp")} value={t.meetingProvider} disabled={readOnly} onChange={(e) => {
            const meetingProvider = e.target.value as MeetingProvider;
            set({ meetingProvider, meetingLink: meetingProvider === "custom_link" ? t.meetingLink : null });
          }}>
            {(Object.keys(PROVIDER_LABELS) as MeetingProvider[]).map((k) => <option key={k} value={k}>{PROVIDER_LABELS[k]}</option>)}
          </Select>
        </Field>
        {t.meetingProvider === "custom_link" && (
          <Field label="Fixed link" htmlFor={f("ml")} optional hint="Leave it empty when each client adds its own: the setup checklist asks for it, and the type starts without a link.">
            <Input id={f("ml")} type="url" value={t.meetingLink ?? ""} maxLength={500} placeholder="https://" disabled={readOnly} onChange={(e) => set({ meetingLink: orNull(e.target.value.trim()) })} />
          </Field>
        )}
      </FieldGrid>
      <div className="grid gap-2 sm:grid-cols-2">
        <ToggleRow id={f("public")} label="On the booking page" hint="Shown once the calendar is verified and its booking page is switched on." checked={t.public} disabled={readOnly} onChange={(v) => set({ public: v })} />
        <ToggleRow id={f("confirm")} label="Needs confirming" hint="Bookings wait for someone to confirm them." checked={t.requiresConfirmation} disabled={readOnly} onChange={(v) => set({ requiresConfirmation: v })} />
        <ToggleRow id={f("email")} label="Ask for an email address" checked={t.requireEmail} disabled={readOnly} onChange={(v) => set({ requireEmail: v })} />
        <ToggleRow id={f("phone")} label="Ask for a phone number" checked={t.requirePhone} disabled={readOnly} onChange={(v) => set({ requirePhone: v })} />
        <ToggleRow id={f("changes")} label="People can reschedule or cancel" checked={t.allowCustomerChanges} disabled={readOnly} onChange={(v) => set({ allowCustomerChanges: v })} />
      </div>
      {!t.requireEmail && !t.requirePhone && <p className="text-[13px] text-danger-ink" role="status">Ask for at least an email address or a phone number, so the business can reach the person who booked.</p>}
      {t.allowCustomerChanges && (
        <Field label="Changes allowed until" htmlFor={f("cut")}><NumberInput id={f("cut")} value={t.changeCutoffMinutes} min={0} max={10080} suffix="minutes before the start" disabled={readOnly} onChange={(v) => v !== null && set({ changeCutoffMinutes: v })} /></Field>
      )}
      <Field label="Confirmation message" htmlFor={f("cm")} optional><Textarea id={f("cm")} rows={2} maxLength={500} value={t.confirmationMessage ?? ""} disabled={readOnly} onChange={(e) => set({ confirmationMessage: orNull(e.target.value) })} /></Field>
      <Field label="Colour" htmlFor={f("color")} optional><ColorPicker id={f("color")} label={`${t.name} colour`} value={t.color} nullable disabled={readOnly} onChange={(color) => set({ color })} /></Field>
      <QuestionsEditor questions={t.questions} onChange={(questions) => set({ questions })} readOnly={readOnly} idPrefix={f("q")} />
    </div>
  );
}

const QUESTION_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
const keyFromLabel = (label: string, taken: Set<string>) => {
  let base = label.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 34);
  if (!/^[a-z]/.test(base)) base = `q_${base}`.replace(/_+$/, "");
  let key = base || "question";
  for (let i = 2; taken.has(key); i++) key = `${base}_${i}`;
  return key;
};

function QuestionsEditor({ questions, onChange, readOnly, idPrefix }: { questions: BookingQuestion[]; onChange: (q: BookingQuestion[]) => void; readOnly: boolean; idPrefix: string }) {
  const setAt = (i: number, patch: Partial<BookingQuestion>) => onChange(questions.map((q, j) => (j === i ? { ...q, ...patch } : q)));
  const add = () => {
    const taken = new Set(questions.map((q) => q.key));
    onChange([...questions, { key: keyFromLabel(`Question ${questions.length + 1}`, taken), label: `Question ${questions.length + 1}`, type: "text", required: false }]);
  };
  return (
    <fieldset className="space-y-2">
      <legend className="text-[14px] font-medium text-ink-2">Booking questions</legend>
      <p className="text-[13px] text-muted">Asked when someone books, after their name and contact details.</p>
      <ol className="space-y-2">
        {questions.map((q, i) => {
          const keyBad = !QUESTION_KEY_RE.test(q.key) || questions.some((x, j) => j !== i && x.key === q.key);
          return (
            <li key={i} className="space-y-2 rounded-xl border border-line p-3">
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)]">
                <Field label="Question" htmlFor={`${idPrefix}-${i}-label`}><Input id={`${idPrefix}-${i}-label`} value={q.label} maxLength={120} disabled={readOnly} onChange={(e) => setAt(i, { label: e.target.value })} /></Field>
                <Field label="Answer key" htmlFor={`${idPrefix}-${i}-key`} error={keyBad ? "Unique; lower-case letters, numbers and _." : null}>
                  <Input id={`${idPrefix}-${i}-key`} value={q.key} maxLength={40} className="font-mono" disabled={readOnly} aria-invalid={keyBad || undefined} onChange={(e) => setAt(i, { key: e.target.value.toLowerCase() })} />
                </Field>
                <Field label="Answer" htmlFor={`${idPrefix}-${i}-type`}>
                  <Select id={`${idPrefix}-${i}-type`} value={q.type} disabled={readOnly} onChange={(e) => {
                    const type = e.target.value as BookingQuestion["type"];
                    const next: BookingQuestion = { key: q.key, label: q.label, type, required: q.required };
                    if (type === "select") next.options = q.options?.length ? q.options : ["Option 1", "Option 2"];
                    onChange(questions.map((x, j) => (j === i ? next : x)));
                  }}>
                    <option value="text">Short answer</option>
                    <option value="textarea">Long answer</option>
                    <option value="select">Choice</option>
                  </Select>
                </Field>
              </div>
              {q.type === "select" && (
                <Field label="Choices (one per line)" htmlFor={`${idPrefix}-${i}-opts`} hint="1 to 20 choices, each different.">
                  <Textarea id={`${idPrefix}-${i}-opts`} rows={3} disabled={readOnly} value={(q.options ?? []).join("\n")} onChange={(e) => setAt(i, { options: e.target.value.split("\n").map((o) => o.slice(0, 100)).slice(0, 20) })}
                    onBlur={(e) => setAt(i, { options: e.target.value.split("\n").map((o) => o.trim()).filter(Boolean).slice(0, 20) })} />
                </Field>
              )}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="inline-flex min-h-11 items-center gap-2 text-[14px] text-ink-2 sm:min-h-0">
                  <input type="checkbox" checked={q.required} disabled={readOnly} onChange={(e) => setAt(i, { required: e.target.checked })} className="size-4 accent-primary" />
                  Required
                </label>
                {!readOnly && (
                  <span className="flex items-center gap-1">
                    <Button variant="ghost" size="icon-sm" onClick={() => onChange(moveItem(questions, i, -1))} disabled={i === 0} aria-label={`Move question ${q.label} up`}><ArrowUp className="size-4" /></Button>
                    <Button variant="ghost" size="icon-sm" onClick={() => onChange(moveItem(questions, i, 1))} disabled={i === questions.length - 1} aria-label={`Move question ${q.label} down`}><ArrowDown className="size-4" /></Button>
                    <Button variant="ghost" size="icon-sm" onClick={() => onChange(questions.filter((_, j) => j !== i))} aria-label={`Remove question ${q.label}`}><Trash2 className="size-4" /></Button>
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {!readOnly && <Button variant="secondary" size="sm" onClick={add} disabled={questions.length >= 10}><Plus className="size-3.5" aria-hidden />Add question</Button>}
    </fieldset>
  );
}
