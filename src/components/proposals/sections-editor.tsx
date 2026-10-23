"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { DOC_LIMITS } from "@/lib/proposals/doc";
import { blankSection, issueFor, sectionField, type EditorSection, type FieldIssue } from "@/lib/proposals/editor";
import { PROPOSAL_TOKENS } from "@/lib/proposals/tokens";

// The sections of wording in a proposal or a template: a heading and a few paragraphs each. The same rules the server enforces are checked as you type. Placeholders are
// picked from the list iAcquire knows, so a typo can never reach a customer.

export function SectionsEditor({ sections, onChange, readOnly, issues, idPrefix }: {
  sections: EditorSection[];
  onChange: (next: EditorSection[]) => void;
  readOnly: boolean;
  issues: readonly FieldIssue[];
  idPrefix: string;
}) {
  const set = (key: string, patch: Partial<EditorSection>) => onChange(sections.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  // Focus follows what the person just did: a new section takes them to its heading, and removing one leaves them at the list rather than nowhere.
  const region = React.useRef<HTMLElement | null>(null);
  const pending = React.useRef<{ kind: "heading"; key: string } | { kind: "list" } | null>(null);
  React.useEffect(() => {
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    if (p.kind === "heading") document.getElementById(`${idPrefix}-${p.key}-heading`)?.focus();
    else region.current?.focus();
  });
  const move = (index: number, by: -1 | 1) => {
    const next = [...sections];
    const to = index + by;
    if (to < 0 || to >= next.length) return;
    [next[index], next[to]] = [next[to], next[index]];
    onChange(next);
  };
  return (
    <section ref={region} tabIndex={-1} aria-label="Sections" className="space-y-3 outline-none">
      {sections.length === 0 && <p className="rounded-xl border border-dashed border-line px-4 py-5 text-center text-[13.5px] text-muted">No wording yet. Add a section for the introduction, the scope of work, or anything the customer should read.</p>}
      <ol className="space-y-3">
        {sections.map((s, i) => {
          const headingId = `${idPrefix}-${s.key}-heading`;
          const bodyId = `${idPrefix}-${s.key}-body`;
          const name = s.heading.trim() || `section ${i + 1}`;
          return (
            <li key={s.key} className="space-y-3 rounded-2xl border border-line bg-surface p-4">
              <Field label={`Section ${i + 1} heading`} htmlFor={headingId} error={issueFor(issues, sectionField(s.key, "heading"))}>
                <Input id={headingId} value={s.heading} maxLength={DOC_LIMITS.heading + 20} disabled={readOnly} onChange={(e) => set(s.key, { heading: e.target.value })} className="text-[16px] sm:text-[14px]" />
              </Field>
              <Field
                label="Wording" htmlFor={bodyId} error={issueFor(issues, sectionField(s.key, "body"))}
                hint={`${s.body.length.toLocaleString("en-US")} of ${DOC_LIMITS.body.toLocaleString("en-US")} characters. Use **bold**, *italic*, and lines starting with "- " or "1. " for lists. No HTML, links or images.`}
              >
                <Textarea id={bodyId} rows={6} value={s.body} disabled={readOnly} onChange={(e) => set(s.key, { body: e.target.value })} className="text-[16px] sm:text-[14px]" />
              </Field>
              {!readOnly && (
                <div className="flex flex-wrap items-end gap-2">
                  <label className="min-w-0 flex-1 text-[12.5px] text-muted sm:max-w-xs">
                    <span className="mb-1 block">Insert a placeholder</span>
                    <Select
                      aria-label={`Insert a placeholder into ${name}`} value=""
                      onChange={(e) => {
                        if (e.target.value) set(s.key, { body: `${s.body}${s.body && !/\s$/.test(s.body) ? " " : ""}{{${e.target.value}}}` });
                      }}
                    >
                      <option value="">Choose…</option>
                      {PROPOSAL_TOKENS.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                    </Select>
                  </label>
                  <Button type="button" variant="ghost" size="icon-sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${name} up`}><ArrowUp className="size-4" aria-hidden /></Button>
                  <Button type="button" variant="ghost" size="icon-sm" disabled={i === sections.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${name} down`}><ArrowDown className="size-4" aria-hidden /></Button>
                  <Button type="button" variant="ghost" size="icon-sm" onClick={() => { pending.current = { kind: "list" }; onChange(sections.filter((x) => x.key !== s.key)); }} aria-label={`Remove ${name}`}><Trash2 className="size-4" aria-hidden /></Button>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {!readOnly && (
        <Button type="button" variant="secondary" disabled={sections.length >= DOC_LIMITS.sections} onClick={() => { const added = blankSection(); pending.current = { kind: "heading", key: added.key }; onChange([...sections, added]); }}><Plus className="size-4" aria-hidden />Add a section</Button>
      )}
      {issueFor(issues, "sections") && <p role="alert" className="text-[12.5px] text-danger-ink">{issueFor(issues, "sections")}</p>}
    </section>
  );
}
