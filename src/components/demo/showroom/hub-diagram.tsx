"use client";

import * as React from "react";
import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { DEMO_CAPABILITY_AREAS } from "@/lib/demo/showroom/content";
import { useShowroom } from "@/components/demo/showroom/context";

// The business hub: the visitor's business and one AI Growth Partner in the middle, with six internal capability areas around it. This is a picture of the product model, not a live view.
//
// The same capability buttons use a grid on smaller screens and an ellipse on wider screens. Every button opens the single Growth Partner overview.

// Six positions around an ellipse, in percent of the box, starting at the top and going clockwise.
const SPOTS = [0, 1, 2, 3, 4, 5].map((i) => {
  const a = (-90 + i * 60) * (Math.PI / 180);
  return { x: 50 + 38 * Math.cos(a), y: 50 + 37 * Math.sin(a) };
});

export function BusinessHub({ className }: { className?: string }) {
  const { business, go } = useShowroom();
  const name = business?.trim() || "Your business";
  return (
    <div
      data-business-hub
      role="group"
      aria-label="Your business and the six capabilities of one AI Growth Partner"
      className={cn(
        "relative mx-auto grid w-full max-w-[820px] grid-cols-2 gap-3 @lg:grid-cols-3",
        "@2xl:block @2xl:aspect-[2/0.95] @2xl:gap-0 @4xl:aspect-[1/0.93] @4xl:max-w-[560px]",
        className,
      )}
    >
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 hidden size-full @2xl:block" aria-hidden>
        <defs>
          <linearGradient id="hub-line" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" style={{ stopColor: "var(--primary)" }} stopOpacity="0.9" />
            <stop offset="1" style={{ stopColor: "var(--violet)" }} stopOpacity="0.9" />
          </linearGradient>
        </defs>
        <ellipse cx="50" cy="50" rx="38" ry="37" fill="none" style={{ stroke: "var(--line-strong)" }} strokeWidth="1" vectorEffect="non-scaling-stroke" strokeDasharray="2 6" />
        {SPOTS.map((p, i) => (
          <line key={i} x1="50" y1="50" x2={p.x} y2={p.y} stroke="url(#hub-line)" strokeWidth="1.5" strokeOpacity="0.55" vectorEffect="non-scaling-stroke" className="sx-flow" />
        ))}
      </svg>

      <div data-hub-centre className="col-span-full @2xl:absolute @2xl:left-1/2 @2xl:top-1/2 @2xl:grid @2xl:-translate-x-1/2 @2xl:-translate-y-1/2 @2xl:place-items-center">
        <span className="sx-ping absolute hidden size-32 rounded-full border border-primary/40 @2xl:block" aria-hidden />
        <div className="relative rounded-2xl border border-line-strong bg-gradient-to-b from-surface-3 to-surface px-4 py-3.5 text-center shadow-[var(--glow)] @2xl:grid @2xl:size-32 @2xl:place-items-center @2xl:rounded-full @2xl:p-3">
          <span>
            <span className="block text-[12px] font-semibold uppercase tracking-[0.12em] text-primary-ink">AI Growth Partner</span>
            <span className="mt-1 block break-words text-[15px] font-semibold leading-tight text-ink @2xl:line-clamp-3 @2xl:text-[13px]">{name}</span>
          </span>
        </div>
      </div>

      {/* A short line of work from the partner to its capabilities, drawn only where the cards are a grid below it. */}
      <span aria-hidden className="col-span-full mx-auto -my-1 h-4 w-px bg-line-strong @2xl:hidden" />

      {DEMO_CAPABILITY_AREAS.map((area, i) => {
        const p = SPOTS[i];
        return (
          <button
            key={area.key}
            type="button"
            onClick={() => go("workforce")}
            style={{ "--hub-x": `${p.x}%`, "--hub-y": `${p.y}%` } as React.CSSProperties}
            className={cn(
              "group relative flex min-h-[7.25rem] min-w-0 flex-col items-center justify-center gap-2 rounded-2xl border border-line bg-surface px-2 py-3.5 text-center shadow-[var(--shadow-sm)] outline-offset-2 transition-[transform,border-color,box-shadow] @max-2xl:hover:-translate-y-0.5 @max-2xl:hover:border-line-strong",
              "@2xl:absolute @2xl:left-[var(--hub-x)] @2xl:top-[var(--hub-y)] @2xl:z-10 @2xl:min-h-0 @2xl:w-28 @2xl:-translate-x-1/2 @2xl:-translate-y-1/2 @2xl:gap-1.5 @2xl:border-transparent @2xl:bg-transparent @2xl:p-1.5 @2xl:shadow-none @2xl:transition-transform @2xl:hover:scale-105",
            )}
            aria-label={`Open ${area.title}`}
          >
            <span className={cn("grid size-12 place-items-center rounded-2xl border border-primary/15 bg-surface text-primary shadow-md", i % 2 ? "sx-bob" : "sx-bob [animation-delay:-2.5s]")}>
              <Sparkles className="size-5" aria-hidden />
            </span>
            <span data-capability-name className="block max-w-full break-words text-[12px] font-semibold leading-tight text-ink-2 group-hover:text-ink @2xl:max-w-[110px]">{area.title}</span>
          </button>
        );
      })}
    </div>
  );
}
