"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { ShellProvider } from "@/components/shell/shell-context";
import { Sidebar } from "@/components/shell/sidebar";
import { DemoBanner, SetupBanner, Topbar } from "@/components/shell/topbar";
import { Sheet } from "@/components/ui/overlays";
import type { ShellData } from "@/server/queries/shell";

export function PortalShell({ data, children }: { data: ShellData; children: React.ReactNode }) {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [compact, setCompact] = React.useState(false);
  const pathname = usePathname();
  const showSetup = !data.org.onboardingComplete && data.org.kind === "client" && data.permissions.includes("workspace.manage_profile") && !pathname.startsWith("/onboarding");

  return (
    <ShellProvider value={data}>
      <div className="app-backdrop grain relative min-h-dvh" style={{ "--sidebar-w": compact ? "80px" : "264px" } as React.CSSProperties}>
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[80] focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2 focus:shadow-float">
          Skip to content
        </a>
        <aside aria-label="Primary navigation" className="fixed inset-y-0 left-0 z-30 hidden w-[var(--sidebar-w)] transition-[width] duration-200 lg:block">
          <Sidebar compact={compact} onCompact={() => setCompact((s) => !s)} />
        </aside>
        <Sheet open={menuOpen} onOpenChange={setMenuOpen} side="left" title="Navigation" hideHeader>
          <Sidebar onNavigate={() => setMenuOpen(false)} />
        </Sheet>

        <div className="relative z-10 min-w-0 transition-[padding] duration-200 lg:pl-[var(--sidebar-w)]">
          {data.org.isDemo && <DemoBanner />}
          <Topbar onOpenMenu={() => setMenuOpen(true)} />
          {showSetup && <SetupBanner />}
          <main id="main" className="page-in mx-auto w-full max-w-[1600px] px-4 pb-28 pt-6 sm:px-6 lg:px-8">
            {children}
          </main>
        </div>
      </div>
    </ShellProvider>
  );
}
