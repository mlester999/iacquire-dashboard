"use client";

import * as React from "react";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { describeVisibility, shownQuestions } from "@/lib/crm/forms/visibility";
import type { PublicFormDef, PublicQuestion } from "@/lib/crm/forms/spec";

// A native form as visitors fill it in: the hosted form page and the builder's preview draw the same thing. It is a real HTML form that
// posts without any script; with script it also hides questions whose conditions don't hold, keeps the answers on screen when something
// needs fixing, and shows the thank-you without leaving the page.

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Black or white text, whichever reads better on the colour (WCAG relative luminance). */
function readableOn(hex: string): string {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return 1.05 / (l + 0.05) >= (l + 0.05) / 0.05 ? "#ffffff" : "#0a0d14";
}

export interface PublicFormProps {
  def: PublicFormDef;
  /** Where the form posts. Null in the builder's preview: everything works except sending. */
  action: string | null;
  /** Hidden values the page adds (workspace, form, signed time token, the visit's landing page and referrer). */
  hidden?: Record<string, string>;
  /** The business's colour for the send button. */
  accent?: string | null;
  idPrefix?: string;
}

type Sent = { message: string | null };

const subscribeNever = () => () => undefined;

/** The page's own host, as the server compares the referrer with it (none while drawn on the server). */
const ownHost = () => (typeof window === "undefined" ? null : window.location.hostname);

const inputClass =
  "w-full rounded-xl border border-line-strong bg-surface px-3.5 text-[15px] text-ink shadow-soft outline-none transition placeholder:text-faint focus:border-primary focus:ring-4 focus:ring-primary/12 aria-[invalid=true]:border-danger disabled:opacity-60";

export function PublicForm({ def, action, hidden = {}, accent, idPrefix = "pf" }: PublicFormProps) {
  const formRef = React.useRef<HTMLFormElement>(null);
  // True once the page is running in the browser (false while it is drawn on the server, and for anyone without script).
  const enhanced = React.useSyncExternalStore(subscribeNever, () => true, () => false);
  // The visit the form posts (its landing page and referrer): hidden attribution values come from it, as on the server.
  const visit = React.useMemo(() => ({ landing: hidden._l || null, referrer: hidden._r || null }), [hidden._l, hidden._r]);
  const hiddenFields = React.useMemo(() => def.hidden ?? [], [def.hidden]);
  // What shows before anything is answered; every change to the answers works it out again.
  const [shown, setShown] = React.useState<Set<string>>(() => shownQuestions(def.questions, hiddenFields, () => [], visit, ownHost()));
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [message, setMessage] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);
  const [sent, setSent] = React.useState<Sent | null>(null);
  const [previewNote, setPreviewNote] = React.useState(false);
  const sentRef = React.useRef<HTMLHeadingElement>(null);
  const alertRef = React.useRef<HTMLDivElement>(null);
  const id = (k: string) => `${idPrefix}-${k}`;
  const byKey = React.useMemo(() => new Map<string, { label: string; options?: PublicQuestion["options"] }>([...hiddenFields, ...def.questions].map((q) => [q.key, q])), [def.questions, hiddenFields]);

  const recompute = React.useCallback(() => {
    const el = formRef.current;
    if (!el) return;
    const fd = new FormData(el);
    // Disabled (hidden) inputs aren't in FormData, which is exactly right: a hidden question counts as not answered.
    setShown(shownQuestions(def.questions, hiddenFields, (name) => fd.getAll(name).filter((v): v is string => typeof v === "string"), visit, ownHost()));
  }, [def.questions, hiddenFields, visit]);

  React.useEffect(() => {
    if (sent) sentRef.current?.focus();
  }, [sent]);

  const isShown = (q: PublicQuestion) => !enhanced || shown.has(q.key);
  const conditional = (q: PublicQuestion) => Boolean(q.visibleWhen?.conditions.length);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    if (!action) {
      e.preventDefault();
      setPreviewNote(true);
      return;
    }
    if (!enhanced) return; // the browser posts the form itself
    e.preventDefault();
    const el = e.currentTarget;
    const body = new URLSearchParams();
    for (const [k, v] of new FormData(el)) if (typeof v === "string") body.append(k, v);
    setSending(true);
    setMessage(null);
    try {
      const res = await fetch(action, { method: "POST", body, headers: { Accept: "application/json" } });
      const json = (await res.json().catch(() => null)) as { ok?: boolean; message?: string | null; redirect?: string | null; errors?: Record<string, string> } | null;
      if (json?.ok) {
        setErrors({});
        if (json.redirect) {
          window.location.assign(json.redirect);
          return;
        }
        setSent({ message: json.message ?? null });
        return;
      }
      setErrors(json?.errors ?? {});
      setMessage(json?.message ?? "Your answers couldn't be sent. Please try again.");
      requestAnimationFrame(() => {
        const first = def.questions.find((q) => json?.errors?.[q.key]);
        const target = first ? el.querySelector<HTMLElement>(`[data-q="${first.key}"] input, [data-q="${first.key}"] select, [data-q="${first.key}"] textarea`) : json?.errors?.consent ? el.querySelector<HTMLElement>("input[name=consent]") : null;
        if (target) target.focus();
        else alertRef.current?.focus();
      });
    } catch {
      setMessage("Your answers couldn't be sent. Check your connection and try again.");
      requestAnimationFrame(() => alertRef.current?.focus());
    } finally {
      setSending(false);
    }
  }

  if (sent) {
    return (
      <div className="rounded-2xl border border-line bg-surface p-6 text-center shadow-card sm:p-8" role="status">
        <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-success-soft text-success-ink">
          <CheckCircle2 className="size-6" aria-hidden />
        </div>
        <h2 ref={sentRef} tabIndex={-1} className="mt-4 text-[20px] font-semibold tracking-[-0.02em] text-ink outline-none">Thank you</h2>
        <p className="mx-auto mt-2 max-w-md whitespace-pre-line text-[14.5px] leading-relaxed text-muted">{sent.message || "Your answers have been sent."}</p>
      </div>
    );
  }

  const btnStyle = accent && HEX.test(accent) ? { backgroundColor: accent, color: readableOn(accent) } : undefined;
  const errorFor = (k: string) => errors[k];
  // The email and phone saved to the contact: at least one must be given (the server checks it the same way). With both on the form
  // neither is marked optional and one note, tied to both, says either will do; with only one, it is required like any required question.
  const oneOf = def.requireOneOf ?? [];
  const pair = oneOf.length > 1 ? new Set(oneOf) : null;
  const firstOfPair = pair ? def.questions.find((q) => pair.has(q.key))?.key : undefined;
  const asAsked = (q: PublicQuestion): PublicQuestion => (oneOf.length === 1 && oneOf[0] === q.key && !q.required ? { ...q, required: true } : q);

  return (
    <form ref={formRef} method="post" action={action ?? undefined} onSubmit={onSubmit} onInput={recompute} onChange={recompute} aria-label={def.title} className="space-y-5">
      {Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      {/* A person never sees or reaches this field; anything that fills it is treated as a bot. */}
      <div aria-hidden className="absolute -left-[9999px] h-px w-px overflow-hidden">
        <label>Leave this field empty<input type="text" name="website" tabIndex={-1} autoComplete="off" defaultValue="" /></label>
      </div>

      {message && (
        <div ref={alertRef} tabIndex={-1} role="alert" className="flex items-start gap-2.5 rounded-xl border border-danger/25 bg-danger-soft px-3.5 py-3 text-[14px] text-danger-ink outline-none">
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{message}</span>
        </div>
      )}

      <div className="grid gap-x-4 gap-y-5 sm:grid-cols-2">
        {def.questions.map((raw) => {
          const q = asAsked(raw);
          const visible = isShown(q);
          const hint = !enhanced && conditional(q) ? describeVisibility(q.visibleWhen, (k) => byKey.get(k)) : null;
          const inPair = Boolean(pair?.has(q.key));
          return (
            <React.Fragment key={q.key}>
              {q.key === firstOfPair && <p id={id("one-of")} className="text-[13px] leading-relaxed text-muted sm:col-span-2">Give an email address or a phone number, or both, so we can reply.</p>}
              <div data-q={q.key} hidden={!visible} className={cn("min-w-0", q.width === "half" ? "sm:col-span-1" : "sm:col-span-2")}>
                <Question
                  q={q}
                  fieldId={id(q.key)}
                  disabled={!visible}
                  // A conditional question is required only once it is shown; without script the server decides.
                  nativeRequired={q.required && (!conditional(q) || enhanced)}
                  error={errorFor(q.key)}
                  condition={hint}
                  optionalMark={!inPair}
                  describedByExtra={inPair ? id("one-of") : null}
                />
              </div>
            </React.Fragment>
          );
        })}
      </div>

      {(def.consent.text || def.consent.marketing) && (
        <div className="space-y-3 rounded-xl border border-line bg-surface-2/60 p-4">
          {def.consent.text && (
            <div>
              <label className="flex items-start gap-3 text-[14px] leading-relaxed text-ink-2">
                <input
                  type="checkbox" name="consent" value="yes" required aria-invalid={errorFor("consent") ? true : undefined} aria-describedby={errorFor("consent") ? id("consent-error") : undefined}
                  className="mt-0.5 size-[18px] shrink-0 accent-[var(--primary)]"
                />
                <span>{def.consent.text}</span>
              </label>
              {errorFor("consent") && <p id={id("consent-error")} className="mt-1.5 pl-[30px] text-[13px] text-danger-ink">{errorFor("consent")}</p>}
            </div>
          )}
          {def.consent.marketing && (
            <label className="flex items-start gap-3 text-[14px] leading-relaxed text-muted">
              <input type="checkbox" name="marketing" value="yes" className="mt-0.5 size-[18px] shrink-0 accent-[var(--primary)]" />
              <span>{def.consent.marketing}</span>
            </label>
          )}
        </div>
      )}

      <div className="space-y-2">
        <button
          type="submit"
          disabled={sending}
          style={btnStyle}
          className={cn(
            "inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl px-6 text-[15px] font-semibold shadow-soft transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-60 sm:w-auto",
            !btnStyle && "bg-ink text-surface hover:bg-ink/90",
          )}
        >
          {sending && <Loader2 className="size-4 animate-spin" aria-hidden />}
          {sending ? "Sending…" : def.submitLabel}
        </button>
        {previewNote && <p role="status" className="text-[13px] text-muted">Preview only: answers aren&apos;t sent from here.</p>}
      </div>
    </form>
  );
}

function Question({ q, fieldId, disabled, nativeRequired, error, condition, optionalMark = true, describedByExtra = null }: {
  q: PublicQuestion; fieldId: string; disabled: boolean; nativeRequired: boolean; error?: string; condition: string | null;
  /** False for the email and phone of which one must be given: neither is optional on its own, and a shared note says so. */
  optionalMark?: boolean;
  /** A note elsewhere on the form that applies to this question too. */
  describedByExtra?: string | null;
}) {
  const name = `q.${q.key}`;
  const describedBy = [describedByExtra, q.help ? `${fieldId}-help` : null, condition ? `${fieldId}-cond` : null, error ? `${fieldId}-error` : null].filter(Boolean).join(" ") || undefined;
  const invalid = error ? true : undefined;
  const v = q.validation ?? {};
  const optional = !q.required && optionalMark ? <span className="ml-1 text-[12px] font-normal text-faint">(optional)</span> : null;
  const meta = (
    <>
      {q.help && <p id={`${fieldId}-help`} className="text-[13px] leading-relaxed text-muted">{q.help}</p>}
      {condition && <p id={`${fieldId}-cond`} className="text-[13px] text-muted">Answer this if {condition}.</p>}
      {error && <p id={`${fieldId}-error`} className="text-[13px] text-danger-ink">{error}</p>}
    </>
  );

  if (q.type === "checkbox") {
    return (
      <div className="space-y-1.5">
        <label className="flex min-h-11 items-start gap-3 rounded-xl border border-line bg-surface px-3.5 py-3 text-[14px] text-ink shadow-soft has-[:checked]:border-primary/40 has-[:checked]:bg-primary-soft/40">
          <input type="checkbox" name={name} value="yes" disabled={disabled} required={nativeRequired} aria-invalid={invalid} aria-describedby={describedBy} className="mt-0.5 size-[18px] shrink-0 accent-[var(--primary)]" />
          <span>{q.label}{optional}</span>
        </label>
        {meta}
      </div>
    );
  }

  if ((q.type === "single_choice" && q.display === "radio") || q.type === "multiple_choice") {
    const multi = q.type === "multiple_choice";
    return (
      <fieldset className="min-w-0 space-y-2" disabled={disabled} aria-describedby={describedBy} aria-invalid={invalid}>
        <legend className="mb-1 text-[14px] font-medium text-ink-2">{q.label}{optional}</legend>
        <div className={cn("grid gap-2", q.options.length > 4 && "sm:grid-cols-2")}>
          {q.options.map((o, i) => (
            <label key={o.value} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-line bg-surface px-3.5 py-2.5 text-[14px] text-ink shadow-soft transition has-[:checked]:border-primary/50 has-[:checked]:bg-primary-soft/50 has-[:focus-visible]:ring-4 has-[:focus-visible]:ring-primary/15">
              <input type={multi ? "checkbox" : "radio"} name={name} value={o.value} required={!multi && nativeRequired && i === 0 ? true : undefined} className="size-[18px] shrink-0 accent-[var(--primary)]" />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
        {meta}
      </fieldset>
    );
  }

  const label = <label htmlFor={fieldId} className="text-[14px] font-medium text-ink-2">{q.label}{optional}</label>;
  const common = { id: fieldId, name, disabled, required: nativeRequired, "aria-invalid": invalid, "aria-describedby": describedBy, autoComplete: q.autocomplete ?? undefined };
  let control: React.ReactNode;
  switch (q.type) {
    case "long_text":
      control = <textarea {...common} rows={4} maxLength={v.maxLength ?? 2000} minLength={v.minLength} placeholder={q.placeholder ?? undefined} className={cn(inputClass, "min-h-[112px] resize-y py-2.5 leading-relaxed")} />;
      break;
    case "single_choice":
      control = (
        <div className="relative">
          <select {...common} defaultValue="" className={cn(inputClass, "h-12 appearance-none pr-9")}>
            <option value="">Choose one</option>
            {q.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <svg aria-hidden viewBox="0 0 20 20" className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted"><path d="M5.5 7.5 10 12l4.5-4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </div>
      );
      break;
    case "number":
      control = <input {...common} type="number" inputMode={v.integer ? "numeric" : "decimal"} step={v.integer ? 1 : "any"} min={v.min} max={v.max} placeholder={q.placeholder ?? undefined} className={cn(inputClass, "h-12")} />;
      break;
    case "date":
      control = <input {...common} type="date" min={v.minDate} max={v.maxDate} className={cn(inputClass, "h-12")} />;
      break;
    case "email":
      control = <input {...common} type="email" inputMode="email" maxLength={320} placeholder={q.placeholder ?? undefined} className={cn(inputClass, "h-12")} />;
      break;
    case "phone":
      control = <input {...common} type="tel" inputMode="tel" maxLength={30} placeholder={q.placeholder ?? undefined} className={cn(inputClass, "h-12")} />;
      break;
    default:
      control = <input {...common} type="text" maxLength={v.maxLength ?? 300} minLength={v.minLength} placeholder={q.placeholder ?? undefined} className={cn(inputClass, "h-12")} />;
  }
  return (
    <div className="space-y-1.5">
      {label}
      {control}
      {meta}
    </div>
  );
}
