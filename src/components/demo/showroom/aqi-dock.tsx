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

// AQi, the demo's guide, as the real portal's assistant is: a floating button in the bottom-right corner that opens a panel over the page, and a close button that tucks it away again.
// The panel is kept in the page while it is closed (only hidden), so what was typed, the conversation and a message still on its way are all still there when it opens again, and
// closing it is never a way to lose a question. It adds nothing the chat did not already do: it uses the same endpoint, the same ten messages and the same key handling.

export interface AqiDockProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chat: { initial: RoomChatState; fallbackMessageId: string; pageNotice: Notice | null; show: boolean };
  roles: ReadonlyArray<{ key: string; name: string }>;
  /** A question to put in the box (not send). A new `nonce` puts it there again. */
  draft: { text: string; nonce: number } | null;
  suggestions: readonly string[];
}

const noSubscribe = () => () => {};

export function AqiDock({ open, onOpenChange, chat, roles, draft, suggestions }: AqiDockProps) {
  const { aiEnabled, ended, messagesLeft, messageAllowance, reportChat } = useShowroom();
  const launcherRef = React.useRef<HTMLButtonElement>(null);
  const panelRef = React.useRef<HTMLElement>(null);
  const closeRef = React.useRef<HTMLButtonElement>(null);
  const wasOpen = React.useRef(open);
  // Hidden from assistive technology and from the keyboard only once the page is live: without scripts the panel is drawn on the page and must stay usable.
  const live = React.useSyncExternalStore(noSubscribe, () => true, () => false);

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
  return (
    <>
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
          "fixed bottom-4 right-4 z-40 flex h-14 items-center gap-2 rounded-2xl px-3.5 text-white ring-1 ring-white/20 max-md:bottom-[76px]",
          "brand-gradient shadow-[0_14px_40px_-10px_rgba(44,91,255,0.65)] transition-[opacity,transform,visibility] duration-200 ease-out hover:-translate-y-0.5 motion-reduce:transition-none",
          open && "pointer-events-none invisible scale-75 opacity-0",
        )}
      >
        <span aria-hidden className="grid size-8 place-items-center rounded-xl bg-white/15">
          <Sparkles className="size-4" />
        </span>
        <span aria-hidden className="text-[14px] font-semibold tracking-tight">
          AQi
        </span>{" "}
        {answering && (
          <span aria-hidden className="rounded-full bg-white/20 px-2 py-0.5 text-[12px] font-semibold tabular-nums">
            {messagesLeft} left
          </span>
        )}
      </button>

      {open && <button type="button" tabIndex={-1} aria-hidden onClick={() => onOpenChange(false)} className="sx-fade fixed inset-0 z-40 bg-black/35 backdrop-blur-[2px] sm:hidden dark:bg-black/60" />}

      <aside
        ref={panelRef}
        id="showroom-chat"
        aria-label="AQi demo guide"
        aria-hidden={live && !open ? true : undefined}
        inert={live && !open}
        data-open={open}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onOpenChange(false);
          }
        }}
        className={cn(
          "fixed z-50 flex flex-col overflow-hidden border border-line bg-surface shadow-float",
          "inset-x-0 bottom-0 h-[92dvh] rounded-t-3xl sm:inset-auto sm:bottom-5 sm:right-5 sm:h-[min(680px,calc(100dvh-40px))] sm:w-[410px] sm:rounded-3xl",
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
          <div className="relative flex items-start gap-3 p-4">
            <span className="brand-gradient grid size-10 shrink-0 place-items-center rounded-xl text-white shadow-glow" aria-hidden>
              <LogoMark className="size-6" title="AQi" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="flex items-center gap-2 text-[16px] font-semibold leading-tight text-ink">
                {aiEnabled ? (
                  <>
                    <span>AQi</span>
                    <span className="rounded-full bg-primary-soft px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary-ink">Demo guide</span>
                  </>
                ) : (
                  ROOM_COPY.chatOffHeading
                )}
              </h2>
              <p className="mt-1 text-[12.5px] leading-snug text-muted">{aiEnabled ? ROOM_COPY.chatIntro : REFUSAL_COPY.ai_off}</p>
            </div>
            <button
              ref={closeRef}
              type="button"
              onClick={() => onOpenChange(false)}
              className="sx-btn-quiet grid size-9 shrink-0 place-items-center rounded-xl"
              aria-label="Close AQi"
              title="Close AQi: your chat stays here"
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>
        </header>
        <div className="flex min-h-0 flex-1 flex-col p-4">
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
      </aside>
    </>
  );
}
