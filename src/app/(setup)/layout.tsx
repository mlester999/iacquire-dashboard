import Link from "next/link";
import { requireOrgContext } from "@/server/tenancy/context";
import { Logo } from "@/components/brand";

export const dynamic = "force-dynamic";

export default async function SetupLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireOrgContext("workspace.manage_profile");
  return (
    <div className="app-backdrop grain relative min-h-dvh">
      <header className="relative z-10 mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link href="/overview" aria-label="Go to dashboard">
          <Logo />
        </Link>
        <div className="flex items-center gap-3 text-[13px] text-muted">
          <span className="hidden sm:inline">{ctx.org.name}</span>
          <Link href="/overview" className="rounded-lg px-2.5 py-1.5 font-medium text-ink-2 hover:bg-surface-2 hover:text-ink">
            Finish later
          </Link>
        </div>
      </header>
      <div className="relative z-10">{children}</div>
    </div>
  );
}
