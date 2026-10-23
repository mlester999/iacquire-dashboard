"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { RecordPicker, useCrmAction } from "@/components/crm/ui";
import { searchContactsAction } from "@/app/actions/crm";
import { createProposalAction, draftWithAiAction, searchDealsAction } from "@/app/actions/proposals";
import { isCurrency } from "@/lib/money";
import { SUPPORTED_CURRENCIES } from "@/lib/proposals/doc";
import { AI_LIMITS } from "@/lib/proposals/ai";

// Starting a proposal: by hand, or with a first draft from the AI. Either way the result is a draft that a person edits and, where needed, sends for approval. The AI never
// sends anything and never sets a price: it picks items from the price book.

export interface NewProposalProps {
  templates: Array<{ id: string; name: string }>;
  defaultCurrency: string;
  contact: { id: string; name: string } | null;
  deal: { id: string; name: string; currency: string | null } | null;
  /** Whether the person may ask for a first draft, and if not why not (in words). */
  ai: { available: boolean; reason: string | null };
}

interface ContactChoice { id: string; name: string; email: string | null; phone: string | null }
interface DealPick { id: string; name: string; contactId: string | null; contactName: string | null; currency: string | null }

export function NewProposal({ templates, defaultCurrency, contact: contact0, deal: deal0, ai }: NewProposalProps) {
  const router = useRouter();
  const { run, busy } = useCrmAction();
  const [contact, setContact] = React.useState<{ id: string; name: string } | null>(contact0);
  const [deal, setDeal] = React.useState<{ id: string; name: string } | null>(deal0 ? { id: deal0.id, name: deal0.name } : null);
  const [templateId, setTemplateId] = React.useState("");
  const [currency, setCurrency] = React.useState(deal0?.currency && isCurrency(deal0.currency) ? deal0.currency : defaultCurrency);
  const [title, setTitle] = React.useState("");
  const [brief, setBrief] = React.useState("");

  const findContacts = React.useCallback(async (q: string) => {
    const r = await searchContactsAction(null, q);
    return r.ok ? (r.data as ContactChoice[]) : [];
  }, []);
  const findDeals = React.useCallback(async (q: string) => {
    const r = await searchDealsAction(q);
    return r.ok ? (r.data as DealPick[]) : [];
  }, []);

  const links = { contactId: contact?.id ?? null, opportunityId: deal?.id ?? null, templateId: templateId || null, currency };

  async function start() {
    const r = await run("start", () => createProposalAction({ ...links, ...(title.trim() ? { title: title.trim() } : {}) }), "Draft started.");
    if (r) router.push(`/proposals/${(r as { id: string }).id}`);
  }
  async function draft() {
    const r = await run("draft", () => draftWithAiAction({ ...links, brief: brief.trim() || null }));
    if (!r) return;
    const out = r as { id: string; droppedCount: number; rejectedItems: number };
    toast.success(out.droppedCount || out.rejectedItems ? `The AI draft is ready. ${out.droppedCount ? `${out.droppedCount} ${out.droppedCount === 1 ? "sentence was" : "sentences were"} left out because it could not be backed. ` : ""}Read it carefully before you send it for approval.` : "The AI draft is ready. Read it carefully before you send it for approval.");
    router.push(`/proposals/${out.id}`);
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <form className="space-y-4 rounded-2xl border border-line bg-surface p-4" aria-label="Start a proposal" onSubmit={(e) => { e.preventDefault(); void start(); }}>
        <h2 className="text-[15px] font-semibold text-ink">Who and what is it for</h2>
        <Field label="Customer" htmlFor="np-contact" optional hint="Their name and email are filled in from their contact record.">
          <RecordPicker<ContactChoice>
            id="np-contact" label="Customer" placeholder="Search by name, email or phone" search={findContacts}
            render={(c) => <span className="flex min-w-0 flex-col"><span className="truncate font-medium text-ink">{c.name || "Unnamed contact"}</span><span className="truncate text-[12px] text-muted">{c.email ?? c.phone ?? ""}</span></span>}
            onPick={(c) => setContact({ id: c.id, name: c.name || c.email || "Unnamed contact" })}
            value={contact ? contact.name : undefined} onClear={() => setContact(null)}
          />
        </Field>
        <Field label="Deal" htmlFor="np-deal" optional hint="Link it to a deal in your pipeline so the deal shows its proposals.">
          <RecordPicker<DealPick>
            id="np-deal" label="Deal" placeholder="Search your open deals" search={findDeals}
            render={(d) => <span className="flex min-w-0 flex-col"><span className="truncate font-medium text-ink">{d.name}</span><span className="truncate text-[12px] text-muted">{d.contactName ?? "No contact"}</span></span>}
            onPick={(d) => {
              setDeal({ id: d.id, name: d.name });
              if (d.contactId && d.contactName && !contact) setContact({ id: d.contactId, name: d.contactName });
              if (d.currency && isCurrency(d.currency)) setCurrency(d.currency);
            }}
            value={deal ? deal.name : undefined} onClear={() => setDeal(null)}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Currency" htmlFor="np-currency">
            <Select id="np-currency" value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {!isCurrency(currency) && <option value={currency}>{currency}</option>}
              {SUPPORTED_CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </Field>
          <Field label="Template" htmlFor="np-template" optional hint={templates.length ? "Only templates the owner approved." : "No approved template yet."}>
            <Select id="np-template" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">Start from a blank page</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Title" htmlFor="np-title" optional hint="Leave empty to use the deal's or customer's name.">
          <Input id="np-title" value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} className="text-[16px] sm:text-[14px]" />
        </Field>
        <Button type="submit" variant="brand" loading={busy("start")}>Start a draft</Button>
      </form>

      <section aria-labelledby="np-ai" className="space-y-4 rounded-2xl border border-line bg-surface p-4">
        <h2 id="np-ai" className="flex items-center gap-2 text-[15px] font-semibold text-ink"><Sparkles className="size-4 text-violet-ink" aria-hidden />Write a first draft with AI</h2>
        <p className="text-[13px] leading-relaxed text-ink-2">The AI picks items from your price book and writes the wording from what your business has approved. It never sets a price, a discount or a date, and anything it states that your price book or approved knowledge does not back is removed. Its draft always needs a person&apos;s approval before it can be sent. It can still get things wrong, so read all of it. It uses your workspace&apos;s AI service credits.</p>
        {ai.available ? (
          <>
            <Field label="What should the proposal cover" htmlFor="np-brief" optional hint={`Describe the work in your own words. The AI treats this as information, not as instructions. ${brief.length} of ${AI_LIMITS.brief} characters.`}>
              <Textarea id="np-brief" rows={5} value={brief} maxLength={AI_LIMITS.brief} onChange={(e) => setBrief(e.target.value)} className="text-[16px] sm:text-[14px]" />
            </Field>
            <Button type="button" variant="secondary" loading={busy("draft")} onClick={draft}>Write a first draft</Button>
            {busy("draft") && <p role="status" className="text-[12.5px] text-muted">This can take up to a minute.</p>}
            <p className="text-[12.5px] text-muted">It uses the customer, deal, template and currency chosen on the left.</p>
          </>
        ) : <p role="status" className="rounded-xl bg-surface-2 px-3 py-2.5 text-[13px] text-ink-2">{ai.reason}</p>}
      </section>
    </div>
  );
}
