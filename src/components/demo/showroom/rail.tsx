"use client";

import * as React from "react";
import Link from "next/link";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/brand";
import { Tooltip } from "@/components/ui/overlays";
import { VIEWS, type ViewId } from "@/lib/demo/showroom/content";
import { MessageMeter, MiniStats, WindowClock } from "@/components/demo/showroom/clock";
import { useShowroom } from "@/components/demo/showroom/context";
import { ConsultRail } from "@/components/demo/showroom/cta";
import { ThemeCycle, ThemeSwitch } from "@/components/demo/showroom/theme-switch";
import { ViewIcon } from "@/components/demo/showroom/ui";

// The demo's navigation rail: the portal's navy sidebar, which folds into a rail of icons. Every row is built from a fixed 44 px icon cell followed by a label, so folding only changes the
// width (and fades the labels): no icon ever moves. The width and the page's left padding animate together (src/components/demo/showroom/showroom.css), and a folded row keeps its words for
// assistive technology and shows them in a tooltip. The choice is remembered in this browser (rail-preference.ts).

export const RAIL_WIDE = 264;
export const RAIL_FOLDED = 68;
// The rail's side padding (12 px) plus a 6 px gap, so a tip clears the rail's edge instead of sitting half on it.
const TIP_GAP = 18;

const GROUPS: Array<{ label: string; ids: ViewId[] }> = [
  { label: "Explore the product", ids: ["overview", "workforce", "crm", "inbox", "automation", "reports"] },
  { label: "Plans and next steps", ids: ["pricing", "why"] },
];

const hrefOf = (id: ViewId) => (id === "overview" ? "/demo/room" : `/demo/room?view=${id}`);

function NavItem({ id, view, go, collapsed }: { id: ViewId; view: ViewId; go: (v: ViewId) => void; collapsed: boolean }) {
  const v = VIEWS.find((x) => x.id === id)!;
  return (
    <li>
      <Tooltip content={v.label} side="right" sideOffset={TIP_GAP} disabled={!collapsed}>
        <a
          href={hrefOf(v.id)}
          aria-current={view === v.id ? "page" : undefined}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
            e.preventDefault();
            go(v.id);
          }}
          className="nav-row h-11 gap-0 overflow-hidden text-[14px] font-medium"
        >
          <span className="grid size-11 shrink-0 place-items-center">
            <span className="nav-icon-box">
              <ViewIcon name={v.icon} className="size-[17px]" />
            </span>
          </span>
          <span className="sx-rail-label min-w-0 truncate pr-3">{v.label}</span>
        </a>
      </Tooltip>
    </li>
  );
}

export function NavRail({ view, go, collapsed, onToggle }: { view: ViewId; go: (v: ViewId) => void; collapsed: boolean; onToggle: () => void }) {
  const { business, firstName, industryLabel } = useShowroom();
  const name = business?.trim() || `${firstName}'s business`;
  const initial = (name.match(/[A-Za-z0-9]/)?.[0] ?? "A").toUpperCase();
  return (
    <aside
      id="demo-rail"
      aria-label="Demo navigation"
      data-collapsed={collapsed}
      className="workspace-nav sx-on-nav sx-rail sx-scroll hidden lg:fixed lg:inset-y-0 lg:left-0 lg:z-30 lg:flex lg:flex-col lg:overflow-y-auto lg:overflow-x-hidden"
    >
      {/* The mark, the "Demo" label and the fold button. One set of elements in both states, so focus stays on the button when the rail folds. */}
      <div className={cn("flex shrink-0 px-3", collapsed ? "flex-col items-start gap-1 pb-2 pt-3" : "h-[68px] items-center gap-2")}>
        <Link href="/demo" aria-label="iAcquire demo home" className="workspace-nav-brand inline-flex shrink-0 items-center p-1.5">
          <Logo tone="inverse" compact={collapsed} />
        </Link>
        {!collapsed && <span className="flex-1" />}
        <span className={cn("sx-rail-label rounded-full border border-white/15 bg-white/[.07] px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-[#cdd8ee]", collapsed && "hidden")}>Demo</span>
        <Tooltip content={collapsed ? "Expand navigation" : "Collapse navigation"} side="right" sideOffset={TIP_GAP}>
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={!collapsed}
            aria-controls="demo-rail"
            aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
            className={cn("grid shrink-0 place-items-center rounded-xl text-[#b6c1d4] transition-colors hover:bg-white/10 hover:text-white", collapsed ? "size-11 bg-white/[.06]" : "size-9")}
          >
            {collapsed ? <PanelLeftOpen className="size-[18px]" aria-hidden /> : <PanelLeftClose className="size-[18px]" aria-hidden />}
          </button>
        </Tooltip>
      </div>

      <div className="mx-3 mb-3 shrink-0">
        <Tooltip content={name} side="right" sideOffset={TIP_GAP} disabled={!collapsed}>
          <div className="flex h-11 items-center overflow-hidden rounded-xl bg-white/[.035] ring-1 ring-inset ring-white/10 data-[folded=true]:ring-0" data-folded={collapsed}>
            <span aria-hidden className="grid size-11 shrink-0 place-items-center rounded-xl bg-white/10 text-[16px] font-semibold text-white">
              {initial}
            </span>
            <div className="sx-rail-label min-w-0 flex-1 pr-3 leading-tight">
              <p className="sr-only">Your demo</p>
              <p className="truncate text-[13.5px] font-semibold text-white">{name}</p>
              {industryLabel && <p className="truncate text-[11.5px] text-[#b6c1d4]">{industryLabel}</p>}
            </div>
          </div>
        </Tooltip>
      </div>

      <div className="mx-3 mb-4 shrink-0">
        <Tooltip content="Book a free consultation" side="right" sideOffset={TIP_GAP} disabled={!collapsed}>
          <div>
            <ConsultRail />
          </div>
        </Tooltip>
      </div>

      <nav aria-label="Sections" className="min-h-0 flex-1 px-3">
        <div className="space-y-1">
          {GROUPS.map((g) => (
            <div key={g.label}>
              <div aria-hidden className="relative h-8">
                <p className="workspace-nav-section sx-rail-label absolute inset-x-0 bottom-1 whitespace-nowrap px-3">{g.label}</p>
                <span className="sx-rail-divider absolute inset-x-2 bottom-3 h-px bg-white/10" />
              </div>
              <ul aria-label={g.label} className="space-y-0.5">
                {g.ids.map((id) => (
                  <NavItem key={id} id={id} view={view} go={go} collapsed={collapsed} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      </nav>

      <div className="mt-4 shrink-0 space-y-3 px-3 pb-4">
        <div key={collapsed ? "mini" : "full"} className="sx-fade">
          {collapsed ? (
            <MiniStats />
          ) : (
            <div className="space-y-3.5 rounded-xl border border-white/10 bg-white/[.035] p-3.5">
              <WindowClock compact />
              <MessageMeter compact />
            </div>
          )}
        </div>
        {collapsed ? (
          <ThemeCycle />
        ) : (
          <div className="flex items-center justify-between gap-2 px-1">
            <span className="text-[12px] font-medium text-[#91a0ba]">Appearance</span>
            <ThemeSwitch tone="nav" />
          </div>
        )}
      </div>
    </aside>
  );
}
