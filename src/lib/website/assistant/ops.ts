// What the website assistant is allowed to do. An edit is a small piece of data from a closed list, never markup, CSS or code. Each one is
// checked against the document (do the ids exist, is every value one the editor itself offers), applied with the editor's own safe
// operations, and the whole result must still be a valid website. Anything that would not be is dropped and reported, not applied.
import { z } from "zod";
import { ANIM_PRESETS, collectIds, isRef, parseContent, SIZES, type Design, type ElementNode, type Section, type SiteContent } from "../doc";
import { ELEMENT_DEFS, SPACES } from "../catalog";
import { SECTION_PRESETS, buildPreset, pageStarter, PAGE_STARTERS, type PageStarterKind } from "../editor/library";
import { FONT_KEYS, type FontKey } from "../font-keys";
import { plainText } from "../markup";
import { addPage, getElement, getPage, getSection, insertSection, moveNode, newId, removeNode, setColumnCount, setHide, setProp, setResponsive, setStyle, updateSection } from "../ops";

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/).transform((v) => v.toLowerCase());
const id = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/);
const space = z.enum(SPACES);
const font = z.enum(FONT_KEYS as [FontKey, ...FontKey[]]);
const minH = z.enum(["auto", "40", "60", "75", "90", "100"]);
const stack = z.enum(["mobile", "tablet", "never"]);

const designSet = z.object({
  primary: hex.optional(), accent: hex.optional(),
  headingFont: font.optional(), bodyFont: font.optional(), accentFont: font.optional(),
  radius: z.enum(["square", "soft", "round", "pill"]).optional(), spacing: z.enum(["tight", "regular", "airy", "luxe"]).optional(), scale: z.enum(["compact", "regular", "grand", "display"]).optional(),
  shadow: z.enum(["none", "soft", "crisp", "dramatic"]).optional(), motion: z.enum(["none", "subtle", "smooth", "dramatic"]).optional(), mode: z.enum(["light", "dark"]).optional(),
  buttonStyle: z.enum(["solid", "outline", "gradient", "glass", "soft"]).optional(), buttonHover: z.enum(["lift", "shine", "invert", "none"]).optional(), buttonCaps: z.boolean().optional(),
  headingWeight: z.number().int().min(100).max(900).optional(), headingCaps: z.boolean().optional(), grain: z.boolean().optional(), width: z.enum(["narrow", "regular", "wide"]).optional(),
}).strict();

const elementStyle = z.object({
  size: z.enum(SIZES).optional(), weight: z.number().int().min(100).max(900).optional(), align: z.enum(["start", "center", "end"]).optional(), italic: z.boolean().optional(),
  transform: z.enum(["none", "uppercase"]).optional(), radius: z.enum(["none", "s", "m", "l", "xl", "full"]).optional(), shadow: z.enum(["none", "s", "m", "l"]).optional(),
  mt: space.optional(), mb: space.optional(), color: z.enum(["primary", "accent", "ink", "muted", "dark", "light", "onDark"]).optional(), hover: z.enum(["none", "lift", "scale", "glow", "underline"]).optional(),
}).strict();

const sectionPatch = z.object({
  tone: z.enum(["auto", "light", "dark", "brand", "accent"]).optional(),
  bg: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }),
    z.object({ kind: z.literal("color"), color: z.enum(["bg", "surface", "surface2", "primary", "accent", "dark", "primarySoft", "accentSoft"]) }),
    z.object({ kind: z.literal("gradient"), from: z.enum(["primary", "accent", "dark", "surface2"]), to: z.enum(["primary", "accent", "dark", "surface2"]), angle: z.number().int().min(0).max(360).default(135) }),
  ]).optional(),
  pt: space.optional(), pb: space.optional(), minH: minH.optional(), valign: z.enum(["start", "center", "end", "stretch"]).optional(), stack: stack.optional(),
  width: z.enum(["narrow", "regular", "wide", "full"]).optional(),
}).strict();

export const opSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("design"), set: designSet }),
  z.object({ op: z.literal("section"), id, set: sectionPatch }),
  z.object({ op: z.literal("element_style"), id, style: elementStyle }),
  z.object({ op: z.literal("set_text"), id, key: z.string().max(40), value: z.string().max(1000) }),
  z.object({ op: z.literal("add_section"), preset: z.string().max(40), afterId: id.optional(), atStart: z.boolean().optional(), pageSlug: z.string().max(40).optional() }),
  z.object({ op: z.literal("move_section"), id, afterId: id.optional(), beforeId: id.optional(), position: z.enum(["start", "end"]).optional() }),
  z.object({ op: z.literal("remove_section"), id }),
  z.object({ op: z.literal("columns"), id, count: z.number().int().min(1).max(4) }),
  z.object({ op: z.literal("hide"), id, screen: z.enum(["d", "t", "m"]), hidden: z.boolean() }),
  z.object({ op: z.literal("responsive"), id, screen: z.enum(["t", "m"]), set: z.object({ size: z.enum(SIZES).optional(), minH: minH.optional(), align: z.enum(["start", "center", "end"]).optional(), pt: space.optional(), pb: space.optional(), stack: stack.optional() }).strict() }),
  z.object({ op: z.literal("add_page"), title: z.string().min(1).max(60), starter: z.enum(PAGE_STARTERS.map((s) => s.id) as [PageStarterKind, ...PageStarterKind[]]).default("blank") }),
  z.object({ op: z.literal("animation"), id, preset: z.enum(ANIM_PRESETS) }),
]);
export type Op = z.output<typeof opSchema>;

export interface Plan {
  /** One sentence saying what this will do. */
  summary: string;
  ops: Op[];
  /** Things the person should know: what they still have to write themselves, or what was left alone. */
  notes: string[];
  /** Set when the request needs more from the person before anything can be proposed. */
  clarification?: string;
  /** Removing things always needs an explicit yes. */
  destructive: boolean;
  source: "rules" | "ai";
}

export interface ApplyResult {
  doc: SiteContent;
  applied: string[];
  rejected: Array<{ op: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// Claims: the assistant never writes proof
// ---------------------------------------------------------------------------

const CLAIM = /(?<!\w)(award[- ]?winning|best[- ]in[- ]class|best (?:in|of) (?:the )?[a-z]+|#\s?1|number[- ]one|top[- ]rated|world[- ]class|guarantee[ds]?|money[- ]back|risk[- ]free|100\s?%|certified|accredited|licen[sc]ed|insured|bonded|5[- ]star|five[- ]star|thousands of|\d[\d,]*\+?\s+(?:years?|customers|clients|patients|homes|projects|reviews)|since\s+(?:19|20)\d{2}|testimonials?|reviews? from)(?!\w)/i;

/** Whether copy the assistant wrote makes a claim nobody gave it. Words the owner already uses on their own site are theirs to keep. */
export function inventsClaim(text: string, known: string): boolean {
  const m = CLAIM.exec(text);
  return Boolean(m) && !known.toLowerCase().includes(m![0].toLowerCase());
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

function applyDesign(doc: SiteContent, s: z.output<typeof designSet>): { doc: SiteContent; says: string[] } {
  const next: Design = { ...doc.design, colors: { ...doc.design.colors }, fonts: { ...doc.design.fonts }, heading: { ...doc.design.heading }, buttons: { ...doc.design.buttons } };
  const says: string[] = [];
  if (s.primary) { next.colors.primary = s.primary; says.push(`main colour ${s.primary}`); }
  if (s.accent) { next.colors.accent = s.accent; says.push(`accent colour ${s.accent}`); }
  if (s.headingFont) { next.fonts.heading = s.headingFont; says.push("heading font"); }
  if (s.bodyFont) { next.fonts.body = s.bodyFont; says.push("body font"); }
  if (s.accentFont) { next.fonts.accent = s.accentFont; says.push("accent font"); }
  if (s.radius) { next.radius = s.radius; says.push(`${s.radius} corners`); }
  if (s.spacing) { next.spacing = s.spacing; says.push(`${s.spacing} spacing`); }
  if (s.scale) { next.scale = s.scale; says.push(`${s.scale} text size`); }
  if (s.shadow) { next.shadow = s.shadow; says.push(`${s.shadow} shadows`); }
  if (s.motion) { next.motion = s.motion; says.push(`${s.motion} motion`); }
  if (s.grain !== undefined) { next.grain = s.grain; says.push(s.grain ? "film grain on" : "film grain off"); }
  if (s.width) { next.width = s.width; says.push(`${s.width} content width`); }
  if (s.buttonStyle) { next.buttons.style = s.buttonStyle; says.push(`${s.buttonStyle} buttons`); }
  if (s.buttonHover) next.buttons.hover = s.buttonHover;
  if (s.buttonCaps !== undefined) { next.buttons.caps = s.buttonCaps; says.push(s.buttonCaps ? "capital-letter buttons" : "normal-case buttons"); }
  if (s.headingWeight) { next.heading.weight = s.headingWeight; says.push(`heading weight ${s.headingWeight}`); }
  if (s.headingCaps !== undefined) { next.heading.transform = s.headingCaps ? "uppercase" : "none"; says.push(s.headingCaps ? "capital-letter headings" : "normal-case headings"); }
  if (s.mode) { next.mode = s.mode; says.push(`${s.mode} mode`); }
  const changed = JSON.stringify(next) !== JSON.stringify(doc.design);
  return { doc: changed ? { ...doc, design: next } : doc, says: changed ? says : [] };
}

/** Where a section sits on a page. Shared sections are found by the section they point at. */
const pageIndexOf = (doc: SiteContent, pageId: string, sectionId: string): number =>
  getPage(doc, pageId)?.items.findIndex((i) => i.id === sectionId || (isRef(i) && doc.globals[i.ref]?.id === sectionId)) ?? -1;

const sectionLabel = (doc: SiteContent, sid: string) => {
  const name = getSection(doc, sid)?.name;
  return name ? `“${name}” section` : "section";
};

/**
 * Applies edits to a document. `pageId` is the page the person is looking at (new sections go there). `known` is every word the owner has
 * already used, so copy is only ever checked against claims that did not come from them. Each edit is applied on its own and the whole
 * site is re-validated after it, so one bad edit never takes the others down.
 */
export function applyOps(input: SiteContent, ops: Op[], opts: { pageId: string; known: string; maxOps?: number }): ApplyResult {
  let doc = input;
  const applied: string[] = [];
  const rejected: ApplyResult["rejected"] = [];
  const no = (op: Op, reason: string): null => {
    rejected.push({ op: op.op, reason });
    return null;
  };
  for (const op of ops.slice(0, opts.maxOps ?? 40)) {
    const before = doc;
    const line = ((): string | null => {
      switch (op.op) {
        case "design": {
          const r = applyDesign(doc, op.set);
          if (r.says.length === 0) return no(op, "That is already how the site is set up.");
          doc = r.doc;
          return `Changed the design: ${r.says.join(", ")}.`;
        }
        case "section": {
          if (!getSection(doc, op.id)) return no(op, "That section isn't on the site.");
          const { bg, tone, pt, pb, minH: mh, valign, stack: st, width } = op.set;
          const label = sectionLabel(doc, op.id);
          doc = updateSection(doc, op.id, (s) => ({
            ...s, ...(tone ? { tone } : {}), ...(bg ? { bg } : {}),
            layout: { ...s.layout, ...(pt ? { pt } : {}), ...(pb ? { pb } : {}), ...(mh ? { minH: mh } : {}), ...(valign ? { valign } : {}), ...(st ? { stack: st } : {}), ...(width ? { width } : {}) },
          }));
          return `Restyled the ${label}.`;
        }
        case "element_style": {
          const el = getElement(doc, op.id);
          if (!el) return no(op, "That item isn't on the site.");
          doc = setStyle(doc, op.id, op.style);
          return `Restyled a ${el.type}.`;
        }
        case "set_text": {
          const el = getElement(doc, op.id);
          if (!el) return no(op, "That item isn't on the site.");
          const bare = op.key.replace(/\.label$/, "");
          const field = ELEMENT_DEFS[el.type].fields.find((f) => f.key === bare);
          if (!field || (field.type !== "text" && field.type !== "longtext" && field.type !== "markup" && field.type !== "link")) return no(op, "That text can't be changed this way.");
          const max = field.type === "link" ? 60 : field.max;
          const value = op.value.replace(/[ \t]+\n/g, "\n").trim().slice(0, max);
          if (!value) return no(op, "There was no wording to put there.");
          if (inventsClaim(value, opts.known)) return no(op, "That wording makes a claim (a number, award, guarantee or review) the owner hasn't given us, so it wasn't added.");
          doc = setProp(doc, op.id, field.type === "link" ? `${field.key}.label` : field.key, value);
          return `Rewrote ${el.type === "button" ? "a button label" : `a ${el.type}`}: “${plainText(value).slice(0, 50)}”.`;
        }
        case "add_section": {
          const preset = SECTION_PRESETS.find((p) => p.id === op.preset);
          if (!preset || preset.place !== "page") return no(op, "I don't have a section like that.");
          const page = op.pageSlug ? doc.pages.find((p) => p.slug === op.pageSlug) : getPage(doc, opts.pageId);
          if (!page) return no(op, "That page doesn't exist.");
          const sec = buildPreset(doc, preset);
          if (!sec) return no(op, "That section couldn't be built.");
          const at = op.afterId ? pageIndexOf(doc, page.id, op.afterId) : -1;
          doc = insertSection(doc, page.id, op.atStart ? 0 : at >= 0 ? at + 1 : page.items.length, sec);
          return `Added a “${preset.label}” section${page.id === opts.pageId ? "" : ` to ${page.title}`}.`;
        }
        case "move_section": {
          const page = getPage(doc, opts.pageId);
          const from = pageIndexOf(doc, opts.pageId, op.id);
          if (!page || from < 0) return no(op, "That section isn't on this page.");
          const moving = page.items[from];
          const others = page.items.filter((i) => i.id !== moving.id);
          let index = others.length;
          if (op.position === "start") index = 0;
          else if (op.beforeId || op.afterId) {
            const target = (op.beforeId ?? op.afterId)!;
            const at = others.findIndex((i) => i.id === target || (isRef(i) && doc.globals[i.ref]?.id === target));
            if (at < 0) return no(op, "I couldn't find where to put it.");
            index = op.beforeId ? at : at + 1;
          }
          const label = sectionLabel(doc, op.id);
          doc = moveNode(doc, moving.id, page.id, index);
          return doc === before ? no(op, "That section is already there.") : `Moved the ${label}.`;
        }
        case "remove_section": {
          const page = getPage(doc, opts.pageId);
          const at = pageIndexOf(doc, opts.pageId, op.id);
          if (!page || at < 0) return no(op, "That section isn't on this page.");
          const label = sectionLabel(doc, op.id);
          doc = removeNode(doc, page.items[at].id);
          return `Removed the ${label}.`;
        }
        case "columns": {
          if (!getSection(doc, op.id)) return no(op, "That section isn't on the site.");
          const used = new Set(collectIds(doc));
          const label = sectionLabel(doc, op.id);
          doc = setColumnCount(doc, op.id, op.count, () => ({ id: newId(used, "c"), span: 12, gap: "s", pad: "0", surface: "none", elements: [] }));
          return `Set the ${label} to ${op.count} column${op.count === 1 ? "" : "s"}.`;
        }
        case "hide": {
          const el = getElement(doc, op.id);
          if (!el) return no(op, "That item isn't on the site.");
          doc = setHide(doc, op.id, op.screen, op.hidden);
          return `${op.hidden ? "Hid" : "Showed"} a ${el.type} on ${op.screen === "d" ? "desktop" : op.screen === "t" ? "tablets" : "phones"}.`;
        }
        case "responsive": {
          const { minH: mh, stack: st, size, align, ...shared } = op.set;
          if (getSection(doc, op.id)) {
            const label = sectionLabel(doc, op.id);
            const patch = { ...shared, ...(mh ? { minH: mh } : {}), ...(st ? { stack: st } : {}) };
            doc = updateSection(doc, op.id, (s) => ({ ...s, r: { ...(s.r ?? {}), [op.screen]: { ...(s.r?.[op.screen] ?? {}), ...patch } } }));
            return `Tuned the ${label} for ${op.screen === "t" ? "tablets" : "phones"}.`;
          }
          const el = getElement(doc, op.id);
          if (!el) return no(op, "That item isn't on the site.");
          doc = setResponsive(doc, op.id, op.screen, { ...shared, ...(size ? { size } : {}), ...(align ? { align } : {}) });
          return `Tuned a ${el.type} for ${op.screen === "t" ? "tablets" : "phones"}.`;
        }
        case "add_page": {
          const kind = PAGE_STARTERS.find((s) => s.id === op.starter)?.kind ?? "page";
          const r = addPage(doc, op.title, pageStarter(doc, op.starter, op.title), kind);
          if (!r) return no(op, "The site already has the most pages it can hold.");
          doc = r.doc;
          return `Added the page “${op.title}”.`;
        }
        case "animation": {
          if (!getSection(doc, op.id)) return no(op, "That section isn't on the site.");
          const label = sectionLabel(doc, op.id);
          doc = updateSection(doc, op.id, (s: Section) => ({ ...s, anim: { ...s.anim, preset: op.preset } }));
          return op.preset === "none" ? `Turned off the entrance animation on the ${label}.` : `The ${label} now animates in (${op.preset}).`;
        }
      }
    })();
    if (line === null || doc === before) {
      doc = before;
      continue;
    }
    // The whole site must still be valid after each edit; an edit that would break it is dropped.
    const check = parseContent(doc);
    if (!check.ok) {
      doc = before;
      no(op, `That would have broken the site (${check.error}).`);
      continue;
    }
    doc = check.content;
    applied.push(line);
  }
  return { doc, applied, rejected };
}

/** Every word the owner has put on their own site, so the assistant can tell their claims from its own. */
export function knownWords(doc: SiteContent, extra = ""): string {
  const parts: string[] = [extra, doc.business.name, doc.business.tagline, doc.seo.description, doc.business.hours, doc.business.areas.join(" ")];
  const read = (v: unknown) => {
    if (typeof v === "string") parts.push(v);
    else if (Array.isArray(v)) v.forEach(read);
    else if (v && typeof v === "object") Object.values(v).forEach(read);
  };
  const visit = (e: ElementNode) => {
    read(e.props);
    e.children?.forEach(visit);
  };
  const sec = (s: Section) => s.columns.forEach((c) => c.elements.forEach(visit));
  doc.pages.forEach((p) => p.items.forEach((i) => !isRef(i) && sec(i)));
  Object.values(doc.globals).forEach(sec);
  return parts.join(" ");
}

/** A flat outline of one page the planner can reason about: which sections exist and what is in them. */
export interface OutlineSection { id: string; name: string; kinds: string[]; headline: string; index: number }
export function outline(doc: SiteContent, pageId: string): OutlineSection[] {
  const page = getPage(doc, pageId);
  if (!page) return [];
  return page.items.flatMap((item, index): OutlineSection[] => {
    const s = isRef(item) ? doc.globals[item.ref] : item;
    if (!s) return [];
    const kinds: string[] = [];
    let headline = "";
    const visit = (e: ElementNode) => {
      kinds.push(e.type);
      if (!headline && e.type === "heading" && typeof e.props.text === "string") headline = plainText(e.props.text);
      e.children?.forEach(visit);
    };
    s.columns.forEach((c) => c.elements.forEach(visit));
    return [{ id: s.id, name: s.name, kinds, headline, index }];
  });
}
