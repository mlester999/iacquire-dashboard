"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, CalendarPlus, CalendarX, CircleAlert, CircleCheck, Mail, Phone } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, Textarea } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/overlays";
import type { ManagePageView } from "@/server/calendars/public-booking";
import { SlotPicker, TimeZoneSelect, useDetectedTimeZone, type PublicSlot } from "./slot-picker";
import { cutoffLabel, formatDate, formatShortDate, formatTime } from "./time";
import { AppointmentDetails, secondaryLinkClass, StatusBadge } from "./details";

const MIN_FORM_AGE_MS = 3_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function reasonText(view: ManagePageView): string {
  const who = view.business.name;
  switch (view.cannotChangeReason) {
    case "not_upcoming": return view.appointment.status === "cancelled" ? "This booking is cancelled." : "This appointment is no longer upcoming.";
    case "started": return "This appointment has already started.";
    case "not_allowed": return `${who} doesn't take changes to this booking online. To reschedule or cancel, contact them directly.`;
    case "past_cutoff": return `Online changes close ${cutoffLabel(view.changeCutoffMinutes)} before the appointment. To reschedule or cancel now, contact ${who} directly.`;
    default: return "";
  }
}

type FocusTarget = "heading" | "reschedule" | "notice";

/**
 * The customer's booking: its details, and rescheduling or cancelling when the business allows it. `renderedAt` is the server's clock
 * when the page was rendered, which the time picker counts today from.
 */
export function ManagePanel({ view, token, formToken, renderedAt }: { view: ManagePageView; token: string; formToken: string; renderedAt: number }) {
  const router = useRouter();
  const detected = useDetectedTimeZone();
  const [mode, setMode] = React.useState<"view" | "reschedule">("view");
  const [tzChoice, setTzChoice] = React.useState<string | null>(null);
  const timeZone = tzChoice ?? view.appointment.timeZone;
  const [slot, setSlot] = React.useState<PublicSlot | null>(null);
  const [reloadKey, setReloadKey] = React.useState(0);
  const [busy, setBusy] = React.useState<"reschedule" | "cancel" | null>(null);
  const [banner, setBanner] = React.useState<{ text: string; reload?: boolean } | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const mountedAt = React.useRef(0);
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const rescheduleRef = React.useRef<HTMLButtonElement>(null);
  const noticeRef = React.useRef<HTMLDivElement>(null);
  const focusNext = React.useRef<FocusTarget | null>(null);
  const source = React.useMemo(() => ({ kind: "manage" as const, token }), [token]);
  const a = view.appointment;
  const cancelled = a.status === "cancelled";

  React.useEffect(() => {
    mountedAt.current = Date.now();
  }, []);
  // Switching between viewing the booking and choosing a new time removes the button that had focus, so focus moves on purpose (as
  // BookingFlow does between its steps): to the new card's heading, back to Reschedule, or to the notice saying what changed.
  React.useEffect(() => {
    const target = focusNext.current;
    if (!target) return;
    focusNext.current = null;
    (target === "heading" ? headingRef : target === "notice" ? noticeRef : rescheduleRef).current?.focus();
  }, [mode]);
  const switchTo = (next: "view" | "reschedule", focus: FocusTarget) => {
    focusNext.current = focus;
    setMode(next);
  };

  const post = async (body: Record<string, unknown>) => {
    const age = Date.now() - mountedAt.current;
    if (age < MIN_FORM_AGE_MS) await sleep(MIN_FORM_AGE_MS - age);
    const send = async () => {
      const res = await fetch("/api/public/booking/manage", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ token, formToken, ...body }) });
      return { res, json: (await res.json().catch(() => null)) as { ok?: boolean; code?: string; error?: string; startAt?: string } | null };
    };
    let out = await send();
    if (out.json?.code === "too_fast") {
      await sleep(MIN_FORM_AGE_MS);
      out = await send();
    }
    return out;
  };

  const fail = (json: { code?: string; error?: string } | null) => {
    const text = json?.error ?? "We couldn't make that change. Please try again.";
    if (json?.code === "slot_taken") {
      setSlot(null);
      setReloadKey((k) => k + 1);
    }
    setBanner({ text, reload: json?.code === "stale" || json?.code === "expired" || json?.code === "not_allowed" });
  };

  const reschedule = async () => {
    if (!slot) return;
    setBusy("reschedule");
    setBanner(null);
    try {
      const { res, json } = await post({ action: "reschedule", startAt: slot.start, version: a.version });
      if (res.ok && json?.ok) {
        setNotice(`Your booking is now ${formatDate(json.startAt ?? slot.start, timeZone)} at ${formatTime(json.startAt ?? slot.start, timeZone)}.`);
        switchTo("view", "notice");
        setSlot(null);
        router.refresh();
      } else fail(json);
    } catch {
      setBanner({ text: "We couldn't reach the booking service. Check your connection and try again." });
    } finally {
      setBusy(null);
    }
  };

  const cancel = async () => {
    setBusy("cancel");
    setBanner(null);
    try {
      const { res, json } = await post({ action: "cancel", reason: reason.trim() || undefined });
      if (res.ok && json?.ok) {
        setCancelOpen(false);
        setMode("view");
        setNotice("Your booking is cancelled.");
        router.refresh();
      } else {
        setCancelOpen(false);
        fail(json);
      }
    } catch {
      setCancelOpen(false);
      setBanner({ text: "We couldn't reach the booking service. Check your connection and try again." });
    } finally {
      setBusy(null);
    }
  };

  const contact = (view.business.contactEmail || view.business.contactPhone) && (
    <div className="mt-3 flex flex-wrap gap-2">
      {view.business.contactEmail && (
        <a href={`mailto:${view.business.contactEmail}`} className={secondaryLinkClass}><Mail className="size-4" aria-hidden /><span className="truncate">{view.business.contactEmail}</span></a>
      )}
      {view.business.contactPhone && (
        <a href={`tel:${view.business.contactPhone}`} className={secondaryLinkClass}><Phone className="size-4" aria-hidden />{view.business.contactPhone}</a>
      )}
    </div>
  );

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[24px] font-semibold tracking-[-0.03em] text-ink">Your booking</h1>
        <StatusBadge status={a.status} />
      </div>

      {notice && (
        <div ref={noticeRef} tabIndex={-1} role="status" className="flex items-start gap-2 rounded-xl border border-success/20 bg-success-soft px-4 py-3 text-[13.5px] text-success-ink outline-none">
          <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden />{notice}
        </div>
      )}
      {banner && (
        <div role="alert" className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-danger/20 bg-danger-soft px-4 py-3 text-[13.5px] text-danger-ink">
          <p className="flex min-w-0 items-start gap-2"><CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /><span>{banner.text}</span></p>
          {banner.reload && <Button type="button" variant="secondary" size="sm" onClick={() => window.location.reload()}>Reload page</Button>}
        </div>
      )}

      <Card className="p-4 sm:p-6">
        <AppointmentDetails view={view} />
        <div className="mt-5 flex flex-wrap gap-2 border-t border-line pt-5">
          {view.canChange && mode === "view" && (
            <>
              <Button ref={rescheduleRef} type="button" onClick={() => { switchTo("reschedule", "heading"); setBanner(null); setNotice(null); }}><CalendarClock className="size-4" aria-hidden />Reschedule</Button>
              <Button type="button" variant="secondary" onClick={() => { setCancelOpen(true); setNotice(null); }}><CalendarX className="size-4" aria-hidden />Cancel booking</Button>
            </>
          )}
          {!cancelled && (
            <a href={view.icsUrl} download="appointment.ics" className={secondaryLinkClass}><CalendarPlus className="size-4" aria-hidden />Add to calendar</a>
          )}
          {cancelled && view.bookAgainUrl && <ButtonLink href={view.bookAgainUrl} variant="secondary">Book another time</ButtonLink>}
        </div>
        {view.canChange && view.changeCutoffMinutes > 0 && view.changeDeadline && mode === "view" && (
          <p className="mt-3 text-[12.5px] text-muted">You can reschedule or cancel online until {formatShortDate(view.changeDeadline, timeZone)} at {formatTime(view.changeDeadline, timeZone)}.</p>
        )}
        {!view.canChange && reasonText(view) && (
          <div className="mt-4 rounded-xl bg-surface-2 px-4 py-3 text-[13.5px] text-ink-2">
            <p>{reasonText(view)}</p>
            {(view.cannotChangeReason === "not_allowed" || view.cannotChangeReason === "past_cutoff") && contact}
          </div>
        )}
      </Card>

      {view.canChange && mode === "reschedule" && (
        <NewTimeCard
          headingRef={headingRef} view={view} timeZone={timeZone} onTimeZone={setTzChoice} detected={detected} renderedAt={renderedAt} source={source}
          reloadKey={reloadKey} slot={slot} onSelect={(s) => { setSlot(s); setBanner(null); }} busy={busy === "reschedule"}
          onKeep={() => { switchTo("view", "reschedule"); setSlot(null); }} onConfirm={reschedule}
        />
      )}

      <Dialog
        open={cancelOpen}
        onOpenChange={(o) => busy !== "cancel" && setCancelOpen(o)}
        title="Cancel this booking?"
        description={`${a.typeName} on ${formatDate(a.startAt, timeZone)} at ${formatTime(a.startAt, timeZone)}. ${view.business.name} will see that you cancelled.`}
        size="sm"
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setCancelOpen(false)} disabled={busy === "cancel"}>Keep booking</Button>
            <Button type="button" variant="danger" onClick={cancel} loading={busy === "cancel"}>Cancel booking</Button>
          </>
        }
      >
        <label htmlFor="mp-reason" className="text-[13px] font-medium text-ink-2">Reason <span className="font-normal text-faint">(optional)</span></label>
        <Textarea id="mp-reason" className="mt-1.5" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="Let them know why, if you like." />
      </Dialog>
    </div>
  );
}

/** Choosing a new time for a booking. The heading can take focus (tabIndex -1) so the panel can move focus to it when the card opens. */
export function NewTimeCard({
  headingRef, view, timeZone, onTimeZone, detected, renderedAt, source, reloadKey, slot, onSelect, busy, onKeep, onConfirm,
}: {
  headingRef?: React.Ref<HTMLHeadingElement>;
  view: ManagePageView;
  timeZone: string;
  onTimeZone: (tz: string) => void;
  detected: string | null;
  renderedAt: number;
  source: { kind: "manage"; token: string };
  reloadKey: number;
  slot: PublicSlot | null;
  onSelect: (slot: PublicSlot) => void;
  busy: boolean;
  onKeep: () => void;
  onConfirm: () => void;
}) {
  const a = view.appointment;
  return (
    <Card className="p-4 sm:p-6">
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 id="mp-new-time" ref={headingRef} tabIndex={-1} className="text-[17px] font-semibold tracking-[-0.02em] text-ink outline-none">Choose a new time</h2>
        <div className="sm:w-64"><TimeZoneSelect id="mp-tz" value={timeZone} onChange={onTimeZone} suggested={[detected, a.timeZone]} /></div>
      </div>
      <SlotPicker
        idPrefix="mp" heading="Choose a new date and time" source={source} timeZone={timeZone} maxDaysAhead={view.maxDaysAhead} renderedAt={renderedAt} capacity={1} reloadKey={reloadKey}
        currentStart={a.startAt} selected={slot} onSelect={onSelect}
      />
      <div className="mt-6 flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[13.5px] text-ink-2">
          {slot ? <>Move to <span className="font-semibold text-ink">{formatShortDate(slot.start, timeZone)}</span> at <span className="font-semibold tabular-nums text-ink">{formatTime(slot.start, timeZone)}</span>?</> : "Pick a new time above."}
        </p>
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <Button type="button" variant="secondary" onClick={onKeep} disabled={busy}>Keep current time</Button>
          <Button type="button" onClick={onConfirm} disabled={!slot} loading={busy}>Confirm new time</Button>
        </div>
      </div>
    </Card>
  );
}
