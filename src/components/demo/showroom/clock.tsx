"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Hourglass, MessageSquareText } from "lucide-react";
import { cn } from "@/lib/utils";
import { LocalTime } from "@/components/demo/local-time";
import { REFUSAL_COPY } from "@/lib/demo/rules";
import { useShowroom } from "@/components/demo/showroom/context";

// The two live numbers of a demo: how long the window has left, and how many AI messages. The server's record is the only authority for both: this page draws a countdown toward the
// end time the server gave, and when it reaches zero it asks the server again (a refresh) instead of deciding by itself that the demo is over. Until the page is live it shows the end
// time in UTC, the same text on the server and in the first browser render, so nothing mismatches.

const DAY_MS = 24 * 60 * 60 * 1000;

/** Milliseconds left, ticking; null until the page is live. */
function useMsLeft(endsAt: string | null, active: boolean): number | null {
  const router = useRouter();
  const [ms, setMs] = React.useState<number | null>(null);
  const refreshed = React.useRef(false);
  React.useEffect(() => {
    if (!endsAt || !active) return;
    const end = new Date(endsAt).getTime();
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const left = end - Date.now();
      setMs(Math.max(0, left));
      if (left <= 0) {
        if (!refreshed.current) {
          refreshed.current = true;
          router.refresh();
        }
        return;
      }
      timer = setTimeout(tick, left < 3_600_000 ? 1000 : 15_000);
    };
    timer = setTimeout(tick, 0);
    return () => clearTimeout(timer);
  }, [endsAt, active, router]);
  return endsAt && active ? ms : null;
}

export function formatLeft(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

/** The demo window: a countdown while it is open, and what happened when it is not. */
export function WindowClock({ className, compact = false }: { className?: string; compact?: boolean }) {
  const { access, windowEndsAt, extended } = useShowroom();
  const open = access === "open";
  const ms = useMsLeft(windowEndsAt, open);
  const share = ms === null ? 1 : Math.min(1, ms / DAY_MS);
  if (!open) {
    return (
      <div className={cn("flex items-start gap-2", className)}>
        <Hourglass className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
        <p className="text-[13px] leading-snug text-ink-2">
          <span className="block font-semibold text-ink">Interactive window ended</span>
          {windowEndsAt ? (
            <>
              Ended <LocalTime iso={windowEndsAt} />
            </>
          ) : null}
        </p>
      </div>
    );
  }
  return (
    <div className={cn("space-y-2", className)}>
      <p className="text-[12px] font-semibold uppercase tracking-[0.1em] text-muted">Demo window{extended ? " · Extended" : ""}</p>
      <p className="whitespace-nowrap" aria-hidden>
        <span className="text-[24px] font-semibold tabular-nums tracking-[-0.02em] text-ink">{ms === null ? "Open" : formatLeft(ms)}</span>
        {ms !== null && <span className="ml-1.5 text-[13px] font-medium text-muted">left</span>}
      </p>
      <div className="sx-track" aria-hidden>
        <span style={{ width: `${share * 100}%` }} />
      </div>
      {!compact && (
        <p className="text-[13px] leading-snug text-muted">
          Your demo is open until {windowEndsAt ? <LocalTime iso={windowEndsAt} /> : "the end of your window"}.
        </p>
      )}
      {compact && windowEndsAt && <span className="sr-only">Your demo is open until <LocalTime iso={windowEndsAt} />.</span>}
    </div>
  );
}

/** How many AI messages are left: ten pips, filled for the ones that remain. Navigation and the simulations never use one. */
export function MessageMeter({ left: leftOverride, className, compact = false }: { left?: number; className?: string; compact?: boolean }) {
  const { messagesLeft, messageAllowance, aiEnabled, access } = useShowroom();
  const left = leftOverride ?? messagesLeft;
  if (access !== "open") {
    return (
      <p className={cn("flex items-start gap-2 text-[13px] leading-snug text-muted", className)}>
        <MessageSquareText className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>
          <span className="block font-semibold text-ink">AI chat closed</span>
          Your conversation stays readable.
        </span>
      </p>
    );
  }
  if (!aiEnabled) {
    return (
      <p className={cn("flex items-start gap-2 text-[13px] leading-snug text-muted", className)}>
        <MessageSquareText className="mt-0.5 size-4 shrink-0" aria-hidden />
        {REFUSAL_COPY.ai_off}
      </p>
    );
  }
  const pips = Math.min(messageAllowance, 20);
  return (
    <div className={cn("space-y-2", className)}>
      <p className="text-[12px] font-semibold uppercase tracking-[0.1em] text-muted">AI messages</p>
      <p className="whitespace-nowrap">
        <span className="text-[24px] font-semibold tabular-nums tracking-[-0.02em] text-ink">{left}</span>
        <span className="ml-1.5 text-[13px] font-medium text-muted">of {messageAllowance} left</span>
      </p>
      <div className="flex gap-1" aria-hidden>
        {Array.from({ length: pips }, (_, i) => (
          <span key={i} className={cn("h-1.5 flex-1 rounded-full", i < left ? "bg-gradient-to-r from-primary to-violet" : "bg-surface-3")} />
        ))}
      </div>
      {!compact && <p className="sr-only">You have {left} of {messageAllowance} messages left.</p>}
    </div>
  );
}
