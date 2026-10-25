"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const ITEMS = [
  { href: "/website", label: "Overview", exact: true, needs: "any" },
  { href: "/website/edit", label: "Edit", needs: "edit" },
  { href: "/website/domains", label: "Domains", needs: "site" },
  { href: "/website/leads", label: "Enquiries", needs: "site" },
  { href: "/website/chat", label: "Chat", needs: "any" },
  { href: "/website/history", label: "History", needs: "site" },
] as const;

/** Sections of the website area. Before a site exists there is only the overview, so nothing leads to an empty page. */
export function WebsiteSubnav({ hasSite, canEdit }: { hasSite: boolean; canEdit: boolean }) {
  const pathname = usePathname();
  const items = ITEMS.filter((i) => i.needs === "any" || (hasSite && (i.needs !== "edit" || canEdit)));
  if (items.length < 2) return null;
  return (
    <nav aria-label="Website sections" className="relative scrollbar-thin -mx-1 flex gap-1 overflow-x-auto px-1">
      {items.map((i) => {
        const active = "exact" in i && i.exact ? pathname === i.href : pathname === i.href || pathname.startsWith(`${i.href}/`);
        return (
          <Link
            key={i.href} href={i.href} aria-current={active ? "page" : undefined}
            className={cn("inline-flex h-9 shrink-0 items-center rounded-xl px-3.5 text-[13.5px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-primary", active ? "border border-line bg-surface text-ink shadow-soft" : "text-muted hover:text-ink")}
          >
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}
