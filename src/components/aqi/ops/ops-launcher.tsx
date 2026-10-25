"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowUpRight, Sparkles, X } from "lucide-react";
import { OpsChat } from "@/components/aqi/ops/ops-chat";
import { useOpsChat } from "@/components/aqi/ops/use-ops-chat";
import { PLATFORM_SCOPE, type OpsScope } from "@/lib/aqi/ops/types";
import { cn } from "@/lib/utils";

/**
 * The floating entry for Super Admins on every other page. It is the same Operations conversation as
 * the full console, not the Client assistant: a Super Admin never sees the Client launcher. The
 * server decides the runtime from the signed-in role; this component only changes the presentation.
 */
export function OpsLauncher() {
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);
  const [scope, setScope] = React.useState<OpsScope>(PLATFORM_SCOPE);
  const chat = useOpsChat();
  const launcherRef = React.useRef<HTMLButtonElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const onConsole = pathname?.startsWith("/admin/operations");
  const raised = Boolean(pathname?.startsWith("/chat"));

  React.useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target instanceof HTMLElement && e.target.closest("[role='dialog'][data-state], [data-radix-popper-content-wrapper]"))) {
        setOpen(false);
        launcherRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  if (onConsole) return null;
  return (
    <>
      <button
        ref={launcherRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="ops-launcher-panel"
        className={cn(
          "fixed right-4 z-40 inline-flex min-h-12 items-center gap-2 rounded-full border border-line-strong bg-ink px-4 text-[14px] font-semibold text-surface shadow-float transition-transform hover:scale-[1.02] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary dark:text-bg",
          raised ? "bottom-24" : "bottom-4",
        )}
      >
        <Sparkles className="size-4" aria-hidden />AQi Operations
      </button>
      {open && (
        <div
          id="ops-launcher-panel"
          ref={panelRef}
          role="dialog"
          aria-modal="false"
          aria-label="AQi Operations"
          tabIndex={-1}
          className="fixed inset-x-0 bottom-0 z-50 flex h-[88dvh] flex-col overflow-hidden rounded-t-3xl border border-line bg-surface shadow-float outline-none sm:inset-x-auto sm:bottom-4 sm:right-4 sm:h-[min(700px,calc(100dvh-32px))] sm:w-[440px] sm:rounded-3xl"
        >
          <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
            <p className="flex min-w-0 items-center gap-2 text-[14px] font-semibold text-ink"><Sparkles className="size-4 text-primary" aria-hidden /><span className="truncate">AQi Operations</span></p>
            <div className="flex items-center gap-1">
              <Link href="/admin/operations" onClick={() => setOpen(false)} className="inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-[13px] font-medium text-primary-ink hover:bg-primary-soft sm:min-h-8">Open console<ArrowUpRight className="size-3.5" aria-hidden /></Link>
              <button type="button" onClick={() => { setOpen(false); launcherRef.current?.focus(); }} className="inline-flex size-11 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink sm:size-8" aria-label="Close AQi Operations"><X className="size-4" aria-hidden /></button>
            </div>
          </div>
          <div className="min-h-0 flex-1"><OpsChat chat={chat} scope={scope} onScopeChange={setScope} variant="panel" onNavigate={() => undefined} /></div>
        </div>
      )}
    </>
  );
}
