// A frozen proposal version set as a PDF. Pure and deterministic: the same snapshot, version and creation time always make the same bytes (nothing reads the clock), so the sha256
// kept with the stored file is a fact about that document and a copy made again can be checked against it.
//
// It shows exactly what the snapshot holds, which is what the reviewer approved and what the customer's page shows: the wording, the priced lines, each billing group's totals,
// the terms and the valid-until date. It says nothing about enforceability: how a customer answers is on their page, not in this file. A proposal that needs a signature ends
// with one extra page holding an empty, labelled signature area at a fixed place (signatureBox), so a signing service can put its signature field there; the copy is not signed.
import { formatMinor, formatQuantity, type CurrencyCode } from "@/lib/money";
import { BILLINGS, BILLING_LABELS, type Billing } from "@/lib/proposals/doc";
import { bpsLabel } from "@/lib/proposals/money";
import type { ProposalSnapshot, SnapshotLine } from "@/lib/proposals/snapshot";
import { formatDay } from "@/lib/proposals/validity";
import { Flow, INK, MUTED, PANEL, PdfDocument, type PageSizeName, type TableCell } from "@/lib/pdf/writer";

export interface ProposalPdfInput {
  snapshot: ProposalSnapshot;
  version: number;
  /** The version's content hash: shown on every page as the document id and used as the file identifier. */
  contentHash: string;
  /** When the version was frozen. Never "now". */
  createdAt: Date;
}

/** Letter paper where it is the usual size for the currency's home markets (the dollar currencies of North America and the Philippines); A4 everywhere else. Cosmetic only. */
export function pageSizeFor(currency: CurrencyCode): PageSizeName {
  return currency === "USD" || currency === "CAD" || currency === "PHP" ? "LETTER" : "A4";
}

/** Where the signature area is on the last page: points from the page's top-left corner. The same on both paper sizes, because the margins are. */
export interface SignatureBox {
  page: "last";
  x: number;
  yTop: number;
  width: number;
  height: number;
}

export const SIGNATURE_BOX: SignatureBox = { page: "last", x: 54, yTop: 210, width: 280, height: 64 };

/** The page that carries the signature area. It is always a page of its own, so the area never depends on how long the proposal is. */
function signaturePage(flow: Flow, s: ProposalSnapshot, version: number): void {
  flow.newPage();
  flow.heading("Signature");
  flow.paragraph(
    `Version ${version} of proposal ${s.number} is signed on this page, through the signing service ${s.business.name || "the business"} uses. Until the signing service reports it signed, this copy is not signed.`,
    { size: 10, color: MUTED, spaceAfter: 6, literal: true },
  );
  const b = SIGNATURE_BOX;
  flow.doc.text(flow.page, b.x, b.yTop - 8, "Signature", { font: "bold", size: 9, color: MUTED });
  flow.doc.fillRect(flow.page, b.x, b.yTop, b.width, b.height, PANEL);
  flow.doc.rule(flow.page, b.x, b.x + b.width, b.yTop + b.height, INK, 0.8);
  const lineY = b.yTop + b.height + 52;
  flow.doc.text(flow.page, b.x, lineY - 6, "Name", { font: "bold", size: 9, color: MUTED });
  flow.doc.rule(flow.page, b.x, b.x + b.width, lineY, INK, 0.6);
  flow.doc.text(flow.page, b.x, lineY + 40, "Date", { font: "bold", size: 9, color: MUTED });
  flow.doc.rule(flow.page, b.x, b.x + 140, lineY + 46, INK, 0.6);
}

/** A percentage discount shows the rate and then what it comes to, each on its own line, so a narrow column never splits an amount. */
function discountParagraphs(l: SnapshotLine, currency: CurrencyCode): TableCell["paragraphs"] {
  if (!l.discount) return [{ text: "-" }];
  const given = { text: formatMinor(-l.amounts.discount, currency) };
  return l.discount.kind === "percent" ? [{ text: bpsLabel(l.discount.bps) }, { ...given, size: 8.5, color: MUTED }] : [given];
}

function lineCells(l: SnapshotLine, currency: CurrencyCode): TableCell[] {
  const item: TableCell["paragraphs"] = [{ text: l.name, font: "bold" }];
  if (l.description.trim()) item.push({ text: l.description.replace(/\s*\n\s*/g, " ").trim(), size: 8.5, color: MUTED, inline: true });
  if (l.note.trim()) item.push({ text: l.note.replace(/\s*\n\s*/g, " ").trim(), font: "italic", size: 8.5, color: MUTED, inline: true });
  if (l.taxBps > 0) item.push({ text: `${l.taxName ?? "Tax"} ${bpsLabel(l.taxBps)} added to the total`, size: 8.5, color: MUTED });
  return [
    { paragraphs: item },
    { paragraphs: [{ text: `${formatQuantity(l.quantityMilli)} ${l.unitLabel}` }] },
    { paragraphs: [{ text: formatMinor(l.unitPriceMinor, currency) }] },
    { paragraphs: discountParagraphs(l, currency) },
    // Before tax: the lines add up to the subtotal, and the subtotal plus tax is the total.
    { paragraphs: [{ text: formatMinor(l.amounts.net, currency) }] },
  ];
}

/** "Label ........ amount" rows, the amounts ending at the right margin. */
function totalsBlock(flow: Flow, rows: Array<{ label: string; value: string; bold?: boolean }>): void {
  const size = 10;
  const leading = 15;
  flow.need(rows.length * leading + 8);
  const labelX = flow.right - 230;
  for (const r of rows) {
    const font = r.bold ? "bold" : "regular";
    if (r.bold) flow.doc.rule(flow.page, labelX, flow.right, flow.y + 3, INK, 0.8);
    flow.doc.text(flow.page, labelX, flow.y + (r.bold ? 4 : 0) + size + 2, r.label, { font, size, color: r.bold ? INK : MUTED });
    flow.doc.textRight(flow.page, flow.right, flow.y + (r.bold ? 4 : 0) + size + 2, r.value, { font, size });
    flow.y += leading + (r.bold ? 4 : 0);
  }
  flow.space(8);
}

function keyValue(flow: Flow, key: string, value: string): void {
  if (!value.trim()) return;
  const size = 10;
  const keyWidth = 92;
  flow.need(size * 2.7);
  flow.doc.text(flow.page, flow.left, flow.y + size, key, { font: "bold", size: 9, color: MUTED });
  // The value's first line sits on the key's own line and the rest run below it.
  flow.paragraph(value, { size, indent: keyWidth, literal: true });
  flow.space(1);
}

export function renderProposalPdfBytes(input: ProposalPdfInput): Buffer {
  const s = input.snapshot;
  const doc = new PdfDocument(
    { title: `${s.number} ${s.title}`.slice(0, 120), author: s.business.name || undefined, subject: `Proposal ${s.number}, version ${input.version}`, createdAt: input.createdAt, idSeed: input.contentHash },
    { size: pageSizeFor(s.currency) },
  );
  const flow = new Flow(doc);

  if (s.business.name) flow.paragraph(s.business.name, { size: 11, base: "bold", color: MUTED, spaceAfter: 6, literal: true });
  flow.paragraph(s.title, { size: 22, base: "bold", leading: 1.2, spaceAfter: 4, literal: true });
  flow.paragraph(`Proposal ${s.number}  ·  Version ${input.version}`, { size: 10, color: MUTED, spaceAfter: 10, literal: true });
  flow.rule();
  flow.space(2);

  keyValue(flow, "Prepared for", [s.client.name, s.client.company, s.client.email ?? ""].filter((x) => x.trim()).join("\n"));
  keyValue(flow, "Prepared by", [s.sender.name ?? "", s.business.name, s.business.website ?? ""].filter((x) => x.trim()).join("\n"));
  if (s.validUntil) keyValue(flow, "Valid until", formatDay(s.validUntil));
  keyValue(flow, "Currency", s.currency);
  flow.space(6);

  for (const section of s.sections) {
    flow.heading(section.heading);
    flow.wording(section.body, { spaceAfter: 6 });
  }

  const used = BILLINGS.filter((b) => s.lines.some((l) => l.billing === b));
  if (used.length) {
    flow.need(120);
    flow.heading("Investment");
    for (const billing of used as Billing[]) {
      const lines = s.lines.filter((l) => l.billing === billing);
      const g = s.groups[billing];
      // The group's name, its table header and the start of its first row stay together.
      flow.need(110);
      if (used.length > 1 || billing !== "one_time") flow.paragraph(BILLING_LABELS[billing], { size: 10, base: "bold", color: MUTED, spaceAfter: 3, keepWithNext: true, literal: true });
      flow.table(
        [
          { weight: 4.2, header: "Item" },
          { weight: 1.5, header: "Quantity" },
          { weight: 1.7, header: "Unit price", align: "right" },
          { weight: 1.9, header: "Discount", align: "right" },
          { weight: 1.9, header: "Amount", align: "right" },
        ],
        lines.map((l) => lineCells(l, s.currency)),
      );
      flow.space(6);
      const rows: Array<{ label: string; value: string; bold?: boolean }> = [];
      if (g.discount > 0) {
        rows.push({ label: "Before discounts", value: formatMinor(g.gross, s.currency) });
        rows.push({ label: "Discounts", value: formatMinor(-g.discount, s.currency) });
      }
      rows.push({ label: "Subtotal", value: formatMinor(g.subtotal, s.currency) });
      if (g.tax > 0) rows.push({ label: "Tax", value: formatMinor(g.tax, s.currency) });
      rows.push({ label: used.length > 1 || billing !== "one_time" ? `Total ${BILLING_LABELS[billing].toLowerCase()}` : "Total", value: formatMinor(g.total, s.currency), bold: true });
      totalsBlock(flow, rows);
    }
    if (used.length > 1) flow.paragraph("One-time, monthly and yearly amounts are shown separately and are not added together.", { size: 8.5, color: MUTED, spaceAfter: 8, literal: true });
  }

  if (s.terms.trim()) {
    flow.heading("Terms");
    flow.wording(s.terms, { spaceAfter: 6 });
  }

  flow.space(4);
  flow.paragraph(
    s.requiresSignature
      ? "This proposal needs a signature. The business arranges signing, through a signing service or in person; this copy is not signed."
      : `This is a copy for your records. To accept, decline or ask for changes, use the link you were sent${s.business.name ? ` by ${s.business.name}` : ""}.`,
    { size: 8.5, color: MUTED, literal: true },
  );
  if (s.requiresSignature) signaturePage(flow, s, input.version);

  // Footers, now that the number of pages is known.
  const total = doc.pageCount;
  for (let i = 0; i < total; i++) {
    const y = doc.height - doc.margin + 10;
    doc.text(i, doc.margin, y, `${s.number}  ·  Version ${input.version}`, { size: 8, color: MUTED });
    doc.textRight(i, doc.width - doc.margin, y, `Page ${i + 1} of ${total}`, { size: 8, color: MUTED });
    doc.text(i, doc.margin, y + 10, `Document ID ${input.contentHash.slice(0, 16)}`, { size: 7, color: MUTED });
  }
  return doc.build();
}
