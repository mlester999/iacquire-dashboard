import Link from "next/link";
import { BarChart3, Inbox, Settings2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgencySupportCaps } from "@/server/support/access";

const TABS = [
  { href: "/admin/support", key: "requests", label: "Requests", icon: Inbox },
  { href: "/admin/support/analytics", key: "analytics", label: "Analytics", icon: BarChart3 },
  { href: "/admin/support/settings", key: "settings", label: "Settings", icon: Settings2 },
] as const;

/** Requests, Analytics and Settings: each shown only to people whose role includes it. */
export function SupportSubnav({ active, caps }: { active: "requests" | "analytics" | "settings"; caps: AgencySupportCaps }) {
  const visible = TABS.filter((t) => t.key === "requests" || (t.key === "analytics" && caps["agency.support.analytics"]) || (t.key === "settings" && caps["agency.support.settings"]));
  return (
    <nav aria-label="Requests sections" className="flex gap-1 border-b border-line">
      {visible.map((t) => (
        <Link key={t.key} href={t.href} aria-current={active === t.key ? "page" : undefined}
          className={cn("-mb-px inline-flex min-h-11 items-center gap-2 border-b-2 px-3.5 text-[13.5px] font-medium transition", active === t.key ? "border-primary text-ink" : "border-transparent text-muted hover:border-line-strong hover:text-ink")}>
          <t.icon className="size-4" aria-hidden /> {t.label}
        </Link>
      ))}
    </nav>
  );
}
