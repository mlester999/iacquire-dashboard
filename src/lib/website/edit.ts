// Pure editing operations for website content. The editor calls these and the server validates the result again, so
// the interface can be simple and the rules (unique ids, unique slugs, one home page) stay in one tested place.
import { LIMITS, RESERVED_SLUGS, newSection, type SiteContent, type SitePage, type SiteSection } from "./schema";
import { SECTION_DEFS, emptyListItem, type FieldSpec, type SectionType } from "./sections";

const clone = <T,>(v: T): T => structuredClone(v);

export function uniqueSectionId(content: SiteContent, type: SectionType): string {
  const used = new Set(content.pages.flatMap((p) => p.sections.map((s) => s.id)));
  for (let n = 1; n < 1000; n += 1) {
    const id = `${type.toLowerCase()}-${n}`;
    if (!used.has(id)) return id;
  }
  return `${type.toLowerCase()}-${Date.now().toString(36)}`;
}

export function slugFromTitle(title: string): string {
  return title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
}

export function uniqueSlug(content: SiteContent, wanted: string): string {
  const base = slugFromTitle(wanted) || "page";
  const taken = new Set([...content.pages.map((p) => p.slug), ...RESERVED_SLUGS]);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base.slice(0, 36)}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base.slice(0, 30)}-${Date.now().toString(36)}`;
}

const mapPage = (content: SiteContent, slug: string, fn: (page: SitePage) => SitePage): SiteContent => ({ ...content, pages: content.pages.map((p) => (p.slug === slug ? fn(p) : p)) });

export function setSectionField(content: SiteContent, pageSlug: string, sectionId: string, key: string, value: unknown): SiteContent {
  return mapPage(content, pageSlug, (p) => ({ ...p, sections: p.sections.map((s) => (s.id === sectionId ? { ...s, data: { ...s.data, [key]: value } } : s)) }));
}

export function setSectionData(content: SiteContent, pageSlug: string, sectionId: string, data: Record<string, unknown>): SiteContent {
  return mapPage(content, pageSlug, (p) => ({ ...p, sections: p.sections.map((s) => (s.id === sectionId ? { ...s, data } : s)) }));
}

export function toggleSectionHidden(content: SiteContent, pageSlug: string, sectionId: string): SiteContent {
  return mapPage(content, pageSlug, (p) => ({ ...p, sections: p.sections.map((s) => (s.id === sectionId ? { ...s, hidden: !s.hidden } : s)) }));
}

export function moveSection(content: SiteContent, pageSlug: string, sectionId: string, direction: -1 | 1): SiteContent {
  return mapPage(content, pageSlug, (p) => {
    const i = p.sections.findIndex((s) => s.id === sectionId);
    const j = i + direction;
    if (i < 0 || j < 0 || j >= p.sections.length) return p;
    const sections = [...p.sections];
    [sections[i], sections[j]] = [sections[j], sections[i]];
    return { ...p, sections };
  });
}

export function removeSection(content: SiteContent, pageSlug: string, sectionId: string): SiteContent {
  return mapPage(content, pageSlug, (p) => ({ ...p, sections: p.sections.filter((s) => s.id !== sectionId) }));
}

/** Adds a section after `afterId` (or at the end). Returns the new content and the new section's id, or null if it isn't allowed. */
export function addSection(content: SiteContent, pageSlug: string, type: SectionType, afterId?: string): { content: SiteContent; id: string } | null {
  const page = content.pages.find((p) => p.slug === pageSlug);
  if (!page || page.sections.length >= LIMITS.sectionsPerPage) return null;
  if (!SECTION_DEFS[type].repeatable && page.sections.some((s) => s.type === type)) return null;
  const id = uniqueSectionId(content, type);
  const section = newSection(type, id);
  const next = mapPage(content, pageSlug, (p) => {
    const at = afterId ? p.sections.findIndex((s) => s.id === afterId) : -1;
    const sections = [...p.sections];
    sections.splice(at === -1 ? sections.length : at + 1, 0, section);
    return { ...p, sections };
  });
  return { content: next, id };
}

export function sectionTypesAvailable(page: SitePage): SectionType[] {
  return (Object.keys(SECTION_DEFS) as SectionType[]).filter((t) => SECTION_DEFS[t].repeatable || !page.sections.some((s) => s.type === t));
}

export function addPage(content: SiteContent, title: string): { content: SiteContent; slug: string } | null {
  if (content.pages.length >= LIMITS.pages) return null;
  const clean = title.trim().slice(0, 60);
  if (!clean) return null;
  const slug = uniqueSlug(content, clean);
  const page: SitePage = {
    slug, title: clean, navLabel: clean.slice(0, 30), showInNav: true, seoTitle: "", seoDescription: "",
    sections: [{ ...newSection("richText", uniqueSectionId(content, "richText")), data: { heading: clean, body: "" } }],
  };
  return { content: { ...content, pages: [...content.pages, page] }, slug };
}

export function updatePage(content: SiteContent, slug: string, patch: Partial<Pick<SitePage, "title" | "navLabel" | "showInNav" | "seoTitle" | "seoDescription">>): SiteContent {
  return mapPage(content, slug, (p) => ({ ...p, ...patch }));
}

export function removePage(content: SiteContent, slug: string): SiteContent | null {
  if (slug === "home" || content.pages.length <= 1) return null;
  return { ...content, pages: content.pages.filter((p) => p.slug !== slug) };
}

export function movePage(content: SiteContent, slug: string, direction: -1 | 1): SiteContent {
  const i = content.pages.findIndex((p) => p.slug === slug);
  const j = i + direction;
  // The home page always stays first.
  if (i < 0 || j < 1 || j >= content.pages.length || slug === "home") return content;
  const pages = [...content.pages];
  [pages[i], pages[j]] = [pages[j], pages[i]];
  return { ...content, pages };
}

// ---------------------------------------------------------------------------
// List fields
// ---------------------------------------------------------------------------

export function addListRow(field: Extract<FieldSpec, { type: "list" }>, rows: unknown[]): unknown[] {
  return rows.length >= field.max ? rows : [...rows, emptyListItem(field)];
}
export function moveRow<T>(rows: T[], index: number, direction: -1 | 1): T[] {
  const j = index + direction;
  if (j < 0 || j >= rows.length) return rows;
  const next = [...rows];
  [next[index], next[j]] = [next[j], next[index]];
  return next;
}
export const removeRow = <T,>(rows: T[], index: number): T[] => rows.filter((_, i) => i !== index);

/** Where in the content a section lives, for jumping to it from the preview. */
export function findSection(content: SiteContent, sectionId: string): { page: SitePage; section: SiteSection } | null {
  for (const page of content.pages) {
    const section = page.sections.find((s) => s.id === sectionId);
    if (section) return { page, section };
  }
  return null;
}

export const cloneContent = clone;
