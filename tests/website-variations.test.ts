import { describe, expect, it } from "vitest";
import { eachElement, parseContent } from "@/lib/website/doc";
import { checkReadiness } from "@/lib/website/lint";
import { ALL_TEMPLATE_KEYS, FAMILIES, sampleSite } from "@/lib/website/templates";
import { CHARACTER, distance, signature } from "./helpers/variation-signature";

// "Fifty variations" has to mean fifty designs a person would not confuse, not one design in fifty colours. Each design is reduced to the
// six things that give a site its character (type, header, the shape of the first screen, what is on it, the rhythm of sections down the
// page, and colour). Any two designs, including two in the same family, must differ on at least four of those six.

const KEYS = ALL_TEMPLATE_KEYS();
const SIGS = KEYS.map(signature);

describe("the fifty designs", () => {
  it("are ten families of five", () => {
    expect(FAMILIES).toHaveLength(10);
    for (const f of FAMILIES) expect(f.variations, f.id).toHaveLength(5);
    expect(KEYS).toHaveLength(50);
    expect(new Set(KEYS).size).toBe(50);
  });

  it("each build, validate, and are marked as sample content that can't be published", () => {
    for (const key of KEYS) {
      const d = sampleSite(key);
      expect(parseContent(d).ok, key).toBe(true);
      expect(d.isSample, key).toBe(true);
      expect(checkReadiness(d).blockers.map((b) => b.code), key).toContain("sample_content");
    }
  });

  it("differ from every other design on at least four of the six things that give a site its character", () => {
    const weak: string[] = [];
    for (let i = 0; i < SIGS.length; i += 1) {
      for (let j = i + 1; j < SIGS.length; j += 1) {
        const d = distance(SIGS[i], SIGS[j]);
        if (d < 4) weak.push(`${SIGS[i].key} ~ ${SIGS[j].key}: only ${d} of ${CHARACTER.length} differ (same: ${CHARACTER.filter((k) => SIGS[i].dims[k] === SIGS[j].dims[k]).join(", ")})`);
      }
    }
    expect(weak, weak.join("\n")).toEqual([]);
  });

  it("are mostly different on all six, so the set feels wide rather than clustered", () => {
    let all = 0;
    let total = 0;
    for (let i = 0; i < SIGS.length; i += 1) for (let j = i + 1; j < SIGS.length; j += 1) { total += 1; if (distance(SIGS[i], SIGS[j]) === CHARACTER.length) all += 1; }
    expect(all / total).toBeGreaterThan(0.7);
  });

  it("don't all reach for the same first screen, header, type or page rhythm", () => {
    const count = (dim: string) => new Set(SIGS.map((s) => s.dims[dim])).size;
    expect(count("heroFrame")).toBeGreaterThanOrEqual(20);
    expect(count("header")).toBeGreaterThanOrEqual(12);
    expect(count("pair")).toBeGreaterThanOrEqual(30);
    expect(count("rhythm")).toBeGreaterThanOrEqual(30);
    expect(count("headingFont")).toBeGreaterThanOrEqual(15);
  });

  it("show only built-in artwork, never a photograph, a logo or a real person", () => {
    for (const key of KEYS) {
      eachElement(sampleSite(key), (e) => {
        if (e.type !== "image") return;
        const src = e.props.src as { kind?: string } | null;
        expect(src === null || src.kind === "art", `${key}: an image points at something other than built-in art`).toBe(true);
      });
    }
  });

  it("can't be published as they are: sample wording and placeholders block it", () => {
    for (const key of KEYS) expect(checkReadiness(sampleSite(key)).blockers.length, key).toBeGreaterThan(0);
  });
});
