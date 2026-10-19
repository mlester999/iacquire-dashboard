"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { ArrowRight, Sparkles, X } from "lucide-react";
import { currentGuidance, setOnboardingVisible, startTutorial, useGuidance } from "@/components/aqi/tutorial/tutorial-store";
import type { AqiTutorialSummary } from "@/lib/aqi/tutorials";

interface OnboardingView {
  recommended: AqiTutorialSummary | null;
  shouldOffer: boolean;
  reason: string;
}

/**
 * Optional first-time guidance. The server decides eligibility from the person's real permissions,
 * and every choice is remembered server-side. It never auto-starts a walkthrough and never returns
 * after "Don't show again".
 */
export function OnboardingNudge() {
  const pathname = usePathname();
  const state = useGuidance();
  const [view, setView] = React.useState<OnboardingView | null>(null);
  const [busy, setBusy] = React.useState(false);
  const timer = React.useRef<number | null>(null);

  React.useEffect(() => {
    const path = pathname ?? "/";
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(`/api/aqi/onboarding?path=${encodeURIComponent(path)}`, { cache: "no-store" });
          if (!res.ok) return;
          const data = (await res.json()) as OnboardingView;
          if (!data.shouldOffer || !data.recommended) return;
          // Re-check the live store: a walkthrough may have started while this request was in flight.
          const live = currentGuidance();
          if (live.open || live.resume) return;
          setView(data);
        } catch {
          // Optional guidance failing is never an error the person needs to see.
        }
      })();
    }, 1800);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [pathname]);

  React.useEffect(() => {
    setOnboardingVisible(Boolean(view?.shouldOffer));
    return () => setOnboardingVisible(false);
  }, [view?.shouldOffer]);

  if (!view?.recommended || !view.shouldOffer || state.open || state.resume) return null;
  const tutorial = view.recommended;

  async function act(action: "start" | "defer" | "dismiss") {
    if (busy) return;
    setBusy(true);
    try {
      await fetch("/api/aqi/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
    } catch {
      // The preference may not save; the card still closes so it never traps the page.
    }
    setView((current) => (current ? { ...current, shouldOffer: false } : current));
    setOnboardingVisible(false);
    setBusy(false);
    if (action === "start") await startTutorial(tutorial.slug, "onboarding");
  }

  return (
    <div
      className="fixed z-40 w-[min(348px,calc(100vw-24px))] rounded-2xl border border-line bg-surface p-3.5 shadow-float"
      style={{ right: "max(12px, env(safe-area-inset-right))", bottom: "calc(max(14px, env(safe-area-inset-bottom)) + 70px)" }}
      role="dialog"
      aria-labelledby="aqi-welcome-title"
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl brand-gradient text-white"><Sparkles className="size-4" /></span>
        <div className="min-w-0 flex-1">
          <p id="aqi-welcome-title" className="text-[13px] font-semibold tracking-tight text-ink">Welcome to iAcquireOS</p>
          <p className="mt-0.5 text-[12px] leading-relaxed text-muted">Want a quick tour? AQi can show you the workspace, your AI team and where to get help.</p>
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <button type="button" disabled={busy} onClick={() => void act("start")} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-2.5 text-[11.5px] font-semibold text-white hover:bg-primary/90 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
              Start tour <ArrowRight className="size-3" />
            </button>
            <button type="button" disabled={busy} onClick={() => void act("defer")} className="inline-flex h-8 items-center rounded-lg px-2 text-[11px] font-medium text-muted hover:bg-surface-2 hover:text-ink disabled:opacity-60">Maybe later</button>
            <button type="button" disabled={busy} onClick={() => void act("dismiss")} className="inline-flex h-8 items-center rounded-lg px-2 text-[10.5px] font-medium text-faint hover:bg-surface-2 hover:text-muted disabled:opacity-60">Don&apos;t show again</button>
          </div>
        </div>
        <button type="button" disabled={busy} onClick={() => void act("defer")} aria-label="Postpone the tour" className="-mr-1 -mt-1 flex size-7 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink"><X className="size-3.5" /></button>
      </div>
    </div>
  );
}
