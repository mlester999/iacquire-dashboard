import * as React from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { Logo } from "@/components/brand";
import PreviewInner from "@/app/dev/onboarding-preview/preview-inner";

if (!sessionStorage.getItem("iaq-onboarding-preview:empty")) {
  const row = (value: string) => ({ value, source: "user", skipped: false, needsConfirmation: false, updatedAt: new Date().toISOString() });
  sessionStorage.setItem("iaq-onboarding-preview:empty", JSON.stringify({ answers: { "a.business_name": row("Brightside Roofing"), "a.industry": row("home_services"), "a.business_model": row("mixed"), "a.description": row("My original business wording.") }, revision: 1, current: "a.description", submitted: false }));
}
createRoot(document.getElementById("root")!).render(<>
  <header className="relative z-10 mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6"><Logo /><div className="flex items-center gap-2"><div id="onboarding-header-actions" /><button className="min-h-11 rounded-lg px-2 text-[12px] text-muted" onClick={() => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark"; }}>Theme</button></div></header>
  <PreviewInner seed="empty" /><Toaster />
</>);
