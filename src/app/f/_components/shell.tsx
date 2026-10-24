import * as React from "react";
import { Hourglass } from "lucide-react";
import { cn } from "@/lib/utils";
import { businessInitials } from "@/lib/business-initials";

// The frame every hosted form page shares: the business's name and colour, the form, and a quiet footer. No portal navigation and
// nothing about the signed-in app.

const HEX = /^#[0-9a-fA-F]{6}$/;

function readableOn(hex: string): string {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return 1.05 / (l + 0.05) >= (l + 0.05) / 0.05 ? "#ffffff" : "#0a0d14";
}

export function Monogram({ name, color, className }: { name: string; color: string | null; className?: string }) {
  const bg = color && HEX.test(color) ? color : null;
  return (
    <span
      aria-hidden
      className={cn("inline-flex size-11 shrink-0 items-center justify-center rounded-2xl text-[15px] font-semibold tracking-tight shadow-soft", !bg && "brand-gradient text-white", className)}
      style={bg ? { backgroundColor: bg, color: readableOn(bg) } : undefined}
    >
      {businessInitials(name)}
    </span>
  );
}

export function FormShell({ business, children }: { business: { name: string; brandColor: string | null } | null; children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#form-main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-xl focus:bg-surface focus:px-4 focus:py-2 focus:text-[14px] focus:text-ink focus:shadow-float">
        Skip to content
      </a>
      {business && (
        <header className="mx-auto w-full max-w-2xl px-4 pt-6 sm:px-6 sm:pt-10">
          <div className="flex min-w-0 items-center gap-3">
            <Monogram name={business.name} color={business.brandColor} />
            <p className="truncate text-[16px] font-semibold tracking-[-0.02em] text-ink">{business.name}</p>
          </div>
        </header>
      )}
      <main id="form-main" tabIndex={-1} className="mx-auto w-full max-w-2xl flex-1 px-4 py-6 outline-none sm:px-6 sm:py-8">
        {children}
      </main>
      <footer className="mx-auto w-full max-w-2xl px-4 pb-8 pt-2 text-center text-[12px] text-muted sm:px-6">Form by iAcquire</footer>
    </div>
  );
}

/** Shown instead of a page when one visitor has asked for too many pages in a short time. */
export function BusyNotice() {
  return (
    <FormShell business={null}>
      <div className="mx-auto mt-16 max-w-md text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-2xl border border-line bg-surface text-primary shadow-card">
          <Hourglass className="size-5" aria-hidden />
        </div>
        <h1 className="mt-5 text-[22px] font-semibold tracking-[-0.03em] text-ink">One moment, please</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-muted">We&apos;ve had a lot of requests from your connection. Wait a minute, then reload this page.</p>
      </div>
    </FormShell>
  );
}
