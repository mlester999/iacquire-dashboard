// Pure operations on a website document. Every function returns a new document (sharing whatever did not change), so undo and redo
// are simply "go back to the previous document", and the editor, the AI assistant and the tests all change a site the same way.
import { CONTAINER_TYPES, ELEMENT_DEFS, MAX_CONTAINER_DEPTH, type ElementType } from "./catalog";
import {
  LIMITS, NODE_ID, collectIds, isRef, type Column, type Design, type ElementNode, type NodeStyle, type Override, type Page, type PageItem, type Section, type SectionRef, type SiteContent,
} from "./doc";
import { plainText } from "./markup";

export type NodeKind = "section" | "column" | "element" | "page" | "ref";

export interface NodeRef {
  kind: NodeKind;
  id: string;
  /** The id of whatever holds it: a page (for sections), a section, a column or a container. Null for pages. */
  parentId: string | null;
  index: number;
  /** The section it lives in (or is). */
  sectionId: string | null;
  /** Where its section lives. */
  home: { type: "header" } | { type: "footer" } | { type: "global"; key: string } | { type: "page"; pageId: string } | null;
  depth: number;
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

export function indexDoc(doc: SiteContent): Map<string, NodeRef> {
  const map = new Map<string, NodeRef>();
  const walkEls = (els: ElementNode[], parentId: string, sectionId: string, home: NodeRef["home"], depth: number) =>
    els.forEach((e, i) => {
      map.set(e.id, { kind: "element", id: e.id, parentId, index: i, sectionId, home, depth });
      if (e.children) walkEls(e.children, e.id, sectionId, home, depth + 1);
    });
  const walkSec = (s: Section, parentId: string | null, index: number, home: NodeRef["home"]) => {
    map.set(s.id, { kind: "section", id: s.id, parentId, index, sectionId: s.id, home, depth: 0 });
    s.columns.forEach((c, ci) => {
      map.set(c.id, { kind: "column", id: c.id, parentId: s.id, index: ci, sectionId: s.id, home, depth: 0 });
      walkEls(c.elements, c.id, s.id, home, 1);
    });
  };
  if (doc.header) walkSec(doc.header, null, 0, { type: "header" });
  if (doc.footer) walkSec(doc.footer, null, 0, { type: "footer" });
  for (const [key, s] of Object.entries(doc.globals)) walkSec(s, null, 0, { type: "global", key });
  for (const p of doc.pages) {
    map.set(p.id, { kind: "page", id: p.id, parentId: null, index: doc.pages.indexOf(p), sectionId: null, home: null, depth: 0 });
    p.items.forEach((item, i) => {
      if (isRef(item)) map.set(item.id, { kind: "ref", id: item.id, parentId: p.id, index: i, sectionId: null, home: { type: "page", pageId: p.id }, depth: 0 });
      else walkSec(item, p.id, i, { type: "page", pageId: p.id });
    });
  }
  return map;
}

export const findNode = (doc: SiteContent, id: string): NodeRef | null => indexDoc(doc).get(id) ?? null;

/** The section a node belongs to, resolving a reference to the shared section it points at. */
export function sectionOf(doc: SiteContent, id: string): Section | null {
  const ref = findNode(doc, id);
  if (!ref) return null;
  if (ref.kind === "ref") {
    const item = doc.pages.flatMap((p) => p.items).find((i) => i.id === id);
    return item && isRef(item) ? (doc.globals[item.ref] ?? null) : null;
  }
  if (!ref.sectionId) return null;
  return getSection(doc, ref.sectionId);
}

export function getSection(doc: SiteContent, id: string): Section | null {
  if (doc.header?.id === id) return doc.header;
  if (doc.footer?.id === id) return doc.footer;
  for (const s of Object.values(doc.globals)) if (s.id === id) return s;
  for (const p of doc.pages) for (const i of p.items) if (!isRef(i) && i.id === id) return i;
  return null;
}
export function getColumn(doc: SiteContent, id: string): Column | null {
  const r = findNode(doc, id);
  if (!r || r.kind !== "column") return null;
  return getSection(doc, r.sectionId!)?.columns.find((c) => c.id === id) ?? null;
}
export function getElement(doc: SiteContent, id: string): ElementNode | null {
  const r = findNode(doc, id);
  if (!r || r.kind !== "element" || !r.sectionId) return null;
  const find = (els: ElementNode[]): ElementNode | null => {
    for (const e of els) {
      if (e.id === id) return e;
      const k = e.children ? find(e.children) : null;
      if (k) return k;
    }
    return null;
  };
  const sec = getSection(doc, r.sectionId);
  if (!sec) return null;
  for (const c of sec.columns) {
    const hit = find(c.elements);
    if (hit) return hit;
  }
  return null;
}
export const getPage = (doc: SiteContent, id: string): Page | null => doc.pages.find((p) => p.id === id) ?? null;

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
export function newId(doc: SiteContent | Set<string>, prefix = "n"): string {
  const used = doc instanceof Set ? doc : new Set(collectIds(doc));
  const p = prefix.replace(/[^a-z]/g, "").slice(0, 3) || "n";
  for (let i = 0; i < 200; i += 1) {
    let tail = "";
    for (let k = 0; k < 5; k += 1) tail += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    const id = `${p}${tail}`;
    if (NODE_ID.test(id) && !used.has(id)) {
      if (doc instanceof Set) doc.add(id);
      return id;
    }
  }
  throw new Error("Could not allocate an id");
}

/** A deep copy of a node with every id replaced by a fresh one. */
export function cloneWithNewIds<T extends Section | Column | ElementNode>(node: T, used: Set<string>): T {
  const fresh = (id: string) => newId(used, id.replace(/[^a-z]/g, "").slice(0, 2) || "n");
  const el = (e: ElementNode): ElementNode => ({ ...e, id: fresh("e"), props: structuredClone(e.props), ...(e.children ? { children: e.children.map(el) } : {}) });
  const col = (c: Column): Column => ({ ...structuredClone({ ...c, elements: [] as ElementNode[] }), id: fresh("c"), elements: c.elements.map(el) });
  if ("columns" in node) return { ...structuredClone({ ...node, columns: [] as Column[] }), id: fresh("s"), columns: node.columns.map(col) } as T;
  if ("elements" in node) return col(node as Column) as T;
  return el(node as ElementNode) as T;
}

// ---------------------------------------------------------------------------
// Generic updaters
// ---------------------------------------------------------------------------

function mapSections(doc: SiteContent, fn: (s: Section) => Section | undefined): SiteContent {
  let changed = false;
  const apply = (s: Section): Section => {
    const out = fn(s);
    if (out && out !== s) {
      changed = true;
      return out;
    }
    return s;
  };
  const header = doc.header ? apply(doc.header) : doc.header;
  const footer = doc.footer ? apply(doc.footer) : doc.footer;
  const globals = Object.fromEntries(Object.entries(doc.globals).map(([k, s]) => [k, apply(s)]));
  const pages = doc.pages.map((p) => {
    let pageChanged = false;
    const items = p.items.map((i) => {
      if (isRef(i)) return i;
      const out = apply(i);
      if (out !== i) pageChanged = true;
      return out;
    });
    return pageChanged ? { ...p, items } : p;
  });
  return changed ? { ...doc, header, footer, globals, pages } : doc;
}

export const updateSection = (doc: SiteContent, id: string, fn: (s: Section) => Section): SiteContent => mapSections(doc, (s) => (s.id === id ? fn(s) : undefined));

export function updateColumn(doc: SiteContent, id: string, fn: (c: Column) => Column): SiteContent {
  return mapSections(doc, (s) => {
    if (!s.columns.some((c) => c.id === id)) return undefined;
    return { ...s, columns: s.columns.map((c) => (c.id === id ? fn(c) : c)) };
  });
}

function mapElements(els: ElementNode[], id: string, fn: (e: ElementNode) => ElementNode): ElementNode[] {
  let changed = false;
  const out = els.map((e) => {
    if (e.id === id) {
      changed = true;
      return fn(e);
    }
    if (e.children) {
      const kids = mapElements(e.children, id, fn);
      if (kids !== e.children) {
        changed = true;
        return { ...e, children: kids };
      }
    }
    return e;
  });
  return changed ? out : els;
}

export function updateElement(doc: SiteContent, id: string, fn: (e: ElementNode) => ElementNode): SiteContent {
  return mapSections(doc, (s) => {
    let changed = false;
    const columns = s.columns.map((c) => {
      const els = mapElements(c.elements, id, fn);
      if (els !== c.elements) {
        changed = true;
        return { ...c, elements: els };
      }
      return c;
    });
    return changed ? { ...s, columns } : undefined;
  });
}

/** Sets a value deep inside a plain object or array, copying only the path. Missing numeric steps create arrays. */
export function setIn<T>(target: T, path: Array<string | number>, value: unknown): T {
  if (path.length === 0) return value as T;
  const [head, ...rest] = path;
  const src = (target ?? (typeof head === "number" ? [] : {})) as Record<string | number, unknown>;
  const next = Array.isArray(src) ? [...src] : { ...src };
  (next as Record<string | number, unknown>)[head] = setIn(src[head], rest, value);
  return next as T;
}

export const parsePath = (path: string): Array<string | number> => path.split(".").filter(Boolean).map((p) => (/^\d+$/.test(p) ? Number(p) : p));

export const setProp = (doc: SiteContent, id: string, path: string | Array<string | number>, value: unknown): SiteContent =>
  updateElement(doc, id, (e) => ({ ...e, props: setIn(e.props, typeof path === "string" ? parsePath(path) : path, value) }));

export const patchProps = (doc: SiteContent, id: string, patch: Record<string, unknown>): SiteContent => updateElement(doc, id, (e) => ({ ...e, props: { ...e.props, ...patch } }));

/** Merges style keys; a key set to undefined is removed, so "reset to default" is just clearing it. */
function mergeDefined<T extends object>(base: T | undefined, patch: Partial<T>): T | undefined {
  const out = { ...(base ?? {}), ...patch } as Record<string, unknown>;
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return Object.keys(out).length ? (out as T) : undefined;
}

export function setStyle(doc: SiteContent, id: string, patch: Partial<NodeStyle>): SiteContent {
  return updateElement(doc, id, (e) => {
    const style = mergeDefined(e.style, patch);
    const { style: _drop, ...rest } = e;
    void _drop;
    return style ? { ...rest, style } : (rest as ElementNode);
  });
}

export function setResponsive(doc: SiteContent, id: string, screen: "t" | "m", patch: Partial<Override>): SiteContent {
  return updateElement(doc, id, (e) => {
    const cur = e.r?.[screen];
    const next = mergeDefined(cur, patch);
    const r = { ...(e.r ?? {}), ...(next ? { [screen]: next } : {}) };
    if (!next) delete (r as Record<string, unknown>)[screen];
    const { r: _drop, ...rest } = e;
    void _drop;
    return Object.keys(r).length ? { ...rest, r } : (rest as ElementNode);
  });
}

export const setHide = (doc: SiteContent, id: string, screen: "d" | "t" | "m", hidden: boolean): SiteContent =>
  updateElement(doc, id, (e) => {
    const hide = mergeDefined(e.hide, { [screen]: hidden ? true : undefined });
    const { hide: _drop, ...rest } = e;
    void _drop;
    return hide ? { ...rest, hide } : (rest as ElementNode);
  });

export const setDesign = (doc: SiteContent, patch: Partial<Design>): SiteContent => ({ ...doc, design: { ...doc.design, ...patch } });

// ---------------------------------------------------------------------------
// Structure: validity
// ---------------------------------------------------------------------------

/** How many container levels deep an element would sit inside, counting its own container if it has one. */
function containerDepth(el: ElementNode): number {
  if (!el.children?.length) return CONTAINER_TYPES.includes(el.type) ? 1 : 0;
  return 1 + Math.max(0, ...el.children.map(containerDepth));
}

export type DropCheck = { ok: true } | { ok: false; reason: string };

/** Whether a node may be moved under a parent (a page, a section, a column or a container element). */
export function canPlace(doc: SiteContent, nodeId: string, parentId: string): DropCheck {
  const idx = indexDoc(doc);
  const node = idx.get(nodeId);
  const parent = idx.get(parentId);
  if (!node || !parent) return { ok: false, reason: "That spot isn't available." };
  if (nodeId === parentId) return { ok: false, reason: "An item can't go inside itself." };
  // No cycles: the target must not be inside the node being moved.
  let up: NodeRef | undefined = parent;
  while (up) {
    if (up.id === nodeId) return { ok: false, reason: "An item can't go inside itself." };
    up = up.parentId ? idx.get(up.parentId) : undefined;
  }
  if (node.kind === "section" || node.kind === "ref") {
    if (parent.kind !== "page") return { ok: false, reason: "Sections go on a page." };
    return { ok: true };
  }
  if (node.kind === "column") {
    if (parent.kind !== "section") return { ok: false, reason: "Columns go inside a section." };
    const sec = getSection(doc, parent.id);
    if (sec && node.parentId !== parent.id && sec.columns.length >= LIMITS.columnsPerSection) return { ok: false, reason: `A section holds up to ${LIMITS.columnsPerSection} columns.` };
    return { ok: true };
  }
  if (node.kind === "element") {
    const el = getElement(doc, nodeId);
    if (!el) return { ok: false, reason: "That item wasn't found." };
    if (parent.kind === "column") {
      const col = getColumn(doc, parentId);
      if (col && node.parentId !== parentId && col.elements.length >= LIMITS.elementsPerColumn) return { ok: false, reason: "That column is full." };
      return { ok: true };
    }
    if (parent.kind === "element") {
      const host = getElement(doc, parentId);
      if (!host || !CONTAINER_TYPES.includes(host.type)) return { ok: false, reason: `${host ? ELEMENT_DEFS[host.type].label : "That item"} can't hold other items.` };
      if (parent.depth + containerDepth(el) > MAX_CONTAINER_DEPTH) return { ok: false, reason: "Cards and rows can be nested up to three levels deep." };
      if ((host.children?.length ?? 0) >= LIMITS.childrenPerContainer && node.parentId !== parentId) return { ok: false, reason: "That container is full." };
      return { ok: true };
    }
    return { ok: false, reason: "Elements go in a column or a card." };
  }
  return { ok: false, reason: "That can't be moved." };
}

/** Whether a brand-new element of this type may be dropped under a parent. */
export function canInsertElement(doc: SiteContent, type: ElementType, parentId: string): DropCheck {
  const idx = indexDoc(doc);
  const parent = idx.get(parentId);
  if (!parent) return { ok: false, reason: "That spot isn't available." };
  if (parent.kind === "column") {
    const col = getColumn(doc, parentId);
    return col && col.elements.length >= LIMITS.elementsPerColumn ? { ok: false, reason: "That column is full." } : { ok: true };
  }
  if (parent.kind === "element") {
    const host = getElement(doc, parentId);
    if (!host || !CONTAINER_TYPES.includes(host.type)) return { ok: false, reason: "That item can't hold other items." };
    if (parent.depth + (CONTAINER_TYPES.includes(type) ? 1 : 0) > MAX_CONTAINER_DEPTH) return { ok: false, reason: "Cards and rows can be nested up to three levels deep." };
    if ((host.children?.length ?? 0) >= LIMITS.childrenPerContainer) return { ok: false, reason: "That container is full." };
    return { ok: true };
  }
  return { ok: false, reason: "Elements go in a column or a card." };
}

// ---------------------------------------------------------------------------
// Structure: insert, remove, move
// ---------------------------------------------------------------------------

const clampIndex = (i: number, len: number) => Math.max(0, Math.min(len, i));

export function insertSection(doc: SiteContent, pageId: string, index: number, section: Section | SectionRef): SiteContent {
  return {
    ...doc,
    pages: doc.pages.map((p) => {
      if (p.id !== pageId) return p;
      const items = [...p.items];
      items.splice(clampIndex(index, items.length), 0, section);
      return { ...p, items };
    }),
  };
}

export function insertColumn(doc: SiteContent, sectionId: string, index: number, column: Column): SiteContent {
  return updateSection(doc, sectionId, (s) => {
    const columns = [...s.columns];
    columns.splice(clampIndex(index, columns.length), 0, column);
    return { ...s, columns };
  });
}

export function insertElement(doc: SiteContent, parentId: string, index: number, el: ElementNode): SiteContent {
  const parent = findNode(doc, parentId);
  if (!parent) return doc;
  if (parent.kind === "column") {
    return updateColumn(doc, parentId, (c) => {
      const elements = [...c.elements];
      elements.splice(clampIndex(index, elements.length), 0, el);
      return { ...c, elements };
    });
  }
  return updateElement(doc, parentId, (host) => {
    const children = [...(host.children ?? [])];
    children.splice(clampIndex(index, children.length), 0, el);
    return { ...host, children };
  });
}

/** Removes a node and returns the document without it. Removing the header or footer leaves the site without one. */
export function removeNode(doc: SiteContent, id: string): SiteContent {
  const ref = findNode(doc, id);
  if (!ref) return doc;
  if (ref.kind === "page") {
    if (doc.pages.length <= 1) return doc;
    const p = getPage(doc, id);
    if (p?.slug === "home") return doc;
    return { ...doc, pages: doc.pages.filter((x) => x.id !== id) };
  }
  if (ref.kind === "ref") return { ...doc, pages: doc.pages.map((p) => ({ ...p, items: p.items.filter((i) => i.id !== id) })) };
  if (ref.kind === "section") {
    if (ref.home?.type === "header") return { ...doc, header: null };
    if (ref.home?.type === "footer") return { ...doc, footer: null };
    if (ref.home?.type === "global") {
      // A shared section that is removed takes its references with it.
      const globals = { ...doc.globals };
      delete globals[ref.home.key];
      return { ...doc, globals, pages: doc.pages.map((p) => ({ ...p, items: p.items.filter((i) => !(isRef(i) && i.ref === (ref.home as { key: string }).key)) })) };
    }
    return { ...doc, pages: doc.pages.map((p) => (p.items.some((i) => i.id === id) ? { ...p, items: p.items.filter((i) => i.id !== id) } : p)) };
  }
  if (ref.kind === "column") return updateSection(doc, ref.sectionId!, (s) => ({ ...s, columns: s.columns.filter((c) => c.id !== id) }));
  // element
  const parent = ref.parentId ? findNode(doc, ref.parentId) : null;
  if (parent?.kind === "column") return updateColumn(doc, parent.id, (c) => ({ ...c, elements: c.elements.filter((e) => e.id !== id) }));
  if (parent?.kind === "element") return updateElement(doc, parent.id, (h) => ({ ...h, children: (h.children ?? []).filter((e) => e.id !== id) }));
  return doc;
}

function detach(doc: SiteContent, id: string): { doc: SiteContent; node: Section | SectionRef | Column | ElementNode } | null {
  const ref = findNode(doc, id);
  if (!ref) return null;
  let node: Section | SectionRef | Column | ElementNode | null = null;
  if (ref.kind === "section") node = getSection(doc, id);
  else if (ref.kind === "ref") node = doc.pages.flatMap((p) => p.items).find((i) => i.id === id) ?? null;
  else if (ref.kind === "column") node = getColumn(doc, id);
  else if (ref.kind === "element") node = getElement(doc, id);
  if (!node) return null;
  return { doc: removeNode(doc, id), node };
}

/** Moves a node under a new parent at an index. The index is relative to the parent's children after the node has been taken out. */
export function moveNode(doc: SiteContent, id: string, parentId: string, index: number): SiteContent {
  const check = canPlace(doc, id, parentId);
  if (!check.ok) return doc;
  const taken = detach(doc, id);
  if (!taken) return doc;
  const parent = findNode(taken.doc, parentId);
  if (!parent) return doc;
  const node = taken.node;
  if (parent.kind === "page" && ("columns" in node || (node as SectionRef).type === "ref")) return insertSection(taken.doc, parentId, index, node as Section | SectionRef);
  if (parent.kind === "section" && "elements" in node) return insertColumn(taken.doc, parentId, index, node as Column);
  if ((parent.kind === "column" || parent.kind === "element") && "props" in node) return insertElement(taken.doc, parentId, index, node as ElementNode);
  return doc;
}

/** Moves a node one place earlier or later among its siblings. Also the keyboard alternative to dragging. */
export function nudge(doc: SiteContent, id: string, delta: -1 | 1): SiteContent {
  const ref = findNode(doc, id);
  if (!ref || ref.kind === "page" || !ref.parentId) return doc;
  const idx = ref.index + delta;
  const siblings = siblingCount(doc, ref);
  if (idx < 0 || idx >= siblings) return doc;
  return moveNode(doc, id, ref.parentId, idx);
}

function siblingCount(doc: SiteContent, ref: NodeRef): number {
  const parent = ref.parentId ? findNode(doc, ref.parentId) : null;
  if (!parent) return 0;
  if (parent.kind === "page") return getPage(doc, parent.id)?.items.length ?? 0;
  if (parent.kind === "section") return getSection(doc, parent.id)?.columns.length ?? 0;
  if (parent.kind === "column") return getColumn(doc, parent.id)?.elements.length ?? 0;
  return getElement(doc, parent.id)?.children?.length ?? 0;
}

/** Moves an element out of its container into the one before or after it (or into the neighbouring column), for keyboard users. */
export function nudgeAcross(doc: SiteContent, id: string, delta: -1 | 1): SiteContent {
  const ref = findNode(doc, id);
  if (!ref || ref.kind !== "element" || !ref.parentId) return doc;
  const parent = findNode(doc, ref.parentId);
  if (!parent) return doc;
  if (parent.kind === "column") {
    const sec = getSection(doc, parent.sectionId!);
    const next = sec?.columns[parent.index + delta];
    if (!sec || !next) return doc;
    return moveNode(doc, id, next.id, delta < 0 ? next.elements.length : 0);
  }
  // Out of a container: sit just before or after it in its own parent.
  const grand = parent.parentId;
  if (!grand) return doc;
  return moveNode(doc, id, grand, delta < 0 ? parent.index : parent.index + 1);
}

export function duplicateNode(doc: SiteContent, id: string): { doc: SiteContent; id: string } | null {
  const ref = findNode(doc, id);
  if (!ref || ref.kind === "page" || !ref.parentId) return null;
  const used = new Set(collectIds(doc));
  if (ref.kind === "section") {
    const s = getSection(doc, id);
    if (!s) return null;
    const copy = cloneWithNewIds(s, used);
    return { doc: insertSection(doc, ref.parentId, ref.index + 1, { ...copy, name: s.name ? `${s.name} copy`.slice(0, 40) : "" }), id: copy.id };
  }
  if (ref.kind === "ref") {
    const item = doc.pages.flatMap((p) => p.items).find((i) => i.id === id);
    if (!item || !isRef(item)) return null;
    const copy: SectionRef = { ...item, id: newId(used, "r") };
    return { doc: insertSection(doc, ref.parentId, ref.index + 1, copy), id: copy.id };
  }
  if (ref.kind === "column") {
    const c = getColumn(doc, id);
    const sec = c ? getSection(doc, ref.sectionId!) : null;
    if (!c || !sec || sec.columns.length >= LIMITS.columnsPerSection) return null;
    const copy = cloneWithNewIds(c, used);
    return { doc: insertColumn(doc, ref.parentId, ref.index + 1, copy), id: copy.id };
  }
  const el = getElement(doc, id);
  if (!el) return null;
  const copy = cloneWithNewIds(el, used);
  return { doc: insertElement(doc, ref.parentId, ref.index + 1, copy), id: copy.id };
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

/** Re-lays a section out as n equal columns, moving surplus elements into the last one so nothing is lost. */
export function setColumnCount(doc: SiteContent, sectionId: string, count: number, makeColumn: () => Column): SiteContent {
  const n = Math.max(1, Math.min(LIMITS.columnsPerSection, Math.round(count)));
  return updateSection(doc, sectionId, (s) => {
    let columns = s.columns.map((c) => ({ ...c }));
    while (columns.length < n) columns.push(makeColumn());
    if (columns.length > n) {
      const keep = columns.slice(0, n);
      const extra = columns.slice(n).flatMap((c) => c.elements);
      keep[n - 1] = { ...keep[n - 1], elements: [...keep[n - 1].elements, ...extra] };
      columns = keep;
    }
    const base = Math.floor(12 / n);
    const spans = columns.map((_, i) => (i === n - 1 ? 12 - base * (n - 1) : base));
    return { ...s, columns: columns.map((c, i) => ({ ...c, span: spans[i] })) };
  });
}

export const setColumnSpans = (doc: SiteContent, sectionId: string, spans: number[]): SiteContent =>
  updateSection(doc, sectionId, (s) => ({ ...s, columns: s.columns.map((c, i) => (spans[i] ? { ...c, span: Math.max(1, Math.min(12, Math.round(spans[i]))) } : c)) }));

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export const slugify = (title: string) => title.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "page";

export function uniqueSlug(doc: SiteContent, wanted: string, except?: string): string {
  const taken = new Set(doc.pages.filter((p) => p.id !== except).map((p) => p.slug));
  const reserved = new Set(["api", "admin", "_next", "__iaq", "assets", "_a", "sitemap", "robots", "favicon", "thanks", "static", "login"]);
  let base = slugify(wanted);
  if (reserved.has(base)) base = `${base}-page`;
  let slug = base;
  for (let i = 2; taken.has(slug); i += 1) slug = `${base.slice(0, 36)}-${i}`;
  return slug;
}

export function addPage(doc: SiteContent, title: string, items: PageItem[] = [], kind: Page["kind"] = "page"): { doc: SiteContent; id: string; slug: string } | null {
  if (doc.pages.length >= LIMITS.pages) return null;
  const used = new Set(collectIds(doc));
  const id = newId(used, "p");
  const slug = uniqueSlug(doc, title);
  const page: Page = { id, slug, title: title.trim().slice(0, 60) || "New page", kind, navLabel: "", showInNav: kind === "page", seoTitle: "", seoDescription: "", ogImage: null, noindex: kind === "thanks", items };
  return { doc: { ...doc, pages: [...doc.pages, page] }, id, slug };
}

export function duplicatePage(doc: SiteContent, id: string): { doc: SiteContent; id: string; slug: string } | null {
  const p = getPage(doc, id);
  if (!p || doc.pages.length >= LIMITS.pages) return null;
  const used = new Set(collectIds(doc));
  const pid = newId(used, "p");
  const title = `${p.title} copy`.slice(0, 60);
  const slug = uniqueSlug(doc, title);
  const items = p.items.map((i) => (isRef(i) ? { ...i, id: newId(used, "r") } : cloneWithNewIds(i, used)));
  const page: Page = { ...p, id: pid, slug, title, items, showInNav: false };
  return { doc: { ...doc, pages: [...doc.pages, page] }, id: pid, slug };
}

export const updatePage = (doc: SiteContent, id: string, patch: Partial<Omit<Page, "id" | "items">>): SiteContent => {
  const cur = getPage(doc, id);
  if (!cur) return doc;
  const next = { ...patch };
  if (next.slug !== undefined) {
    // The home page's address is fixed, and every other address stays unique.
    next.slug = cur.slug === "home" ? "home" : uniqueSlug(doc, next.slug, id);
  }
  return { ...doc, pages: doc.pages.map((p) => (p.id === id ? { ...p, ...next } : p)) };
};

export function movePage(doc: SiteContent, id: string, delta: -1 | 1): SiteContent {
  const i = doc.pages.findIndex((p) => p.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= doc.pages.length) return doc;
  const pages = [...doc.pages];
  [pages[i], pages[j]] = [pages[j], pages[i]];
  return { ...doc, pages };
}

/** Makes another page the home page: addresses are swapped, so links to "/" keep working and nothing else is renamed. */
export function setHomePage(doc: SiteContent, id: string): SiteContent {
  const target = getPage(doc, id);
  const home = doc.pages.find((p) => p.slug === "home");
  if (!target || !home || target.id === home.id || target.kind === "thanks") return doc;
  const swapped = uniqueSlug({ ...doc, pages: doc.pages.filter((p) => p.id !== home.id && p.id !== target.id) }, slugify(home.title), home.id);
  return { ...doc, pages: doc.pages.map((p) => (p.id === target.id ? { ...p, slug: "home" } : p.id === home.id ? { ...p, slug: swapped } : p)) };
}

// ---------------------------------------------------------------------------
// Shared (site-wide) sections
// ---------------------------------------------------------------------------

/** Turns a section on a page into a shared section: the page keeps a reference, and every page that references it shows the same one. */
export function makeShared(doc: SiteContent, sectionId: string): { doc: SiteContent; ref: string } | null {
  const ref = findNode(doc, sectionId);
  if (!ref || ref.kind !== "section" || ref.home?.type !== "page") return null;
  if (Object.keys(doc.globals).length >= LIMITS.globals) return null;
  const s = getSection(doc, sectionId);
  if (!s) return null;
  const used = new Set(collectIds(doc));
  const key = newId(used, "g");
  const item: SectionRef = { id: newId(used, "r"), type: "ref", ref: key };
  const without = removeNode(doc, sectionId);
  const globals = { ...without.globals, [key]: { ...s, id: s.id } };
  return { doc: insertSection({ ...without, globals }, ref.parentId!, ref.index, item), ref: key };
}

/** Replaces a reference with its own independent copy of the shared section, so editing it no longer affects other pages. */
export function detachShared(doc: SiteContent, refItemId: string): SiteContent {
  const ref = findNode(doc, refItemId);
  if (!ref || ref.kind !== "ref") return doc;
  const item = doc.pages.flatMap((p) => p.items).find((i) => i.id === refItemId);
  if (!item || !isRef(item)) return doc;
  const shared = doc.globals[item.ref];
  if (!shared) return doc;
  const copy = cloneWithNewIds(shared, new Set(collectIds(doc)));
  return insertSection(removeNode(doc, refItemId), ref.parentId!, ref.index, copy);
}

// ---------------------------------------------------------------------------
// Description (for layer lists and breadcrumbs)
// ---------------------------------------------------------------------------

export function describeNode(doc: SiteContent, id: string): string {
  const r = findNode(doc, id);
  if (!r) return "Item";
  if (r.kind === "page") return getPage(doc, id)?.title ?? "Page";
  if (r.kind === "ref") return "Shared section";
  if (r.kind === "section") {
    const s = getSection(doc, id);
    if (!s) return "Section";
    if (s.name) return s.name;
    if (r.home?.type === "header") return "Header";
    if (r.home?.type === "footer") return "Footer";
    const first = s.columns.flatMap((c) => c.elements).find((e) => e.type === "heading");
    const t = first ? plainText(String(first.props.text ?? "")) : "";
    return t ? t.slice(0, 32) : "Section";
  }
  if (r.kind === "column") return `Column ${r.index + 1}`;
  const e = getElement(doc, id);
  if (!e) return "Item";
  const label = ELEMENT_DEFS[e.type].label;
  const text = typeof e.props.text === "string" ? plainText(e.props.text) : e.type === "button" ? String((e.props.link as { label?: string } | undefined)?.label ?? "") : "";
  return text ? `${label}: ${text.slice(0, 28)}` : label;
}

/** The chain from the page's top down to a node, for breadcrumbs and "select parent". */
export function ancestors(doc: SiteContent, id: string): NodeRef[] {
  const idx = indexDoc(doc);
  const chain: NodeRef[] = [];
  let cur = idx.get(id);
  while (cur) {
    chain.unshift(cur);
    cur = cur.parentId ? idx.get(cur.parentId) : undefined;
  }
  return chain;
}
