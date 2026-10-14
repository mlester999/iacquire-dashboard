import { describe, expect, it } from "vitest";
import { addListRow, addPage, addSection, findSection, movePage, moveRow, moveSection, removePage, removeRow, removeSection, sectionTypesAvailable, setSectionField, slugFromTitle, toggleSectionHidden, uniqueSlug, updatePage } from "@/lib/website/edit";
import { generateSiteContent } from "@/lib/website/generate";
import { LIMITS, parseContent, type SiteContent } from "@/lib/website/schema";
import { SECTION_DEFS } from "@/lib/website/sections";

const base = (): SiteContent => generateSiteContent({ businessName: "Edit Co", industry: "other", description: "We do things for people.", services: [{ title: "One" }, { title: "Two" }], phone: "+15125550100", pages: ["home", "about", "services", "contact"], aboutText: "Our story." }, "summit.peak");
const valid = (c: SiteContent) => expect(parseContent(c).ok, JSON.stringify(parseContent(c))).toBe(true);

describe("editing website content", () => {
  it("makes URL-safe, unique, never-reserved page addresses", () => {
    expect(slugFromTitle("  Our Services & Pricing!  ")).toBe("our-services-pricing");
    expect(slugFromTitle("Café ☕ crème")).toBe("cafe-creme");
    const c = base();
    expect(uniqueSlug(c, "About")).toBe("about-2");
    expect(uniqueSlug(c, "Admin")).toBe("admin-2");
    expect(uniqueSlug(c, "api")).toBe("api-2");
    expect(uniqueSlug(c, "###")).toBe("page");
    expect(uniqueSlug(c, "x".repeat(100)).length).toBeLessThanOrEqual(40);
  });

  it("adds sections with unique ids, in the right place, and respects what a page may hold", () => {
    const c = base();
    const heroId = c.pages[0].sections[0].id;
    const res = addSection(c, "home", "faq", heroId)!;
    expect(res.content.pages[0].sections[1].id).toBe(res.id);
    expect(res.content.pages[0].sections[1].type).toBe("faq");
    valid(res.content);
    expect(addSection(res.content, "home", "faq")).toBeNull(); // one FAQ per page
    const twice = addSection(addSection(c, "home", "cta")!.content, "home", "richText")!;
    const again = addSection(twice.content, "home", "richText")!; // repeatable
    const ids = again.content.pages[0].sections.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(addSection(c, "nope", "faq")).toBeNull();
    // Ids are unique across the whole site, not just a page.
    const p2 = addSection(c, "contact", "richText")!;
    const p3 = addSection(p2.content, "home", "richText")!;
    expect(p3.id).not.toBe(p2.id);
  });

  it("stops at the section and page limits", () => {
    let c = base();
    for (let i = 0; c.pages[0].sections.length < LIMITS.sectionsPerPage; i += 1) {
      const next = addSection(c, "home", "richText");
      if (!next) throw new Error("should still have room");
      c = next.content;
    }
    expect(addSection(c, "home", "richText")).toBeNull();
    let n = base();
    for (let i = n.pages.length; i < LIMITS.pages; i += 1) n = addPage(n, `Page ${i}`)!.content;
    expect(n.pages).toHaveLength(LIMITS.pages);
    expect(addPage(n, "One more")).toBeNull();
    valid(n);
  });

  it("offers only the section types that can still be added", () => {
    const c = base();
    const offered = sectionTypesAvailable(c.pages[0]);
    expect(offered).not.toContain("hero");
    expect(offered).toContain("richText");
    expect(offered).toContain("cta");
    expect(offered.every((t) => t in SECTION_DEFS)).toBe(true);
  });

  it("edits, hides, reorders and removes sections without disturbing anything else", () => {
    const c = base();
    const page = c.pages[0];
    const [a, b] = [page.sections[0].id, page.sections[1].id];
    const edited = setSectionField(c, "home", a, "headline", "A new headline");
    expect((edited.pages[0].sections[0].data as { headline: string }).headline).toBe("A new headline");
    expect(c.pages[0].sections[0].data).not.toEqual(edited.pages[0].sections[0].data); // the original is untouched
    expect(edited.pages[1]).toBe(c.pages[1]);
    const hidden = toggleSectionHidden(c, "home", b);
    expect(hidden.pages[0].sections[1].hidden).toBe(true);
    expect(toggleSectionHidden(hidden, "home", b).pages[0].sections[1].hidden).toBe(false);
    const moved = moveSection(c, "home", b, -1);
    expect(moved.pages[0].sections.map((s) => s.id).slice(0, 2)).toEqual([b, a]);
    expect(moveSection(c, "home", a, -1)).toEqual(c); // already first
    expect(moveSection(c, "home", page.sections.at(-1)!.id, 1)).toEqual(c); // already last
    expect(removeSection(c, "home", b).pages[0].sections.some((s) => s.id === b)).toBe(false);
    expect(findSection(c, b)?.page.slug).toBe("home");
    expect(findSection(c, "ghost")).toBeNull();
  });

  it("adds, renames, reorders and removes pages, always keeping a home page first", () => {
    const c = base();
    const added = addPage(c, "Our Team")!;
    expect(added.slug).toBe("our-team");
    expect(added.content.pages.at(-1)).toMatchObject({ title: "Our Team", navLabel: "Our Team", showInNav: true });
    valid(added.content);
    expect(addPage(c, "   ")).toBeNull();
    expect(addPage(added.content, "Our Team")!.slug).toBe("our-team-2");
    const renamed = updatePage(added.content, "our-team", { title: "Meet the team", showInNav: false });
    expect(renamed.pages.find((p) => p.slug === "our-team")).toMatchObject({ title: "Meet the team", showInNav: false });
    expect(removePage(added.content, "home")).toBeNull();
    expect(removePage(added.content, "our-team")!.pages.some((p) => p.slug === "our-team")).toBe(false);
    const up = movePage(added.content, "our-team", -1);
    expect(up.pages.map((p) => p.slug).at(-2)).toBe("our-team");
    expect(movePage(added.content, "home", 1).pages[0].slug).toBe("home");
    expect(movePage(added.content, "about", -1).pages[0].slug).toBe("home"); // nothing can move above the home page
  });

  it("edits list rows", () => {
    const field = SECTION_DEFS.faq.fields.find((f) => f.type === "list" && f.key === "items") as Extract<(typeof SECTION_DEFS.faq.fields)[number], { type: "list" }>;
    let rows = addListRow(field, []);
    expect(rows).toEqual([{ question: "", answer: "" }]);
    for (let i = 0; i < 30; i += 1) rows = addListRow(field, rows);
    expect(rows).toHaveLength(field.max);
    expect(moveRow(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
    expect(moveRow(["a", "b"], 0, -1)).toEqual(["a", "b"]);
    expect(removeRow(["a", "b", "c"], 1)).toEqual(["a", "c"]);
  });
});
