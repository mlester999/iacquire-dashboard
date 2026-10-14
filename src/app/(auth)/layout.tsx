import Link from "next/link";
import { Logo } from "@/components/brand";
import { AuthShowcase } from "@/components/auth/showcase";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-backdrop grain relative grid min-h-dvh lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
      <AuthShowcase />
      <main className="relative z-10 flex min-h-dvh flex-col px-4 py-6 sm:px-8 lg:px-14">
        <div className="flex items-center justify-between lg:hidden">
          <Link href="/login" aria-label="iAcquire home">
            <Logo />
          </Link>
        </div>
        <div className="flex flex-1 items-center justify-center py-10">
          <div className="w-full max-w-[420px]">{children}</div>
        </div>
        <footer className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[12px] text-faint lg:justify-start">
          <span>© {new Date().getFullYear()} iAcquire</span>
          <Link href="/get-started" className="hover:text-ink">
            Get started
          </Link>
          <a href="mailto:support@iacquire.ai" className="hover:text-ink">
            Contact support
          </a>
        </footer>
      </main>
    </div>
  );
}
