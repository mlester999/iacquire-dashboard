"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { Expand, Minimize, Monitor, Smartphone, Tablet, X } from "lucide-react";
import { cn } from "@/lib/utils";

const DEVICES = [
  { width: 1440, label: "Desktop", icon: Monitor }, { width: 1024, label: "Landscape", icon: Monitor },
  { width: 768, label: "Tablet", icon: Tablet }, { width: 390, label: "Phone", icon: Smartphone },
] as const;

/** The website document owns scrolling. Scaling never changes its responsive
 * viewport, and device changes never remount the frame or reset its scroll. */
export function PreviewShell({ title, subtitle, src, onClose, actions, pages, page, onPageChange }: {
  title: string; subtitle?: string; src: string; onClose: () => void; actions?: React.ReactNode;
  pages?: Array<{ slug: string; title: string }>; page?: string; onPageChange?: (slug: string) => void;
}) {
  const dialog = React.useRef<HTMLDialogElement>(null);
  const stage = React.useRef<HTMLDivElement>(null);
  const [width, setWidth] = React.useState(1440);
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
    const observer = new ResizeObserver(() => setSize({ width: area.clientWidth, height: area.clientHeight }));
    observer.observe(area);
    const changed = () => setFullscreen(document.fullscreenElement === el);
    document.addEventListener("fullscreenchange", changed);
    return () => {
      observer.disconnect();
      document.removeEventListener("fullscreenchange", changed);
      if (document.fullscreenElement === el) void document.exitFullscreen().catch(() => undefined);
      el.close();
      document.body.style.overflow = previous;
      opener?.focus({ preventScroll: true });
    };
  }, [mounted]);
  const scale = Math.min(1, Math.max(1, size.width - 24) / width);
  const frameHeight = Math.max(200, (size.height - 24) / scale);
  if (!mounted) return null;
  return createPortal(
    <dialog ref={dialog} aria-label={`Preview of ${title}`} onCancel={(event) => { event.preventDefault(); onClose(); }}
      className="fixed inset-0 m-0 h-dvh max-h-none w-screen max-w-none border-0 bg-[#12151c] p-0 text-white backdrop:bg-black/70 open:flex open:flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-white/10 bg-[#0c0f15] px-4 py-3">
        <div className="mr-auto min-w-0"><h2 className="text-sm font-semibold">{title}</h2>{subtitle && <p className="text-xs text-white/65">{subtitle}</p>}</div>
        <div role="group" aria-label="Preview viewport" className="flex rounded-lg bg-white/10 p-1">
          {DEVICES.map((device) => <button key={device.width} type="button" aria-pressed={width === device.width} aria-label={`${device.label} ${device.width}px`} title={`${device.label} · ${device.width}px`} onClick={() => setWidth(device.width)}
            className={cn("flex min-h-9 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium focus-visible:outline-2 focus-visible:outline-white", width === device.width ? "bg-white text-[#0c0f15]" : "text-white/75 hover:bg-white/10 hover:text-white")}><device.icon className="size-4" aria-hidden /><span className="hidden sm:inline">{device.label}</span></button>)}
        </div>
        {actions}
        <button type="button" aria-label={fullscreen ? "Exit full screen" : "Enter full screen"} title={fullscreen ? "Exit full screen" : "Full screen"} onClick={async () => {
          try { if (document.fullscreenElement) await document.exitFullscreen(); else await dialog.current?.requestFullscreen(); } catch { /* Preview still fills the available app viewport. */ }
        }} className="flex size-10 items-center justify-center rounded-lg bg-white/10 hover:bg-white/20">{fullscreen ? <Minimize className="size-4" /> : <Expand className="size-4" />}</button>
        <button type="button" onClick={onClose} className="flex min-h-10 items-center gap-1.5 rounded-lg bg-white/10 px-3 text-xs font-medium hover:bg-white/20"><X className="size-4" aria-hidden />Close</button>
      </header>
      {pages && onPageChange && <nav aria-label="Pages in this template" className="flex shrink-0 gap-1 overflow-x-auto border-b border-white/10 bg-[#0c0f15] px-4 py-2">{pages.map((item) => <button type="button" key={item.slug} aria-current={page === item.slug ? "page" : undefined} onClick={() => { setLoading(true); onPageChange(item.slug); }} className={cn("min-h-9 shrink-0 rounded-md px-3 text-xs", page === item.slug ? "bg-white/15 text-white" : "text-white/70 hover:bg-white/10")}>{item.title}</button>)}</nav>}
      <div ref={stage} className="relative min-h-0 flex-1 overflow-hidden" aria-label="Website preview area">
        {loading && <p role="status" className="absolute left-1/2 top-8 z-10 -translate-x-1/2 rounded-full bg-[#0c0f15] px-4 py-2 text-xs shadow-lg">Opening website…</p>}
        <div className="absolute left-1/2 top-3 -translate-x-1/2" style={{ width: width * scale, height: frameHeight * scale }}>
          <iframe title={`${title} website preview`} src={src} className="block origin-top-left rounded-lg border-0 bg-white shadow-2xl" style={{ width, height: frameHeight, transform: `scale(${scale})` }} onLoad={(event) => {
            setLoading(false);
            try {
              const next = new URL(event.currentTarget.contentWindow!.location.href).searchParams.get("p");
              if (next && next !== page && pages?.some((item) => item.slug === next)) onPageChange?.(next);
            } catch { /* Retain the page when frame navigation cannot be read. */ }
          }} />
        </div>
      </div>
      <div className="flex shrink-0 justify-between px-4 py-1.5 text-[11px] text-white/65"><span>{width}px viewport · {Math.round(scale * 100)}%</span><span>Scroll inside the website · Esc to close</span></div>
    </dialog>, document.body,
  );
}
