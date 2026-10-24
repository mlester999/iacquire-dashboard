// @vitest-environment jsdom
// The customer's invoice page on a phone, as far as markup can show it (there is no layout engine here, so these assert the classes that decide the layout; the browser run
// checks the pixels). The lead's phone pass found the Amount column cut off ("Amo", "₱4,800.") because the line table kept a minimum width wider than the page's text column.
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { InvoiceDocument } from "@/components/invoices/public/invoice-document";
import { ReturnStatus } from "@/components/invoices/public/return-status";
import { PublicShell } from "@/components/invoices/public/shell";
import { Monogram } from "@/app/book/_components/shell";
import { BACK_STORAGE_KEY } from "@/lib/invoices/public-http";
import type { PublicInvoice } from "@/server/invoices/public";

afterEach(cleanup);

const invoice: PublicInvoice = {
  business: { name: "Harbor Home Services (QA)", brandColor: "#1d4ed8", addressLines: ["14 Quay Road", "Cebu City"], taxLabel: "VAT", taxId: "QA-111", email: "billing@harbor.example.test", phone: null },
  number: "INV-0007", issueOn: "2026-10-20", dueOn: "2026-11-03", currency: "PHP", taxInclusive: false, billTo: { name: "Mara Villanueva", company: null, addressLines: ["12 Mango Street"] },
  lines: [
    { position: 1, description: "Annual boiler service, including the flue check and a written report for the landlord", quantity: "1", unitPriceMinor: 480000, discountMinor: 0, taxRateBps: 1200, amountMinor: 480000 },
    { position: 2, description: "Replacement pressure valve", quantity: "2", unitPriceMinor: 125050, discountMinor: 5000, taxRateBps: null, amountMinor: 245100 },
    { position: 3, description: "SupercalifragilisticexpialidociousPartNumberWithoutAnySpacesAtAll", quantity: "10", unitPriceMinor: 12345678, discountMinor: 0, taxRateBps: null, amountMinor: 123456780 },
  ],
  subtotalMinor: 480000, taxMinor: 57600, totalMinor: 537600, paidMinor: 0, balanceMinor: 537600, paymentStatus: "unpaid", overdue: false, paymentInstructions: "Bank transfer to QA Bank.", notes: null, terms: null, footerNote: "Thank you.",
  hasPendingPayment: false, canPayOnline: true, isTest: false, banner: { kind: "pay_online", tone: "info" },
};

const has = (el: Element | null, token: string) => (el?.getAttribute("class") ?? "").split(/\s+/).includes(token);

describe("the line table on a phone (Q5)", () => {
  it("has no minimum width, so it can never be wider than the page's text column, and the Amount column cannot be squeezed or cut", () => {
    const { container } = render(<InvoiceDocument invoice={invoice} />);
    const table = container.querySelector("table")!;
    expect(table.getAttribute("class")).not.toMatch(/(^|\s)(sm:|print:)?min-w-\[/);
    expect(has(table, "w-full")).toBe(true);
    const amountHead = [...container.querySelectorAll("thead th")].find((th) => th.textContent === "Amount")!;
    expect(has(amountHead, "whitespace-nowrap")).toBe(true);
    const rows = [...container.querySelectorAll("tbody tr")];
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const amount = row.lastElementChild!;
      expect(amount.tagName).toBe("TD");
      expect(has(amount, "whitespace-nowrap"), amount.textContent ?? "").toBe(true);
      expect(has(amount, "text-right")).toBe(true);
    }
    // The widest amount is on the page whole.
    expect(screen.getByText("₱1,234,567.80")).toBeTruthy();
  });

  it("lets a long description, even one with no spaces, wrap inside its own column instead of pushing the amount out", () => {
    const { container } = render(<InvoiceDocument invoice={invoice} />);
    for (const th of container.querySelectorAll("tbody th[scope=row]")) expect(th.getAttribute("class"), th.textContent ?? "").toContain("[overflow-wrap:anywhere]");
  });

  it("shows quantity times price under the description on a phone, and the whole table, Qty and Price columns included, when printed", () => {
    const { container } = render(<InvoiceDocument invoice={invoice} />);
    const headers = [...container.querySelectorAll("thead th")];
    for (const name of ["Qty", "Price"]) {
      const th = headers.find((h) => h.textContent === name)!;
      expect(th.getAttribute("class"), name).toContain("hidden");
      expect(th.getAttribute("class"), name).toContain("sm:table-cell");
      expect(th.getAttribute("class"), name).toContain("print:table-cell");
    }
    for (const row of container.querySelectorAll("tbody tr")) {
      const cells = [...row.children];
      expect(cells).toHaveLength(4);
      for (const cell of cells.slice(1, 3)) expect(cell.getAttribute("class")).toContain("print:table-cell");
      // The stacked "2 × ₱1,250.50" line is for phones only: on paper the columns say it.
      const stacked = row.querySelector("th span.sm\\:hidden");
      expect(stacked, "a stacked quantity line").toBeTruthy();
      expect(stacked!.getAttribute("class")).toContain("print:hidden");
    }
    expect(screen.getByText("2 × ₱1,250.50")).toBeTruthy();
  });

  it("still scrolls sideways inside its own box, reachable by keyboard, if something ever does not fit, rather than widening the page", () => {
    const { container } = render(<PublicShell business={invoice.business} wide><InvoiceDocument invoice={invoice} /></PublicShell>);
    const region = screen.getByRole("region", { name: "Invoice lines" });
    expect(has(region, "overflow-x-auto")).toBe(true);
    expect(region.getAttribute("tabindex")).toBe("0");
    expect(container.querySelector("table")!.closest("[role=region]")).toBe(region);
  });
});

describe("the small tile that stands for the business (Q6)", () => {
  it("shows two letters from the words of the name, never a bracket", () => {
    const tile = (name: string) => {
      const { container, unmount } = render(<Monogram name={name} color="#1d4ed8" />);
      const text = container.textContent;
      unmount();
      return text;
    };
    expect(tile("Harbor Home Services (QA)")).toBe("HS");
    expect(tile("(QA) Harbor")).toBe("HA");
    expect(tile("A & B Plumbing")).toBe("AP");
    expect(tile("9 to 5 Co")).toBe("9C");
    expect(tile("Ñandú Café")).toBe("ÑC");
  });

  it("is what the customer's invoice page puts in its frame", () => {
    const { container } = render(<PublicShell business={invoice.business}><p>x</p></PublicShell>);
    const tile = container.querySelector("header [aria-hidden=true]");
    expect(tile?.textContent).toBe("HS");
  });
});

describe("a link on the return page (Q9)", () => {
  it("is a full-height target on a phone", () => {
    window.sessionStorage.setItem(BACK_STORAGE_KEY, `/pay/${"A".repeat(43)}`);
    render(<ReturnStatus reference={`CP-${"a".repeat(24)}`} initial={{ state: "received", headline: "We have received your payment", detail: "Thank you.", polling: false, tone: "ok" }} approvedCheckoutId={null} />);
    const link = screen.getByRole("link", { name: "Back to your invoice" });
    expect(link.getAttribute("class")).toContain("min-h-11");
    expect(link.getAttribute("class")).toContain("inline-flex");
    window.sessionStorage.clear();
  });
});
