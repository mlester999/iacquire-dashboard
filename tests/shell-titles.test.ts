// The top bar names the page the person is on. A route with no entry falls back to the product name, which made every invoice screen read "iAcquire" while the side menu and the
// page heading said Invoices. The titles live in a plain file (not the client top bar) so this can check them without a browser.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FALLBACK_TITLE, titleFor } from "@/components/shell/titles";

const SRC = path.resolve(import.meta.dirname, "..", "src");

describe("the top bar title", () => {
  it("names every Wave 1 screen", () => {
    for (const p of ["/invoices", "/invoices/new", "/invoices/7d1f/edit", "/invoices/settings", "/invoices/0c9e5b1a-0000-4000-8000-000000000000"]) expect(titleFor(p), p).toBe("Invoices");
    for (const p of ["/proposals", "/proposals/new", "/proposals/approvals", "/proposals/catalog", "/proposals/settings", "/proposals/templates/abc"]) expect(titleFor(p), p).toBe("Proposals");
    expect(titleFor("/crm/reviews")).toBe("Reviews");
    expect(titleFor("/settings/payments")).toBe("Settings");
  });

  it("keeps the titles it had, and the more specific entry still wins over the general one", () => {
    expect(titleFor("/overview")).toBe("Overview");
    expect(titleFor("/employees/abc/configure")).toBe("Configure employee");
    expect(titleFor("/employees/abc")).toBe("AI Employees");
    expect(titleFor("/crm/contacts/123")).toBe("Contacts");
    expect(titleFor("/crm/reports/sources")).toBe("CRM");
    expect(titleFor("/crm/reviews/anything")).toBe("Reviews");
    expect(titleFor("/inbox")).toBe("Inbox");
  });

  it("falls back to the product name only for a path that is not a portal screen", () => {
    expect(titleFor("/")).toBe(FALLBACK_TITLE);
    expect(titleFor("/somewhere-else")).toBe(FALLBACK_TITLE);
  });

  it("gives every entry of the side menu a title of its own, so no screen reached from it says 'iAcquire'", () => {
    const sidebar = readFileSync(path.join(SRC, "components/shell/sidebar.tsx"), "utf8");
    const hrefs = [...new Set([...sidebar.matchAll(/\{ href: "(\/[a-z0-9\-/]*)", label: "([^"]+)"/g)].map((m) => m[1]))];
    expect(hrefs.length).toBeGreaterThan(25);
    expect(hrefs).toContain("/invoices");
    expect(hrefs.filter((h) => titleFor(h) === FALLBACK_TITLE)).toEqual([]);
  });

  it("covers every top-level screen of the client portal", () => {
    const portal = path.join(SRC, "app/(portal)");
    const tops = readdirSync(portal).filter((n) => statSync(path.join(portal, n)).isDirectory() && !n.startsWith("_") && !n.startsWith("(") && !n.startsWith("["));
    expect(tops).toContain("invoices");
    // The screens that open outside the top bar's title (a full-screen chat, pages that choose their own heading) are named here with their reason; every other screen has a title.
    const own = new Set<string>([]);
    expect(tops.filter((t) => !own.has(t) && titleFor(`/${t}`) === FALLBACK_TITLE)).toEqual([]);
  });
});
