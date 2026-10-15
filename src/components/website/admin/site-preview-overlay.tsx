"use client";

import * as React from "react";
import { Eye, Monitor, Smartphone, Tablet, X } from "lucide-react";
import { cn } from "@/lib/utils";

const DEVICES = [{ id: "desktop", label: "Desktop", width: 1440, icon: Monitor }, { id: "tablet", label: "Tablet", width: 768, icon: Tablet }, { id: "mobile", label: "Phone", width: 390, icon: Smartphone }] as const;

/** A client's draft, in an isolated frame, at a chosen device width. Read-only: nothing here changes the site. */
export function SitePreviewOverlay({ title, src, onClose, actions, note = "draft" }: { title: string; src: string; onClose: () => void; actions?: React.ReactNode; note?: string }) {
  const [device, setDevice] = React.useState<(typeof DEVICES)[number]["id"]>("desktop");
  const wrap = React.useRef<HTMLDivElement>(null);
  const [w, setW] = React.useState(1200);
  const close = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    close.current?.focus();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const ro = new ResizeObserver(() => setW(wrap.current?.clientWidth ?? 1200));
    if (wrap.current) ro.observe(wrap.current);
    return () => {
      window.removeEventListener("keydown", key);
      document.body.style.overflow = prev;
      ro.disconnect();
    };
  }, [onClose]);
  const d = DEVICES.find((x) => x.id === device)!;
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#12151c]" role="dialog" aria-modal="true" aria-label={`Preview: ${title}`}>
      <div className="flex flex-wrap items-center gap-3 border-b border-white/10 bg-[#0c0f15] px-4 py-2.5 text-white">
        <p className="flex items-center gap-2 text-[13.5px] font-semibold"><Eye className="size-4 text-[#9ebcff]" aria-hidden /> {title} <span className="font-normal text-white/55">· {note}</span></p>
        <div role="radiogroup" aria-label="Device" className="ml-auto flex rounded-lg bg-white/10 p-0.5">
          {DEVICES.map((x) => (
            <button key={x.id} type="button" role="radio" aria-checked={device === x.id} onClick={() => setDevice(x.id)} className={cn("flex h-8 items-center gap-1.5 rounded-md px-3 text-[12px] font-medium", device === x.id ? "bg-white text-[#0c0f15]" : "text-white/70 hover:text-white")}><x.icon className="size-3.5" aria-hidden />{x.label}</button>
          ))}
        </div>
        {actions}
        <button ref={close} type="button" onClick={onClose} className="flex h-8 items-center gap-1.5 rounded-lg bg-white/10 px-3 text-[12.5px] font-medium hover:bg-white/20"><X className="size-4" aria-hidden /> Close</button>
      </div>
      <div ref={wrap} className="min-h-0 flex-1 overflow-auto p-4">
        <iframe key={device} title={`Preview of ${title}`} src={src} className="mx-auto block h-full min-h-[24rem] rounded-xl border-0 bg-white shadow-2xl" style={{ width: Math.min(d.width, Math.max(320, w - 32)) }} />
      </div>
    </div>
  );
}
