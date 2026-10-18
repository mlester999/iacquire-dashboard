// The element library. Each element type declares its fields once; the document schema, the inspector, the defaults and the
// renderer all derive from this, so they cannot drift apart. Nothing here is HTML, script or CSS: every value is plain,
// length-limited data from a fixed vocabulary.

export type Option = { value: string; label: string };

export type FieldSpec =
  | { key: string; label: string; type: "text"; max: number; placeholder?: string; hint?: string; when?: Cond }
  | { key: string; label: string; type: "longtext"; max: number; placeholder?: string; hint?: string; rows?: number; when?: Cond }
  /** Text that may carry the inline marks: **bold**, *emphasis*, [label](link). Edited in place on the canvas. */
  | { key: string; label: string; type: "markup"; max: number; placeholder?: string; hint?: string; rows?: number; when?: Cond }
  | { key: string; label: string; type: "link"; hint?: string; when?: Cond }
  | { key: string; label: string; type: "href"; hint?: string; when?: Cond }
  | { key: string; label: string; type: "image"; hint?: string; when?: Cond }
  | { key: string; label: string; type: "select"; options: Option[]; ui?: "segmented" | "dropdown"; hint?: string; when?: Cond }
  | { key: string; label: string; type: "toggle"; hint?: string; when?: Cond }
  | { key: string; label: string; type: "number"; min: number; max: number; step?: number; unit?: string; hint?: string; when?: Cond }
  | { key: string; label: string; type: "color"; hint?: string; when?: Cond }
  | { key: string; label: string; type: "icon"; hint?: string; when?: Cond }
  | { key: string; label: string; type: "textlist"; max: number; itemMax: number; itemLabel: string; hint?: string; when?: Cond }
  | { key: string; label: string; type: "list"; max: number; itemLabel: string; item: FieldSpec[]; summary?: string; hint?: string; when?: Cond }
  /** One of the workspace's calendars, by slug. Empty means the default public calendar, so the element works in any workspace. */
  | { key: string; label: string; type: "calendarRef"; hint?: string; when?: Cond }
  /** One appointment type of the calendar named by `calendarKey`, by slug. Empty means every public type in that calendar. */
  | { key: string; label: string; type: "bookingTypeRef"; calendarKey: string; hint?: string; when?: Cond }
  /** One of the workspace's native CRM forms, by key. Empty means the built-in enquiry form, so the element works in any workspace. */
  | { key: string; label: string; type: "formRef"; hint?: string; when?: Cond };

/** Show a field only while another field has one of these values. */
export type Cond = { key: string; in: string[] };

export const ELEMENT_TYPES = [
  "heading", "text", "image", "button", "group", "card", "icon", "divider", "spacer", "badge", "list", "services", "steps", "faq", "testimonials",
  "stats", "logos", "team", "pricing", "gallery", "collage", "video", "contactInfo", "social", "nav", "logo", "form", "map", "marquee", "booking",
] as const;
export type ElementType = (typeof ELEMENT_TYPES)[number];
export const isElementType = (v: unknown): v is ElementType => typeof v === "string" && (ELEMENT_TYPES as readonly string[]).includes(v);

/** Elements that hold other elements. Nesting is capped, so a page stays a structure a person can reason about. */
export const CONTAINER_TYPES: ElementType[] = ["group", "card"];
export const MAX_CONTAINER_DEPTH = 3;

/** Icons an element may use. All render as inline SVG, so no icon font or script is shipped. */
export const ICONS = [
  "wrench", "home", "heart", "shield", "clock", "star", "map-pin", "phone", "mail", "calendar", "check", "sparkles", "users", "briefcase", "hammer", "leaf",
  "zap", "droplets", "key", "stethoscope", "smile", "scale", "chart", "building", "truck", "paintbrush", "camera", "lightbulb", "thumbs-up", "file-text",
  "arrow-right", "arrow-up-right", "play", "quote", "bed", "bath", "ruler", "sun", "waves", "coffee", "utensils", "wine", "dumbbell", "flower", "cpu", "code",
  "rocket", "globe", "lock", "layers", "target", "trending-up", "badge-check", "calendar-check", "car", "sofa", "trees", "mountain", "compass", "gem",
  "handshake", "message-circle", "search", "pen-tool", "scissors", "baby", "paw-print", "sprout", "flame", "snowflake", "wifi", "monitor", "palette", "brush",
] as const;
export type IconName = (typeof ICONS)[number];

export const ASPECTS = ["auto", "1/1", "5/4", "4/3", "3/2", "16/10", "16/9", "21/9", "4/5", "3/4", "2/3", "9/16"] as const;
export const aspectOptions: Option[] = ASPECTS.map((a) => ({ value: a, label: a === "auto" ? "Natural" : a.replace("/", ":") }));

export const SPACES = ["0", "xs", "s", "m", "l", "xl", "2xl", "3xl"] as const;
export type Space = (typeof SPACES)[number];
export const spaceOptions: Option[] = [
  { value: "0", label: "None" }, { value: "xs", label: "XS" }, { value: "s", label: "S" }, { value: "m", label: "M" },
  { value: "l", label: "L" }, { value: "xl", label: "XL" }, { value: "2xl", label: "2XL" }, { value: "3xl", label: "3XL" },
];

const text = (key: string, label: string, max: number, extra: Partial<{ placeholder: string; hint: string; when: Cond }> = {}): FieldSpec => ({ key, label, type: "text", max, ...extra });
const markup = (key: string, label: string, max: number, extra: Partial<{ placeholder: string; hint: string; rows: number; when: Cond }> = {}): FieldSpec => ({ key, label, type: "markup", max, ...extra });
const link = (key: string, label: string, hint?: string, when?: Cond): FieldSpec => ({ key, label, type: "link", hint, when });
const image = (key: string, label: string, hint?: string): FieldSpec => ({ key, label, type: "image", hint });
const toggle = (key: string, label: string, hint?: string, when?: Cond): FieldSpec => ({ key, label, type: "toggle", hint, when });
const select = (key: string, label: string, options: Option[], ui: "segmented" | "dropdown" = "dropdown", extra: Partial<{ hint: string; when: Cond }> = {}): FieldSpec => ({ key, label, type: "select", options, ui, ...extra });
const number = (key: string, label: string, min: number, max: number, step = 1, unit?: string): FieldSpec => ({ key, label, type: "number", min, max, step, unit });
const opts = (...pairs: Array<[string, string]>): Option[] => pairs.map(([value, label]) => ({ value, label }));
/**
 * The form element's built-in settings apply only while it uses the built-in enquiry form: no CRM form chosen, which is an empty key or
 * (in every template and older site) no key at all.
 */
const BUILT_IN_FORM: Cond = { key: "formKey", in: ["", "undefined"] };

export interface ElementDef {
  type: ElementType;
  label: string;
  group: "Basics" | "Layout" | "Content" | "Media" | "Business" | "Site";
  description: string;
  fields: FieldSpec[];
  /** True for elements that can sit directly in a column from the add menu. */
  addable: boolean;
}

export const ELEMENT_DEFS: Record<ElementType, ElementDef> = {
  heading: {
    type: "heading", label: "Heading", group: "Basics", addable: true, description: "A headline or title.",
    fields: [markup("text", "Text", 200, { rows: 2, hint: "Wrap a word in *asterisks* to emphasise it." }), select("level", "Level", opts(["1", "H1"], ["2", "H2"], ["3", "H3"], ["4", "H4"]), "segmented", { hint: "Each page should have one H1." })],
  },
  text: {
    type: "text", label: "Text", group: "Basics", addable: true, description: "A paragraph, lead-in or small label.",
    fields: [markup("text", "Text", 4000, { rows: 5 }), select("role", "Style", opts(["body", "Paragraph"], ["lede", "Lead-in"], ["eyebrow", "Small label"], ["quote", "Pull quote"], ["caption", "Caption"], ["small", "Small print"]))],
  },
  image: {
    type: "image", label: "Image", group: "Media", addable: true, description: "A photo or graphic.",
    fields: [
      image("src", "Image"), text("alt", "Description for screen readers", 200, { hint: "Describe what the image shows. Leave empty for decoration." }),
      select("aspect", "Shape", aspectOptions), select("fit", "Fit", opts(["cover", "Fill"], ["contain", "Whole image"]), "segmented"),
      number("posX", "Focus: left to right", 0, 100, 1, "%"), number("posY", "Focus: top to bottom", 0, 100, 1, "%"),
      select("frame", "Frame", opts(["none", "None"], ["soft", "Rounded"], ["arch", "Arch"], ["circle", "Circle"], ["offset", "Offset border"], ["tilt", "Tilted"], ["notch", "Cut corner"])),
      select("overlay", "Tint", opts(["0", "None"], ["20", "Light"], ["40", "Medium"], ["60", "Strong"]), "segmented"),
      text("caption", "Caption", 160), toggle("priority", "Load first", "Turn on for the large image at the top of the page."),
    ],
  },
  button: {
    type: "button", label: "Button", group: "Basics", addable: true, description: "A button that links to a page, a phone number or an email.",
    fields: [
      link("link", "Label and destination"),
      select("variant", "Style", opts(["primary", "Primary"], ["accent", "Accent"], ["secondary", "Soft"], ["outline", "Outline"], ["ghost", "Text link"], ["light", "White"], ["dark", "Dark"])),
      select("size", "Size", opts(["s", "Small"], ["m", "Medium"], ["l", "Large"]), "segmented"),
      select("icon", "Icon", opts(["none", "None"], ["arrow-right", "Arrow"], ["arrow-up-right", "Arrow up-right"], ["phone", "Phone"], ["calendar", "Calendar"], ["play", "Play"], ["mail", "Mail"])),
      toggle("fullWidth", "Full width"), text("track", "Name for conversion tracking", 40, { hint: "Optional. Shows in reports when this button is clicked." }),
    ],
  },
  group: {
    type: "group", label: "Row or stack", group: "Layout", addable: true, description: "Holds elements side by side or stacked, with its own spacing.",
    fields: [
      select("dir", "Direction", opts(["row", "Side by side"], ["col", "Stacked"]), "segmented"), select("gap", "Gap", spaceOptions),
      toggle("wrap", "Wrap onto new lines"), select("justify", "Align along", opts(["start", "Start"], ["center", "Centre"], ["end", "End"], ["between", "Spread"])),
      select("items", "Align across", opts(["start", "Start"], ["center", "Centre"], ["end", "End"], ["stretch", "Stretch"])),
    ],
  },
  card: {
    type: "card", label: "Card", group: "Layout", addable: true, description: "A panel that holds other elements.",
    fields: [
      select("surface", "Look", opts(["flat", "Flat"], ["outlined", "Outlined"], ["elevated", "Raised"], ["tinted", "Tinted"], ["glass", "Glass"], ["dark", "Dark"], ["brand", "Brand colour"])),
      select("pad", "Padding", spaceOptions), select("gap", "Gap between items", spaceOptions), select("hover", "On hover", opts(["none", "Nothing"], ["lift", "Lift"], ["glow", "Glow"], ["border", "Border"])),
      select("align", "Text alignment", opts(["start", "Left"], ["center", "Centre"], ["end", "Right"]), "segmented"),
    ],
  },
  icon: {
    type: "icon", label: "Icon", group: "Basics", addable: true, description: "A simple symbol.",
    fields: [
      { key: "name", label: "Icon", type: "icon" }, select("size", "Size", opts(["s", "S"], ["m", "M"], ["l", "L"], ["xl", "XL"]), "segmented"),
      select("shape", "Background", opts(["none", "None"], ["circle", "Circle"], ["square", "Square"], ["soft", "Soft square"])), select("tone", "Colour", opts(["primary", "Primary"], ["accent", "Accent"], ["ink", "Text"], ["light", "White"])),
    ],
  },
  divider: {
    type: "divider", label: "Divider", group: "Layout", addable: true, description: "A line that separates content.",
    fields: [select("style", "Style", opts(["line", "Line"], ["dashed", "Dashed"], ["dots", "Dots"], ["ornament", "Ornament"], ["thick", "Thick"])), select("width", "Width", opts(["xs", "Short"], ["s", "Small"], ["m", "Medium"], ["full", "Full"]), "segmented")],
  },
  spacer: { type: "spacer", label: "Spacer", group: "Layout", addable: true, description: "Empty space.", fields: [select("size", "Height", spaceOptions)] },
  badge: {
    type: "badge", label: "Badge", group: "Basics", addable: true, description: "A small pill of text.",
    fields: [text("text", "Text", 40), select("style", "Style", opts(["pill", "Pill"], ["outline", "Outline"], ["dot", "With dot"], ["plain", "Plain"])), { key: "icon", label: "Icon", type: "icon" }],
  },
  list: {
    type: "list", label: "Feature list", group: "Content", addable: true, description: "A short list of points.",
    fields: [
      { key: "items", label: "Points", type: "textlist", max: 14, itemMax: 140, itemLabel: "point" },
      select("style", "Marker", opts(["check", "Tick"], ["dot", "Dot"], ["number", "Number"], ["dash", "Dash"], ["none", "None"])), select("cols", "Columns", opts(["1", "1"], ["2", "2"], ["3", "3"]), "segmented"),
    ],
  },
  services: {
    type: "services", label: "Services", group: "Content", addable: true, description: "Your services as cards, rows or a bento grid.",
    fields: [
      {
        key: "items", label: "Services", type: "list", max: 16, itemLabel: "service", summary: "title",
        item: [text("title", "Name", 80), markup("text", "Description", 400, { rows: 3 }), { key: "icon", label: "Icon", type: "icon" }, image("image", "Image"), link("link", "Link (optional)")],
      },
      select("style", "Layout", opts(["grid", "Cards"], ["iconCards", "Icon cards"], ["imageCards", "Image cards"], ["bento", "Bento"], ["rows", "Rows"], ["numbered", "Numbered"], ["alternating", "Alternating"], ["list", "Simple list"])),
      select("cols", "Columns", opts(["2", "2"], ["3", "3"], ["4", "4"]), "segmented"),
    ],
  },
  steps: {
    type: "steps", label: "Process", group: "Content", addable: true, description: "The steps from first contact to done.",
    fields: [
      { key: "items", label: "Steps", type: "list", max: 8, itemLabel: "step", summary: "title", item: [text("title", "Step name", 80), markup("text", "What happens", 300, { rows: 3 })] },
      select("style", "Layout", opts(["timeline", "Timeline"], ["cards", "Cards"], ["numbered", "Large numbers"], ["line", "Connected"], ["vertical", "Vertical"])),
    ],
  },
  faq: {
    type: "faq", label: "FAQ", group: "Content", addable: true, description: "Questions and answers.",
    fields: [
      { key: "items", label: "Questions", type: "list", max: 24, itemLabel: "question", summary: "q", item: [text("q", "Question", 180), markup("a", "Answer", 800, { rows: 4 })] },
      select("style", "Layout", opts(["accordion", "Accordion"], ["columns", "Two columns"], ["cards", "Cards"], ["lines", "Lines"])), toggle("openFirst", "Open the first answer"),
    ],
  },
  testimonials: {
    type: "testimonials", label: "Testimonials", group: "Business", addable: true, description: "Real words from real customers, with their permission.",
    fields: [
      {
        key: "items", label: "Testimonials", type: "list", max: 9, itemLabel: "testimonial", summary: "author",
        item: [
          markup("quote", "What they said", 500, { rows: 4 }), text("author", "Name", 80), text("role", "Who they are (optional)", 80), image("avatar", "Photo (optional)"),
          toggle("confirmedReal", "A real customer said this and agreed to its use", "A testimonial can't be published unless you confirm this."),
        ],
      },
      select("style", "Layout", opts(["cards", "Cards"], ["quote", "Large quote"], ["wall", "Wall"], ["slider", "Swipe row"])),
    ],
  },
  stats: {
    type: "stats", label: "Numbers", group: "Business", addable: true, description: "A few figures you can verify.",
    fields: [
      { key: "items", label: "Figures", type: "list", max: 6, itemLabel: "figure", summary: "value", item: [text("value", "Figure", 20, { placeholder: "250" }), text("prefix", "Before", 6), text("suffix", "After", 8, { placeholder: "+" }), text("label", "What it measures", 70)] },
      select("style", "Layout", opts(["row", "Row"], ["cards", "Cards"], ["big", "Large"], ["lines", "Divided"])), toggle("countUp", "Count up when scrolled into view"),
    ],
  },
  logos: {
    type: "logos", label: "Logos", group: "Business", addable: true, description: "Partners, clients or accreditations you hold.",
    fields: [
      { key: "items", label: "Logos", type: "list", max: 12, itemLabel: "logo", summary: "name", item: [text("name", "Name", 60), image("image", "Logo image")] },
      select("style", "Layout", opts(["row", "Row"], ["grid", "Grid"], ["marquee", "Scrolling"])), toggle("grayscale", "Show in one tone"),
    ],
  },
  team: {
    type: "team", label: "Team", group: "Business", addable: true, description: "The people customers will meet.",
    fields: [
      { key: "members", label: "People", type: "list", max: 12, itemLabel: "person", summary: "name", item: [text("name", "Name", 80), text("role", "Role", 80), image("photo", "Photo"), markup("bio", "Short bio", 300, { rows: 3 })] },
      select("style", "Layout", opts(["cards", "Cards"], ["minimal", "Minimal"], ["circles", "Round photos"])), select("cols", "Columns", opts(["2", "2"], ["3", "3"], ["4", "4"]), "segmented"),
    ],
  },
  pricing: {
    type: "pricing", label: "Pricing", group: "Business", addable: true, description: "Prices you have approved for publication.",
    fields: [
      {
        key: "plans", label: "Plans", type: "list", max: 4, itemLabel: "plan", summary: "name",
        item: [text("name", "Name", 60), text("price", "Price", 40), text("period", "Per", 24, { placeholder: "month" }), markup("text", "Description", 200, { rows: 2 }), { key: "features", label: "What's included", type: "textlist", max: 10, itemMax: 90, itemLabel: "item" }, link("cta", "Button"), toggle("featured", "Highlight this plan")],
      },
      text("note", "Note under the prices", 200),
    ],
  },
  gallery: {
    type: "gallery", label: "Gallery", group: "Media", addable: true, description: "Photos of your work, properties or premises.",
    fields: [
      { key: "items", label: "Images", type: "list", max: 18, itemLabel: "image", summary: "caption", item: [image("src", "Image"), text("alt", "Description", 160), text("caption", "Caption", 100)] },
      select("layout", "Layout", opts(["grid", "Grid"], ["masonry", "Masonry"], ["mosaic", "Mosaic"], ["strip", "Scrolling strip"])),
      select("cols", "Columns", opts(["2", "2"], ["3", "3"], ["4", "4"]), "segmented"), select("aspect", "Shape", aspectOptions), select("gap", "Gap", spaceOptions),
    ],
  },
  collage: {
    type: "collage", label: "Image collage", group: "Media", addable: true, description: "A composed group of images.",
    fields: [
      { key: "items", label: "Images", type: "list", max: 4, itemLabel: "image", item: [image("src", "Image"), text("alt", "Description", 160)] },
      select("layout", "Arrangement", opts(["trio", "Three, staggered"], ["duo", "Two, offset"], ["stack", "Overlapping"], ["arch", "Arches"], ["tall", "One tall, two small"])),
    ],
  },
  video: {
    type: "video", label: "Video", group: "Media", addable: true, description: "A YouTube or Vimeo video. It loads only when the visitor presses play.",
    fields: [
      select("provider", "Where is it?", opts(["youtube", "YouTube"], ["vimeo", "Vimeo"]), "segmented"), text("videoId", "Video ID", 24, { hint: "The code at the end of the video's address." }),
      image("poster", "Cover image"), text("title", "Title", 120), select("aspect", "Shape", aspectOptions),
    ],
  },
  contactInfo: {
    type: "contactInfo", label: "Contact details", group: "Business", addable: true, description: "Phone, email, address and hours from your business details.",
    fields: [
      toggle("phone", "Phone"), toggle("email", "Email"), toggle("address", "Address"), toggle("hours", "Opening hours"),
      select("layout", "Layout", opts(["stack", "List"], ["cards", "Cards"], ["inline", "In a row"])),
    ],
  },
  social: {
    type: "social", label: "Social links", group: "Business", addable: true, description: "Links to the social pages you have added in Site settings.",
    fields: [select("style", "Style", opts(["icons", "Round icons"], ["links", "Text links"], ["plain", "Plain icons"])), select("size", "Size", opts(["s", "S"], ["m", "M"], ["l", "L"]), "segmented")],
  },
  nav: {
    type: "nav", label: "Navigation", group: "Site", addable: false, description: "Links to your pages.",
    fields: [
      select("style", "Style", opts(["links", "Links"], ["pills", "Pills"], ["underline", "Underline"], ["minimal", "Small caps"])),
      { key: "extra", label: "Extra links", type: "list", max: 6, itemLabel: "link", summary: "label", item: [text("label", "Label", 30), { key: "href", label: "Destination", type: "href" }] },
      toggle("showCta", "Show a button"), link("cta", "Button", undefined, { key: "showCta", in: ["true"] }),
      select("align", "Alignment", opts(["start", "Left"], ["center", "Centre"], ["end", "Right"]), "segmented"),
    ],
  },
  logo: {
    type: "logo", label: "Logo", group: "Site", addable: false, description: "Your logo, or your business name.",
    fields: [select("variant", "Show", opts(["auto", "Logo if you have one"], ["text", "Name only"], ["both", "Logo and name"])), select("size", "Size", opts(["s", "S"], ["m", "M"], ["l", "L"]), "segmented"), { key: "tagline", label: "Show tagline", type: "toggle" }],
  },
  form: {
    type: "form", label: "Enquiry form", group: "Business", addable: true, description: "A form whose answers arrive in your contacts.",
    fields: [
      // A native CRM form (its own questions, mapping and actions), or "" for the built-in enquiry form below.
      { key: "formKey", label: "Form", type: "formRef", hint: "Use one of your CRM forms, or the built-in enquiry form." },
      select("purpose", "What is it for?", opts(["contact", "General enquiry"], ["consultation", "Consultation request"], ["lead", "Quote or lead"], ["appointment", "Appointment request"]), "dropdown", { when: BUILT_IN_FORM }),
      text("submitLabel", "Button label", 40, { when: BUILT_IN_FORM }), select("layout", "Look", opts(["card", "Card"], ["plain", "Plain"], ["inline", "Compact"])),
      select("phone", "Phone number", opts(["hidden", "Hidden"], ["optional", "Optional"], ["required", "Required"]), "segmented", { when: BUILT_IN_FORM }),
      select("message", "Message", opts(["hidden", "Hidden"], ["optional", "Optional"], ["required", "Required"]), "segmented", { when: BUILT_IN_FORM }),
      select("service", "Service choice", opts(["hidden", "Hidden"], ["optional", "Optional"], ["required", "Required"]), "segmented", { when: BUILT_IN_FORM }),
      { key: "services", label: "Services to choose from", type: "textlist", max: 12, itemMax: 60, itemLabel: "service", when: BUILT_IN_FORM },
      text("helper", "Small note under the button", 160),
    ],
  },
  map: {
    type: "map", label: "Location", group: "Business", addable: true, description: "Your address with a link to open it in maps. Nothing is loaded from a map provider.",
    fields: [text("address", "Address", 200, { hint: "Leave empty to use your business address." }), select("style", "Style", opts(["card", "Card"], ["art", "Illustrated"])), text("label", "Button label", 40)],
  },
  marquee: {
    type: "marquee", label: "Scrolling words", group: "Content", addable: true, description: "A slow-moving line of words.",
    fields: [{ key: "items", label: "Words", type: "textlist", max: 12, itemMax: 40, itemLabel: "word" }, select("speed", "Speed", opts(["slow", "Slow"], ["normal", "Normal"], ["fast", "Fast"]), "segmented"), select("style", "Style", opts(["text", "Large text"], ["outline", "Outlined text"], ["badge", "Pills"]))],
  },
  booking: {
    type: "booking", label: "Book appointment", group: "Business", addable: true, description: "Lets visitors choose a time and book it. Bookings go straight into your calendar.",
    fields: [
      { key: "calendar", label: "Calendar", type: "calendarRef", hint: "The default uses your main public calendar." },
      { key: "type", label: "Appointment type", type: "bookingTypeRef", calendarKey: "calendar", hint: "Offer one type, or every public type in the calendar." },
      select("display", "Show as", opts(["button", "A button"], ["types", "A list of appointment types"], ["card", "A card with the types and a button"])),
      text("label", "Button label", 40, { placeholder: "Book an appointment", when: { key: "display", in: ["button", "card"] } }),
      select("variant", "Button style", opts(["primary", "Primary"], ["accent", "Accent"], ["secondary", "Soft"], ["outline", "Outline"], ["light", "White"], ["dark", "Dark"]), "dropdown", { when: { key: "display", in: ["button", "card"] } }),
      select("size", "Button size", opts(["s", "Small"], ["m", "Medium"], ["l", "Large"]), "segmented", { when: { key: "display", in: ["button", "card"] } }),
      text("helper", "Small note", 160, { hint: "Optional. A short line shown under the booking options." }),
    ],
  },
};

/** The value a new element starts with, so a freshly added element always has the shape the renderer expects. */
export function defaultsFor(fields: FieldSpec[]): Record<string, unknown> {
  return Object.fromEntries(
    // A form element's CRM form is opt-in: without one the key is simply absent, so templates and saved sites stay exactly as they were.
    fields.filter((f) => f.type !== "formRef").map((f) => {
      switch (f.type) {
        case "text":
        case "longtext":
        case "markup":
        case "href": return [f.key, ""];
        case "link": return [f.key, { label: "", href: "" }];
        case "image": return [f.key, null];
        case "select": return [f.key, f.options[0].value];
        case "toggle": return [f.key, false];
        case "number": return [f.key, f.min];
        case "color": return [f.key, "primary"];
        case "icon": return [f.key, "sparkles"];
        case "textlist":
        case "list": return [f.key, []];
        case "calendarRef":
        case "bookingTypeRef": return [f.key, ""];
      }
    }),
  );
}

/** Per-element starting values that differ from the blank defaults. */
const START: Partial<Record<ElementType, Record<string, unknown>>> = {
  heading: { text: "A clear headline", level: "2" },
  text: { text: "Write something helpful here.", role: "body" },
  image: { aspect: "4/3", fit: "cover", posX: 50, posY: 50, frame: "none", overlay: "0" },
  button: { link: { label: "Get in touch", href: "/contact" }, variant: "primary", size: "m", icon: "none" },
  group: { dir: "row", gap: "s", wrap: true, justify: "start", items: "center" },
  card: { surface: "outlined", pad: "m", gap: "s", hover: "none", align: "start" },
  icon: { name: "sparkles", size: "m", shape: "soft", tone: "primary" },
  divider: { style: "line", width: "full" },
  spacer: { size: "m" },
  badge: { text: "New", style: "pill", icon: "sparkles" },
  list: { items: ["First point", "Second point", "Third point"], style: "check", cols: "1" },
  services: { style: "grid", cols: "3", items: [] },
  steps: { style: "timeline", items: [] },
  faq: { style: "accordion", items: [] },
  testimonials: { style: "cards", items: [] },
  stats: { style: "row", items: [], countUp: true },
  logos: { style: "row", items: [], grayscale: true },
  team: { style: "cards", cols: "3", members: [] },
  pricing: { plans: [], note: "" },
  gallery: { layout: "grid", cols: "3", aspect: "4/3", gap: "s", items: [] },
  collage: { layout: "trio", items: [] },
  video: { provider: "youtube", aspect: "16/9" },
  contactInfo: { phone: true, email: true, address: true, hours: true, layout: "stack" },
  social: { style: "icons", size: "m" },
  nav: { style: "links", showCta: false, extra: [], cta: { label: "Get in touch", href: "/contact" }, align: "end" },
  logo: { variant: "auto", size: "m", tagline: false },
  form: { purpose: "contact", submitLabel: "Send message", layout: "card", phone: "optional", message: "required", service: "hidden", services: [], helper: "" },
  map: { address: "", style: "card", label: "Open in maps" },
  marquee: { items: [], speed: "normal", style: "text" },
  booking: { calendar: "", type: "", display: "button", label: "Book an appointment", variant: "primary", size: "m", helper: "" },
};

export function elementDefaults(type: ElementType): Record<string, unknown> {
  return { ...defaultsFor(ELEMENT_DEFS[type].fields), ...(START[type] ?? {}) };
}

export const GROUP_ORDER: ElementDef["group"][] = ["Basics", "Content", "Media", "Business", "Layout", "Site"];
