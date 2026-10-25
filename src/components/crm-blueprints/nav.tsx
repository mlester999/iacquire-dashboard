"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BLUEPRINT_SECTIONS, blueprintSectionFor } from "@/lib/admin-breadcrumb";
import { cn } from "@/lib/utils";

/** The sections of CRM Blueprints. A Blueprint's own pages (detail, editor, apply) belong to the Library tab. */
export function BlueprintNav({ pathname: forced }: { pathname?: string }) {
  const current = usePathname();
  const active = blueprintSectionFor(forced ?? current ?? "");
  return (
    <nav aria-label="CRM Blueprints sections" className="relative scrollbar-thin -mx-1 flex gap-1 overflow-x-auto px-1">
      {BLUEPRINT_SECTIONS.map((s) => {
        const on = active === s.href;
        return (
          <Link key={s.href} href={s.href} aria-current={on ? "page" : undefined}
            className={cn("inline-flex h-11 shrink-0 items-center rounded-xl px-3.5 text-[13.5px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-primary sm:h-9", on ? "border border-line bg-surface text-ink shadow-soft" : "text-muted hover:text-ink")}>
            {s.label}
          </Link>
        );
      })}
    </nav>
  );
}
