"use client";

import * as React from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { Badge, EmptyState, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { useCrmAction } from "@/components/crm/ui";
import { createCatalogItemAction, createTaxRateAction, updateCatalogItemAction, updateTaxRateAction } from "@/app/actions/proposals";
import { formatMinor, isCurrency, toDecimalString } from "@/lib/money";
import { BILLING_LABELS, BILLINGS, SUPPORTED_CURRENCIES, type Billing } from "@/lib/proposals/doc";
import { bpsToPercent, parsePrice, percentToBps } from "@/lib/proposals/editor";
import { bpsLabel } from "@/lib/proposals/money";
import type { CatalogItemView, TaxRateView } from "@/server/proposals/catalog";

// The workspace's own tax rates and price book. Nothing is pre-filled: a price exists because a person typed it, and a tax rate is whatever the business's accountant says. A
// proposal copies the price when a line is added, so changing the price book never changes a proposal that was already written, and a sent version never changes.

export interface CatalogPanelProps {
  /** null for the client's own team; the client's id for an agency person inside an audited support session. */
  orgId: string | null;
  items: CatalogItemView[];
  taxRates: TaxRateView[];
  canEdit: boolean;
  defaultCurrency: string;
}

export function CatalogPanel({ orgId, items, taxRates, canEdit, defaultCurrency }: CatalogPanelProps) {
  const [tax, setTax] = React.useState<TaxRateView | "new" | null>(null);
  const [item, setItem] = React.useState<CatalogItemView | "new" | null>(null);
  return (
    <div className="space-y-8">
      <section aria-label="Tax rates" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-[16px] font-semibold text-ink">Tax rates</h2>
            <p className="max-w-2xl text-[13px] text-muted">A rate is added on top of the price, line by line. iAcquire does not know your local tax rules and gives no tax advice: use the rates your accountant gives you.</p>
          </div>
          {canEdit && <Button variant="secondary" onClick={() => setTax("new")}><Plus className="size-4" aria-hidden />Add a tax rate</Button>}
        </div>
        {taxRates.length === 0 ? <p className="rounded-xl border border-dashed border-line px-4 py-5 text-center text-[13.5px] text-muted">No tax rates yet. Without one, no tax is added to any line.</p> : (
          <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
            {taxRates.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
                <span className="min-w-0 flex-1 text-[13.5px]"><span className="font-medium text-ink">{t.name}</span> <span className="text-muted">· {bpsLabel(t.rateBps)}</span></span>
                {t.archived && <Badge tone="outline">Archived</Badge>}
                {canEdit && <Button size="sm" variant="ghost" onClick={() => setTax(t)} aria-label={`Edit ${t.name}`}>Edit</Button>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Price book" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-[16px] font-semibold text-ink">Price book</h2>
            <p className="max-w-2xl text-[13px] text-muted">The items you sell, with their prices. A proposal line copies its item&apos;s price when it is added, so changing a price here never changes a proposal already written. The AI can only choose items from here.</p>
          </div>
          {canEdit && <Button variant="secondary" onClick={() => setItem("new")}><Plus className="size-4" aria-hidden />Add an item</Button>}
        </div>
        {items.length === 0 ? (
          <EmptyState compact title="Your price book is empty" description="Nothing is pre-filled. Add the services and products you sell, with the prices you charge, and proposals can use them." action={canEdit ? <Button variant="secondary" onClick={() => setItem("new")}><Plus className="size-4" aria-hidden />Add an item</Button> : undefined} />
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
            {items.map((i) => (
              <li key={i.id} className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-medium text-ink">{i.name} {i.archived && <Badge tone="outline" className="ml-1 align-middle">Archived</Badge>}</p>
                  {i.description && <p className="mt-0.5 line-clamp-2 break-words text-[12.5px] text-muted">{i.description}</p>}
                  <p className="mt-1 text-[12.5px] text-ink-2">{i.billing === "one_time" ? "Billed once" : BILLING_LABELS[i.billing]} · per {i.unitLabel}{i.taxRateName ? ` · ${i.taxRateName} ${i.taxBps !== null ? bpsLabel(i.taxBps) : ""}` : " · no tax"}</p>
                </div>
                <span className="text-[14px] font-semibold tabular-nums text-ink">{isCurrency(i.currency) ? formatMinor(i.unitPriceMinor, i.currency) : `${i.currency} ${i.unitPriceMinor}`}</span>
                {canEdit && <Button size="sm" variant="ghost" onClick={() => setItem(i)} aria-label={`Edit ${i.name}`}>Edit</Button>}
              </li>
            ))}
          </ul>
        )}
      </section>
      {!canEdit && <p className="text-[12.5px] text-muted">The owner or a manager changes the price book and tax rates.</p>}

      {tax && <TaxDialog key={tax === "new" ? "new" : tax.id} orgId={orgId} tax={tax === "new" ? null : tax} onClose={() => setTax(null)} />}
      {item && <ItemDialog key={item === "new" ? "new" : item.id} orgId={orgId} item={item === "new" ? null : item} taxRates={taxRates} defaultCurrency={defaultCurrency} onClose={() => setItem(null)} />}
    </div>
  );
}

function TaxDialog({ orgId, tax, onClose }: { orgId: string | null; tax: TaxRateView | null; onClose: () => void }) {
  const { run, busy } = useCrmAction();
  const [name, setName] = React.useState(tax?.name ?? "");
  const [rate, setRate] = React.useState(tax ? bpsToPercent(tax.rateBps) : "");
  const bps = percentToBps(rate);
  const rateOk = rate.trim() === "0" || rate.trim() === "0.00" || bps !== null;
  const rateBps = bps ?? 0;
  const save = async () => {
    const ok = await run("save", () => (tax ? updateTaxRateAction(orgId, tax.id, { name, rateBps }) : createTaxRateAction(orgId, { name, rateBps })), "Saved.");
    if (ok) onClose();
  };
  return (
    <Dialog
      open onOpenChange={(o) => !o && onClose()} title={tax ? "Edit tax rate" : "Add a tax rate"} size="sm"
      description={tax ? "Lines already on proposals keep the rate they were added with. Only lines added from now on use the new one." : undefined}
      footer={
        <>
          {tax && <Button variant="ghost" loading={busy("archive")} onClick={async () => { if (await run("archive", () => updateTaxRateAction(orgId, tax.id, { archived: !tax.archived }), tax.archived ? "Restored." : "Archived.")) onClose(); }}>{tax.archived ? "Restore" : "Archive"}</Button>}
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy("save")} disabled={!name.trim() || !rateOk || !rate.trim()} onClick={save}>Save</Button>
        </>
      }
    >
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (name.trim() && rateOk && rate.trim()) void save(); }}>
        <Field label="Name" htmlFor="tx-name"><Input id="tx-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} className="text-[16px] sm:text-[14px]" /></Field>
        <Field label="Rate (percent)" htmlFor="tx-rate" error={rate.trim() && !rateOk ? "Enter a percentage from 0 to 100 with at most two decimals, such as 12 or 12.5." : null} hint="Added on top of the price.">
          <Input id="tx-rate" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} className="text-[16px] sm:text-[14px]" />
        </Field>
      </form>
    </Dialog>
  );
}

function ItemDialog({ orgId, item, taxRates, defaultCurrency, onClose }: { orgId: string | null; item: CatalogItemView | null; taxRates: TaxRateView[]; defaultCurrency: string; onClose: () => void }) {
  const { run, busy } = useCrmAction();
  const [name, setName] = React.useState(item?.name ?? "");
  const [description, setDescription] = React.useState(item?.description ?? "");
  const [unit, setUnit] = React.useState(item?.unitLabel ?? "each");
  const [currency, setCurrency] = React.useState(item?.currency ?? defaultCurrency);
  const [price, setPrice] = React.useState(item && isCurrency(item.currency) ? toDecimalString(item.unitPriceMinor, item.currency) : "");
  const [billing, setBilling] = React.useState<Billing>(item?.billing ?? "one_time");
  const [taxRateId, setTaxRateId] = React.useState(item?.taxRateId ?? "");
  const parsed = parsePrice(price, currency);
  const ready = name.trim() && unit.trim() && parsed.ok;
  const body = () => ({ name, description, unitLabel: unit, unitPriceMinor: parsed.ok ? parsed.minor : 0, currency, billing, taxRateId: taxRateId || null });
  const save = async () => {
    if (!ready) return;
    const ok = await run("save", () => (item ? updateCatalogItemAction(orgId, item.id, body(), item.version) : createCatalogItemAction(orgId, body())), "Saved.");
    if (ok) onClose();
  };
  return (
    <Dialog
      open onOpenChange={(o) => !o && onClose()} title={item ? "Edit item" : "Add an item"} size="md"
      description={item ? "Proposals that already hold this item keep the price they were given. A new price applies to lines added from now on." : undefined}
      footer={
        <>
          {item && <Button variant="ghost" loading={busy("archive")} onClick={async () => { if (await run("archive", () => updateCatalogItemAction(orgId, item.id, { archived: !item.archived }, item.version), item.archived ? "Restored." : "Archived.")) onClose(); }}>{item.archived ? "Restore" : "Archive"}</Button>}
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy("save")} disabled={!ready} onClick={save}>Save</Button>
        </>
      }
    >
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <Field label="Name" htmlFor="ci-name"><Input id="ci-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} className="text-[16px] sm:text-[14px]" /></Field>
        <Field label="Description" htmlFor="ci-desc" optional hint="What the customer gets. It appears on proposals."><Textarea id="ci-desc" rows={3} value={description} maxLength={1000} onChange={(e) => setDescription(e.target.value)} className="text-[16px] sm:text-[14px]" /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Currency" htmlFor="ci-currency">
            <Select id="ci-currency" value={currency} onChange={(e) => setCurrency(e.target.value)}>{SUPPORTED_CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}</Select>
          </Field>
          <Field label="Price per unit" htmlFor="ci-price" error={price.trim() && !parsed.ok ? parsed.message : null}>
            <Input id="ci-price" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} className="text-[16px] sm:text-[14px]" />
          </Field>
          <Field label="One unit is" htmlFor="ci-unit" hint="For example: project, hour, month.">
            <Input id="ci-unit" value={unit} maxLength={30} onChange={(e) => setUnit(e.target.value)} className="text-[16px] sm:text-[14px]" />
          </Field>
          <Field label="Billed" htmlFor="ci-billing">
            <Select id="ci-billing" value={billing} onChange={(e) => setBilling(e.target.value as Billing)}>{BILLINGS.map((b) => <option key={b} value={b}>{BILLING_LABELS[b]}</option>)}</Select>
          </Field>
        </div>
        <Field label="Tax" htmlFor="ci-tax" optional>
          <Select id="ci-tax" value={taxRateId} onChange={(e) => setTaxRateId(e.target.value)}>
            <option value="">No tax</option>
            {taxRates.filter((t) => !t.archived || t.id === taxRateId).map((t) => <option key={t.id} value={t.id}>{t.name} ({bpsLabel(t.rateBps)}){t.archived ? " - archived" : ""}</option>)}
          </Select>
        </Field>
      </form>
    </Dialog>
  );
}
