import * as React from "react";
import { Card } from "@/components/ui/primitives";
import { type StatusTone } from "@/components/ui/status";
import { cn } from "@/lib/utils";

/** Soft tinted surfaces per tone, so a card or row can carry its meaning without relying on colour alone. */
export const TINT: Record<StatusTone, { tile: string; row: string; strip: string; wash: string }> = {
  neutral: { tile: "bg-surface-2 text-ink-2 ring-line-strong", row: "border-line bg-surface", strip: "from-line-strong to-transparent", wash: "from-surface-2/80" },
  primary: { tile: "bg-primary-soft text-primary-ink ring-primary/20", row: "border-primary/15 bg-primary-soft/40", strip: "from-primary to-violet", wash: "from-primary-soft/70" },
  success: { tile: "bg-success-soft text-success-ink ring-success/20", row: "border-success/15 bg-success-soft/40", strip: "from-success to-success/10", wash: "from-success-soft/60" },
  warning: { tile: "bg-warning-soft text-warning-ink ring-warning/25", row: "border-warning/20 bg-warning-soft/50", strip: "from-warning to-warning/10", wash: "from-warning-soft/60" },
  danger: { tile: "bg-danger-soft text-danger-ink ring-danger/20", row: "border-danger/20 bg-danger-soft/50", strip: "from-danger to-danger/10", wash: "from-danger-soft/60" },
  violet: { tile: "bg-violet-soft text-violet-ink ring-violet/20", row: "border-violet/15 bg-violet-soft/40", strip: "from-violet to-primary", wash: "from-violet-soft/70" },
};

/** A small rounded tile that carries an icon. The shared "identity" mark for sections, rows and notices. */
export function IconTile({ tone = "primary", size = "md", children, className }: { tone?: StatusTone; size?: "sm" | "md" | "lg"; children: React.ReactNode; className?: string }) {
  const dims = { sm: "size-7 rounded-lg [&>svg]:size-3.5", md: "size-9 rounded-xl [&>svg]:size-4", lg: "size-11 rounded-2xl [&>svg]:size-5" }[size];
  return (
    <span aria-hidden className={cn("grid shrink-0 place-items-center ring-1 ring-inset", dims, TINT[tone].tile, className)}>
      {children}
    </span>
  );
}

/** A thin accent strip and soft wash along the top edge of a card, in the tone of the card. */
export function AccentTop({ tone = "primary", wash = true }: { tone?: StatusTone; wash?: boolean }) {
  return (
    <>
      <span aria-hidden className={cn("pointer-events-none absolute inset-x-0 top-0 z-10 h-[3px] bg-gradient-to-r", TINT[tone].strip)} />
      {wash && <span aria-hidden className={cn("pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b to-transparent", TINT[tone].wash)} />}
    </>
  );
}

/**
 * A section card with a clear header: icon tile, title, one-line description and an optional action on the right.
 * Use it instead of a bare heading and paragraph so every section has the same structure.
 */
export function Panel({
  icon,
  tone = "primary",
  title,
  description,
  action,
  children,
  className,
  bodyClassName,
  id,
  accent = false,
}: {
  icon: React.ReactNode;
  tone?: StatusTone;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  id?: string;
  accent?: boolean;
}) {
  return (
    <Card id={id} className={cn("relative flex min-w-0 flex-col overflow-hidden", className)}>
      {accent && <AccentTop tone={tone} />}
      <div className="relative flex flex-wrap items-start justify-between gap-x-3 gap-y-2 px-5 pt-5">
        <div className="flex min-w-0 items-start gap-3">
          <IconTile tone={tone}>{icon}</IconTile>
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold leading-tight tracking-tight text-ink">{title}</h2>
            {description && <p className="mt-1 text-[13px] leading-relaxed text-muted">{description}</p>}
          </div>
        </div>
        {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
      </div>
      <div className={cn("relative flex-1 px-5 pb-5 pt-4", bodyClassName)}>{children}</div>
    </Card>
  );
}
