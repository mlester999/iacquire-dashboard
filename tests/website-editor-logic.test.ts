import { describe, expect, it } from "vitest";
import { collectIds, eachElement, isRef, parseContent, type ElementNode, type Section, type SiteContent } from "@/lib/website/doc";
import { diffDocs } from "@/lib/website/editor/diff";
import { adjustForRemoval, axisOf, pickSlot, slotLine, spanFromPixels, type Rect } from "@/lib/website/editor/dnd";
import { buildLayout, buildPreset, ELEMENT_PRESETS, LAYOUT_PRESETS, newElement, SECTION_PRESETS } from "@/lib/website/editor/library";
import { initialState, reducer } from "@/lib/website/editor/state";
import { checkReadiness, warningNeedsAcknowledgement } from "@/lib/website/lint";
import { upgradeLegacy, parseStoredContent } from "@/lib/website/legacy";
import {
  addPage, canInsertElement, canPlace, detachShared, duplicateNode, duplicatePage, findNode, getElement, getSection, insertElement, insertSection, makeShared, moveNode, nudge, nudgeAcross,
  removeNode, setColumnCount, setHide, setHomePage, setProp, setResponsive, setStyle, updatePage,
} from "@/lib/website/ops";
import { buildSite, sampleSite } from "@/lib/website/templates";
import type { SiteDetails } from "@/lib/website/templates/types";

const DETAILS: SiteDetails = {
  businessName: "Bright Roofing", industry: "home_services", tagline: "Roof repairs across Austin", description: "We repair and replace roofs.",
  services: [{ title: "Roof repair" }, { title: "Gutters" }, { title: "Inspections" }], phone: "+15125550100", email: "hello@brightroofing.test", areas: ["Austin", "Round Rock"],
  pages: ["home", "about", "services", "contact"], primaryAction: "call",
};
const site = (): SiteContent => buildSite("meridian.estate", DETAILS);
const firstPageSections = (d: SiteContent) => d.pages[0].items.filter((i): i is Section => !isRef(i));

describe("document operations", () => {
  it("moves a section and keeps every id", () => {
    const doc = site();
    const page = doc.pages[0];
    const before = collectIds(doc).sort();
    const sec = firstPageSections(doc)[1];
    const moved = moveNode(doc, sec.id, page.id, 0);
    expect(moved.pages[0].items[0].id).toBe(sec.id);
    expect(collectIds(moved).sort()).toEqual(before);
    expect(parseContent(moved).ok).toBe(true);
  });

  it("refuses to put something inside itself or into a non-container", () => {
    const doc = site();
    const sec = firstPageSections(doc)[0];
    const col = sec.columns[0];
    expect(canPlace(doc, col.id, col.id).ok).toBe(false);
    const el = col.elements[0];
    expect(canPlace(doc, sec.id, el.id).ok).toBe(false);
    expect(canPlace(doc, el.id, el.id).ok).toBe(false);
  });

  it("moves an element between columns and nudges it up and down", () => {
    const doc = site();
    const sec = firstPageSections(doc).find((s) => s.columns.length >= 2 && s.columns[0].elements.length)!;
    const el = sec.columns[0].elements[0];
    const into = sec.columns[1];
    const moved = moveNode(doc, el.id, into.id, 0);
    expect(findNode(moved, el.id)?.parentId).toBe(into.id);
    expect(parseContent(moved).ok).toBe(true);
    const down = nudge(moved, el.id, 1);
    expect(findNode(down, el.id)!.index).toBe(Math.min(1, into.elements.length));
    const across = nudgeAcross(down, el.id, -1);
    expect(findNode(across, el.id)?.parentId).toBe(sec.columns[0].id);
  });

  it("duplicates a section with fresh ids, and removing it leaves no orphans", () => {
    const doc = site();
    const sec = firstPageSections(doc)[1];
    const dup = duplicateNode(doc, sec.id)!;
    expect(dup.id).not.toBe(sec.id);
    const ids = collectIds(dup.doc);
    expect(new Set(ids).size).toBe(ids.length);
    expect(parseContent(dup.doc).ok).toBe(true);
    const removed = removeNode(dup.doc, dup.id);
    expect(collectIds(removed).sort()).toEqual(collectIds(doc).sort());
  });

  it("sets properties, styles, responsive overrides and visibility without touching other nodes", () => {
    const doc = site();
    const el = firstPageSections(doc)[0].columns.flatMap((c) => c.elements).find((e) => e.type === "heading")!;
    let next = setProp(doc, el.id, "text", "A *new* headline");
    next = setStyle(next, el.id, { size: "5xl", align: "center" });
    next = setResponsive(next, el.id, "m", { size: "3xl", align: "start" });
    next = setHide(next, el.id, "t", true);
    const got = getElement(next, el.id)!;
    expect(got.props.text).toBe("A *new* headline");
    expect(got.style).toMatchObject({ size: "5xl", align: "center" });
    expect(got.r?.m).toMatchObject({ size: "3xl", align: "start" });
    expect(got.hide).toEqual({ t: true });
    // Clearing a value removes it entirely, so "reset to default" is just undefined.
    const cleared = setStyle(next, el.id, { size: undefined, align: undefined });
    expect(getElement(cleared, el.id)!.style).toBeUndefined();
    expect(parseContent(next).ok).toBe(true);
  });

  it("changes the column count without losing elements", () => {
    const doc = site();
    const sec = firstPageSections(doc).find((s) => s.columns.length === 2)!;
    const count = sec.columns.flatMap((c) => c.elements).length;
    let n = 0;
    const one = setColumnCount(doc, sec.id, 1, () => ({ id: `nc${++n}`, span: 12, gap: "s", pad: "0", surface: "none", elements: [] }));
    const after = getSection(one, sec.id)!;
    expect(after.columns).toHaveLength(1);
    expect(after.columns[0].span).toBe(12);
    expect(after.columns.flatMap((c) => c.elements)).toHaveLength(count);
  });

  it("manages pages: unique slugs, a fixed home, a swappable home, duplication", () => {
    let doc = site();
    const a = addPage(doc, "Our team")!;
    doc = a.doc;
    const b = addPage(doc, "Our team")!;
    expect(b.slug).not.toBe(a.slug);
    doc = b.doc;
    expect(addPage(doc, "Admin")!.slug).not.toBe("admin");
    const home = doc.pages.find((p) => p.slug === "home")!;
    expect(updatePage(doc, home.id, { slug: "x" }).pages.find((p) => p.id === home.id)!.slug).toBe("home");
    const taken = updatePage(doc, b.id, { slug: a.slug }).pages.find((p) => p.id === b.id)!.slug;
    expect(taken).not.toBe(a.slug);
    const swapped = setHomePage(doc, a.id);
    expect(swapped.pages.find((p) => p.id === a.id)!.slug).toBe("home");
    expect(parseContent(swapped).ok).toBe(true);
    const copy = duplicatePage(doc, a.id)!;
    expect(copy.doc.pages.length).toBe(doc.pages.length + 1);
    expect(parseContent(copy.doc).ok).toBe(true);
    expect(removeNode(doc, home.id)).toBe(doc);
  });

  it("makes a section site-wide, shares it, and detaches it again", () => {
    const doc = site();
    const sec = firstPageSections(doc)[1];
    const shared = makeShared(doc, sec.id)!;
    expect(Object.keys(shared.doc.globals)).toContain(shared.ref);
    expect(parseContent(shared.doc).ok).toBe(true);
    const refItem = shared.doc.pages[0].items.find((i) => isRef(i) && i.ref === shared.ref)!;
    const detached = detachShared(shared.doc, refItem.id);
    expect(detached.pages[0].items.some((i) => isRef(i) && i.ref === shared.ref)).toBe(false);
    expect(parseContent(detached).ok).toBe(true);
  });

  it("enforces nesting limits when placing elements", () => {
    let doc = site();
    const sec = firstPageSections(doc)[0];
    const col = sec.columns[0];
    const card1 = newElement(doc, "card");
    doc = insertElement(doc, col.id, 0, card1);
    const card2 = newElement(doc, "card");
    doc = insertElement(doc, card1.id, 0, card2);
    const card3 = newElement(doc, "card");
    doc = insertElement(doc, card2.id, 0, card3);
    expect(canInsertElement(doc, "card", card3.id).ok).toBe(false);
    expect(canInsertElement(doc, "heading", card3.id).ok).toBe(true);
    expect(canInsertElement(doc, "heading", sec.id).ok).toBe(false);
  });
});

describe("editor history", () => {
  it("undoes, redoes and merges a burst of typing into one step", () => {
    const doc = site();
    let s = initialState(doc);
    const el = firstPageSections(doc)[0].columns.flatMap((c) => c.elements).find((e) => e.type === "heading")!;
    const t0 = 1000;
    s = reducer(s, { type: "commit", doc: setProp(s.doc, el.id, "text", "A"), coalesce: `t:${el.id}`, at: t0 });
    s = reducer(s, { type: "commit", doc: setProp(s.doc, el.id, "text", "AB"), coalesce: `t:${el.id}`, at: t0 + 300 });
    s = reducer(s, { type: "commit", doc: setProp(s.doc, el.id, "text", "ABC"), coalesce: `t:${el.id}`, at: t0 + 600 });
    expect(s.past).toHaveLength(1);
    s = reducer(s, { type: "commit", doc: setProp(s.doc, el.id, "text", "ABCD"), coalesce: `t:${el.id}`, at: t0 + 5000 });
    expect(s.past).toHaveLength(2);
    s = reducer(s, { type: "undo" });
    expect(getElement(s.doc, el.id)!.props.text).toBe("ABC");
    s = reducer(s, { type: "undo" });
    expect(getElement(s.doc, el.id)!.props.text).toBe(getElement(doc, el.id)!.props.text);
    s = reducer(s, { type: "redo" });
    expect(getElement(s.doc, el.id)!.props.text).toBe("ABC");
    // A new edit after undo discards the redo branch.
    s = reducer(s, { type: "commit", doc: setProp(s.doc, el.id, "text", "Z"), at: t0 + 9000 });
    expect(s.future).toHaveLength(0);
  });

  it("drops a selection whose node no longer exists", () => {
    const doc = site();
    let s = initialState(doc);
    const sec = firstPageSections(doc)[1];
    s = reducer(s, { type: "select", id: sec.id });
    s = reducer(s, { type: "commit", doc: removeNode(s.doc, sec.id) });
    expect(s.selection).toBeNull();
    s = reducer(s, { type: "undo" });
    expect(findNode(s.doc, sec.id)).not.toBeNull();
  });
});

describe("drop geometry", () => {
  const r = (left: number, top: number, width: number, height: number): Rect => ({ left, top, width, height });
  it("tells rows from stacks", () => {
    expect(axisOf([r(0, 0, 100, 50), r(110, 0, 100, 50)])).toBe("x");
    expect(axisOf([r(0, 0, 100, 50), r(0, 60, 100, 50)])).toBe("y");
    expect(axisOf([], "x")).toBe("x");
  });
  it("picks the slot nearest the pointer, before or after", () => {
    const stack = [r(0, 0, 200, 40), r(0, 50, 200, 40), r(0, 100, 200, 40)];
    expect(pickSlot(stack, "y", { x: 50, y: 5 })).toMatchObject({ index: 0, before: true });
    expect(pickSlot(stack, "y", { x: 50, y: 70 })).toMatchObject({ index: 2, before: false });
    expect(pickSlot(stack, "y", { x: 50, y: 400 })).toMatchObject({ index: 3, before: false });
    expect(pickSlot([], "y", { x: 0, y: 0 })).toEqual({ index: 0, ref: -1, before: true });
    const row = [r(0, 0, 100, 40), r(110, 0, 100, 40)];
    expect(pickSlot(row, "x", { x: 120, y: 10 })).toMatchObject({ index: 1, before: true });
  });
  it("draws the indicator on the right edge", () => {
    const stack = [r(0, 0, 200, 40), r(0, 50, 200, 40)];
    const line = slotLine(stack, pickSlot(stack, "y", { x: 5, y: 85 }), "y", r(0, 0, 200, 90));
    expect(line).toMatchObject({ orientation: "horizontal", y: 90, x: 0, length: 200 });
  });
  it("adjusts the index when an item moves later within its own list, and snaps widths to the grid", () => {
    expect(adjustForRemoval(3, 1, true)).toBe(2);
    expect(adjustForRemoval(1, 3, true)).toBe(1);
    expect(adjustForRemoval(3, 1, false)).toBe(3);
    expect(spanFromPixels(300, 1200)).toBe(3);
    expect(spanFromPixels(5000, 1200)).toBe(12);
    expect(spanFromPixels(1, 1200)).toBe(1);
  });
});

describe("comparing versions", () => {
  it("reports added, removed, moved and changed things in plain terms", () => {
    const a = site();
    const sec = firstPageSections(a)[1];
    const el = firstPageSections(a)[0].columns.flatMap((c) => c.elements).find((e) => e.type === "heading")!;
    let b = setProp(a, el.id, "text", "Something else entirely");
    b = moveNode(b, sec.id, b.pages[0].id, 0);
    // Remove a different element from the first section, so the edited heading's section survives.
    const other = firstPageSections(a)[0].columns.flatMap((c) => c.elements).find((e) => e.id !== el.id && e.type !== "heading")!;
    b = removeNode(b, other.id);
    const added = buildPreset(b, SECTION_PRESETS.find((p) => p.id === "faq-accordion")!)!;
    b = insertSection(b, b.pages[0].id, 1, added);
    const d = diffDocs(a, b);
    expect(d.counts.removed).toBeGreaterThan(0);
    expect(d.counts.added).toBeGreaterThan(0);
    expect(d.counts.changed).toBeGreaterThan(0);
    expect(d.counts.moved).toBeGreaterThan(0);
    expect(d.summary.join("\n")).toMatch(/Changed Heading/);
    expect(diffDocs(a, a).changes).toHaveLength(0);
  });
});

describe("the block library", () => {
  it("builds every section preset into a valid page, with unique ids", () => {
    for (const preset of SECTION_PRESETS) {
      let doc = site();
      const sec = buildPreset(doc, preset);
      expect(sec, preset.id).not.toBeNull();
      if (preset.place === "page") doc = insertSection(doc, doc.pages[0].id, doc.pages[0].items.length, sec!);
      else doc = { ...doc, [preset.place]: sec };
      // Adding the same block twice must also be safe.
      if (preset.place === "page") doc = insertSection(doc, doc.pages[0].id, 0, buildPreset(doc, preset)!);
      const parsed = parseContent(doc);
      expect(parsed.ok, `${preset.id}: ${parsed.ok ? "" : parsed.error}`).toBe(true);
      const ids = collectIds(doc);
      expect(new Set(ids).size, preset.id).toBe(ids.length);
    }
  });

  it("builds every layout and element", () => {
    let doc = site();
    for (const l of LAYOUT_PRESETS) doc = insertSection(doc, doc.pages[0].id, 0, buildLayout(doc, l));
    const col = doc.pages[0].items.filter((i): i is Section => !isRef(i))[0].columns[0];
    for (const p of ELEMENT_PRESETS) {
      const el = newElement(doc, p.type);
      const ok = canInsertElement(doc, p.type, col.id);
      if (ok.ok) doc = insertElement(doc, col.id, 0, el);
    }
    const parsed = parseContent(doc);
    expect(parsed.ok, parsed.ok ? "" : parsed.error).toBe(true);
    expect(ELEMENT_PRESETS.length).toBeGreaterThanOrEqual(20);
  });

  it("starts claim-bearing content as a prompt that blocks publishing until replaced", () => {
    let doc = buildSite("local.corner", DETAILS);
    expect(checkReadiness(doc).blockers.map((b) => b.code)).not.toContain("placeholder");
    doc = insertSection(doc, doc.pages[0].id, 1, buildPreset(doc, SECTION_PRESETS.find((p) => p.id === "testi-cards")!)!);
    const codes = checkReadiness(doc).blockers.map((b) => b.code);
    expect(codes).toContain("placeholder");
    expect(codes).toContain("testimonial_unconfirmed");
  });
});

describe("publishing checks", () => {
  it("blocks sample content, dead links, a disabled form and unconfirmed testimonials", () => {
    expect(checkReadiness(sampleSite("meridian.estate")).blockers.map((b) => b.code)).toContain("sample_content");
    const doc = site();
    const sec = firstPageSections(doc)[0];
    const btn = sec.columns.flatMap((c) => c.elements).find((e) => e.type === "button" || (e.children ?? []).some((k) => k.type === "button"));
    const target: ElementNode = btn?.type === "button" ? btn : btn!.children!.find((k) => k.type === "button")!;
    const broken = setProp(doc, target.id, "link", { label: "Go", href: "/missing" });
    expect(checkReadiness(broken).blockers.map((b) => b.code)).toContain("link_missing_page");
    const noForm = { ...doc, form: { ...doc.form, enabled: false } };
    let hasForm = false;
    eachElement(noForm, (e) => {
      if (e.type === "form") hasForm = true;
    });
    if (hasForm) expect(checkReadiness(noForm).blockers.map((b) => b.code)).toContain("form_disabled");
  });

  it("treats illustrations as acknowledgements, and as blockers when they stand in for real work", () => {
    const r = checkReadiness(site());
    const ill = r.warnings.filter((w) => w.code === "illustration_in_use");
    expect(ill.every(warningNeedsAcknowledgement)).toBe(true);
    let doc = site();
    doc = insertSection(doc, doc.pages[0].id, 1, buildPreset(doc, SECTION_PRESETS.find((p) => p.id === "gallery-grid")!)!);
    expect(checkReadiness(doc).blockers.map((b) => b.code)).toContain("illustration_as_proof");
  });
});

describe("older sites", () => {
  const v1 = {
    schemaVersion: 1, isSample: false,
    business: { name: "Old Co", tagline: "We fix it", phone: "+15125550123", email: "", address: "", hours: "" },
    brand: { primary: "#112233", accent: "#44aa88", logoAssetId: null, logoVariant: "original" },
    seo: { title: "Old Co", description: "We fix things.", ogImageAssetId: null, noindex: false },
    social: { facebook: "", instagram: "", linkedin: "", x: "", youtube: "", tiktok: "" },
    form: { enabled: true, fields: { phone: "optional", message: "required", service: "hidden" }, services: [], successMessage: "Thanks.", consentText: "I agree.", marketingOptIn: false, marketingText: "Updates" },
    footer: { note: "", poweredBy: false },
    pages: [
      { slug: "home", title: "Home", navLabel: "Home", showInNav: true, seoTitle: "", seoDescription: "", sections: [{ id: "hero-1", type: "hero", hidden: false, data: { headline: "We fix it", subheadline: "Fast and tidy." } }, { id: "services-1", type: "services", hidden: false, data: { items: [{ title: "Leaks", description: "We stop them." }] } }] },
      { slug: "contact", title: "Contact", navLabel: "Contact", showInNav: true, seoTitle: "", seoDescription: "", sections: [] },
    ],
  };
  it("are rebuilt from their own words, never lost", () => {
    const up = parseStoredContent(v1, "summit.peak");
    expect(up.ok, up.ok ? "" : up.error).toBe(true);
    if (!up.ok) return;
    expect(up.content.business.name).toBe("Old Co");
    expect(up.content.design.colors.primary).toBe("#112233");
    expect(up.content.seo.description).toBe("We fix things.");
    const text = JSON.stringify(up.content);
    expect(text).toContain("Leaks");
    expect(text).toContain("We stop them.");
    expect(upgradeLegacy(v1, "summit.peak")).toBeTruthy();
  });
  it("are refused by the strict parser unless an upgrade is supplied", () => {
    expect(parseContent(v1).ok).toBe(false);
  });
});
