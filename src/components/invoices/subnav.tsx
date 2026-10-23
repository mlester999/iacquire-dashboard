"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const ITEMS = [
  { href: "/invoices", label: "Invoices", exact: true },
  { href: "/invoices/settings", label: "Settings" },
] as const;

/** Sections of the invoices area. The payment account lives under Settings, Payments (owner only) and is linked from here for the owner. */
export function InvoicesSubnav({ waiting, canConnect }: { waiting: number; canConnect: boolean }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Invoice sections" className="scrollbar-thin -mx-1 flex gap-1 overflow-x-auto px-1">
      {ITEMS.map((i) => {
        const active = "exact" in i && i.exact ? pathname === i.href || pathname === "/invoices/new" || /^\/invoices\/[0-9a-f-]{36}/i.test(pathname) : pathname === i.href || pathname.startsWith(`${i.href}/`);
        return (
          <Link
            key={i.href} href={i.href} aria-current={active ? "page" : undefined}
            className={cn("inline-flex h-11 shrink-0 items-center gap-1.5 rounded-xl px-3.5 text-[13.5px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-primary sm:h-9", active ? "border border-primary/30 bg-primary-soft text-primary-ink" : "text-ink-2 hover:bg-surface-2")}
          >
            {i.label}
            {"exact" in i && waiting > 0 && <span className="rounded-full bg-warning-soft px-1.5 text-[11px] font-semibold text-warning-ink"><span aria-hidden>{waiting}</span><span className="sr-only">, {waiting} waiting for approval</span></span>}
          </Link>
        );
      })}
      {canConnect && (
        <Link href="/settings/payments" className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-xl px-3.5 text-[13.5px] font-medium text-ink-2 transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-primary sm:h-9">Payment account</Link>
      )}
    </nav>
  );
}
