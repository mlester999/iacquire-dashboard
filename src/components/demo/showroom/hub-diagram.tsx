"use client";

import * as React from "react";
import { AgentAvatar } from "@/components/brand";
import { cn } from "@/lib/utils";
import { AGENT_ROLES } from "@/lib/agents";
import { useShowroom } from "@/components/demo/showroom/context";

// The business hub: the visitor's business in the middle, the six AI Employees around it, and a faint flow of work between them. It is a picture of how the roles surround one business, not
// a live view of anything. Every employee is a real button that opens that employee in the AI workforce view.
//
// One set of buttons, two arrangements, chosen by the width of the demo's content area (the `@container` on <main>), so there is never a second copy of the employees on the page:
//   * narrower than @2xl (phones, and small windows): the business is a card, and the six employees are a grid of cards under it, two across (three from @lg). Nothing is positioned by
//     percentage, so nothing can collide: a long business name or a long role name just wraps, and every card is a comfortable touch target.
//   * @2xl and wider (tablets, laptops, desktops): the picture, with the employees around the business on an ellipse. Wide and flat in a single column, near-square beside the
//     headline from @4xl. The ellipse is only used where it has room: its height is half its width, and the circle in the middle and the avatars around it were checked not to touch.

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
      aria-label="Your business and its six AI Employees"
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
        {/* The hand-offs between neighbours: the order in which the roles pass work along. */}
        {SPOTS.map((p, i) => {
          const q = SPOTS[(i + 1) % 6];
          return <line key={`n${i}`} x1={p.x} y1={p.y} x2={q.x} y2={q.y} style={{ stroke: "var(--line-strong)" }} strokeWidth="1" vectorEffect="non-scaling-stroke" />;
        })}
      </svg>

      <div data-hub-centre className="col-span-full @2xl:absolute @2xl:left-1/2 @2xl:top-1/2 @2xl:grid @2xl:-translate-x-1/2 @2xl:-translate-y-1/2 @2xl:place-items-center">
        <span className="sx-ping absolute hidden size-32 rounded-full border border-primary/40 @2xl:block" aria-hidden />
        <div className="relative rounded-2xl border border-line-strong bg-gradient-to-b from-surface-3 to-surface px-4 py-3.5 text-center shadow-[var(--glow)] @2xl:grid @2xl:size-32 @2xl:place-items-center @2xl:rounded-full @2xl:p-3">
          <span>
            <span className="block text-[12px] font-semibold uppercase tracking-[0.12em] text-primary-ink">Your business</span>
            <span className="mt-1 block break-words text-[16px] font-semibold leading-tight text-ink @2xl:line-clamp-3 @2xl:text-[14px]">{name}</span>
          </span>
        </div>
      </div>

      {/* A short line of work from the business down to its team, drawn only where the team is a grid under it. */}
      <span aria-hidden className="col-span-full mx-auto -my-1 h-4 w-px bg-line-strong @2xl:hidden" />

      {AGENT_ROLES.map((role, i) => {
        const p = SPOTS[i];
        return (
          <button
            key={role.key}
            type="button"
            onClick={() => go("workforce", role.key)}
            style={{ "--hub-x": `${p.x}%`, "--hub-y": `${p.y}%` } as React.CSSProperties}
            className={cn(
              "group relative flex min-h-[7.25rem] min-w-0 flex-col items-center justify-center gap-2 rounded-2xl border border-line bg-surface px-2 py-3.5 text-center shadow-[var(--shadow-sm)] outline-offset-2 transition-[transform,border-color,box-shadow] @max-2xl:hover:-translate-y-0.5 @max-2xl:hover:border-line-strong",
              "@2xl:absolute @2xl:left-[var(--hub-x)] @2xl:top-[var(--hub-y)] @2xl:z-10 @2xl:min-h-0 @2xl:-translate-x-1/2 @2xl:-translate-y-1/2 @2xl:gap-1.5 @2xl:border-transparent @2xl:bg-transparent @2xl:p-1.5 @2xl:shadow-none @2xl:transition-transform @2xl:hover:scale-105",
            )}
            aria-label={`Open ${role.shortName}`}
          >
            <span className={cn("rounded-2xl shadow-md ring-1 ring-line", i % 2 ? "sx-bob" : "sx-bob [animation-delay:-2.5s]")}>
              <AgentAvatar role={role} size="lg" eager />
            </span>
            <span data-role-name className="block max-w-full break-words text-[13px] font-semibold leading-tight text-ink-2 group-hover:text-ink @2xl:max-w-[120px]">{role.shortName}</span>
          </button>
        );
      })}
    </div>
  );
}
