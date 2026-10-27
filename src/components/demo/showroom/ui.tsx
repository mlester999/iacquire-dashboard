import * as React from "react";
import { BarChart3, ChevronDown, Flag, Inbox, LayoutDashboard, SquareKanban, Sparkles, Tag, Users, Workflow } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Tone } from "@/lib/demo/showroom/employees";
import type { ViewDef } from "@/lib/demo/showroom/content";

// The small pieces the showroom's views are built from. Server-safe (no state), so a view can render on the server first.

export function Eyebrow({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn("sx-eyebrow", className)}>{children}</p>;
}

export function SectionHead({ eyebrow, title, lead, className, as: Tag = "h2" }: { eyebrow?: string; title: React.ReactNode; lead?: React.ReactNode; className?: string; as?: "h1" | "h2" | "h3" }) {
  return (
    <header className={cn("max-w-3xl", className)}>
      {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
      <Tag className="sx-display mt-1.5 text-[26px] leading-[1.15] text-ink @xl:text-[30px]">{title}</Tag>
      {lead && <p className="mt-2 text-[15px] leading-relaxed text-ink-2">{lead}</p>}
    </header>
  );
}

export function Panel({ children, className, hot, as: Tag = "div", ...rest }: React.HTMLAttributes<HTMLElement> & { hot?: boolean; as?: "div" | "section" | "article" | "li" }) {
  return (
    <Tag className={cn("sx-panel", hot && "sx-panel-hot", className)} {...rest}>
      {children}
    </Tag>
  );
}

export function Chip({ children, tone = "neutral", className }: { children: React.ReactNode; tone?: Tone; className?: string }) {
  return (
    <span className={cn("sx-chip", className)} data-tone={tone === "neutral" ? undefined : tone}>
      {children}
    </span>
  );
}

/** Says, once and plainly, that what is drawn is a simulation. Not a banner: a label that sits on the thing it describes. */
export function SimTag({ children = "Simulated sample", className }: { children?: React.ReactNode; className?: string }) {
  return (
    <span className={cn("sx-chip", className)} data-tone="warn">
      <span className="size-1.5 rounded-full bg-warning" aria-hidden />
      {children}
    </span>
  );
}

/** Which plan a capability belongs to. The words are fixed by the approved offer: the core system never waits on the monthly plan. */
export function PlanTag({ plan }: { plan: "core" | "maintenance" }) {
  return plan === "core" ? (
    <Chip tone="ok">Part of your implementation</Chip>
  ) : (
    <Chip tone="violet">Optional: Managed Maintenance</Chip>
  );
}

/** "US$1,499": the price as the offer states it, with the currency named. */
export const usd = (n: number) => `US${dollars(n)}`;
export const dollars = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);

/**
 * One question and its answer: a native <details>, so it opens without scripts and without any state. Opening it changes the card's border and turns its arrow, and the height eases open
 * where the browser can animate a <details> (showroom.css); it never changes the page's background.
 */
export function FaqItem({ question, children, className }: { question: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <details className={cn("sx-faq group rounded-2xl border border-line bg-surface shadow-[var(--shadow-sm)] transition-[border-color,box-shadow] duration-200 open:border-primary/45 open:shadow-[var(--shadow-md)]", className)}>
      <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 rounded-2xl px-5 py-3.5 text-[15px] font-semibold text-ink [&::-webkit-details-marker]:hidden">
        <span>{question}</span>
        <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full bg-surface-2 text-muted transition-[transform,background-color,color] duration-200 group-open:rotate-180 group-open:bg-primary-soft group-open:text-primary-ink">
          <ChevronDown className="size-4" />
        </span>
      </summary>
      <div className="sx-fade px-5 pb-5">{children}</div>
    </details>
  );
}

/** A sideways-scrolling area (a wide table, a board) that a keyboard can reach: it is focusable, named, and scrolls with the arrow keys. */
export function ScrollRegion({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <div role="region" aria-label={label} tabIndex={0} className={cn("relative overflow-x-auto rounded-2xl border border-line focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary", className)}>
      {children}
    </div>
  );
}

const ICONS = { layout: LayoutDashboard, users: Users, kanban: SquareKanban, inbox: Inbox, workflow: Workflow, chart: BarChart3, tag: Tag, sparkles: Sparkles, flag: Flag } as const;

export function ViewIcon({ name, className }: { name: ViewDef["icon"]; className?: string }) {
  const Icon = ICONS[name];
  return <Icon className={cn("size-[18px] shrink-0", className)} aria-hidden />;
}
