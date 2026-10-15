// A plain-language comparison of two versions of a site, used for version history, review, publishing and the AI assistant's
// "here is what I would change". It works from stable node ids, so a section that was only moved is reported as moved, not as removed and added.
import { ELEMENT_DEFS } from "../catalog";
import { isRef, type ElementNode, type Section, type SiteContent } from "../doc";
import { describeNode, indexDoc, type NodeRef } from "../ops";
import { plainText } from "../markup";

export type ChangeKind = "added" | "removed" | "changed" | "moved";
export interface Change {
  kind: ChangeKind;
  scope: "site" | "design" | "page" | "section" | "element";
  /** The node to select in the editor, when there is one. */
  id?: string;
  label: string;
  /** Where it lives, for context. */
  where?: string;
}
export interface DocDiff {
  changes: Change[];
  /** Short sentences, most important first, ready to show a person. */
  summary: string[];
  counts: Record<ChangeKind, number>;
}

const json = (v: unknown) => JSON.stringify(v ?? null);

function sectionBare(s: Section) {
  const { columns, ...rest } = s;
  void columns;
  return rest;
}
function elementBare(e: ElementNode) {
  const { children, ...rest } = e;
  void children;
  return rest;
}

function allSections(doc: SiteContent): Map<string, { sec: Section; where: string }> {
  const m = new Map<string, { sec: Section; where: string }>();
  if (doc.header) m.set(doc.header.id, { sec: doc.header, where: "Header" });
  if (doc.footer) m.set(doc.footer.id, { sec: doc.footer, where: "Footer" });
  for (const s of Object.values(doc.globals)) m.set(s.id, { sec: s, where: "Shared section" });
  for (const p of doc.pages) for (const i of p.items) if (!isRef(i)) m.set(i.id, { sec: i, where: p.title });
  return m;
}
function allElements(doc: SiteContent): Map<string, { el: ElementNode; where: string }> {
  const m = new Map<string, { el: ElementNode; where: string }>();
  for (const { sec, where } of allSections(doc).values()) {
    const walk = (list: ElementNode[]) =>
      list.forEach((e) => {
        m.set(e.id, { el: e, where });
        if (e.children) walk(e.children);
      });
    sec.columns.forEach((c) => walk(c.elements));
  }
  return m;
}

const elLabel = (e: ElementNode) => {
  const t = typeof e.props.text === "string" ? plainText(e.props.text) : e.type === "button" ? String((e.props.link as { label?: string } | undefined)?.label ?? "") : "";
  return t ? `${ELEMENT_DEFS[e.type].label} “${t.slice(0, 40)}”` : ELEMENT_DEFS[e.type].label;
};

export function diffDocs(a: SiteContent, b: SiteContent): DocDiff {
  const changes: Change[] = [];
  const ia = indexDoc(a);
  const ib = indexDoc(b);

  // Site-level settings
  if (json(a.business) !== json(b.business)) changes.push({ kind: "changed", scope: "site", label: "Business details" });
  if (json(a.seo) !== json(b.seo)) changes.push({ kind: "changed", scope: "site", label: "Search and sharing settings" });
  if (json(a.social) !== json(b.social)) changes.push({ kind: "changed", scope: "site", label: "Social links" });
  if (json(a.form) !== json(b.form)) changes.push({ kind: "changed", scope: "site", label: "Enquiry form settings" });
  if (json(a.brand) !== json(b.brand)) changes.push({ kind: "changed", scope: "site", label: "Logo" });
  const keys = new Set([...Object.keys(a.design), ...Object.keys(b.design)] as Array<keyof typeof a.design>);
  const designChanged: string[] = [];
  for (const k of keys) if (json(a.design[k]) !== json(b.design[k])) designChanged.push(k === "colors" ? "colours" : k === "fonts" ? "fonts" : k === "buttons" ? "buttons" : k === "radius" ? "corner roundness" : k === "scale" ? "text size scale" : k === "spacing" ? "spacing" : k === "shadow" ? "shadows" : String(k));
  if (designChanged.length) changes.push({ kind: "changed", scope: "design", label: `Design: ${designChanged.join(", ")}` });

  // Pages
  for (const p of b.pages) {
    const old = a.pages.find((x) => x.id === p.id);
    if (!old) changes.push({ kind: "added", scope: "page", id: p.id, label: `Page “${p.title}”` });
    else if (json({ ...old, items: 0 }) !== json({ ...p, items: 0 })) changes.push({ kind: "changed", scope: "page", id: p.id, label: `Page settings for “${p.title}”` });
  }
  for (const p of a.pages) if (!b.pages.some((x) => x.id === p.id)) changes.push({ kind: "removed", scope: "page", label: `Page “${p.title}”` });
  if (json(a.pages.map((p) => p.id)) !== json(b.pages.map((p) => p.id)) && a.pages.length === b.pages.length) changes.push({ kind: "moved", scope: "page", label: "Page order" });

  // Sections
  const sa = allSections(a);
  const sb = allSections(b);
  for (const [id, { sec, where }] of sb) {
    const old = sa.get(id);
    if (!old) {
      changes.push({ kind: "added", scope: "section", id, label: describeNode(b, id), where });
      continue;
    }
    if (json(sectionBare(old.sec)) !== json(sectionBare(sec)) || json(old.sec.columns.map((c) => { const { elements, ...r } = c; void elements; return r; })) !== json(sec.columns.map((c) => { const { elements, ...r } = c; void elements; return r; }))) {
      changes.push({ kind: "changed", scope: "section", id, label: `${describeNode(b, id)} layout or style`, where });
    }
    const ra: NodeRef | undefined = ia.get(id);
    const rb: NodeRef | undefined = ib.get(id);
    if (ra && rb && (ra.parentId !== rb.parentId || ra.index !== rb.index) && ra.home?.type === "page" && rb.home?.type === "page") changes.push({ kind: "moved", scope: "section", id, label: describeNode(b, id), where });
  }
  for (const [id, { sec, where }] of sa) if (!sb.has(id)) changes.push({ kind: "removed", scope: "section", label: describeNode(a, id) || sec.name || "Section", where });

  // Elements
  const ea = allElements(a);
  const eb = allElements(b);
  for (const [id, { el, where }] of eb) {
    const old = ea.get(id);
    if (!old) {
      // An element inside a brand-new section is covered by that section.
      const sec = ib.get(id)?.sectionId;
      if (sec && sa.has(sec)) changes.push({ kind: "added", scope: "element", id, label: elLabel(el), where });
      continue;
    }
    if (json(elementBare(old.el)) !== json(elementBare(el))) changes.push({ kind: "changed", scope: "element", id, label: elLabel(el), where });
    const ra = ia.get(id);
    const rb = ib.get(id);
    if (ra && rb && ra.parentId !== rb.parentId && sa.has(rb.sectionId ?? "")) changes.push({ kind: "moved", scope: "element", id, label: elLabel(el), where });
  }
  for (const [id, { el, where }] of ea) {
    if (eb.has(id)) continue;
    const sec = ia.get(id)?.sectionId;
    if (sec && sb.has(sec)) changes.push({ kind: "removed", scope: "element", label: elLabel(el), where });
  }

  const counts: Record<ChangeKind, number> = { added: 0, removed: 0, changed: 0, moved: 0 };
  for (const c of changes) counts[c.kind] += 1;
  const verb: Record<ChangeKind, string> = { added: "Added", removed: "Removed", changed: "Changed", moved: "Moved" };
  const summary = changes.slice(0, 40).map((c) => `${verb[c.kind]} ${c.label}${c.where ? ` (${c.where})` : ""}`);
  return { changes, summary, counts };
}

export const hasChanges = (d: DocDiff) => d.changes.length > 0;
