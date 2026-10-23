"use client";

import * as React from "react";
import { AlertTriangle, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { useCrmAction } from "@/components/crm/ui";
import { updateProposalAction } from "@/app/actions/proposals";
import { formatMinor, isCurrency } from "@/lib/money";
import { BILLINGS, BILLING_LABELS, DOC_LIMITS, SUPPORTED_CURRENCIES } from "@/lib/proposals/doc";
import { editorIssues, issueFor, liveTotals, patchFromState, sameState, stateFromSaved, type CatalogChoice, type EditorState, type SavedProposal } from "@/lib/proposals/editor";
import { groupTotalsText } from "@/lib/proposals/list";
import type { Problem } from "@/lib/proposals/problems";
import { syncVersions } from "@/lib/social/edit-sync";
import type { ProposalDetail } from "@/server/proposals/view";
import { LinesEditor, type TaxOption } from "@/components/proposals/lines-editor";
import { SectionsEditor } from "@/components/proposals/sections-editor";

// The proposal editor. What is typed here is checked by the same rules the server uses (src/lib/proposals/editor.ts) and the totals are worked out by the same code, so a
// problem is shown beside the field before anything is sent. The server still decides: prices come from the price book, and a discount needs its own permission.

export interface EditorProps {
  detail: ProposalDetail;
  catalog: CatalogChoice[];
  taxRates: TaxOption[];
  canDiscount: boolean;
  /** The proposal can be edited in its status and by this person. */
  editable: boolean;
  /** Why it cannot be edited, in words, when it cannot. */
  lockedReason: string | null;
  onDirtyChange?: (dirty: boolean) => void;
}

const saved = (d: ProposalDetail): SavedProposal => d;

export function ProposalEditor({ detail, catalog, taxRates, canDiscount, editable, lockedReason, onDirtyChange }: EditorProps) {
  const { run, busy } = useCrmAction();
  // The saved version these fields started from. A save is checked against it, so edits made on top of an old version can never overwrite a newer one.
  const [loaded, setLoaded] = React.useState(detail);
  const [s, setS] = React.useState<EditorState>(() => stateFromSaved(saved(detail)));
  const [touched, setTouched] = React.useState(false);
  const base = stateFromSaved(saved(loaded));
  const dirty = !sameState(s, base);
  // When the page brings a newer version (a teammate saved, or an action moved the proposal on), the fields follow it if they have not been touched. With unsaved edits they are
  // kept, but cannot be saved over the newer text.
  const sync = syncVersions({ loadedVersion: loaded.version, currentVersion: detail.version, loaded: base, current: stateFromSaved(saved(detail)), mine: s, same: sameState });
  const adopt = (d: ProposalDetail) => {
    setS(stateFromSaved(saved(d)));
    setLoaded(d);
    setTouched(false);
  };
  // Adjusting state while rendering is the pattern React documents for state that follows a prop: it re-renders at once, before anything is shown or painted.
  if (sync === "mark_current") setLoaded(detail);
  else if (sync === "adopt_current") adopt(detail);

  React.useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const issues = React.useMemo(() => editorIssues(s), [s]);
  const totals = React.useMemo(() => liveTotals(s), [s]);
  const patch = (p: Partial<EditorState>) => {
    setTouched(true);
    setS((x) => ({ ...x, ...p }));
  };
  const currencyLocked = s.lines.length > 0;
  const voids = dirty && (detail.status === "pending_approval" || detail.status === "approved");
  const shown = (path: string) => (touched ? issueFor(issues, path) : null);
  const fieldIssues = touched ? issues : [];

  async function save() {
    setTouched(true);
    const built = patchFromState(s);
    if (!built.ok) return;
    const { doc, ...rest } = built.patch;
    const result = await run("save", () => updateProposalAction(detail.id, { ...rest, doc }, loaded.version), "Saved.");
    // What the server stored is the new base, and the fields show it (the server tidies spacing and fills in what it decides).
    if (result && typeof result === "object" && "doc" in result) adopt(result as ProposalDetail);
  }

  const blocking = detail.problems.filter((p: Problem) => p.level === "blocking");
  const warnings = detail.problems.filter((p: Problem) => p.level === "warning");

  return (
    <form className="space-y-6" aria-label="Edit proposal" onSubmit={(e) => { e.preventDefault(); if (sync !== "conflict") void save(); }}>
      {lockedReason && <p role="status" className="flex items-start gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-[13px] text-ink-2"><Info className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />{lockedReason}</p>}
      {sync === "conflict" && (
        <div role="alert" className="rounded-xl border border-warning-ink/30 bg-warning-soft px-3 py-2.5 text-[13px] text-warning-ink">
          <p className="font-medium">Someone changed this proposal while you were editing it.</p>
          <p className="mt-0.5">Your edits are kept below, but they cannot be saved over the newer version. Copy anything you want to keep, then load the latest version.</p>
          <Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => adopt(detail)}>Load the latest version</Button>
        </div>
      )}

      {(blocking.length > 0 || warnings.length > 0) && (
        <section aria-label="Checks for this proposal" className="space-y-1.5">
          <ul className="space-y-1.5">
            {[...blocking, ...warnings].map((p) => (
              <li key={p.code + p.message} className={`flex items-start gap-2 rounded-xl px-3 py-2 text-[13px] ${p.level === "blocking" ? "bg-danger-soft text-danger-ink" : "bg-warning-soft text-warning-ink"}`}>
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span><span className="font-semibold">{p.level === "blocking" ? (p.stopsAt === "send" ? "Fix before sending: " : "Fix before approval: ") : "Note: "}</span>{p.message}</span>
              </li>
            ))}
          </ul>
          {dirty && <p className="text-[12.5px] text-muted">These checks are for the last saved version. Save to check your changes.</p>}
        </section>
      )}

      <fieldset className="space-y-4 rounded-2xl border border-line bg-surface p-4" disabled={!editable}>
        <legend className="px-1 text-[15px] font-semibold text-ink">About this proposal</legend>
        <Field label="Title" htmlFor="pe-title" error={shown("title")}>
          <Input id="pe-title" value={s.title} maxLength={200} onChange={(e) => patch({ title: e.target.value })} className="text-[16px] sm:text-[14px]" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Customer's name" htmlFor="pe-client" error={shown("clientName")}>
            <Input id="pe-client" value={s.clientName} autoComplete="off" maxLength={200} onChange={(e) => patch({ clientName: e.target.value })} className="text-[16px] sm:text-[14px]" />
          </Field>
          <Field label="Company" htmlFor="pe-company" optional error={shown("clientCompany")}>
            <Input id="pe-company" value={s.clientCompany} autoComplete="off" maxLength={200} onChange={(e) => patch({ clientCompany: e.target.value })} className="text-[16px] sm:text-[14px]" />
          </Field>
          <Field label="Customer's email" htmlFor="pe-email" optional error={shown("clientEmail")} hint="The code to accept online is emailed here, and only here. Without it the customer can open the proposal but you record their answer yourself.">
            <Input id="pe-email" type="email" inputMode="email" autoComplete="off" value={s.clientEmail} onChange={(e) => patch({ clientEmail: e.target.value })} className="text-[16px] sm:text-[14px]" />
          </Field>
          <Field label="Valid until" htmlFor="pe-valid" optional error={shown("validUntil")} hint="The whole of this day, in your workspace's time zone. After it the customer can no longer accept.">
            <Input id="pe-valid" type="date" value={s.validUntil} onChange={(e) => patch({ validUntil: e.target.value })} className="text-[16px] sm:text-[14px]" />
          </Field>
          <Field label="Currency" htmlFor="pe-currency" error={shown("currency")} hint={currencyLocked ? "Remove the lines before changing the currency." : undefined}>
            <Select id="pe-currency" value={s.currency} disabled={currencyLocked} onChange={(e) => patch({ currency: e.target.value })}>
              {!isCurrency(s.currency) && <option value={s.currency}>{s.currency}</option>}
              {SUPPORTED_CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </Field>
        </div>
        <div className="relative flex items-start gap-3 py-1">
          <input id="pe-sign" type="checkbox" checked={s.requiresSignature} onChange={(e) => patch({ requiresSignature: e.target.checked })} className="mt-0.5 size-5 shrink-0 rounded border-line-strong accent-[var(--color-primary,#2563eb)]" />
          <div className="min-w-0">
            <label htmlFor="pe-sign" className="text-[14px] font-medium text-ink after:absolute after:inset-0 after:content-['']">This proposal needs a signature</label>
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted">The customer then cannot accept it with an emailed code. It needs a connected signing service, or you record the signing as done offline. Nothing is described as signed unless a signing service says so or a person records it.</p>
          </div>
        </div>
      </fieldset>

      <fieldset className="space-y-3" disabled={!editable}>
        <legend className="mb-2 text-[15px] font-semibold text-ink">Wording</legend>
        <SectionsEditor sections={s.sections} onChange={(sections) => patch({ sections })} readOnly={!editable} issues={fieldIssues} idPrefix="pe-section" />
      </fieldset>

      <fieldset className="space-y-3" disabled={!editable}>
        <legend className="mb-2 text-[15px] font-semibold text-ink">Prices</legend>
        <LinesEditor
          lines={s.lines} onChange={(lines) => patch({ lines })} currency={s.currency} catalog={catalog} taxRates={taxRates} canDiscount={canDiscount} readOnly={!editable} issues={fieldIssues}
          amounts={totals.lines} idPrefix="pe-line"
        />
        <TotalsSummary totals={totals} currency={s.currency} />
      </fieldset>

      <fieldset className="space-y-3 rounded-2xl border border-line bg-surface p-4" disabled={!editable}>
        <legend className="px-1 text-[15px] font-semibold text-ink">Terms</legend>
        <Field
          label="Terms" htmlFor="pe-terms" optional error={shown("terms")}
          hint={`${s.terms.length.toLocaleString("en-US")} of ${DOC_LIMITS.terms.toLocaleString("en-US")} characters. Payment terms, what is not included, anything the customer agrees to. iAcquire gives no legal wording: write what your business stands behind.`}
        >
          <Textarea id="pe-terms" rows={7} value={s.terms} onChange={(e) => patch({ terms: e.target.value })} className="text-[16px] sm:text-[14px]" />
        </Field>
      </fieldset>

      <fieldset className="space-y-3 rounded-2xl border border-line bg-surface p-4" disabled={!editable}>
        <legend className="px-1 text-[15px] font-semibold text-ink">Notes for your team</legend>
        <Field label="Internal notes" htmlFor="pe-notes" optional error={shown("internalNotes")} hint="Only your team sees this. It is never in the proposal, the PDF, the customer's page or anything the AI reads.">
          <Textarea id="pe-notes" rows={3} value={s.internalNotes} onChange={(e) => patch({ internalNotes: e.target.value })} className="text-[16px] sm:text-[14px]" />
        </Field>
      </fieldset>

      {editable && (
        <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface/95 px-4 py-3 shadow-soft backdrop-blur">
          <Button type="submit" variant="brand" loading={busy("save")} disabled={!dirty || sync === "conflict"}>Save changes</Button>
          <div className="min-w-0 flex-1 text-[12.5px]" role="status">
            {touched && issues.length > 0 && dirty && <span className="text-danger-ink">{issues.length === 1 ? "One thing needs fixing" : `${issues.length} things need fixing`} before this can be saved.</span>}
            {!(touched && issues.length > 0 && dirty) && dirty && <span className="text-muted">You have unsaved changes.{voids ? " Saving sends this back to a draft, because the approval was of the earlier text." : ""}</span>}
            {!dirty && <span className="text-muted">All changes saved.</span>}
          </div>
        </div>
      )}
    </form>
  );
}

function TotalsSummary({ totals, currency }: { totals: ReturnType<typeof liveTotals>; currency: string }) {
  if (!isCurrency(currency)) return null;
  const used = BILLINGS.filter((b) => totals.groups[b].total > 0 || totals.groups[b].subtotal > 0);
  const grand = { one_time: totals.groups.one_time.total, monthly: totals.groups.monthly.total, yearly: totals.groups.yearly.total };
  return (
    <div className="rounded-2xl border border-line bg-surface-2 p-4" aria-live="polite">
      <h3 className="text-[14px] font-semibold text-ink">Totals</h3>
      {used.length === 0 ? <p className="mt-1 text-[13px] text-muted">Nothing to add up yet.</p> : (
        <dl className="mt-2 space-y-3 text-[13.5px]">
          {used.map((b) => {
            const g = totals.groups[b];
            return (
              <div key={b}>
                <dt className="text-[12px] font-semibold uppercase tracking-wide text-muted">{BILLING_LABELS[b]}</dt>
                <dd className="mt-1 space-y-0.5">
                  {g.discount > 0 && <p className="flex justify-between gap-4 text-muted"><span>Discounts</span><span className="tabular-nums">{formatMinor(-g.discount, currency)}</span></p>}
                  <p className="flex justify-between gap-4 text-muted"><span>Subtotal</span><span className="tabular-nums">{formatMinor(g.subtotal, currency)}</span></p>
                  {g.tax > 0 && <p className="flex justify-between gap-4 text-muted"><span>Tax</span><span className="tabular-nums">{formatMinor(g.tax, currency)}</span></p>}
                  <p className="flex justify-between gap-4 font-semibold text-ink"><span>Total</span><span className="tabular-nums">{formatMinor(g.total, currency)}</span></p>
                </dd>
              </div>
            );
          })}
        </dl>
      )}
      {used.length > 1 && <p className="mt-3 text-[12.5px] text-muted">{groupTotalsText(grand, currency)}. One-time, monthly and yearly amounts are never added together.</p>}
      {totals.incomplete && <p className="mt-2 text-[12.5px] text-warning-ink">A line is not complete yet, so it is left out of these totals.</p>}
    </div>
  );
}
