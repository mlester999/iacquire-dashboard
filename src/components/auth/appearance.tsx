"use client";
import { Moon,Sun } from "lucide-react";
import { useTheme } from "@/components/providers";

export function AuthAppearance() {
  const {resolved,setTheme}=useTheme();
  return <button type="button" onClick={()=>setTheme(resolved==="light"?"dark":"light")} aria-label={`Switch to ${resolved==="light"?"dark":"light"} theme`} className="flex size-11 items-center justify-center rounded-xl border border-line bg-surface/80 text-ink-2 transition hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">{resolved==="light"?<Moon className="size-4" aria-hidden/>:<Sun className="size-4" aria-hidden/>}</button>;
}
