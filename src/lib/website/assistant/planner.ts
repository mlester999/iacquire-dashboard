// The assistant's built-in planner. It reads a plain-English request and turns it into the same closed list of edits the AI planner uses,
// with no network and no model. It only does what it can read clearly; anything else comes back as a question, never a guess.
import { isRef, SIZES, type ElementNode, type Section, type SiteContent } from "../doc";
import { getElement, getPage, sectionOf } from "../ops";
import { outline, type Op, type OutlineSection, type Plan } from "./ops";

const words = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9#'"\s-]/g, " ").replace(/\s+/g, " ").trim();
/** What was asked for, without the words the person quoted: a headline that says "Blue Skies" is not a request for blue. */
const stripQuotes = (s: string) => s.replace(/["“][^"”]*["”]/g, " ").replace(/(^|\s)['‘][^'’]*['’](?=\s|$|[.,!?])/g, " ");
const any = (text: string, list: string[]) => list.some((w) => new RegExp(`(?:^|[^a-z])${w}(?:[^a-z]|$)`).test(text));

const COLOURS: Array<{ words: string[]; name: string; primary: string; accent: string }> = [
  { words: ["navy"], name: "navy", primary: "#1e3a8a", accent: "#c9a24b" },
  { words: ["blue"], name: "blue", primary: "#1d4ed8", accent: "#0ea5e9" },
  { words: ["forest", "dark green"], name: "forest green", primary: "#14532d", accent: "#c9a24b" },
  { words: ["green"], name: "green", primary: "#15803d", accent: "#84cc16" },
  { words: ["teal", "turquoise"], name: "teal", primary: "#0f766e", accent: "#f59e0b" },
  { words: ["burgundy", "maroon", "wine"], name: "burgundy", primary: "#7f1d1d", accent: "#c9a24b" },
  { words: ["red"], name: "red", primary: "#b91c1c", accent: "#f59e0b" },
  { words: ["orange"], name: "orange", primary: "#ea580c", accent: "#0f172a" },
  { words: ["purple", "violet"], name: "purple", primary: "#6d28d9", accent: "#f472b6" },
  { words: ["pink"], name: "pink", primary: "#db2777", accent: "#7c3aed" },
  { words: ["gold", "golden"], name: "gold", primary: "#a16207", accent: "#1f2937" },
  { words: ["yellow"], name: "yellow", primary: "#ca8a04", accent: "#1f2937" },
  { words: ["brown", "earthy", "terracotta"], name: "earthy brown", primary: "#7c4a2d", accent: "#d4a373" },
  { words: ["black", "monochrome"], name: "black and white", primary: "#111827", accent: "#6b7280" },
  { words: ["grey", "gray", "charcoal", "slate"], name: "slate", primary: "#334155", accent: "#0ea5e9" },
];

/** Section kinds the assistant can add, the preset that builds each, and whether it carries claims only the owner can supply. */
const ADDABLE: Array<{ words: string[]; preset: string; label: string; proof: boolean }> = [
  { words: ["testimonial", "testimonials", "review", "reviews", "social proof"], preset: "testi-cards", label: "testimonials", proof: true },
  { words: ["faq", "faqs", "frequently asked questions", "questions"], preset: "faq-accordion", label: "FAQ", proof: false },
  { words: ["pricing", "prices", "price list", "plans", "packages"], preset: "pricing", label: "pricing", proof: true },
  { words: ["gallery", "photos", "portfolio", "images"], preset: "gallery-grid", label: "gallery", proof: false },
  { words: ["team", "staff", "our people", "meet the team"], preset: "team-cards", label: "team", proof: true },
  { words: ["process", "how it works", "steps", "timeline"], preset: "process-timeline", label: "process", proof: false },
  { words: ["stats", "statistics", "numbers", "figures", "results"], preset: "stats-row", label: "numbers", proof: true },
  { words: ["call to action", "cta"], preset: "cta-band", label: "call to action", proof: false },
  { words: ["quick lead form", "lead form", "enquiry form", "contact form", "sign up form", "form"], preset: "lead-band", label: "enquiry form", proof: false },
  { words: ["contact section", "contact details", "contact"], preset: "contact-split", label: "contact", proof: false },
  { words: ["services", "service cards", "what we do"], preset: "svc-icons", label: "services", proof: false },
  { words: ["about", "our story", "about us"], preset: "about-split", label: "about", proof: false },
  { words: ["logos", "partners", "logo strip", "trusted by"], preset: "logos", label: "logo strip", proof: true },
  { words: ["benefits", "why choose us", "why us"], preset: "benefits-cards", label: "benefits", proof: false },
  { words: ["video"], preset: "video", label: "video", proof: false },
];

const STEPS = { scale: ["compact", "regular", "grand", "display"], spacing: ["tight", "regular", "airy", "luxe"] } as const;
const step = <T extends string>(list: readonly T[], cur: T, by: 1 | -1): T => list[Math.max(0, Math.min(list.length - 1, list.indexOf(cur) + by))];

/** Finds the section on this page a short phrase refers to ("the FAQ", "contact form", "hero", "pricing"). */
function find(o: OutlineSection[], phrase: string): OutlineSection | null {
  const p = words(phrase).replace(/\bthe\b|\bsection\b|\bblock\b|\bpart\b/g, "").trim();
  if (!p) return null;
  const by = (kinds: string[]) => o.find((s) => kinds.some((k) => s.kinds.includes(k)));
  if (any(p, ["hero", "banner", "top", "header image", "intro"])) return o[0] ?? null;
  if (any(p, ["faq", "faqs", "questions"])) return by(["faq"]) ?? null;
  if (any(p, ["testimonial", "testimonials", "reviews"])) return by(["testimonials"]) ?? null;
  if (any(p, ["pricing", "prices", "plans"])) return by(["pricing"]) ?? null;
  if (any(p, ["gallery", "photos", "portfolio"])) return by(["gallery", "collage"]) ?? null;
  if (any(p, ["team", "staff"])) return by(["team"]) ?? null;
  if (any(p, ["services", "service"])) return by(["services"]) ?? null;
  if (any(p, ["process", "steps", "how it works"])) return by(["steps"]) ?? null;
  if (any(p, ["stats", "numbers", "figures"])) return by(["stats"]) ?? null;
  if (any(p, ["contact", "form", "enquiry", "contact form", "enquiry form", "lead form"])) return by(["form"]) ?? null;
  if (any(p, ["logos", "partners"])) return by(["logos"]) ?? null;
  if (any(p, ["call to action", "cta"])) return [...o].reverse().find((s) => s.kinds.includes("button") && !s.kinds.includes("form")) ?? null;
  const named = o.find((s) => s.name && words(s.name).includes(p)) ?? o.find((s) => s.headline && words(s.headline).includes(p));
  return named ?? null;
}

const firstOf = (s: Section | null, type: string): ElementNode | null => {
  let hit: ElementNode | null = null;
  const visit = (e: ElementNode) => {
    if (!hit && e.type === type) hit = e;
    e.children?.forEach(visit);
  };
  s?.columns.forEach((c) => c.elements.forEach(visit));
  return hit;
};

function eachPageSection(doc: SiteContent, pageId: string, visit: (s: Section) => void) {
  for (const item of getPage(doc, pageId)?.items ?? []) {
    const s = isRef(item) ? doc.globals[item.ref] : item;
    if (s) visit(s);
  }
}

const SUGGESTIONS = [
  "Make it feel more luxurious",
  "Use a deep green and gold palette",
  "Add an FAQ section",
  "Add testimonials below the hero",
  "Move the contact form above the FAQ",
  "Make the corners rounder",
  "Make this section two columns (select a section first)",
  "Make it work better on phones",
  "Add an About page",
];

export interface PlanContext { pageId: string; selection: string | null }

export function planWithRules(doc: SiteContent, request: string, ctx: PlanContext): Plan {
  const text = words(stripQuotes(request));
  const ops: Op[] = [];
  const says: string[] = [];
  const notes: string[] = [];
  let destructive = false;
  const o = outline(doc, ctx.pageId);
  const selected = ctx.selection ? sectionOf(doc, ctx.selection) : null;
  const d = doc.design;

  // ----- Colour -----
  const hexes = [...request.matchAll(/#([0-9a-f]{3}|[0-9a-f]{6})\b/gi)].map((m) => {
    const h = m[1].toLowerCase();
    return `#${h.length === 3 ? [...h].map((c) => c + c).join("") : h}`;
  });
  if (hexes.length) {
    ops.push({ op: "design", set: { primary: hexes[0], ...(hexes[1] ? { accent: hexes[1] } : {}) } });
    says.push(`use ${hexes.slice(0, 2).join(" and ")} as your brand colours`);
  } else {
    const hit = COLOURS.find((c) => c.words.some((w) => any(text, [w])));
    if (hit && !/background/.test(text)) {
      ops.push({ op: "design", set: { primary: hit.primary, accent: hit.accent } });
      says.push(`use a ${hit.name} palette`);
    } else if (any(text, ["brand colours", "brand colors", "my colours", "my colors", "our colours", "our colors"])) {
      notes.push("Tell me the colours as a name (like “deep green”) or a code (like #1b4332) and I'll apply them.");
    }
  }

  // ----- Look and feel -----
  if (any(text, ["luxury", "luxurious", "premium", "elegant", "high-end", "high end", "upscale", "refined", "sophisticated", "exclusive"])) {
    ops.push({ op: "design", set: { headingFont: "cormorant", bodyFont: "jost", radius: "square", spacing: "luxe", scale: "grand", shadow: "soft", buttonStyle: "outline", buttonCaps: true, headingWeight: 500, headingCaps: false, motion: "smooth" } });
    says.push("give the design a quieter, more luxurious feel");
  } else if (any(text, ["modern", "clean", "minimal", "minimalist", "simple", "sleek"])) {
    ops.push({ op: "design", set: { headingFont: "manrope", bodyFont: "inter", radius: "soft", spacing: "airy", shadow: "none", buttonStyle: "solid", buttonCaps: false, headingWeight: 700 } });
    says.push("make the design cleaner and more modern");
  } else if (any(text, ["bold", "punchy", "energetic", "striking", "loud", "dramatic"])) {
    ops.push({ op: "design", set: { headingFont: "bricolage", bodyFont: "dmsans", radius: "round", scale: "grand", buttonStyle: "solid", buttonHover: "lift", headingWeight: 800, shadow: "crisp", motion: "dramatic" } });
    says.push("make the design bolder");
  } else if (any(text, ["friendly", "warm", "approachable", "welcoming", "cosy", "cozy", "playful"])) {
    ops.push({ op: "design", set: { headingFont: "fraunces", bodyFont: "figtree", radius: "round", spacing: "regular", buttonStyle: "solid", headingWeight: 600, shadow: "soft" } });
    says.push("make the design warmer and friendlier");
  } else if (any(text, ["professional", "corporate", "trustworthy", "serious", "established"])) {
    ops.push({ op: "design", set: { headingFont: "jakarta", bodyFont: "inter", radius: "soft", shadow: "crisp", spacing: "regular", buttonStyle: "solid", headingWeight: 700 } });
    says.push("make the design more professional");
  }
  if (any(text, ["dark mode", "dark theme", "dark site", "go dark", "make it dark", "darker"])) { ops.push({ op: "design", set: { mode: "dark" } }); says.push("switch to dark mode"); }
  else if (any(text, ["light mode", "light theme", "go light", "make it light", "lighter background"])) { ops.push({ op: "design", set: { mode: "light" } }); says.push("switch to light mode"); }
  if (any(text, ["rounder", "more rounded", "rounded", "softer corners", "round corners"])) { ops.push({ op: "design", set: { radius: any(text, ["pill", "pills"]) ? "pill" : "round" } }); says.push("round the corners"); }
  else if (any(text, ["sharper", "square corners", "squarer", "sharp corners", "no rounded"])) { ops.push({ op: "design", set: { radius: "square" } }); says.push("square off the corners"); }
  if (any(text, ["bigger text", "larger text", "bigger headings", "larger headings", "bigger type", "text bigger", "more impact"])) { ops.push({ op: "design", set: { scale: step(STEPS.scale, d.scale, 1) } }); says.push("make the type larger"); }
  else if (any(text, ["smaller text", "smaller headings", "smaller type", "text smaller"])) { ops.push({ op: "design", set: { scale: step(STEPS.scale, d.scale, -1) } }); says.push("make the type smaller"); }
  if (any(text, ["more space", "more breathing room", "airier", "more whitespace", "more white space", "less cramped", "roomier"])) { ops.push({ op: "design", set: { spacing: step(STEPS.spacing, d.spacing, 1) } }); says.push("add more breathing room"); }
  else if (any(text, ["tighter", "more compact", "less space", "less whitespace", "denser"])) { ops.push({ op: "design", set: { spacing: step(STEPS.spacing, d.spacing, -1) } }); says.push("tighten the spacing"); }
  if (any(text, ["no grain", "remove grain", "remove the grain", "without grain", "no film grain"])) { ops.push({ op: "design", set: { grain: false } }); says.push("remove the film grain"); }
  else if (any(text, ["film grain", "grain", "textured"])) { ops.push({ op: "design", set: { grain: true } }); says.push("add a subtle film grain"); }
  if (any(text, ["no animation", "no animations", "stop animations", "remove animations", "reduce motion", "less motion", "calmer", "static"])) {
    ops.push({ op: "design", set: { motion: "none" } });
    eachPageSection(doc, ctx.pageId, (s) => { if (s.anim.preset !== "none") ops.push({ op: "animation", id: s.id, preset: "none" }); });
    says.push("turn the animation off");
  } else if (any(text, ["animate", "animation", "animations", "more motion", "movement", "come to life"])) {
    ops.push({ op: "design", set: { motion: "smooth" } });
    o.forEach((s, i) => ops.push({ op: "animation", id: s.id, preset: i === 0 ? "fade" : "up" }));
    says.push("animate sections in as they appear");
    notes.push("Animations switch off automatically for visitors who ask their device for reduced motion.");
  }

  // ----- Rewriting -----
  const quoted = /(headline|heading|title|subheading|button(?: text| label)?)[^"“'‘]{0,40}\b(?:to|as|say|read)\b[^"“'‘]{0,12}["“'‘]([^"”’]{2,200})["”’]/i.exec(request);
  if (quoted) {
    const kind = quoted[1].toLowerCase();
    const scope = selected ?? (o[0] ? sectionOf(doc, o[0].id) : null);
    const wantType = kind.startsWith("button") ? "button" : kind === "subheading" ? "text" : "heading";
    const picked = ctx.selection ? getElement(doc, ctx.selection) : null;
    const target = picked?.type === wantType ? picked : firstOf(scope, wantType);
    if (target) {
      ops.push({ op: "set_text", id: target.id, key: target.type === "button" ? "link" : "text", value: quoted[2].trim() });
      says.push(`change ${target.type === "button" ? "the button" : target.type === "text" ? "the subheading" : "the headline"} to “${quoted[2].trim().slice(0, 40)}”`);
    } else notes.push("I couldn't find a headline or button to change. Select it and ask again.");
  }

  // ----- Moving and removing -----
  const move = /\b(?:(?:move|shift)\s+(?:the\s+)?|(?:put|place)\s+the\s+)(.+?)\s+(above|before|below|after|under|to the top|to the bottom|to the end|to the start)\b\s*(?:the\s+)?(.*)$/.exec(text);
  if (move) {
    const subject = find(o, move[1]);
    const where = move[2];
    if (!subject) notes.push(`I couldn't find “${move[1].trim()}” on this page.`);
    else if (where === "to the top" || where === "to the start") { ops.push({ op: "move_section", id: subject.id, position: "start" }); says.push(`move ${move[1].trim()} to the top`); }
    else if (where === "to the bottom" || where === "to the end") { ops.push({ op: "move_section", id: subject.id, position: "end" }); says.push(`move ${move[1].trim()} to the bottom`); }
    else {
      const anchor = find(o, move[3]);
      if (!anchor) notes.push(`I couldn't find “${move[3].trim()}” on this page, so I didn't move anything.`);
      else if (anchor.id === subject.id) notes.push("That is the same section, so there is nothing to move.");
      else {
        ops.push(where === "above" || where === "before" ? { op: "move_section", id: subject.id, beforeId: anchor.id } : { op: "move_section", id: subject.id, afterId: anchor.id });
        says.push(`move ${move[1].trim()} ${where === "above" || where === "before" ? "above" : "below"} ${move[3].trim()}`);
      }
    }
  }
  const remove = /\b(?:remove|delete|get rid of|take out|drop)\s+(?:the\s+)?(.+?)(?:\s+(?:section|block|part))?$/.exec(text);
  if (remove && !move && !any(remove[1], ["animation", "animations", "grain", "film grain", "motion"])) {
    const target = find(o, remove[1]);
    if (!target) notes.push(`I couldn't find “${remove[1].trim()}” on this page.`);
    else { ops.push({ op: "remove_section", id: target.id }); says.push(`remove the ${remove[1].trim()} section`); destructive = true; }
  }

  // ----- Adding -----
  const adding = /\b(add|include|insert|create|need|want|put in|show|build|new|write|generate|draft|give me|get me)\b/.test(text) && !(remove && !any(remove[1], ["animation", "animations", "grain", "film grain", "motion"])) && !move;
  const wantsPage = /\b(add|create|make|new)\s+(?:a |an |the )?(.{2,40}?)\s+page\b/.exec(text);
  if (wantsPage) {
    const title = wantsPage[2].replace(/\b(new|another)\b/g, "").trim();
    const starter = any(title, ["about", "story"]) ? "about" : any(title, ["service", "services"]) ? "services" : any(title, ["faq", "faqs"]) ? "faq" : any(title, ["contact"]) ? "contact" : any(title, ["landing"]) ? "landing" : any(title, ["thank", "thanks", "thank you"]) ? "thanks" : "blank";
    if (title) {
      ops.push({ op: "add_page", title: title.replace(/\b\w/g, (c) => c.toUpperCase()), starter });
      says.push(`add a ${title} page`);
      notes.push("The new page starts with bracketed prompts where only you can supply the words. They stop publishing until you replace them.");
    }
  } else if (adding) {
    const lastIsForm = o.length > 1 && o[o.length - 1].kinds.includes("form");
    const place = (): { afterId?: string } => {
      const below = /\b(?:below|after|under)\s+(?:the\s+)?(.+)$/.exec(text);
      const above = /\b(?:above|before)\s+(?:the\s+)?(.+)$/.exec(text);
      if (below) { const a = find(o, below[1]); if (a) return { afterId: a.id }; }
      if (above) { const a = find(o, above[1]); if (a) { const prev = o[a.index - 1] ?? null; return prev ? { afterId: prev.id } : {}; } }
      if (/\bat the (?:top|start)\b/.test(text)) return {};
      return lastIsForm ? { afterId: o[o.length - 2].id } : {};
    };
    const seen = new Set<string>();
    for (const kind of ADDABLE) {
      if (!any(text, kind.words) || seen.has(kind.preset)) continue;
      // "contact form" must not also add a contact section, "faq" must not also add a generic questions block, and so on.
      if (kind.preset === "contact-split" && any(text, ["form", "enquiry form", "contact form"])) continue;
      if (kind.preset === "lead-band" && seen.has("contact-split")) continue;
      seen.add(kind.preset);
      const p = place();
      ops.push({ op: "add_section", preset: kind.preset, ...p, ...(/\bat the (?:top|start)\b/.test(text) ? { atStart: true } : {}) });
      says.push(`add ${/^(faq|enquiry|about)/i.test(kind.label) ? "an" : "a"} ${kind.label} section`);
      if (kind.proof) notes.push(`The ${kind.label} section uses [bracketed] prompts. Replace them with real, approved details; the site can't be published while they remain.`);
      if (kind.label === "testimonials" && /\b(write|make up|invent|fake|generate|create)\b[^.]*\b(testimonial|testimonials|review|reviews)\b/.test(text)) {
        notes.push("I don't write testimonials or reviews for you. Only add words your real customers have said and agreed to share.");
      }
    }
  }

  // ----- Columns -----
  const cols = /\b(one|two|three|four|1|2|3|4)[ -]columns?\b/.exec(text);
  if (cols) {
    const n = ({ one: 1, two: 2, three: 3, four: 4 } as Record<string, number>)[cols[1]] ?? Number(cols[1]);
    if (selected) { ops.push({ op: "columns", id: selected.id, count: n }); says.push(`make the selected section ${n} column${n === 1 ? "" : "s"}`); }
    else notes.push("Select the section you want to change first, then ask for columns again.");
  }

  // ----- Hide on a device -----
  const hide = /\bhide\b.*\b(mobile|phones?|tablets?|desktop)\b/.exec(text);
  if (hide) {
    const el = ctx.selection ? getElement(doc, ctx.selection) : null;
    if (el) { ops.push({ op: "hide", id: el.id, screen: hide[1].startsWith("tab") ? "t" : hide[1] === "desktop" ? "d" : "m", hidden: true }); says.push(`hide the selected ${el.type} on ${hide[1]}`); }
    else notes.push("Select the item you want to hide first, then ask again.");
  }

  // ----- Phones -----
  if (any(text, ["mobile", "phone", "phones", "small screen", "small screens", "responsive"]) && any(text, ["better", "friendly", "improve", "fix", "optimise", "optimize", "suit", "suitable", "work", "works", "easier", "tidy"]) && !hide) {
    const big = SIZES.indexOf("6xl");
    eachPageSection(doc, ctx.pageId, (s) => {
      if (s.layout.stack === "never" && !s.r?.m?.stack) ops.push({ op: "responsive", id: s.id, screen: "m", set: { stack: "mobile" } });
      if ((s.layout.minH === "90" || s.layout.minH === "100") && !s.r?.m?.minH) ops.push({ op: "responsive", id: s.id, screen: "m", set: { minH: "75" } });
      if ((s.layout.pt === "3xl" || s.layout.pt === "2xl") && !s.r?.m?.pt) ops.push({ op: "responsive", id: s.id, screen: "m", set: { pt: "xl", pb: "xl" } });
      const visit = (e: ElementNode) => {
        const size = e.style?.size;
        if (e.type === "heading" && size && SIZES.indexOf(size) >= big && !e.r?.m?.size) {
          ops.push({ op: "responsive", id: e.id, screen: "m", set: { size: "4xl" } });
          ops.push({ op: "responsive", id: e.id, screen: "t", set: { size: "5xl" } });
        }
        e.children?.forEach(visit);
      };
      s.columns.forEach((c) => c.elements.forEach(visit));
    });
    says.push("tune large headings and tall sections for phones");
    if (ops.length === 0 || !ops.some((x) => x.op === "responsive")) notes.push("Nothing on this page needed tuning for phones: sections already stack and headings already scale down.");
  }

  // Several design requests read as one change to the design, so the person sees one line, not one per rule.
  const firstDesign = ops.findIndex((x) => x.op === "design");
  if (firstDesign >= 0) {
    const merged = Object.assign({}, ...ops.filter((x): x is Extract<Op, { op: "design" }> => x.op === "design").map((x) => x.set));
    const rest = ops.filter((x) => x.op !== "design");
    ops.length = 0;
    ops.push({ op: "design", set: merged }, ...rest);
  }

  const destructiveNote = destructive ? ["Removing a section can be undone straight away with Undo, or later from Version history."] : [];
  if (ops.length === 0) {
    return {
      summary: "",
      ops: [],
      notes,
      clarification: notes.length
        ? undefined
        : `I couldn't turn that into a change I can make safely. Try asking for one of these: ${SUGGESTIONS.map((s) => `“${s}”`).slice(0, 5).join(", ")}.`,
      destructive: false,
      source: "rules",
    };
  }
  const summary = `${says.join("; ").replace(/^./, (c) => c.toUpperCase())}.`;
  return { summary, ops, notes: [...notes, ...destructiveNote], destructive, source: "rules" };
}

export { SUGGESTIONS };
