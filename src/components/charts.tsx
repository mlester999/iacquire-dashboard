"use client";

import * as React from "react";
import { motion, useReducedMotion } from "motion/react";
import { Info, Table2 } from "lucide-react";
import { AnimatedNumber } from "@/components/brand";
import { Tooltip } from "@/components/ui/overlays";
import { cn, formatNumber } from "@/lib/utils";

function useWidth<T extends HTMLElement>() {
  const ref = React.useRef<T>(null);
  const [width, setWidth] = React.useState(0);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(el);
    setWidth(Math.floor(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

function niceMax(v: number) {
  if (v <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(v));
  const n = v / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

// ---------------------------------------------------------------------------
// Stat tile
// ---------------------------------------------------------------------------

export function StatTile({
  label,
  value,
  unavailableReason,
  definition,
  icon,
  href,
  accent = "primary",
  format,
  index = 0,
}: {
  label: string;
  value: number | null;
  unavailableReason?: string;
  definition: string;
  icon: React.ReactNode;
  href?: string;
  accent?: "primary" | "violet" | "success" | "warning";
  format?: (n: number) => string;
  index?: number;
}) {
  const reduce = useReducedMotion();
  const tone = {
    primary: "bg-primary-soft text-primary",
    violet: "bg-violet-soft text-violet",
    success: "bg-success-soft text-success",
    warning: "bg-warning-soft text-warning",
  }[accent];
  const content = (
    <motion.div
      style={{ animationDelay: `${index * 40}ms` }}
      whileHover={reduce ? undefined : { y: -2 }}
      className="card-surface rise-in group relative h-full overflow-hidden rounded-2xl p-4 transition-shadow hover:shadow-float sm:p-5"
    >
      <div aria-hidden className="pointer-events-none absolute -right-8 -top-8 size-24 rounded-full bg-primary/5 opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
      <div className="flex items-start justify-between gap-2">
        <span className={cn("flex size-9 items-center justify-center rounded-xl", tone)}>{icon}</span>
        <Tooltip content={definition}>
          <button type="button" className="rounded-md p-1 text-faint hover:text-muted" aria-label={`About ${label}`}>
            <Info className="size-3.5" />
          </button>
        </Tooltip>
      </div>
      <p className="mt-3 text-[12.5px] font-medium text-muted">{label}</p>
      {value === null ? (
        <p className="mt-1 flex items-baseline gap-2">
          <span className="text-[26px] font-semibold leading-none tracking-tight text-faint">—</span>
          <span className="text-[12px] text-muted">{unavailableReason ?? "Unavailable"}</span>
        </p>
      ) : (
        <AnimatedNumber value={value} format={format} className="mt-1 block text-[28px] font-semibold leading-none tracking-tight text-ink" />
      )}
    </motion.div>
  );
  return href ? (
    <a href={href} className="block h-full rounded-2xl focus-visible:outline-2">
      {content}
    </a>
  ) : (
    content
  );
}

// ---------------------------------------------------------------------------
// Single-series area chart with crosshair tooltip
// ---------------------------------------------------------------------------

export function AreaChart({
  data,
  height = 220,
  label,
  formatX,
  unit,
}: {
  data: Array<{ x: string; y: number }>;
  height?: number;
  label: string;
  formatX: (x: string) => string;
  unit: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = React.useState<number | null>(null);
  const [showTable, setShowTable] = React.useState(false);
  const reduce = useReducedMotion();
  const pad = { l: 32, r: 12, t: 12, b: 26 };
  const w = Math.max(0, width - pad.l - pad.r);
  const h = height - pad.t - pad.b;
  const max = niceMax(Math.max(...data.map((d) => d.y), 0));
  const x = (i: number) => pad.l + (data.length <= 1 ? w / 2 : (i / (data.length - 1)) * w);
  const y = (v: number) => pad.t + h - (v / max) * h;
  const line = data.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d.y).toFixed(1)}`).join(" ");
  const area = data.length ? `${line} L${x(data.length - 1).toFixed(1)},${pad.t + h} L${x(0).toFixed(1)},${pad.t + h} Z` : "";
  const ticks = [0, max / 2, max];
  const total = data.reduce((s, d) => s + d.y, 0);

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const rect = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const rel = (e.clientX - rect.left) / Math.max(1, rect.width);
    setHover(Math.max(0, Math.min(data.length - 1, Math.round(rel * (data.length - 1)))));
  };

  return (
    <div>
      <div className="mb-2 flex items-center justify-end">
        <button type="button" onClick={() => setShowTable((s) => !s)} className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-muted hover:bg-surface-2 hover:text-ink" aria-pressed={showTable}>
          <Table2 className="size-3.5" /> {showTable ? "Chart" : "Table"}
        </button>
      </div>
      {showTable ? (
        <div className="scrollbar-thin max-h-[240px] overflow-y-auto rounded-xl border border-line">
          <table className="w-full text-[13px]">
            <caption className="sr-only">{label}</caption>
            <thead className="bg-surface-2 text-left text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Day</th>
                <th className="px-3 py-2 text-right font-medium">{unit}</th>
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.x} className="border-t border-line">
                  <td className="px-3 py-1.5">{formatX(d.x)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{formatNumber(d.y)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={ref} className="relative w-full" style={{ height }}>
          {width > 0 && (
            <svg width={width} height={height} role="img" aria-label={`${label}: ${formatNumber(total)} ${unit} over ${data.length} days`}>
              <defs>
                <linearGradient id="area-wash" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="var(--series-1)" stopOpacity="0.16" />
                  <stop offset="1" stopColor="var(--series-1)" stopOpacity="0.02" />
                </linearGradient>
              </defs>
              {ticks.map((t) => (
                <g key={t}>
                  <line x1={pad.l} x2={pad.l + w} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth={1} />
                  <text x={pad.l - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-[var(--faint)] text-[11px] tabular-nums">
                    {formatNumber(t, { compact: true })}
                  </text>
                </g>
              ))}
              {data.map((d, i) =>
                i % Math.ceil(data.length / 7) === 0 || i === data.length - 1 ? (
                  <text key={d.x} x={x(i)} y={height - 6} textAnchor="middle" className="fill-[var(--faint)] text-[11px]">
                    {formatX(d.x)}
                  </text>
                ) : null,
              )}
              <motion.path d={area} fill="url(#area-wash)" initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.6 }} />
              <motion.path
                d={line}
                fill="none"
                stroke="var(--series-1)"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                initial={reduce ? false : { pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
              />
              {data.length > 0 && (
                <circle cx={x(data.length - 1)} cy={y(data[data.length - 1].y)} r={4} fill="var(--series-1)" stroke="var(--surface)" strokeWidth={2} />
              )}
              {hover !== null && (
                <g>
                  <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + h} stroke="var(--line-strong)" strokeWidth={1} />
                  <circle cx={x(hover)} cy={y(data[hover].y)} r={5} fill="var(--series-1)" stroke="var(--surface)" strokeWidth={2} />
                </g>
              )}
              <rect
                x={pad.l}
                y={pad.t}
                width={w}
                height={h}
                fill="transparent"
                onPointerMove={onMove}
                onPointerLeave={() => setHover(null)}
                style={{ touchAction: "pan-y" }}
              />
            </svg>
          )}
          {hover !== null && width > 0 && (
            <div
              className="pointer-events-none absolute z-10 rounded-xl border border-line bg-surface px-3 py-2 text-[12px] shadow-float"
              style={{ left: Math.min(Math.max(8, x(hover) - 60), width - 128), top: 0 }}
            >
              <p className="text-muted">{formatX(data[hover].x)}</p>
              <p className="font-semibold text-ink">
                {formatNumber(data[hover].y)} {unit}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ordinal funnel (horizontal bars, ordinal blue ramp, values outside the bar)
// ---------------------------------------------------------------------------

const RAMP = ["var(--ramp-250)", "var(--ramp-350)", "var(--ramp-450)", "var(--ramp-550)", "var(--ramp-650)"];

/**
 * Stages may carry a `source`. Step conversion ("x% of previous") is only shown between stages from
 * the same source where the count narrows — a ratio across systems or above 100% would mislead.
 */
export function Funnel({ stages, unavailableLabel = "Not connected" }: { stages: Array<{ label: string; value: number | null; source?: string }>; unavailableLabel?: string }) {
  const reduce = useReducedMotion();
  const max = Math.max(1, ...stages.map((s) => s.value ?? 0));
  return (
    <ol className="space-y-3" aria-label="Funnel">
      {stages.map((s, i) => {
        const before = i > 0 ? stages[i - 1] : null;
        const prev = before && before.source === s.source ? before.value : null;
        const rate = s.value !== null && prev && s.value <= prev ? s.value / prev : null;
        return (
          <li key={s.label}>
            <div className="mb-1.5 flex items-baseline justify-between gap-3 text-[13px]">
              <span className="font-medium text-ink-2">{s.label}</span>
              <span className="tabular-nums text-ink">
                {s.value === null ? <span className="text-[12px] text-muted">{unavailableLabel}</span> : formatNumber(s.value)}
                {rate !== null && <span className="ml-2 text-[12px] text-muted">{Math.round(rate * 100)}% of previous</span>}
              </span>
            </div>
            <div className="h-6 rounded-md bg-surface-2">
              {s.value !== null && s.value > 0 && (
                <motion.div
                  className="h-6 rounded-r-[4px] rounded-l-[2px]"
                  style={{ background: RAMP[Math.min(i, RAMP.length - 1)] }}
                  initial={reduce ? false : { width: 0 }}
                  animate={{ width: `${Math.max(2, (s.value / max) * 100)}%` }}
                  transition={{ duration: 0.8, delay: i * 0.08, ease: [0.16, 1, 0.3, 1] }}
                />
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Single-series horizontal bars (categories carry their own label/avatar)
// ---------------------------------------------------------------------------

export function HBarList({
  rows,
  unit,
  emptyLabel = "No activity in this period",
}: {
  rows: Array<{ key: string; label: React.ReactNode; value: number; hint?: string }>;
  unit: string;
  emptyLabel?: string;
}) {
  const reduce = useReducedMotion();
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.some((r) => r.value > 0)) return <p className="py-6 text-center text-[13px] text-muted">{emptyLabel}</p>;
  return (
    <ul className="space-y-3">
      {rows.map((r, i) => (
        <li key={r.key} className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3 text-[13px]">
          <span className="min-w-0 truncate text-ink-2">{r.label}</span>
          <div className="h-4 rounded bg-surface-2" title={`${formatNumber(r.value)} ${unit}`}>
            {r.value > 0 && (
              <motion.div
                className="h-4 rounded-r-[4px]"
                style={{ background: "var(--series-1)" }}
                initial={reduce ? false : { width: 0 }}
                animate={{ width: `${Math.max(2, (r.value / max) * 100)}%` }}
                transition={{ duration: 0.7, delay: i * 0.05, ease: [0.16, 1, 0.3, 1] }}
              />
            )}
          </div>
          <span className="w-12 text-right tabular-nums text-ink">{formatNumber(r.value)}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Columns with hover tooltip (single series)
// ---------------------------------------------------------------------------

export function Columns({ data, height = 180, unit, label }: { data: Array<{ x: string; y: number }>; height?: number; unit: string; label: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = React.useState<number | null>(null);
  const reduce = useReducedMotion();
  const pad = { l: 28, r: 8, t: 10, b: 24 };
  const w = Math.max(0, width - pad.l - pad.r);
  const h = height - pad.t - pad.b;
  const max = niceMax(Math.max(...data.map((d) => d.y), 0));
  const band = data.length ? w / data.length : 0;
  const barW = Math.min(24, band * 0.6);
  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={label}>
          {[0, max / 2, max].map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={pad.l + w} y1={pad.t + h - (t / max) * h} y2={pad.t + h - (t / max) * h} stroke="var(--grid)" />
              <text x={pad.l - 6} y={pad.t + h - (t / max) * h} dy="0.32em" textAnchor="end" className="fill-[var(--faint)] text-[11px] tabular-nums">
                {formatNumber(t, { compact: true })}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const bh = (d.y / max) * h;
            const cx = pad.l + band * i + band / 2;
            return (
              <g key={d.x} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
                <rect x={cx - band / 2} y={pad.t} width={band} height={h} fill="transparent" />
                {d.y > 0 && (
                  <motion.path
                    d={`M${cx - barW / 2},${pad.t + h} V${pad.t + h - bh + 4} Q${cx - barW / 2},${pad.t + h - bh} ${cx - barW / 2 + 4},${pad.t + h - bh} H${cx + barW / 2 - 4} Q${cx + barW / 2},${pad.t + h - bh} ${cx + barW / 2},${pad.t + h - bh + 4} V${pad.t + h} Z`}
                    fill="var(--series-1)"
                    opacity={hover === null || hover === i ? 1 : 0.55}
                    initial={reduce ? false : { opacity: 0 }}
                    animate={{ opacity: hover === null || hover === i ? 1 : 0.55 }}
                  />
                )}
                <text x={cx} y={height - 6} textAnchor="middle" className="fill-[var(--faint)] text-[11px]">
                  {d.x}
                </text>
              </g>
            );
          })}
        </svg>
      )}
      {hover !== null && (
        <div className="pointer-events-none absolute z-10 rounded-xl border border-line bg-surface px-3 py-2 text-[12px] shadow-float" style={{ left: Math.min(Math.max(4, pad.l + band * hover + band / 2 - 50), width - 110), top: 0 }}>
          <p className="text-muted">{data[hover].x}</p>
          <p className="font-semibold text-ink">
            {formatNumber(data[hover].y)} {unit}
          </p>
        </div>
      )}
    </div>
  );
}

/** A 100% bar split into status segments with a 2px surface gap; icon + label carry meaning. */
export function StatusSplit({ segments }: { segments: Array<{ label: string; value: number; color: string; icon: React.ReactNode }> }) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  if (!total) return <p className="py-4 text-center text-[13px] text-muted">No runs in this period</p>;
  return (
    <div>
      <div className="flex h-3 gap-[2px] overflow-hidden rounded-full">
        {segments
          .filter((s) => s.value > 0)
          .map((s) => (
            <div key={s.label} style={{ width: `${(s.value / total) * 100}%`, background: s.color }} title={`${s.label}: ${s.value}`} />
          ))}
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-[12.5px]">
        {segments.map((s) => (
          <li key={s.label} className="flex items-center gap-1.5 text-ink-2">
            {s.icon}
            <span>{s.label}</span>
            <span className="font-semibold tabular-nums text-ink">{formatNumber(s.value)}</span>
            <span className="text-muted">({Math.round((s.value / total) * 100)}%)</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
