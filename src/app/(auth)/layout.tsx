import Link from "next/link";
import { Logo } from "@/components/brand";
import { AuthShowcase } from "@/components/auth/showcase";
import { AuthAppearance } from "@/components/auth/appearance";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-backdrop grain relative grid min-h-dvh lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
      <AuthShowcase />
      <main className="relative z-10 flex min-h-dvh min-w-0 flex-col px-4 py-6 sm:px-8 lg:px-10 xl:px-14">
        <div className="flex items-center justify-between gap-3">
          <Link href="/login" aria-label="iAcquire home" className="lg:hidden">
            <Logo />
          </Link>
          <span className="hidden text-[12px] font-medium uppercase tracking-[.16em] text-muted lg:block">Your iAcquire workspace</span>
          <AuthAppearance />
        </div>
        <div className="flex flex-1 items-center justify-center py-8 sm:py-10">
          <div className="w-full max-w-[480px] rounded-[26px] border border-line bg-surface/85 p-5 shadow-card sm:p-8">{children}</div>
        </div>
        <footer className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[12px] text-faint lg:justify-start">
          <span>© {new Date().getFullYear()} iAcquire</span>
          <Link href="/get-started" className="inline-flex min-h-11 items-center hover:text-ink">
            Get started
          </Link>
          <a href="mailto:support@iacquire.ai" className="inline-flex min-h-11 items-center hover:text-ink">
            Contact support
          </a>
        </footer>
      </main>
    </div>
  );
}
