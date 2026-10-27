"use client";

import * as React from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTheme, type ThemePreference } from "@/components/providers";

// The portal's own theme control (the shared ThemeProvider and the one `iaq-theme` preference), so the demo and the signed-in product never disagree about light, dark or system.
// The provider reads the saved choice after it hydrates; until then the pressed state is not drawn, so the server and the first browser render are the same markup.

const OPTIONS: Array<{ v: ThemePreference; label: string; icon: typeof Sun }> = [
  { v: "light", label: "Light", icon: Sun },
  { v: "dark", label: "Dark", icon: Moon },
  { v: "system", label: "System", icon: Monitor },
];

const noSubscribe = () => () => {};

export function ThemeSwitch({ className, tone = "surface" }: { className?: string; tone?: "surface" | "nav" }) {
  const { theme, setTheme } = useTheme();
  const live = React.useSyncExternalStore(noSubscribe, () => true, () => false);
  return (
    <div role="group" aria-label="Colour theme" className={cn("inline-flex rounded-xl p-0.5", tone === "nav" ? "bg-white/[.06]" : "border border-line bg-surface-2", className)}>
      {OPTIONS.map((o) => {
        const on = live && theme === o.v;
        return (
          <button
            key={o.v}
            type="button"
            onClick={() => setTheme(o.v)}
            aria-pressed={live ? on : undefined}
            title={`${o.label} theme`}
            className={cn(
              "inline-flex size-9 items-center justify-center rounded-[10px] transition-colors",
              tone === "nav" ? (on ? "bg-white/15 text-white" : "text-[#b6c1d4] hover:bg-white/10 hover:text-white") : on ? "bg-surface text-ink shadow-soft ring-1 ring-line" : "text-muted hover:text-ink",
            )}
          >
            <o.icon className="size-4" aria-hidden />
            <span className="sr-only">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
