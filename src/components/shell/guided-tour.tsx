"use client";

import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

const STEPS = [
  { target: "overview", title: "Your command center", body: "Overview shows leads, meetings, approvals and what your AI team is doing — using real data only." },
  { target: "workforce", title: "Meet your AI workforce", body: "Six AI employees, each set up for your business. Click one to chat, or open AI Workforce to configure them." },
  { target: "approvals", title: "You stay in control", body: "Anything that affects customers or your CRM waits here for your approval first." },
  { target: "settings", title: "Make it yours", body: "Invite your team, set AI preferences, and check integration status in Settings." },
  { target: "help", title: "Help is one click away", body: "Ask the iAcquire Assistant anything about the portal, or reach a real person on our team." },
];

const KEY = "iaq-tour-v1";

export function startTour() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
  window.dispatchEvent(new Event("iaq:start-tour"));
}

export function GuidedTour({ autoStart }: { autoStart: boolean }) {
  const [step, setStep] = React.useState<number | null>(null);
  const [rect, setRect] = React.useState<DOMRect | null>(null);

  React.useEffect(() => {
    const start = () => setStep(0);
    window.addEventListener("iaq:start-tour", start);
    let seen = true;
    try {
      seen = localStorage.getItem(KEY) === "done";
    } catch {
      /* storage unavailable */
    }
    const t = autoStart && !seen ? setTimeout(start, 900) : null;
    return () => {
      window.removeEventListener("iaq:start-tour", start);
      if (t) clearTimeout(t);
    };
  }, [autoStart]);

  const finish = React.useCallback(() => {
    setStep(null);
    try {
      localStorage.setItem(KEY, "done");
    } catch {
      /* storage unavailable */
    }
  }, []);

  React.useLayoutEffect(() => {
    if (step === null) return;
    const find = () => {
      const all = Array.from(document.querySelectorAll<HTMLElement>(`[data-tour="${STEPS[step].target}"]`));
      const el = all.find((e) => e.getBoundingClientRect().width > 0);
      setRect(el ? el.getBoundingClientRect() : null);
    };
    find();
    window.addEventListener("resize", find);
    window.addEventListener("scroll", find, true);
    return () => {
      window.removeEventListener("resize", find);
      window.removeEventListener("scroll", find, true);
    };
  }, [step]);

  React.useEffect(() => {
    if (step === null) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && finish();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, finish]);

  if (step === null) return null;
  const s = STEPS[step];
  const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const cardW = Math.min(320, vw - 32);
  let left = vw / 2 - cardW / 2;
  let top = vh / 2 - 90;
  if (rect) {
    const rightSpace = vw - rect.right;
    if (rightSpace > cardW + 24) {
      left = rect.right + 14;
      top = Math.min(Math.max(16, rect.top - 8), vh - 220);
    } else {
      left = Math.min(Math.max(16, rect.right - cardW), vw - cardW - 16);
      top = rect.top > 240 ? rect.top - 196 : rect.bottom + 14;
    }
  }

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-[70]" role="dialog" aria-modal="true" aria-labelledby="tour-title">
        <div className={rect ? "absolute inset-0" : "absolute inset-0 bg-black/45"} onClick={finish} aria-hidden />
        {rect && (
          <motion.div
            className="pointer-events-none absolute rounded-xl ring-2 ring-primary"
            style={{ boxShadow: "0 0 0 9999px rgba(5, 8, 20, 0.5)" }}
            initial={{ left: rect.left - 4, top: rect.top - 4, width: rect.width + 8, height: rect.height + 8, opacity: 0 }}
            animate={{ left: rect.left - 4, top: rect.top - 4, width: rect.width + 8, height: rect.height + 8, opacity: 1 }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
          />
        )}
        <motion.div
          key={step}
          className="absolute rounded-2xl border border-line bg-surface p-4 shadow-float"
          style={{ left, top, width: cardW }}
          initial={{ opacity: 0, y: 8, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ type: "spring", stiffness: 420, damping: 32 }}
        >
          <div className="flex items-start justify-between gap-3">
            <p className="text-[11.5px] font-medium uppercase tracking-wider text-primary">
              Step {step + 1} of {STEPS.length}
            </p>
            <button type="button" onClick={finish} className="-mr-1 -mt-1 rounded-lg p-1 text-muted hover:bg-surface-2" aria-label="Skip tour">
              <X className="size-4" />
            </button>
          </div>
          <h2 id="tour-title" className="mt-1 text-[15px] font-semibold text-ink">
            {s.title}
          </h2>
          <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted">{s.body}</p>
          <div className="mt-4 flex items-center justify-between">
            <div className="flex gap-1">
              {STEPS.map((_, i) => (
                <span key={i} className={`h-1.5 rounded-full transition-all ${i === step ? "w-4 bg-primary" : "w-1.5 bg-surface-3"}`} />
              ))}
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={finish}>
                Skip
              </Button>
              <Button size="sm" variant="brand" onClick={() => (step + 1 < STEPS.length ? setStep(step + 1) : finish())} autoFocus>
                {step + 1 < STEPS.length ? "Next" : "Done"}
              </Button>
            </div>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
