"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  ChevronRight,
  Search,
  Building2,
  LogOut,
  Menu as MenuIcon,
  Monitor,
  Moon,
  ShieldHalf,
  Sparkles,
  Sun,
  UserRound,
} from "lucide-react";
import { toast } from "sonner";
import { ButtonLink } from "@/components/ui/button";
import { Input } from "@/components/ui/primitives";
import { Dialog, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Tooltip } from "@/components/ui/overlays";
import { CLIENT_NAV } from "@/components/shell/sidebar";
import { useLogoutConfirmation } from "@/components/auth/logout-confirmation";
import { useTheme } from "@/components/providers";
import { useShell } from "@/components/shell/shell-context";
import { NotificationCenter } from "@/components/notifications/notification-center";
import { switchOrgAction } from "@/app/actions/shell";
import { cn, currentTime, initials } from "@/lib/utils";

const TITLES: Array<[RegExp, string]> = [
  [/^\/overview/, "Overview"],
  [/^\/setup/, "Setup"],
  [/^\/employees\/[^/]+\/configure/, "Configure employee"],
  [/^\/employees/, "AI Employees"],
  [/^\/leads/, "Leads"],
  [/^\/appointments/, "Appointments"],
  [/^\/sales/, "Sales Pipeline"],
  [/^\/retention/, "Customer Retention"],
  [/^\/analytics/, "Analytics"],
  [/^\/approvals/, "Approval Center"],
  [/^\/knowledge/, "Knowledge Center"],
  [/^\/activity/, "Activity"],
  [/^\/notifications/, "Notifications"],
  [/^\/support/, "Support"],
  [/^\/crm\/contacts/, "Contacts"],
  [/^\/crm\/companies/, "Companies"],
  [/^\/crm\/smart-lists/, "Smart Lists"],
  [/^\/crm\/tags/, "Tags & Segments"],
  [/^\/crm\/fields/, "Custom Fields"],
  [/^\/crm\/pipelines/, "Pipelines"],
  [/^\/crm\/opportunities/, "Opportunities"],
  [/^\/crm\/tasks/, "Tasks"],
  [/^\/crm\/settings/, "CRM Settings"],
  [/^\/crm/, "CRM"],
  [/^\/inbox/, "Inbox"],
  [/^\/settings/, "Settings"],
  [/^\/add-ons/, "Custom Projects & Add-ons"],
  [/^\/projects/, "My Projects"],
  [/^\/our-work/, "Selected Work"],
  [/^\/maintenance/, "Maintenance"],
];

function ThemeMenuItems() {
  const { theme, setTheme } = useTheme();
  const opts = [
    { v: "light" as const, label: "Light", icon: Sun },
    { v: "dark" as const, label: "Dark", icon: Moon },
    { v: "system" as const, label: "System", icon: Monitor },
  ];
  return (
    <div className="grid grid-cols-3 gap-1 p-1">
      {opts.map((o) => (
        <button
          key={o.v}
          type="button"
          onClick={() => setTheme(o.v)}
          aria-pressed={theme === o.v}
          className={cn(
            "flex flex-col items-center gap-1 rounded-lg py-2 text-[11.5px] text-muted transition hover:bg-surface-2",
            theme === o.v && "bg-surface-2 text-ink ring-1 ring-line",
          )}
        >
          <o.icon className="size-4" />
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Topbar({ onOpenMenu }: { onOpenMenu: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const shell = useShell();
  const { requestLogout } = useLogoutConfirmation();
  const [navigationOpen, setNavigationOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const { resolved, setTheme } = useTheme();
  const title = TITLES.find(([re]) => re.test(pathname))?.[1] ?? "iAcquire";
  const destinations = CLIENT_NAV.filter((n) => (!n.permission || shell.permissions.includes(n.permission)) && (n.href !== "/setup" || shell.setup.visible) && n.label.toLowerCase().includes(search.toLowerCase()));
  React.useEffect(() => {
    const key = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setNavigationOpen((s) => !s); } };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);

  const switchOrg = async (id: string) => {
    const res = await switchOrgAction(id);
    if (!res.ok) toast.error(res.error);
    else router.push("/overview");
  };

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-bg/80 backdrop-blur-xl supports-[backdrop-filter]:bg-bg/70">
      <div className="mx-auto flex h-16 max-w-[1600px] items-center gap-2 px-4 sm:px-6 lg:px-8">
        <button
          type="button"
          onClick={onOpenMenu}
          className="-ml-1 flex size-10 items-center justify-center rounded-xl text-ink-2 hover:bg-surface-2 lg:hidden"
          aria-label="Open navigation"
        >
          <MenuIcon className="size-5" />
        </button>
        <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-2 text-[12px]"><Link href="/overview" className="hidden max-w-36 truncate text-muted hover:text-ink md:block">{shell.org.name}</Link><ChevronRight className="hidden size-3 text-faint md:block" /><span className="truncate font-medium text-ink">{title}</span></nav>

        <button type="button" onClick={() => { setSearch(""); setNavigationOpen(true); }} aria-label="Search workspace navigation" className="flex size-9 items-center justify-center rounded-xl border border-line bg-surface text-muted hover:text-ink"><Search className="size-4" /></button>
        <button type="button" onClick={() => setTheme(resolved === "light" ? "dark" : "light")} aria-label={`Switch to ${resolved === "light" ? "dark" : "light"} theme`} className="hidden size-9 items-center justify-center rounded-xl text-muted hover:bg-surface-2 sm:flex">{resolved === "light" ? <Moon className="size-4" /> : <Sun className="size-4" />}</button>

        <ButtonLink href="/chat/operations-manager" variant="secondary" size="sm" className="hidden gap-1.5 sm:inline-flex">
          <Sparkles className="size-3.5 text-primary" /> Ask your AI team
        </ButtonLink>
        <Tooltip content="Ask your AI team">
          <Link href="/chat/operations-manager" className="flex size-10 items-center justify-center rounded-xl text-ink-2 hover:bg-surface-2 sm:hidden" aria-label="Ask your AI team">
            <Sparkles className="size-[18px] text-primary" />
          </Link>
        </Tooltip>
        <NotificationCenter
          initialUnread={shell.unreadNotifications}
          initialNow={currentTime()}
          timeZone={shell.org.timezone}
          viewAllHref="/notifications"
          settingsHref="/settings/notifications"
        />

        <Menu>
          <MenuTrigger asChild>
            <button type="button" className="ml-0.5 flex items-center gap-2 rounded-xl p-1 pr-1.5 transition hover:bg-surface-2" aria-label={`Account menu ${initials(shell.user.name)}`}>
              <span className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-violet text-[12px] font-semibold text-white">
                {initials(shell.user.name)}
              </span>
            </button>
          </MenuTrigger>
          <MenuContent className="w-64">
            <div className="px-2.5 py-2">
              <p className="truncate text-[13.5px] font-semibold text-ink">{shell.user.name}</p>
              <p className="truncate text-[12px] text-muted">{shell.user.email}</p>
            </div>
            <MenuSeparator />
            <MenuItem onSelect={() => router.push("/settings/security")}>
              <UserRound className="size-4" /> Account &amp; security
            </MenuItem>
            {shell.user.platformRole !== "none" && (
              <MenuItem onSelect={() => router.push("/admin")}>
                <ShieldHalf className="size-4" /> Agency admin
              </MenuItem>
            )}
            {shell.memberships.length > 1 && (
              <>
                <MenuSeparator />
                <MenuLabel>Workspaces</MenuLabel>
                {shell.memberships.map((m) => (
                  <MenuItem key={m.id} onSelect={() => switchOrg(m.id)} disabled={m.id === shell.org.id}>
                    <Building2 className="size-4" />
                    <span className="flex-1 truncate">{m.name}</span>
                    {m.id === shell.org.id && <span className="text-[11px] text-primary">Current</span>}
                  </MenuItem>
                ))}
              </>
            )}
            <MenuSeparator />
            <MenuLabel>Appearance</MenuLabel>
            <ThemeMenuItems />
            <MenuSeparator />
            <MenuItem onSelect={requestLogout} destructive className="w-full">
              <LogOut className="size-4" /> Sign out
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
      <Dialog open={navigationOpen} onOpenChange={setNavigationOpen} title="Jump to your workspace" description="Search the modules available to your account."><Input autoFocus aria-label="Search workspace modules" placeholder="Leads, AI Employees, Support…" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && destinations[0]) { router.push(destinations[0].href); setNavigationOpen(false); } }} /><ul className="mt-3 space-y-1">{destinations.map((n) => <li key={n.href}><Link href={n.href} onClick={() => setNavigationOpen(false)} className="flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm text-ink hover:bg-primary-soft"><n.icon className="size-4 text-primary" />{n.label}</Link></li>)}</ul>{!destinations.length && <p className="py-8 text-center text-sm text-muted">No modules match your search.</p>}</Dialog>
    </header>
  );
}

export function DemoBanner() {
  return (
    <aside aria-label="Demo workspace" className="border-b border-violet/20 bg-violet-soft px-4 py-2 text-center text-[12.5px] font-medium text-violet-ink">
      Demo workspace — the records here are fictional sample data for previewing the portal, not live business results.
    </aside>
  );
}

export function SetupBanner() {
  return (
    <div className="mx-auto mt-4 max-w-[1440px] px-4 sm:px-6 lg:px-8">
      <div className="flex flex-col items-start justify-between gap-3 rounded-2xl border border-primary/20 bg-primary-soft px-4 py-3 sm:flex-row sm:items-center">
        <p className="text-[13.5px] text-primary-ink">
          <span className="font-semibold">Finish your company setup</span> so we can tailor your AI team. It takes about 3–5 minutes and saves as you go.
        </p>
        <ButtonLink href="/onboarding" size="sm" variant="brand">
          Continue setup
        </ButtonLink>
      </div>
    </div>
  );
}
