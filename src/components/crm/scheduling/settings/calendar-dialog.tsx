"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/primitives";
import { Dialog, Switch } from "@/components/ui/overlays";
import { cn } from "@/lib/utils";
import { createCalendarAction, updateCalendarAction } from "@/app/actions/crm-calendar-settings";
import { Avatar, useCrmAction } from "@/components/crm/ui";
import { ROLE_LABELS, type EffectiveRole } from "@/lib/permissions";
import { ASSIGNMENT_INFO, ColorPicker, DRAFT_EXPLAINER, ROUND_ROBIN_INFO, SettingRow, useResetOnOpen } from "@/components/crm/scheduling/settings/shared";
import type { Assignment, CalendarView } from "@/server/calendars/setup";
import type { CrmScope } from "@/server/crm/page";

export interface SchedulingPerson {
  id: string;
  name: string;
  role: string;
}

/**
 * Creates or edits a calendar: who hosts it, how bookings are shared between them, and its booking page. A new calendar goes to its
 * page next so its first appointment type can be added; its booking page can be turned on once it has one.
 */
export function CalendarDialog({ open, onOpenChange, scope, calendar, people }: { open: boolean; onOpenChange: (o: boolean) => void; scope: CrmScope; calendar: CalendarView | null; people: SchedulingPerson[] }) {
  const router = useRouter();
  const { run, busy } = useCrmAction();
  const initial = React.useMemo(() => ({
    name: calendar?.name ?? "",
    description: calendar?.description ?? "",
    assignment: calendar?.assignment ?? ("single" as Assignment),
    roundRobinMode: calendar?.roundRobinMode ?? ("balanced" as const),
    color: calendar?.color ?? null,
    isDefault: calendar?.isDefault ?? false,
    isPublic: calendar?.public ?? false,
    bookingIntro: calendar?.bookingIntro ?? "",
    // Only current members can host; anyone who has left the workspace is shown below and dropped on save.
    members: calendar
      ? calendar.members.filter((m) => people.some((p) => p.id === m.userId)).map((m) => ({ userId: m.userId, priority: m.priority }))
      : scope.userId && people.some((p) => p.id === scope.userId) ? [{ userId: scope.userId, priority: 50 }] : [],
    // A draft from a Blueprint suggests weekly hours; hosts who have none yet can start from them.
    useHoursTemplate: !!calendar?.hoursTemplate?.length && calendar.status === "draft",
  }), [calendar, people, scope.userId]);
  const draft = calendar?.status === "draft";
  const hasTemplate = !!calendar?.hoursTemplate?.length;
  const [form, setForm] = React.useState(initial);
  const [q, setQ] = React.useState("");
  const [tried, setTried] = React.useState(false);
  useResetOnOpen(open, () => {
    setForm(initial);
    setQ("");
    setTried(false);
  });
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  // Hosts who left the workspace still show, so removing them is a visible choice.
  const known = new Map(people.map((p) => [p.id, p]));
  const formerHosts = (calendar?.members ?? []).filter((m) => !known.has(m.userId)).map((m) => ({ id: m.userId, name: m.name, role: "former" }));
  const everyone = [...people, ...formerHosts];
  const shown = q.trim() ? everyone.filter((p) => p.name.toLowerCase().includes(q.trim().toLowerCase())) : everyone;
  const selected = new Set(form.members.map((m) => m.userId));

  const errors = {
    name: !form.name.trim() ? "Name the calendar." : form.name.trim().length > 80 ? "Up to 80 characters." : null,
    members: !form.members.length ? "Choose at least one host." : form.assignment === "single" && form.members.length > 1 ? "A one-person calendar has one host. Choose round robin or collective for a team." : null,
    intro: form.bookingIntro.trim().length > 500 ? "Up to 500 characters." : null,
  };
  const invalid = Object.values(errors).some(Boolean);

  function toggleMember(id: string) {
    setForm((f) => {
      const has = f.members.some((m) => m.userId === id);
      const members = has ? f.members.filter((m) => m.userId !== id) : [...f.members, { userId: id, priority: 50 }];
      // A second host means the calendar is shared: switch from "one person" so the choice stays valid, and say so in the form.
      const assignment = !has && f.assignment === "single" && members.length > 1 ? "round_robin" : f.assignment;
      return { ...f, members, assignment };
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTried(true);
    if (invalid) return;
    const payload = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      assignment: form.assignment,
      roundRobinMode: form.roundRobinMode,
      color: form.color,
      bookingIntro: form.bookingIntro.trim() || null,
      members: form.members.map((m) => ({ userId: m.userId, priority: Math.max(0, Math.min(100, Math.round(m.priority))) })),
      ...(form.isDefault && !calendar?.isDefault && !draft ? { isDefault: true } : {}),
      ...(hasTemplate && form.useHoursTemplate ? { useHoursTemplate: true } : {}),
    };
    if (calendar) {
      const ok = await run("save", () => updateCalendarAction(scope.orgId, calendar.id, { ...payload, ...(form.isPublic !== calendar.public && !draft ? { public: form.isPublic } : {}) }),
        (r) => (r.hoursApplied.length ? `Calendar saved. Suggested hours given to ${r.hoursApplied.length} ${r.hoursApplied.length === 1 ? "host" : "hosts"} without hours.` : "Calendar saved."));
      if (ok) onOpenChange(false);
    } else {
      const r = await run("save", () => createCalendarAction(scope.orgId, payload), "Calendar created. Add what customers can book next.");
      if (r) {
        onOpenChange(false);
        router.push(`${scope.base}/calendars/${r.id}`);
      }
    }
  }

  const formId = calendar ? `cal-form-${calendar.id}` : "cal-form-new";
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={calendar ? `Edit ${calendar.name}` : "New calendar"}
      description="A calendar is a set of hosts and the appointment types customers can book with them."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" form={formId} loading={busy("save")}>{calendar ? "Save calendar" : "Create calendar"}</Button>
        </>
      }
    >
      <form id={formId} className="space-y-6" onSubmit={submit} noValidate>
        <section className="space-y-3">
          <Field label="Name" htmlFor={`${formId}-name`} error={tried ? errors.name : null}>
            <Input id={`${formId}-name`} value={form.name} onChange={(e) => set("name", e.target.value)} maxLength={80} placeholder="Consultations" aria-invalid={(tried && !!errors.name) || undefined} autoFocus={!calendar} />
          </Field>
          <Field label="Description" htmlFor={`${formId}-desc`} optional>
            <Textarea id={`${formId}-desc`} rows={2} value={form.description} onChange={(e) => set("description", e.target.value)} maxLength={500} />
          </Field>
          <ColorPicker label="Colour on the calendar" name={`${formId}-color`} value={form.color} onChange={(c) => set("color", c)} />
        </section>

        <section className="space-y-3" aria-labelledby={`${formId}-hosts-h`}>
          <div>
            <h3 id={`${formId}-hosts-h`} className="text-[13px] font-semibold text-ink">Hosts</h3>
            <p className="mt-0.5 text-[12.5px] text-muted">The people who take these appointments. Each host&apos;s working hours are set in Availability.</p>
          </div>
          {everyone.length > 8 && (
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden />
              <Input aria-label="Find a person" placeholder="Find a person" className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          )}
          <ul className="scrollbar-thin max-h-64 space-y-1 overflow-y-auto rounded-xl border border-line p-1" aria-label="Team members">
            {shown.map((p) => {
              const on = selected.has(p.id);
              const member = form.members.find((m) => m.userId === p.id);
              return (
                <li key={p.id} className={cn("flex flex-wrap items-center gap-3 rounded-lg px-2 py-1.5", on && "bg-surface-2")}>
                  <label className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-3 sm:min-h-9">
                    <input type="checkbox" className="size-4 shrink-0 accent-primary" checked={on} disabled={p.role === "former"} onChange={() => toggleMember(p.id)} />
                    <Avatar name={p.name} size="sm" />
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-medium text-ink">{p.name}{p.id === scope.userId ? " (you)" : ""}</span>
                      <span className="block text-[12px] text-muted">{p.role === "former" ? "Left the workspace. Removed from this calendar when you save." : ROLE_LABELS[p.role as EffectiveRole] ?? p.role}</span>
                    </span>
                  </label>
                  {on && form.assignment === "round_robin" && form.roundRobinMode === "priority" && (
                    <label className="flex items-center gap-2 text-[12.5px] text-muted">
                      Priority
                      <Input type="number" inputMode="numeric" min={0} max={100} className="w-20" value={member?.priority ?? 50}
                        onChange={(e) => setForm((f) => ({ ...f, members: f.members.map((m) => (m.userId === p.id ? { ...m, priority: Number(e.target.value) || 0 } : m)) }))}
                        aria-label={`Priority for ${p.name}, 0 to 100`} />
                    </label>
                  )}
                </li>
              );
            })}
            {!shown.length && <li className="px-3 py-2 text-[13px] text-muted">Nobody matches.</li>}
          </ul>
          {tried && errors.members && <p role="alert" className="text-[12.5px] text-danger-ink">{errors.members}</p>}
          {hasTemplate && (
            <label className="flex cursor-pointer items-start gap-2.5 text-[12.5px] text-ink-2">
              <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-primary" checked={form.useHoursTemplate} onChange={(e) => set("useHoursTemplate", e.target.checked)} />
              <span>Give hosts who have no weekly hours yet this calendar&apos;s suggested hours{calendar?.suggestedTimezone ? ` (${calendar.suggestedTimezone})` : ""}. Hosts with hours keep their own.</span>
            </label>
          )}
        </section>

        <fieldset className="space-y-2">
          <legend className="text-[13px] font-semibold text-ink">How bookings are assigned</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {(Object.keys(ASSIGNMENT_INFO) as Assignment[]).map((a) => {
              const disabled = a === "single" && form.members.length > 1;
              return (
                <label key={a} className={cn("flex cursor-pointer flex-col gap-1 rounded-xl border p-3 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-primary", form.assignment === a ? "border-primary bg-primary-soft/40" : "border-line hover:bg-surface-2", disabled && "cursor-not-allowed opacity-60")}>
                  <span className="flex items-center gap-2">
                    <input type="radio" name={`${formId}-assign`} value={a} checked={form.assignment === a} disabled={disabled} onChange={() => set("assignment", a)} className="accent-primary" />
                    <span className="text-[13px] font-medium text-ink">{ASSIGNMENT_INFO[a].label}</span>
                  </span>
                  <span className="text-[12px] leading-relaxed text-muted">{ASSIGNMENT_INFO[a].explain}</span>
                </label>
              );
            })}
          </div>
          {form.members.length > 1 && <p className="text-[12px] text-muted">With more than one host, choose round robin or collective.</p>}
        </fieldset>

        {form.assignment === "round_robin" && (
          <fieldset className="space-y-2">
            <legend className="text-[13px] font-semibold text-ink">Who gets the next booking</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {(Object.keys(ROUND_ROBIN_INFO) as Array<"balanced" | "priority">).map((m) => (
                <label key={m} className={cn("flex cursor-pointer flex-col gap-1 rounded-xl border p-3 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-primary", form.roundRobinMode === m ? "border-primary bg-primary-soft/40" : "border-line hover:bg-surface-2")}>
                  <span className="flex items-center gap-2">
                    <input type="radio" name={`${formId}-rr`} value={m} checked={form.roundRobinMode === m} onChange={() => set("roundRobinMode", m)} className="accent-primary" />
                    <span className="text-[13px] font-medium text-ink">{ROUND_ROBIN_INFO[m].label}</span>
                  </span>
                  <span className="text-[12px] leading-relaxed text-muted">{ROUND_ROBIN_INFO[m].explain}{m === "priority" ? " Set each host's priority above (0 to 100)." : ""}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}

        <section className="space-y-4 rounded-2xl border border-line p-4">
          {draft && <p className="text-[12.5px] leading-relaxed text-ink-2">{DRAFT_EXPLAINER}</p>}
          <SettingRow
            id={`${formId}-default`}
            label="Default calendar"
            hint={draft ? "Available once this calendar is activated." : calendar?.isDefault ? "This is the default. To change it, make another calendar the default." : "Used when your AI Appointment Setter or a booking request doesn't name a calendar. Its first appointment type is offered."}
            control={<Switch id={`${formId}-default`} checked={form.isDefault} disabled={calendar?.isDefault || draft} onCheckedChange={(v) => set("isDefault", v)} aria-describedby={`${formId}-default-hint`} />}
          />
          {calendar ? (
            <SettingRow
              id={`${formId}-public`}
              label="Public booking page"
              hint={draft ? "Available once this calendar is activated." : "Customers can book the appointment types you show on it. It needs an active host and at least one shown appointment type."}
              control={<Switch id={`${formId}-public`} checked={form.isPublic} disabled={draft} onCheckedChange={(v) => set("isPublic", v)} aria-describedby={`${formId}-public-hint`} />}
            />
          ) : (
            <p className="text-[12.5px] leading-relaxed text-muted">The public booking page can be turned on once this calendar has an appointment type.</p>
          )}
          <Field label="Booking page intro" htmlFor={`${formId}-intro`} optional hint={`${form.bookingIntro.trim().length}/500. A short welcome shown above the appointment types.`} error={tried ? errors.intro : null}>
            <Textarea id={`${formId}-intro`} rows={3} value={form.bookingIntro} onChange={(e) => set("bookingIntro", e.target.value)} maxLength={500} placeholder="Pick a time that suits you." />
          </Field>
        </section>
      </form>
    </Dialog>
  );
}
