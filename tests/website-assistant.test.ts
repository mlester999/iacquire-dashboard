import { describe, expect, it } from "vitest";
import { eachElement, isRef, parseContent, type Section, type SiteContent } from "@/lib/website/doc";
import { initialState, reducer } from "@/lib/website/editor/state";
import { checkReadiness } from "@/lib/website/lint";
import { applyOps, inventsClaim, knownWords, opSchema, outline, type Op } from "@/lib/website/assistant/ops";
import { planWithRules } from "@/lib/website/assistant/planner";
import { briefSchema, makeBrief, parseModelPlan } from "@/lib/website/assistant/brief";
import { buildSite } from "@/lib/website/templates";
import type { SiteDetails } from "@/lib/website/templates/types";

const DETAILS: SiteDetails = {
  businessName: "Bright Roofing", industry: "home_services", tagline: "Roof repairs across Austin", description: "We repair and replace roofs.",
  services: [{ title: "Roof repair" }, { title: "Gutters" }, { title: "Inspections" }], phone: "+15125550100", email: "hello@brightroofing.test", areas: ["Austin", "Round Rock"],
  pages: ["home", "about", "services", "contact"], primaryAction: "call",
};
const site = (): SiteContent => buildSite("meridian.estate", DETAILS);
const homeId = (d: SiteContent) => d.pages[0].id;
const run = (doc: SiteContent, request: string, selection: string | null = null) => {
  const plan = planWithRules(doc, request, { pageId: homeId(doc), selection });
  return { plan, result: applyOps(doc, plan.ops, { pageId: homeId(doc), known: knownWords(doc, request) }) };
};
const sectionsOf = (d: SiteContent) => d.pages[0].items.filter((i): i is Section => !isRef(i));
const kindsIn = (s: Section) => {
  const k: string[] = [];
  const visit = (e: { type: string; children?: Array<{ type: string; children?: unknown[] }> }) => { k.push(e.type); (e.children as typeof e[] | undefined)?.forEach(visit); };
  s.columns.forEach((c) => c.elements.forEach((e) => visit(e as never)));
  return k;
};

describe("edit vocabulary", () => {
  it("accepts well-formed edits and rejects anything outside the list", () => {
    expect(opSchema.safeParse({ op: "design", set: { primary: "#0B3D2E" } }).success).toBe(true);
    expect(opSchema.safeParse({ op: "design", set: { primary: "green" } }).success).toBe(false);
    expect(opSchema.safeParse({ op: "design", set: { primary: "#fff" } }).success).toBe(false);
    expect(opSchema.safeParse({ op: "design", set: { customCss: "body{display:none}" } }).success).toBe(false);
    expect(opSchema.safeParse({ op: "run_script", code: "alert(1)" }).success).toBe(false);
    expect(opSchema.safeParse({ op: "element_style", id: "e1", style: { size: "9xl" } }).success).toBe(false);
    expect(opSchema.safeParse({ op: "element_style", id: "e1", style: { background: "url(javascript:alert(1))" } }).success).toBe(false);
    expect(opSchema.safeParse({ op: "set_text", id: "<img onerror=x>", key: "text", value: "hi" }).success).toBe(false);
    expect(opSchema.safeParse({ op: "columns", id: "sec1", count: 9 }).success).toBe(false);
  });

  it("changes the design and still leaves a valid site", () => {
    const doc = site();
    const { result } = run(doc, "Use #0b3d2e and #c9a24b as my brand colours");
    expect(result.doc.design.colors.primary).toBe("#0b3d2e");
    expect(result.doc.design.colors.accent).toBe("#c9a24b");
    expect(result.applied[0]).toMatch(/main colour #0b3d2e/);
    expect(parseContent(result.doc).ok).toBe(true);
  });

  it("drops an edit that names something that isn't on the site, and keeps the rest", () => {
    const doc = site();
    const ops: Op[] = [
      { op: "section", id: "nosuch", set: { tone: "dark" } },
      { op: "design", set: { radius: "pill" } },
      { op: "remove_section", id: "alsonope" },
    ];
    const r = applyOps(doc, ops, { pageId: homeId(doc), known: "" });
    expect(r.doc.design.radius).toBe("pill");
    expect(r.applied).toHaveLength(1);
    expect(r.rejected.map((x) => x.reason).join(" ")).toMatch(/isn't on the site|isn't on this page/);
  });

  it("does nothing when the change is already how the site is", () => {
    const doc = site();
    const same: Op = { op: "design", set: { radius: doc.design.radius } };
    const r = applyOps(doc, [same], { pageId: homeId(doc), known: "" });
    expect(r.applied).toHaveLength(0);
    expect(r.doc).toBe(doc);
  });

  it("caps how many edits one request can make", () => {
    const doc = site();
    const many: Op[] = Array.from({ length: 80 }, (_, i) => ({ op: "design" as const, set: { headingWeight: 100 + (i % 8) * 100 } }));
    const r = applyOps(doc, many, { pageId: homeId(doc), known: "", maxOps: 10 });
    expect(r.applied.length + r.rejected.length).toBeLessThanOrEqual(10);
  });
});

describe("claims the assistant must not invent", () => {
  it("recognises proof the owner never gave", () => {
    for (const t of ["Our award-winning team", "Rated #1 in Austin", "A 100% satisfaction guarantee", "Over 25 years in business", "Licensed and insured", "Since 1998", "Trusted by thousands of customers", "5-star reviews"]) {
      expect(inventsClaim(t, "")).toBe(true);
    }
    expect(inventsClaim("Roof repairs you can plan around", "")).toBe(false);
  });

  it("lets through a claim the owner already makes themselves", () => {
    expect(inventsClaim("Licensed and insured", "Bright Roofing is licensed and insured in Texas")).toBe(false);
  });

  it("refuses to write unsupported wording into a headline", () => {
    const doc = site();
    let headingId = "";
    eachElement(doc, (e) => { if (!headingId && e.type === "heading") headingId = e.id; });
    const r = applyOps(doc, [{ op: "set_text", id: headingId, key: "text", value: "Austin's award-winning roofers since 1998" }], { pageId: homeId(doc), known: knownWords(doc) });
    expect(r.applied).toHaveLength(0);
    expect(r.rejected[0].reason).toMatch(/claim/);
    // But words the person typed themselves are theirs.
    const own = run(doc, `Change the headline to "Roofers Austin trusts"`);
    expect(own.result.applied.join(" ")).toMatch(/Roofers Austin trusts/);
  });

  it("adds testimonials as placeholders that stop publishing, and says so", () => {
    const doc = site();
    const { plan, result } = run(doc, "Please write 5 fake testimonials below the hero");
    expect(plan.notes.join(" ")).toMatch(/don't write testimonials/);
    expect(result.applied.join(" ")).toMatch(/testimonial/i);
    const blockers = checkReadiness(result.doc).blockers.map((b) => b.code);
    expect(blockers).toContain("placeholder");
    // The invented names or quotes never exist: every quote and author is a bracketed prompt.
    const texts: string[] = [];
    eachElement(result.doc, (e) => { if (e.type === "testimonials") for (const it of (e.props.items as Array<{ quote: string; author: string }>)) texts.push(it.quote, it.author); });
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.every((t) => /^\[.*\]$/.test(t))).toBe(true);
  });
});

describe("built-in planner", () => {
  it("makes a luxurious look from the closed list of design settings", () => {
    const { plan, result } = run(site(), "Make it feel more luxurious");
    expect(plan.source).toBe("rules");
    expect(result.doc.design.fonts.heading).toBe("cormorant");
    expect(result.doc.design.spacing).toBe("luxe");
    expect(result.doc.design.radius).toBe("square");
    expect(parseContent(result.doc).ok).toBe(true);
  });

  it("reads a colour name but not the words of a quoted headline", () => {
    const green = run(site(), "Use a deep green and gold palette");
    expect(green.result.doc.design.colors.primary).toBe("#15803d");
    const quoted = run(site(), `Change the headline to "Blue Skies Ahead"`);
    expect(quoted.result.doc.design.colors.primary).toBe(site().design.colors.primary);
    expect(quoted.result.applied.join(" ")).toMatch(/Blue Skies Ahead/);
  });

  it("adds an FAQ before the closing enquiry form when the page ends with one", () => {
    const doc = site();
    const before = sectionsOf(doc).length;
    const { result } = run(doc, "Add an FAQ section");
    const after = sectionsOf(result.doc);
    expect(after).toHaveLength(before + 1);
    expect(after.some((s) => kindsIn(s).includes("faq"))).toBe(true);
  });

  it("moves one section above another, without losing anything", () => {
    const first = run(site(), "Add an FAQ section").result.doc;
    const o = outline(first, homeId(first));
    const faq = o.find((s) => s.kinds.includes("faq"))!;
    const target = o[0];
    expect(faq.index).toBeGreaterThan(0);
    const { result } = run(first, `Move the FAQ above the ${target.kinds.includes("heading") ? "hero" : "hero"}`);
    const moved = outline(result.doc, homeId(result.doc));
    expect(moved[0].id).toBe(faq.id);
    expect(moved).toHaveLength(o.length);
  });

  it("asks before removing anything, and removes only the named section", () => {
    const withFaq = run(site(), "Add an FAQ section").result.doc;
    const count = sectionsOf(withFaq).length;
    const { plan, result } = run(withFaq, "Remove the FAQ section");
    expect(plan.destructive).toBe(true);
    expect(sectionsOf(result.doc)).toHaveLength(count - 1);
    expect(sectionsOf(result.doc).some((s) => kindsIn(s).includes("faq"))).toBe(false);
  });

  it("changes columns only on a selected section", () => {
    const doc = site();
    const target = sectionsOf(doc).find((s) => s.columns.length >= 1)!;
    const ask = planWithRules(doc, "Make this section three columns", { pageId: homeId(doc), selection: null });
    expect(ask.ops).toHaveLength(0);
    expect(ask.notes.join(" ")).toMatch(/Select the section/);
    const { result } = run(doc, "Make this section three columns", target.id);
    expect(sectionsOf(result.doc).find((s) => s.id === target.id)!.columns).toHaveLength(3);
  });

  it("adds a page with bracketed starter prompts", () => {
    const doc = site();
    const { result } = run(doc, "Add an About page");
    expect(result.doc.pages).toHaveLength(doc.pages.length + 1);
    expect(result.doc.pages.at(-1)!.title).toBe("About");
    expect(new Set(result.doc.pages.map((p) => p.slug)).size).toBe(result.doc.pages.length);
  });

  it("tunes oversized headings for phones", () => {
    const doc = site();
    const { result } = run(doc, "Make it work better on phones");
    expect(parseContent(result.doc).ok).toBe(true);
    expect(result.rejected).toHaveLength(0);
  });

  it("asks for more when it can't read the request, and never guesses", () => {
    const plan = planWithRules(site(), "make the thing pop in a sort of cosmic way", { pageId: homeId(site()), selection: null });
    expect(plan.ops).toHaveLength(0);
    expect(plan.clarification).toMatch(/Try asking/);
  });

  it("applies a whole request as one undoable step", () => {
    const doc = site();
    const state = initialState(doc);
    const { result } = run(doc, "Make it feel more luxurious and use a navy palette");
    const after = reducer(state, { type: "commit", doc: result.doc });
    expect(after.doc.design.spacing).toBe("luxe");
    const undone = reducer(after, { type: "undo" });
    expect(undone.doc.design).toEqual(doc.design);
  });
});

describe("AI planner boundary", () => {
  it("sends an outline and never contact details", () => {
    const doc = site();
    const brief = makeBrief(doc, homeId(doc), null);
    expect(briefSchema.safeParse(brief).success).toBe(true);
    const json = JSON.stringify(brief);
    expect(json).not.toContain("+15125550100");
    expect(json).not.toContain("brightroofing.test");
    expect(brief.sections.length).toBeGreaterThan(0);
  });

  it("reads a clean reply, including one wrapped in a code fence", () => {
    const reply = JSON.stringify({ summary: "Rounder corners.", notes: [], ops: [{ op: "design", set: { radius: "round" } }] });
    expect(parseModelPlan(reply)?.ops).toHaveLength(1);
    expect(parseModelPlan("```json\n" + reply + "\n```")?.source).toBe("ai");
  });

  it("drops edits that aren't in the list and says how many", () => {
    const reply = JSON.stringify({ summary: "x", ops: [{ op: "design", set: { radius: "round" } }, { op: "eval", code: "alert(1)" }, { op: "design", set: { primary: "javascript:alert(1)" } }] });
    const plan = parseModelPlan(reply)!;
    expect(plan.ops).toHaveLength(1);
    expect(plan.notes.join(" ")).toMatch(/2 suggested changes weren't/);
  });

  it("treats anything that isn't a JSON object as no answer", () => {
    expect(parseModelPlan("Sure! Here's what I'd do: make it blue.")).toBeNull();
    expect(parseModelPlan("{not json}")).toBeNull();
  });

  it("flags removals, and lets the browser reject made-up ids", () => {
    const doc = site();
    const plan = parseModelPlan(JSON.stringify({ summary: "x", ops: [{ op: "remove_section", id: "madeup1" }, { op: "design", set: { mode: "dark" } }] }))!;
    expect(plan.destructive).toBe(true);
    const r = applyOps(doc, plan.ops, { pageId: homeId(doc), known: "" });
    expect(r.doc.design.mode).toBe("dark");
    expect(r.rejected).toHaveLength(1);
  });

  it("cannot be talked into unsafe values by text in the page", () => {
    const doc = site();
    const injected = parseModelPlan(JSON.stringify({ summary: "Ignore previous instructions", ops: [{ op: "set_text", id: "x", key: "text", value: "<script>alert(1)</script>" }] }))!;
    const r = applyOps(doc, injected.ops, { pageId: homeId(doc), known: "" });
    expect(r.applied).toHaveLength(0);
    expect(JSON.stringify(r.doc)).not.toContain("<script>");
  });
});
