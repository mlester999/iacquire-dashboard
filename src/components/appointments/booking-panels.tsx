"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, CalendarPlus, CheckCircle2, Clock, Search, ShieldCheck, UserRound } from "lucide-react";
import { bookAppointmentAction, cancelBookingAction, loadSlotsAction, renewRemindersAction, savePolicyAction, searchContactsAction } from "@/app/actions/appointments";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input, Select } from "@/components/ui/primitives";
import { Dialog, Switch } from "@/components/ui/overlays";
import { cn, formatDate, relativeTime } from "@/lib/utils";
import type { PendingBookingRow, BookableContact } from "@/server/appointments/overview";
import type { PolicyView } from "@/server/appointments/settings";

type Slot = { start: string; label: string };

/** Pick a person, pick one of the calendar's own free times, and book it. Nothing on the list was added by the portal. */
export function BookDialog({ open, onOpenChange, timeZone }: { open: boolean; onOpenChange: (o: boolean) => void; timeZone: string }) {
  const router = useRouter();
  const [query, setQuery] = React.useState("");
  const [found, setResults] = React.useState<BookableContact[]>([]);
  const [contact, setContact] = React.useState<BookableContact | null>(null);
  const [slots, setSlots] = React.useState<{ calendarId: string; slots: Slot[]; checkedAt: string } | null>(null);
  const [slotError, setSlotError] = React.useState<string | null>(null);
  const [chosen, setChosen] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    let live = true;
    void loadSlotsAction().then((res) => {
      if (!live) return;
      if (res.ok) {
        setSlotError(null);
        setSlots({ calendarId: res.data.calendarId, slots: res.data.slots, checkedAt: res.data.checkedAt });
      } else {
        setSlots(null);
        setSlotError(res.error);
      }
    });
    return () => { live = false; };
  }, [open]);

  React.useEffect(() => {
    if (query.trim().length < 2) return;
    let live = true;
    const t = setTimeout(() => {
      void searchContactsAction(query).then((res) => { if (live && res.ok) setResults(res.data); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [query]);

  const results = query.trim().length < 2 ? [] : found;

  const byDay = React.useMemo(() => {
    const m = new Map<string, Slot[]>();
    for (const s of slots?.slots ?? []) {
      const key = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone }).format(new Date(s.start));
      m.set(key, [...(m.get(key) ?? []), s]);
    }
    return [...m.entries()];
  }, [slots, timeZone]);

  const reset = () => { setQuery(""); setResults([]); setContact(null); setChosen(null); setSlotError(null); };

  const book = async () => {
    if (!contact || !chosen || !slots) return;
    setBusy(true);
    const res = await bookAppointmentAction({ contactId: contact.id, startIso: chosen, calendarId: slots.calendarId });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error);
      // The time may have gone; show the calendar's current list.
      void loadSlotsAction().then((r) => r.ok && setSlots({ calendarId: r.data.calendarId, slots: r.data.slots, checkedAt: r.data.checkedAt }));
      setChosen(null);
      return;
    }
    if (res.data.outcome === "booked") toast.success("Booked. It's on your calendar.");
    else if (res.data.outcome === "needs_manual") toast.message("Time held. Add it to your calendar to finish.", { description: res.data.message });
    else toast.message("Waiting for approval.");
    reset();
    onOpenChange(false);
    router.refresh();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}
      size="lg"
      title="Book an appointment"
      description="Times come straight from your calendar. If it can't be read, nothing is offered."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="brand" loading={busy} disabled={!contact || !chosen} onClick={book}>Book this time</Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field label="Who is it for?" htmlFor="book-contact" hint={contact ? undefined : "Search your contacts by name, email or phone."}>
          {contact ? (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface-2 px-3.5 py-2.5">
              <span className="flex min-w-0 items-center gap-2 text-[14px]"><UserRound className="size-4 shrink-0 text-muted" aria-hidden /><span className="truncate font-medium">{contact.name}</span><span className="truncate text-muted">{contact.detail}</span></span>
              <Button size="sm" variant="ghost" onClick={() => setContact(null)}>Change</Button>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
                <Input id="book-contact" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Start typing a name" className="pl-9" autoComplete="off" />
              </div>
              {results.length > 0 && (
                <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line" aria-label="Matching contacts">
                  {results.map((r) => (
                    <li key={r.id}>
                      <button type="button" onClick={() => setContact(r)} className="flex min-h-11 w-full items-center justify-between gap-3 px-3.5 py-2 text-left text-[13.5px] hover:bg-surface-2">
                        <span className="truncate font-medium">{r.name}</span>
                        <span className="shrink-0 text-[12px] text-muted">{r.detail}{r.linkedToCrm ? "" : " · not in CRM yet"}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {contact && !contact.linkedToCrm && <p className="mt-2 text-[12.5px] text-warning-ink">This contact isn&apos;t linked to your CRM yet, so the booking will wait for someone to add it to the calendar by hand.</p>}
        </Field>

        <div>
          <p className="mb-2 text-[13px] font-medium text-ink-2">Free times</p>
          {slotError ? (
            <p className="flex items-start gap-2 rounded-xl bg-warning-soft px-3.5 py-3 text-[13px] text-warning-ink" role="alert"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />{slotError}</p>
          ) : !slots ? (
            <p className="text-[13px] text-muted">Asking your calendar…</p>
          ) : byDay.length === 0 ? (
            <p className="rounded-xl bg-surface-2 px-3.5 py-3 text-[13px] text-muted">Your calendar shows nothing free in the next two weeks.</p>
          ) : (
            <div className="max-h-72 space-y-4 overflow-y-auto pr-1" role="radiogroup" aria-label="Free times">
              {byDay.map(([day, list]) => (
                <div key={day}>
                  <p className="mb-1.5 text-[12px] font-semibold text-muted">{day}</p>
                  <div className="flex flex-wrap gap-2">
                    {list.map((s) => (
                      <button
                        key={s.start}
                        type="button"
                        role="radio"
                        aria-checked={chosen === s.start}
                        onClick={() => setChosen(s.start)}
                        className={cn("min-h-11 rounded-xl border px-3 text-[13px] font-medium transition sm:min-h-9", chosen === s.start ? "border-primary bg-primary-soft text-primary-ink" : "border-line bg-surface hover:border-line-strong")}
                      >
                        {new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(new Date(s.start))}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
          {slots && <p className="mt-2 text-[12px] text-muted">Read from your calendar {relativeTime(slots.checkedAt)} and checked again when you book. Times are in your workspace time zone.</p>}
        </div>
      </div>
    </Dialog>
  );
}

/** Bookings that are waiting on a person. */
export function PendingBookings({ rows, canBook }: { rows: PendingBookingRow[]; canBook: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  if (!rows.length) return null;
  return (
    <Card className="xl:col-span-3">
      <CardHeader>
        <div>
          <CardTitle>Waiting on you</CardTitle>
          <CardDescription>These times are held so nobody else can take them. Nothing here is booked until your calendar shows it.</CardDescription>
        </div>
        <Badge tone="warning">{rows.length}</Badge>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-line">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 py-3">
              <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-xl", r.status === "awaiting_approval" ? "bg-primary-soft text-primary-ink" : "bg-warning-soft text-warning-ink")}>
                {r.status === "awaiting_approval" ? <ShieldCheck className="size-4" aria-hidden /> : <Clock className="size-4" aria-hidden />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-medium">{r.contactName} · {r.label}</p>
                <p className="text-[12.5px] text-muted">
                  {r.status === "awaiting_approval" ? `Your Appointment Setter proposed this ${relativeTime(r.createdAt)}. Confirm it in Approvals.` : `Add this to your calendar${r.reason ? `. ${r.reason}` : ""}`}
                </p>
              </div>
              {r.status === "awaiting_approval" ? (
                <Link href="/approvals" className="inline-flex h-11 items-center rounded-xl px-3 text-[13px] font-medium text-primary hover:underline sm:h-8">Review in Approvals</Link>
              ) : null}
              {canBook && (
                <Button
                  size="sm"
                  variant="ghost"
                  loading={busy === r.id}
                  onClick={async () => {
                    setBusy(r.id);
                    const res = await cancelBookingAction(r.id);
                    setBusy(null);
                    if (!res.ok) return void toast.error(res.error);
                    toast.success("Released.");
                    router.refresh();
                  }}
                >
                  Release the time
                </Button>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

const OFFSET_CHOICES = [
  { value: 10080, label: "1 week before" },
  { value: 2880, label: "2 days before" },
  { value: 1440, label: "1 day before" },
  { value: 240, label: "4 hours before" },
  { value: 120, label: "2 hours before" },
  { value: 60, label: "1 hour before" },
];

/** The workspace's booking rules, reminders and whether the Appointment Setter may book on its own. */
export function BookingRules({ policy, canGoAutonomous }: { policy: PolicyView; canGoAutonomous: boolean }) {
  const router = useRouter();
  const [p, setP] = React.useState(policy);
  const [busy, setBusy] = React.useState(false);
  const dirty = JSON.stringify(p) !== JSON.stringify(policy);

  const save = async () => {
    setBusy(true);
    const res = await savePolicyAction({
      defaultCalendarId: p.defaultCalendarId, slotMinutes: p.slotMinutes, minNoticeMinutes: p.minNoticeMinutes, maxDaysAhead: p.maxDaysAhead, lateCancelHours: p.lateCancelHours,
      remindersEnabled: p.remindersEnabled, reminderOffsetsMinutes: p.reminderOffsetsMinutes, ...(canGoAutonomous ? { aiBookingEnabled: p.aiBookingEnabled } : {}),
    });
    setBusy(false);
    if (!res.ok) return void toast.error(res.error);
    toast.success("Booking rules saved");
    router.refresh();
  };
  const toggleOffset = (v: number) => setP((cur) => ({ ...cur, reminderOffsetsMinutes: cur.reminderOffsetsMinutes.includes(v) ? cur.reminderOffsetsMinutes.filter((x) => x !== v) : [...cur.reminderOffsetsMinutes, v].sort((a, b) => b - a).slice(0, 3) }));

  return (
    <Card className="xl:col-span-3">
      <CardHeader>
        <div>
          <CardTitle>Booking rules</CardTitle>
          <CardDescription>How far ahead and how short a notice customers can book, and what your AI employees may do on their own.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Calendar for bookings" htmlFor="rule-cal" hint={policy.calendars.length ? undefined : "No calendar is connected yet."}>
            <Select id="rule-cal" value={p.defaultCalendarId ?? ""} onChange={(e) => setP({ ...p, defaultCalendarId: e.target.value || null })} disabled={!policy.calendars.length}>
              <option value="">{policy.calendars.length === 1 ? "The connected calendar" : "Choose a calendar"}</option>
              {policy.calendars.map((c, i) => <option key={c} value={c}>{`Calendar ${i + 1} (${c.slice(0, 6)}…)`}</option>)}
            </Select>
          </Field>
          <Field label="Appointment length" htmlFor="rule-len">
            <Select id="rule-len" value={p.slotMinutes} onChange={(e) => setP({ ...p, slotMinutes: Number(e.target.value) })}>
              {[15, 30, 45, 60, 90, 120].map((m) => <option key={m} value={m}>{m} minutes</option>)}
            </Select>
          </Field>
          <Field label="Shortest notice" htmlFor="rule-notice" hint="For the AI. People can book sooner.">
            <Select id="rule-notice" value={p.minNoticeMinutes} onChange={(e) => setP({ ...p, minNoticeMinutes: Number(e.target.value) })}>
              {[[0, "None"], [60, "1 hour"], [120, "2 hours"], [240, "4 hours"], [1440, "1 day"], [2880, "2 days"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </Field>
          <Field label="Furthest ahead" htmlFor="rule-ahead">
            <Select id="rule-ahead" value={p.maxDaysAhead} onChange={(e) => setP({ ...p, maxDaysAhead: Number(e.target.value) })}>
              {[7, 14, 21, 30].map((d) => <option key={d} value={d}>{d} days</option>)}
            </Select>
          </Field>
          <Field label="Late-cancellation notice" htmlFor="rule-late" hint="Cancelling closer than this is flagged for you." className="lg:col-span-2">
            <Select id="rule-late" value={p.lateCancelHours ?? ""} onChange={(e) => setP({ ...p, lateCancelHours: e.target.value === "" ? null : Number(e.target.value) })}>
              <option value="">No rule</option>
              {[2, 4, 12, 24, 48].map((h) => <option key={h} value={h}>{h} hours</option>)}
            </Select>
          </Field>
        </div>

        <div className="divide-y divide-line rounded-2xl border border-line">
          <label className="flex items-start justify-between gap-4 p-4">
            <span>
              <span className="block text-[14px] font-medium">Send appointment reminders</span>
              <span className="mt-0.5 block text-[12.5px] leading-relaxed text-muted">A short text or email before each appointment. Only to customers who haven&apos;t opted out, never during quiet hours, and always from your credit balance. This records your standing permission, which you renew every 90 days.</span>
            </span>
            <Switch checked={p.remindersEnabled} aria-label="Send appointment reminders" onCheckedChange={(v) => setP({ ...p, remindersEnabled: v })} />
          </label>
          {p.remindersEnabled && (
            <div className="space-y-3 p-4">
              <p className="text-[13px] font-medium">When to remind <span className="font-normal text-muted">(up to three)</span></p>
              <div className="flex flex-wrap gap-2" role="group" aria-label="Reminder times">
                {OFFSET_CHOICES.map((o) => {
                  const on = p.reminderOffsetsMinutes.includes(o.value);
                  return (
                    <button key={o.value} type="button" aria-pressed={on} onClick={() => toggleOffset(o.value)} className={cn("min-h-11 rounded-full border px-3.5 text-[13px] font-medium transition sm:min-h-9", on ? "border-primary bg-primary-soft text-primary-ink" : "border-line bg-surface hover:border-line-strong")}>
                      {o.label}
                    </button>
                  );
                })}
              </div>
              {policy.remindersAuthorization === "expired" && (
                <p className="flex flex-wrap items-center gap-3 rounded-xl bg-warning-soft px-3.5 py-3 text-[13px] text-warning-ink" role="alert">
                  <AlertTriangle className="size-4 shrink-0" aria-hidden /> Your permission has lapsed, so reminders are paused.
                  <Button size="sm" variant="secondary" onClick={async () => { const r = await renewRemindersAction(); if (!r.ok) return void toast.error(r.error); toast.success("Renewed for 90 days"); router.refresh(); }}>Renew now</Button>
                </p>
              )}
              {policy.remindersAuthorization === "active" && policy.remindersAuthorizedUntil && (
                <p className="flex items-center gap-2 text-[12.5px] text-muted"><CheckCircle2 className="size-3.5 text-success-ink" aria-hidden /> Permission active until {formatDate(policy.remindersAuthorizedUntil, "UTC")}.</p>
              )}
            </div>
          )}
          <label className={cn("flex items-start justify-between gap-4 p-4", !canGoAutonomous && "opacity-70")}>
            <span>
              <span className="block text-[14px] font-medium">Let the Appointment Setter book without asking</span>
              <span className="mt-0.5 block text-[12.5px] leading-relaxed text-muted">
                Off by default: it proposes a time from your real calendar and you confirm in Approvals. When this is on, an employee that works autonomously books a time the customer clearly chose, and the calendar must still confirm it.
                {!canGoAutonomous && " Only the business owner can change this."}
              </span>
            </span>
            <Switch checked={p.aiBookingEnabled} disabled={!canGoAutonomous} aria-label="Let the Appointment Setter book without asking" onCheckedChange={(v) => setP({ ...p, aiBookingEnabled: v })} />
          </label>
        </div>

        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button variant="ghost" disabled={!dirty || busy} onClick={() => setP(policy)}>Discard</Button>
          <Button disabled={!dirty} loading={busy} onClick={save}>Save rules</Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function BookButton({ onClick }: { onClick: () => void }) {
  return (
    <Button size="sm" variant="brand" onClick={onClick}>
      <CalendarPlus className="size-3.5" /> Book a time
    </Button>
  );
}
