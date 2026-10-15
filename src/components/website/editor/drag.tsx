"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { GripVertical } from "lucide-react";
import type { ElementType } from "@/lib/website/catalog";
import type { Line, Point, Rect } from "@/lib/website/editor/dnd";
import { useMounted } from "./hooks";

/** Something that can be picked up: an existing piece of the page, or something new from the library. */
export type DragSource =
  | { kind: "node"; id: string; label: string }
  | { kind: "section-preset"; presetId: string; label: string }
  | { kind: "layout"; layoutId: string; label: string }
  | { kind: "element"; type: ElementType; label: string }
  | { kind: "saved"; savedId: string; label: string };

export interface DropTarget {
  parentId: string;
  /** Position among the parent's children once the dragged node (if any) has been taken out. */
  index: number;
  valid: boolean;
  reason?: string;
  line: Line | null;
  /** The container that would receive the item, to outline it. */
  container: Rect | null;
}

export type Locator = (source: DragSource, point: Point) => DropTarget | null;
export type Dropper = (source: DragSource, target: DropTarget) => void;

interface DragState {
  active: DragSource | null;
  target: DropTarget | null;
  point: Point | null;
}
interface DragApi extends DragState {
  start: (source: DragSource, e: { clientX: number; clientY: number; pointerId?: number; preventDefault?: () => void }) => void;
  setLocator: (fn: Locator | null) => void;
  setDropper: (fn: Dropper | null) => void;
  pointerRef: React.RefObject<Point | null>;
  /** True for a moment after a drag ends, so the click that follows a drop doesn't also insert something. */
  justDragged: () => boolean;
}

const DragContext = React.createContext<DragApi | null>(null);
export const useDrag = () => {
  const v = React.useContext(DragContext);
  if (!v) throw new Error("DragProvider is missing");
  return v;
};

const THRESHOLD = 5;

export function DragProvider({ children, onAnnounce }: { children: React.ReactNode; onAnnounce?: (message: string) => void }) {
  const [state, setState] = React.useState<DragState>({ active: null, target: null, point: null });
  const locator = React.useRef<Locator | null>(null);
  const dropper = React.useRef<Dropper | null>(null);
  const pointerRef = React.useRef<Point | null>(null);
  const session = React.useRef<{ source: DragSource; origin: Point; started: boolean } | null>(null);
  const cleanup = React.useRef<(() => void) | null>(null);
  const suppressUntil = React.useRef(0);

  const start: DragApi["start"] = React.useCallback((source, e) => {
    cleanup.current?.();
    session.current = { source, origin: { x: e.clientX, y: e.clientY }, started: false };
    const move = (ev: PointerEvent) => {
      const s = session.current;
      if (!s) return;
      const p = { x: ev.clientX, y: ev.clientY };
      pointerRef.current = p;
      if (!s.started) {
        if (Math.hypot(p.x - s.origin.x, p.y - s.origin.y) < THRESHOLD) return;
        s.started = true;
        document.body.style.cursor = "grabbing";
        document.body.style.userSelect = "none";
      }
      setState({ active: s.source, point: p, target: locator.current?.(s.source, p) ?? null });
    };
    const finish = (commit: boolean) => {
      const s = session.current;
      if (s?.started) suppressUntil.current = Date.now() + 350;
      const target = commit && s?.started && pointerRef.current ? locator.current?.(s.source, pointerRef.current) ?? null : null;
      if (s?.started && commit) {
        if (target && target.valid) {
          dropper.current?.(s.source, target);
        } else {
          onAnnounce?.(target?.reason ? `Can't drop here. ${target.reason}` : "Dropped outside the page, so nothing changed.");
        }
      }
      session.current = null;
      pointerRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      cleanup.current?.();
      cleanup.current = null;
      setState({ active: null, target: null, point: null });
    };
    const up = () => finish(true);
    const key = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") finish(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", () => finish(false));
    window.addEventListener("keydown", key);
    cleanup.current = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("keydown", key);
    };
  }, [onAnnounce]);

  React.useEffect(() => () => cleanup.current?.(), []);

  const api = React.useMemo<DragApi>(
    () => ({ ...state, start, pointerRef, justDragged: () => Date.now() < suppressUntil.current, setLocator: (fn) => { locator.current = fn; }, setDropper: (fn) => { dropper.current = fn; } }),
    [state, start],
  );
  return (
    <DragContext.Provider value={api}>
      {children}
      <DragGhost />
    </DragContext.Provider>
  );
}

function DragGhost() {
  const { active, point, target } = useDrag();
  const mounted = useMounted();
  if (!mounted || !active || !point) return null;
  const invalid = target ? !target.valid : false;
  return createPortal(
    <div aria-hidden className="pointer-events-none fixed z-[200]" style={{ left: point.x + 14, top: point.y + 14 }}>
      <div className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium shadow-lg ${invalid ? "bg-danger text-white" : "bg-ink text-surface"}`}>
        <GripVertical className="size-3.5 opacity-70" />
        <span className="max-w-[16rem] truncate">{active.label}</span>
      </div>
      {invalid && target?.reason && <div className="mt-1 max-w-[16rem] rounded-md bg-danger-soft px-2 py-1 text-[11px] text-danger-ink shadow">{target.reason}</div>}
    </div>,
    document.body,
  );
}

/** A grip that starts dragging `source` when pressed. Pointer events cover mouse, pen and touch. */
export function DragHandle({ source, label, className, children }: { source: DragSource; label: string; className?: string; children?: React.ReactNode }) {
  const { start } = useDrag();
  return (
    <span
      role="button" tabIndex={-1} aria-label={label} title={label}
      onPointerDown={(e) => {
        if (e.button !== 0 && e.pointerType === "mouse") return;
        e.preventDefault();
        e.stopPropagation();
        start(source, e);
      }}
      className={className}
      style={{ touchAction: "none", cursor: "grab" }}
    >
      {children ?? <GripVertical className="size-3.5" />}
    </span>
  );
}
