"use client";

import * as React from "react";
import { MailCheck } from "lucide-react";
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

const checkboxRow = "flex min-h-11 cursor-pointer items-start gap-3 rounded-xl py-1.5 text-[14px] leading-relaxed text-ink-2";
const checkbox = "mt-0.5 size-5 shrink-0 rounded border-line-strong accent-primary";

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
      <div ref={statusRef} tabIndex={-1} role="status" className="rounded-2xl border border-success/25 bg-success-soft p-5 text-success-ink outline-none">
        <p className="flex items-center gap-2 text-[16px] font-semibold">
          <MailCheck className="size-5 shrink-0" aria-hidden />
          Check your email
        </p>
        <p className="mt-2 text-[14px] leading-relaxed">{LINK_SENT_COPY}</p>
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
        <Input id="demo-name" name="name" required maxLength={120} autoComplete="name" aria-invalid={errors.name ? true : undefined} />
      </Field>
      <Field label="Work email" htmlFor="demo-email" hint="We email your demo link here. Please use your work address." error={errors.email}>
        <Input id="demo-email" name="email" type="email" inputMode="email" required maxLength={254} autoComplete="email" aria-invalid={errors.email ? true : undefined} />
      </Field>
      <Field label="Business name" htmlFor="demo-business" error={errors.business}>
        <Input id="demo-business" name="business" required maxLength={160} autoComplete="organization" aria-invalid={errors.business ? true : undefined} />
      </Field>
      <Field label="Industry" htmlFor="demo-industry" error={errors.industry}>
        <Select id="demo-industry" name="industry" required defaultValue="" aria-invalid={errors.industry ? true : undefined}>
          <option value="" disabled>
            Choose the closest
          </option>
          {industries.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </Field>

      {/* A field no person sees or tabs to. A program that fills every field fills it, and is told it worked. */}
      <div aria-hidden className="absolute -left-[9999px] top-auto h-px w-px overflow-hidden">
        <label>
          Company website
          <input name="company_website" tabIndex={-1} autoComplete="off" />
        </label>
      </div>

      <div className="space-y-1">
        <label className={checkboxRow}>
          <input type="checkbox" name="consent" required className={checkbox} aria-invalid={errors.consent ? true : undefined} />
          <span>{notice.consent}</span>
        </label>
        {errors.consent && (
          <p className="text-[13px] text-danger-ink" role="alert">
            {errors.consent}
          </p>
        )}
        <label className={checkboxRow}>
          <input type="checkbox" name="marketingOptIn" className={checkbox} />
          <span>{notice.marketing}</span>
        </label>
      </div>

      <Button type="submit" size="lg" className="w-full" loading={sending}>
        {sending ? "Sending" : "Email me my demo link"}
      </Button>
      {sending && (
        <p className="sr-only" role="status">
          Sending your request
        </p>
      )}
      <ul className="space-y-1.5 text-[13px] leading-relaxed text-muted">
        {notice.details.map((d) => (
          <li key={d}>{d}</li>
        ))}
      </ul>
    </form>
  );
}
