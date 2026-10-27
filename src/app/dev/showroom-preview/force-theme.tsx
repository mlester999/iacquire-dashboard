"use client";

import * as React from "react";
import { useTheme, type ThemePreference } from "@/components/providers";
import { writeRailPreference, type RailPreference } from "@/components/demo/showroom/rail-preference";

/**
 * Design QA only (the page that renders it is development-only): opens the preview in the theme the address asks for, through the same ThemeProvider the demo's own switch uses, with the
 * navigation rail folded or open, and with AQi open, by pressing the same buttons a visitor would.
 */
export function ForceTheme({ theme, rail = null, aqi = false }: { theme: ThemePreference | null; rail?: RailPreference | null; aqi?: boolean }) {
  const { setTheme } = useTheme();
  React.useEffect(() => {
    if (theme) setTheme(theme);
  }, [theme, setTheme]);
  React.useEffect(() => {
    if (rail) writeRailPreference(rail);
  }, [rail]);
  React.useEffect(() => {
    if (!aqi) return;
    const t = window.setTimeout(() => document.getElementById("aqi-launcher")?.click(), 400);
    return () => window.clearTimeout(t);
  }, [aqi]);
  return null;
}
