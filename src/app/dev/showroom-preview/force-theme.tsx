"use client";

import * as React from "react";
import { useTheme, type ThemePreference } from "@/components/providers";

/** Design QA only (the page that renders it is development-only): opens the preview in the theme the address asks for, through the same ThemeProvider the demo's own switch uses. */
export function ForceTheme({ theme }: { theme: ThemePreference | null }) {
  const { setTheme } = useTheme();
  React.useEffect(() => {
    if (theme) setTheme(theme);
  }, [theme, setTheme]);
  return null;
}
