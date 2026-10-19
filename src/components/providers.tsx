"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { MotionConfig } from "motion/react";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/overlays";
import { LogoutConfirmationProvider } from "@/components/auth/logout-confirmation";
import { AqiWidget } from "@/components/aqi/aqi-widget";

export type ThemePreference = "light" | "dark" | "system";

/**
 * AQi lives at the application shell, not inside each page layout. A client-side navigation between
 * the portal, chat and agency areas therefore keeps the same widget (and its temporary chat) mounted
 * instead of recreating it. Auth, setup and public pages are outside this surface.
 */
const AQI_SURFACE = /^\/(activity|add-ons|analytics|appointments|approvals|chat|crm|inbox|knowledge|leads|maintenance|notifications|our-work|overview|projects|retention|sales|settings|setup|support|website|workforce|admin)(\/|$)/;

function isAqiSurface(pathname: string | null) {
  return Boolean(pathname && AQI_SURFACE.test(pathname));
}

function AqiMount({ allowed }: { allowed: boolean }) {
  const pathname = usePathname();
  if (!allowed || !isAqiSurface(pathname)) return null;
  return <AqiWidget />;
}

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

export function Providers({ children, aqiAllowed }: { children: React.ReactNode; aqiAllowed: boolean }) {
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
    const current = resolve(saved);
    setResolved(current);
    document.documentElement.dataset.theme = current;
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
      <LogoutConfirmationProvider>
        <MotionConfig reducedMotion="user">
          <TooltipProvider>
            {children}
            <AqiMount allowed={aqiAllowed} />
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
      </LogoutConfirmationProvider>
    </ThemeContext.Provider>
  );
}
