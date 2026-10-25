"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const ITEMS = [
  { href: "/proposals", label: "Proposals", exact: true },
  { href: "/proposals/approvals", label: "Approvals", badge: true },
  { href: "/proposals/templates", label: "Templates" },
  { href: "/proposals/catalog", label: "Price book" },
  { href: "/proposals/settings", label: "Settings" },
] as const;

/** Sections of the proposals area. The approvals tab carries the count waiting, in words as well as a number. */
export function ProposalsSubnav({ waiting }: { waiting: number }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Proposal sections" className="relative scrollbar-thin -mx-1 flex gap-1 overflow-x-auto px-1 lg:mx-0 lg:px-0 lg:flex-wrap lg:overflow-visible">
      {ITEMS.map((i) => {
        const active = "exact" in i && i.exact
          ? pathname === i.href || pathname === "/proposals/new" || /^\/proposals\/[0-9a-f-]{36}$/i.test(pathname)
          : pathname === i.href || pathname.startsWith(`${i.href}/`);
        return (
          <Link
            key={i.href} href={i.href} aria-current={active ? "page" : undefined}
            className={cn("inline-flex h-11 shrink-0 items-center gap-1.5 rounded-xl px-3.5 text-[14px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-primary sm:h-9", active ? "border border-primary/30 bg-primary-soft text-primary-ink" : "text-ink-2 hover:bg-surface-2")}
          >
            {i.label}
            {"badge" in i && waiting > 0 && <span className="rounded-full bg-warning-soft px-1.5 text-[12px] font-semibold text-warning-ink"><span aria-hidden>{waiting}</span><span className="sr-only">, {waiting} waiting</span></span>}
          </Link>
        );
      })}
    </nav>
  );
}
