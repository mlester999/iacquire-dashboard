"use client";

import * as React from "react";
import { MessageSquareText } from "lucide-react";
import { AgentAvatar } from "@/components/brand";
import { AGENT_BY_KEY } from "@/lib/agents";
import { REPORT_SERIES, REPORT_SOURCES, REPORT_WEEKS } from "@/lib/demo/showroom/content";
import { useShowroom } from "@/components/demo/showroom/context";
import { ContextCta } from "@/components/demo/showroom/cta";
import { SectionHead, SimTag } from "@/components/demo/showroom/ui";

// Reports & insights: what the Performance Analyst reads and writes about. The figures are invented and rounded so the charts have a shape; the page says so, defines every measure, and
// states no benchmark, no percentage gain and no result. Each chart has a text table for screen readers.

const W = 640;
const H = 280;
const PAD = { l: 40, r: 64, t: 16, b: 32 };
const MAX = 30;
const SERIES = [
  { key: "enquiries", label: "Enquiries", color: "var(--primary)", ink: "var(--primary-ink)", data: REPORT_SERIES.enquiries },
  { key: "booked", label: "Appointments booked", color: "var(--violet)", ink: "var(--violet-ink)", data: REPORT_SERIES.booked },
  { key: "won", label: "Deals won", color: "var(--success)", ink: "var(--success-ink)", data: REPORT_SERIES.won },
] as const;

const x = (i: number) => PAD.l + (i * (W - PAD.l - PAD.r)) / (REPORT_WEEKS.length - 1);
const y = (v: number) => PAD.t + (1 - v / MAX) * (H - PAD.t - PAD.b);

export function ReportsView() {
  const { ask, aiEnabled, ended } = useShowroom();
  const last = REPORT_WEEKS.length - 1;
  return (
    <div className="space-y-8">
      <SectionHead as="h1" eyebrow="Reports & insights" title="See what is working, in plain words." lead="The Performance Analyst reads your CRM every week, says what stood out and shows where each figure comes from. Nothing is hidden behind a score." />

      <section aria-labelledby="trend-heading" className="sx-panel space-y-5 p-5 @xl:p-7">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="trend-heading" className="text-[18px] font-semibold tracking-[-0.01em] text-ink">Weekly activity</h2>
            <p className="text-[13px] text-muted">Six sample weeks</p>
          </div>
          <SimTag>Invented sample figures</SimTag>
        </header>

        <div className="grid gap-3 @xl:grid-cols-3">
          {SERIES.map((s) => (
            <div key={s.key} className="sx-panel-flat px-4 py-3">
              <p className="flex items-center gap-2 text-[12px] font-medium text-muted">
                <span className="size-2.5 rounded-full" style={{ background: s.color }} aria-hidden />
                {s.label}
              </p>
              <p className="mt-0.5 text-[26px] font-semibold tabular-nums tracking-[-0.02em] text-ink">
                {s.data[last]}
                <span className="ml-1.5 text-[13px] font-medium text-muted">in {REPORT_WEEKS[last]}</span>
              </p>
            </div>
          ))}
        </div>

        <figure className="m-0">
          <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-labelledby="trend-title trend-desc">
            <title id="trend-title">Enquiries, appointments booked and deals won over six sample weeks</title>
            <desc id="trend-desc">All three measures rise over the six weeks. The last week shows {REPORT_SERIES.enquiries[last]} enquiries, {REPORT_SERIES.booked[last]} appointments booked and {REPORT_SERIES.won[last]} deals won. These are invented figures.</desc>
            <defs>
              <linearGradient id="area-enq" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" style={{ stopColor: "var(--primary)" }} stopOpacity="0.28" />
                <stop offset="1" style={{ stopColor: "var(--primary)" }} stopOpacity="0" />
              </linearGradient>
            </defs>
            {[0, 10, 20, 30].map((t) => (
              <g key={t}>
                <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} style={{ stroke: "var(--line)" }} strokeWidth="1" />
                <text x={PAD.l - 10} y={y(t) + 4} textAnchor="end" fontSize="11" fill="currentColor" className="text-muted">{t}</text>
              </g>
            ))}
            {REPORT_WEEKS.map((w, i) => (
              <text key={w} x={x(i)} y={H - 10} textAnchor="middle" fontSize="11" fill="currentColor" className="text-muted">{w}</text>
            ))}
            <path d={`M ${x(0)} ${y(0)} ${SERIES[0].data.map((v, i) => `L ${x(i)} ${y(v)}`).join(" ")} L ${x(last)} ${y(0)} Z`} fill="url(#area-enq)" />
            {SERIES.map((s) => (
              <g key={s.key}>
                <polyline points={s.data.map((v, i) => `${x(i)},${y(v)}`).join(" ")} fill="none" stroke={s.color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
                {s.data.map((v, i) => (
                  <circle key={i} cx={x(i)} cy={y(v)} r={i === last ? 4.5 : 3} style={{ fill: "var(--surface)", stroke: s.color }} strokeWidth="2">
                    <title>{`${s.label}, ${REPORT_WEEKS[i]}: ${v}`}</title>
                  </circle>
                ))}
                <text x={x(last) + 10} y={y(s.data[last]) + 4} fontSize="12" fontWeight="600" fill={s.ink}>{s.data[last]}</text>
              </g>
            ))}
          </svg>
          <figcaption className="sr-only">Data table below.</figcaption>
        </figure>
        <div className="sr-only">
        <table>
          <caption>Sample weekly figures</caption>
          <thead>
            <tr>
              <th scope="col">Week</th>
              {SERIES.map((s) => <th key={s.key} scope="col">{s.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {REPORT_WEEKS.map((w, i) => (
              <tr key={w}>
                <th scope="row">{w}</th>
                {SERIES.map((s) => <td key={s.key}>{s.data[i]}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </section>

      <div className="grid gap-6 @4xl:grid-cols-2">
        <section aria-labelledby="source-heading" className="sx-panel space-y-4 p-5 @xl:p-7">
          <div className="flex items-center justify-between gap-3">
            <h2 id="source-heading" className="text-[18px] font-semibold tracking-[-0.01em] text-ink">Where enquiries come from</h2>
            <SimTag>Sample</SimTag>
          </div>
          <ul className="space-y-3.5">
            {REPORT_SOURCES.map((s) => (
              <li key={s.label}>
                <div className="flex items-baseline justify-between text-[14px]">
                  <span className="font-medium text-ink">{s.label}</span>
                  <span className="tabular-nums text-ink-2">{s.share}%</span>
                </div>
                <div className="sx-track mt-1.5" role="img" aria-label={`${s.label}: ${s.share} percent of sample enquiries`}>
                  <span style={{ width: `${s.share}%` }} />
                </div>
              </li>
            ))}
          </ul>
          <p className="text-[13px] leading-relaxed text-muted">Share of the sample enquiries by the channel they arrived through. In your portal this uses the source recorded on each lead.</p>
        </section>

        <section aria-labelledby="note-heading" className="sx-panel space-y-4 p-5 @xl:p-7">
          <div className="flex items-center gap-3">
            <AgentAvatar role={AGENT_BY_KEY.performance_analyst} size="md" eager />
            <div>
              <h2 id="note-heading" className="text-[18px] font-semibold tracking-[-0.01em] text-ink">This week&rsquo;s note</h2>
              <p className="text-[13px] text-muted">Written by the Performance Analyst</p>
            </div>
          </div>
          <div className="space-y-3 text-[14px] leading-relaxed text-ink-2">
            <p>Enquiries and booked appointments both trended up over the six weeks. Phone is the largest source, and replies sent after hours took the longest.</p>
            <p>Worth a look: the enquiries that arrived by message waited longest for a first answer.</p>
          </div>
          <dl className="space-y-1.5 rounded-xl border border-line bg-surface-2/60 p-4 text-[13px] leading-relaxed">
            <div className="flex gap-2">
              <dt className="font-semibold text-ink">Source:</dt>
              <dd className="text-ink-2">the CRM&rsquo;s own records for the period</dd>
            </div>
            <div className="flex gap-2">
              <dt className="font-semibold text-ink">Booked means:</dt>
              <dd className="text-ink-2">an appointment was created for the lead</dd>
            </div>
            <div className="flex gap-2">
              <dt className="font-semibold text-ink">Compared with:</dt>
              <dd className="text-ink-2">your earlier weeks only, never an outside benchmark</dd>
            </div>
          </dl>
          {aiEnabled && !ended && (
            <button type="button" onClick={() => ask("How does the Performance Analyst decide what to put in the weekly note?")} className="inline-flex min-h-10 items-center gap-2 text-[14px] font-semibold text-primary-ink hover:text-ink">
              <MessageSquareText className="size-4" aria-hidden />
              Ask how the weekly note works
            </button>
          )}
        </section>
      </div>

      <ContextCta
        plan="core"
        title="See how your own pipeline performs."
        body="Reports and the Performance Analyst are part of your core implementation. They read your own CRM, so the numbers describe your business, with the source and definition beside each one."
        consultLabel="Book a free consultation"
        secondary={{ view: "pricing", label: "See what it costs" }}
      />
    </div>
  );
}
