// Building assets the same way everywhere: placeholders for things only known by name (a GoHighLevel form, workflow or template whose
// contents the API does not expose), and small starting points. Every builder returns an asset that passes validateContent on its own, and
// every placeholder is marked as one, so the compatibility report shows it as "Manual review", never as converted. Pure.
import { emptyDraft, type FormKind, type FormPurpose } from "@/lib/crm/forms/spec";
import type { FormAsset, MessageChannel, MessageTemplateAsset, SlotAsset, SlotKind, WorkflowAsset } from "@/lib/crm/blueprints/types";

/** A form known only by name: no questions, the default consent and thank-you wording, nothing it does yet. */
export function placeholderForm(id: string, key: string, name: string, opts: { kind?: FormKind; purpose?: FormPurpose; folder?: string | null } = {}): FormAsset {
  const kind = opts.kind ?? "form";
  const draft = emptyDraft(kind);
  return {
    id, key, name: name.trim().slice(0, 80) || key, kind, purpose: opts.purpose ?? (kind === "survey" ? "survey" : "contact"), folder: opts.folder ?? null,
    draft: { ...draft, questions: [] }, placeholder: true,
  };
}

/** A workflow known only by name: started by hand, no steps. It can never run until it is rebuilt and approved. */
export function placeholderWorkflow(id: string, key: string, name: string, opts: { description?: string | null; folder?: string | null } = {}): WorkflowAsset {
  return {
    id, key, name: name.trim().slice(0, 80) || key, description: opts.description ?? null, folder: opts.folder ?? null, hourlyRunLimit: 500,
    definition: { trigger: { type: "manual" }, steps: [] }, placeholder: true,
  };
}

/** A message template known only by name: no wording yet. */
export function placeholderTemplate(id: string, key: string, name: string, channel: MessageChannel, opts: { purpose?: "service" | "marketing"; folder?: string | null } = {}): MessageTemplateAsset {
  return {
    id, kind: "template", key, name: name.trim().slice(0, 80) || key, channel, purpose: opts.purpose ?? "service", category: null, folder: opts.folder ?? null,
    subject: null, body: "", whatsapp: null, placeholder: true,
  };
}

/** A mapping slot ("member.closer" labelled "Closer"). */
export function slot(kind: SlotKind, segment: string, label: string, description: string | null = null): SlotAsset {
  return { id: `${kind}.${segment}`, label: label.trim().slice(0, 80) || segment, description };
}
