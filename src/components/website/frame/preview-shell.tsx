"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { Expand, Minimize, Monitor, Smartphone, Tablet, X } from "lucide-react";
import { captureAnchor, keyScroll, readerMoved, restoreAnchor, wheelDeltaPx, type ScrollAnchor, type SectionBox } from "@/lib/website/preview-scroll";
import { cn } from "@/lib/utils";

const DEVICES = [
  { width: 1440, label: "Desktop", icon: Monitor }, { width: 1024, label: "Landscape", icon: Monitor },
  { width: 768, label: "Tablet", icon: Tablet }, { width: 390, label: "Phone", icon: Smartphone },
] as const;

/** The largest preset that fits the window with at most a little scaling, so a phone opens at phone width, not a 25% desktop. */
function defaultDevice(available: number): number {
  return (DEVICES.find((d) => d.width <= available * 1.18) ?? DEVICES[DEVICES.length - 1]).width;
}

/** The framed website is same-origin by design (/frame/*), but a browser may still refuse access; every use below degrades to doing nothing. */
function frameWindow(frame: HTMLIFrameElement | null): Window | null {
  try { return frame?.contentWindow && frame.contentDocument ? frame.contentWindow : null; } catch { return null; }
}

function sectionBoxes(win: Window): SectionBox[] {
  const seen = new Set<string>();
  const boxes: SectionBox[] = [];
  for (const el of win.document.querySelectorAll<HTMLElement>(".iq-site > [id], .iq-site [data-site-main] > [id]")) {
    if (seen.has(el.id)) continue;
    // A stuck header's measured top always equals the scroll offset, which would make it the anchor for every position.
    const position = win.getComputedStyle(el).position;
    if (position === "sticky" || position === "fixed") continue;
    seen.add(el.id);
    boxes.push({ id: el.id, top: el.getBoundingClientRect().top + win.scrollY, height: el.offsetHeight });
  }
  return boxes.sort((a, b) => a.top - b.top);
}

/** The website document owns scrolling. Scaling never changes its responsive viewport, and device changes never remount the frame. The area around
 * a narrow website, and the dialog's own controls, still scroll it, so there is no part of the preview where the wheel or the keys do nothing. */
export function PreviewShell({ title, subtitle, src, onClose, actions, pages, page, onPageChange }: {
  title: string; subtitle?: string; src: string; onClose: () => void; actions?: React.ReactNode;
  pages?: Array<{ slug: string; title: string }>; page?: string; onPageChange?: (slug: string) => void;
}) {
  const dialog = React.useRef<HTMLDialogElement>(null);
  const stage = React.useRef<HTMLDivElement>(null);
  const frame = React.useRef<HTMLIFrameElement>(null);
  const anchor = React.useRef<ScrollAnchor | null>(null);
  const touched = React.useRef(false);
  /** Where the preview itself last put the page while restoring a place, to tell its own moves from the reader's. */
  const placedAt = React.useRef<number | null>(null);
  const timers = React.useRef<number[]>([]);
  const settling = React.useRef<ResizeObserver | null>(null);
  const chosen = React.useRef(false);
  const closeRef = React.useRef(onClose);
  React.useEffect(() => { closeRef.current = onClose; });
  const [width, setWidth] = React.useState(() => defaultDevice(typeof window === "undefined" ? 1440 : window.innerWidth));
  const [size, setSize] = React.useState({ width: 1440, height: 800 });
  const [fullscreen, setFullscreen] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [mounted, setMounted] = React.useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- native dialog portals mount only after browser hydration.
  React.useEffect(() => { setMounted(true); }, []);

  React.useEffect(() => {
    if (!mounted) return;
    const el = dialog.current;
    const area = stage.current;
    if (!el || !area) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    el.showModal();
    const observer = new ResizeObserver(() => {
      setSize({ width: area.clientWidth, height: area.clientHeight });
      // Until the reader picks a device, the preset follows the space actually available.
      if (!chosen.current) setWidth(defaultDevice(area.clientWidth));
    });
    observer.observe(area);
    const changed = () => setFullscreen(document.fullscreenElement === el);
    document.addEventListener("fullscreenchange", changed);
    // A wheel over the empty area beside a narrow website scrolls the website. (A wheel over the website itself is the website's own.)
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      const win = frameWindow(frame.current);
      if (!win) return;
      touched.current = true;
      win.scrollBy({ top: wheelDeltaPx(event.deltaY, event.deltaMode, win.innerHeight), left: wheelDeltaPx(event.deltaX, event.deltaMode, win.innerWidth), behavior: "auto" });
    };
    area.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      observer.disconnect();
      area.removeEventListener("wheel", onWheel);
      document.removeEventListener("fullscreenchange", changed);
      timers.current.forEach((t) => window.clearTimeout(t));
      settling.current?.disconnect();
      if (document.fullscreenElement === el) void document.exitFullscreen().catch(() => undefined);
      el.close();
      document.body.style.overflow = previous;
      opener?.focus({ preventScroll: true });
    };
  }, [mounted]);

  // Keys that scroll a page work from the dialog's own controls too, not only after the reader clicks into the website.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDialogElement>) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable='true']")) return;
    const win = frameWindow(frame.current);
    if (!win) return;
    const action = keyScroll(event.key, event.shiftKey, win.innerHeight, Boolean(target.closest("button, a, [role='button']")));
    if (!action) return;
    event.preventDefault();
    touched.current = true;
    if (action.kind === "by") win.scrollBy({ top: action.dy, behavior: "auto" });
    else win.scrollTo({ top: action.edge === "top" ? 0 : win.document.documentElement.scrollHeight, behavior: "auto" });
  };

  const stopSettling = () => {
    settling.current?.disconnect();
    settling.current = null;
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  };

  /** Changing the device changes the website's own width, so the same pixel offset is a different place. Keep the reader in the same section. */
  const chooseWidth = (next: number) => {
    chosen.current = true;
    if (next === width) return;
    const win = frameWindow(frame.current);
    if (win) anchor.current = captureAnchor(win.scrollY, win.document.documentElement.scrollHeight, win.innerHeight, sectionBoxes(win));
    touched.current = false;
    placedAt.current = null;
    setWidth(next);
    stopSettling();
    // The website re-lays itself out over a few frames (and again as fonts and pictures settle, however slowly), so the position is re-applied
    // each time its size really changes during a short window, and on a few early timers, until the reader scrolls.
    const apply = () => {
      const current = frameWindow(frame.current);
      if (!current || !anchor.current || touched.current) return;
      const height = current.document.documentElement.scrollHeight;
      // The reader scrolled somewhere else since the last placement (for instance by dragging the scrollbar, which the page never sees as an event): their place wins.
      if (readerMoved(current.scrollY, placedAt.current, height - current.innerHeight)) { touched.current = true; stopSettling(); return; }
      const top = restoreAnchor(anchor.current, height, current.innerHeight, sectionBoxes(current));
      if (Math.abs(top - current.scrollY) > 1) current.scrollTo({ top, behavior: "auto" });
      placedAt.current = current.scrollY;
    };
    if (win) {
      const Observer = (win as Window & typeof globalThis).ResizeObserver;
      settling.current = new Observer(apply);
      settling.current.observe(win.document.documentElement);
    }
    timers.current = [60, 180, 420, 900].map((delay) => window.setTimeout(apply, delay));
    timers.current.push(window.setTimeout(stopSettling, 4000));
  };

  const scale = Math.min(1, Math.max(1, size.width - 24) / width);
  const frameHeight = Math.max(200, Math.round((size.height - 24) / scale));
  if (!mounted) return null;
  return createPortal(
    <dialog ref={dialog} aria-label={`Preview of ${title}`} aria-describedby="preview-help" onKeyDown={onKeyDown} onCancel={(event) => { event.preventDefault(); onClose(); }}
      className="fixed inset-0 m-0 h-dvh max-h-none w-screen max-w-none border-0 bg-[#12151c] p-0 text-white backdrop:bg-black/70 open:flex open:flex-col">
      {/* A div, not a header: inside a dialog a header still counts as the page's banner landmark, giving the page two. */}
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-white/10 bg-[#0c0f15] px-4 py-3">
        <div className="mr-auto min-w-0"><h2 className="text-sm font-semibold">{title}</h2>{subtitle && <p className="text-xs text-white/65">{subtitle}</p>}</div>
        <div role="group" aria-label="Preview viewport" className="flex rounded-lg bg-white/10 p-1">
          {DEVICES.map((device) => <button key={device.width} type="button" aria-pressed={width === device.width} aria-label={`${device.label} ${device.width}px`} title={`${device.label} · ${device.width}px`} onClick={() => chooseWidth(device.width)}
            className={cn("flex min-h-9 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium focus-visible:outline-2 focus-visible:outline-white", width === device.width ? "bg-white text-[#0c0f15]" : "text-white/75 hover:bg-white/10 hover:text-white")}><device.icon className="size-4" aria-hidden /><span className="hidden sm:inline">{device.label}</span></button>)}
        </div>
        {actions}
        <button type="button" aria-label={fullscreen ? "Exit full screen" : "Enter full screen"} title={fullscreen ? "Exit full screen" : "Full screen"} onClick={async () => {
          try { if (document.fullscreenElement) await document.exitFullscreen(); else await dialog.current?.requestFullscreen(); } catch { /* Preview still fills the available app viewport. */ }
        }} className="flex size-10 items-center justify-center rounded-lg bg-white/10 hover:bg-white/20">{fullscreen ? <Minimize className="size-4" /> : <Expand className="size-4" />}</button>
        <button type="button" onClick={onClose} className="flex min-h-10 items-center gap-1.5 rounded-lg bg-white/10 px-3 text-xs font-medium hover:bg-white/20"><X className="size-4" aria-hidden />Close</button>
      </div>
      {pages && onPageChange && <nav aria-label="Pages in this template" className="relative flex shrink-0 gap-1 overflow-x-auto border-b border-white/10 bg-[#0c0f15] px-4 py-2">{pages.map((item) => <button type="button" key={item.slug} aria-current={page === item.slug ? "page" : undefined} onClick={() => { if (item.slug === page) return; setLoading(true); onPageChange(item.slug); }} className={cn("min-h-9 shrink-0 rounded-md px-3 text-xs", page === item.slug ? "bg-white/15 text-white" : "text-white/70 hover:bg-white/10")}>{item.title}</button>)}</nav>}
      <div ref={stage} role="region" aria-label="Website preview area" className="relative min-h-0 flex-1 overflow-hidden">
        {loading && <p role="status" className="absolute left-1/2 top-8 z-10 -translate-x-1/2 rounded-full bg-[#0c0f15] px-4 py-2 text-xs shadow-lg">Opening website…</p>}
        <div className="absolute left-1/2 top-3 -translate-x-1/2" style={{ width: width * scale, height: frameHeight * scale }}>
          <iframe ref={frame} title={`${title} website preview`} src={src} className="block origin-top-left rounded-lg border-0 bg-white shadow-2xl" style={{ width, height: frameHeight, transform: `scale(${scale})` }} onLoad={(event) => {
            setLoading(false);
            anchor.current = null;
            stopSettling();
            const win = frameWindow(event.currentTarget);
            if (win) {
              // Anything the reader does inside the website itself ends the "keep my place" adjustment. The listeners last as long as this
              // document does (each page load is a new one), because every later device change starts a new adjustment.
              const stop = () => { touched.current = true; };
              for (const type of ["wheel", "touchstart", "keydown", "pointerdown"] as const) win.addEventListener(type, stop, { passive: true });
              // A key pressed inside the frame never reaches the dialog, so Escape would not close the preview once the reader clicked into the site.
              win.addEventListener("keydown", (key) => { if (key.key === "Escape" && !key.defaultPrevented) { key.preventDefault(); closeRef.current(); } });
            }
            try {
              const next = new URL(event.currentTarget.contentWindow!.location.href).searchParams.get("p");
              if (next && next !== page && pages?.some((item) => item.slug === next)) onPageChange?.(next);
            } catch { /* Retain the page when frame navigation cannot be read. */ }
          }} />
        </div>
      </div>
      <div className="flex shrink-0 justify-between gap-4 px-4 py-1.5 text-[11px] text-white/65"><span>{width}px viewport · {Math.round(scale * 100)}%</span><span id="preview-help">Scroll anywhere, or use Page Up, Page Down, Home and End · Esc to close</span></div>
    </dialog>, document.body,
  );
}
