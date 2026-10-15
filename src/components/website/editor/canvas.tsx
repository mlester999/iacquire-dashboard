"use client";

import * as React from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Bold, CornerLeftUp, Copy, EyeOff, Italic, Link2, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/overlays";
import { Inline_ } from "@/components/website/render/parts";
import { SiteRenderer } from "@/components/website/render/site-renderer";
import type { EditBridge, RenderCtx } from "@/components/website/render/ctx";
import { ELEMENT_DEFS } from "@/lib/website/catalog";
import { findPage, isRef, type Section, type SiteContent } from "@/lib/website/doc";
import { axisOf, pickSlot, slotLine, spanFromPixels, type Axis, type Point, type Rect } from "@/lib/website/editor/dnd";
import { deviceWidth, type Device } from "@/lib/website/editor/state";
import { canInsertElement, canPlace, describeNode, findNode, getColumn, getSection, setColumnSpans, setProp, updateSection } from "@/lib/website/ops";
import { cn } from "@/lib/utils";
import { IconButton } from "./controls";
import { DragHandle, useDrag, type DragSource, type DropTarget } from "./drag";
import "./editor.css";

// ---------------------------------------------------------------------------
// Inline text editing
// ---------------------------------------------------------------------------

interface EditState {
  editingKey: string | null;
  onText: (nodeId: string, path: string, value: string) => void;
  stop: () => void;
}
const EditContext = React.createContext<EditState>({ editingKey: null, onText: () => undefined, stop: () => undefined });

type TextProps = React.ComponentProps<EditBridge["Text"]>;

/**
 * Text on the canvas. When it isn't being edited it is drawn exactly as a visitor would see it; when it is, it becomes a plain-text field that
 * shows the inline marks (**bold**, *emphasis*) as typed. The page's own markup never enters the document: only plain text does.
 */
function EditableText(props: TextProps) {
  const { nodeId, path, value, as: Tag = "span", className, multiline, rootProps, placeholder, plain } = props;
  const state = React.useContext(EditContext);
  const key = `${nodeId}::${path}`;
  const cn2 = [className, rootProps?.className].filter(Boolean).join(" ") || undefined;
  if (state.editingKey !== key) {
    return (
      <Tag {...rootProps} className={cn2} data-eid={nodeId} data-epath={path} data-placeholder={placeholder} data-empty={value ? undefined : ""}>
        {plain ? value || null : <Inline_ src={value} />}
      </Tag>
    );
  }
  return <EditingText {...props} cls={cn2} state={state} />;
}

function EditingText({ nodeId, path, value, as: Tag = "span", multiline, rootProps, placeholder, plain, cls, state }: TextProps & { cls?: string; state: EditState }) {
  const ref = React.useRef<HTMLElement | null>(null);
  const initial = React.useRef(value);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.textContent = initial.current;
    el.focus({ preventScroll: true });
    const sel = window.getSelection();
    if (sel) {
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
    }
  }, []);
  const read = (el: HTMLElement) => {
    // Chrome adds one trailing newline to a field that ends with a blank line; it is never content.
    const t = el.innerText.replace(/\r\n?/g, "\n").replace(/ /g, " ");
    return multiline ? t.replace(/\n$/, "") : t.replace(/\n+/g, " ");
  };
  const AnyTag = Tag as React.ElementType;
  return (
    <AnyTag
      {...rootProps} ref={ref} className={cls} contentEditable={"plaintext-only" as unknown as boolean} suppressContentEditableWarning spellCheck data-eid={nodeId} data-epath={path} data-editing="" data-plain={plain ? "" : undefined} data-placeholder={placeholder}
      role="textbox" aria-multiline={multiline ? true : undefined} aria-label={placeholder ?? "Edit text"}
      onInput={(e: React.FormEvent<HTMLElement>) => state.onText(nodeId, path, read(e.currentTarget))}
      onPaste={(e: React.ClipboardEvent<HTMLElement>) => {
        // Only plain text comes in; formatting from other pages never does.
        e.preventDefault();
        const t = e.clipboardData.getData("text/plain");
        document.execCommand("insertText", false, multiline ? t : t.replace(/\s*\n+\s*/g, " "));
      }}
      onKeyDown={(e: React.KeyboardEvent<HTMLElement>) => {
        if (e.key === "Escape") {
          e.preventDefault();
          state.stop();
        } else if (e.key === "Enter" && !multiline) {
          e.preventDefault();
          state.stop();
        } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
          e.preventDefault();
          wrapSelection(e.currentTarget, "**");
        } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "i") {
          e.preventDefault();
          wrapSelection(e.currentTarget, "*");
        }
      }}
      onBlur={() => state.stop()}
    />
  );
}

/** Wraps the selected words of the active text field in a mark, or unwraps them if they already are. */
export function wrapSelection(el: HTMLElement, mark: "**" | "*" | "[]", href?: string) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) return;
  const range = sel.getRangeAt(0);
  const pre = range.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.startContainer, range.startOffset);
  const start = pre.toString().length;
  const text = el.innerText.replace(/\n$/, "");
  const end = start + range.toString().length;
  const picked = text.slice(start, end);
  if (!picked) return;
  const open = mark === "[]" ? "[" : mark;
  const close = mark === "[]" ? `](${href ?? "https://"})` : mark;
  const wrapped = picked.startsWith(open) && picked.endsWith(close) && picked.length > open.length + close.length;
  const next = text.slice(0, start) + (wrapped ? picked.slice(open.length, picked.length - close.length) : `${open}${picked}${close}`) + text.slice(end);
  el.textContent = next;
  el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  const s = window.getSelection();
  if (s && el.firstChild) {
    const r = document.createRange();
    const caret = start + (wrapped ? picked.length - open.length - close.length : picked.length + open.length + close.length);
    r.setStart(el.firstChild, Math.min(caret, next.length));
    r.collapse(true);
    s.removeAllRanges();
    s.addRange(r);
  }
}

const BRIDGE: EditBridge = { selectedId: null, Text: EditableText };
const noHref = () => "#";
const MemoSite = React.memo(SiteRenderer);

// ---------------------------------------------------------------------------
// The canvas
// ---------------------------------------------------------------------------

export interface CanvasActions {
  select: (id: string | null) => void;
  commit: (doc: SiteContent, o?: { coalesce?: string; select?: string | null; page?: string }) => void;
  nudge: (id: string, delta: -1 | 1) => void;
  nudgeAcross: (id: string, delta: -1 | 1) => void;
  duplicate: (id: string) => void;
  remove: (id: string) => void;
  toggleHidden: (id: string) => void;
  addBelow: (id: string) => void;
  selectParent: (id: string) => void;
  makeShared: (id: string) => void;
  detachShared: (id: string) => void;
  saveAsComponent: (id: string) => void;
  announce: (message: string) => void;
}

export interface CanvasProps {
  doc: SiteContent;
  pageSlug: string;
  device: Device;
  zoom: "fit" | number;
  selection: string | null;
  resolveAsset: RenderCtx["resolveAsset"];
  actions: CanvasActions;
  readOnly?: boolean;
  onScale?: (scale: number) => void;
  /** Changes whenever the document is rewritten from outside (undo, redo, restore), so a half-typed field closes. */
  closeEditSignal?: number;
  /** Scrolls an item into view (after adding or moving it). `n` changes on every request, so asking twice for the same item works. */
  reveal?: { id: string; n: number } | null;
}

interface Box extends Rect {
  kind: string;
}

const NODE_KIND_LABEL: Record<string, string> = { section: "Section", header: "Header", footer: "Footer", column: "Column", ref: "Shared section" };

/** The page item that stands for a section on the current page: itself, or the reference to it when it is shared. */
export function pageItemFor(doc: SiteContent, pageSlug: string, sectionId: string): string {
  const page = findPage(doc, pageSlug);
  const sec = getSection(doc, sectionId);
  if (!page || !sec) return sectionId;
  const ref = page.items.find((i) => isRef(i) && doc.globals[i.ref]?.id === sectionId);
  return ref ? ref.id : sectionId;
}

export function Canvas({ doc, pageSlug, device, zoom, selection, resolveAsset, actions, readOnly, onScale, closeEditSignal, reveal }: CanvasProps) {
  const drag = useDrag();
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const stageRef = React.useRef<HTMLDivElement>(null);
  const frameRef = React.useRef<HTMLDivElement>(null);
  const docRef = React.useRef(doc);
  React.useLayoutEffect(() => {
    docRef.current = doc;
  }, [doc]);
  // What is being typed into, and which undo/redo "generation" it belongs to; it ends when either the selection or the generation changes.
  const [editing, setEditing] = React.useState<{ key: string; signal: number } | null>(null);
  const editingKey = editing && editing.signal === (closeEditSignal ?? 0) && selection && editing.key.startsWith(`${selection}::`) ? editing.key : null;
  const closeEditSignalRef = React.useRef(closeEditSignal ?? 0);
  React.useLayoutEffect(() => {
    closeEditSignalRef.current = closeEditSignal ?? 0;
  }, [closeEditSignal]);
  const setEditingKey = React.useCallback((key: string | null) => setEditing(key ? { key, signal: closeEditSignalRef.current } : null), []);
  const [hover, setHover] = React.useState<string | null>(null);
  const [avail, setAvail] = React.useState(1000);
  const [contentH, setContentH] = React.useState(900);
  const [selBox, setSelBox] = React.useState<Box | null>(null);
  const [hoverBox, setHoverBox] = React.useState<Box | null>(null);
  const [meta, setMeta] = React.useState<{ ntype: string; shared: boolean; hasText: boolean; rich: boolean }>({ ntype: "", shared: false, hasText: false, rich: false });
  const [tick, setTick] = React.useState(0);
  const page = findPage(doc, pageSlug) ?? doc.pages[0];

  // --- Size and scale ------------------------------------------------------
  const frameW = device === "desktop" ? Math.max(1100, Math.min(1440, avail - 48)) : deviceWidth(device);
  const fit = Math.min(1, (avail - 40) / frameW);
  const scale = zoom === "fit" ? fit : zoom;
  React.useEffect(() => onScale?.(scale), [scale, onScale]);
  const vh = device === "desktop" ? 900 : device === "tablet" ? 1024 : 844;

  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // The observer reports the size as soon as it starts watching, so there is no separate first read.
    const ro = new ResizeObserver(() => setAvail(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  React.useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setContentH(el.offsetHeight);
      setTick((t) => t + 1);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [device, pageSlug]);

  // --- Measuring -----------------------------------------------------------
  const rel = React.useCallback((el: Element): Rect | null => {
    const stage = stageRef.current;
    if (!stage) return null;
    const s = stage.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { left: r.left - s.left, top: r.top - s.top, width: r.width, height: r.height };
  }, []);
  const find = React.useCallback((id: string | null): HTMLElement | null => (id && frameRef.current ? frameRef.current.querySelector<HTMLElement>(`[data-nid="${CSS.escape(id)}"]`) : null), []);

  // The page's real layout decides where the overlay goes, so it is measured after each render.
  /* eslint-disable react-hooks/set-state-in-effect -- measuring the DOM after layout is what this effect is for */
  React.useLayoutEffect(() => {
    const el = find(selection);
    const r = el ? rel(el) : null;
    setSelBox(el && r ? { ...r, kind: el.dataset.ntype ?? "element" } : null);
    setMeta({
      ntype: el?.dataset.ntype ?? "", shared: el?.hasAttribute("data-shared") ?? false, hasText: Boolean(el?.matches("[data-epath]") || el?.querySelector("[data-epath]")),
      rich: Boolean(frameRef.current?.querySelector("[data-editing]:not([data-plain])")),
    });
    const h = hover && hover !== selection ? find(hover) : null;
    const hr = h ? rel(h) : null;
    setHoverBox(h && hr ? { ...hr, kind: h.dataset.ntype ?? "element" } : null);
  }, [selection, hover, doc, device, scale, tick, pageSlug, editingKey, find, rel, avail, contentH]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Keep the overlay glued to the page when anything scrolls or loads.
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const bump = () => setTick((t) => t + 1);
    el.addEventListener("scroll", bump, { passive: true });
    window.addEventListener("resize", bump);
    const frame = frameRef.current;
    frame?.addEventListener("load", bump, true);
    if (document.fonts?.ready) void document.fonts.ready.then(bump);
    return () => {
      el.removeEventListener("scroll", bump);
      window.removeEventListener("resize", bump);
      frame?.removeEventListener("load", bump, true);
    };
  }, [pageSlug]);

  // Bring a newly added or moved item into view.
  React.useEffect(() => {
    if (!reveal) return;
    const id = window.setTimeout(() => {
      const el = find(reveal.id);
      const sc = scrollRef.current;
      if (!el || !sc) return;
      const r = el.getBoundingClientRect();
      const s = sc.getBoundingClientRect();
      if (r.top < s.top + 40 || r.bottom > s.bottom - 40) sc.scrollTo({ top: sc.scrollTop + (r.top - s.top) - 120, behavior: "smooth" });
    }, 60);
    return () => window.clearTimeout(id);
  }, [reveal, find]);

  // --- Editing -------------------------------------------------------------
  const stopEditing = React.useCallback(() => setEditingKey(null), []);
  const lastKey = React.useRef<string | null>(null);
  const editState = React.useMemo<EditState>(
    () => ({
      editingKey,
      stop: stopEditing,
      onText: (nodeId, path, value) => {
        const d = docRef.current;
        const node = findNode(d, nodeId);
        if (!node) return;
        lastKey.current = `${nodeId}::${path}`;
        actions.commit(setProp(d, nodeId, path, value), { coalesce: `text:${nodeId}:${path}` });
      },
    }),
    [editingKey, stopEditing, actions],
  );
  // A different selection always ends editing, and so do undo and redo (they rewrite the text), by how `editingKey` is derived above.

  // --- Pointer -------------------------------------------------------------
  const onClickCapture = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest("[data-editing]")) return;
    e.preventDefault();
    e.stopPropagation();
    if (readOnly) return;
    const node = t.closest<HTMLElement>("[data-nid]");
    if (!node || !frameRef.current?.contains(node)) {
      actions.select(null);
      return;
    }
    const id = node.dataset.nid!;
    const textEl = t.closest<HTMLElement>("[data-epath]");
    if (id === selection && textEl && textEl.dataset.eid === id) {
      lastKey.current = `${id}::${textEl.dataset.epath}`;
      setEditingKey(`${id}::${textEl.dataset.epath}`);
      return;
    }
    actions.select(id);
  };
  const onDoubleClickCapture = (e: React.MouseEvent) => {
    if (readOnly) return;
    const t = e.target as HTMLElement;
    const textEl = t.closest<HTMLElement>("[data-epath]");
    const node = t.closest<HTMLElement>("[data-nid]");
    if (textEl && node && textEl.dataset.eid === node.dataset.nid) {
      actions.select(node.dataset.nid!);
      lastKey.current = `${node.dataset.nid}::${textEl.dataset.epath}`;
      setEditingKey(`${node.dataset.nid}::${textEl.dataset.epath}`);
    }
  };
  const raf = React.useRef(0);
  const onPointerMove = (e: React.PointerEvent) => {
    if (drag.active || readOnly) return;
    const { target } = e;
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      const n = (target as HTMLElement).closest?.("[data-nid]") as HTMLElement | null;
      setHover(n && frameRef.current?.contains(n) ? n.dataset.nid! : null);
    });
  };

  // --- Keyboard ------------------------------------------------------------
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("[data-editing]")) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "z") return; // handled by the shell
    if (!selection) return;
    const node = findNode(doc, selection);
    if (!node) return;
    const id = node.kind === "section" && node.home?.type === "page" ? selection : node.kind === "section" ? pageItemFor(doc, pageSlug, selection) : selection;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      actions.remove(id);
    } else if (mod && e.key.toLowerCase() === "d") {
      e.preventDefault();
      actions.duplicate(id);
    } else if (e.altKey && e.key === "ArrowUp") {
      e.preventDefault();
      actions.nudge(id, -1);
    } else if (e.altKey && e.key === "ArrowDown") {
      e.preventDefault();
      actions.nudge(id, 1);
    } else if (e.altKey && e.key === "ArrowLeft") {
      e.preventDefault();
      actions.nudgeAcross(id, -1);
    } else if (e.altKey && e.key === "ArrowRight") {
      e.preventDefault();
      actions.nudgeAcross(id, 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      actions.selectParent(selection);
    } else if (e.key === "Enter") {
      const textEl = find(selection)?.querySelector<HTMLElement>("[data-epath]") ?? (find(selection)?.matches("[data-epath]") ? find(selection) : null);
      if (textEl) {
        e.preventDefault();
        lastKey.current = `${selection}::${textEl.dataset.epath}`;
        setEditingKey(`${selection}::${textEl.dataset.epath}`);
      }
    }
  };

  // --- Dragging ------------------------------------------------------------
  const locate = (source: DragSource, p: Point): DropTarget | null => {
    const scroller = scrollRef.current;
    const stage = stageRef.current;
    const frame = frameRef.current;
    if (!scroller || !stage || !frame) return null;
    const d = docRef.current;
    const pg = findPage(d, pageSlug);
    if (!pg) return null;
    const sr = scroller.getBoundingClientRect();
    if (p.x < sr.left || p.x > sr.right || p.y < sr.top || p.y > sr.bottom) return null;
    const origin = stage.getBoundingClientRect();
    const toStage = (el: Element): Rect => {
      const r = el.getBoundingClientRect();
      return { left: r.left - origin.left, top: r.top - origin.top, width: r.width, height: r.height };
    };
    const pointer = { x: p.x - origin.left, y: p.y - origin.top };
    const stack = document.elementsFromPoint(p.x, p.y).filter((e): e is HTMLElement => e instanceof HTMLElement && frame.contains(e));
    const dragged = source.kind === "node" ? findNode(d, source.id) : null;
    const wants: "section" | "column" | "element" = source.kind === "node" ? (dragged?.kind === "column" ? "column" : dragged?.kind === "element" ? "element" : "section") : source.kind === "element" ? "element" : "section";
    const draggedDomId = (() => {
      if (!dragged) return null;
      if (dragged.kind === "ref" && source.kind === "node") {
        const item = pg.items.find((i) => i.id === source.id && isRef(i));
        return item && isRef(item) ? d.globals[item.ref]?.id ?? null : null;
      }
      return source.kind === "node" ? source.id : null;
    })();
    const kids = (container: Element) => (Array.from(container.children) as HTMLElement[]).filter((c) => c.dataset?.nid && c.dataset.nid !== draggedDomId);

    const finish = (parentId: string, parentEl: Element, children: HTMLElement[], hintAxis: Axis, check: { ok: boolean; reason?: string }): DropTarget => {
      const rects = children.map(toStage);
      const axis = axisOf(rects, hintAxis);
      const slot = pickSlot(rects, axis, pointer);
      const container = toStage(parentEl);
      return { parentId, index: slot.index, valid: check.ok, reason: check.ok ? undefined : check.reason, line: slotLine(rects, slot, axis, container), container };
    };

    if (wants === "section") {
      const main = frame.querySelector("[data-site-main]");
      if (!main) return null;
      const children = kids(main);
      // A page with nothing on it still accepts a drop at the top.
      const check = dragged ? canPlace(d, source.kind === "node" ? source.id : "", pg.id) : { ok: true as const };
      return finish(pg.id, main, children, "y", check);
    }
    if (wants === "column") {
      const sec = stack.find((e) => e.dataset.ntype === "section" || e.dataset.ntype === "header" || e.dataset.ntype === "footer");
      if (!sec || !sec.dataset.nid) return null;
      const grid = sec.querySelector(".iq-grid");
      if (!grid) return null;
      return finish(sec.dataset.nid, grid, kids(grid), "x", canPlace(d, source.kind === "node" ? source.id : "", sec.dataset.nid));
    }
    // An element goes into the innermost column, row or card under the pointer that will have it.
    let firstInvalid: { id: string; el: HTMLElement; reason?: string } | null = null;
    for (const el of stack) {
      const id = el.dataset.nid;
      const type = el.dataset.ntype;
      if (!id || (type !== "column" && type !== "group" && type !== "card")) continue;
      const check = source.kind === "element" ? canInsertElement(d, source.type, id) : source.kind === "node" ? canPlace(d, source.id, id) : { ok: false as const, reason: "That spot isn't available." };
      if (check.ok) return finish(id, el, kids(el), type === "group" && el.dataset.dir === "row" ? "x" : "y", check);
      if (!firstInvalid) firstInvalid = { id, el, reason: check.reason };
    }
    if (firstInvalid) return finish(firstInvalid.id, firstInvalid.el, kids(firstInvalid.el), "y", { ok: false, reason: firstInvalid.reason });
    const sec = stack.find((e) => e.dataset.ntype === "section");
    if (sec) return { parentId: sec.dataset.nid!, index: 0, valid: false, reason: "Elements go in a column. Drop it inside a section's column.", line: null, container: toStage(sec) };
    return null;
  };

  React.useEffect(() => {
    drag.setLocator((source, p) => locate(source, p));
    return () => drag.setLocator(null);
    // The locator reads current values through refs and the DOM.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag.setLocator, pageSlug]);

  // Scroll while dragging near an edge.
  React.useEffect(() => {
    if (!drag.active) return;
    const id = window.setInterval(() => {
      const sc = scrollRef.current;
      const p = drag.pointerRef.current;
      if (!sc || !p) return;
      const r = sc.getBoundingClientRect();
      const edge = 70;
      if (p.y < r.top + edge && p.y > r.top - 40) sc.scrollTop -= 16;
      else if (p.y > r.bottom - edge && p.y < r.bottom + 40) sc.scrollTop += 16;
    }, 16);
    return () => window.clearInterval(id);
  }, [drag.active, drag.pointerRef]);

  // --- Resize --------------------------------------------------------------
  const startColumnResize = (e: React.PointerEvent, columnId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const d0 = docRef.current;
    const col = getColumn(d0, columnId);
    const colNode = findNode(d0, columnId);
    const sec = colNode?.sectionId ? getSection(d0, colNode.sectionId) : null;
    const colEl = find(columnId);
    const grid = colEl?.parentElement;
    if (!col || !sec || !grid) return;
    const i = sec.columns.findIndex((c) => c.id === columnId);
    const next = sec.columns[i + 1];
    const total = sec.columns.reduce((n, c) => n + c.span, 0);
    const unit = grid.getBoundingClientRect().width / Math.max(12, total);
    const x0 = e.clientX;
    const span0 = col.span;
    const nextSpan0 = next?.span ?? 0;
    const move = (ev: PointerEvent) => {
      const delta = Math.round((ev.clientX - x0) / unit);
      const span = Math.max(1, Math.min(span0 + (next ? nextSpan0 - 1 : 12 - span0), span0 + delta));
      const spans = sec.columns.map((c) => c.span);
      spans[i] = span;
      if (next) spans[i + 1] = Math.max(1, nextSpan0 - (span - span0));
      actions.commit(setColumnSpans(docRef.current, sec.id, spans), { coalesce: `resize:${columnId}` });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      actions.announce(`Column is now ${getColumn(docRef.current, columnId)?.span ?? span0} of 12 wide.`);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const MIN_STEPS = ["auto", "40", "60", "75", "90", "100"] as const;
  const startHeightResize = (e: React.PointerEvent, sectionId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const el = find(sectionId);
    const sec = getSection(docRef.current, sectionId);
    if (!el || !sec) return;
    const startH = el.getBoundingClientRect().height / scale;
    const y0 = e.clientY;
    const move = (ev: PointerEvent) => {
      const px = startH + (ev.clientY - y0) / scale;
      // Pick the step whose height is nearest the dragged one.
      let best: (typeof MIN_STEPS)[number] = "auto";
      let bestD = Infinity;
      for (const s of MIN_STEPS) {
        const h = s === "auto" ? 0 : (vh * Number(s)) / 100;
        const dd = Math.abs(h - px);
        if (dd < bestD) {
          bestD = dd;
          best = s;
        }
      }
      if (sec.layout.minH !== best) actions.commit(updateSection(docRef.current, sectionId, (s: Section) => ({ ...s, layout: { ...s.layout, minH: best } })), { coalesce: `minh:${sectionId}` });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // --- Overlay pieces ------------------------------------------------------
  const selNode = selection ? findNode(doc, selection) : null;
  const instanceId = selNode?.kind === "section" && selection ? (selNode.home?.type === "page" ? selection : selNode.home?.type === "global" ? pageItemFor(doc, pageSlug, selection) : selection) : selection;
  const isTextEditing = editingKey !== null;
  const dragTarget = drag.target;

  const label = selection ? describeNode(doc, selection) : "";
  const hasText = meta.hasText;
  const richEditing = isTextEditing && meta.rich;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef} className="editor-canvas-bg relative min-h-0 flex-1 overflow-auto" tabIndex={0} role="application" aria-label="Website canvas. Select an item, then use the toolbar or keyboard to change it."
        onKeyDown={onKeyDown}
      >
        <div ref={stageRef} className="relative mx-auto" style={{ width: frameW * scale, height: contentH * scale + 96, marginTop: 24, marginBottom: 24 }}>
          <div className="absolute left-0 top-0 origin-top-left shadow-[0_8px_40px_-12px_rgb(16_24_40/.35)]" style={{ width: frameW, transform: `scale(${scale})`, background: "var(--bg, #fff)" }}>
            <div ref={frameRef} onClickCapture={onClickCapture} onDoubleClickCapture={onDoubleClickCapture} onPointerMove={onPointerMove} onPointerLeave={() => setHover(null)} onDragStart={(e) => e.preventDefault()} data-canvas-frame="" data-device={device}>
              <EditContext.Provider value={editState}>
                <MemoSite
                  content={doc} pageSlug={page.slug} resolveAsset={resolveAsset} mode="edit" formAction={null} hrefFor={noHref} embedded viewportHeight={vh} edit={BRIDGE} scope="canvas"
                />
              </EditContext.Provider>
            </div>
          </div>

          {/* Overlay: everything below is editor chrome, outside the site. */}
          <div className="pointer-events-none absolute inset-0" aria-hidden={false}>
            {hoverBox && !drag.active && <div className="editor-hover" style={{ left: hoverBox.left, top: hoverBox.top, width: hoverBox.width, height: hoverBox.height }} />}
            {selBox && !readOnly && (
              <SelectionLayer
                box={selBox} label={label} kindLabel={NODE_KIND_LABEL[selBox.kind] ?? (selNode?.kind === "element" ? ELEMENT_DEFS[(meta.ntype || "text") as keyof typeof ELEMENT_DEFS]?.label ?? "Item" : "Item")}
                kind={selBox.kind} editing={isTextEditing} richText={richEditing} instanceId={instanceId ?? selection!} selection={selection!} dragging={Boolean(drag.active)}
                shared={meta.shared} hasText={hasText} actions={actions} stageWidth={frameW * scale}
                onResizeColumn={(e) => selection && startColumnResize(e, selection)} onResizeHeight={(e) => selection && startHeightResize(e, selection)}
                canResizeColumn={selBox.kind === "column" && (getSectionOfColumn(doc, selection!)?.columns.length ?? 0) > 1}
                canResizeHeight={selBox.kind === "section"} doc={doc} pageSlug={pageSlug}
              />
            )}
            {drag.active && dragTarget?.container && <div className={cn("editor-drop-container", !dragTarget.valid && "is-invalid")} style={{ left: dragTarget.container.left, top: dragTarget.container.top, width: dragTarget.container.width, height: dragTarget.container.height }} />}
            {drag.active && dragTarget?.line && (
              <div
                className={cn("editor-drop-line", dragTarget.line.orientation, !dragTarget.valid && "is-invalid")}
                style={dragTarget.line.orientation === "horizontal" ? { left: dragTarget.line.x, top: dragTarget.line.y - 1.5, width: dragTarget.line.length } : { left: dragTarget.line.x - 1.5, top: dragTarget.line.y, height: dragTarget.line.length }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function getSectionOfColumn(doc: SiteContent, columnId: string) {
  const n = findNode(doc, columnId);
  return n?.sectionId ? getSection(doc, n.sectionId) : null;
}

// ---------------------------------------------------------------------------
// Selection chrome
// ---------------------------------------------------------------------------

function SelectionLayer({
  box, label, kindLabel, kind, editing, richText, instanceId, selection, dragging, shared, hasText, actions, stageWidth, onResizeColumn, onResizeHeight, canResizeColumn, canResizeHeight, doc, pageSlug,
}: {
  box: Box; label: string; kindLabel: string; kind: string; editing: boolean; richText: boolean; instanceId: string; selection: string; dragging: boolean; shared: boolean; hasText: boolean;
  actions: CanvasActions; stageWidth: number; onResizeColumn: (e: React.PointerEvent) => void; onResizeHeight: (e: React.PointerEvent) => void; canResizeColumn: boolean; canResizeHeight: boolean; doc: SiteContent; pageSlug: string;
}) {
  const node = findNode(doc, selection);
  const isSection = kind === "section" || kind === "header" || kind === "footer";
  const movable = kind !== "header" && kind !== "footer";
  const horizontal = kind === "column";
  const tbWidth = 300;
  const flipBelow = box.top < 44;
  const left = Math.max(0, Math.min(box.left, stageWidth - tbWidth));
  const handleSource: DragSource = { kind: "node", id: instanceId, label: label || kindLabel };
  void pageSlug;
  return (
    <>
      <div className={cn("editor-selected", dragging && "is-dragging")} style={{ left: box.left, top: box.top, width: box.width, height: box.height }} data-kind={kind} />
      {/* Toolbar */}
      {!editing || richText ? (
        <div className="pointer-events-auto absolute z-30" style={{ left, top: flipBelow ? box.top + 4 : box.top - 36 }} role="toolbar" aria-label={`${kindLabel} tools`}>
          <div className="flex items-center gap-0.5 rounded-xl bg-ink p-0.5 text-surface shadow-lg">
            {movable && (
              <DragHandle source={handleSource} label={`Drag ${kindLabel.toLowerCase()} to move it`} className="flex size-7 items-center justify-center rounded-lg hover:bg-white/15" />
            )}
            <span className="max-w-[10rem] truncate px-1.5 text-[11.5px] font-medium">{kindLabel}{shared ? " · shared" : ""}</span>
            {!editing && (
              <>
                {movable && (
                  <>
                    <TB label={horizontal ? "Move left" : "Move up"} onClick={() => actions.nudge(instanceId, -1)}>{horizontal ? <ArrowLeft className="size-3.5" /> : <ArrowUp className="size-3.5" />}</TB>
                    <TB label={horizontal ? "Move right" : "Move down"} onClick={() => actions.nudge(instanceId, 1)}>{horizontal ? <ArrowRight className="size-3.5" /> : <ArrowDown className="size-3.5" />}</TB>
                  </>
                )}
                {kind === "element" && <TB label="Select the item that contains this" onClick={() => actions.selectParent(selection)}><CornerLeftUp className="size-3.5" /></TB>}
                {kind === "column" && <TB label="Select the section" onClick={() => actions.selectParent(selection)}><CornerLeftUp className="size-3.5" /></TB>}
                {isSection && movable && <TB label="Add a section below" onClick={() => actions.addBelow(instanceId)}><Plus className="size-3.5" /></TB>}
                {movable && <TB label="Duplicate" onClick={() => actions.duplicate(instanceId)}><Copy className="size-3.5" /></TB>}
                {isSection && <TB label="Hide or show on the site" onClick={() => actions.toggleHidden(selection)}><EyeOff className="size-3.5" /></TB>}
                {(movable || kind === "header" || kind === "footer") && <TB label={isSection ? "Remove" : "Delete"} onClick={() => actions.remove(instanceId)}><Trash2 className="size-3.5" /></TB>}
                <Menu>
                  <MenuTrigger asChild>
                    <button type="button" aria-label="More" className="flex size-7 items-center justify-center rounded-lg hover:bg-white/15"><MoreHorizontal className="size-3.5" /></button>
                  </MenuTrigger>
                  <MenuContent align="start">
                    {node?.kind === "element" && <MenuItem onSelect={() => actions.nudgeAcross(instanceId, -1)}>Move out of this container (earlier)</MenuItem>}
                    {node?.kind === "element" && <MenuItem onSelect={() => actions.nudgeAcross(instanceId, 1)}>Move into the next container</MenuItem>}
                    {isSection && node?.home?.type === "page" && <MenuItem onSelect={() => actions.makeShared(selection)}>Share across all pages</MenuItem>}
                    {isSection && shared && <MenuItem onSelect={() => actions.detachShared(instanceId)}>Make an independent copy for this page</MenuItem>}
                    {isSection && <MenuItem onSelect={() => actions.saveAsComponent(selection)}>Save as a component</MenuItem>}
                    {isSection && <MenuSeparator />}
                    <MenuItem onSelect={() => actions.select(null)}>Deselect</MenuItem>
                  </MenuContent>
                </Menu>
              </>
            )}
            {richText && (
              <>
                <TB label="Bold (Ctrl+B)" onMouseDown={(e) => { e.preventDefault(); const el = document.querySelector<HTMLElement>("[data-editing]"); if (el) wrapSelection(el, "**"); }}><Bold className="size-3.5" /></TB>
                <TB label="Emphasis (Ctrl+I)" onMouseDown={(e) => { e.preventDefault(); const el = document.querySelector<HTMLElement>("[data-editing]"); if (el) wrapSelection(el, "*"); }}><Italic className="size-3.5" /></TB>
                <TB label="Link the selected words" onMouseDown={(e) => { e.preventDefault(); const el = document.querySelector<HTMLElement>("[data-editing]"); if (el) wrapSelection(el, "[]"); }}><Link2 className="size-3.5" /></TB>
              </>
            )}
          </div>
        </div>
      ) : null}
      {!editing && hasText && kind === "element" && <div className="pointer-events-none absolute z-20 text-[10.5px] font-medium text-primary-ink" style={{ left: box.left, top: box.top + box.height + 4 }}><span className="rounded bg-primary-soft px-1.5 py-0.5">Click the text again to edit it</span></div>}
      {/* Resize handles */}
      {canResizeColumn && !editing && (
        <div className="pointer-events-auto absolute z-30 flex w-3 cursor-col-resize items-center justify-center" style={{ left: box.left + box.width - 6, top: box.top, height: box.height, touchAction: "none" }} onPointerDown={onResizeColumn} role="separator" aria-orientation="vertical" aria-label="Drag to change the column width">
          <span className="h-10 w-1.5 rounded-full bg-primary shadow" />
        </div>
      )}
      {canResizeHeight && !editing && (
        <div className="pointer-events-auto absolute z-30 flex h-3 cursor-row-resize items-center justify-center" style={{ left: box.left, top: box.top + box.height - 6, width: box.width, touchAction: "none" }} onPointerDown={onResizeHeight} role="separator" aria-orientation="horizontal" aria-label="Drag to change the section height">
          <span className="h-1.5 w-10 rounded-full bg-primary shadow" />
        </div>
      )}
    </>
  );
}

function TB({ label, children, onClick, onMouseDown }: { label: string; children: React.ReactNode; onClick?: () => void; onMouseDown?: (e: React.MouseEvent) => void }) {
  return (
    <IconButton label={label} onClick={onClick} onMouseDown={onMouseDown} side="top" className="size-7 text-surface hover:bg-white/15 hover:text-surface">{children}</IconButton>
  );
}

export { spanFromPixels };
