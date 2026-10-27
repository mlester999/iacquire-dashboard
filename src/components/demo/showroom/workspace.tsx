"use client";

import * as React from "react";
import Link from "next/link";
import { Logo } from "@/components/brand";
import { TooltipProvider } from "@/components/ui/overlays";
import { AGENT_ROLES, type AgentRoleKey } from "@/lib/agents";
import { ROOM_COPY, type Notice } from "@/lib/demo/outcomes";
import { REFUSAL_COPY } from "@/lib/demo/rules";
import type { RoomChatState } from "@/lib/demo/room-types";
import { VIEWS, isViewId, type ViewId } from "@/lib/demo/showroom/content";
import { AqiDock } from "@/components/demo/showroom/aqi-dock";
import { ShowroomProvider, useShowroom, type ShowroomState } from "@/components/demo/showroom/context";
import { ConfirmHost, ConfirmStatic, ConsultCta } from "@/components/demo/showroom/cta";
import { JourneyBar, JourneyProvider } from "@/components/demo/showroom/journey";
import { NavRail, RAIL_FOLDED, RAIL_WIDE } from "@/components/demo/showroom/rail";
import { useRailCollapsed } from "@/components/demo/showroom/rail-preference";
import { ThemeSwitch } from "@/components/demo/showroom/theme-switch";
import { Chip, ViewIcon } from "@/components/demo/showroom/ui";
import { AutomationView } from "@/components/demo/showroom/views/automation";
import { CrmView } from "@/components/demo/showroom/views/crm";
import { InboxView } from "@/components/demo/showroom/views/inbox";
import { OverviewView } from "@/components/demo/showroom/views/overview";
import { PricingView } from "@/components/demo/showroom/views/pricing";
import { ReportsView } from "@/components/demo/showroom/views/reports";
import { SummaryView } from "@/components/demo/showroom/views/summary";
import { WhyView } from "@/components/demo/showroom/views/why";
import { WorkforceView } from "@/components/demo/showroom/views/workforce";
import "@/components/demo/showroom/showroom.css";

// The demo room as a safe preview of the real portal: the same navy navigation rail (which folds to icons), the same themed page, cards and buttons, the same light/dark/system choice, and
// AQi as the floating assistant in the corner. It is a public component set: it never mounts the portal's own shell, and nothing here reads a workspace. Everything shown is the record's:
// the window, the messages, the conversation and the two requests come from the server's view of this one demo, and moving between views changes none of them and counts no message. The
// address carries the view (?view=...), so a view can be opened directly and the page works without scripts.

const ROLES = AGENT_ROLES.map((r) => ({ key: r.key as string, name: r.name }));

const SUGGESTIONS: Record<ViewId, string[]> = {
  overview: ["What can the AI team do for a business like mine?", "What is included in the implementation?", "Do I need to pay a monthly fee?"],
  workforce: ["How do the six AI Employees work together?", "What will the AI Employees never do without my approval?", "Which employee should I start with?"],
  crm: ["What is in the native CRM?", "How does a lead move through the pipeline?", "Can I use my own pipeline stages?"],
  inbox: ["Which channels can the inbox bring together?", "How does the Appointment Setter use my calendar?", "Who approves a reply before it is sent?"],
  automation: ["What is Automation Studio?", "Is Automation Studio part of the core system?", "Can I use n8n or Zapier instead?"],
  reports: ["What does the Performance Analyst report on?", "Where do the numbers come from?", "Can I see reports for my own pipeline?"],
  pricing: ["What does the implementation cost?", "What does Managed Maintenance add?", "What costs are separate?"],
  why: ["Why not build this myself?", "How is this different from a normal CRM?", "What happens after I ask for a consultation?"],
  summary: ["What happens after I book a consultation?", "What would you set up for me first?", "How long does setup take?"],
};

export interface WorkspaceProps {
  state: ShowroomState;
  initialView: ViewId;
  chat: { initial: RoomChatState; fallbackMessageId: string; pageNotice: Notice | null; show: boolean };
}

function viewOf(search: string): ViewId {
  const v = new URLSearchParams(search).get("view");
  return isViewId(v) ? v : "overview";
}

const noSubscribe = () => () => {};

/** The confirmation of a link followed without scripts, drawn on the page until the page is live; then the dialog takes over. */
function StaticConfirmation() {
  const { confirming } = useShowroom();
  const live = React.useSyncExternalStore(noSubscribe, () => true, () => false);
  if (live || !confirming) return null;
  return <ConfirmStatic kind={confirming} />;
}

export function Workspace({ state, initialView, chat }: WorkspaceProps) {
  const [view, setView] = React.useState<ViewId>(initialView);
  const [focusRole, setFocusRole] = React.useState<AgentRoleKey | null>(null);
  // AQi starts tucked away, unless the page is coming back from a message sent without scripts (its answer or refusal is in the chat, so it should be seen).
  const [chatOpen, setChatOpen] = React.useState(chat.pageNotice !== null);
  const [draft, setDraft] = React.useState<{ text: string; nonce: number } | null>(null);
  const [collapsed, setCollapsed] = useRailCollapsed();
  const [ready, setReady] = React.useState(false);
  const mainRef = React.useRef<HTMLElement>(null);
  const moved = React.useRef(false);

  // Nothing animates until the page is live and has painted once, so a remembered folded rail does not play its fold on every load.
  React.useEffect(() => {
    let inner = 0;
    const outer = window.requestAnimationFrame(() => {
      inner = window.requestAnimationFrame(() => setReady(true));
    });
    return () => {
      window.cancelAnimationFrame(outer);
      window.cancelAnimationFrame(inner);
    };
  }, []);

  const go = React.useCallback((next: ViewId, role?: AgentRoleKey) => {
    moved.current = true;
    setFocusRole(role ?? null);
    setView(next);
    // On a phone AQi is a sheet over the whole page, so moving somewhere tucks it away; on a larger screen it floats beside the page and stays where the visitor left it.
    if (typeof window.matchMedia === "function" && window.matchMedia("(max-width: 639px)").matches) setChatOpen(false);
    try {
      window.history.pushState(null, "", next === "overview" ? window.location.pathname : `${window.location.pathname}?view=${next}`);
    } catch {
      /* the address stays as it was; the view still changes */
    }
  }, []);

  React.useEffect(() => {
    const onPop = () => {
      moved.current = true;
      setFocusRole(null);
      setView(viewOf(window.location.search));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  React.useEffect(() => {
    if (!moved.current) return;
    window.scrollTo({ top: 0 });
    mainRef.current?.focus({ preventScroll: true });
  }, [view]);

  const ask = React.useCallback((question: string) => {
    setDraft((d) => ({ text: question, nonce: (d?.nonce ?? 0) + 1 }));
    setChatOpen(true);
  }, []);

  const current = VIEWS.find((v) => v.id === view);
  const label = current?.label ?? "Your business, powered by iAcquireOS";
  const open = state.access === "open";

  return (
    <TooltipProvider>
      <ShowroomProvider state={state} view={view} go={go} ask={ask} focusRole={focusRole}>
        <JourneyProvider view={view}>
          <div className="demo-stage app-backdrop grain">
            <a href="#demo-main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[80] focus:rounded-xl focus:bg-surface focus:px-4 focus:py-2 focus:text-[14px] focus:text-ink focus:shadow-float">
              Skip to content
            </a>

            <div
              className="showroom-layout relative z-10"
              data-nav-collapsed={collapsed}
              data-ready={ready ? "true" : undefined}
              style={{ "--sidebar-w": `${collapsed ? RAIL_FOLDED : RAIL_WIDE}px` } as React.CSSProperties}
            >
              {/* Navigation rail (large screens): the portal's navy sidebar, which folds to icons */}
              <NavRail view={view} go={go} collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />

              <div className="sx-shift min-w-0">
                {/* Header and section pills (smaller screens) */}
                <header className="sticky top-0 z-30 border-b border-line bg-surface/90 backdrop-blur-xl lg:hidden">
                  <div className="flex items-center justify-between gap-3 px-4 pt-2.5">
                    <Link href="/demo" aria-label="iAcquire demo home" className="inline-flex min-h-11 items-center gap-2.5">
                      <Logo />
                      <Chip tone="info">Demo</Chip>
                    </Link>
                    <ThemeSwitch />
                  </div>
                  <nav aria-label="Sections" className="sx-noscrollbar relative overflow-x-auto px-3 py-2.5">
                    <ul className="flex gap-1.5">
                      {VIEWS.map((v) => (
                        <li key={v.id} className="shrink-0">
                          <a
                            href={v.id === "overview" ? "/demo/room" : `/demo/room?view=${v.id}`}
                            aria-current={view === v.id ? "page" : undefined}
                            onClick={(e) => {
                              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                              e.preventDefault();
                              go(v.id);
                            }}
                            className="sx-nav-item inline-flex min-h-10 items-center gap-2 rounded-full border border-line bg-surface px-3.5 text-[13px] font-medium text-ink-2"
                          >
                            <ViewIcon name={v.icon} className="size-4" />
                            {v.short}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </nav>
                </header>

                <div className="px-4 pb-28 pt-4 sm:px-6 lg:px-8 lg:pb-16 lg:pt-0">
                  {/* Tour strip, and the consultation action where the rail is not on screen */}
                  <div className="z-20 -mx-4 mb-6 bg-gradient-to-b from-[var(--bg)] via-[var(--bg)]/90 to-transparent px-4 pb-3 pt-0 sm:-mx-6 sm:px-6 lg:sticky lg:top-0 lg:-mx-8 lg:px-8 lg:pt-5">
                    <div className="flex flex-wrap items-stretch gap-3">
                      <JourneyBar className="min-w-0 basis-full lg:flex-1 lg:basis-0" />
                      <div className="hidden w-full items-center gap-2 md:flex lg:hidden">
                        <ConsultCta size="md" className="flex-1" />
                      </div>
                    </div>
                  </div>

                  {!open && (
                    <p role="status" className="sx-panel-flat mb-6 px-5 py-3.5 text-[14px] leading-relaxed text-ink-2">
                      {REFUSAL_COPY.window_ended} The tour, the plans and the case for iAcquireOS stay open to read.
                    </p>
                  )}

                  <main id="demo-main" ref={mainRef} tabIndex={-1} className="@container mx-auto w-full max-w-[1120px] outline-none">
                    <p className="sr-only" aria-live="polite">
                      Showing {label}
                    </p>
                    <StaticConfirmation />
                    <div key={view} className="sx-rise">
                      {view === "overview" && <OverviewView />}
                      {view === "workforce" && <WorkforceView key={focusRole ?? "any"} />}
                      {view === "crm" && <CrmView />}
                      {view === "inbox" && <InboxView />}
                      {view === "automation" && <AutomationView />}
                      {view === "reports" && <ReportsView />}
                      {view === "pricing" && <PricingView />}
                      {view === "why" && <WhyView />}
                      {view === "summary" && <SummaryView />}
                    </div>

                    <footer className="mt-16 space-y-3 border-t border-line pt-6 text-[13px] leading-relaxed text-muted">
                      <p>iAcquire demo. Sample data only.</p>
                      <form method="post" action="/api/public/demo/leave">
                        <button type="submit" className="min-h-10 rounded-lg px-1 text-[13px] font-medium text-ink-2 underline underline-offset-4 hover:text-ink">
                          {ROOM_COPY.leaveButton}
                        </button>
                      </form>
                      <p>{ROOM_COPY.erasure}</p>
                    </footer>
                  </main>
                </div>
              </div>
            </div>

            {/* AQi: a floating button in the corner that opens the guide over the page, and tucks it away again */}
            <AqiDock open={chatOpen} onOpenChange={setChatOpen} chat={chat} roles={ROLES} draft={draft} suggestions={SUGGESTIONS[view]} />

            {/* Bottom bar on phones: the consultation action stays one tap away (AQi's button floats just above it) */}
            <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 px-3 py-2.5 backdrop-blur-xl md:hidden">
              <div className="mx-auto flex max-w-xl items-center gap-2">
                <ConsultCta size="md" className="min-w-0 flex-1" />
              </div>
            </div>

            <ConfirmHost />

            <noscript>
              <style>{`#aqi-launcher{display:none!important}#showroom-chat{position:static!important;visibility:visible!important;opacity:1!important;pointer-events:auto!important;transform:none!important;translate:none!important;scale:none!important;width:auto!important;max-width:760px!important;height:auto!important;margin:16px auto!important;border-radius:16px!important}`}</style>
            </noscript>
          </div>
        </JourneyProvider>
      </ShowroomProvider>
    </TooltipProvider>
  );
}
