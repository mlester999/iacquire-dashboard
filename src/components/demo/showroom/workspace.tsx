"use client";

import * as React from "react";
import Link from "next/link";
import { MessageSquareText, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Logo, LogoMark } from "@/components/brand";
import { AGENT_ROLES, type AgentRoleKey } from "@/lib/agents";
import { DemoChat } from "@/components/demo/chat";
import { DemoNotice } from "@/components/demo/shell";
import { ROOM_COPY, type Notice } from "@/lib/demo/outcomes";
import { REFUSAL_COPY } from "@/lib/demo/rules";
import type { RoomChatState } from "@/lib/demo/room-types";
import { VIEWS, isViewId, type ViewId } from "@/lib/demo/showroom/content";
import { MessageMeter, WindowClock } from "@/components/demo/showroom/clock";
import { ShowroomProvider, useShowroom, type ShowroomState } from "@/components/demo/showroom/context";
import { ConfirmHost, ConfirmStatic, ConsultCta } from "@/components/demo/showroom/cta";
import { JourneyBar, JourneyProvider } from "@/components/demo/showroom/journey";
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

// The demo room as a safe preview of the real portal: the same navy navigation rail, the same themed page, cards and buttons, the same light/dark/system choice. It is a public component
// set: it never mounts the portal's own shell, and nothing here reads a workspace. Everything shown is the record's: the window, the messages, the conversation and the two requests
// come from the server's view of this one demo, and moving between views changes none of them and counts no message. The address carries the view (?view=...), so a view can be
// opened directly and the page works without scripts.

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

const GROUPS: Array<{ label: string; ids: ViewId[] }> = [
  { label: "Explore the product", ids: ["overview", "workforce", "crm", "inbox", "automation", "reports"] },
  { label: "Plans and next steps", ids: ["pricing", "why"] },
];

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

function NavLinks({ view, go, className }: { view: ViewId; go: (v: ViewId) => void; className?: string }) {
  return (
    <div className={cn("space-y-4", className)}>
      {GROUPS.map((g) => (
        <div key={g.label} className="space-y-1">
          <p className="workspace-nav-section px-3 pb-1">{g.label}</p>
          <ul className="space-y-0.5">
            {g.ids.map((id) => {
              const v = VIEWS.find((x) => x.id === id)!;
              return (
                <li key={v.id}>
                  <a
                    href={v.id === "overview" ? "/demo/room" : `/demo/room?view=${v.id}`}
                    aria-current={view === v.id ? "page" : undefined}
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                      e.preventDefault();
                      go(v.id);
                    }}
                    className="nav-row min-h-10 px-2 text-[14px] font-medium"
                  >
                    <span className="nav-icon-box">
                      <ViewIcon name={v.icon} className="size-[17px]" />
                    </span>
                    {v.label}
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function Workspace({ state, initialView, chat }: WorkspaceProps) {
  const [view, setView] = React.useState<ViewId>(initialView);
  const [focusRole, setFocusRole] = React.useState<AgentRoleKey | null>(null);
  const [chatOpen, setChatOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<{ text: string; nonce: number } | null>(null);
  const mainRef = React.useRef<HTMLElement>(null);
  const chatToggleRef = React.useRef<HTMLButtonElement>(null);
  const chatCloseRef = React.useRef<HTMLButtonElement>(null);
  const moved = React.useRef(false);

  const go = React.useCallback((next: ViewId, role?: AgentRoleKey) => {
    moved.current = true;
    setFocusRole(role ?? null);
    setView(next);
    setChatOpen(false);
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

  React.useEffect(() => {
    if (!chatOpen) return;
    chatCloseRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setChatOpen(false);
        chatToggleRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chatOpen]);

  const current = VIEWS.find((v) => v.id === view);
  const label = current?.label ?? "Your business, powered by iAcquireOS";
  const open = state.access === "open";

  return (
    <ShowroomProvider state={state} view={view} go={go} ask={ask} focusRole={focusRole}>
      <JourneyProvider view={view}>
        <div className="demo-stage app-backdrop grain">
          <a href="#demo-main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[80] focus:rounded-xl focus:bg-surface focus:px-4 focus:py-2 focus:text-[14px] focus:text-ink focus:shadow-float">
            Skip to content
          </a>

          <div className="relative z-10 lg:grid lg:grid-cols-[264px_minmax(0,1fr)] 2xl:grid-cols-[264px_minmax(0,1fr)_380px]">
            {/* Navigation rail (large screens): the portal's navy sidebar, with demo labels */}
            <aside aria-label="Demo navigation" className="workspace-nav sx-on-nav sx-scroll hidden lg:sticky lg:top-0 lg:flex lg:h-dvh lg:flex-col lg:overflow-y-auto">
              <div className="flex h-[68px] shrink-0 items-center justify-between px-5">
                <Link href="/demo" aria-label="iAcquire demo home" className="workspace-nav-brand -m-1 inline-flex items-center p-1">
                  <Logo tone="inverse" />
                </Link>
                <span className="rounded-full border border-white/15 bg-white/[.07] px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-[#cdd8ee]">Demo</span>
              </div>
              <div className="mx-4 mb-3 rounded-xl border border-white/10 bg-white/[.035] px-3 py-2.5">
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#91a0ba]">Your demo</p>
                <p className="mt-0.5 break-words text-[14px] font-semibold leading-snug text-white">{state.business?.trim() || `${state.firstName}'s business`}</p>
                {state.industryLabel && <p className="text-[12.5px] text-[#b6c1d4]">{state.industryLabel}</p>}
              </div>
              <div className="mx-4 mb-4">
                <ConsultCta size="md" className="w-full" />
              </div>
              <nav aria-label="Sections" className="min-h-0 flex-1 px-3">
                <NavLinks view={view} go={go} />
              </nav>
              <div className="mt-4 space-y-3 p-4">
                <div className="space-y-3.5 rounded-xl border border-white/10 bg-white/[.035] p-3.5">
                  <WindowClock compact />
                  <MessageMeter compact />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12px] font-medium text-[#91a0ba]">Appearance</span>
                  <ThemeSwitch tone="nav" />
                </div>
              </div>
            </aside>

            <div className="min-w-0">
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
                {/* Tour strip and the persistent consultation action */}
                <div className="z-20 -mx-4 mb-6 bg-gradient-to-b from-[var(--bg)] via-[var(--bg)]/90 to-transparent px-4 pb-3 pt-0 sm:-mx-6 sm:px-6 lg:sticky lg:top-0 lg:-mx-8 lg:px-8 lg:pt-5">
                  <div className="flex flex-wrap items-stretch gap-3">
                    <JourneyBar className="min-w-0 basis-full lg:flex-1 lg:basis-0" />
                    <div className="hidden w-full items-center gap-2 md:flex lg:w-auto">
                      <ConsultCta size="md" className="flex-1 lg:hidden" />
                      <button
                        ref={chatToggleRef}
                        type="button"
                        onClick={() => setChatOpen((o) => !o)}
                        aria-expanded={chatOpen}
                        aria-controls="showroom-chat"
                        className="sx-btn-quiet inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl px-4 text-[14px] font-semibold lg:flex-none 2xl:hidden"
                      >
                        <MessageSquareText className="size-4" aria-hidden />
                        Ask AQi
                      </button>
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

            {/* AQi: docked on very wide screens, a sheet otherwise */}
            {chatOpen && <button type="button" tabIndex={-1} aria-hidden onClick={() => setChatOpen(false)} className="fixed inset-0 z-40 bg-black/35 backdrop-blur-[2px] dark:bg-black/60 2xl:hidden" />}
            <aside
              id="showroom-chat"
              aria-label="AQi demo guide"
              className={cn(
                "fixed inset-y-0 right-0 z-50 flex w-full max-w-[440px] flex-col border-l border-line bg-surface shadow-float transition-[transform,visibility] duration-300 sm:w-[420px]",
                "2xl:sticky 2xl:top-0 2xl:z-10 2xl:h-dvh 2xl:w-auto 2xl:max-w-none 2xl:translate-x-0 2xl:visible 2xl:bg-surface/80 2xl:shadow-none 2xl:backdrop-blur-xl",
                chatOpen ? "visible translate-x-0" : "invisible translate-x-full",
              )}
            >
              <header className="flex items-start gap-3 border-b border-line p-5">
                <span className="brand-gradient grid size-10 shrink-0 place-items-center rounded-xl text-white shadow-glow" aria-hidden>
                  <LogoMark className="size-6" title="AQi" />
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="flex items-center gap-2 text-[16px] font-semibold leading-tight text-ink">
                    {state.aiEnabled ? (
                      <>
                        <span>AQi</span>
                        <span className="rounded-full bg-primary-soft px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary-ink">Demo guide</span>
                      </>
                    ) : ROOM_COPY.chatOffHeading}
                  </h2>
                  <p className="mt-1 text-[12.5px] leading-snug text-muted">{state.aiEnabled ? ROOM_COPY.chatIntro : REFUSAL_COPY.ai_off}</p>
                </div>
                <button ref={chatCloseRef} type="button" onClick={() => { setChatOpen(false); chatToggleRef.current?.focus(); }} className="sx-btn-quiet grid size-10 shrink-0 place-items-center rounded-lg 2xl:hidden" aria-label="Close AQi">
                  <X className="size-4" aria-hidden />
                </button>
              </header>
              <div className="flex min-h-0 flex-1 flex-col p-4">
                {chat.show ? (
                  <DemoChat
                    initial={chat.initial}
                    roles={ROLES}
                    fallbackMessageId={chat.fallbackMessageId}
                    pageNotice={chat.pageNotice}
                    draft={draft}
                    suggestions={SUGGESTIONS[view]}
                    className="min-h-0 flex-1"
                    closedFooter={<ConsultCta size="md" className="w-full" />}
                  />
                ) : (
                  <div className="space-y-3">
                    <DemoNotice notice={chat.pageNotice} />
                    <p role="status" className="rounded-xl border border-line bg-surface-2 px-4 py-3 text-[14px] leading-relaxed text-ink-2">
                      {chat.initial.refusalMessage ?? REFUSAL_COPY.ai_off}
                    </p>
                    <ConsultCta size="md" className="w-full" />
                  </div>
                )}
              </div>
            </aside>
          </div>

          {/* Bottom bar on phones: the consultation action and AQi stay one tap away */}
          {!chatOpen && (
            <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 px-3 py-2.5 backdrop-blur-xl md:hidden">
              <div className="mx-auto flex max-w-xl items-center gap-2">
                <ConsultCta size="md" className="min-w-0 flex-1" />
                <button type="button" onClick={() => setChatOpen(true)} aria-controls="showroom-chat" aria-expanded={chatOpen} className="sx-btn-quiet inline-flex h-11 shrink-0 items-center gap-2 rounded-xl px-4 text-[14px] font-semibold">
                  <MessageSquareText className="size-4" aria-hidden />
                  Ask AQi
                </button>
              </div>
            </div>
          )}

          <ConfirmHost />

          <noscript>
            <style>{`#showroom-chat{position:static!important;visibility:visible!important;transform:none!important;width:auto!important;max-width:none!important;height:auto!important}`}</style>
          </noscript>
        </div>
      </JourneyProvider>
    </ShowroomProvider>
  );
}
