"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Building2, CalendarDays, Database, Eye, Handshake, Inbox, KanbanSquare, LayoutDashboard, ListChecks, ListFilter, Plug, ShieldCheck, Sparkles, Tags, TextCursorInput, Users,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { CrmNavSection } from "@/lib/crm/nav";
import { CRM_MODE_LABELS, type CrmMode } from "@/lib/crm/types";

const ICONS: Record<string, LucideIcon> = {
  "layout-dashboard": LayoutDashboard, users: Users, "building-2": Building2, "list-filter": ListFilter, tags: Tags, "text-cursor-input": TextCursorInput,
  "kanban-square": KanbanSquare, handshake: Handshake, "list-checks": ListChecks, inbox: Inbox, sparkles: Sparkles, plug: Plug, "shield-check": ShieldCheck,
  database: Database, eye: Eye, "calendar-days": CalendarDays,
};

export interface CrmShellProps {
  base: string;
  sections: CrmNavSection[];
  mode: CrmMode;
  orgName: string;
  /** Shown above everything when an agency person is inside a client's CRM. */
  banner?: React.ReactNode;
  children: React.ReactNode;
}

export function CrmShell({ base, sections, mode, orgName, banner, children }: CrmShellProps) {
  const pathname = usePathname();
  const href = (item: { path: string; external?: boolean }) => (item.external ? item.path : `${base}${item.path}`);
  const isActive = (item: { path: string; external?: boolean; exact?: boolean }) => {
    const h = href(item);
    return item.exact ? pathname === h : pathname === h || pathname.startsWith(`${h}/`);
  };
  const flat = sections.flatMap((s) => s.items);
  return (
    <div className="space-y-5">
      {banner}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">CRM workspace</p>
          <h1 className="mt-1 truncate text-[22px] font-semibold tracking-[-0.03em] text-ink">{orgName}</h1>
        </div>
        <span
          className={cn(
            "inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-[12px] font-medium",
            mode === "native" ? "border-primary/20 bg-primary-soft text-primary-ink" : mode === "ghl" ? "border-warning/30 bg-warning-soft text-warning-ink" : "border-violet/25 bg-violet-soft text-violet-ink",
          )}
          title={CRM_MODE_LABELS[mode].description}
        >
          <span className="size-1.5 rounded-full bg-current" aria-hidden />
          {CRM_MODE_LABELS[mode].label}
        </span>
      </div>

      {/* Mobile and tablet: one scrollable row of every section. */}
      <nav aria-label="CRM sections" className="scrollbar-thin -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 lg:hidden">
        {flat.map((item) => {
          const Icon = ICONS[item.icon] ?? LayoutDashboard;
          const active = isActive(item);
          return (
            <Link
              key={`${item.path}-${item.label}`}
              href={href(item)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl border px-3 text-[13px] font-medium transition-colors sm:min-h-9",
                active ? "border-primary/25 bg-primary-soft text-primary-ink" : "border-line bg-surface text-ink-2 hover:bg-surface-2",
              )}
            >
              <Icon className="size-4" aria-hidden />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="grid min-w-0 gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
        <nav aria-label="CRM" className="hidden self-start lg:sticky lg:top-24 lg:block">
          <div className="space-y-5">
            {sections.map((section) => (
              <div key={section.key}>
                <p className="px-2.5 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-faint">{section.label}</p>
                <ul className="space-y-0.5">
                  {section.items.map((item) => {
                    const Icon = ICONS[item.icon] ?? LayoutDashboard;
                    const active = isActive(item);
                    return (
                      <li key={`${item.path}-${item.label}`}>
                        <Link
                          href={href(item)}
                          aria-current={active ? "page" : undefined}
                          className={cn(
                            "flex min-h-9 items-center gap-2.5 rounded-xl px-2.5 text-[13.5px] font-medium transition-colors",
                            active ? "bg-surface text-ink shadow-soft ring-1 ring-line" : "text-ink-2 hover:bg-surface-2 hover:text-ink",
                          )}
                        >
                          <Icon className={cn("size-4 shrink-0", active ? "text-primary" : "text-muted")} aria-hidden />
                          <span className="truncate">{item.label}</span>
                          {item.external && <span className="ml-auto text-[10px] text-faint" aria-hidden>↗</span>}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </nav>
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
