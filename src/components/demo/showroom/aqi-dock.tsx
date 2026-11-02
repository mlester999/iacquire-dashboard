"use client";

import * as React from "react";
import { Sparkles, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { LogoMark } from "@/components/brand";
import { DemoChat } from "@/components/demo/chat";
import { DemoNotice } from "@/components/demo/shell";
import { ROOM_COPY, type Notice } from "@/lib/demo/outcomes";
import { REFUSAL_COPY } from "@/lib/demo/rules";
import type { RoomChatState } from "@/lib/demo/room-types";
import { useShowroom } from "@/components/demo/showroom/context";
import { ConsultCta } from "@/components/demo/showroom/cta";
import { SHEET_QUERY, useKeyboardBox, useMediaQuery } from "@/components/demo/showroom/use-media";

// AQi, the demo's guide. Where it lives depends on the screen, so it never sits on top of what a visitor is reading or pressing:
//   * below `lg` (phones and tablets) there is nothing floating over the page: a bottom bar holds the consultation action and, beside it, a compact AQi button. The page keeps room under its
//     last line for the bar, and the bar keeps clear of the home indicator (safe-area inset). The panel opens as a sheet over the whole page on a phone (a modal dialog: the page behind is
//     inert, Escape and the backdrop close it, focus goes into the question box and comes back to the button, the sheet rides above the keyboard) and as a corner panel above the bar on a tablet.
//   * from `lg` (laptops and desktops) AQi is the floating button in the bottom-right corner, as in the portal, and the panel opens above it.
// The panel is kept in the page while it is closed (only hidden), so what was typed, the conversation and a message still on its way are all still there when it opens again, and closing it
// is never a way to lose a question. It adds nothing the chat did not already do: it uses the same endpoint, the same ten messages and the same key handling.

export interface AqiDockProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chat: { initial: RoomChatState; fallbackMessageId: string; pageNotice: Notice | null; show: boolean };
  roles: ReadonlyArray<{ key: string; name: string }>;
  /** A question to put in the box (not send). A new `nonce` puts it there again. */
  draft: { text: string; nonce: number } | null;
  suggestions: readonly string[];
  /** What sits beside the AQi button in the bottom bar below `lg`: the consultation action. */
  bar: React.ReactNode;
}

const noSubscribe = () => () => {};

export function AqiDock({ open, onOpenChange, chat, roles, draft, suggestions, bar }: AqiDockProps) {
  const { aiEnabled, ended, messagesLeft, messageAllowance, reportChat } = useShowroom();
  const launcherRef = React.useRef<HTMLButtonElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const closeRef = React.useRef<HTMLButtonElement>(null);
  const wasOpen = React.useRef(open);
  // Hidden from assistive technology and from the keyboard only once the page is live: without scripts the panel is drawn on the page and must stay usable.
  const live = React.useSyncExternalStore(noSubscribe, () => true, () => false);
  const isSheet = useMediaQuery(SHEET_QUERY);
  const sheetOpen = open && isSheet;
  const keyboard = useKeyboardBox(sheetOpen);

  // Focus follows the panel: into the question box when it opens (or onto the close button when there is no box), and back to the button when it closes. The short wait lets the panel
  // become visible first, since a hidden element cannot take focus. Only a change of `open` moves focus, never the page loading (React runs an effect twice on mount while developing).
  React.useEffect(() => {
    if (wasOpen.current === open) return;
    wasOpen.current = open;
    const t = window.setTimeout(() => {
      if (open) (panelRef.current?.querySelector<HTMLElement>("#demo-message") ?? closeRef.current)?.focus({ preventScroll: true });
      else launcherRef.current?.focus({ preventScroll: true });
    }, 60);
    return () => window.clearTimeout(t);
  }, [open]);

  const answering = aiEnabled && !ended;
  const kb = keyboard ? ({ "--aqi-kb-bottom": `${keyboard.bottom}px`, "--aqi-kb-height": `${keyboard.height}px` } as React.CSSProperties) : undefined;
  return (
    <>
      {/* The bottom bar below lg, and the corner at lg and up. One element in both places, so there is never a second AQi button. */}
      <div
        data-dock-bar
        inert={sheetOpen}
        className={cn(
          "fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 pb-[max(0.5rem,env(safe-area-inset-bottom))] pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] pt-2 backdrop-blur-xl",
          "lg:inset-x-auto lg:bottom-4 lg:right-4 lg:border-0 lg:bg-transparent lg:p-0 lg:backdrop-blur-none",
        )}
      >
        <div className="mx-auto flex max-w-xl items-center gap-2 lg:contents">
          <div className="min-w-0 flex-1 lg:hidden">{bar}</div>
          {/* The button's name begins with the words drawn on it ("AQi", "9 left"), so a visitor who speaks to their device can press it by what they see; the fuller sentence is its title. */}
          <button
            ref={launcherRef}
            id="aqi-launcher"
            type="button"
            onClick={() => onOpenChange(true)}
            aria-expanded={open}
            aria-controls="showroom-chat"
            aria-label={answering ? `Open AQi, ${messagesLeft} left` : "Open AQi"}
            title={answering ? `Open AQi, the demo guide. ${messagesLeft} of ${messageAllowance} messages left.` : "Open AQi, the demo guide."}
            className={cn(
              "brand-gradient relative inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl px-2.5 text-white ring-1 ring-white/20 transition-[opacity,transform,visibility] duration-200 ease-out motion-reduce:transition-none sm:px-3.5",
              "lg:h-14 lg:rounded-2xl lg:shadow-[0_14px_40px_-10px_rgba(44,91,255,0.65)] lg:hover:-translate-y-0.5",
              open && "pointer-events-none invisible scale-75 opacity-0",
            )}
          >
            <span aria-hidden className="grid size-8 place-items-center rounded-lg bg-white/15 lg:rounded-xl">
              <Sparkles className="size-4" />
            </span>
            <span aria-hidden className="hidden text-[14px] font-semibold tracking-tight sm:inline">
              AQi
            </span>{" "}
            {answering && (
              <span
                aria-hidden
                className="absolute -right-1 -top-1.5 grid h-5 min-w-5 place-items-center rounded-full bg-ink px-1 text-[12px] font-bold leading-none tabular-nums text-surface ring-2 ring-surface sm:static sm:h-auto sm:min-w-0 sm:bg-white/20 sm:px-2 sm:py-0.5 sm:font-semibold sm:text-white sm:ring-0"
              >
                {messagesLeft}
                <span className="hidden sm:inline"> left</span>
              </span>
            )}
          </button>
        </div>
      </div>

      {sheetOpen && <button type="button" tabIndex={-1} aria-hidden data-overlay-backdrop onClick={() => onOpenChange(false)} className="sx-fade fixed inset-0 z-40 bg-black/35 backdrop-blur-[2px] dark:bg-black/60" />}

      <div
        ref={panelRef}
        id="showroom-chat"
        role={sheetOpen ? "dialog" : "complementary"}
        aria-modal={sheetOpen ? true : undefined}
        aria-label="AQi demo guide"
        aria-hidden={live && !open ? true : undefined}
        inert={live && !open}
        data-open={open}
        style={kb}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onOpenChange(false);
          }
        }}
        className={cn(
          "fixed z-50 flex flex-col overflow-hidden border border-line bg-surface shadow-float",
          // A phone: a sheet over the whole page, above the keyboard when there is one.
          "inset-x-0 bottom-[var(--aqi-kb-bottom,0px)] h-[min(92dvh,calc(var(--aqi-kb-height,100dvh)-0.5rem))] rounded-t-3xl",
          // A tablet: a panel in the corner, above the bottom bar so it never covers the consultation action.
          "sm:inset-auto sm:bottom-[calc(4.75rem+env(safe-area-inset-bottom))] sm:right-5 sm:h-[min(680px,calc(100dvh-6rem))] sm:w-[410px] sm:rounded-3xl",
          // A laptop or desktop: the corner, above the AQi button.
          "lg:bottom-5 lg:h-[min(680px,calc(100dvh-40px))]",
          "origin-bottom-right transition-[opacity,transform,visibility] duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none",
          open ? "visible translate-y-0 scale-100 opacity-100" : "pointer-events-none invisible opacity-0 max-sm:translate-y-full sm:translate-y-5 sm:scale-95",
        )}
      >
        <header className="relative shrink-0 overflow-hidden border-b border-line">
          <div
            aria-hidden
            className="absolute inset-0 opacity-90"
            style={{ background: "radial-gradient(420px 170px at 0% 0%, color-mix(in srgb, var(--primary) 16%, transparent), transparent 70%), radial-gradient(320px 160px at 100% 0%, color-mix(in srgb, var(--violet) 14%, transparent), transparent 70%)" }}
          />
          <div className="relative flex items-start gap-3 p-4 [@media(max-height:500px)]:gap-2.5 [@media(max-height:500px)]:p-2.5">
            <span className="brand-gradient grid size-10 shrink-0 place-items-center rounded-xl text-white shadow-glow [@media(max-height:500px)]:size-8" aria-hidden>
              <LogoMark className="size-6" title="AQi" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="flex items-center gap-2 text-[16px] font-semibold leading-tight text-ink">
                {aiEnabled ? (
                  <>
                    <span>AQi</span>
                    <span className="rounded-full bg-primary-soft px-2 py-0.5 text-[12px] font-semibold uppercase tracking-wide text-primary-ink">Demo guide</span>
                  </>
                ) : (
                  ROOM_COPY.chatOffHeading
                )}
              </h2>
              {/* While a phone's keyboard is up there is room for the question box and little else: the plain-words limits are hidden only then, and are back when the keyboard goes down. */}
              <p className={cn("mt-1 text-[12.5px] leading-snug text-muted [@media(max-height:500px)]:hidden", keyboard && "hidden")}>{aiEnabled ? ROOM_COPY.chatIntro : REFUSAL_COPY.ai_off}</p>
            </div>
            <button
              ref={closeRef}
              type="button"
              onClick={() => onOpenChange(false)}
              className="sx-btn-quiet grid size-11 shrink-0 place-items-center rounded-xl sm:size-9"
              aria-label="Close AQi"
              title="Close AQi: your chat stays here"
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain p-4 pb-[max(1rem,env(safe-area-inset-bottom))] [@media(max-height:500px)]:p-2.5 [@media(max-height:500px)]:pb-[max(0.625rem,env(safe-area-inset-bottom))]">
          {chat.show ? (
            <DemoChat
              initial={chat.initial}
              roles={roles}
              fallbackMessageId={chat.fallbackMessageId}
              pageNotice={chat.pageNotice}
              draft={draft}
              suggestions={suggestions}
              onRecord={reportChat}
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
      </div>
    </>
  );
}
