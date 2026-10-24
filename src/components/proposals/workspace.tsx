"use client";

import * as React from "react";
import { Sparkles } from "lucide-react";
import { DROP_REASON_TEXT, type DropReason } from "@/lib/proposals/ai";
import { lockedReason, type CatalogChoice } from "@/lib/proposals/editor";
import { shortHash } from "@/lib/proposals/format";
import type { ProposalDetail } from "@/server/proposals/view";
import type { ProposalInvoicing } from "@/server/invoices/from-proposal";
import { InvoicePanel } from "@/components/proposals/invoice-panel";
import { ProposalActions } from "@/components/proposals/actions-panel";
import { PanelTabs, type TabItem } from "@/components/proposals/tabs";
import { ProposalEditor } from "@/components/proposals/editor";
import type { TaxOption } from "@/components/proposals/lines-editor";
import { DeliveryPanel } from "@/components/proposals/delivery-panel";
import { SignaturePanel } from "@/components/proposals/signature-panel";
import { ActivityPanel, VersionsPanel } from "@/components/proposals/history-panels";
import { ProposalDocument } from "@/components/proposals/public/document";

// One proposal: its status and actions, and the editor, preview, saved versions, history and delivery as tabs. All the panels stay mounted, so what is typed in the editor is
// still there when you look at the preview.

export interface WorkspaceProps {
  detail: ProposalDetail;
  catalog: CatalogChoice[];
  taxRates: TaxOption[];
  can: { create: boolean; approve: boolean; send: boolean; record: boolean; discount: boolean };
  twoPerson: boolean;
  tz: string;
  initialTab?: string;
  /** Invoicing for this proposal (src/server/invoices/from-proposal.ts). Absent, or not available, and there is no Invoice tab: the workspace has no invoicing or the person has no use for it. */
  invoicing?: ProposalInvoicing | null;
}

export function ProposalWorkspace({ detail, catalog, taxRates, can, twoPerson, tz, initialTab, invoicing }: WorkspaceProps) {
  const reason = lockedReason(detail.status, detail.viewer.canEdit);
  const editable = reason === null;
  // The Signature tab is there for a proposal that asks for a signature, or that has had a signing request, and only then: it is no use to anyone else.
  const withSignature = detail.requiresSignature || detail.signature.requests.length > 0;
  const items: TabItem[] = [
    { id: "edit", label: editable ? "Edit" : "Details" },
    { id: "preview", label: "Preview" },
    { id: "versions", label: "Versions", count: detail.versions.length },
    { id: "activity", label: "Activity" },
    { id: "delivery", label: "Delivery" },
    ...(withSignature ? [{ id: "signature", label: "Signature" }] : []),
    ...(invoicing?.available ? [{ id: "invoice", label: "Invoice", count: invoicing.existing.length }] : []),
  ];
  const [tab, setTab] = React.useState<string>(initialTab && items.some((i) => i.id === initialTab) ? initialTab : "edit");
  const [dirty, setDirty] = React.useState(false);
  const preview = detail.preview;
  return (
    <div className="space-y-5">
      {detail.ai && <AiNotice ai={detail.ai} />}
      <ProposalActions detail={detail} can={can} twoPerson={twoPerson} dirty={dirty} tz={tz} onOpenTab={setTab} />
      <PanelTabs
        label="Proposal sections" items={items} value={items.some((i) => i.id === tab) ? tab : "edit"} onChange={setTab} idPrefix="prop"
        panels={{
          edit: <ProposalEditor detail={detail} catalog={catalog} taxRates={taxRates} canDiscount={can.discount} editable={editable} lockedReason={reason} onDirtyChange={setDirty} />,
          preview: (
            <div className="space-y-4">
              <p role="status" className="rounded-xl bg-surface-2 px-3 py-2.5 text-[13px] text-ink-2">
                {!preview ? "The figures can't be worked out yet, so there is no preview. Check the prices, quantities and discounts."
                  : preview.frozen ? `This is version ${preview.version} exactly as it was saved${preview.contentHash ? ` (fingerprint ${shortHash(preview.contentHash)})` : ""}. It is what the customer sees.`
                    : `This is how the customer will read your last saved changes, with placeholders filled in. It is not what a reviewer approves until you send it for approval, which saves it as a version.${dirty ? " You have unsaved changes that are not shown here." : ""}`}
              </p>
              {preview && (
                <div className="rounded-2xl border border-line bg-surface p-5 sm:p-8">
                  <ProposalDocument snapshot={preview.snapshot} version={preview.version} level={2} />
                </div>
              )}
            </div>
          ),
          versions: <VersionsPanel detail={detail} tz={tz} />,
          activity: <ActivityPanel detail={detail} tz={tz} />,
          delivery: <DeliveryPanel detail={detail} canSend={can.send} tz={tz} onOpenTab={setTab} active={tab === "delivery"} />,
          ...(withSignature ? { signature: <SignaturePanel detail={detail} tz={tz} /> } : {}),
          ...(invoicing?.available ? { invoice: <InvoicePanel detail={detail} invoicing={invoicing} tz={tz} /> } : {}),
        }}
      />
    </div>
  );
}

function AiNotice({ ai }: { ai: NonNullable<ProposalDetail["ai"]> }) {
  return (
    <section aria-label="About this AI draft" className="space-y-2 rounded-2xl border border-line bg-violet-soft p-4">
      <p className="flex items-start gap-2 text-[13.5px] text-ink">
        <Sparkles className="mt-0.5 size-4 shrink-0 text-violet-ink" aria-hidden />
        <span><span className="font-semibold">The AI wrote this first draft.</span> It chose items from your price book and wrote the wording. It did not set any price: every price comes from your price book. It can still get things wrong, so read all of it before you send it for approval. It always needs a person&apos;s approval.</span>
      </p>
      {(ai.droppedCount > 0 || ai.rejectedItems > 0) && (
        <details className="rounded-xl bg-surface px-3 py-2 text-[13px] text-ink-2">
          <summary className="min-h-11 cursor-pointer font-medium text-ink sm:min-h-8">
            {ai.droppedCount > 0 ? `${ai.droppedCount} ${ai.droppedCount === 1 ? "sentence was" : "sentences were"} left out` : "Some items were not used"}
            {ai.rejectedItems > 0 ? `${ai.droppedCount > 0 ? ", and " : ": "}${ai.rejectedItems} ${ai.rejectedItems === 1 ? "item it chose was" : "items it chose were"} not used` : ""}
          </summary>
          <div className="mt-2 space-y-2">
            {ai.droppedCount > 0 && <p>These were removed before you saw the draft, because each stated something the checks could not back.</p>}
            <ul className="space-y-2">
              {ai.dropped.map((d, i) => (
                <li key={i} className="rounded-lg border border-line px-3 py-2">
                  <p className="break-words text-ink">{d.text}</p>
                  <p className="mt-0.5 text-[12px] text-muted">{DROP_REASON_TEXT[d.reason as DropReason] ?? "It did not pass a check."}{d.detail ? ` (${d.detail})` : ""}</p>
                </li>
              ))}
            </ul>
            {ai.rejectedItems > 0 && <p>Items are used only when they are in your price book, in this proposal&apos;s currency, and in a whole quantity from 1 to 999.</p>}
          </div>
        </details>
      )}
    </section>
  );
}
