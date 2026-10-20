import * as React from "react";
import { AlertCircle, ArrowRight, Check, Circle, CircleDot, ShieldCheck, Sparkles } from "lucide-react";
import { AgentAvatar } from "@/components/brand";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, ProgressBar } from "@/components/ui/primitives";
import { StatusPill, toneDotClass } from "@/components/ui/status";
import type { AgentRoleMeta } from "@/lib/agents";
import type { EmployeeReadiness, ReadinessStep } from "@/lib/workforce-readiness";
import { cn } from "@/lib/utils";

const TONE_TO_STATUS = {
  neutral: "neutral",
  warning: "warning",
  danger: "danger",
  success: "success",
  primary: "primary",
  violet: "violet",
} as const;

function ReadinessPill({ readiness, dark = false }: { readiness: EmployeeReadiness; dark?: boolean }) {
  if (!dark) {
    return (
      <StatusPill tone={TONE_TO_STATUS[readiness.tone]} size="md">
        {readiness.label}
      </StatusPill>
    );
  }
  return (
    <span className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-white/10 px-2.5 text-[12px] font-medium text-white ring-1 ring-inset ring-white/15">
      <span aria-hidden className={cn("size-1.5 rounded-full", toneDotClass(TONE_TO_STATUS[readiness.tone]))} />
      {readiness.label}
    </span>
  );
}

export function ReadinessInline({ readiness, detail = false }: { readiness: EmployeeReadiness; detail?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill tone={TONE_TO_STATUS[readiness.tone]} size="sm">{readiness.label}</StatusPill>
        <span className="text-[11.5px] tabular-nums text-muted">{readiness.completed}/{readiness.total} requirements</span>
      </div>
      {detail && <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted">{readiness.title}. {readiness.description}</p>}
    </div>
  );
}

function StepGlyph({ step, dark = false }: { step: ReadinessStep; dark?: boolean }) {
  const base = "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full ring-1 ring-inset";
  if (step.state === "done") {
    return <span className={cn(base, dark ? "bg-white/10 text-emerald-300 ring-white/15" : "bg-success-soft text-success-ink ring-success/25")}><Check className="size-3.5" aria-hidden /></span>;
  }
  if (step.state === "blocked") {
    return <span className={cn(base, dark ? "bg-white/10 text-amber-300 ring-white/15" : "bg-warning-soft text-warning-ink ring-warning/25")}><AlertCircle className="size-3.5" aria-hidden /></span>;
  }
  if (step.state === "current") {
    return <span className={cn(base, dark ? "bg-white/15 text-white ring-white/20" : "bg-primary-soft text-primary-ink ring-primary/25")}><CircleDot className="size-3.5" aria-hidden /></span>;
  }
  return <span className={cn(base, dark ? "text-white/35 ring-white/10" : "text-faint ring-line")}><Circle className="size-3.5" aria-hidden /></span>;
}

export function ReadinessMini({ readiness, dark = false }: { readiness: EmployeeReadiness; dark?: boolean }) {
  return (
    <div className={cn("rounded-2xl border p-4", dark ? "border-white/10 bg-white/[.045]" : "border-line bg-surface-2/70")}>
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className={cn("text-[10px] font-semibold uppercase tracking-[.16em]", dark ? "text-white/60" : "text-muted")}>Activation readiness</p>
          <p className={cn("mt-1 text-[13px] font-semibold", dark ? "text-white" : "text-ink")}>
            {readiness.completed} of {readiness.total} requirements
          </p>
        </div>
        <span className={cn("text-[11px] font-medium tabular-nums", dark ? "text-white/55" : "text-muted")}>{Math.round((readiness.completed / readiness.total) * 100)}%</span>
      </div>
      <ProgressBar value={(readiness.completed / readiness.total) * 100} tone={readiness.tone === "danger" ? "danger" : readiness.tone === "success" ? "success" : readiness.tone === "warning" ? "warning" : "primary"} className="mt-3" label="Activation readiness" />
      <ol className="mt-3 space-y-2">
        {readiness.steps.slice(0, 4).map((step) => (
          <li key={step.key} className="flex items-start gap-2">
            <StepGlyph step={step} dark={dark} />
            <span className={cn("pt-0.5 text-[12px] leading-snug", step.state === "done" ? (dark ? "text-white/70" : "text-muted") : step.state === "current" ? (dark ? "text-white" : "text-ink") : dark ? "text-white/65" : "text-muted")}>
              {step.label}
            </span>
          </li>
        ))}
      </ol>
      <a href="#employee-readiness" className={cn("mt-3 inline-flex items-center gap-1 text-[12px] font-medium", dark ? "text-blue-200 hover:text-white" : "text-primary hover:underline")}>
        View setup requirements <ArrowRight className="size-3" aria-hidden />
      </a>
    </div>
  );
}

export function EmployeeProfileHero({
  meta,
  displayName,
  description,
  readiness,
  eyebrow = "AI employee",
  actions,
  footer,
  dark = false,
  target,
}: {
  meta: AgentRoleMeta;
  displayName: string;
  description: React.ReactNode;
  readiness: EmployeeReadiness;
  eyebrow?: string;
  actions?: React.ReactNode;
  footer?: React.ReactNode;
  dark?: boolean;
  target?: string;
}) {
  return (
    <section
      data-aqi-target={target}
      className={cn(
        "relative isolate overflow-hidden rounded-[28px] border",
        dark ? "border-white/10 bg-[#11192c] text-white" : "border-line bg-surface shadow-card",
      )}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -right-24 -top-32 size-[420px] rounded-full blur-3xl"
        style={{ background: `${meta.accent}${dark ? "2e" : "24"}` }}
      />
      {!dark && (
        <div aria-hidden className="pointer-events-none absolute inset-0 opacity-[.55]" style={{ background: "linear-gradient(120deg, transparent 20%, var(--primary-soft) 130%)" }} />
      )}
      <div className="relative grid gap-6 p-5 sm:p-7 lg:grid-cols-[minmax(0,1fr)_330px] lg:items-start">
        <div className="min-w-0">
          <p className={cn("flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[.17em]", dark ? "text-blue-200" : "text-primary-ink")}>
            <Sparkles className="size-3.5" aria-hidden /> {eyebrow}
          </p>
          <div className="mt-4 flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start">
            <div className="relative shrink-0 self-start">
              <div aria-hidden className="absolute inset-0 rounded-[26px] blur-xl" style={{ background: `${meta.accent}30` }} />
              <div className={cn("relative rounded-[26px] border p-2", dark ? "border-white/10 bg-white/[.06]" : "border-line bg-surface-2 shadow-soft")}>
                <AgentAvatar role={meta} size="xl" />
              </div>
            </div>
            <div className="min-w-0 flex-1">
              <h1 className={cn("text-balance text-[25px] font-semibold leading-[1.12] tracking-[-.045em] sm:text-[31px]", dark ? "text-white" : "text-ink")}>{displayName}</h1>
              <p className={cn("mt-1 text-[13px] font-medium", dark ? "text-blue-200" : "text-primary-ink")}>{meta.tagline}</p>
              <div className={cn("mt-2 max-w-2xl text-[13.5px] leading-[1.7]", dark ? "text-slate-300" : "text-muted")}>{description}</div>
              <div className="mt-4 flex flex-wrap items-center gap-2.5">
                <ReadinessPill readiness={readiness} dark={dark} />
                <span className={cn("text-[12.5px] leading-snug", dark ? "text-slate-300" : "text-muted")}>{readiness.title}</span>
              </div>
              <p className={cn("mt-2 max-w-2xl text-[12.5px] leading-[1.65]", dark ? "text-slate-400" : "text-muted")}>{readiness.description}</p>
            </div>
          </div>
          {actions && <div className="mt-5 flex flex-wrap items-center gap-2">{actions}</div>}
          {footer && <div className={cn("mt-5 border-t pt-4", dark ? "border-white/10" : "border-line")}>{footer}</div>}
        </div>
        <ReadinessMini readiness={readiness} dark={dark} />
      </div>
    </section>
  );
}

export function ReadinessChecklist({
  readiness,
  title = "Activation readiness",
  description = "Every item comes from the saved employee record. Nothing is marked complete until the backend confirms it.",
  action,
  className,
}: {
  readiness: EmployeeReadiness;
  title?: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <Card id="employee-readiness" className={cn("scroll-mt-24 overflow-hidden", className)}>
      <CardHeader className="flex-col gap-3 sm:flex-row sm:items-start">
        <div>
          <CardTitle className="flex items-center gap-2"><ShieldCheck className="size-4 text-primary" aria-hidden /> {title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
        {action}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-2xl border border-line bg-surface-2/60 p-3.5">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[12.5px] font-medium text-ink">{readiness.completed} of {readiness.total} complete</p>
            <span className="text-[11px] tabular-nums text-muted">{Math.round((readiness.completed / readiness.total) * 100)}%</span>
          </div>
          <ProgressBar value={(readiness.completed / readiness.total) * 100} tone={readiness.tone === "danger" ? "danger" : readiness.tone === "success" ? "success" : readiness.tone === "warning" ? "warning" : "primary"} className="mt-2.5" label="Activation readiness" />
        </div>
        <ol className="space-y-1.5" aria-label="Activation requirements">
          {readiness.steps.map((step) => (
            <li
              key={step.key}
              aria-current={step.state === "current" ? "step" : undefined}
              className={cn(
                "flex items-start gap-3 rounded-xl border border-transparent px-3 py-2.5 transition-colors",
                step.state === "current" && "border-primary/15 bg-primary-soft/35",
              )}
            >
              <StepGlyph step={step} />
              <div className="min-w-0">
                <p className={cn("text-[13px] font-medium", step.state === "upcoming" ? "text-muted" : "text-ink")}>{step.label}</p>
                <p className="mt-0.5 text-[12px] leading-relaxed text-muted">{step.description}</p>
              </div>
            </li>
          ))}
        </ol>
        {!readiness.completed && action ? <div className="pt-1">{action}</div> : null}
      </CardContent>
    </Card>
  );
}

export function EmployeeHeroActionLink({ href, children, secondary = false }: { href: string; children: React.ReactNode; secondary?: boolean }) {
  return (
    <ButtonLink href={href} variant={secondary ? "secondary" : "brand"} size="md">
      {children}
    </ButtonLink>
  );
}
