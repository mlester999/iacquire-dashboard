import * as React from "react";
import { CardDescription, CardHeader, CardTitle } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { AvatarTile, type StatusTone } from "@/components/ui/status";

/**
 * Small structural pieces shared by the admin client workspaces (detail tabs, setup manager, readiness, provisioning,
 * offboarding and website). They sit on top of ui/status (StatusPill, InfoChip, AvatarTile) and only add layout:
 * an icon tile, a stat tile, a tinted callout and a framed key/value list.
 */

const TILE: Record<StatusTone, string> = {
  neutral: "bg-surface-2 text-ink-2 ring-line-strong",
  primary: "bg-primary-soft text-primary-ink ring-primary/15",
  success: "bg-success-soft text-success-ink ring-success/20",
  warning: "bg-warning-soft text-warning-ink ring-warning/25",
  danger: "bg-danger-soft text-danger-ink ring-danger/20",
  violet: "bg-violet-soft text-violet-ink ring-violet/20",
};

const CALLOUT: Record<StatusTone, { box: string; ink: string }> = {
  neutral: { box: "bg-surface-2/70 ring-line", ink: "text-ink" },
  primary: { box: "bg-primary-soft/60 ring-primary/15", ink: "text-primary-ink" },
  success: { box: "bg-success-soft/70 ring-success/20", ink: "text-success-ink" },
  warning: { box: "bg-warning-soft/70 ring-warning/25", ink: "text-warning-ink" },
  danger: { box: "bg-danger-soft/70 ring-danger/20", ink: "text-danger-ink" },
  violet: { box: "bg-violet-soft/70 ring-violet/20", ink: "text-violet-ink" },
};

const TILE_SIZE = {
  xs: "size-7 rounded-lg [&>svg]:size-3.5",
  sm: "size-8 rounded-lg [&>svg]:size-4",
  md: "size-10 rounded-xl [&>svg]:size-[18px]",
  lg: "size-12 rounded-2xl [&>svg]:size-5",
};

/** A tinted square that holds an icon: the identity cell for rows, cards and sections that have no person or company. */
export function IconTile({ icon, tone = "primary", size = "md", className }: { icon: React.ReactNode; tone?: StatusTone; size?: keyof typeof TILE_SIZE; className?: string }) {
  return (
    <span aria-hidden className={cn("grid shrink-0 place-items-center ring-1 ring-inset", TILE[tone], TILE_SIZE[size], className)}>
      {icon}
    </span>
  );
}

/** A compact number with an icon tile, for hero summaries and card headers. */
export function StatTile({ icon, label, value, detail, tone = "primary", className }: { icon: React.ReactNode; label: React.ReactNode; value: React.ReactNode; detail?: React.ReactNode; tone?: StatusTone; className?: string }) {
  return (
    <div className={cn("flex min-w-0 items-center gap-3 rounded-xl bg-surface/80 p-3 ring-1 ring-inset ring-line", className)}>
      <IconTile icon={icon} tone={tone} size="sm" />
      <div className="min-w-0">
        <p className="text-[12px] font-medium leading-snug text-muted">{label}</p>
        <p className="text-[19px] font-semibold leading-tight tracking-[-0.02em] tabular-nums text-ink">{value}</p>
        {detail && <div className="mt-0.5 text-[12px] text-muted">{detail}</div>}
      </div>
    </div>
  );
}

/** A tinted explanation with an icon. Replaces loose coloured sentences. */
export function Callout({ tone = "neutral", icon, title, children, className }: { tone?: StatusTone; icon?: React.ReactNode; title?: React.ReactNode; children?: React.ReactNode; className?: string }) {
  const c = CALLOUT[tone];
  return (
    <div className={cn("flex items-start gap-2.5 rounded-xl px-3.5 py-3 text-[14px] leading-relaxed ring-1 ring-inset", c.box, className)}>
      {icon && (
        <span aria-hidden className={cn("mt-0.5 shrink-0 [&>svg]:size-4", c.ink)}>
          {icon}
        </span>
      )}
      <div className="min-w-0 flex-1 break-words">
        {title && <p className={cn("font-semibold", c.ink)}>{title}</p>}
        {children && <div className={cn("text-ink-2", title && "mt-0.5")}>{children}</div>}
      </div>
    </div>
  );
}

/** A framed list of label/value rows with hairline dividers. */
export function DetailList({ children, className }: { children: React.ReactNode; className?: string }) {
  return <dl className={cn("divide-y divide-line overflow-hidden rounded-xl bg-surface-2/50 ring-1 ring-inset ring-line", className)}>{children}</dl>;
}

export function DetailRow({ label, children, mono, className }: { label: React.ReactNode; children: React.ReactNode; mono?: boolean; className?: string }) {
  return (
    <div className={cn("flex items-center justify-between gap-3 px-3 py-2 text-[13px]", className)}>
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className={cn("flex min-w-0 items-center justify-end gap-1.5 text-right text-ink", mono && "font-mono text-[12px]")}>{children}</dd>
    </div>
  );
}

/** Role pills: owners lead in the accent colour, admins and managers in violet, everyone else neutral. */
export function roleTone(role: string | null | undefined): StatusTone {
  const r = (role ?? "").toLowerCase();
  if (r === "owner") return "primary";
  if (r === "admin" || r === "manager" || r.includes("super")) return "violet";
  return "neutral";
}

/** The identity card that sits in a hero's aside: the company monogram, a small caption and the state pills that matter on this page. */
export function HeroIdentity({ name, label, children, className }: { name: string; label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center gap-3.5 rounded-2xl bg-surface/80 p-3.5 shadow-card ring-1 ring-inset ring-line sm:gap-4 sm:p-4", className)}>
      <AvatarTile name={name} size="lg" />
      <div className="flex min-w-0 flex-col items-start gap-1.5">
        <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-muted">{label}</span>
        <div className="flex flex-wrap items-center gap-1.5">{children}</div>
      </div>
    </div>
  );
}

/**
 * The standard card header: an icon tile, a title with its description and an optional status on the right. The status drops
 * under the title on narrow screens instead of squeezing the description into a thin column.
 */
export function SectionHead({ icon, tone = "primary", title, description, aside, className }: { icon: React.ReactNode; tone?: StatusTone; title: React.ReactNode; description?: React.ReactNode; aside?: React.ReactNode; className?: string }) {
  return (
    <CardHeader className={cn("flex-wrap", className)}>
      <div className="flex min-w-0 flex-1 basis-56 items-start gap-3">
        <IconTile icon={icon} tone={tone} />
        <div className="min-w-0">
          <CardTitle>{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
      </div>
      {aside ? <div className="max-sm:ml-[52px]">{aside}</div> : null}
    </CardHeader>
  );
}
