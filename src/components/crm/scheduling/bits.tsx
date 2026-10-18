"use client";

import * as React from "react";
import { CheckCircle2, CircleDashed, UserX, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { STATUS_LABEL, STATUS_TONE } from "@/components/crm/scheduling/format";
import { followDrawerLink, type DrawerLink } from "@/components/crm/scheduling/calendar-math";

/**
 * Rewrites the address bar without a server round trip, so an open appointment can be shared and reloaded. The `null` history state is
 * what Next's docs use: the router then copies its own state into the entry and adopts the new address, so a later refresh (after an
 * action in the drawer, say) loads this address, not the one before it.
 */
export function replaceAddress(url: string) {
  window.history.replaceState(null, "", url);
}

/** The appointment open in a screen's drawer, following links to appointments as they are opened (see followDrawerLink). */
export function useDrawerLink(state: { appointmentId: string | null }): [string | null, (id: string | null) => void] {
  const [link, setLink] = React.useState<DrawerLink>(() => ({ seen: state, openId: state.appointmentId }));
  const next = followDrawerLink(link, state);
  if (next !== link) setLink(next);
  const setOpenId = React.useCallback((openId: string | null) => setLink((l) => ({ ...l, openId })), []);
  return [next.openId, setOpenId];
}

/** The current time, ticking once a step (a minute by default). Zero while rendering on the server, so the first client render matches. */
export function useNow(step = 60_000): number {
  return React.useSyncExternalStore(
    React.useCallback((notify: () => void) => {
      const t = setInterval(notify, step);
      return () => clearInterval(t);
    }, [step]),
    () => Math.floor(Date.now() / step) * step,
    () => 0,
  );
}

const subscribeNever = () => () => {};
/** The device's own time zone, or null while rendering on the server. */
export function useBrowserTimeZone(): string | null {
  return React.useSyncExternalStore(subscribeNever, () => Intl.DateTimeFormat().resolvedOptions().timeZone || null, () => null);
}

/** Keeps the latest value of a callback for effects and handlers without making them re-run when its identity changes. */
export function useLatest<T>(value: T) {
  const ref = React.useRef(value);
  React.useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return <Badge tone={STATUS_TONE[status] ?? "neutral"} className={className}>{STATUS_LABEL[status] ?? status}</Badge>;
}

/** A small icon for statuses that colour alone shouldn't carry. */
export function StatusGlyph({ status, className }: { status: string; className?: string }) {
  const cls = cn("size-3 shrink-0", className);
  if (status === "new") return <CircleDashed className={cls} aria-hidden />;
  if (status === "showed") return <CheckCircle2 className={cls} aria-hidden />;
  if (status === "noshow") return <UserX className={cls} aria-hidden />;
  if (status === "cancelled") return <XCircle className={cls} aria-hidden />;
  return null;
}

export function ColorDot({ color, className }: { color: string; className?: string }) {
  return <i aria-hidden className={cn("inline-block size-2.5 shrink-0 rounded-full", className)} style={{ background: color }} />;
}

/** Tinted chip styles for an appointment's colour and status: unconfirmed is dashed, cancelled is struck through, no-show is muted. */
export function chipStyle(color: string, status: string): { className: string; style: React.CSSProperties } {
  const base = "border border-l-[3px] text-ink";
  if (status === "cancelled") return { className: cn(base, "border-line bg-surface-2 text-muted line-through opacity-70"), style: { borderLeftColor: color } };
  if (status === "noshow") return { className: cn(base, "border-line bg-surface-2 text-ink-2"), style: { borderLeftColor: color } };
  if (status === "new") return { className: cn(base, "border-dashed bg-surface"), style: { borderColor: color, background: `${color}14` } };
  return { className: base, style: { borderColor: `${color}55`, borderLeftColor: color, background: `${color}1f` } };
}
