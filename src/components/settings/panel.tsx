import * as React from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/primitives";
import { InfoChip, StatusPill, type StatusTone } from "@/components/ui/status";
import { cn } from "@/lib/utils";

/**
 * Shared building blocks for the client portal's account areas (settings, billing, support, knowledge, notifications).
 * Everything here is token-only so light and dark themes both work, and every block has a deliberate icon tile,
 * title and meta hierarchy rather than a bare heading over a paragraph.
 */

export type PanelTone = StatusTone;

const TILE: Record<PanelTone, string> = {
  neutral: "bg-surface-2 text-ink-2 ring-line-strong",
  primary: "bg-primary-soft text-primary-ink ring-primary/15",
  success: "bg-success-soft text-success-ink ring-success/15",
  warning: "bg-warning-soft text-warning-ink ring-warning/20",
  danger: "bg-danger-soft text-danger-ink ring-danger/15",
  violet: "bg-violet-soft text-violet-ink ring-violet/15",
};

const NOTICE: Record<PanelTone, string> = {
  neutral: "bg-surface-2/70 ring-line",
  primary: "bg-primary-soft/60 ring-primary/15",
  success: "bg-success-soft/70 ring-success/15",
  warning: "bg-warning-soft/70 ring-warning/20",
  danger: "bg-danger-soft/70 ring-danger/15",
  violet: "bg-violet-soft/70 ring-violet/15",
};

/** A tinted square that carries an icon. The visual anchor for rows, cards and notices. */
export function IconTile({ icon, tone = "primary", size = "md", className }: { icon: React.ReactNode; tone?: PanelTone; size?: "sm" | "md" | "lg"; className?: string }) {
  const dims = { sm: "size-8 rounded-lg [&>svg]:size-4", md: "size-10 rounded-xl [&>svg]:size-[18px]", lg: "size-12 rounded-2xl [&>svg]:size-5" }[size];
  return (
    <span aria-hidden className={cn("grid shrink-0 place-items-center ring-1 ring-inset", dims, TILE[tone], className)}>
      {icon}
    </span>
  );
}

/** A card with an icon tile, title and description header, an optional trailing slot (status, action) and an optional footer bar. */
export function Panel({
  icon,
  tone = "primary",
  title,
  description,
  aside,
  footer,
  children,
  flush,
  className,
  bodyClassName,
}: {
  icon?: React.ReactNode;
  tone?: PanelTone;
  title: React.ReactNode;
  description?: React.ReactNode;
  aside?: React.ReactNode;
  footer?: React.ReactNode;
  children?: React.ReactNode;
  /** Let the body run edge to edge, for lists with their own row padding. */
  flush?: boolean;
  className?: string;
  bodyClassName?: string;
}) {
  const hasBody = children !== undefined && children !== null && children !== false;
  return (
    <Card className={cn("min-w-0 overflow-hidden", className)}>
      <header className={cn("flex flex-wrap items-start gap-x-3.5 gap-y-3 px-5 pt-5 sm:px-6", !hasBody && "pb-5")}>
        {icon && <IconTile icon={icon} tone={tone} />}
        <div className="min-w-0 flex-1 basis-52">
          <h2 className="text-[15px] font-semibold leading-snug tracking-tight text-ink">{title}</h2>
          {description && <p className="mt-1 text-[14px] leading-relaxed text-muted">{description}</p>}
        </div>
        {aside && <div className="flex shrink-0 flex-wrap items-center gap-2">{aside}</div>}
      </header>
      {hasBody && <div className={cn(flush ? "pt-4" : "px-5 pb-5 pt-5 sm:px-6", bodyClassName)}>{children}</div>}
      {footer && <footer className="border-t border-line bg-surface-2/50 px-5 py-3.5 sm:px-6">{footer}</footer>}
    </Card>
  );
}

/** Footer bar for editable panels: says whether there is anything to save, and offers Discard and Save. */
export function SaveBar({ dirty, pending, onSave, onReset, saveLabel = "Save changes" }: { dirty: boolean; pending: boolean; onSave: () => void; onReset: () => void; saveLabel?: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      {dirty ? <StatusPill tone="warning">Unsaved changes</StatusPill> : <InfoChip icon={<Check aria-hidden />}>Up to date</InfoChip>}
      <div className="ml-auto flex items-center gap-2">
        <Button variant="ghost" disabled={!dirty || pending} onClick={onReset}>
          Discard
        </Button>
        <Button disabled={!dirty} loading={pending} onClick={onSave}>
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}

/** One setting: optional icon tile, title and description on the left, the control (switch, pill, select) on the right. */
export function SettingRow({
  icon,
  tone = "neutral",
  title,
  description,
  children,
  as = "div",
  className,
}: {
  icon?: React.ReactNode;
  tone?: PanelTone;
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  as?: "div" | "label";
  className?: string;
}) {
  const Tag = as;
  return (
    <Tag
      className={cn(
        "flex min-h-14 flex-wrap items-center gap-x-3.5 gap-y-2.5 rounded-2xl border border-line bg-surface px-4 py-3 transition-colors",
        as === "label" && "cursor-pointer hover:border-line-strong hover:bg-surface-2/50",
        className,
      )}
    >
      {icon && <IconTile icon={icon} tone={tone} size="sm" />}
      <span className="min-w-[9.5rem] flex-1 basis-40">
        <span className="block text-[14px] font-medium leading-snug text-ink">{title}</span>
        {description && <span className="mt-0.5 block text-[13px] leading-relaxed text-muted">{description}</span>}
      </span>
      {children && <span className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2.5">{children}</span>}
    </Tag>
  );
}

/** A selectable card for a single-choice setting (tone, availability, follow-up style). Marked with a check, not colour alone. */
export function OptionCard({
  selected,
  onSelect,
  disabled,
  title,
  description,
  icon,
  meta,
  className,
}: {
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  meta?: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "group relative flex min-h-[4.5rem] items-start gap-3 rounded-2xl border p-3.5 text-left transition disabled:cursor-not-allowed disabled:opacity-60",
        selected ? "border-primary/50 bg-primary-soft/60 ring-2 ring-primary/15" : "border-line bg-surface hover:border-line-strong hover:bg-surface-2/50",
        className,
      )}
    >
      {icon && <IconTile icon={icon} tone={selected ? "primary" : "neutral"} size="sm" />}
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[14px] font-semibold leading-snug text-ink">
          {title}
          {meta}
        </span>
        {description && <span className="mt-1 block text-[13px] leading-relaxed text-muted">{description}</span>}
      </span>
      <span aria-hidden className={cn("mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border transition", selected ? "border-primary bg-primary text-white" : "border-line-strong bg-surface")}>
        {selected && <Check className="size-3" strokeWidth={3} />}
      </span>
    </button>
  );
}

/** A compact figure with a label: the replacement for a muted sentence that happens to hold a number. */
export function Stat({ label, value, hint, icon, className }: { label: React.ReactNode; value: React.ReactNode; hint?: React.ReactNode; icon?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0 rounded-2xl border border-line bg-surface-2/50 p-4", className)}>
      <p className="flex items-center gap-1.5 text-[12px] font-medium text-muted [&>svg]:size-3.5 [&>svg]:shrink-0">
        {icon}
        {label}
      </p>
      <p className="mt-1.5 truncate text-[22px] font-semibold leading-tight tracking-[-0.03em] text-ink tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-[12px] leading-snug text-muted">{hint}</p>}
    </div>
  );
}

/** A tinted callout with an icon tile, for a state or rule that used to be a muted sentence. */
export function Notice({ tone = "neutral", icon, title, children, className, role }: { tone?: PanelTone; icon: React.ReactNode; title?: React.ReactNode; children: React.ReactNode; className?: string; role?: "status" | "alert" }) {
  return (
    <div role={role} className={cn("flex items-start gap-3 rounded-2xl p-3.5 ring-1 ring-inset", NOTICE[tone], className)}>
      <IconTile icon={icon} tone={tone} size="sm" />
      <div className="min-w-0 flex-1 self-center text-[14px] leading-relaxed text-ink-2">
        {title && <p className="text-[14px] font-semibold leading-snug text-ink">{title}</p>}
        <div className={cn(title && "mt-0.5")}>{children}</div>
      </div>
    </div>
  );
}

/** Pill tabs with counts, in the style of the Clients toolbar. */
export function FilterTabs<V extends string>({ value, onChange, options, label, className }: { value: V; onChange: (v: V) => void; options: Array<{ value: V; label: string; count?: number }>; label: string; className?: string }) {
  return (
    <div role="group" aria-label={label} className={cn("scrollbar-thin relative -mx-1 flex max-w-full items-center gap-1.5 overflow-x-auto px-1 pb-1 sm:pb-0", className)}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(o.value)}
            className={cn("inline-flex h-10 shrink-0 items-center gap-2 rounded-full px-3.5 text-[14px] font-medium transition-colors duration-200 sm:h-9", active ? "bg-ink text-surface shadow-soft" : "text-ink-2 hover:bg-surface-3/70")}
          >
            {o.label}
            {o.count !== undefined && <span className={cn("grid h-5 min-w-5 place-items-center rounded-full px-1.5 text-[12px] font-semibold tabular-nums", active ? "bg-surface/20 text-surface" : "bg-surface text-muted ring-1 ring-inset ring-line")}>{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** A thin tinted strip along the top edge of a card, for cards whose state matters at a glance. */
export function AccentStrip({ tone = "primary" }: { tone?: PanelTone }) {
  const bar: Record<PanelTone, string> = {
    neutral: "from-line-strong to-transparent",
    primary: "from-primary to-violet",
    success: "from-success to-success/10",
    warning: "from-warning to-warning/10",
    danger: "from-danger to-danger/10",
    violet: "from-violet to-primary",
  };
  return <span aria-hidden className={cn("pointer-events-none absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r", bar[tone])} />;
}
