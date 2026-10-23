"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { RecordPicker, useCrmAction } from "@/components/crm/ui";
import { searchContactsAction } from "@/app/actions/crm";
import { createInvoiceDraftAction, searchInvoiceDealsAction, updateInvoiceDraftAction } from "@/app/actions/invoices";
import { CURRENCIES, CURRENCY_CODES, type CurrencyCode } from "@/lib/money";
import type { LineFormInput } from "@/lib/invoices/lines";
import type { InvoiceFormState } from "@/lib/invoices/form-state";
import { blankLine, filledLines, previewLines } from "@/lib/invoices/screens";
import { money } from "@/lib/invoices/labels";

// Writing an invoice. Everything a person types stays text until the server reads it with the same money rules this screen previews with: the totals shown here are a
// preview, and the server works the real ones out again. Saving makes (or updates) a draft; nothing is sent to anyone, and nothing can be paid until it is issued.

export type InvoiceFormMode = { kind: "new" } | { kind: "edit"; id: string; version: number };

interface ContactChoice { id: string; name: string; email: string | null; phone: string | null }
interface DealPick { id: string; name: string; contactId: string | null; contactName: string | null; currency: string | null }

const input16 = "text-[16px] sm:text-[14px]";

/** The request body for the server, from the form. Empty optional fields are sent as empty so a cleared field is cleared. */
export function formPayload(s: InvoiceFormState) {
  const address = s.billTo.address.split("\n").map((l) => l.trim()).filter(Boolean);
  return {
    contactId: s.contact?.id ?? null, opportunityId: s.deal?.id ?? null, currency: s.currency, taxInclusive: s.taxInclusive,
    lines: filledLines(s.lines).map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, discountPercent: l.discountPercent || null, discountAmount: l.discountAmount || null, taxPercent: l.taxPercent || null })),
    dueOn: s.dueOn || null,
    billTo: { name: s.billTo.name, company: s.billTo.company, email: s.billTo.email, phone: s.billTo.phone, addressLines: address, taxId: s.billTo.taxId },
    paymentInstructions: s.paymentInstructions || null, notes: s.notes || null, terms: s.terms || null, closesDeal: s.deal ? s.closesDeal : false,
  };
}

export function InvoiceForm({ mode, initial, termsDays }: { mode: InvoiceFormMode; initial: InvoiceFormState; termsDays: number }) {
  const router = useRouter();
  const { run, busy } = useCrmAction();
  const [s, setS] = React.useState<InvoiceFormState>(initial);
  const set = <K extends keyof InvoiceFormState>(k: K, v: InvoiceFormState[K]) => setS((p) => ({ ...p, [k]: v }));
  const setLine = (i: number, patch: Partial<LineFormInput>) => setS((p) => ({ ...p, lines: p.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
  const preview = React.useMemo(() => previewLines(s.lines, s.currency, s.taxInclusive), [s.lines, s.currency, s.taxInclusive]);
  const filled = filledLines(s.lines);
  // A draft can be saved without a customer (it cannot be sent for approval without one); it cannot be saved with a line that cannot be read.
  const canSave = filled.length > 0 && preview.ok && !preview.problem;

  const findContacts = React.useCallback(async (q: string) => {
    const r = await searchContactsAction(null, q);
    return r.ok ? (r.data as ContactChoice[]) : [];
  }, []);
  const findDeals = React.useCallback(async (q: string) => {
    const r = await searchInvoiceDealsAction(q);
    return r.ok ? (r.data as DealPick[]) : [];
  }, []);

  async function save() {
    const body = formPayload(s);
    if (mode.kind === "new") {
      const r = await run("save", () => createInvoiceDraftAction(body), "Draft saved.");
      if (r) router.push(`/invoices/${(r as { id: string }).id}`);
    } else {
      const r = await run("save", () => updateInvoiceDraftAction(mode.id, body, mode.version), "Draft saved.");
      if (r) router.push(`/invoices/${mode.id}`);
    }
  }

  return (
    <form className="space-y-6" onSubmit={(e) => { e.preventDefault(); if (canSave) void save(); }} aria-label={mode.kind === "new" ? "New invoice" : "Edit invoice"}>
      <section aria-labelledby="inv-customer" className="space-y-4 rounded-2xl border border-line bg-surface p-4 sm:p-5">
        <h2 id="inv-customer" className="text-[15px] font-semibold text-ink">Customer</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <RecordPicker<ContactChoice>
            id="inv-contact" label="Who is this invoice for?" placeholder="Search customers by name, email or phone" search={findContacts}
            render={(c) => <span><span className="font-medium">{c.name}</span>{c.email ? <span className="text-muted"> · {c.email}</span> : null}</span>}
            onPick={(c) => setS((p) => ({ ...p, contact: { id: c.id, name: c.name } }))} value={s.contact ? s.contact.name : undefined} onClear={() => set("contact", null)}
          />
          <RecordPicker<DealPick>
            id="inv-deal" label="Deal (optional)" placeholder="Search open deals" search={findDeals}
            render={(d) => <span><span className="font-medium">{d.name}</span>{d.contactName ? <span className="text-muted"> · {d.contactName}</span> : null}</span>}
            onPick={(d) => setS((p) => ({ ...p, deal: { id: d.id, name: d.name }, contact: p.contact ?? (d.contactId ? { id: d.contactId, name: d.contactName ?? "Customer" } : null) }))} value={s.deal ? s.deal.name : undefined} onClear={() => setS((p) => ({ ...p, deal: null, closesDeal: false }))}
          />
        </div>
        {!s.contact && <p className="text-[12.5px] text-muted">An invoice needs a customer before it can be sent for approval. Choose one, or choose a deal and its customer comes with it.</p>}
        <details className="rounded-xl border border-line bg-surface-2/50 px-3 py-2">
          <summary className="min-h-11 cursor-pointer text-[13.5px] font-medium text-ink-2 sm:min-h-8">Customer details printed on the invoice (optional)</summary>
          <p className="mt-2 text-[12.5px] text-muted">Left empty, the invoice uses what is on the customer&apos;s record when it is issued. Whatever is printed is frozen when the invoice is issued.</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label="Name" htmlFor="bt-name" optional><Input id="bt-name" className={input16} value={s.billTo.name} maxLength={160} onChange={(e) => set("billTo", { ...s.billTo, name: e.target.value })} /></Field>
            <Field label="Company" htmlFor="bt-company" optional><Input id="bt-company" className={input16} value={s.billTo.company} maxLength={160} onChange={(e) => set("billTo", { ...s.billTo, company: e.target.value })} /></Field>
            <Field label="Email" htmlFor="bt-email" optional><Input id="bt-email" type="email" className={input16} value={s.billTo.email} maxLength={200} onChange={(e) => set("billTo", { ...s.billTo, email: e.target.value })} /></Field>
            <Field label="Phone" htmlFor="bt-phone" optional><Input id="bt-phone" type="tel" className={input16} value={s.billTo.phone} maxLength={40} onChange={(e) => set("billTo", { ...s.billTo, phone: e.target.value })} /></Field>
            <Field label="Address" htmlFor="bt-address" optional hint="One line per row, up to six."><Textarea id="bt-address" rows={3} className={input16} value={s.billTo.address} onChange={(e) => set("billTo", { ...s.billTo, address: e.target.value })} /></Field>
            <Field label="Tax number" htmlFor="bt-tax" optional><Input id="bt-tax" className={input16} value={s.billTo.taxId} maxLength={60} onChange={(e) => set("billTo", { ...s.billTo, taxId: e.target.value })} /></Field>
          </div>
        </details>
      </section>

      <section aria-labelledby="inv-lines" className="space-y-4 rounded-2xl border border-line bg-surface p-4 sm:p-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="inv-lines" className="text-[15px] font-semibold text-ink">What is being billed</h2>
          <div className="flex flex-wrap gap-3">
            <Field label="Currency" htmlFor="inv-currency">
              <Select id="inv-currency" value={s.currency} onChange={(e) => set("currency", e.target.value as CurrencyCode)} className={input16}>
                {CURRENCY_CODES.map((c) => <option key={c} value={c}>{c} · {CURRENCIES[c].name}</option>)}
              </Select>
            </Field>
            <Field label="Prices" htmlFor="inv-taxmode">
              <Select id="inv-taxmode" value={s.taxInclusive ? "inclusive" : "exclusive"} onChange={(e) => set("taxInclusive", e.target.value === "inclusive")} className={input16}>
                <option value="exclusive">Tax is added on top</option>
                <option value="inclusive">Tax is included in the price</option>
              </Select>
            </Field>
          </div>
        </div>
        <ol className="space-y-3">
          {s.lines.map((l, i) => (
            <li key={i} className="rounded-xl border border-line bg-surface-2/40 p-3">
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_90px_130px]">
                <Field label={`Line ${i + 1} description`} htmlFor={`ln-desc-${i}`}><Input id={`ln-desc-${i}`} className={input16} value={l.description} maxLength={300} onChange={(e) => setLine(i, { description: e.target.value })} /></Field>
                <Field label="Quantity" htmlFor={`ln-qty-${i}`}><Input id={`ln-qty-${i}`} inputMode="decimal" className={input16} value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} /></Field>
                <Field label={`Unit price (${s.currency})`} htmlFor={`ln-price-${i}`}><Input id={`ln-price-${i}`} inputMode="decimal" className={input16} value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: e.target.value })} /></Field>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-[110px_130px_110px_auto] sm:items-end">
                <Field label="Discount %" htmlFor={`ln-dp-${i}`} optional><Input id={`ln-dp-${i}`} inputMode="decimal" className={input16} value={l.discountPercent ?? ""} onChange={(e) => setLine(i, { discountPercent: e.target.value, discountAmount: e.target.value ? "" : l.discountAmount })} /></Field>
                <Field label={`Or discount (${s.currency})`} htmlFor={`ln-da-${i}`} optional><Input id={`ln-da-${i}`} inputMode="decimal" className={input16} value={l.discountAmount ?? ""} onChange={(e) => setLine(i, { discountAmount: e.target.value, discountPercent: e.target.value ? "" : l.discountPercent })} /></Field>
                <Field label="Tax %" htmlFor={`ln-tax-${i}`} optional><Input id={`ln-tax-${i}`} inputMode="decimal" className={input16} value={l.taxPercent ?? ""} onChange={(e) => setLine(i, { taxPercent: e.target.value })} /></Field>
                <div className="col-span-2 flex justify-end sm:col-span-1">
                  <Button type="button" variant="ghost" size="sm" disabled={s.lines.length === 1} aria-label={`Remove line ${i + 1}`} onClick={() => set("lines", s.lines.filter((_, j) => j !== i))}><Trash2 className="size-4" aria-hidden />Remove</Button>
                </div>
              </div>
              {preview.errors[i] && <p role="alert" className="mt-2 text-[12.5px] text-danger-ink">{preview.errors[i]}</p>}
            </li>
          ))}
        </ol>
        <Button type="button" variant="secondary" disabled={s.lines.length >= 100} onClick={() => set("lines", [...s.lines, blankLine()])}><Plus className="size-4" aria-hidden />Add a line</Button>
        <p className="text-[12.5px] text-muted">Tax is only what you enter on a line: nothing is worked out for you, and this is not tax advice.</p>

        <dl aria-label="Preview of the totals" className="ml-auto grid max-w-xs grid-cols-[1fr_auto] gap-x-6 gap-y-1.5 text-[13.5px]">
          <dt className="text-muted">Subtotal{s.taxInclusive ? " (before tax)" : ""}</dt><dd className="text-right tabular-nums text-ink">{money(preview.subtotalMinor, s.currency)}</dd>
          <dt className="text-muted">Tax{s.taxInclusive ? " (included)" : ""}</dt><dd className="text-right tabular-nums text-ink">{money(preview.taxMinor, s.currency)}</dd>
          <dt className="border-t border-line-strong pt-1.5 font-semibold text-ink">Total</dt><dd className="border-t border-line-strong pt-1.5 text-right text-[15px] font-semibold tabular-nums text-ink">{money(preview.totalMinor, s.currency)}</dd>
        </dl>
        <p className="text-right text-[12px] text-muted">A preview. The server works out the real totals when you save.</p>
        {preview.problem && filled.length > 0 && <p role="alert" className="text-[12.5px] text-danger-ink">{preview.problem}</p>}
      </section>

      <section aria-labelledby="inv-details" className="space-y-4 rounded-2xl border border-line bg-surface p-4 sm:p-5">
        <h2 id="inv-details" className="text-[15px] font-semibold text-ink">Dates and wording</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Due on" htmlFor="inv-due" optional hint={`Left empty, it is due ${termsDays} ${termsDays === 1 ? "day" : "days"} after the day you issue it (your payment terms).`}>
            <Input id="inv-due" type="date" className={input16} value={s.dueOn} onChange={(e) => set("dueOn", e.target.value)} />
          </Field>
        </div>
        <Field label="How to pay" htmlFor="inv-pay" optional hint="Shown on the invoice: bank details, a mobile wallet number, anything the customer needs. Never type a card number."><Textarea id="inv-pay" rows={3} className={input16} maxLength={1000} value={s.paymentInstructions} onChange={(e) => set("paymentInstructions", e.target.value)} /></Field>
        <Field label="Notes" htmlFor="inv-notes" optional><Textarea id="inv-notes" rows={2} className={input16} maxLength={2000} value={s.notes} onChange={(e) => set("notes", e.target.value)} /></Field>
        <Field label="Terms" htmlFor="inv-terms" optional><Textarea id="inv-terms" rows={2} className={input16} maxLength={2000} value={s.terms} onChange={(e) => set("terms", e.target.value)} /></Field>
        {s.deal && (
          <label className="flex min-h-11 items-start gap-3 text-[13.5px] text-ink-2">
            <input type="checkbox" className="mt-0.5 size-5" checked={s.closesDeal} onChange={(e) => set("closesDeal", e.target.checked)} />
            <span>Paying this invoice in full may mark the deal &ldquo;{s.deal.name}&rdquo; as won. <span className="text-muted">It only happens if the owner has turned that rule on in the invoice settings, and only for a payment the payment provider confirmed.</span></span>
          </label>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="brand" loading={busy("save")} disabled={!canSave}>{mode.kind === "new" ? "Save draft" : "Save changes"}</Button>
        <Button type="button" variant="ghost" onClick={() => router.push(mode.kind === "edit" ? `/invoices/${mode.id}` : "/invoices")}>Cancel</Button>
        {!canSave && <p className="text-[12.5px] text-muted">{filled.length === 0 ? "Add at least one line to save." : "Fix the lines marked above to save."}</p>}
      </div>
    </form>
  );
}
