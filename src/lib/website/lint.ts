// Checks a site before it can go live. Blockers can never be published; warnings are claims we cannot verify, so the owner must
// read them and explicitly confirm. We never publish fabricated testimonials, placeholder text or sample content, we never let a
// link point nowhere, and we make unverifiable claims visible rather than silently shipping them.
import { artKind } from "./art-keys";
import { ELEMENT_DEFS, type FieldSpec } from "./catalog";
import { eachElement, isRef, resolveItem, type ElementNode, type ImageSrc, type SiteContent } from "./doc";
import { plainText } from "./markup";

export interface Issue {
  code: string;
  message: string;
  where: string;
  /** The words that triggered a claim warning, so the owner can see exactly what we mean. */
  match?: string;
  /** The node to select in the editor to fix it. */
  nodeId?: string;
}
export interface Readiness {
  blockers: Issue[];
  warnings: Issue[];
}

const PLACEHOLDER = /\b(lorem ipsum|sample customer|todo|placeholder|your (business|realty|clinic|practice|agency|shop|consultancy|local business|home services)|example\.(com|org)|insert (name|text))\b/i;
const BRACKETS = /\[[^\]]{1,40}\]/;
const TOKEN = /\{\{\s*[a-z0-9_.]+\s*\}\}/i;

const CLAIMS: Array<{ code: string; re: RegExp; message: (m: string) => string }> = [
  { code: "claim_superlative", re: /\b(award[- ]?winning|award winner|best[- ]in[- ]class|best (?:in|of) (?:the )?[a-z]+|#\s?1|number[- ]one|no\.? ?1|top[- ]rated|top[- ]ranked|market[- ]leading|world[- ]class|unrivall?ed|finest|premier)\b/i, message: (m) => `"${m}" is a claim you'll need to be able to prove.` },
  { code: "claim_guarantee", re: /\b(guarantee[ds]?|money[- ]back|risk[- ]free|100\s?%)/i, message: (m) => `"${m}" promises an outcome. Only keep it if it's in your written terms.` },
  { code: "claim_credential", re: /\b(certified|accredited|licen[sc]ed|insured|bonded|approved by|endorsed by|registered with)\b/i, message: (m) => `"${m}" claims a credential. Only publish it if you hold it and can show it.` },
  { code: "claim_figure", re: /\b\d[\d,]*\+?\s+(?:years?|customers|clients|patients|homes|projects|reviews|five[- ]star)\b|\bsince\s+(?:19|20)\d{2}\b/i, message: (m) => `"${m}" is a figure. Check it's accurate today.` },
  { code: "claim_reviews", re: /\b(?:5|five)[- ]star\b|\bhighly rated\b|\bthousands of (?:happy|satisfied)\b/i, message: (m) => `"${m}" refers to reviews or ratings. Only keep it if it matches real, current reviews.` },
  { code: "claim_health", re: /\b(cures?|cured|heals?|clinically proven|doctor[- ]recommended|pain[- ]free)\b/i, message: (m) => `"${m}" is a health claim that may be regulated where you operate.` },
];

export interface TextRef { where: string; value: string; nodeId?: string }

/** Every piece of text a visitor could read, with where it lives. Marks are stripped so link syntax is never mistaken for a placeholder. */
export function collectTexts(content: SiteContent): TextRef[] {
  const out: TextRef[] = [];
  const add = (where: string, value: unknown, nodeId?: string) => {
    if (typeof value === "string" && value.trim()) out.push({ where, value, nodeId });
  };
  const b = content.business;
  add("Business › Name", b.name); add("Business › Tagline", b.tagline); add("Business › Address", b.address); add("Business › Hours", b.hours); add("Business › Email", b.email);
  add("Search › Title", content.seo.title); add("Search › Description", content.seo.description);
  add("Form › Success message", content.form.successMessage); add("Form › Consent", content.form.consentText);
  const walk = (where: string, fields: FieldSpec[], data: unknown, nodeId: string) => {
    if (!data || typeof data !== "object") return;
    const rec = data as Record<string, unknown>;
    for (const f of fields) {
      const v = rec[f.key];
      const label = `${where} › ${f.label}`;
      if (f.type === "text" || f.type === "longtext") add(label, v, nodeId);
      else if (f.type === "markup") add(label, typeof v === "string" ? plainText(v) : v, nodeId);
      else if (f.type === "link") add(label, (v as { label?: string } | undefined)?.label, nodeId);
      else if (f.type === "textlist" && Array.isArray(v)) v.forEach((t, i) => add(`${label} #${i + 1}`, t, nodeId));
      else if (f.type === "list" && Array.isArray(v)) v.forEach((row, i) => walk(`${label} #${i + 1}`, f.item, row, nodeId));
    }
  };
  eachElement(content, (e, where) => walk(`${where} › ${ELEMENT_DEFS[e.type].label}`, ELEMENT_DEFS[e.type].fields, e.props, e.id));
  for (const page of content.pages) {
    add(`${page.title} › Page title`, page.title); add(`${page.title} › Search title`, page.seoTitle); add(`${page.title} › Search description`, page.seoDescription);
  }
  return out;
}

/** Every link a site contains, so navigation can be checked. */
function collectLinks(content: SiteContent): Array<{ href: string; where: string; nodeId: string }> {
  const out: Array<{ href: string; where: string; nodeId: string }> = [];
  const walk = (where: string, fields: FieldSpec[], data: unknown, nodeId: string) => {
    if (!data || typeof data !== "object") return;
    const rec = data as Record<string, unknown>;
    for (const f of fields) {
      const v = rec[f.key];
      if (f.type === "link") {
        const l = v as { label?: string; href?: string } | undefined;
        if (l?.href) out.push({ href: l.href, where: `${where} › ${l.label || f.label}`, nodeId });
      } else if (f.type === "href" && typeof v === "string" && v) out.push({ href: v, where: `${where} › ${f.label}`, nodeId });
      else if (f.type === "list" && Array.isArray(v)) v.forEach((row) => walk(where, f.item, row, nodeId));
    }
  };
  eachElement(content, (e, where) => walk(`${where} › ${ELEMENT_DEFS[e.type].label}`, ELEMENT_DEFS[e.type].fields, e.props, e.id));
  return out;
}

/** Ids a link's #anchor can point at: sections and elements. */
function anchorIds(content: SiteContent): Set<string> {
  const ids = new Set<string>();
  const sec = (s: { id: string; columns: Array<{ elements: ElementNode[] }> }) => {
    ids.add(s.id);
    const el = (e: ElementNode) => {
      ids.add(e.id);
      e.children?.forEach(el);
    };
    s.columns.forEach((c) => c.elements.forEach(el));
  };
  if (content.header) sec(content.header);
  if (content.footer) sec(content.footer);
  Object.values(content.globals).forEach(sec);
  content.pages.forEach((p) => p.items.forEach((i) => !isRef(i) && sec(i)));
  return ids;
}

/** Images (with their node) used anywhere, to find illustrations standing in for real photographs and images with no description. */
function imageUses(content: SiteContent): Array<{ src: ImageSrc; nodeId: string; type: ElementNode["type"]; alt: string; where: string }> {
  const out: Array<{ src: ImageSrc; nodeId: string; type: ElementNode["type"]; alt: string; where: string }> = [];
  const walk = (e: ElementNode, fields: FieldSpec[], data: unknown, where: string) => {
    if (!data || typeof data !== "object") return;
    const rec = data as Record<string, unknown>;
    const alt = typeof rec.alt === "string" ? rec.alt : "";
    for (const f of fields) {
      const v = rec[f.key];
      if (f.type === "image") out.push({ src: v as ImageSrc, nodeId: e.id, type: e.type, alt, where });
      else if (f.type === "list" && Array.isArray(v)) v.forEach((row) => walk(e, f.item, row, where));
    }
  };
  eachElement(content, (e, where) => walk(e, ELEMENT_DEFS[e.type].fields, e.props, where));
  return out;
}

export function checkReadiness(content: SiteContent): Readiness {
  const blockers: Issue[] = [];
  const warnings: Issue[] = [];

  if (content.isSample) blockers.push({ code: "sample_content", message: "This is sample content from a template. Replace it with your own details first.", where: "Site" });

  const texts = collectTexts(content);
  for (const t of texts) {
    const ph = TOKEN.exec(t.value) ?? PLACEHOLDER.exec(t.value) ?? BRACKETS.exec(t.value);
    if (ph) blockers.push({ code: TOKEN.test(t.value) ? "unresolved_token" : "placeholder", message: `"${ph[0]}" looks like placeholder text. Replace it with your own words.`, where: t.where, match: ph[0], nodeId: t.nodeId });
  }

  // Testimonials are real customers' words, with their say-so, or they are not published.
  eachElement(content, (e, where) => {
    if (e.type !== "testimonials") return;
    const items = (e.props.items ?? []) as Array<{ quote: string; author: string; confirmedReal: boolean }>;
    items.forEach((t, i) => {
      if (t.quote && !t.confirmedReal) blockers.push({ code: "testimonial_unconfirmed", message: "Confirm this is a real customer's words and that they agreed to its use, or remove it.", where: `${where} › Testimonials › #${i + 1}`, nodeId: e.id });
      if (t.quote && !t.author.trim()) blockers.push({ code: "testimonial_unattributed", message: "A testimonial needs the customer's name (a first name and initial is fine).", where: `${where} › Testimonials › #${i + 1}`, nodeId: e.id });
    });
    if (!items.length) blockers.push({ code: "testimonials_empty", message: "This testimonials block has nothing in it. Add a real one or delete it.", where: `${where} › Testimonials`, nodeId: e.id });
  });

  // Links must go somewhere.
  const slugs = new Set(content.pages.map((p) => p.slug));
  const anchors = anchorIds(content);
  for (const l of collectLinks(content)) {
    if (l.href.startsWith("/")) {
      const [path, hash] = l.href.split("#");
      const slug = path === "/" || path === "" ? "home" : path.slice(1);
      if (!slugs.has(slug)) blockers.push({ code: "link_missing_page", message: `This link goes to a page that doesn't exist (${l.href}). Choose one of your pages.`, where: l.where, match: l.href, nodeId: l.nodeId });
      else if (hash && !anchors.has(hash)) warnings.push({ code: "link_missing_anchor", message: `This link points at a spot on the page that no longer exists (#${hash}).`, where: l.where, match: l.href, nodeId: l.nodeId });
    } else if (l.href.startsWith("#") && !anchors.has(l.href.slice(1))) {
      warnings.push({ code: "link_missing_anchor", message: `This link points at a spot on the page that no longer exists (${l.href}).`, where: l.where, match: l.href, nodeId: l.nodeId });
    }
  }

  // Forms must work.
  let formEls = 0;
  eachElement(content, (e) => {
    if (e.type === "form") formEls += 1;
  });
  if (formEls > 0 && !content.form.enabled) blockers.push({ code: "form_disabled", message: "A page shows an enquiry form, but enquiries are switched off in Site settings. Visitors would be unable to send it.", where: "Form" });
  if (!content.business.phone && !content.business.email && !(content.form.enabled && formEls > 0)) {
    blockers.push({ code: "no_contact", message: "Visitors need a way to reach you: add a phone number, an email address, or put an enquiry form on a page.", where: "Business" });
  }
  if (content.form.enabled && formEls === 0) warnings.push({ code: "form_not_shown", message: "Enquiries are on, but no page shows the form. Add an enquiry form to a page.", where: "Form" });

  const home = content.pages.find((p) => p.slug === "home") ?? content.pages[0];
  const homeHasHero = home.items.some((i) => {
    const s = resolveItem(content, i);
    return s && !s.hidden && s.columns.some((c) => c.elements.some((e) => e.type === "heading"));
  });
  if (!homeHasHero) warnings.push({ code: "no_hero", message: "Your home page has no headline, so visitors won't see what you do straight away.", where: "Home" });
  if (!content.seo.description) warnings.push({ code: "no_meta", message: "Add a short description so search engines can describe your site.", where: "Search" });

  // Pictures. A drawn illustration is honest artwork, not a photo of the owner's work, team or places.
  const noAlt = new Set<string>();
  // One note per element, however many pictures it holds (a services section with three picture cards is one thing to fix, not three).
  const noted = new Set<string>();
  for (const u of imageUses(content)) {
    if (u.src && u.src.kind === "art" && artKind(u.src.scene) === "illustration" && !noted.has(u.nodeId)) {
      noted.add(u.nodeId);
      if (u.type === "gallery" || u.type === "collage" || u.type === "team" || u.type === "testimonials") {
        blockers.push({ code: "illustration_as_proof", message: "This shows built-in artwork where visitors expect a real photo of your work or people. Replace it with your own image.", where: u.where, nodeId: u.nodeId });
      } else {
        warnings.push({ code: "illustration_in_use", message: "This uses a built-in illustration rather than your own photograph. Replace it with your own image, or keep the artwork if you prefer.", where: u.where, nodeId: u.nodeId });
      }
    }
    if (u.src && u.type === "image" && !u.alt.trim() && !noAlt.has(u.nodeId)) {
      noAlt.add(u.nodeId);
      warnings.push({ code: "image_alt_missing", message: "Describe this image for visitors who use a screen reader (or leave it empty only if it is purely decorative).", where: u.where, nodeId: u.nodeId });
    }
  }
  const sectionBgIllustrations: string[] = [];
  const bgCheck = (name: string, s: { bg: { kind: string; src?: ImageSrc } }) => {
    if (s.bg.kind === "image" && s.bg.src && s.bg.src.kind === "art" && artKind(s.bg.src.scene) === "illustration") sectionBgIllustrations.push(name);
  };
  if (content.header) bgCheck("Header", content.header);
  content.pages.forEach((p) => p.items.forEach((i) => !isRef(i) && bgCheck(p.title, i)));
  for (const w of new Set(sectionBgIllustrations)) {
    warnings.push({ code: "illustration_in_use", message: "A background on this page uses a built-in illustration rather than your own photograph. Replace it with your own image, or keep the artwork if you prefer.", where: w });
  }

  if (eachHas(content, "stats")) warnings.push({ code: "claim_figure", message: "Your site shows figures. Check each one is accurate today.", where: "Numbers" });

  const seen = new Set<string>();
  for (const t of texts) {
    for (const c of CLAIMS) {
      const m = c.re.exec(t.value);
      if (!m) continue;
      const key = `${c.code}:${t.where}:${m[0].toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      warnings.push({ code: c.code, message: c.message(m[0]), where: t.where, match: m[0], nodeId: t.nodeId });
    }
  }
  return { blockers, warnings };
}

function eachHas(content: SiteContent, type: ElementNode["type"]): boolean {
  let found = false;
  eachElement(content, (e) => {
    if (e.type === type) found = true;
  });
  return found;
}

/** What the owner must acknowledge before publishing: every distinct kind of unverifiable claim, and the use of built-in artwork. */
export const warningNeedsAcknowledgement = (w: Issue) => w.code.startsWith("claim_") || w.code === "illustration_in_use";
