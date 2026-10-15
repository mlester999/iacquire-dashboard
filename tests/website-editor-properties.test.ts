import { describe, expect, it } from "vitest";
import { siteCss, styleDecls } from "@/lib/website/css";
import { eachElement, parseContent, type ElementNode } from "@/lib/website/doc";
import { canvasGeometry, layerCommand } from "@/lib/website/editor/interaction";
import { initialState, reducer } from "@/lib/website/editor/state";
import { getElement, setProp, setResponsive, setStyle, updateSection } from "@/lib/website/ops";
import { sampleSite } from "@/lib/website/templates";
import { createMemoryApi, newControl } from "@/components/website/studio/memory-api";

describe("visual editor interaction", () => {
  it("keeps responsive document widths real while fitting narrow canvases safely", () => {
    expect(canvasGeometry("mobile", 390, "fit")).toEqual({ width: 390, scale: 350 / 390 });
    expect(canvasGeometry("tablet", 1000, "fit")).toEqual({ width: 768, scale: 1 });
    expect(canvasGeometry("desktop", 1600, "fit")).toEqual({ width: 1440, scale: 1 });
    expect(canvasGeometry("mobile", 390, 1)).toEqual({ width: 390, scale: 1 });
    for (const width of [0, 1, 24, Number.NaN, Number.POSITIVE_INFINITY]) {
      const frame = canvasGeometry("desktop", width, "fit");
      expect(frame.width).toBeGreaterThan(0);
      expect(frame.scale).toBeGreaterThan(0);
      expect(Number.isFinite(frame.scale)).toBe(true);
    }
  });

  it("gives keyboard section reordering precedence over layer navigation", () => {
    expect(layerCommand("ArrowUp", true)).toBe("move-up");
    expect(layerCommand("ArrowDown", true)).toBe("move-down");
    expect(layerCommand("ArrowUp", false)).toBe("previous");
    expect(layerCommand("ArrowDown", false)).toBe("next");
    expect(layerCommand("Home", false)).toBe("first");
    expect(layerCommand("End", false)).toBe("last");
    expect(layerCommand("Tab", false)).toBeNull();
  });
});

describe("contextual properties through validation, save and rendering", () => {
  it("persists heading and button typography, fills, borders and responsive styles", async () => {
    const original = sampleSite("meridian.estate");
    const nodes: ElementNode[] = [];
    eachElement(original, (el) => nodes.push(el));
    const heading = nodes.find((el) => el.type === "heading")!;
    const button = nodes.find((el) => el.type === "button")!;
    let draft = setProp(original, heading.id, "text", "Rooms with a considered point of view");
    draft = setStyle(draft, heading.id, { font: "accent", size: "6xl", weight: 600, color: "#243346", align: "center", bg: "#f4ede4", pt: "m", pb: "s" });
    draft = setResponsive(draft, heading.id, "m", { size: "3xl", align: "start", w: "full" });
    draft = setProp(draft, button.id, "link.label", "Discuss your space");
    draft = setProp(draft, button.id, "link.href", "/contact");
    draft = setStyle(draft, button.id, { font: "body", size: "lg", weight: 700, color: "#ffffff", bg: "#243346", radius: "m", border: "none", w: "fit", align: "end", hover: "lift" });
    expect(parseContent(draft).ok).toBe(true);
    expect(getElement(original, heading.id)?.props.text).not.toBe("Rooms with a considered point of view");

    const api = createMemoryApi(original, { control: newControl(), owner: true });
    expect(await api.saveDraft(draft, 1)).toMatchObject({ ok: true, revision: 2 });
    const reopened = await api.getDraft();
    if (!reopened.ok) throw new Error(reopened.error);
    const stored = reopened.data.content;
    expect(getElement(stored, heading.id)?.style).toMatchObject({ weight: 600, font: "accent", bg: "#f4ede4" });
    expect(getElement(stored, button.id)?.style).toMatchObject({ weight: 700, bg: "#243346", border: "none", w: "fit" });
    expect(getElement(stored, heading.id)?.r?.m).toEqual({ size: "3xl", align: "start", w: "full" });
    expect(getElement(stored, button.id)?.props.link).toMatchObject({ label: "Discuss your space", href: "/contact" });
    const css = siteCss(stored, stored.pages[0], { scope: "editor-properties" });
    expect(css).toContain("font-weight:600");
    expect(css).toContain("font-family:var(--f-a)");
    expect(css).toContain("background:#243346");
    expect(css).toContain("border:0");
    expect(css).toContain("@container (max-width:639px)");

    let state = initialState(original);
    state = reducer(state, { type: "select", id: heading.id });
    state = reducer(state, { type: "commit", doc: stored });
    state = reducer(state, { type: "undo" });
    expect(state.doc).toBe(original);
    expect(state.selection).toBe(heading.id);
    state = reducer(state, { type: "redo" });
    expect(state.doc).toBe(stored);
    expect(state.selection).toBe(heading.id);
  });

  it("does not accept the string weight previously emitted by the inspector", () => {
    const original = sampleSite("meridian.estate");
    const nodes: ElementNode[] = [];
    eachElement(original, (el) => nodes.push(el));
    const heading = nodes.find((el) => el.type === "heading")!;
    const invalid = setStyle(original, heading.id, { weight: "700" as unknown as number });
    expect(parseContent(invalid).ok).toBe(false);
    const valid = setStyle(original, heading.id, { weight: Number("700") });
    expect(parseContent(valid).ok).toBe(true);
  });

  it("persists a named font family and only emits its allowlisted self-hosted font variable", async () => {
    const original = sampleSite("meridian.estate");
    const nodes: ElementNode[] = [];
    eachElement(original, (el) => nodes.push(el));
    const heading = nodes.find((el) => el.type === "heading")!;
    const draft = setStyle(original, heading.id, { font: "jetbrains", weight: 600 });
    const api = createMemoryApi(original, { control: newControl(), owner: true });
    expect(await api.saveDraft(draft, 1)).toMatchObject({ ok: true });
    const reopened = await api.getDraft();
    if (!reopened.ok) throw new Error(reopened.error);
    expect(getElement(reopened.data.content, heading.id)?.style?.font).toBe("jetbrains");
    expect(siteCss(reopened.data.content, reopened.data.content.pages[0])).toContain('font-family:var(--f-jetbrains),ui-monospace, "SF Mono", Menlo, Consolas, monospace');
    for (const malicious of ["__proto__", "Arial; background:url(https://invalid.example)", "system-ui", "<script>"]) {
      expect(parseContent(setStyle(original, heading.id, { font: malicious as "jetbrains" })).ok).toBe(false);
    }
  });

  it("replaces a component gradient and border when an explicit fill or no border is selected", () => {
    expect(styleDecls({ bg: "#112233", border: "none" })).toBe("background:#112233;border:0");
    expect(styleDecls({ border: "thin", borderColor: "#112233" })).toBe("border:1px solid #112233");
    expect(styleDecls({ bg: "#112233", border: "none" }, { box: false })).toBe("");
  });
});

describe("section border, shadow and per-screen visibility", () => {
  const firstSection = (doc: ReturnType<typeof sampleSite>) => doc.pages[0].items.find((item) => item.type === "section") as Extract<ReturnType<typeof sampleSite>["pages"][number]["items"][number], { type: "section" }>;
  const ruleFor = (css: string, id: string) => css.split("}").find((chunk) => chunk.includes(`.x-${id}{`)) ?? "";

  it("adds nothing to a section that uses none of them, and parses sections saved before these existed", () => {
    const original = sampleSite("luxe.maison");
    const section = firstSection(original);
    const css = siteCss(original, original.pages[0], { scope: "plain" });
    expect(ruleFor(css, section.id)).not.toMatch(/border|box-shadow/);
    // A document written before border, shadow and hide existed has none of those keys.
    const legacy = JSON.parse(JSON.stringify(original));
    const raw = legacy.pages[0].items.find((item: { type: string }) => item.type === "section");
    delete raw.layout.border; delete raw.layout.shadow; delete raw.hide;
    const parsed = parseContent(legacy);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const reopened = firstSection(parsed.content);
      expect(reopened.layout).toMatchObject({ border: "none", shadow: "none" });
      expect(reopened.hide).toBeUndefined();
    }
  });

  it("draws a chosen border and shadow: lines above and below a full-width section, all round a panel", () => {
    const original = sampleSite("luxe.maison");
    const id = firstSection(original).id;
    const set = (patch: Record<string, unknown>) => updateSection(original, id, (s) => ({ ...s, layout: { ...s.layout, ...patch } } as typeof s));
    const fullDoc = set({ border: "thin", shadow: "m" });
    const full = siteCss(fullDoc, fullDoc.pages[0], { scope: "x" });
    expect(ruleFor(full, id)).toContain("border-block:1px solid var(--line)");
    expect(ruleFor(full, id)).toContain("box-shadow:var(--sh-m)");
    const panelDoc = set({ inset: true, border: "bold", shadow: "l" });
    const panel = siteCss(panelDoc, panelDoc.pages[0], { scope: "x" });
    expect(ruleFor(panel, id)).toContain("border:3px solid var(--line)");
    expect(ruleFor(panel, id)).not.toContain("border-block");
    expect(ruleFor(panel, id)).toContain("box-shadow:var(--sh-l)");
    for (const bad of [{ border: "huge" }, { shadow: "xl" }, { border: "1px solid red; background:url(x)" }]) expect(parseContent(set(bad)).ok).toBe(false);
  });

  it("hides a section on chosen screens only, dims it while editing, and keeps the choice through save and reopen", async () => {
    const original = sampleSite("luxe.maison");
    const id = firstSection(original).id;
    const draft = updateSection(original, id, (s) => ({ ...s, hide: { m: true, t: true } }));
    const published = siteCss(draft, draft.pages[0], { scope: "h" });
    const mobile = published.slice(published.indexOf("@container (max-width:639px)"));
    expect(mobile).toContain(`.x-${id}{display:none!important}`);
    expect(siteCss(original, original.pages[0], { scope: "h" })).not.toContain(`.x-${id}{display:none!important}`);
    const editing = siteCss(draft, draft.pages[0], { scope: "h", edit: true });
    expect(editing).toContain(`.x-${id}{opacity:.28!important`);
    expect(editing).not.toContain(`.x-${id}{display:none!important}`);
    const api = createMemoryApi(original, { control: newControl(), owner: true });
    expect(await api.saveDraft(draft, 1)).toMatchObject({ ok: true });
    const reopened = await api.getDraft();
    if (!reopened.ok) throw new Error(reopened.error);
    expect(firstSection(reopened.data.content).hide).toEqual({ m: true, t: true });
    expect(parseContent(updateSection(original, id, (s) => ({ ...s, hide: { m: "yes" as unknown as boolean } }))).ok).toBe(false);
  });
});
