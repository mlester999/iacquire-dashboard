"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/**
 * Chooses which part of a picture stays in view when it is cropped to fit its frame. Click or drag on the picture to place the point, or use
 * the arrow keys on the handle (hold Shift for bigger steps). It sets the same two percentages as the sliders, so the result is identical.
 */
export function FocalPoint({ url, x, y, onChange, label = "Focal point" }: { url: string; x: number; y: number; onChange: (x: number, y: number) => void; label?: string }) {
  const box = React.useRef<HTMLDivElement>(null);
  const place = (clientX: number, clientY: number) => {
    const r = box.current?.getBoundingClientRect();
    if (!r || r.width === 0 || r.height === 0) return;
    onChange(clamp(((clientX - r.left) / r.width) * 100), clamp(((clientY - r.top) / r.height) * 100));
  };
  const key = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 2;
    const move: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const d = move[e.key];
    if (!d) return;
    e.preventDefault();
    onChange(clamp(x + d[0]), clamp(y + d[1]));
  };
  return (
    <div className="space-y-1.5">
      <div
        ref={box}
        onPointerDown={(e) => { if (e.button !== 0 && e.pointerType === "mouse") return; e.currentTarget.setPointerCapture(e.pointerId); place(e.clientX, e.clientY); }}
        onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) place(e.clientX, e.clientY); }}
        className="relative max-h-44 cursor-crosshair overflow-hidden rounded-lg border border-line bg-surface-3 select-none"
        style={{ touchAction: "none" }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt="" draggable={false} className="block max-h-44 w-full object-contain" />
        <button
          type="button" onKeyDown={key} aria-label={`${label}: ${x}% across, ${y}% down. Use the arrow keys to move it.`}
          className={cn("absolute size-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-primary/80 shadow-[0_0_0_2px_rgba(0,0,0,.35)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary")}
          style={{ left: `${x}%`, top: `${y}%` }}
        />
      </div>
      <p className="text-[12px] leading-relaxed text-muted">Click or drag to choose the part of the picture that should always stay in view. Now {x}% across, {y}% down.</p>
    </div>
  );
}
