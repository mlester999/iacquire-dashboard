import * as React from "react";
import Link from "next/link";
import { CircleAlert, CircleCheck, type LucideIcon } from "lucide-react";
import { Logo } from "@/components/brand";
import { Badge } from "@/components/ui/primitives";
import { ThemeSwitch } from "@/components/demo/showroom/theme-switch";
import type { Notice } from "@/lib/demo/outcomes";
import "@/components/demo/showroom/showroom.css";

// The frame every public demo page shares: the iAcquire mark, a "Demo" label, the theme control, the page, and a quiet footer. No portal navigation and nothing about the signed-in app: a
// prospect has no account. Designed for a 375 px phone first; the page is one column that widens to a readable measure (or, for the request page, to a two-column layout).

export function DemoShell({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  const measure = wide ? "max-w-6xl" : "max-w-2xl";
  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#demo-main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-xl focus:bg-surface focus:px-4 focus:py-2 focus:text-[14px] focus:text-ink focus:shadow-float">
        Skip to content
      </a>
      <header className={`mx-auto w-full ${measure} px-4 pt-5 sm:px-6 sm:pt-7`}>
        <div className="flex min-w-0 items-center justify-between gap-3">
          <Link href="/demo" aria-label="iAcquire demo home" className="inline-flex min-h-11 items-center">
            <Logo />
          </Link>
          <div className="flex items-center gap-2">
            <Badge tone="primary">Demo</Badge>
            <ThemeSwitch />
          </div>
        </div>
      </header>
      <main id="demo-main" tabIndex={-1} className={`mx-auto w-full ${measure} flex-1 px-4 py-6 outline-none sm:px-6 sm:py-10`}>
        {children}
      </main>
      <footer className={`mx-auto w-full ${measure} px-4 pb-8 pt-2 text-center text-[12px] text-muted sm:px-6`}>
        <p>iAcquire demo. Sample data only.</p>
      </footer>
    </div>
  );
}

/**
 * The frame of the pages that ask for something (the request page, the emailed link, a message): the mark, the page, a quiet footer. The request page asks for the wide frame, which
 * adds the soft brand glow behind the first screen; the narrow one is a single readable column.
 */
export function PublicFrame({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="app-backdrop relative min-h-dvh overflow-x-clip">
      {wide && <div aria-hidden className="sx-hero-glow" />}
      <div className="relative">
        <DemoShell wide={wide}>{children}</DemoShell>
      </div>
    </div>
  );
}

/** The outcome of what the person just did. An error is announced as an alert, a good outcome as a status. */
export function DemoNotice({ notice, id }: { notice: Notice | null; id?: string }) {
  if (!notice) return null;
  const ok = notice.tone === "ok";
  return (
    <p id={id} role={ok ? "status" : "alert"} className={`flex items-start gap-2 rounded-xl border px-4 py-3 text-[14px] leading-relaxed ${ok ? "border-success/25 bg-success-soft text-success-ink" : "border-danger/20 bg-danger-soft text-danger-ink"}`}>
      {ok ? <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden /> : <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />}
      <span className="min-w-0 break-words">{notice.text}</span>
    </p>
  );
}

/** A page that has only a message to give: the demo is closed, the link is no good, the session ended. */
export function DemoMessage({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: React.ReactNode }) {
  return (
    <div className="sx-panel relative mx-auto mt-4 max-w-md overflow-hidden p-7 text-center sm:mt-12 sm:p-9">
      <span aria-hidden className="brand-gradient absolute inset-x-0 top-0 h-1" />
      <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-primary-soft text-primary-ink">
        <Icon className="size-5" aria-hidden />
      </div>
      <h1 className="mt-5 text-[22px] font-semibold tracking-[-0.03em] text-ink">{title}</h1>
      <div className="mt-2 space-y-3 text-[14px] leading-relaxed text-muted">{children}</div>
    </div>
  );
}

export const linkClass =
  "inline-flex h-11 min-w-0 select-none items-center justify-center gap-2 rounded-xl border border-line bg-surface px-4 text-sm font-medium text-ink shadow-soft transition-colors hover:border-line-strong hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";
