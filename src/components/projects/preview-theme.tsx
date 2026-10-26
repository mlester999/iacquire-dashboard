"use client";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/components/providers";
import { Button } from "@/components/ui/button";

/**
 * Safe development preview switch using the same application theme provider.
 *
 * The visible word is the theme a press switches to ("Dark" / "Light"), so the accessible name has to contain that word: an aria-label that did not ("Preview dark
 * theme" against the visible "Dark") fails WCAG 2.5.3, label in name, which a screen-reader user who speaks the visible label cannot match to the control.
 */
export function PreviewTheme() {
  const { resolved, setTheme } = useTheme();
  const target = resolved === "light" ? "dark" : "light";
  return (
    <Button size="sm" variant="secondary" onClick={() => setTheme(target)} aria-label={`Switch to the ${target} preview`}>
      {resolved === "light" ? <Moon className="size-3.5" aria-hidden /> : <Sun className="size-3.5" aria-hidden />}
      {target === "dark" ? "Dark" : "Light"} preview
    </Button>
  );
}
