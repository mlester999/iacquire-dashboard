"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { Dialog, Segmented } from "@/components/ui/overlays";
import { bookableSlotsAction, bookAppointmentAction } from "@/app/actions/crm-scheduling";
import { searchContactsAction } from "@/app/actions/crm";
import { RecordPicker, useCrmAction } from "@/components/crm/ui";
import { permissionNeeded } from "@/lib/permissions";
import { SlotPicker, type PickerSlot } from "@/components/crm/scheduling/slot-picker";
import { dateTimeIn } from "@/components/crm/scheduling/format";
import type { ScheduleFilters } from "@/server/calendars/schedule";
import type { CrmScope } from "@/server/crm/page";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * A person books for a customer: choose the type, a real free time (staff may book inside the notice period), the customer (an existing
 * contact, or new details, matched to an existing contact by email or phone), and for round robin optionally who hosts.
 */
export function NewAppointmentDialog({
  scope, filters, timeZone, today, defaultDate, onClose, onBooked,
}: {
  scope: CrmScope;
  filters: ScheduleFilters;
  timeZone: string;
  today: string;
  defaultDate: string;
  onClose: () => void;
  onBooked?: (appointmentId: string) => void;
}) {
  const { run, busy } = useCrmAction();
  const types = filters.calendars.flatMap((c) => c.types.map((t) => ({ ...t, calendar: c })));
  const [typeId, setTypeId] = React.useState(() => (filters.calendars.find((c) => c.isDefault)?.types[0] ?? types[0])?.id ?? "");
  const [hostId, setHostId] = React.useState("");
  const [picked, setPicked] = React.useState<{ key: string; slot: PickerSlot } | null>(null);
  const canSearch = !!scope.can["contacts.view"];
  const [mode, setMode] = React.useState<"existing" | "new">(canSearch ? "existing" : "new");
  const [contact, setContact] = React.useState<{ id: string; name: string } | null>(null);
  const [person, setPerson] = React.useState({ firstName: "", lastName: "", email: "", phone: "" });
  const [answers, setAnswers] = React.useState<Record<string, string>>({});
  const [notes, setNotes] = React.useState("");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [idempotencyKey] = React.useState(() => `staff:${crypto.randomUUID()}`);

  const type = types.find((t) => t.id === typeId) ?? null;
  const cal = type?.calendar ?? null;
  const hostNames = Object.fromEntries(filters.hosts.map((h) => [h.id, h.name]));
  const calHosts = cal ? cal.hostIds.map((id) => ({ id, name: hostNames[id] ?? "Host" })) : [];
  const roundRobin = cal?.assignment === "round_robin" && calHosts.length > 1;
  const loadKey = `${typeId}|${roundRobin ? hostId : ""}`;
  const slot = picked?.key === loadKey ? picked.slot : null;
  const load = React.useCallback(
    (from: string, to: string) => bookableSlotsAction(scope.orgId, { typeId, from, to, hostId: roundRobin && hostId ? hostId : null }),
    [scope.orgId, typeId, hostId, roundRobin],
  );

  const validate = () => {
    const e: Record<string, string> = {};
    if (!type) e.type = "Choose an appointment type.";
    if (!slot) e.slot = "Choose a free time.";
    if (mode === "existing" && !contact) e.contact = "Choose the customer, or switch to a new contact.";
    if (mode === "new") {
      if (!person.firstName.trim()) e.firstName = "Enter the customer's first name.";
      if (!person.email.trim() && !person.phone.trim()) e.email = "Add an email address or a phone number.";
      else if (person.email.trim() && !EMAIL.test(person.email.trim())) e.email = "Enter a valid email address.";
    }
    for (const q of type?.questions ?? []) if (q.required && !answers[q.key]?.trim()) e[`q:${q.key}`] = "This answer is required.";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = async () => {
    if (!validate() || !type || !slot) return;
    const r = await run(
      "book",
      () =>
        bookAppointmentAction(scope.orgId, {
          typeId: type.id,
          startAt: slot.start,
          hostId: roundRobin && hostId ? hostId : null,
          contact: mode === "existing" && contact ? { kind: "existing", id: contact.id } : { kind: "new", firstName: person.firstName.trim(), lastName: person.lastName.trim() || null, email: person.email.trim() || null, phone: person.phone.trim() || null },
          answers: Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v)),
          notes: notes.trim() || null,
          idempotencyKey,
        }),
      (res) => (res.created ? `Booked for ${dateTimeIn(res.startAt, timeZone)}.` : "That booking was already made."),
    );
    if (r) {
      onBooked?.(r.appointmentId);
      onClose();
    }
  };

  if (!types.length) {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()} title="New appointment" size="sm" footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
        <p className="text-[14px] leading-relaxed text-muted">
          There are no appointment types to book yet. {scope.can["calendars.manage"] ? "Add them under Calendars & Types." : permissionNeeded("Adding them under Calendars & Types", "calendars.manage")}
        </p>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="New appointment"
      description="Book for a customer. Only times that are free are offered."
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button form="new-appointment" type="submit" loading={busy("book")}>Book appointment</Button>
        </>
      }
    >
      <form
        id="new-appointment"
        noValidate
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Appointment type" htmlFor="na-type" error={errors.type}>
            <Select id="na-type" value={typeId} onChange={(e) => { setTypeId(e.target.value); setHostId(""); setAnswers({}); }}>
              {filters.calendars.filter((c) => c.types.length).map((c) => (
                <optgroup key={c.id} label={c.name}>
                  {c.types.map((t) => <option key={t.id} value={t.id}>{t.name} · {t.durationMinutes} min</option>)}
                </optgroup>
              ))}
            </Select>
          </Field>
          {roundRobin ? (
            <Field label="Host" htmlFor="na-host" hint="Leave on round robin to give it to whoever is next in turn.">
              <Select id="na-host" value={hostId} onChange={(e) => setHostId(e.target.value)}>
                <option value="">Round robin (next free host)</option>
                {calHosts.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
              </Select>
            </Field>
          ) : (
            <div className="space-y-1.5">
              <p className="text-[14px] font-medium text-ink-2">Host</p>
              <p className="flex min-h-11 items-center rounded-xl border border-line bg-surface-2 px-3.5 text-[14px] text-ink-2 sm:min-h-10">
                {cal?.assignment === "collective" ? `Everyone attends: ${calHosts.map((h) => h.name).join(", ")}` : calHosts[0]?.name ?? "No host yet"}
              </p>
            </div>
          )}
        </div>

        <div>
          <p className="mb-2 text-[14px] font-medium text-ink-2">Time</p>
          <SlotPicker
            id="na"
            timeZone={timeZone}
            today={today}
            initialDate={defaultDate}
            load={load}
            loadKey={loadKey}
            value={slot?.start ?? null}
            onChange={(s) => setPicked(s ? { key: loadKey, slot: s } : null)}
            hostNames={hostNames}
            showHost={roundRobin && !hostId}
          />
          {errors.slot && <p className="mt-1.5 text-[13px] text-danger-ink" role="alert">{errors.slot}</p>}
        </div>

        <div role="group" aria-labelledby="na-customer" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p id="na-customer" className="text-[14px] font-medium text-ink-2">Customer</p>
            {canSearch && (
              <Segmented id="na-contact-mode" ariaLabel="Customer" size="sm" value={mode} onChange={(v) => { setMode(v); setErrors({}); }}
                options={[{ value: "existing", label: "Existing contact" }, { value: "new", label: "New contact" }]} />
            )}
          </div>
          {mode === "existing" ? (
            <Field label="Contact" htmlFor="na-contact" error={errors.contact}>
              <RecordPicker
                id="na-contact"
                label="Contact"
                placeholder="Search by name, email or phone"
                value={contact ? contact.name || "Unnamed contact" : undefined}
                onClear={() => setContact(null)}
                search={async (q) => {
                  const r = await searchContactsAction(scope.orgId, q);
                  return r.ok ? r.data : [];
                }}
                render={(c) => <span className="flex flex-col"><span>{c.name || "Unnamed contact"}</span><span className="text-[12px] text-muted">{c.email ?? c.phone ?? ""}</span></span>}
                onPick={(c) => setContact({ id: c.id, name: c.name })}
              />
            </Field>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="First name" htmlFor="na-first" error={errors.firstName}>
                <Input id="na-first" autoComplete="off" maxLength={80} value={person.firstName} aria-invalid={!!errors.firstName} onChange={(e) => setPerson({ ...person, firstName: e.target.value })} />
              </Field>
              <Field label="Last name" htmlFor="na-last" optional>
                <Input id="na-last" autoComplete="off" maxLength={80} value={person.lastName} onChange={(e) => setPerson({ ...person, lastName: e.target.value })} />
              </Field>
              <Field label="Email" htmlFor="na-email" error={errors.email} hint="An email or a phone number is needed. An existing contact with the same one is reused.">
                <Input id="na-email" type="email" inputMode="email" autoComplete="off" maxLength={254} value={person.email} aria-invalid={!!errors.email} onChange={(e) => setPerson({ ...person, email: e.target.value })} />
              </Field>
              <Field label="Phone" htmlFor="na-phone" optional>
                <Input id="na-phone" type="tel" inputMode="tel" autoComplete="off" maxLength={40} value={person.phone} onChange={(e) => setPerson({ ...person, phone: e.target.value })} />
              </Field>
            </div>
          )}
        </div>

        {!!type?.questions.length && (
          <fieldset className="space-y-3">
            <legend className="text-[14px] font-medium text-ink-2">Booking questions</legend>
            {type.questions.map((q) => {
              const fid = `na-q-${q.key}`;
              const err = errors[`q:${q.key}`];
              const set = (v: string) => setAnswers({ ...answers, [q.key]: v });
              return (
                <Field key={q.key} label={q.label} htmlFor={fid} optional={!q.required} error={err}>
                  {q.type === "textarea" ? (
                    <Textarea id={fid} rows={3} maxLength={2000} value={answers[q.key] ?? ""} aria-invalid={!!err} onChange={(e) => set(e.target.value)} />
                  ) : q.type === "select" ? (
                    <Select id={fid} value={answers[q.key] ?? ""} aria-invalid={!!err} onChange={(e) => set(e.target.value)}>
                      <option value="">Choose…</option>
                      {(q.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                    </Select>
                  ) : (
                    <Input id={fid} maxLength={300} value={answers[q.key] ?? ""} aria-invalid={!!err} onChange={(e) => set(e.target.value)} />
                  )}
                </Field>
              );
            })}
          </fieldset>
        )}

        <Field label="Notes" htmlFor="na-notes" optional hint="Visible to your team on the appointment.">
          <Textarea id="na-notes" rows={3} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </form>
    </Dialog>
  );
}
