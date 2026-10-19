"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The shared shell for the quiet prompts that sit beside the AQi launcher: the first-run welcome,
 * contextual tips and the paused-walkthrough reminder. It is anchored to the launcher's real position
 * (the launcher publishes it as CSS variables, including the raised position on chat pages), keeps a
 * clear gap above it, never exceeds the viewport, and enters with a short fade that reduced-motion
 * settings remove.
 */
export function GuidanceCard({
  role = "status",
  label,
  labelledBy,
  live,
  tone = "brand",
  icon,
  className,
  children,
  ...rest
}: {
  role?: "dialog" | "status";
  label?: string;
  labelledBy?: string;
  live?: "polite" | "off";
  tone?: "brand" | "soft";
  icon: React.ReactNode;
  className?: string;
  children: React.ReactNode;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "role" | "children">) {
  return (
    <div
      {...rest}
      role={role}
      aria-label={label}
      aria-labelledby={labelledBy}
      aria-live={live}
      data-aqi-nudge
      className={cn(
        "aqi-nudge fixed z-40 w-[min(340px,calc(100vw-24px))] rounded-2xl border border-line bg-surface p-4 shadow-float",
        className,
      )}
      style={{
        right: "var(--aqi-launcher-right)",
        // Launcher height (3.5rem) plus a 14px gap, measured from the launcher's own bottom offset.
        bottom: "calc(var(--aqi-launcher-bottom) + 3.5rem + 14px)",
        maxHeight: "calc(100dvh - var(--aqi-launcher-bottom) - 3.5rem - 28px)",
      }}
    >
      <span
        aria-hidden
        className="absolute -bottom-[6px] right-[38px] size-3 rotate-45 border-b border-r border-line bg-surface"
      />
      <div className="flex items-start gap-3">
        <span className={cn("mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl", tone === "brand" ? "brand-gradient text-white" : "bg-primary-soft text-primary")}>{icon}</span>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}

const PRIMARY_BUTTON = "inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-primary px-3.5 text-[12.5px] font-semibold text-primary-on transition-colors hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-60";
const GHOST_BUTTON = "inline-flex h-9 items-center justify-center rounded-lg px-3 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-60";

export function GuidancePrimaryButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...props} className={cn(PRIMARY_BUTTON, props.className)} />;
}

export function GuidanceGhostButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...props} className={cn(GHOST_BUTTON, props.className)} />;
}

export function GuidanceQuietButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className={cn("inline-flex h-8 items-center rounded-lg px-1 text-[11.5px] font-medium text-muted underline-offset-2 transition-colors hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-60", props.className)}
    />
  );
}

export function GuidanceCloseButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="-mr-1.5 -mt-1.5 flex size-8 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-60"
    >
      <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
        <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
      </svg>
    </button>
  );
}
