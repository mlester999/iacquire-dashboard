"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const ITEMS = [
  { href: "/social", label: "Calendar", exact: true },
  { href: "/social/approvals", label: "Approvals", badge: true },
  { href: "/social/accounts", label: "Accounts" },
  { href: "/social/media", label: "Media" },
  { href: "/social/analytics", label: "Analytics" },
  { href: "/social/settings", label: "Settings" },
] as const;

/** Sections of the social media area. The approvals tab carries the count of posts waiting, in words as well as a number. */
export function SocialSubnav({ waiting }: { waiting: number }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Social media sections" className="relative scrollbar-thin -mx-1 flex gap-1 overflow-x-auto px-1">
      {ITEMS.map((i) => {
        const active = "exact" in i && i.exact ? pathname === i.href || pathname.startsWith("/social/posts") : pathname === i.href || pathname.startsWith(`${i.href}/`);
        return (
          <Link
            key={i.href} href={i.href} aria-current={active ? "page" : undefined}
            className={cn("inline-flex h-11 shrink-0 items-center gap-1.5 rounded-xl px-3.5 text-[13.5px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-primary sm:h-9", active ? "border border-primary/30 bg-primary-soft text-primary-ink" : "text-ink-2 hover:bg-surface-2")}
          >
            {i.label}
            {"badge" in i && waiting > 0 && <span className="rounded-full bg-warning-soft px-1.5 text-[11px] font-semibold text-warning-ink"><span aria-hidden>{waiting}</span><span className="sr-only">, {waiting} waiting</span></span>}
          </Link>
        );
      })}
    </nav>
  );
}
