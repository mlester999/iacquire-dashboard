import { describe, expect, it } from "vitest";
import { builtInCards } from "@/lib/website/gallery-data";
import { EMPTY_GALLERY_FILTERS, discoverTemplates, filterCards, type GalleryCard } from "@/lib/website/gallery";

const cards = builtInCards();
const card = (key: string, patch: Partial<GalleryCard> = {}): GalleryCard => ({ ...cards[0], key, name: key, ...patch });

describe("template discovery", () => {
  it("offers all fifty designs and never invents a featured choice", () => {
    expect(cards).toHaveLength(50);
    expect(cards.filter((c) => c.featured)).toHaveLength(0);
    const explicit = builtInCards({ featured: new Set(["meridian.estate", "luxe.maison"]) });
    expect(explicit.filter((c) => c.featured).map((c) => c.key).sort()).toEqual(["luxe.maison", "meridian.estate"]);
    expect(explicit.every((c) => Boolean(c.layout && c.typography))).toBe(true);
  });

  it("composes search, family, industry, style, theme, layout and typography", () => {
    const target = cards.find((c) => c.familyId === "luxe" && c.styles.includes("editorial"))!;
    const filtered = filterCards(cards, { q: target.name.toUpperCase(), family: target.familyId, industry: target.industries[0], style: "editorial", theme: target.mode, layout: target.layout, typography: target.typography });
    expect(filtered.map((c) => c.key)).toEqual([target.key]);
    expect(filterCards(cards, { q: target.name, theme: target.mode === "light" ? "dark" : "light" })).toHaveLength(0);
  });

  it("searches visible industry labels and requires every search word", () => {
    expect(filterCards(cards, { q: "real estate" }).every((c) => c.industries.includes("real-estate"))).toBe(true);
    expect(filterCards(cards, { q: "real estate" }).length).toBeGreaterThan(0);
    expect(filterCards(cards, { q: "estate impossibleword" })).toHaveLength(0);
    expect(filterCards(cards, { q: "   " })).toHaveLength(50);
  });

  it("honors each sort even when a preferred industry or featured set exists", () => {
    const input = [card("Zebra", { featured: true, industries: [], addedAt: "2024-01-01", updatedAt: "2025-02-01" }), card("Alpha", { featured: false, industries: ["healthcare"], addedAt: "2025-01-01", updatedAt: "2024-02-01" })];
    expect(discoverTemplates(input, { sort: "featured", preferIndustry: "healthcare" }).map((c) => c.key)).toEqual(["Zebra", "Alpha"]);
    expect(discoverTemplates(input, { sort: "name" }).map((c) => c.key)).toEqual(["Alpha", "Zebra"]);
    expect(discoverTemplates(input, { sort: "recent" }).map((c) => c.key)).toEqual(["Alpha", "Zebra"]);
    expect(discoverTemplates(input, { sort: "updated" }).map((c) => c.key)).toEqual(["Zebra", "Alpha"]);
    expect(input.map((c) => c.key)).toEqual(["Zebra", "Alpha"]);
  });

  it("clear filters restores the complete permission-scoped collection", () => {
    const permitted = cards.slice(0, 3);
    expect(filterCards(permitted, EMPTY_GALLERY_FILTERS).map((c) => c.key).sort()).toEqual(permitted.map((c) => c.key).sort());
    expect(filterCards(permitted, EMPTY_GALLERY_FILTERS)).toHaveLength(3);
  });
});
