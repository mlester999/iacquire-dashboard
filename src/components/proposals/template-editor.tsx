"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { ConfirmDialog, useCrmAction } from "@/components/crm/ui";
import { approveTemplateAction, archiveTemplateAction, saveTemplateAction } from "@/app/actions/proposals";
import { formatMinor, formatQuantity, isCurrency } from "@/lib/money";
import { DOC_LIMITS } from "@/lib/proposals/doc";
import { editorIssues, issueFor, newKey, parseQty, type EditorSection, type FieldIssue } from "@/lib/proposals/editor";
import { shortHash, whenIn } from "@/lib/proposals/format";
import { syncVersions } from "@/lib/social/edit-sync";
import type { CatalogItemView } from "@/server/proposals/catalog";
import type { TemplateDetail } from "@/server/proposals/templates";
import { SectionsEditor } from "@/components/proposals/sections-editor";

// Writing a template. Its lines name price book items, never prices: the price is read from the price book when a proposal is made from the template. Saving a changed template
// makes a new frozen version; people keep using the approved version until the owner approves the new one.

interface TplLine { key: string; id: string | undefined; catalogItemId: string; quantity: string; note: string }
interface TplState { name: string; sections: EditorSection[]; lines: TplLine[]; terms: string }

const fromDetail = (t: TemplateDetail): TplState => ({
  name: t.name,
  sections: t.doc.sections.map((s) => ({ key: s.id, id: s.id, heading: s.heading, body: s.body })),
  lines: t.doc.lines.map((l) => ({ key: l.id, id: l.id, catalogItemId: l.catalogItemId, quantity: formatQuantity(l.quantityMilli), note: l.note })),
  terms: t.doc.terms,
});
const keyOf = (s: TplState) => JSON.stringify([s.name.replace(/\s+/g, " ").trim(), s.sections.map((x) => [x.id ?? null, x.heading.replace(/\s+/g, " ").trim(), x.body.replace(/\r\n?/g, "\n").trim()]), s.lines.map((l) => [l.id ?? null, l.catalogItemId, l.quantity.trim(), l.note.trim()]), s.terms.replace(/\r\n?/g, "\n").trim()]);
const same = (a: TplState, b: TplState) => keyOf(a) === keyOf(b);

export function TemplateEditor({ orgId, template, catalog, canEdit, canApprove, tz }: { orgId: string | null; template: TemplateDetail; catalog: CatalogItemView[]; canEdit: boolean; canApprove: boolean; tz: string }) {
  const router = useRouter();
  const { run, busy } = useCrmAction();
  const [loaded, setLoaded] = React.useState(template);
  const [s, setS] = React.useState<TplState>(() => fromDetail(template));
  const [touched, setTouched] = React.useState(false);
  const [archive, setArchive] = React.useState(false);
  const base = fromDetail(loaded);
  const dirty = !same(s, base);
  const archived = template.status === "archived";
  const readOnly = !canEdit || archived;
  const sync = syncVersions({ loadedVersion: loaded.currentVersion, currentVersion: template.currentVersion, loaded: base, current: fromDetail(template), mine: s, same });
  const adopt = (t: TemplateDetail) => {
    setS(fromDetail(t));
    setLoaded(t);
    setTouched(false);
  };
  if (sync === "mark_current") setLoaded(template);
  else if (sync === "adopt_current") adopt(template);

  const issues: FieldIssue[] = React.useMemo(() => {
    const out = editorIssues({
      title: "t", clientName: "", clientCompany: "", clientEmail: "", validUntil: "", requiresSignature: false, currency: "USD", sections: s.sections, lines: [], terms: s.terms, internalNotes: "",
    }).filter((i) => i.path !== "title");
    if (!s.name.trim()) out.push({ path: "name", message: "Give the template a name." });
    for (const l of s.lines) {
      if (!l.catalogItemId) out.push({ path: `tline:${l.key}:item`, message: "Choose a price book item." });
      const q = parseQty(l.quantity);
      if (!q.ok) out.push({ path: `tline:${l.key}:quantity`, message: q.message });
      if (l.note.length > DOC_LIMITS.lineNote) out.push({ path: `tline:${l.key}:note`, message: `A note can be at most ${DOC_LIMITS.lineNote} characters.` });
    }
    return out;
  }, [s]);
  const patch = (p: Partial<TplState>) => {
    setTouched(true);
    setS((x) => ({ ...x, ...p }));
  };
  const shown = (path: string) => (touched ? issueFor(issues, path) : null);
  const setLine = (key: string, p: Partial<TplLine>) => patch({ lines: s.lines.map((l) => (l.key === key ? { ...l, ...p } : l)) });
  const itemName = (id: string) => catalog.find((c) => c.id === id);

  async function save() {
    setTouched(true);
    if (issues.length) return;
    const doc = {
      sections: s.sections.map((x) => ({ ...(x.id ? { id: x.id } : {}), heading: x.heading.trim(), body: x.body })),
      lines: s.lines.map((l) => ({ ...(l.id ? { id: l.id } : {}), catalogItemId: l.catalogItemId, quantityMilli: (parseQty(l.quantity) as { ok: true; milli: number }).milli, note: l.note })),
      terms: s.terms,
    };
    const r = await run("save", () => saveTemplateAction(orgId, template.id, { name: s.name, doc }, loaded.currentVersion), "Saved.");
    if (r && typeof r === "object" && "doc" in r) adopt(r as TemplateDetail);
  }
  const approvedNow = template.approvedVersion === template.currentVersion;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      <form className="space-y-6" aria-label="Edit template" onSubmit={(e) => { e.preventDefault(); if (sync !== "conflict") void save(); }}>
        {archived && <p role="status" className="rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-[14px] text-ink-2">This template is archived. It can no longer be used or changed.</p>}
        {!canEdit && !archived && <p role="status" className="rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-[14px] text-ink-2">The owner or a manager changes templates.</p>}
        {sync === "conflict" && (
          <div role="alert" className="rounded-xl border border-warning-ink/30 bg-warning-soft px-3 py-2.5 text-[14px] text-warning-ink">
            <p className="font-medium">Someone changed this template while you were editing it.</p>
            <p className="mt-0.5">Your edits are kept below, but they cannot be saved over the newer version. Copy anything you want to keep, then load the latest version.</p>
            <Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => adopt(template)}>Load the latest version</Button>
          </div>
        )}
        <fieldset className="space-y-4 rounded-2xl border border-line bg-surface p-4" disabled={readOnly}>
          <legend className="px-1 text-[15px] font-semibold text-ink">Template</legend>
          <Field label="Name" htmlFor="te-name" error={shown("name")}><Input id="te-name" value={s.name} maxLength={100} onChange={(e) => patch({ name: e.target.value })} className="text-[16px] sm:text-[14px]" /></Field>
        </fieldset>
        <fieldset className="space-y-3" disabled={readOnly}>
          <legend className="mb-2 text-[15px] font-semibold text-ink">Wording</legend>
          <SectionsEditor sections={s.sections} onChange={(sections) => patch({ sections })} readOnly={readOnly} issues={touched ? issues : []} idPrefix="te-section" />
        </fieldset>
        <fieldset className="space-y-3" disabled={readOnly}>
          <legend className="mb-1 text-[15px] font-semibold text-ink">Starting items</legend>
          <p className="max-w-2xl text-[14px] text-muted">These price book items start every proposal made from this template, at the price book&apos;s price at the time.</p>
          {s.lines.length === 0 && <p className="rounded-xl border border-dashed border-line px-4 py-5 text-center text-[14px] text-muted">No starting items. Proposals made from this template start with just the wording.</p>}
          <ol className="space-y-3">
            {s.lines.map((l, i) => {
              const it = itemName(l.catalogItemId);
              return (
                <li key={l.key} className="space-y-3 rounded-2xl border border-line bg-surface p-4">
                  <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                    <Field label={`Item ${i + 1}`} htmlFor={`te-line-${l.key}-item`} error={shown(`tline:${l.key}:item`)} hint={it && isCurrency(it.currency) ? `${formatMinor(it.unitPriceMinor, it.currency)} per ${it.unitLabel}` : undefined}>
                      <Select id={`te-line-${l.key}-item`} value={l.catalogItemId} onChange={(e) => setLine(l.key, { catalogItemId: e.target.value })}>
                        <option value="">Choose an item…</option>
                        {catalog.filter((c) => !c.archived || c.id === l.catalogItemId).map((c) => <option key={c.id} value={c.id}>{c.name} ({c.currency}){c.archived ? " - archived" : ""}</option>)}
                      </Select>
                    </Field>
                    <Field label="Quantity" htmlFor={`te-line-${l.key}-qty`} error={shown(`tline:${l.key}:quantity`)}>
                      <Input id={`te-line-${l.key}-qty`} inputMode="decimal" value={l.quantity} onChange={(e) => setLine(l.key, { quantity: e.target.value })} className="text-[16px] sm:text-[14px]" />
                    </Field>
                  </div>
                  <Field label="Note" htmlFor={`te-line-${l.key}-note`} optional error={shown(`tline:${l.key}:note`)}>
                    <Input id={`te-line-${l.key}-note`} value={l.note} onChange={(e) => setLine(l.key, { note: e.target.value })} className="text-[16px] sm:text-[14px]" />
                  </Field>
                  {!readOnly && <div className="flex justify-end"><Button type="button" variant="ghost" size="sm" onClick={() => patch({ lines: s.lines.filter((x) => x.key !== l.key) })} aria-label={`Remove item ${i + 1}`}><Trash2 className="size-4" aria-hidden />Remove</Button></div>}
                </li>
              );
            })}
          </ol>
          {!readOnly && <Button type="button" variant="secondary" disabled={s.lines.length >= DOC_LIMITS.lines} onClick={() => patch({ lines: [...s.lines, { key: newKey(), id: undefined, catalogItemId: "", quantity: "1", note: "" }] })}><Plus className="size-4" aria-hidden />Add a starting item</Button>}
        </fieldset>
        <fieldset className="space-y-3 rounded-2xl border border-line bg-surface p-4" disabled={readOnly}>
          <legend className="px-1 text-[15px] font-semibold text-ink">Terms</legend>
          <Field label="Terms" htmlFor="te-terms" optional error={shown("terms")} hint="Payment terms, what is not included, anything the customer agrees to. Write what your business stands behind: iAcquire gives no legal wording.">
            <Textarea id="te-terms" rows={7} value={s.terms} onChange={(e) => patch({ terms: e.target.value })} className="text-[16px] sm:text-[14px]" />
          </Field>
        </fieldset>
        {!readOnly && (
          <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface/95 px-4 py-3 shadow-soft backdrop-blur">
            <Button type="submit" variant="brand" loading={busy("save")} disabled={!dirty || sync === "conflict"}>Save changes</Button>
            <span className="text-[13px] text-muted" role="status">{touched && issues.length > 0 && dirty ? `${issues.length === 1 ? "One thing needs" : `${issues.length} things need`} fixing before this can be saved.` : dirty ? "You have unsaved changes. A change makes a new version that the owner has to approve." : "All changes saved."}</span>
          </div>
        )}
      </form>

      <aside aria-label="Approval and versions" className="space-y-4 lg:sticky lg:top-4 lg:self-start">
        <section className="space-y-3 rounded-2xl border border-line bg-surface p-4">
          <h2 className="text-[15px] font-semibold text-ink">Approval</h2>
          <p className="text-[14px] text-ink-2">{template.approvedVersion === null ? "No version is approved yet, so nobody can start a proposal from this template." : approvedNow ? `Version ${template.approvedVersion} is approved and in use${template.approvedByName ? `, approved by ${template.approvedByName}` : ""}${template.approvedAt ? ` on ${whenIn(template.approvedAt, tz)}` : ""}.` : `Version ${template.approvedVersion} is in use. Version ${template.currentVersion} is waiting for the owner to approve it.`}</p>
          {canApprove && !archived ? (
            <>
              <Button variant="brand" loading={busy("approve")} disabled={dirty || approvedNow} onClick={() => run("approve", () => approveTemplateAction(template.id, template.currentVersion), "Approved.")}>{approvedNow ? "This version is approved" : `Approve version ${template.currentVersion}`}</Button>
              {dirty && <p className="text-[13px] text-warning-ink">Save your changes first, so you approve what you see.</p>}
            </>
          ) : <p className="text-[13px] text-muted">Only the business owner approves a template: the wording is theirs to stand behind.</p>}
          {canEdit && !archived && <Button variant="ghost" size="sm" onClick={() => setArchive(true)}>Archive this template</Button>}
        </section>
        <section className="space-y-2 rounded-2xl border border-line bg-surface p-4">
          <h2 className="text-[15px] font-semibold text-ink">Versions</h2>
          <ul className="space-y-1.5 text-[14px]">
            {template.versions.map((v) => (
              <li key={v.version} className="flex flex-wrap items-center gap-2"><span className="font-medium text-ink">Version {v.version}</span>{v.approved && <Badge tone="success">Approved</Badge>}<span className="font-mono text-[12px] text-muted">{shortHash(v.contentHash)}</span></li>
            ))}
          </ul>
        </section>
      </aside>
      <ConfirmDialog
        open={archive} onOpenChange={setArchive} title="Archive this template?" confirmLabel="Archive" danger loading={busy("archive")}
        description="Nobody can start a proposal from it any more. Proposals already made from it are not changed."
        onConfirm={async () => { const ok = await run("archive", () => archiveTemplateAction(orgId, template.id), "Archived."); setArchive(false); if (ok) router.push("/proposals/templates"); }}
      />
    </div>
  );
}
