"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, CalendarDays, CircleAlert, Clock, Hourglass, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { bookingUrl } from "@/lib/calendars/urls";
import type { PublicTypeDetail } from "@/server/calendars/public-booking";
import { SlotPicker, TimeZoneSelect, useDetectedTimeZone, type PublicSlot } from "./slot-picker";
import { durationLabel, formatDate, formatShortDate, formatTime, formatTimeRange, zoneLabel } from "./time";
import { LocationIcon } from "./details";

type Step = "time" | "details" | "review";
type Errors = Partial<Record<string, string>>;

const EMAIL = /^[^\s@<>()[\]\\,;:]+@[^\s@<>()[\]\\,;:]+\.[^\s@<>()[\]\\,;:]{2,}$/;
const PHONE = /^[0-9+()\-.\s]{7,30}$/;
const MIN_FORM_AGE_MS = 3_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function newKey(): string {
  try {
    return crypto.randomUUID();
  } catch {
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
}

export function BookingFlow({
  business, calendar, type, slugs, formToken, typeCount, renderedAt,
}: {
  business: { name: string; brandColor: string | null; timezone: string };
  calendar: { name: string };
  type: PublicTypeDetail;
  slugs: { org: string; calendar: string; type: string };
  formToken: string;
  typeCount: number;
  /** The server's clock when the page was rendered; the time picker counts today from it. */
  renderedAt: number;
}) {
  const router = useRouter();
  const detected = useDetectedTimeZone();
  const [tzChoice, setTzChoice] = React.useState<string | null>(null);
  const timeZone = tzChoice ?? detected ?? business.timezone;
  const [step, setStep] = React.useState<Step>("time");
  const [slot, setSlot] = React.useState<PublicSlot | null>(null);
  const [reloadKey, setReloadKey] = React.useState(0);
  const [banner, setBanner] = React.useState<{ text: string; reload?: boolean } | null>(null);
  const [errors, setErrors] = React.useState<Errors>({});
  const [submitting, setSubmitting] = React.useState(false);
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [website, setWebsite] = React.useState("");
  const [answers, setAnswers] = React.useState<Record<string, string>>({});
  const mountedAt = React.useRef(0);
  const attemptKey = React.useRef<string | null>(null);
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const moved = React.useRef(false);
  const source = React.useMemo(() => ({ kind: "page" as const, org: slugs.org, calendar: slugs.calendar, type: slugs.type }), [slugs.org, slugs.calendar, slugs.type]);

  React.useEffect(() => {
    mountedAt.current = Date.now();
  }, []);
  // Moving between steps puts focus on the new step's heading, so screen readers and keyboards follow along.
  React.useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    headingRef.current?.focus();
  }, [step]);

  const go = (next: Step) => {
    moved.current = true;
    setStep(next);
  };
  // Any change to what is being booked makes the next confirm a new submit.
  const touched = () => {
    attemptKey.current = null;
  };

  const validate = (): Errors => {
    const e: Errors = {};
    if (!name.trim()) e.name = "Please enter your name.";
    const em = email.trim();
    const ph = phone.trim();
    if (em && !EMAIL.test(em)) e.email = "Enter a valid email address.";
    else if (type.requireEmail && !em) e.email = "Please enter your email address.";
    if (ph && (!PHONE.test(ph) || ph.replace(/\D/g, "").length < 7)) e.phone = "Enter a phone number, for example +63 917 123 4567.";
    else if (type.requirePhone && !ph) e.phone = "Please enter your phone number.";
    if (!em && !ph && !e.email && !e.phone) e.email = `Enter an email address or a phone number so ${business.name} can reach you.`;
    for (const q of type.questions) {
      const v = (answers[q.key] ?? "").trim();
      if (q.required && !v) e[`answers.${q.key}`] = "Please answer this question.";
    }
    return e;
  };

  const review = (ev: React.FormEvent) => {
    ev.preventDefault();
    const e = validate();
    setErrors(e);
    const firstBad = Object.keys(e)[0];
    if (firstBad) {
      document.getElementById(`bf-${firstBad.replace(".", "-")}`)?.focus();
      return;
    }
    setBanner(null);
    go("review");
  };

  const submit = async () => {
    if (!slot || submitting) return;
    setSubmitting(true);
    setBanner(null);
    const age = Date.now() - mountedAt.current;
    if (age < MIN_FORM_AGE_MS) await sleep(MIN_FORM_AGE_MS - age);
    attemptKey.current ??= newKey();
    const payload = {
      org: slugs.org, calendar: slugs.calendar, type: slugs.type, startAt: slot.start, timeZone, name: name.trim(), email: email.trim(), phone: phone.trim(),
      answers: Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v)), notes: notes.trim(),
      idempotencyKey: attemptKey.current, formToken, website,
    };
    const send = async () => {
      const res = await fetch("/api/public/booking/book", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(payload) });
      const json = (await res.json().catch(() => null)) as { ok?: boolean; code?: string; error?: string; field?: string; confirmationUrl?: string } | null;
      return { res, json };
    };
    try {
      let { res, json } = await send();
      if (json?.code === "too_fast") {
        await sleep(MIN_FORM_AGE_MS);
        ({ res, json } = await send());
      }
      if (res.ok && json?.ok && json.confirmationUrl) {
        router.push(json.confirmationUrl);
        return;
      }
      const message = json?.error ?? "We couldn't complete this booking. Please try again.";
      if (json?.code === "slot_taken") {
        setSlot(null);
        touched();
        setReloadKey((k) => k + 1);
        setBanner({ text: message });
        go("time");
      } else if (json?.code === "invalid" && json.field) {
        if (json.field === "startAt" || json.field === "timeZone") {
          setBanner({ text: message });
          go("time");
        } else {
          setErrors({ [json.field]: message });
          setBanner({ text: message });
          go("details");
        }
      } else if (json?.code === "expired") {
        setBanner({ text: message, reload: true });
      } else {
        setBanner({ text: message });
      }
      setSubmitting(false);
    } catch {
      setBanner({ text: "We couldn't reach the booking service. Check your connection and try again." });
      setSubmitting(false);
    }
  };

  const facts = (
    <ul className="mt-4 space-y-2.5 text-[14px] text-ink-2">
      <li className="flex items-center gap-2.5"><Clock className="size-4 shrink-0 text-muted" aria-hidden />{durationLabel(type.durationMinutes)}</li>
      {type.locationLabel && <li className="flex items-center gap-2.5"><LocationIcon kind={type.locationKind} className="size-4 shrink-0 text-muted" />{type.locationLabel}</li>}
      {type.capacity > 1 && <li className="flex items-center gap-2.5"><Users className="size-4 shrink-0 text-muted" aria-hidden />Group session, up to {type.capacity} people</li>}
      {type.requiresConfirmation && <li className="flex items-center gap-2.5"><Hourglass className="size-4 shrink-0 text-muted" aria-hidden />{business.name} confirms each booking</li>}
    </ul>
  );

  return (
    <Card className="overflow-clip">
      <div className="grid lg:grid-cols-[18rem_minmax(0,1fr)]">
        <aside className="border-b border-line p-4 sm:p-6 lg:border-b-0 lg:border-r">
          {typeCount > 1 && (
            <Link href={bookingUrl(slugs.org, slugs.calendar)} className="mb-4 inline-flex min-h-11 items-center gap-1.5 rounded-lg text-[14px] font-medium text-primary-ink hover:underline sm:min-h-0">
              <ArrowLeft className="size-4" aria-hidden />All appointment types
            </Link>
          )}
          <p className="text-[13px] font-medium text-muted">{calendar.name}</p>
          <h1 className="mt-1 text-[22px] font-semibold leading-tight tracking-[-0.03em] text-ink">{type.name}</h1>
          {facts}
          {type.description && <p className="mt-4 whitespace-pre-line text-[14px] leading-relaxed text-muted">{type.description}</p>}
          {slot && step !== "time" && (
            <div className="mt-5 rounded-xl border border-primary/20 bg-primary-soft px-3.5 py-3 text-[14px] text-primary-ink">
              <p className="flex items-center gap-2 font-semibold"><CalendarDays className="size-4" aria-hidden />{formatDate(slot.start, timeZone)}</p>
              <p className="mt-1 tabular-nums">{formatTimeRange(slot.start, slot.end, timeZone)}</p>
              <p className="mt-0.5 text-[12px] opacity-80">{zoneLabel(timeZone)}</p>
            </div>
          )}
        </aside>

        <section className="min-w-0 p-4 sm:p-6" aria-labelledby="bf-step-heading">
          <ol className="mb-5 flex items-center gap-2 text-[12px] font-medium text-muted" aria-label="Booking steps">
            {(["time", "details", "review"] as Step[]).map((s, i) => (
              <li key={s} className="flex items-center gap-2" aria-current={step === s ? "step" : undefined}>
                {i > 0 && <span aria-hidden className="h-px w-4 bg-line-strong" />}
                <span className={cn("inline-flex items-center gap-1.5", step === s && "text-ink")}>
                  <span className={cn("inline-flex size-5 items-center justify-center rounded-full border text-[12px]", step === s ? "border-primary bg-primary text-primary-on" : "border-line-strong")}>{i + 1}</span>
                  {s === "time" ? "Time" : s === "details" ? "Details" : "Confirm"}
                </span>
              </li>
            ))}
          </ol>

          {banner && (
            <div role="alert" className="mb-5 flex flex-wrap items-start justify-between gap-3 rounded-xl border border-danger/20 bg-danger-soft px-4 py-3 text-[14px] text-danger-ink">
              <p className="flex min-w-0 items-start gap-2"><CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /><span>{banner.text}</span></p>
              {banner.reload && <Button type="button" variant="secondary" size="sm" onClick={() => window.location.reload()}>Reload page</Button>}
            </div>
          )}

          {step === "time" && (
            <div>
              <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <h2 id="bf-step-heading" ref={headingRef} tabIndex={-1} className="text-[17px] font-semibold tracking-[-0.02em] text-ink outline-none">Choose a date and time</h2>
                <div className="sm:w-64"><TimeZoneSelect id="bf-tz" value={timeZone} onChange={setTzChoice} suggested={[detected, business.timezone]} /></div>
              </div>
              <SlotPicker
                idPrefix="bf" source={source} timeZone={timeZone} maxDaysAhead={type.maxDaysAhead} renderedAt={renderedAt} capacity={type.capacity} reloadKey={reloadKey}
                selected={slot} onSelect={(s) => { setSlot(s); touched(); setBanner(null); }}
              />
              {slot && (
                <div className="sticky bottom-0 -mx-4 mt-6 flex flex-col gap-3 border-t border-line bg-surface/95 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4 backdrop-blur sm:-mx-6 sm:flex-row sm:items-center sm:justify-between sm:px-6">
                  <p className="text-[14px] text-ink-2"><span className="font-semibold text-ink">{formatShortDate(slot.start, timeZone)}</span> at <span className="font-semibold text-ink tabular-nums">{formatTime(slot.start, timeZone)}</span></p>
                  <Button type="button" onClick={() => go("details")}>Continue</Button>
                </div>
              )}
            </div>
          )}

          {step === "details" && slot && (
            <form onSubmit={review} noValidate className="relative">
              <div className="mb-5 flex items-center justify-between gap-3">
                <h2 id="bf-step-heading" ref={headingRef} tabIndex={-1} className="text-[17px] font-semibold tracking-[-0.02em] text-ink outline-none">Your details</h2>
                <Button type="button" variant="ghost" size="sm" onClick={() => go("time")}><ArrowLeft className="size-4" aria-hidden />Change time</Button>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Full name" htmlFor="bf-name" error={errors.name} className="sm:col-span-2">
                  <Input id="bf-name" value={name} onChange={(e) => { setName(e.target.value); touched(); }} autoComplete="name" required maxLength={120} aria-invalid={Boolean(errors.name)} />
                </Field>
                <Field label="Email" htmlFor="bf-email" error={errors.email} optional={!type.requireEmail}>
                  <Input id="bf-email" type="email" inputMode="email" value={email} onChange={(e) => { setEmail(e.target.value); touched(); }} autoComplete="email" required={type.requireEmail} maxLength={320} aria-invalid={Boolean(errors.email)} />
                </Field>
                <Field label="Phone" htmlFor="bf-phone" error={errors.phone} optional={!type.requirePhone} hint="Include your country code, like +63 917 123 4567.">
                  <Input id="bf-phone" type="tel" inputMode="tel" value={phone} onChange={(e) => { setPhone(e.target.value); touched(); }} autoComplete="tel" required={type.requirePhone} maxLength={30} aria-invalid={Boolean(errors.phone)} />
                </Field>
                {type.questions.map((q) => {
                  const id = `bf-answers-${q.key}`;
                  const err = errors[`answers.${q.key}`];
                  const set = (v: string) => { setAnswers((a) => ({ ...a, [q.key]: v })); touched(); };
                  return (
                    <Field key={q.key} label={q.label} htmlFor={id} error={err} optional={!q.required} className="sm:col-span-2">
                      {q.type === "textarea" ? (
                        <Textarea id={id} value={answers[q.key] ?? ""} onChange={(e) => set(e.target.value)} maxLength={2000} required={q.required} aria-invalid={Boolean(err)} />
                      ) : q.type === "select" ? (
                        <Select id={id} value={answers[q.key] ?? ""} onChange={(e) => set(e.target.value)} required={q.required} aria-invalid={Boolean(err)}>
                          <option value="">Choose one</option>
                          {q.options.map((o) => <option key={o} value={o}>{o}</option>)}
                        </Select>
                      ) : (
                        <Input id={id} value={answers[q.key] ?? ""} onChange={(e) => set(e.target.value)} maxLength={300} required={q.required} aria-invalid={Boolean(err)} />
                      )}
                    </Field>
                  );
                })}
                <Field label="Anything we should know?" htmlFor="bf-notes" optional className="sm:col-span-2">
                  <Textarea id="bf-notes" value={notes} onChange={(e) => { setNotes(e.target.value); touched(); }} maxLength={2000} />
                </Field>
              </div>
              {/* Left empty by people; filled by bots. Hidden from sight, keyboards and screen readers. */}
              <div aria-hidden="true" className="absolute -left-[10000px] top-auto size-px overflow-hidden">
                <label htmlFor="bf-website">Website</label>
                <input id="bf-website" name="website" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
              </div>
              <p className="mt-5 text-[13px] leading-relaxed text-muted">
                {business.name} will use these details to manage this appointment and to contact you about it. After you book, keep the link
                on the next page: it&apos;s how you see this booking later.
              </p>
              <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button type="submit">Review booking</Button>
              </div>
            </form>
          )}

          {step === "review" && slot && (
            <div>
              <div className="mb-5 flex items-center justify-between gap-3">
                <h2 id="bf-step-heading" ref={headingRef} tabIndex={-1} className="text-[17px] font-semibold tracking-[-0.02em] text-ink outline-none">Review and confirm</h2>
              </div>
              <dl className="divide-y divide-line rounded-xl border border-line text-[14px]">
                {([
                  ["Appointment", type.name],
                  ["Date", formatDate(slot.start, timeZone)],
                  ["Time", `${formatTimeRange(slot.start, slot.end, timeZone)} · ${zoneLabel(timeZone)}`],
                  ...(type.locationLabel ? [["Where", type.locationLabel]] : []),
                  ["Name", name.trim()],
                  ...(email.trim() ? [["Email", email.trim()]] : []),
                  ...(phone.trim() ? [["Phone", phone.trim()]] : []),
                  ...type.questions.filter((q) => (answers[q.key] ?? "").trim()).map((q) => [q.label, answers[q.key].trim()]),
                  ...(notes.trim() ? [["Notes", notes.trim()]] : []),
                ] as Array<[string, string]>).map(([k, v]) => (
                  <div key={k} className="grid gap-1 px-4 py-3 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4">
                    <dt className="text-muted">{k}</dt>
                    <dd className="min-w-0 whitespace-pre-line break-words text-ink">{v}</dd>
                  </div>
                ))}
              </dl>
              {type.requiresConfirmation && (
                <p className="mt-4 rounded-xl bg-warning-soft px-4 py-3 text-[14px] text-warning-ink">{business.name} confirms each booking. You&apos;ll see it as a request until they do.</p>
              )}
              <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button type="button" variant="secondary" onClick={() => go("details")} disabled={submitting}>Edit details</Button>
                <Button type="button" onClick={submit} loading={submitting}>{type.requiresConfirmation ? "Request booking" : "Confirm booking"}</Button>
              </div>
            </div>
          )}
        </section>
      </div>
    </Card>
  );
}
