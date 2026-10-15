import { describe, expect, it } from "vitest";
import { collectIds, isRef, parseContent, type Section, type SiteContent } from "@/lib/website/doc";
import { foreignAssets, sectionFromJson } from "@/lib/website/editor/paste";
import { updateSection } from "@/lib/website/ops";
import { buildSite } from "@/lib/website/templates";

const DETAILS = {
  businessName: "Paste Co", industry: "home_services", tagline: "", description: "We help.", services: [{ title: "A" }, { title: "B" }, { title: "C" }], phone: "+15125550100", email: "a@b.test", areas: ["Austin"],
  pages: ["home", "about", "contact"], primaryAction: "call",
} as const;
const OWN = "11111111-1111-4111-8111-111111111111";
const doc = (): SiteContent => buildSite("care.haven", { ...DETAILS, services: [...DETAILS.services], areas: [...DETAILS.areas], pages: [...DETAILS.pages] });
const sections = (d: SiteContent) => d.pages[0].items.filter((i): i is Section => !isRef(i));

describe("pasting a section as JSON", () => {
  it("accepts a valid section, gives it fresh ids, and can replace one on the page", () => {
    const d = doc();
    const [first, second] = sections(d);
    const r = sectionFromJson(d, JSON.stringify(second), new Set());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const used = new Set(collectIds(d));
    expect(r.section.id).not.toBe(second.id);
    const inner = collectIds({ ...d, pages: [{ ...d.pages[0], items: [r.section] }], header: null, footer: null, globals: {} });
    expect(inner.filter((i) => i !== d.pages[0].id && used.has(i))).toEqual([]);
    const replaced = updateSection(d, first.id, (old) => ({ ...r.section, id: old.id }));
    expect(sections(replaced)[0].id).toBe(first.id);
    expect(parseContent(replaced).ok).toBe(true);
  });

  it("refuses text that isn't JSON, or isn't a section", () => {
    const d = doc();
    expect(sectionFromJson(d, "not json", new Set())).toMatchObject({ ok: false, error: "That isn't valid JSON." });
    expect(sectionFromJson(d, JSON.stringify({ hello: "world" }), new Set()).ok).toBe(false);
    expect(sectionFromJson(d, JSON.stringify({ id: "s1", type: "section", columns: [{ id: "c1", elements: [{ id: "e1", type: "script", props: { src: "https://evil.test/x.js" } }] }] }), new Set()).ok).toBe(false);
  });

  it("refuses unsafe values the document model has no place for", () => {
    const d = doc();
    const section = structuredClone(sections(d)[1]);
    const heading = section.columns.flatMap((c) => c.elements).find((e) => e.type === "heading");
    if (heading) heading.props.text = "<img src=x onerror=alert(1)>";
    const r = sectionFromJson(d, JSON.stringify(section), new Set());
    // Text is data and is rendered as text; what must never happen is a way to smuggle markup in as structure.
    expect(JSON.stringify(r.ok ? r.section : {})).not.toContain("<script");
    const link = structuredClone(section);
    const button = link.columns.flatMap((c) => c.elements).find((e) => e.type === "button");
    if (button) {
      button.props.link = { label: "Go", href: "javascript:alert(1)" };
      expect(sectionFromJson(d, JSON.stringify(link), new Set()).ok).toBe(false);
    }
  });

  it("won't bring in another client's pictures", () => {
    const d = doc();
    const section = structuredClone(sections(d)[0]);
    section.bg = { kind: "image", src: { kind: "asset", id: OWN }, overlay: { color: "dark", opacity: 40, dir: "flat" }, pos: { x: 50, y: 50 }, parallax: false };
    const json = JSON.stringify(section);
    expect(foreignAssets(json, new Set())).toEqual([OWN]);
    expect(foreignAssets(json, new Set([OWN]))).toEqual([]);
    expect(sectionFromJson(d, json, new Set())).toMatchObject({ ok: false });
    expect(sectionFromJson(d, json, new Set([OWN])).ok).toBe(true);
  });
});
