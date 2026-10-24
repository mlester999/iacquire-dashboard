// iOS Safari zooms the page when a field under 16 px takes focus. The shared Input, Select and Textarea (and the record picker's search box, which is an Input) therefore
// render at 16 px below the sm breakpoint and keep their smaller desktop size from sm up, so no call site needs a per-element override. Rendered to static markup, so the
// check is on the class the browser gets. (Whether the page really stops zooming on a phone is for the browser pass; this pins the classes that decide it.)
import * as React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => "/proposals/new" }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { Input, Select, Textarea } from "@/components/ui/primitives";
import { RecordPicker } from "@/components/crm/ui";

/** The class attribute of the first element with this tag. */
function classOf(html: string, tag: string): string {
  const m = new RegExp(`<${tag}\\b[^>]*?class="([^"]*)"`).exec(html);
  if (!m) throw new Error(`no <${tag}> with a class in: ${html}`);
  return m[1];
}

function expectPhoneSafe(cls: string) {
  const tokens = cls.split(/\s+/);
  expect(tokens, cls).toContain("text-[16px]");
  // The size from sm up is the one the design always had.
  expect(tokens, cls).toContain("sm:text-sm");
  // Nothing below 16 px is left for the phone.
  expect(tokens.filter((t) => /^text-\[(1[0-5](\.\d+)?)px\]$/.test(t)), cls).toEqual([]);
  expect(tokens.filter((t) => t === "text-xs" || t === "text-sm"), cls).toEqual([]);
}

describe("the shared form fields are 16 px on a phone", () => {
  it("Input", () => expectPhoneSafe(classOf(renderToStaticMarkup(<Input aria-label="x" />), "input")));
  it("Select", () => expectPhoneSafe(classOf(renderToStaticMarkup(<Select aria-label="x"><option>a</option></Select>), "select")));
  it("Textarea", () => expectPhoneSafe(classOf(renderToStaticMarkup(<Textarea aria-label="x" />), "textarea")));

  it("keeps the 44 px touch height on a phone and 40 px from sm up for Input and Select", () => {
    expect(classOf(renderToStaticMarkup(<Input aria-label="x" />), "input")).toMatch(/\bh-11\b[\s\S]*\bsm:h-10\b/);
    expect(classOf(renderToStaticMarkup(<Select aria-label="x"><option>a</option></Select>), "select")).toMatch(/\bh-11\b[\s\S]*\bsm:h-10\b/);
  });

  it("lets a call site that really wants a different size say so", () => {
    expect(classOf(renderToStaticMarkup(<Input aria-label="x" className="text-[18px]" />), "input").split(/\s+/)).toContain("text-[18px]");
  });

  it("the record picker's search box (contact and deal pickers on the new proposal and new invoice pages) is 16 px on a phone", () => {
    const html = renderToStaticMarkup(<RecordPicker id="contact" label="Customer" placeholder="Search customers" search={async () => []} render={() => null} onPick={() => {}} />);
    expect(html).toContain('role="combobox"');
    expectPhoneSafe(classOf(html, "input"));
  });
});

describe("the Wave 1 call sites do not carry a per-element fix any more", () => {
  // The proposals screens never passed a size to their selects; they now get 16 px from the primitive. A new select there that sets a phone size below 16 px would bring the zoom back.
  it("no proposals, invoices or reputation field forces a phone size under 16 px", () => {
    const files = ["proposals/lines-editor.tsx", "proposals/editor.tsx", "proposals/new-proposal.tsx", "proposals/settings-panel.tsx", "proposals/catalog-panel.tsx", "proposals/actions-panel.tsx", "proposals/signing-connection-card.tsx", "proposals/sections-editor.tsx", "proposals/template-editor.tsx", "invoices/invoice-form.tsx", "reputation/settings-panel.tsx"];
    for (const file of files) {
      const text = readFileSync(`src/components/${file}`, "utf8");
      const small = [...text.matchAll(/<(?:Input|Select|Textarea)\b[^>]*className="([^"]*)"/g)].map((m) => m[1]).filter((c) => c.split(/\s+/).some((t) => /^text-\[(1[0-5](\.\d+)?)px\]$/.test(t) || t === "text-xs" || t === "text-sm"));
      expect(small, file).toEqual([]);
    }
  });
});
