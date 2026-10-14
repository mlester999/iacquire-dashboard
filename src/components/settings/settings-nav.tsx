"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "motion/react";
import { Bell, BellRing, Building2, CreditCard, Gauge, LifeBuoy, MessagesSquare, Plug, Shield, Sparkles, Users } from "lucide-react";
import type { Permission } from "@/lib/permissions";
import { cn } from "@/lib/utils";

const ITEMS: Array<{ href: string; label: string; icon: React.ComponentType<{ className?: string }>; permission?: Permission }> = [
  { href: "/settings", label: "Business profile", icon: Building2 },
  { href: "/settings/team", label: "Team members", icon: Users, permission: "team.view" },
  { href: "/settings/ai", label: "AI preferences", icon: Sparkles },
  { href: "/settings/integrations", label: "Integrations", icon: Plug, permission: "integrations.view" },
  { href: "/settings/messaging", label: "Messaging", icon: MessagesSquare, permission: "inbox.view" },
  { href: "/settings/escalations", label: "Escalations & availability", icon: BellRing, permission: "staff.availability" },
  { href: "/settings/notifications", label: "Notifications", icon: Bell },
  { href: "/settings/security", label: "Security", icon: Shield },
  { href: "/settings/usage", label: "Usage", icon: Gauge, permission: "usage.view" },
  { href: "/settings/billing", label: "Billing & credits", icon: CreditCard, permission: "usage.view" },
  { href: "/support", label: "Support", icon: LifeBuoy, permission: "support.use" },
];

export function SettingsNav({ permissions }: { permissions: Permission[] }) {
  const pathname = usePathname();
  const items = ITEMS.filter((i) => !i.permission || permissions.includes(i.permission));
  return (
    <nav aria-label="Settings" className="scrollbar-thin -mx-4 overflow-x-auto px-4 lg:mx-0 lg:overflow-visible lg:px-0">
      <ul className="flex gap-1 rounded-2xl border border-line bg-surface p-2 lg:flex-col">
        {items.map((i) => {
          const active = i.href === "/settings" ? pathname === "/settings" : pathname.startsWith(i.href);
          return (
            <li key={i.href} className="shrink-0">
              <Link
                href={i.href}
                aria-current={active ? "page" : undefined}
                className={cn("relative flex min-h-11 items-center gap-2.5 whitespace-nowrap rounded-xl px-3 text-[13px] font-medium transition-colors", active ? "text-primary-ink" : "text-muted hover:text-ink")}
              >
                {active && <motion.span layoutId="settings-active" className="absolute inset-0 rounded-xl border border-primary/15 bg-primary-soft" transition={{ type: "spring", stiffness: 520, damping: 40 }} />}
                <i.icon className={cn("relative size-4", active && "text-primary")} />
                <span className="relative">{i.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
