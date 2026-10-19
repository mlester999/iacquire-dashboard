"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "motion/react";
import { Bell, BellRing, Building2, CreditCard, DatabaseBackup, Gauge, LifeBuoy, MessagesSquare, Plug, Shield, Sparkles, Users } from "lucide-react";
import type { Permission } from "@/lib/permissions";
import { cn } from "@/lib/utils";

const ITEMS: Array<{ href: string; label: string; group: string; icon: React.ComponentType<{ className?: string }>; permission?: Permission }> = [
  { href: "/settings", label: "Business profile", group: "Workspace", icon: Building2 },
  { href: "/settings/team", label: "Team members", group: "Workspace", icon: Users, permission: "team.view" },
  { href: "/settings/ai", label: "AI preferences", group: "AI and messaging", icon: Sparkles },
  { href: "/settings/integrations", label: "Integrations", group: "AI and messaging", icon: Plug, permission: "integrations.view" },
  { href: "/settings/messaging", label: "Messaging", group: "AI and messaging", icon: MessagesSquare, permission: "inbox.view" },
  { href: "/settings/escalations", label: "Escalations & availability", group: "AI and messaging", icon: BellRing, permission: "staff.availability" },
  { href: "/settings/notifications", label: "Notifications", group: "Account", icon: Bell },
  { href: "/settings/security", label: "Security", group: "Account", icon: Shield },
  { href: "/settings/usage", label: "Usage", group: "Plan and data", icon: Gauge, permission: "usage.view" },
  { href: "/settings/billing", label: "Billing & credits", group: "Plan and data", icon: CreditCard, permission: "usage.view" },
  { href: "/settings/data", label: "Your data", group: "Plan and data", icon: DatabaseBackup, permission: "offboarding.view" },
  { href: "/support", label: "Support", group: "Help", icon: LifeBuoy, permission: "support.use" },
];

export function SettingsNav({ permissions }: { permissions: Permission[] }) {
  const pathname = usePathname();
  const items = ITEMS.filter((i) => !i.permission || permissions.includes(i.permission));
  const groups = Array.from(new Set(items.map((i) => i.group)));
  const scroller = React.useRef<HTMLUListElement>(null);

  // On a phone the nav scrolls sideways, so bring the current page into view instead of leaving it off screen.
  React.useEffect(() => {
    const el = scroller.current?.querySelector<HTMLElement>('[aria-current="page"]');
    const box = scroller.current?.parentElement;
    if (!el || !box || box.scrollWidth <= box.clientWidth) return;
    box.scrollTo({ left: Math.max(0, el.offsetLeft - 24), behavior: "auto" });
  }, [pathname]);

  return (
    <nav aria-label="Settings" className="scrollbar-thin -mx-4 min-w-0 overflow-x-auto px-4 pb-1 lg:mx-0 lg:overflow-visible lg:px-0 lg:pb-0">
      <ul ref={scroller} className="relative flex gap-1 rounded-2xl border border-line bg-surface p-2 shadow-soft lg:flex-col lg:gap-0.5 lg:p-2.5">
        {groups.map((group, gi) => (
          <React.Fragment key={group}>
            <li aria-hidden className={cn("hidden px-3 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-[.14em] text-faint lg:block", gi > 0 && "mt-1.5 border-t border-line pt-3.5")}>
              {group}
            </li>
            {items
              .filter((i) => i.group === group)
              .map((i) => {
                const active = i.href === "/settings" ? pathname === "/settings" : pathname.startsWith(i.href);
                return (
                  <li key={i.href} className="shrink-0">
                    <Link
                      href={i.href}
                      data-aqi-target={i.href === "/settings/team" ? "settings.team.nav" : i.href === "/settings/integrations" ? "settings.integrations.nav" : undefined}
                      aria-current={active ? "page" : undefined}
                      className={cn("relative flex min-h-11 items-center gap-2.5 whitespace-nowrap rounded-xl px-3 text-[13px] font-medium transition-colors", active ? "text-primary-ink" : "text-muted hover:bg-surface-2 hover:text-ink")}
                    >
                      {active && <motion.span layoutId="settings-active" className="absolute inset-0 rounded-xl border border-primary/15 bg-primary-soft" transition={{ type: "spring", stiffness: 520, damping: 40 }} />}
                      <i.icon className={cn("relative size-4", active && "text-primary")} />
                      <span className="relative">{i.label}</span>
                    </Link>
                  </li>
                );
              })}
          </React.Fragment>
        ))}
      </ul>
    </nav>
  );
}
