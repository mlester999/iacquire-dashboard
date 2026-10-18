import * as React from "react";
import type { ElementNode } from "@/lib/website/doc";
import { describeVisibility } from "@/lib/crm/forms/visibility";
import { NATIVE_FORM_MARKER } from "@/lib/crm/forms/website";
import type { PublicFormDef, PublicQuestion } from "@/lib/crm/forms/spec";
import type { RenderCtx } from "@/components/website/render/ctx";
import { rootProps } from "@/components/website/render/parts";
import { SiteFormLogic } from "./site-form-logic";

// A native CRM form drawn inside a website: the published version's questions with the site's own form styles. It posts to the site's
// /__iaq/form like the built-in enquiry form (no script needed); the page's element id tells the server which element, and so which form,
// it was. Hidden attribution fields are not drawn: the server reads them from the visit.

const s = (v: unknown) => (typeof v === "string" ? v : "");

export function SiteNativeForm({ el, ctx, p, index, def }: { el: ElementNode; ctx: RenderCtx; p: Record<string, unknown>; index?: number; def: PublicFormDef }) {
  const preview = ctx.formAction === null;
  const fid = (k: string) => `f-${el.id}-${k}`;
  const layout = s(p.layout) || "card";
  const byKey = new Map<string, { label: string; options?: PublicQuestion["options"] }>([...(def.hidden ?? []), ...def.questions].map((q) => [q.key, q]));
  const live = ctx.mode === "published";
  // The email and phone saved to the contact: at least one must be given (the server checks it). With both, neither is marked optional
  // and one note, tied to both, says either will do; with only one, it is required like any required question.
  const oneOf = def.requireOneOf ?? [];
  const pair = oneOf.length > 1 ? new Set(oneOf) : null;
  const firstOfPair = pair ? def.questions.find((q) => pair.has(q.key))?.key : undefined;
  const oneOfId = fid("one-of");
  return (
    <form {...rootProps(el, ctx, "iq-form", index)} data-layout={layout} method="post" action={ctx.formAction ?? "#"} aria-label={def.title}>
      <fieldset disabled={preview}>
        <input type="hidden" name="p" value={ctx.page.slug} />
        <input type="hidden" name="t" value={ctx.formToken} />
        <input type="hidden" name="e" value={el.id} />
        <input type="hidden" name={NATIVE_FORM_MARKER} value={def.key} />
        <input type="hidden" name="_l" value="" />
        <input type="hidden" name="_r" value="" />
        <div aria-hidden className="iq-trap"><label>Leave this field empty<input type="text" name="company_website" tabIndex={-1} autoComplete="off" /></label></div>
        <div className="iq-fields">
          {def.questions.map((raw) => {
            const q = oneOf.length === 1 && oneOf[0] === raw.key && !raw.required ? { ...raw, required: true } : raw;
            const when = q.visibleWhen?.conditions.length ? describeVisibility(q.visibleWhen, (k) => byKey.get(k)) : null;
            const inPair = Boolean(pair?.has(q.key));
            return (
              <React.Fragment key={q.key}>
                {q.key === firstOfPair && <p className="iq-help iq-fld-wide" id={oneOfId}>Give an email address or a phone number, or both, so we can reply.</p>}
                <SiteQuestion q={q} id={fid(q.key)} when={when} optionalMark={!inPair} noteId={inPair ? oneOfId : null} />
              </React.Fragment>
            );
          })}
        </div>
        {def.consent.text && <label className="iq-check"><input type="checkbox" name="consent" value="yes" required /><span>{def.consent.text}</span></label>}
        {def.consent.marketing && <label className="iq-check iq-check-soft"><input type="checkbox" name="marketing" value="yes" /><span>{def.consent.marketing}</span></label>}
        <button type="submit" className="iq-btn" data-v="primary" data-s="l" data-full=""><span className="iq-btn-l">{def.submitLabel}</span></button>
        {s(p.helper) && <p className="iq-note">{s(p.helper)}</p>}
      </fieldset>
      {preview && <p className="iq-note">Preview only: the form is switched off here and works on your live site.</p>}
      {live && <SiteFormLogic questions={def.questions.map((q) => ({ key: q.key, type: q.type, visibleWhen: q.visibleWhen }))} hidden={def.hidden} />}
    </form>
  );
}

function SiteQuestion({ q, id, when, optionalMark = true, noteId = null }: { q: PublicQuestion; id: string; when: string | null; optionalMark?: boolean; noteId?: string | null }) {
  const name = `q.${q.key}`;
  const conditional = when !== null;
  // A conditional question is required only once it is shown (the browser code switches that on); the server always decides.
  const req = q.required && !conditional ? true : undefined;
  const dataReq = q.required && conditional ? "1" : undefined;
  const v = q.validation ?? {};
  const wide = q.width !== "half" || q.type === "long_text" || q.type === "multiple_choice" || (q.type === "single_choice" && q.display === "radio");
  const opt = !q.required && optionalMark ? <span className="iq-opt"> (optional)</span> : null;
  const help = q.help ? <p className="iq-help" id={`${id}-help`}>{q.help}</p> : null;
  const hint = when ? <p className="iq-help" data-q-when="">Answer this if {when}.</p> : null;
  const describedBy = [noteId, q.help ? `${id}-help` : null].filter(Boolean).join(" ") || undefined;
  const cls = `iq-fld${wide ? " iq-fld-wide" : ""}`;

  if (q.type === "checkbox") {
    return (
      <div className={cls} data-q={q.key}>
        <label className="iq-check"><input type="checkbox" name={name} value="yes" required={req} data-req={dataReq} aria-describedby={describedBy} /><span>{q.label}{opt}</span></label>
        {help}{hint}
      </div>
    );
  }
  if ((q.type === "single_choice" && q.display === "radio") || q.type === "multiple_choice") {
    const multi = q.type === "multiple_choice";
    return (
      <fieldset className={`iq-qset ${cls}`} data-q={q.key} aria-describedby={describedBy}>
        <legend>{q.label}{opt}</legend>
        <div className="iq-choices" data-n={q.options.length > 4 ? "many" : undefined}>
          {q.options.map((o, i) => (
            <label key={o.value} className="iq-choice">
              <input type={multi ? "checkbox" : "radio"} name={name} value={o.value} required={!multi && i === 0 ? req : undefined} data-req={!multi && i === 0 ? dataReq : undefined} />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
        {help}{hint}
      </fieldset>
    );
  }
  const common = { id, name, required: req, "data-req": dataReq, "aria-describedby": describedBy, autoComplete: q.autocomplete ?? undefined, placeholder: q.placeholder ?? undefined };
  let control: React.ReactNode;
  switch (q.type) {
    case "long_text": control = <textarea {...common} rows={4} maxLength={v.maxLength ?? 2000} minLength={v.minLength} />; break;
    case "single_choice":
      control = <select id={id} name={name} required={req} data-req={dataReq} aria-describedby={describedBy} defaultValue=""><option value="">Choose one</option>{q.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>;
      break;
    case "number": control = <input {...common} type="number" inputMode={v.integer ? "numeric" : "decimal"} step={v.integer ? 1 : "any"} min={v.min} max={v.max} />; break;
    case "date": control = <input {...common} placeholder={undefined} type="date" min={v.minDate} max={v.maxDate} />; break;
    case "email": control = <input {...common} type="email" inputMode="email" maxLength={320} />; break;
    case "phone": control = <input {...common} type="tel" inputMode="tel" maxLength={30} />; break;
    default: control = <input {...common} type="text" maxLength={v.maxLength ?? 300} minLength={v.minLength} />;
  }
  return (
    <div className={cls} data-q={q.key}>
      <label htmlFor={id}>{q.label}{opt}</label>
      {control}
      {help}{hint}
    </div>
  );
}
