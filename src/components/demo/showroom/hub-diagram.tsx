"use client";

import * as React from "react";
import { AgentAvatar } from "@/components/brand";
import { cn } from "@/lib/utils";
import { AGENT_ROLES } from "@/lib/agents";
import { useShowroom } from "@/components/demo/showroom/context";

// The business hub: the visitor's business in the middle, the six AI Employees around it, and a faint flow of work between them. It is a picture of how the roles surround one business, not
// a live view of anything. Every employee is a real button that opens that employee in the AI workforce view.

// Six positions around an ellipse, in percent of the box, starting at the top and going clockwise.
const SPOTS = [0, 1, 2, 3, 4, 5].map((i) => {
  const a = (-90 + i * 60) * (Math.PI / 180);
  return { x: 50 + 38 * Math.cos(a), y: 50 + 37 * Math.sin(a) };
});

export function BusinessHub({ className }: { className?: string }) {
  const { business, go } = useShowroom();
  const name = business?.trim() || "Your business";
  return (
    <div className={cn("relative mx-auto aspect-[2/0.95] w-full max-w-[820px] @4xl:aspect-[1/0.93] @4xl:max-w-[560px]", className)}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 size-full" aria-hidden>
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
        {/* The hand-offs between neighbours: the order in which the roles pass work along. */}
        {SPOTS.map((p, i) => {
          const q = SPOTS[(i + 1) % 6];
          return <line key={`n${i}`} x1={p.x} y1={p.y} x2={q.x} y2={q.y} style={{ stroke: "var(--line-strong)" }} strokeWidth="1" vectorEffect="non-scaling-stroke" />;
        })}
      </svg>

      <div className="absolute left-1/2 top-1/2 grid -translate-x-1/2 -translate-y-1/2 place-items-center">
        <span className="sx-ping absolute size-28 rounded-full border border-primary/40 @xl:size-32" aria-hidden />
        <div className="relative grid size-28 place-items-center rounded-full border border-line-strong bg-gradient-to-b from-surface-3 to-surface p-3 text-center shadow-[var(--glow)] @xl:size-32">
          <span>
            <span className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-primary-ink">Your business</span>
            <span className="mt-1 line-clamp-3 block break-words text-[13px] font-semibold leading-tight text-ink @xl:text-[14px]">{name}</span>
          </span>
        </div>
      </div>

      {AGENT_ROLES.map((role, i) => {
        const p = SPOTS[i];
        return (
          <button
            key={role.key}
            type="button"
            onClick={() => go("workforce", role.key)}
            style={{ left: `${p.x}%`, top: `${p.y}%` }}
            className="group absolute z-10 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1.5 rounded-2xl p-1.5 text-center outline-offset-2 transition-transform hover:scale-105"
            aria-label={`Open ${role.shortName}`}
          >
            <span className={cn("rounded-2xl shadow-md ring-1 ring-line", i % 2 ? "sx-bob" : "sx-bob [animation-delay:-2.5s]")}>
              <AgentAvatar role={role} size="lg" eager />
            </span>
            <span className="max-w-[92px] text-[12px] font-semibold leading-tight text-ink-2 group-hover:text-ink @xl:max-w-[120px] @xl:text-[13px]">{role.shortName}</span>
          </button>
        );
      })}
    </div>
  );
}
