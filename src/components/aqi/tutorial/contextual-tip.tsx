"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { ArrowRight, Lightbulb, X } from "lucide-react";
import { setTipVisible, startTutorial, useGuidance } from "@/components/aqi/tutorial/tutorial-store";

interface TipResponse {
  tip: { id: string; slug: string; title: string; body: string; tutorialSlug: string | null; tutorialTitle: string | null } | null;
  tipsEnabled: boolean;
  reason: string;
}

const seenPaths = new Set<string>();

/**
 * One configured, permission-matched tip per page visit. No AI call is made, nothing is stored in
 * browser storage, and a tip can be dismissed for good or switched off entirely.
 */
export function ContextualTip() {
  const pathname = usePathname();
  const state = useGuidance();
  const [tip, setTip] = React.useState<TipResponse["tip"]>(null);
  const [busy, setBusy] = React.useState(false);
  const timer = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (state.open || state.resume || state.onboardingVisible) return;
    const path = pathname ?? "/";
    if (seenPaths.has(path)) return;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(`/api/aqi/tips?path=${encodeURIComponent(path)}`, { cache: "no-store" });
          if (!res.ok) return;
          const data = (await res.json()) as TipResponse;
          seenPaths.add(path);
          if (!data.tipsEnabled || !data.tip) return;
          setTip(data.tip);
          setTipVisible(true);
        } catch {
          // A tip is optional; failure is silent.
        }
      })();
    }, 3000);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [pathname, state.open, state.resume, state.onboardingVisible]);

  React.useEffect(() => {
    if (!tip) return;
    const hide = window.setTimeout(() => {
      setTip(null);
      setTipVisible(false);
    }, 22_000);
    return () => window.clearTimeout(hide);
  }, [tip]);

  React.useEffect(() => () => setTipVisible(false), []);

  if (!tip || state.open || state.resume || state.onboardingVisible) return null;

  async function dismiss() {
    setTip(null);
    setTipVisible(false);
    if (!tip) return;
    try {
      await fetch("/api/aqi/tips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "dismiss", slug: tip.slug }),
      });
    } catch {
      // The card is already closed; the preference can be retried next time.
    }
  }

  async function disable() {
    setBusy(true);
    setTip(null);
    setTipVisible(false);
    try {
      await fetch("/api/aqi/tips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "enable", enabled: false }),
      });
    } catch {
      // Ignore; the next page load reflects the stored preference.
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    if (!tip?.tutorialSlug || busy) return;
    setBusy(true);
    try {
      await fetch("/api/aqi/tips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "click", slug: tip.slug, pathname }),
      });
    } catch {
      // Analytics only.
    }
    setTip(null);
    setTipVisible(false);
    setBusy(false);
    await startTutorial(tip.tutorialSlug, "tip");
  }

  return (
    <div
      className="fixed z-40 w-[min(344px,calc(100vw-24px))] rounded-2xl border border-line bg-surface p-3.5 shadow-float"
      style={{ right: "max(12px, env(safe-area-inset-right))", bottom: "calc(max(14px, env(safe-area-inset-bottom)) + 70px)" }}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary"><Lightbulb className="size-4" /></span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold tracking-tight text-ink">{tip.title}</p>
          <p className="mt-0.5 text-[12px] leading-relaxed text-muted">{tip.body}</p>
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {tip.tutorialSlug && (
              <button type="button" disabled={busy} onClick={() => void start()} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-2.5 text-[11.5px] font-semibold text-white hover:bg-primary/90 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
                Show me <ArrowRight className="size-3" />
              </button>
            )}
            <button type="button" onClick={() => setTip(null)} className="inline-flex h-8 items-center rounded-lg px-2 text-[11px] font-medium text-muted hover:bg-surface-2 hover:text-ink">Not now</button>
            <button type="button" disabled={busy} onClick={() => void disable()} className="inline-flex h-8 items-center rounded-lg px-2 text-[10.5px] font-medium text-faint hover:bg-surface-2 hover:text-muted disabled:opacity-60">Turn off tips</button>
          </div>
        </div>
        <button type="button" onClick={() => void dismiss()} aria-label="Dismiss this tip" className="-mr-1 -mt-1 flex size-7 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink"><X className="size-3.5" /></button>
      </div>
    </div>
  );
}
