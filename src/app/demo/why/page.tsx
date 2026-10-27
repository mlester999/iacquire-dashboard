import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Logo } from "@/components/brand";
import { WhyContent } from "@/components/demo/showroom/why-content";
import { MAINTENANCE_MONTHLY_USD, SETUP_FEE_USD } from "@/lib/billing";
import "@/components/demo/showroom/showroom.css";

export const dynamic = "force-static";
export const metadata: Metadata = { title: "Why iAcquireOS?", description: "What iAcquireOS is, how it compares with doing it yourself, and what it costs.", robots: { index: false, follow: false }, referrer: "no-referrer" };

/**
 * "Why iAcquireOS?" on its own address. It needs no demo session and shows nothing about anyone, so it stays open after a demo window has ended and can be read by anyone who is sent the
 * link. It records nothing: the buttons are plain links, to the request page and to the room (which sends a browser with no session to the request page).
 */
export default function WhyPage() {
  return (
    <div className="demo-stage">
      <a href="#demo-main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-xl focus:bg-surface focus:px-4 focus:py-2 focus:text-[14px] focus:text-ink">
        Skip to content
      </a>
      <header className="mx-auto flex w-full max-w-[1120px] items-center justify-between gap-4 px-4 pt-5 sm:px-8 sm:pt-8">
        <Link href="/demo" aria-label="iAcquire demo home" className="inline-flex min-h-11 items-center">
          <Logo tone="inverse" />
        </Link>
        <Link href="/demo/room" className="sx-btn-quiet inline-flex h-11 items-center rounded-xl px-4 text-[14px] font-semibold">
          Back to your demo
        </Link>
      </header>
      <main id="demo-main" tabIndex={-1} className="@container mx-auto w-full max-w-[1120px] px-4 py-10 outline-none sm:px-8 sm:py-14">
        <WhyContent
          setupFeeUsd={SETUP_FEE_USD}
          monthlyPlanUsd={MAINTENANCE_MONTHLY_USD}
          actions={
            <section aria-labelledby="why-next" className="sx-panel sx-panel-hot space-y-5 p-6 sm:p-8">
              <h2 id="why-next" className="sx-display text-[28px] leading-tight text-ink sm:text-[34px]">
                See it with your own business name on it
              </h2>
              <p className="max-w-2xl text-[15px] leading-relaxed text-ink-2">The demo is a personal, 24-hour walk through the AI team, the CRM and Automation Studio on sample data. Ask for yours and we will email you a link.</p>
              <div className="flex flex-wrap gap-3">
                <Link href="/demo" className="sx-btn-primary inline-flex h-12 items-center gap-2 rounded-xl px-6 text-[15px] font-semibold">
                  Request your demo
                  <ArrowRight className="size-4" aria-hidden />
                </Link>
                <Link href="/demo/room" className="sx-btn-quiet inline-flex h-12 items-center rounded-xl px-6 text-[15px] font-semibold">
                  I already have a demo
                </Link>
              </div>
            </section>
          }
        />
      </main>
      <footer className="mx-auto w-full max-w-[1120px] px-4 pb-10 text-[13px] text-muted sm:px-8">
        <p>iAcquire demo. Sample data only.</p>
      </footer>
    </div>
  );
}
