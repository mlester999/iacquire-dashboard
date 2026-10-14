"use client";

import * as React from "react";
import { animate, motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

/** Counts from the previously shown value to the new one, so live updates move smoothly instead of restarting. */
function CountUp({ value }: { value: number }) {
  const ref = React.useRef<HTMLSpanElement>(null);
  const prev = React.useRef(value);
  const reduce = useReducedMotion();
  React.useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (reduce) {
      node.textContent = String(value);
      prev.current = value;
      return;
    }
    const controls = animate(prev.current, value, {
      duration: 0.9,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (v) => {
        node.textContent = String(Math.round(v));
      },
    });
    prev.current = value;
    return () => controls.stop();
  }, [value, reduce]);
  return <span ref={ref}>{value}</span>;
}

/**
 * Animated completion ring. `percent` is null when there is nothing to measure yet; the ring then
 * stays empty and shows a dash instead of inventing a number.
 */
export function ProgressRing({
  percent,
  size = 132,
  stroke = 10,
  label = "Setup progress",
  caption,
  className,
}: {
  percent: number | null;
  size?: number;
  stroke?: number;
  label?: string;
  caption?: string;
  className?: string;
}) {
  const reduce = useReducedMotion();
  const id = React.useId().replace(/:/g, "");
  const r = (size - stroke) / 2;
  const value = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  const complete = percent === 100;
  return (
    <div className={cn("relative shrink-0", className)} style={{ width: size, height: size }} role="img" aria-label={percent === null ? `${label}: not measured yet` : `${label}: ${percent}%`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
        <defs>
          <linearGradient id={`g-${id}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={complete ? "var(--success)" : "var(--primary)"} />
            <stop offset="100%" stopColor={complete ? "var(--success)" : "var(--violet)"} />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-3)" strokeWidth={stroke} />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={`url(#g-${id})`}
          strokeWidth={stroke}
          strokeLinecap="round"
          initial={false}
          animate={{ pathLength: value / 100 }}
          transition={{ duration: reduce ? 0 : 1.1, ease: [0.16, 1, 0.3, 1] }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        {percent === null ? (
          <span className="text-[22px] font-semibold text-faint">—</span>
        ) : (
          <span className="flex items-baseline text-[30px] font-semibold leading-none tracking-tight text-ink" style={{ fontSize: size * 0.24 }}>
            <CountUp value={percent} />
            <span className="ml-0.5 font-medium text-muted" style={{ fontSize: size * 0.11 }}>
              %
            </span>
          </span>
        )}
        {caption && <span className="mt-1 text-[11px] font-medium uppercase tracking-wider text-muted">{caption}</span>}
      </div>
    </div>
  );
}
