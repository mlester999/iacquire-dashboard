"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowUpRight, Ban, CalendarDays, Check, Clock, Contact, Funnel, Globe, LifeBuoy, Mail, Sparkles, TriangleAlert, UserRound, Zap, type LucideIcon } from "lucide-react";
import { Tooltip } from "@/components/ui/overlays";
import { SETUP_SERVICES } from "@/lib/setup";
import type { ClientSetupRow } from "@/server/setup/snapshots";
import { cn, formatDate } from "@/lib/utils";
import { HEALTH, plural, STATE, stateOf, type Tone } from "@/components/admin/client-state";
import { AvatarTile, RelativeTime, StatusPill, toneDotClass } from "@/components/ui/status";

export { AvatarTile, StatusPill };

// ---------------------------------------------------------------------------
// Shared building blocks (also used by the table view)
// ---------------------------------------------------------------------------

/** Circular setup progress. Animates from empty on first paint (instant with reduced motion). */
export function ProgressRing({ percent, tone = "primary", size = 64, label }: { percent: number | null; tone?: "primary" | "success" | "warning"; size?: number; label: string }) {
  const id = React.useId();
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => {
    const frame = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  const stroke = 6;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const value = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  const offset = circumference * (1 - (ready ? value : 0) / 100);
  const stops = { primary: ["var(--primary)", "var(--violet)"], success: ["var(--success)", "var(--success)"], warning: ["var(--warning)", "var(--warning)"] }[tone];
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} role="img" aria-label={percent === null ? `${label}: no progress yet` : `${label}: ${value}% complete`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={stops[0]} />
            <stop offset="100%" stopColor={stops[1]} />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--surface-3)" strokeWidth={stroke} strokeDasharray={percent === null ? "2 6" : undefined} strokeLinecap="round" />
        {percent !== null && value > 0 && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={`url(#${id})`}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            className="transition-[stroke-dashoffset] duration-1000 ease-out motion-reduce:transition-none"
          />
        )}
      </svg>
      <span className="absolute inset-0 grid place-items-center text-[14px] font-semibold tabular-nums tracking-tight text-ink">{percent === null ? "—" : `${value}%`}</span>
    </div>
  );
}

function connectionTone(status: string | null): Tone {
  if (status === "connected") return "success";
  if (status === "pending") return "warning";
  if (["error", "disconnected", "needs_attention", "failed"].includes(status ?? "")) return "danger";
  return "neutral";
}

const STATUS_WORDS: Record<string, string> = { connected: "connected", pending: "pending verification", error: "error", disconnected: "disconnected", needs_attention: "needs attention", failed: "failed", not_configured: "not connected" };

/** One chip per system, coloured by its recorded state. Detail is available on hover. */
export function ConnectionChips({ r, compact = false }: { r: ClientSetupRow; compact?: boolean }) {
  const h = r.health;
  const aiTone: Tone = h.failingAgents > 0 ? "danger" : h.agentsEnabled > 0 && h.agentsOnline === h.agentsEnabled ? "success" : h.agentsOnline > 0 ? "warning" : "neutral";
  const chips: Array<{ key: string; label: string; tone: Tone; detail: string }> = [
    { key: "crm", label: "CRM", tone: connectionTone(h.ghl), detail: `CRM: ${h.ghl ? STATUS_WORDS[h.ghl] ?? h.ghl : "not mapped"}` },
    { key: "ai", label: `AI ${h.agentsOnline}/${h.agentsEnabled}`, tone: aiTone, detail: `AI employees online: ${h.agentsOnline} of ${h.agentsEnabled}${h.failingAgents ? ` · ${plural(h.failingAgents, "employee")} failing` : ""}` },
    { key: "calendar", label: "Calendar", tone: connectionTone(h.calendar), detail: `Calendar: ${h.calendar && h.calendar !== "not_configured" ? STATUS_WORDS[h.calendar] ?? h.calendar : "not connected"}` },
    { key: "n8n", label: "n8n", tone: connectionTone(h.n8n), detail: `n8n: ${h.n8n ? STATUS_WORDS[h.n8n] ?? h.n8n : "not configured"}` },
  ];
  return (
    <div className={compact ? "grid grid-cols-2 gap-x-3 gap-y-1" : "flex flex-wrap gap-1.5"}>
      {chips.map((c) => (
        <Tooltip key={c.key} content={c.detail}>
          <span className={cn("inline-flex items-center gap-1.5 text-[11.5px] font-medium text-ink-2", !compact && "h-6 rounded-full bg-surface px-2.5 ring-1 ring-inset ring-line-strong")}>
            <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", c.tone === "neutral" ? "bg-transparent ring-1 ring-inset ring-faint" : toneDotClass(c.tone))} />
            {c.label}
          </span>
        </Tooltip>
      ))}
    </div>
  );
}

const SERVICE_ICONS: Record<string, LucideIcon> = { crm: Contact, ai_workforce: Sparkles, automations: Zap, website: Globe, funnel: Funnel, email: Mail, calendar: CalendarDays };

export function ServiceChips({ services, max = 3 }: { services: ClientSetupRow["services"]; max?: number }) {
  const label = (key: string) => SETUP_SERVICES.find((s) => s.key === key)?.label ?? key;
  const shown = services.slice(0, max);
  const rest = services.slice(max);
  return (
    <div className="flex flex-wrap gap-1.5">
      {shown.map((key) => {
        const Icon = SERVICE_ICONS[key] ?? Sparkles;
        return (
          <span key={key} className="inline-flex h-6 items-center gap-1.5 rounded-lg bg-surface-2/80 px-2 text-[11.5px] font-medium text-ink-2">
            <Icon className="size-3 text-muted" aria-hidden />
            {label(key)}
          </span>
        );
      })}
      {rest.length > 0 && (
        <Tooltip content={rest.map(label).join(" · ")}>
          <span className="inline-flex h-6 items-center rounded-lg bg-surface-2/80 px-2 text-[11.5px] font-medium text-muted">+{rest.length} more</span>
        </Tooltip>
      )}
    </div>
  );
}

/** The state of the owner invitation, shown wherever there is no active owner yet. */
export function PendingOwner() {
  return (
    <StatusPill tone="warning" icon={<Mail className="size-3" aria-hidden />}>
      Owner invitation pending
    </StatusPill>
  );
}

// ---------------------------------------------------------------------------
// The client card
// ---------------------------------------------------------------------------

const ACCENT: Record<Tone, string> = {
  neutral: "from-line-strong to-transparent",
  primary: "from-primary to-violet",
  warning: "from-warning to-warning/10",
  success: "from-success to-success/10",
  danger: "from-danger to-danger/10",
  violet: "from-violet to-primary",
};
const WASH: Record<Tone, string> = {
  neutral: "from-surface-2/80",
  primary: "from-primary-soft/80",
  warning: "from-warning-soft/80",
  success: "from-success-soft/70",
  danger: "from-danger-soft/70",
  violet: "from-violet-soft/80",
};

export function ClientCard({ r, timeZone, index }: { r: ClientSetupRow; timeZone: string; index: number }) {
  const state = STATE[stateOf(r)];
  const health = HEALTH[r.health.level];
  const done = r.setup.state === "activated";
  const ringTone = done || r.setup.percent === 100 ? "success" : r.setup.blocked > 0 ? "warning" : "primary";
  return (
    <li className="page-in min-w-0" style={{ animationDelay: `${Math.min(index, 9) * 45}ms` }}>
      <Link
        href={`/admin/clients/${r.id}`}
        className="group relative flex h-full flex-col overflow-hidden rounded-[22px] border border-line bg-surface shadow-card transition duration-300 ease-out hover:-translate-y-1 hover:border-line-strong hover:shadow-float focus-visible:-translate-y-1 active:scale-[0.995] motion-reduce:transition-none motion-reduce:hover:translate-y-0"
      >
        <span aria-hidden className={cn("pointer-events-none absolute inset-x-0 top-0 z-10 h-[3px] bg-gradient-to-r", ACCENT[state.tone])} />
        <span aria-hidden className={cn("pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b to-transparent", WASH[state.tone])} />
        <span aria-hidden className="pointer-events-none absolute -right-20 -top-20 size-60 rounded-full bg-[radial-gradient(closest-side,var(--primary-soft),transparent)] opacity-0 transition-opacity duration-500 group-hover:opacity-100" />

        <div className="relative flex h-full flex-col gap-5 p-5 sm:p-6">
          <div className="flex items-start justify-between gap-3">
            <AvatarTile name={r.name} size="lg" />
            <StatusPill tone={state.tone}>{state.label}</StatusPill>
          </div>

          <div className="min-w-0">
            <h3 className="truncate text-[18px] font-semibold leading-snug tracking-[-0.025em] text-ink">{r.name}</h3>
            <p className="mt-0.5 text-[12.5px] text-muted">{r.onboardingCompletedAt ? `Onboarded ${formatDate(r.onboardingCompletedAt, timeZone)}` : "Onboarding not submitted"}</p>
            <div className="mt-3 min-h-6">
              {r.contact ? (
                <div className="flex min-w-0 items-center gap-2">
                  <AvatarTile name={r.contact.name} size="sm" className="!shadow-none" />
                  <span className="min-w-0 truncate text-[13px] text-ink-2">
                    <span className="font-medium">{r.contact.name}</span>
                    {r.contact.name !== r.contact.email && <span className="text-muted"> · {r.contact.email}</span>}
                  </span>
                </div>
              ) : (
                <PendingOwner />
              )}
            </div>
          </div>

          <div className="flex items-center gap-4 rounded-2xl bg-surface-2/70 p-3.5 ring-1 ring-inset ring-line">
            <ProgressRing percent={r.setup.started ? r.setup.percent : null} tone={ringTone} label={`${r.name} setup progress`} />
            <div className="min-w-0 flex-1">
              <p className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted">Setup journey</p>
              {!r.setup.started ? (
                <p className="mt-1 text-[14px] font-medium text-ink-2">Checklist not started</p>
              ) : r.setup.percent === null ? (
                <p className="mt-1 text-[14px] font-medium text-ink-2">No required steps</p>
              ) : (
                <>
                  <p className="mt-1 text-[15px] font-semibold tabular-nums tracking-tight text-ink">
                    {r.setup.completed} <span className="font-normal text-muted">of {r.setup.total} steps</span>
                  </p>
                  <p className="mt-0.5 flex items-center gap-1 text-[12px] text-muted">
                    {r.setup.outstanding === 0 ? (
                      <>
                        <Check className="size-3.5 text-success" aria-hidden /> Nothing remaining
                      </>
                    ) : (
                      `${plural(r.setup.outstanding, "step")} remaining`
                    )}
                  </p>
                </>
              )}
            </div>
          </div>

          {(r.setup.clientActions > 0 || r.setup.blocked > 0 || r.openTickets > 0) && (
            <div className="flex flex-wrap gap-1.5">
              {r.setup.clientActions > 0 && (
                <StatusPill tone="warning" icon={<Clock className="size-3" aria-hidden />}>
                  {r.setup.clientActions} waiting on client
                </StatusPill>
              )}
              {r.setup.blocked > 0 && (
                <Tooltip content={r.setup.blockers.join(" · ")}>
                  <span>
                    <StatusPill tone="danger" icon={<Ban className="size-3" aria-hidden />}>
                      {r.setup.blocked} blocked
                    </StatusPill>
                  </span>
                </Tooltip>
              )}
              {r.openTickets > 0 && (
                <StatusPill tone="primary" icon={<LifeBuoy className="size-3" aria-hidden />}>
                  {plural(r.openTickets, "support issue")}
                </StatusPill>
              )}
            </div>
          )}

          <div className="space-y-2.5">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted">Connections</p>
              <StatusPill tone={health.tone} icon={r.health.level === "issue" ? <TriangleAlert className="size-3" aria-hidden /> : undefined}>
                {health.label}
              </StatusPill>
            </div>
            <ConnectionChips r={r} />
          </div>

          {r.services.length > 0 && <ServiceChips services={r.services} />}

          <div className="mt-auto flex items-center gap-3 border-t border-line pt-4">
            {r.responsible ? <AvatarTile name={r.responsible.name} size="sm" /> : <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-lg border border-dashed border-line-strong text-faint"><UserRound className="size-3.5" /></span>}
            <div className="min-w-0 flex-1 leading-tight">
              <p className="truncate text-[13px] font-medium text-ink-2">{r.responsible ? r.responsible.name : "Unassigned"}</p>
              <p className="truncate text-[11.5px] text-muted">{r.lastActivityAt ? <RelativeTime value={r.lastActivityAt} prefix="Active " /> : "No activity yet"}</p>
            </div>
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-surface-2 text-ink-2 ring-1 ring-inset ring-line transition duration-300 group-hover:bg-primary group-hover:text-white group-hover:ring-primary" aria-hidden>
              <ArrowUpRight className="size-4 transition-transform duration-300 group-hover:translate-x-px group-hover:-translate-y-px" />
            </span>
            <span className="sr-only">Open client workspace</span>
          </div>
        </div>
      </Link>
    </li>
  );
}
