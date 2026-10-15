"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { STUDIO_SECTIONS } from "@/lib/admin-breadcrumb";
import { cn } from "@/lib/utils";

const ITEMS = STUDIO_SECTIONS;

/** The sections of the agency's Website Studio. */
export function StudioNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Website Studio sections" className="scrollbar-thin -mx-1 flex gap-1 overflow-x-auto px-1">
      {ITEMS.map((i) => {
        const active = "exact" in i && i.exact ? pathname === i.href : pathname === i.href || pathname.startsWith(`${i.href}/`);
        return (
          <Link key={i.href} href={i.href} aria-current={active ? "page" : undefined}
            className={cn("inline-flex h-9 shrink-0 items-center rounded-xl px-3.5 text-[13.5px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-primary", active ? "border border-line bg-surface text-ink shadow-soft" : "text-muted hover:text-ink")}>
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}
