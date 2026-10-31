"use client";

import * as React from "react";
import { ArrowRight, Briefcase, Building2, Lock, Mail, MailCheck, UserRound, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/primitives";
import { FIELD_COPY, LINK_SENT_COPY } from "@/lib/demo/copy";
import { type FormField } from "@/lib/demo/outcomes";
import { DemoNotice } from "@/components/demo/shell";

// The form that asks for a demo. It works without scripts (a plain post to the demo API, which sends the person back to the page with one word in the address); with scripts it
// sends the same fields as JSON, keeps what was typed when something is wrong, and says how it went where the person is looking. Nothing the person typed is ever put in an address.

export interface RequestFormProps {
  industries: ReadonlyArray<{ value: string; label: string }>;
  notice: { consent: string; marketing: string; details: string[] };
  /** Campaign tags from the page address (utm_source and so on), carried along as hidden fields. */
  utm: Record<string, string>;
  /** Fields the server named after a post without scripts. */
  initialErrors?: FormField[];
}

type Errors = Partial<Record<FormField, string>>;
type State = { status: "idle" } | { status: "sending" } | { status: "sent" } | { status: "error"; message: string | null };

const checkboxRow = "flex min-h-11 cursor-pointer items-start gap-3 rounded-lg px-1 py-1.5 text-[14px] leading-relaxed text-ink-2";
const checkbox = "mt-0.5 size-5 shrink-0 rounded border-line-strong accent-primary";

/** A control with a small icon at its left edge. The icon is decoration: the label and the control keep their own association. */
function Adorned({ icon: Icon, children }: { icon: LucideIcon; children: React.ReactNode }) {
  return (
    <div className="relative">
      <Icon aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 z-10 size-4 -translate-y-1/2 text-faint" />
      {children}
    </div>
  );
}

const STEPS_AFTER = ["Open the email from iAcquire.", "Press the button inside it. Your demo window starts when you press it.", "Look around: the AI team, the CRM and Automation Studio."];

export function DemoRequestForm({ industries, notice, utm, initialErrors = [] }: RequestFormProps) {
  const [state, setState] = React.useState<State>({ status: "idle" });
  const [errors, setErrors] = React.useState<Errors>(() => Object.fromEntries(initialErrors.map((f) => [f, FIELD_COPY[f]])));
  const statusRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (state.status === "sent" || state.status === "error") statusRef.current?.focus();
  }, [state]);

  // Pressing Enter in a field while a request is on its way would send a second one (each sends an email), so the form is held in a ref, not in state that may be a render behind.
  const inFlight = React.useRef(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    const fd = new FormData(event.currentTarget);
    const text = (k: string) => (typeof fd.get(k) === "string" ? (fd.get(k) as string) : "");
    setState({ status: "sending" });
    setErrors({});
    try {
      const res = await fetch("/api/public/demo/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          ...utm,
          name: text("name"),
          email: text("email"),
          business: text("business"),
          industry: text("industry"),
          consent: text("consent") === "on",
          marketingOptIn: text("marketingOptIn") === "on",
          company_website: text("company_website"),
        }),
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: { message?: string }; fields?: Errors } | null;
      if (body?.ok) return setState({ status: "sent" });
      setErrors(body?.fields ?? {});
      setState({ status: "error", message: body?.fields && Object.keys(body.fields).length ? null : (body?.error?.message ?? "The request could not be sent. Please try again.") });
    } catch {
      setState({ status: "error", message: "The request could not be sent. Check your connection and try again." });
    } finally {
      inFlight.current = false;
    }
  }

  if (state.status === "sent") {
    return (
      <div ref={statusRef} tabIndex={-1} role="status" className="space-y-4 rounded-2xl border border-success/25 bg-success-soft p-5 text-success-ink outline-none">
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-success/15">
            <MailCheck className="size-5" aria-hidden />
          </span>
          <div>
            <p className="text-[17px] font-semibold leading-snug">Check your email</p>
            <p className="mt-1 text-[14px] leading-relaxed">{LINK_SENT_COPY}</p>
          </div>
        </div>
        <ol className="space-y-2 border-t border-success/20 pt-4 text-[14px] leading-relaxed">
          {STEPS_AFTER.map((t, i) => (
            <li key={t} className="flex gap-3">
              <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-success/20 text-[12px] font-semibold">{i + 1}</span>
              {t}
            </li>
          ))}
        </ol>
      </div>
    );
  }

  const sending = state.status === "sending";
  return (
    <form method="post" action="/api/public/demo/start" onSubmit={submit} className="space-y-4" aria-describedby={state.status === "error" && state.message ? "request-error" : undefined}>
      {state.status === "error" && state.message && (
        <div ref={statusRef} tabIndex={-1} className="outline-none">
          <DemoNotice id="request-error" notice={{ tone: "error", text: state.message }} />
        </div>
      )}
      {Object.entries(utm).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <Field label="Your name" htmlFor="demo-name" error={errors.name}>
        <Adorned icon={UserRound}>
          <Input id="demo-name" name="name" required maxLength={120} autoComplete="name" className="pl-10" aria-invalid={errors.name ? true : undefined} />
        </Adorned>
      </Field>
      <Field label="Work email" htmlFor="demo-email" hint="We email your demo link here. Please use your work address." error={errors.email}>
        <Adorned icon={Mail}>
          <Input id="demo-email" name="email" type="email" inputMode="email" required maxLength={254} autoComplete="email" className="pl-10" aria-invalid={errors.email ? true : undefined} />
        </Adorned>
      </Field>
      <Field label="Business name" htmlFor="demo-business" error={errors.business}>
        <Adorned icon={Building2}>
          <Input id="demo-business" name="business" required maxLength={160} autoComplete="organization" className="pl-10" aria-invalid={errors.business ? true : undefined} />
        </Adorned>
      </Field>
      <Field label="Industry" htmlFor="demo-industry" error={errors.industry}>
        <Adorned icon={Briefcase}>
          <Select id="demo-industry" name="industry" required defaultValue="" className="pl-10" aria-invalid={errors.industry ? true : undefined}>
            <option value="" disabled>
              Choose the closest
            </option>
            {industries.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Adorned>
      </Field>

      {/* A field no person sees or tabs to. A program that fills every field fills it, and is told it worked. */}
      <div aria-hidden className="absolute -left-[9999px] top-auto h-px w-px overflow-hidden">
        <label>
          Company website
          <input name="company_website" tabIndex={-1} autoComplete="off" />
        </label>
      </div>

      <div className="sx-panel-flat space-y-0.5 p-2.5">
        <label className={checkboxRow}>
          <input type="checkbox" name="consent" required className={checkbox} aria-invalid={errors.consent ? true : undefined} />
          <span>{notice.consent}</span>
        </label>
        {errors.consent && (
          <p className="px-1 pb-1 text-[13px] text-danger-ink" role="alert">
            {errors.consent}
          </p>
        )}
        <label className={checkboxRow}>
          <input type="checkbox" name="marketingOptIn" className={checkbox} />
          <span>{notice.marketing}</span>
        </label>
      </div>

      <Button type="submit" variant="brand" size="lg" className="w-full" loading={sending}>
        {sending ? (
          "Sending"
        ) : (
          <>
            Email me my demo link
            <ArrowRight className="size-4" aria-hidden />
          </>
        )}
      </Button>
      {sending && (
        <p className="sr-only" role="status">
          Sending your request
        </p>
      )}
      <ul className="space-y-2 border-t border-line pt-4 text-[12.5px] leading-relaxed text-muted">
        {notice.details.map((d) => (
          <li key={d} className="flex gap-2.5">
            <Lock className="mt-0.5 size-3.5 shrink-0 text-faint" aria-hidden />
            <span>{d}</span>
          </li>
        ))}
      </ul>
    </form>
  );
}
