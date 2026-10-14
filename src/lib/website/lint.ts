// Checks a site before it can go live. Blockers can never be published; warnings are claims we cannot verify,
// so the owner must read them and explicitly confirm. We never publish fabricated testimonials, placeholder
// text or sample content, and we make unverifiable claims visible rather than silently shipping them.
import { SECTION_DEFS, type FieldSpec } from "./sections";
import type { SiteContent } from "./schema";

export interface Issue {
  code: string;
  message: string;
  where: string;
  /** The words that triggered a claim warning, so the owner can see exactly what we mean. */
  match?: string;
}
export interface Readiness {
  blockers: Issue[];
  warnings: Issue[];
}

const PLACEHOLDER = /\b(lorem ipsum|sample customer|todo|placeholder|your (business|realty|clinic|practice|agency|shop|consultancy|local business|home services)|example\.(com|org)|insert (name|text))\b/i;
const BRACKETS = /\[[^\]]{1,40}\]/;

const CLAIMS: Array<{ code: string; re: RegExp; message: (m: string) => string }> = [
  { code: "claim_superlative", re: /\b(award[- ]?winning|award winner|best[- ]in[- ]class|best (?:in|of) (?:the )?[a-z]+|#\s?1|number[- ]one|no\.? ?1|top[- ]rated|top[- ]ranked|market[- ]leading|world[- ]class|unrivall?ed|finest|premier)\b/i, message: (m) => `"${m}" is a claim you'll need to be able to prove.` },
  { code: "claim_guarantee", re: /\b(guarantee[ds]?|money[- ]back|risk[- ]free|100\s?%)/i, message: (m) => `"${m}" promises an outcome. Only keep it if it's in your written terms.` },
  { code: "claim_credential", re: /\b(certified|accredited|licen[sc]ed|insured|bonded|approved by|endorsed by|registered with)\b/i, message: (m) => `"${m}" claims a credential. Only publish it if you hold it and can show it.` },
  { code: "claim_figure", re: /\b\d[\d,]*\+?\s+(?:years?|customers|clients|patients|homes|projects|reviews|five[- ]star)\b|\bsince\s+(?:19|20)\d{2}\b/i, message: (m) => `"${m}" is a figure. Check it's accurate today.` },
  { code: "claim_reviews", re: /\b(?:5|five)[- ]star\b|\bhighly rated\b|\bthousands of (?:happy|satisfied)\b/i, message: (m) => `"${m}" refers to reviews or ratings. Only keep it if it matches real, current reviews.` },
  { code: "claim_health", re: /\b(cures?|cured|heals?|clinically proven|doctor[- ]recommended|pain[- ]free)\b/i, message: (m) => `"${m}" is a health claim that may be regulated where you operate.` },
];

interface Text { where: string; value: string }

function collect(content: SiteContent): Text[] {
  const out: Text[] = [];
  const add = (where: string, value: unknown) => {
    if (typeof value === "string" && value.trim()) out.push({ where, value });
  };
  const b = content.business;
  add("Business › Name", b.name); add("Business › Tagline", b.tagline); add("Business › Address", b.address); add("Business › Hours", b.hours); add("Business › Email", b.email);
  add("Search › Title", content.seo.title); add("Search › Description", content.seo.description);
  add("Form › Success message", content.form.successMessage); add("Form › Consent", content.form.consentText); add("Footer › Note", content.footer.note);
  const walk = (where: string, fields: FieldSpec[], data: unknown) => {
    if (!data || typeof data !== "object") return;
    const rec = data as Record<string, unknown>;
    for (const f of fields) {
      const v = rec[f.key];
      const label = `${where} › ${f.label}`;
      if (f.type === "text" || f.type === "longtext") add(label, v);
      else if (f.type === "link") add(label, (v as { label?: string } | undefined)?.label);
      else if (f.type === "textlist" && Array.isArray(v)) v.forEach((t, i) => add(`${label} #${i + 1}`, t));
      else if (f.type === "list" && Array.isArray(v)) v.forEach((row, i) => walk(`${label} #${i + 1}`, f.item, row));
    }
  };
  for (const page of content.pages) {
    add(`${page.title} › Page title`, page.title); add(`${page.title} › Search title`, page.seoTitle); add(`${page.title} › Search description`, page.seoDescription);
    for (const s of page.sections) walk(`${page.title} › ${SECTION_DEFS[s.type].label}`, SECTION_DEFS[s.type].fields, s.data);
  }
  return out;
}

export function checkReadiness(content: SiteContent): Readiness {
  const blockers: Issue[] = [];
  const warnings: Issue[] = [];

  if (content.isSample) blockers.push({ code: "sample_content", message: "This is sample content from a template. Replace it with your own details first.", where: "Site" });

  const texts = collect(content);
  for (const t of texts) {
    const ph = PLACEHOLDER.exec(t.value) ?? BRACKETS.exec(t.value);
    if (ph) blockers.push({ code: "placeholder", message: `"${ph[0]}" looks like placeholder text. Replace it with your own words.`, where: t.where, match: ph[0] });
  }

  for (const page of content.pages) {
    for (const s of page.sections) {
      if (s.type !== "testimonials") continue;
      const items = (s.data as { items: Array<{ quote: string; author: string; confirmedReal: boolean }> }).items;
      items.forEach((t, i) => {
        if (t.quote && !t.confirmedReal) blockers.push({ code: "testimonial_unconfirmed", message: "Confirm this is a real customer's words and that they agreed to its use, or remove it.", where: `${page.title} › Testimonials › #${i + 1}` });
        if (t.quote && !t.author.trim()) blockers.push({ code: "testimonial_unattributed", message: "A testimonial needs the customer's name (a first name and initial is fine).", where: `${page.title} › Testimonials › #${i + 1}` });
      });
      if (!items.length) blockers.push({ code: "testimonials_empty", message: "This testimonials section has nothing in it. Add a real one or delete the section.", where: `${page.title} › Testimonials` });
    }
  }

  const home = content.pages.find((p) => p.slug === "home");
  const heroOk = home?.sections.some((s) => s.type === "hero" && !s.hidden);
  if (!heroOk) warnings.push({ code: "no_hero", message: "Your home page has no hero section, so visitors won't see a headline straight away.", where: "Home" });
  if (!content.business.phone && !content.business.email && !content.form.enabled) blockers.push({ code: "no_contact", message: "Visitors need a way to reach you: add a phone number, an email address, or switch the enquiry form on.", where: "Business" });
  const formShown = content.pages.some((p) => p.sections.some((s) => s.type === "contact" && !s.hidden && (s.data as { showForm: boolean }).showForm));
  if (content.form.enabled && !formShown) warnings.push({ code: "form_not_shown", message: "The enquiry form is on, but no page shows it. Add a Contact section.", where: "Form" });
  if (!content.seo.description) warnings.push({ code: "no_meta", message: "Add a short description so search engines can describe your site.", where: "Search" });

  if (content.pages.some((p) => p.sections.some((s) => s.type === "stats" && !s.hidden))) {
    warnings.push({ code: "claim_figure", message: "Your site shows figures. Check each one is accurate today.", where: "Numbers section" });
  }
  const seen = new Set<string>();
  for (const t of texts) {
    for (const c of CLAIMS) {
      const m = c.re.exec(t.value);
      if (!m) continue;
      const key = `${c.code}:${t.where}:${m[0].toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      warnings.push({ code: c.code, message: c.message(m[0]), where: t.where, match: m[0] });
    }
  }
  return { blockers, warnings };
}

/** What the owner must acknowledge before publishing: every distinct kind of unverifiable claim. */
export const warningNeedsAcknowledgement = (w: Issue) => w.code.startsWith("claim_");
