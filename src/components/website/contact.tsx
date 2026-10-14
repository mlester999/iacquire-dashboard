import * as React from "react";
import { Clock, Mail, MapPin, Phone } from "lucide-react";
import type { SiteSection } from "@/lib/website/schema";
import { CARD, RADIUS, RADIUS_LG, BTN_RADIUS, SectionHead, SectionShell, Wrap, type Band, type RenderContext } from "./parts";

interface ContactData { heading: string; intro: string; showDetails: boolean; showForm: boolean; submitLabel: string }
type Props = { ctx: RenderContext; section: SiteSection; band: Band; index: number };

/** A draft's phone number may still have spaces while it is being typed; links and display always use the bare number. */
const cleanPhone = (v: string) => v.replace(/[^\d+]/g, "");
export const telHref = (v: string) => `tel:${cleanPhone(v)}`;
export const displayPhone = (raw: string) => {
  const e164 = cleanPhone(raw);
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164.replace(/^(\+\d{1,3})(\d+)$/, (_, cc: string, rest: string) => `${cc} ${rest.replace(/(\d{3})(?=\d)/g, "$1 ")}`);
};

const field = `w-full min-h-11 border border-[color:var(--s-line)] bg-[var(--s-surface)] px-3.5 py-2.5 text-base text-[color:var(--s-ink)] ${RADIUS} placeholder:text-[color:var(--s-muted)] focus-visible:border-[color:var(--s-primary)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color:var(--s-primary-text)] disabled:opacity-70`;
const label = "mb-1.5 block text-sm font-semibold text-[color:var(--s-ink)]";

export function Details({ ctx, className = "" }: { ctx: RenderContext; className?: string }) {
  const b = ctx.content.business;
  const rows = [
    b.phone && { icon: Phone, label: "Phone", node: <a className="font-semibold text-[color:var(--s-ink)] underline-offset-4 hover:underline" href={telHref(b.phone)}>{displayPhone(b.phone)}</a> },
    b.email && { icon: Mail, label: "Email", node: <a className="break-all font-semibold text-[color:var(--s-ink)] underline-offset-4 hover:underline" href={`mailto:${b.email}`}>{b.email}</a> },
    b.address && { icon: MapPin, label: "Address", node: <span className="whitespace-pre-line text-[color:var(--s-ink)]">{b.address}</span> },
    b.hours && { icon: Clock, label: "Hours", node: <span className="whitespace-pre-line text-[color:var(--s-ink)]">{b.hours}</span> },
  ].filter(Boolean) as Array<{ icon: typeof Phone; label: string; node: React.ReactNode }>;
  if (!rows.length) return null;
  return (
    <dl className={`space-y-5 ${className}`}>
      {rows.map((r) => (
        // A description-list group may only contain dt and dd, so the icon lives inside the dt and is placed beside it.
        <div key={r.label} className="grid grid-cols-[2.75rem_1fr] gap-x-4">
          <dt className="relative col-start-2 min-h-5 text-sm text-[color:var(--s-muted)]">
            <span aria-hidden className={`absolute right-full top-0 mr-4 flex size-11 items-center justify-center bg-[var(--s-primary-soft)] text-[color:var(--s-primary-text)] ${RADIUS}`}>
              <r.icon className="size-5" />
            </span>
            {r.label}
          </dt>
          <dd className="col-start-2 mt-0.5 min-h-6">{r.node}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A plain HTML form that posts back to the site itself. It works without JavaScript, carries a hidden
 * trap field and a signed timing token for spam control, and records consent explicitly.
 */
export function EnquiryForm({ ctx, submitLabel }: { ctx: RenderContext; submitLabel: string }) {
  const f = ctx.content.form;
  if (!f.enabled) return null;
  const preview = ctx.formAction === null;
  const req = (mode: string) => mode === "required";
  return (
    <form method="post" action={ctx.formAction ?? "#"} className="space-y-4" aria-label="Enquiry form">
      <fieldset disabled={preview} className="m-0 min-w-0 space-y-4 border-0 p-0">
        <input type="hidden" name="p" value={ctx.page.slug} />
        <input type="hidden" name="t" value={ctx.formToken} />
        <div aria-hidden className="absolute -left-[9999px] h-px w-px overflow-hidden">
          <label>
            Leave this field empty
            <input type="text" name="company_website" tabIndex={-1} autoComplete="off" />
          </label>
        </div>
        <div className="grid gap-4 @2xl:grid-cols-2">
          <div>
            <label htmlFor="f-name" className={label}>Your name</label>
            <input id="f-name" name="name" required maxLength={120} autoComplete="name" className={field} />
          </div>
          <div>
            <label htmlFor="f-email" className={label}>Email</label>
            <input id="f-email" name="email" type="email" required maxLength={320} autoComplete="email" className={field} />
          </div>
        </div>
        {f.fields.phone !== "hidden" && (
          <div>
            <label htmlFor="f-phone" className={label}>Phone{!req(f.fields.phone) && <span className="font-normal text-[color:var(--s-muted)]"> (optional)</span>}</label>
            <input id="f-phone" name="phone" type="tel" inputMode="tel" required={req(f.fields.phone)} maxLength={30} autoComplete="tel" className={field} />
          </div>
        )}
        {f.fields.service !== "hidden" && f.services.length > 0 && (
          <div>
            <label htmlFor="f-service" className={label}>What do you need?{!req(f.fields.service) && <span className="font-normal text-[color:var(--s-muted)]"> (optional)</span>}</label>
            <select id="f-service" name="service" required={req(f.fields.service)} className={field} defaultValue="">
              <option value="">Choose one</option>
              {f.services.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
        )}
        {f.fields.message !== "hidden" && (
          <div>
            <label htmlFor="f-message" className={label}>How can we help?{!req(f.fields.message) && <span className="font-normal text-[color:var(--s-muted)]"> (optional)</span>}</label>
            <textarea id="f-message" name="message" rows={4} required={req(f.fields.message)} maxLength={2000} className={`${field} resize-y`} />
          </div>
        )}
        <label className="flex items-start gap-3 text-sm text-[color:var(--s-ink)]">
          <input type="checkbox" name="consent" value="yes" required className="mt-1 size-4 shrink-0 accent-[var(--s-primary)]" />
          <span>{f.consentText}</span>
        </label>
        {f.marketingOptIn && (
          <label className="flex items-start gap-3 text-sm text-[color:var(--s-muted)]">
            <input type="checkbox" name="marketing" value="yes" className="mt-1 size-4 shrink-0 accent-[var(--s-primary)]" />
            <span>{f.marketingText}</span>
          </label>
        )}
        <button type="submit" className={`inline-flex min-h-12 w-full items-center justify-center bg-[var(--s-primary)] px-6 py-3 text-base font-semibold text-[color:var(--s-on-primary)] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--s-primary-text)] @2xl:w-auto ${BTN_RADIUS}`}>
          {submitLabel || "Send message"}
        </button>
      </fieldset>
      {preview && <p className="text-sm text-[color:var(--s-muted)]">Preview only: the form is switched off here and works on your live site.</p>}
    </form>
  );
}

export function Contact({ ctx, section, band }: Props) {
  const d = section.data as unknown as ContactData;
  const { contact, surface } = ctx.spec;
  const hasDetails = d.showDetails && Boolean(ctx.content.business.phone || ctx.content.business.email || ctx.content.business.address || ctx.content.business.hours);
  const hasForm = d.showForm && ctx.content.form.enabled;
  const formBlock = hasForm ? <EnquiryForm ctx={ctx} submitLabel={d.submitLabel} /> : null;
  const details = hasDetails ? <Details ctx={ctx} /> : null;

  if (contact === "card") {
    return (
      <SectionShell ctx={ctx} id={section.id} band={band}>
        <Wrap narrow={!details}>
          <div className={`${CARD[surface]} ${RADIUS_LG} p-6 shadow-[var(--s-shadow)] @3xl:p-10`}>
            <SectionHead ctx={ctx} id={section.id} heading={d.heading} intro={d.intro} />
            <div className={`grid gap-8 ${details && formBlock ? "@3xl:grid-cols-[1fr_1.3fr] @3xl:gap-12" : ""}`}>
              {details}
              {formBlock}
            </div>
          </div>
        </Wrap>
      </SectionShell>
    );
  }
  if (contact === "stacked") {
    return (
      <SectionShell ctx={ctx} id={section.id} band={band}>
        <Wrap narrow>
          <SectionHead ctx={ctx} id={section.id} heading={d.heading} intro={d.intro} align="center" />
          {details && <div className={`mb-8 grid gap-6 border-y border-[color:var(--s-line)] py-6 @2xl:grid-cols-2`}>{details}</div>}
          {formBlock}
        </Wrap>
      </SectionShell>
    );
  }
  return (
    <SectionShell ctx={ctx} id={section.id} band={band}>
      <Wrap className={`grid gap-10 ${details && formBlock ? "@3xl:grid-cols-[1fr_1.2fr] @3xl:gap-14" : ""}`}>
        <div>
          <SectionHead ctx={ctx} id={section.id} heading={d.heading} intro={d.intro} />
          {details}
        </div>
        {formBlock && <div className={`${CARD[surface]} ${RADIUS_LG} self-start p-6 @3xl:p-8`}>{formBlock}</div>}
      </Wrap>
    </SectionShell>
  );
}
