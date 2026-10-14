"use client";

import * as React from "react";
import { MotionConfig } from "motion/react";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/overlays";

export type ThemePreference = "light" | "dark" | "system";

const ThemeContext = React.createContext<{ theme: ThemePreference; resolved: "light" | "dark"; setTheme: (t: ThemePreference) => void }>({
  theme: "light",
  resolved: "light",
  setTheme: () => undefined,
});

export function useTheme() {
  return React.useContext(ThemeContext);
}

function resolve(t: ThemePreference): "light" | "dark" {
  if (t === "system") return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  return t;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = React.useState<ThemePreference>("light");
  const [resolved, setResolved] = React.useState<"light" | "dark">("light");

  React.useEffect(() => {
    let saved: ThemePreference = "light";
    try {
      const v = localStorage.getItem("iaq-theme");
      if (v === "dark" || v === "system" || v === "light") saved = v;
    } catch {
      /* storage unavailable */
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync from storage after hydration
    setThemeState(saved);
    setResolved(resolve(saved));
  }, []);

  React.useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const r = resolve("system");
      setResolved(r);
      document.documentElement.dataset.theme = r;
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  const setTheme = React.useCallback((t: ThemePreference) => {
    setThemeState(t);
    const r = resolve(t);
    setResolved(r);
    document.documentElement.dataset.theme = r;
    try {
      localStorage.setItem("iaq-theme", t);
    } catch {
      /* storage unavailable */
    }
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, resolved, setTheme }}>
      <MotionConfig reducedMotion="user">
        <TooltipProvider>
          {children}
          <Toaster
            position="top-center"
            theme={resolved}
            toastOptions={{
              classNames: {
                toast: "!rounded-2xl !border !border-line !bg-surface !text-ink !shadow-float !font-sans",
                description: "!text-muted",
              },
            }}
          />
        </TooltipProvider>
      </MotionConfig>
    </ThemeContext.Provider>
  );
}
