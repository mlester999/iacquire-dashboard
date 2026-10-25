import * as React from "react";
import { formatMinor, formatQuantity } from "@/lib/money";
import { BILLINGS, BILLING_LABELS, type Billing } from "@/lib/proposals/doc";
import { bpsLabel } from "@/lib/proposals/money";
import type { ProposalSnapshot, SnapshotLine } from "@/lib/proposals/snapshot";
import { formatDay } from "@/lib/proposals/validity";
import { wordingBlocks } from "@/lib/proposals/wording";
import type { Run } from "@/lib/pdf/writer";

// The frozen proposal as the customer reads it. Everything comes from the snapshot, which is plain data: wording is turned into elements here, never into markup, so nothing a
// person typed can add a tag, a link or a script to the page.

function Runs({ runs }: { runs: Run[] }) {
  return (
    <>
      {runs.map((r, i) => {
        const bold = r.font === "bold" || r.font === "boldItalic";
        const italic = r.font === "italic" || r.font === "boldItalic";
        let node: React.ReactNode = r.text;
        if (italic) node = <em>{node}</em>;
        if (bold) node = <strong className="font-semibold">{node}</strong>;
        return <React.Fragment key={i}>{node}</React.Fragment>;
      })}
    </>
  );
}

/** Wording as paragraphs and lists. */
export function Wording({ text, className }: { text: string; className?: string }) {
  return (
    <div className={className}>
      {wordingBlocks(text).map((b, i) =>
        b.kind === "p" ? (
          <p key={i} className="mt-2 whitespace-pre-line break-words first:mt-0">
            <Runs runs={b.runs} />
          </p>
        ) : b.kind === "ul" ? (
          <ul key={i} className="mt-2 list-disc space-y-1 pl-5 first:mt-0">
            {b.items.map((it, j) => (
              <li key={j} className="break-words">
                <Runs runs={it} />
              </li>
            ))}
          </ul>
        ) : (
          <ol key={i} className="mt-2 list-decimal space-y-1 pl-5 first:mt-0">
            {b.items.map((it, j) => (
              <li key={j} className="break-words">
                <Runs runs={it} />
              </li>
            ))}
          </ol>
        ),
      )}
    </div>
  );
}

function discountLabel(l: SnapshotLine, currency: ProposalSnapshot["currency"]): string | null {
  if (!l.discount) return null;
  const given = formatMinor(-l.amounts.discount, currency);
  return l.discount.kind === "percent" ? `${bpsLabel(l.discount.bps)} off (${given})` : `${given} off`;
}

function LineItem({ l }: { l: SnapshotLine }) {
  return (
    <div className="min-w-0">
      <p className="font-medium text-ink">{l.name}</p>
      {l.description.trim() && <Wording text={l.description} className="mt-1 text-[14px] leading-relaxed text-muted" />}
      {l.note.trim() && <p className="mt-1 text-[14px] italic text-muted">{l.note}</p>}
      {l.taxBps > 0 && <p className="mt-1 text-[13px] text-muted">{l.taxName ?? "Tax"} {bpsLabel(l.taxBps)} is added to the total.</p>}
    </div>
  );
}

/** The heading tags of a document: the customer's page owns the page title (level 1); inside the team's screens the document sits one level down. */
const HEADINGS = { 1: { title: "h1", section: "h2", group: "h3" }, 2: { title: "h2", section: "h3", group: "h4" } } as const;

function Group({ billing, snapshot, labelled, level }: { billing: Billing; snapshot: ProposalSnapshot; labelled: boolean; level: 1 | 2 }) {
  const GroupHeading = HEADINGS[level].group;
  const lines = snapshot.lines.filter((l) => l.billing === billing);
  const g = snapshot.groups[billing];
  const c = snapshot.currency;
  const rows: Array<{ label: string; value: string; strong?: boolean }> = [];
  if (g.discount > 0) {
    rows.push({ label: "Before discounts", value: formatMinor(g.gross, c) }, { label: "Discounts", value: formatMinor(-g.discount, c) });
  }
  rows.push({ label: "Subtotal", value: formatMinor(g.subtotal, c) });
  if (g.tax > 0) rows.push({ label: "Tax", value: formatMinor(g.tax, c) });
  rows.push({ label: labelled ? `Total ${BILLING_LABELS[billing].toLowerCase()}` : "Total", value: formatMinor(g.total, c), strong: true });
  return (
    <section aria-label={labelled ? BILLING_LABELS[billing] : "Prices"} className="mt-4 first:mt-0">
      {labelled && <GroupHeading className="mb-2 text-[14px] font-semibold uppercase tracking-wide text-muted">{BILLING_LABELS[billing]}</GroupHeading>}
      {/* Phones get a card per line; wider screens get the table. */}
      <ul className="divide-y divide-line rounded-xl border border-line sm:hidden">
        {lines.map((l, i) => (
          <li key={i} className="space-y-2 p-3.5">
            <LineItem l={l} />
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[14px]">
              <dt className="text-muted">Quantity</dt>
              <dd className="text-right tabular-nums">{formatQuantity(l.quantityMilli)} {l.unitLabel}</dd>
              <dt className="text-muted">Unit price</dt>
              <dd className="text-right tabular-nums">{formatMinor(l.unitPriceMinor, c)}</dd>
              {l.discount && (
                <>
                  <dt className="text-muted">Discount</dt>
                  <dd className="text-right tabular-nums">{discountLabel(l, c)}</dd>
                </>
              )}
              <dt className="font-medium text-ink">Amount</dt>
              <dd className="text-right font-medium tabular-nums text-ink">{formatMinor(l.amounts.net, c)}</dd>
            </dl>
          </li>
        ))}
      </ul>
      <div className="hidden overflow-hidden rounded-xl border border-line sm:block">
        <table className="w-full table-fixed text-left text-[14px]">
          <caption className="sr-only">{labelled ? BILLING_LABELS[billing] : "Prices"}</caption>
          <thead className="bg-surface-2 text-[12px] uppercase tracking-wide text-muted">
            <tr>
              <th scope="col" className="w-[40%] px-3.5 py-2.5 font-semibold">Item</th>
              <th scope="col" className="px-3.5 py-2.5 font-semibold">Quantity</th>
              <th scope="col" className="px-3.5 py-2.5 text-right font-semibold">Unit price</th>
              <th scope="col" className="px-3.5 py-2.5 text-right font-semibold">Discount</th>
              <th scope="col" className="px-3.5 py-2.5 text-right font-semibold">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {lines.map((l, i) => (
              <tr key={i} className="align-top">
                <td className="px-3.5 py-3"><LineItem l={l} /></td>
                <td className="px-3.5 py-3 tabular-nums">{formatQuantity(l.quantityMilli)} {l.unitLabel}</td>
                <td className="px-3.5 py-3 text-right tabular-nums">{formatMinor(l.unitPriceMinor, c)}</td>
                <td className="px-3.5 py-3 text-right tabular-nums">{l.discount ? formatMinor(-l.amounts.discount, c) : "-"}</td>
                <td className="px-3.5 py-3 text-right font-medium tabular-nums">{formatMinor(l.amounts.net, c)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="ml-auto mt-3 w-full max-w-xs space-y-1 text-[14px]">
        {rows.map((r) => (
          <div key={r.label} className={`flex justify-between gap-4 ${r.strong ? "border-t border-ink pt-2 text-[15px] font-semibold text-ink" : "text-muted"}`}>
            <dt>{r.label}</dt>
            <dd className="tabular-nums">{r.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function ProposalDocument({ snapshot, version, level = 1 }: { snapshot: ProposalSnapshot; version: number; level?: 1 | 2 }) {
  const Title = HEADINGS[level].title;
  const SectionHeading = HEADINGS[level].section;
  const used = BILLINGS.filter((b) => snapshot.lines.some((l) => l.billing === b));
  const labelled = used.length > 1 || (used.length === 1 && used[0] !== "one_time");
  const client = [snapshot.client.name, snapshot.client.company].filter((x) => x.trim());
  return (
    <article aria-labelledby="proposal-title" className="space-y-6 text-[14.5px] leading-relaxed text-ink-2">
      <header className="space-y-1">
        <p className="text-[14px] text-muted">
          Proposal {snapshot.number} &middot; Version {version}
        </p>
        <Title id="proposal-title" className="text-[24px] font-semibold tracking-[-0.03em] text-ink sm:text-[28px]">{snapshot.title}</Title>
        <dl className="mt-3 grid gap-x-8 gap-y-1 text-[14px] sm:grid-cols-[auto_1fr]">
          {client.length > 0 && (
            <>
              <dt className="text-muted">Prepared for</dt>
              <dd className="text-ink">{client.join(", ")}</dd>
            </>
          )}
          {(snapshot.sender.name || snapshot.business.name) && (
            <>
              <dt className="text-muted">Prepared by</dt>
              <dd className="text-ink">{[snapshot.sender.name, snapshot.business.name].filter(Boolean).join(", ")}</dd>
            </>
          )}
          {snapshot.validUntil && (
            <>
              <dt className="text-muted">Valid until</dt>
              <dd className="text-ink">{formatDay(snapshot.validUntil)}</dd>
            </>
          )}
        </dl>
      </header>

      {snapshot.sections.map((s, i) => (
        <section key={i} aria-labelledby={`proposal-section-${i}`}>
          <SectionHeading id={`proposal-section-${i}`} className="text-[17px] font-semibold tracking-[-0.02em] text-ink">{s.heading}</SectionHeading>
          <Wording text={s.body} className="mt-2" />
        </section>
      ))}

      {used.length > 0 && (
        <section aria-labelledby="proposal-investment">
          <SectionHeading id="proposal-investment" className="text-[17px] font-semibold tracking-[-0.02em] text-ink">Investment</SectionHeading>
          <div className="mt-3 space-y-6">
            {used.map((b) => (
              <Group key={b} billing={b} snapshot={snapshot} labelled={labelled} level={level} />
            ))}
          </div>
          {used.length > 1 && <p className="mt-3 text-[14px] text-muted">One-time, monthly and yearly amounts are shown separately and are not added together.</p>}
        </section>
      )}

      {snapshot.terms.trim() && (
        <section aria-labelledby="proposal-terms">
          <SectionHeading id="proposal-terms" className="text-[17px] font-semibold tracking-[-0.02em] text-ink">Terms</SectionHeading>
          <Wording text={snapshot.terms} className="mt-2" />
        </section>
      )}
    </article>
  );
}
