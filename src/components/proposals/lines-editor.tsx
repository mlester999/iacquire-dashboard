"use client";

import * as React from "react";
import { AlertTriangle, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { formatMinor, isCurrency, type LineAmounts } from "@/lib/money";
import { BILLING_LABELS, BILLINGS, DOC_LIMITS } from "@/lib/proposals/doc";
import { blankLine, issueFor, lineField, lineFromCatalog, parsePrice, type CatalogChoice, type EditorLine, type FieldIssue } from "@/lib/proposals/editor";
import { bpsLabel } from "@/lib/proposals/money";

// The priced lines of a proposal. A line comes from the price book (its price is the price book's, and changing it is a discount-permission act) or is typed by hand. The
// amounts shown are worked out by the same code the server uses, so what is added up on the screen is what is saved.

export interface TaxOption {
  id: string;
  name: string;
  rateBps: number;
  archived: boolean;
}

export function LinesEditor({ lines, onChange, currency, catalog, taxRates, canDiscount, readOnly, issues, amounts, idPrefix }: {
  lines: EditorLine[];
  onChange: (next: EditorLine[]) => void;
  currency: string;
  catalog: CatalogChoice[];
  taxRates: TaxOption[];
  canDiscount: boolean;
  readOnly: boolean;
  issues: readonly FieldIssue[];
  amounts: ReadonlyArray<LineAmounts | null>;
  idPrefix: string;
}) {
  const money = (minor: number) => (isCurrency(currency) ? formatMinor(minor, currency) : String(minor));
  const set = (key: string, patch: Partial<EditorLine>) => onChange(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  // Focus follows what the person just did: a new line takes them to its name, and removing a line leaves them at the list rather than nowhere.
  const region = React.useRef<HTMLElement | null>(null);
  const pending = React.useRef<{ kind: "name"; key: string } | { kind: "list" } | null>(null);
  React.useEffect(() => {
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    if (p.kind === "name") document.getElementById(`${idPrefix}-${p.key}-name`)?.focus();
    else region.current?.focus();
  });
  const add = (line: EditorLine) => {
    pending.current = { kind: "name", key: line.key };
    onChange([...lines, line]);
  };
  const offered = catalog.filter((c) => c.currency === currency);
  const rateById = new Map(taxRates.map((t) => [t.id, t]));
  return (
    <section ref={region} tabIndex={-1} aria-label="Priced lines" className="space-y-3 outline-none">
      {lines.length === 0 && <p className="rounded-xl border border-dashed border-line px-4 py-5 text-center text-[13.5px] text-muted">No priced lines yet. Add an item from your price book, or type one in.</p>}
      <ol className="space-y-3">
        {lines.map((l, i) => {
          const id = (f: string) => `${idPrefix}-${l.key}-${f}`;
          const err = (f: string) => issueFor(issues, lineField(l.key, f));
          const fromBook = l.catalogItemId !== null;
          const typed = parsePrice(l.price, currency);
          const overridden = fromBook && l.catalogPriceMinor !== null && typed.ok && typed.minor !== l.catalogPriceMinor;
          const a = amounts[i] ?? null;
          const showDiscount = canDiscount || l.discount !== "none";
          const name = l.name.trim() || `line ${i + 1}`;
          const archivedRate = l.taxRateId ? rateById.get(l.taxRateId)?.archived : false;
          return (
            <li key={l.key} className="space-y-3 rounded-2xl border border-line bg-surface p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={fromBook ? "primary" : "outline"}>{fromBook ? "From the price book" : "Typed by hand"}</Badge>
                {overridden && <Badge tone="warning">Price differs from the price book</Badge>}
                {l.discount !== "none" && <Badge tone="warning">Discounted</Badge>}
                <span className="ml-auto text-[13px] font-medium tabular-nums text-ink">{a ? <><span className="sr-only">Amount before tax: </span>{money(a.net)}</> : <span className="font-normal text-muted">Amount not worked out yet</span>}</span>
              </div>
              <Field label={`Line ${i + 1} name`} htmlFor={id("name")} error={err("name")}>
                <Input id={id("name")} value={l.name} maxLength={DOC_LIMITS.lineName + 20} disabled={readOnly} onChange={(e) => set(l.key, { name: e.target.value })} className="text-[16px] sm:text-[14px]" />
              </Field>
              <div className="grid gap-3 sm:grid-cols-4">
                <Field label="Quantity" htmlFor={id("quantity")} error={err("quantity")}>
                  <Input id={id("quantity")} inputMode="decimal" value={l.quantity} disabled={readOnly} onChange={(e) => set(l.key, { quantity: e.target.value })} className="text-[16px] sm:text-[14px]" />
                </Field>
                <Field label="Unit" htmlFor={id("unitLabel")} error={err("unitLabel")}>
                  <Input id={id("unitLabel")} value={l.unitLabel} maxLength={DOC_LIMITS.unitLabel + 10} disabled={readOnly} onChange={(e) => set(l.key, { unitLabel: e.target.value })} className="text-[16px] sm:text-[14px]" />
                </Field>
                <Field
                  label={`Price per unit (${currency})`} htmlFor={id("price")} error={err("price")}
                  hint={fromBook && !canDiscount ? "Set by the price book. The owner or a manager can change it." : overridden && l.catalogPriceMinor !== null ? `Price book: ${money(l.catalogPriceMinor)}` : undefined}
                >
                  <Input id={id("price")} inputMode="decimal" value={l.price} disabled={readOnly} readOnly={fromBook && !canDiscount} onChange={(e) => set(l.key, { price: e.target.value })} className="text-[16px] sm:text-[14px]" />
                </Field>
                <Field label="Billed" htmlFor={id("billing")}>
                  <Select id={id("billing")} value={l.billing} disabled={readOnly || fromBook} onChange={(e) => set(l.key, { billing: e.target.value as EditorLine["billing"] })}>
                    {BILLINGS.map((b) => <option key={b} value={b}>{BILLING_LABELS[b]}</option>)}
                  </Select>
                </Field>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Tax" htmlFor={id("tax")} hint={archivedRate ? "This rate is archived. It still applies to this line." : l.taxBps > 0 ? `Added on top of the price: ${bpsLabel(l.taxBps)}.` : "No tax is added."}>
                  <Select
                    id={id("tax")} value={l.taxRateId ?? ""} disabled={readOnly}
                    onChange={(e) => {
                      const r = rateById.get(e.target.value);
                      set(l.key, { taxRateId: r ? r.id : null, taxName: r ? r.name : null, taxBps: r ? r.rateBps : 0 });
                    }}
                  >
                    <option value="">No tax</option>
                    {taxRates.filter((t) => !t.archived || t.id === l.taxRateId).map((t) => <option key={t.id} value={t.id}>{t.name} ({bpsLabel(t.rateBps)}){t.archived ? " - archived" : ""}</option>)}
                  </Select>
                </Field>
                {showDiscount && (
                  <>
                    <Field label="Discount" htmlFor={id("discount")} hint={canDiscount ? undefined : "Only the owner or a manager can change a discount."}>
                      <Select id={id("discount")} value={l.discount} disabled={readOnly || !canDiscount} onChange={(e) => set(l.key, { discount: e.target.value as EditorLine["discount"], discountValue: e.target.value === "none" ? "" : l.discountValue })}>
                        <option value="none">No discount</option>
                        <option value="percent">Percent off</option>
                        <option value="fixed">Amount off</option>
                      </Select>
                    </Field>
                    {l.discount !== "none" && (
                      <Field label={l.discount === "percent" ? "Percent off" : `Amount off (${currency})`} htmlFor={id("discountValue")} error={err("discountValue")}>
                        <Input id={id("discountValue")} inputMode="decimal" value={l.discountValue} disabled={readOnly || !canDiscount} onChange={(e) => set(l.key, { discountValue: e.target.value })} className="text-[16px] sm:text-[14px]" />
                      </Field>
                    )}
                  </>
                )}
              </div>
              <details className="rounded-xl border border-line px-3 py-2" open={Boolean(l.description || l.note)}>
                <summary className="min-h-11 cursor-pointer text-[13px] font-medium text-ink-2 sm:min-h-8">Description and note</summary>
                <div className="mt-2 space-y-3">
                  <Field label="Description" htmlFor={id("description")} optional error={err("description")} hint="What the customer gets. The customer sees this.">
                    <Textarea id={id("description")} rows={3} value={l.description} disabled={readOnly} onChange={(e) => set(l.key, { description: e.target.value })} className="text-[16px] sm:text-[14px]" />
                  </Field>
                  <Field label="Note" htmlFor={id("note")} optional error={err("note")} hint="A short remark under the line. The customer sees this too.">
                    <Input id={id("note")} value={l.note} disabled={readOnly} onChange={(e) => set(l.key, { note: e.target.value })} className="text-[16px] sm:text-[14px]" />
                  </Field>
                </div>
              </details>
              {!readOnly && (
                <div className="flex justify-end">
                  <Button type="button" variant="ghost" size="sm" onClick={() => { pending.current = { kind: "list" }; onChange(lines.filter((x) => x.key !== l.key)); }} aria-label={`Remove ${name}`}><Trash2 className="size-4" aria-hidden />Remove</Button>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {!readOnly && (
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-0 flex-1 text-[12.5px] text-muted sm:max-w-sm">
            <span className="mb-1 block">Add from your price book</span>
            <Select
              value="" disabled={lines.length >= DOC_LIMITS.lines || offered.length === 0} aria-label="Add an item from your price book"
              onChange={(e) => {
                const item = offered.find((c) => c.id === e.target.value);
                if (item) add(lineFromCatalog(item));
              }}
            >
              <option value="">{offered.length ? "Choose an item…" : `No items priced in ${currency}`}</option>
              {offered.map((c) => <option key={c.id} value={c.id}>{c.name} - {isCurrency(c.currency) ? formatMinor(c.unitPriceMinor, c.currency) : c.unitPriceMinor}</option>)}
            </Select>
          </label>
          <Button type="button" variant="secondary" disabled={lines.length >= DOC_LIMITS.lines} onClick={() => add(blankLine())}><Plus className="size-4" aria-hidden />Add a line by hand</Button>
        </div>
      )}
      {issueFor(issues, "lines") && <p role="alert" className="flex items-center gap-1.5 text-[12.5px] text-danger-ink"><AlertTriangle className="size-4" aria-hidden />{issueFor(issues, "lines")}</p>}
    </section>
  );
}
