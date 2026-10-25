"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { ArrowRight, Lightbulb } from "lucide-react";
import { GuidanceCard, GuidanceCloseButton, GuidanceGhostButton, GuidancePrimaryButton, GuidanceQuietButton } from "@/components/aqi/tutorial/guidance-card";
import { setTipVisible, startTutorial, useAqiPanelOpen, useGuidance } from "@/components/aqi/tutorial/tutorial-store";

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
  const panelOpen = useAqiPanelOpen();
  const [tip, setTip] = React.useState<TipResponse["tip"]>(null);
  const [busy, setBusy] = React.useState(false);
  const timer = React.useRef<number | null>(null);
  const blocked = state.open || Boolean(state.resume) || state.onboardingVisible || panelOpen || state.phase === "starting";

  React.useEffect(() => {
    if (blocked) return;
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
  }, [pathname, blocked]);

  React.useEffect(() => {
    if (!tip) return;
    const hide = window.setTimeout(() => {
      setTip(null);
      setTipVisible(false);
    }, 22_000);
    return () => window.clearTimeout(hide);
  }, [tip]);

  React.useEffect(() => () => setTipVisible(false), []);

  if (!tip || blocked) return null;

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
    const slug = tip.tutorialSlug;
    const tipSlug = tip.slug;
    setTip(null);
    setTipVisible(false);
    // The click is analytics only; the walkthrough does not wait for it.
    void fetch("/api/aqi/tips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "click", slug: tipSlug, pathname }),
    }).catch(() => undefined);
    await startTutorial(slug, "tip");
    setBusy(false);
  }

  return (
    <GuidanceCard role="status" live="polite" tone="soft" icon={<Lightbulb className="size-[18px]" aria-hidden />}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-[14px] font-semibold leading-snug tracking-tight text-ink">{tip.title}</p>
        <GuidanceCloseButton label="Dismiss this tip" onClick={() => void dismiss()} />
      </div>
      <p className="mt-1 text-[14px] leading-relaxed text-muted">{tip.body}</p>
      <div className="mt-3 flex items-center gap-1.5">
        {tip.tutorialSlug && (
          <GuidancePrimaryButton disabled={busy} onClick={() => void start()}>
            Show me <ArrowRight className="size-3.5" aria-hidden />
          </GuidancePrimaryButton>
        )}
        <GuidanceGhostButton onClick={() => setTip(null)}>Not now</GuidanceGhostButton>
      </div>
      <div className="mt-2 border-t border-line pt-1.5">
        <GuidanceQuietButton disabled={busy} onClick={() => void disable()}>Turn off tips</GuidanceQuietButton>
      </div>
    </GuidanceCard>
  );
}
