// Native forms inside Website Studio: which forms a site's content uses, and what the editor's form picker is given. The form element
// names a form by its key (not an id), so a template stays portable between workspaces: a key the workspace doesn't have simply falls
// back to the built-in enquiry form.
import { eachElement, type SiteContent } from "@/lib/website/doc";
import { FORM_KEY_RE, type FormStatus, type PublicFormDef } from "@/lib/crm/forms/spec";

/** The form keys a site's form elements name (live pages, shared sections, header and footer), in the order they appear. */
export function formKeysIn(content: SiteContent): string[] {
  const keys: string[] = [];
  eachElement(content, (e) => {
    if (e.type !== "form") return;
    const k = typeof e.props.formKey === "string" ? e.props.formKey.trim() : "";
    if (k && FORM_KEY_RE.test(k) && !keys.includes(k)) keys.push(k);
  });
  return keys;
}

/** Whether a site has any form element at all (the editor loads the workspace's forms only then). */
export function contentHasFormElement(content: SiteContent): boolean {
  let found = false;
  eachElement(content, (e) => {
    if (e.type === "form") found = true;
  });
  return found;
}

export interface SiteFormChoice {
  key: string;
  name: string;
  status: FormStatus;
  /** What visitors see, for a form that is live. Null for drafts. */
  def: PublicFormDef | null;
}

/** The editor's form picker: the workspace's forms that aren't archived, or why native forms can't be used here. */
export interface SiteFormOptions {
  available: boolean;
  reason?: string;
  forms: SiteFormChoice[];
  /** Where this person builds and publishes the workspace's forms. */
  manageHref: string;
}

/** The live definitions by key, as the renderer takes them. */
export function liveFormDefs(options: SiteFormOptions | undefined | null): Record<string, PublicFormDef> | undefined {
  if (!options?.available) return undefined;
  const out: Record<string, PublicFormDef> = {};
  for (const f of options.forms) if (f.def) out[f.key] = f.def;
  return out;
}

/** The hidden field that says a native form was drawn (the key itself is always read from the published page, never from the post). */
export const NATIVE_FORM_MARKER = "fk";
