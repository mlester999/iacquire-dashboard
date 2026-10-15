import { describe, expect, it } from "vitest";
import { siteCss, styleDecls } from "@/lib/website/css";
import { eachElement, parseContent, type ElementNode } from "@/lib/website/doc";
import { canvasGeometry, layerCommand } from "@/lib/website/editor/interaction";
import { initialState, reducer } from "@/lib/website/editor/state";
import { getElement, setProp, setResponsive, setStyle } from "@/lib/website/ops";
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
