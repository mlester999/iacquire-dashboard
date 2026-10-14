"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertTriangle,
  Bell,
  ChevronRight,
  Search,
  Building2,
  CheckCheck,
  CheckCircle2,
  Info,
  LogOut,
  Menu as MenuIcon,
  Monitor,
  Moon,
  ShieldHalf,
  Sparkles,
  Sun,
  UserRound,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { ButtonLink } from "@/components/ui/button";
import { Input } from "@/components/ui/primitives";
import { Dialog, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Popover, PopoverContent, PopoverTrigger, Tooltip } from "@/components/ui/overlays";
import { CLIENT_NAV } from "@/components/shell/sidebar";
import { useTheme } from "@/components/providers";
import { useShell } from "@/components/shell/shell-context";
import { fetchNotificationsAction, markNotificationsReadAction, switchOrgAction } from "@/app/actions/shell";
import { logoutAction } from "@/app/(auth)/actions";
import { cn, initials, relativeTime } from "@/lib/utils";

const TITLES: Array<[RegExp, string]> = [
  [/^\/overview/, "Overview"],
  [/^\/setup/, "Setup"],
  [/^\/workforce\/[^/]+\/configure/, "Configure employee"],
  [/^\/workforce/, "AI Workforce"],
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
  [/^\/settings/, "Settings"],
  [/^\/add-ons/, "Custom Projects & Add-ons"],
  [/^\/projects/, "My Projects"],
  [/^\/our-work/, "Selected Work"],
  [/^\/maintenance/, "Maintenance"],
];

type NotificationItem = Awaited<ReturnType<typeof fetchNotificationsAction>>["items"][number];

const SEVERITY_ICON = {
  info: <Info className="size-4 text-primary" />,
  success: <CheckCircle2 className="size-4 text-success" />,
  warning: <AlertTriangle className="size-4 text-warning" />,
  critical: <XCircle className="size-4 text-danger" />,
} as Record<string, React.ReactNode>;

function NotificationsButton() {
  const shell = useShell();
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [items, setItems] = React.useState<NotificationItem[] | null>(null);
  const [unread, setUnread] = React.useState(shell.unreadNotifications);

  const load = React.useCallback(async () => {
    try {
      const res = await fetchNotificationsAction();
      setItems(res.items);
      setUnread(res.unread);
    } catch {
      /* keep previous state */
    }
  }, []);

  React.useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 60000);
    return () => clearInterval(t);
  }, [load]);

  const markAll = async () => {
    await markNotificationsReadAction("all");
    setUnread(0);
    setItems((prev) => prev?.map((n) => ({ ...n, read_at: n.read_at ?? new Date().toISOString() })) ?? null);
  };

  const openItem = async (n: NotificationItem) => {
    if (!n.read_at) {
      void markNotificationsReadAction([n.id]);
      setUnread((u) => Math.max(0, u - 1));
    }
    setOpen(false);
    if (n.link) router.push(n.link);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) void load();
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="relative flex size-10 items-center justify-center rounded-xl text-ink-2 transition hover:bg-surface-2 hover:text-ink"
          aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
        >
          <Bell className="size-[19px]" />
          <AnimatePresence>
            {unread > 0 && (
              <motion.span
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                exit={{ scale: 0 }}
                className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold text-white ring-2 ring-bg"
              >
                {unread > 9 ? "9+" : unread}
              </motion.span>
            )}
          </AnimatePresence>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(380px,calc(100vw-24px))] p-0">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <p className="text-[14px] font-semibold">Notifications</p>
          <button type="button" onClick={markAll} disabled={!unread} className="flex items-center gap-1.5 text-[12.5px] font-medium text-primary disabled:text-faint">
            <CheckCheck className="size-3.5" /> Mark all read
          </button>
        </div>
        <div className="scrollbar-thin max-h-[420px] overflow-y-auto p-1.5">
          {items === null ? (
            <div className="space-y-2 p-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="skeleton h-14 rounded-xl" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="px-6 py-10 text-center text-[13px] text-muted">You&apos;re all caught up.</div>
          ) : (
            items.map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => openItem(n)}
                className={cn("flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-surface-2", !n.read_at && "bg-primary-soft/50")}
              >
                <span className="mt-0.5">{SEVERITY_ICON[n.severity] ?? SEVERITY_ICON.info}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium leading-snug text-ink">{n.title}</span>
                  {n.body && <span className="mt-0.5 line-clamp-2 block text-[12.5px] text-muted">{n.body}</span>}
                  <span className="mt-1 block text-[11.5px] text-faint">{relativeTime(n.created_at)}</span>
                </span>
                {!n.read_at && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" aria-label="Unread" />}
              </button>
            ))
          )}
        </div>
        <div className="border-t border-line p-2">
          <Link href="/notifications" onClick={() => setOpen(false)} className="block rounded-lg py-2 text-center text-[13px] font-medium text-primary hover:bg-surface-2">
            View all activity
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}

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
        <NotificationsButton />

        <Menu>
          <MenuTrigger asChild>
            <button type="button" className="ml-0.5 flex items-center gap-2 rounded-xl p-1 pr-1.5 transition hover:bg-surface-2" aria-label="Account menu">
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
            <form action={logoutAction}>
              <button type="submit" className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] text-ink-2 hover:bg-surface-2 hover:text-ink">
                <LogOut className="size-4" /> Sign out
              </button>
            </form>
          </MenuContent>
        </Menu>
      </div>
      <Dialog open={navigationOpen} onOpenChange={setNavigationOpen} title="Jump to your workspace" description="Search the modules available to your account."><Input autoFocus aria-label="Search workspace modules" placeholder="Leads, AI Workforce, Support…" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && destinations[0]) { router.push(destinations[0].href); setNavigationOpen(false); } }} /><ul className="mt-3 space-y-1">{destinations.map((n) => <li key={n.href}><Link href={n.href} onClick={() => setNavigationOpen(false)} className="flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm text-ink hover:bg-primary-soft"><n.icon className="size-4 text-primary" />{n.label}</Link></li>)}</ul>{!destinations.length && <p className="py-8 text-center text-sm text-muted">No modules match your search.</p>}</Dialog>
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

