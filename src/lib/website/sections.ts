// The section library. Each section type declares its fields once; the content schema, the editor forms,
// the generator and the renderer all derive from this, so they cannot drift apart.

export type FieldSpec =
  | { key: string; label: string; type: "text"; max: number; placeholder?: string; hint?: string }
  | { key: string; label: string; type: "longtext"; max: number; placeholder?: string; hint?: string }
  | { key: string; label: string; type: "link"; hint?: string }
  | { key: string; label: string; type: "image"; hint?: string }
  | { key: string; label: string; type: "select"; options: Array<{ value: string; label: string }>; hint?: string }
  | { key: string; label: string; type: "toggle"; hint?: string }
  | { key: string; label: string; type: "color"; hint?: string }
  | { key: string; label: string; type: "textlist"; max: number; itemMax: number; itemLabel: string; hint?: string }
  | { key: string; label: string; type: "list"; max: number; itemLabel: string; item: FieldSpec[]; hint?: string };

export const SECTION_TYPES = [
  "hero", "services", "about", "process", "testimonials", "faq", "cta", "gallery", "contact", "pricing", "areas", "stats", "team", "richText",
] as const;
export type SectionType = (typeof SECTION_TYPES)[number];
export const isSectionType = (v: unknown): v is SectionType => typeof v === "string" && (SECTION_TYPES as readonly string[]).includes(v);

/** Icons a services or process item may use. All render as inline SVG, so no icon font or script is shipped. */
export const ICONS = [
  "wrench", "home", "heart", "shield", "clock", "star", "map-pin", "phone", "mail", "calendar", "check", "sparkles", "users",
  "briefcase", "hammer", "leaf", "zap", "droplets", "key", "stethoscope", "smile", "scale", "chart", "building", "truck", "paintbrush",
  "camera", "lightbulb", "thumbs-up", "file-text",
] as const;
export type IconName = (typeof ICONS)[number];
const iconOptions = ICONS.map((i) => ({ value: i, label: i.replace(/-/g, " ") }));

export interface SectionDef {
  type: SectionType;
  label: string;
  description: string;
  /** Whether an owner may add more than one of these to a page. */
  repeatable: boolean;
  fields: FieldSpec[];
}

const text = (key: string, label: string, max: number, extra: Partial<{ placeholder: string; hint: string }> = {}): FieldSpec => ({ key, label, type: "text", max, ...extra });
const long = (key: string, label: string, max: number, extra: Partial<{ placeholder: string; hint: string }> = {}): FieldSpec => ({ key, label, type: "longtext", max, ...extra });
const link = (key: string, label: string, hint?: string): FieldSpec => ({ key, label, type: "link", hint });

export const SECTION_DEFS: Record<SectionType, SectionDef> = {
  hero: {
    type: "hero", label: "Hero", description: "The first thing visitors see: your headline and main action.", repeatable: false,
    fields: [
      text("eyebrow", "Small label above the headline", 60, { placeholder: "Serving Austin since…" }),
      text("headline", "Headline", 120, { placeholder: "What you do, in plain words" }),
      long("subheadline", "Supporting text", 320),
      link("primaryCta", "Main button"),
      link("secondaryCta", "Second button"),
      { key: "image", label: "Image", type: "image" },
      { key: "badges", label: "Short highlights", type: "textlist", max: 4, itemMax: 40, itemLabel: "highlight", hint: "Only claims you can back up, such as a licence you hold." },
    ],
  },
  services: {
    type: "services", label: "Services", description: "What you offer, as cards or rows.", repeatable: false,
    fields: [
      text("heading", "Heading", 100), long("intro", "Introduction", 300),
      { key: "items", label: "Services", type: "list", max: 12, itemLabel: "service", item: [
        text("title", "Name", 80), long("description", "Description", 260),
        { key: "icon", label: "Icon", type: "select", options: iconOptions }, link("link", "Link (optional)"),
      ] },
    ],
  },
  about: {
    type: "about", label: "About", description: "Who you are and why customers trust you.", repeatable: false,
    fields: [
      text("heading", "Heading", 100), long("body", "Your story", 1600), { key: "image", label: "Photo", type: "image" },
      { key: "points", label: "Key points", type: "textlist", max: 6, itemMax: 90, itemLabel: "point" },
    ],
  },
  process: {
    type: "process", label: "How it works", description: "The steps from first contact to done.", repeatable: false,
    fields: [
      text("heading", "Heading", 100), long("intro", "Introduction", 300),
      { key: "steps", label: "Steps", type: "list", max: 6, itemLabel: "step", item: [text("title", "Step name", 70), long("description", "What happens", 240)] },
    ],
  },
  testimonials: {
    type: "testimonials", label: "Testimonials", description: "Real words from real customers, with their permission.", repeatable: false,
    fields: [
      text("heading", "Heading", 100),
      { key: "items", label: "Testimonials", type: "list", max: 6, itemLabel: "testimonial", item: [
        long("quote", "What they said", 420), text("author", "Name", 80), text("role", "Who they are (optional)", 80),
        { key: "confirmedReal", label: "A real customer said this and agreed to its use", type: "toggle", hint: "A testimonial can't be published unless you confirm this." },
      ] },
    ],
  },
  faq: {
    type: "faq", label: "FAQ", description: "Answers to questions customers ask.", repeatable: false,
    fields: [
      text("heading", "Heading", 100), long("intro", "Introduction", 240),
      { key: "items", label: "Questions", type: "list", max: 20, itemLabel: "question", item: [text("question", "Question", 160), long("answer", "Answer", 600)] },
    ],
  },
  cta: {
    type: "cta", label: "Call to action", description: "A clear next step for the visitor.", repeatable: true,
    fields: [text("heading", "Heading", 120), long("body", "Supporting text", 260), link("button", "Button"), link("secondary", "Second button")],
  },
  gallery: {
    type: "gallery", label: "Gallery", description: "Photos of your work or premises.", repeatable: false,
    fields: [
      text("heading", "Heading", 100), long("intro", "Introduction", 240),
      { key: "images", label: "Images", type: "list", max: 12, itemLabel: "image", item: [{ key: "image", label: "Image", type: "image" }, text("caption", "Caption", 100)] },
    ],
  },
  contact: {
    type: "contact", label: "Contact", description: "How to reach you, with an enquiry form.", repeatable: false,
    fields: [
      text("heading", "Heading", 100), long("intro", "Introduction", 260), { key: "showDetails", label: "Show phone, email, address and hours", type: "toggle" },
      { key: "showForm", label: "Show the enquiry form", type: "toggle" }, text("submitLabel", "Form button label", 40),
    ],
  },
  pricing: {
    type: "pricing", label: "Pricing", description: "Prices you have approved for publication.", repeatable: false,
    fields: [
      text("heading", "Heading", 100), long("intro", "Introduction", 240),
      { key: "plans", label: "Plans", type: "list", max: 4, itemLabel: "plan", item: [
        text("name", "Name", 60), text("price", "Price", 40), long("description", "Description", 200),
        { key: "features", label: "What's included", type: "textlist", max: 8, itemMax: 80, itemLabel: "item" }, link("cta", "Button"),
      ] },
      text("note", "Note under the prices", 200),
    ],
  },
  areas: {
    type: "areas", label: "Areas served", description: "Where you work.", repeatable: false,
    fields: [text("heading", "Heading", 100), long("intro", "Introduction", 240), { key: "areas", label: "Places", type: "textlist", max: 30, itemMax: 60, itemLabel: "place" }],
  },
  stats: {
    type: "stats", label: "Numbers", description: "A few figures you can verify.", repeatable: false,
    fields: [{ key: "items", label: "Figures", type: "list", max: 4, itemLabel: "figure", item: [text("value", "Figure", 20, { placeholder: "250+" }), text("label", "What it measures", 60)] }],
  },
  team: {
    type: "team", label: "Team", description: "The people customers will meet.", repeatable: false,
    fields: [
      text("heading", "Heading", 100),
      { key: "members", label: "People", type: "list", max: 8, itemLabel: "person", item: [text("name", "Name", 80), text("role", "Role", 80), { key: "photo", label: "Photo", type: "image" }, long("bio", "Short bio", 240)] },
    ],
  },
  richText: {
    type: "richText", label: "Text", description: "A heading with free text.", repeatable: true,
    fields: [text("heading", "Heading", 120), long("body", "Text", 4000)],
  },
};

/** A blank value for every field, so a new section or list row always has the shape the renderer expects. */
export function defaultsFor(fields: FieldSpec[]): Record<string, unknown> {
  return Object.fromEntries(
    fields.map((f) => {
      switch (f.type) {
        case "text":
        case "longtext": return [f.key, ""];
        case "link": return [f.key, { label: "", href: "" }];
        case "image": return [f.key, null];
        case "select": return [f.key, f.options[0].value];
        case "toggle": return [f.key, f.key === "showDetails" || f.key === "showForm"];
        case "color": return [f.key, "#2c5bff"];
        case "textlist":
        case "list": return [f.key, []];
      }
    }),
  );
}

export const defaultSectionData = (type: SectionType): Record<string, unknown> => defaultsFor(SECTION_DEFS[type].fields);
export const emptyListItem = (spec: Extract<FieldSpec, { type: "list" }>): Record<string, unknown> => defaultsFor(spec.item);
