# Shared layouts

## src/components/shell/guided-tour.tsx

```tsx
"use client";

import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

const STEPS = [
  { target: "overview", title: "Your command center", body: "Overview shows leads, meetings, approvals and what your AI team is doing — using real data only." },
  { target: "workforce", title: "Meet your AI workforce", body: "Six AI employees, each set up for your business. Click one to chat, or open AI Workforce to configure them." },
  { target: "approvals", title: "You stay in control", body: "Anything that affects customers or your CRM waits here for your approval first." },
  { target: "settings", title: "Make it yours", body: "Invite your team, set AI preferences, and check integration status in Settings." },
  { target: "help", title: "Help is one click away", body: "Ask the iAcquire Assistant anything about the portal, or reach a real person on our team." },
];

const KEY = "iaq-tour-v1";

export function startTour() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
  window.dispatchEvent(new Event("iaq:start-tour"));
}

export function GuidedTour({ autoStart }: { autoStart: boolean }) {
  const [step, setStep] = React.useState<number | null>(null);
  const [rect, setRect] = React.useState<DOMRect | null>(null);

  React.useEffect(() => {
    const start = () => setStep(0);
    window.addEventListener("iaq:start-tour", start);
    let seen = true;
    try {
      seen = localStorage.getItem(KEY) === "done";
    } catch {
      /* storage unavailable */
    }
    const t = autoStart && !seen ? setTimeout(start, 900) : null;
    return () => {
      window.removeEventListener("iaq:start-tour", start);
      if (t) clearTimeout(t);
    };
  }, [autoStart]);

  const finish = React.useCallback(() => {
    setStep(null);
    try {
      localStorage.setItem(KEY, "done");
    } catch {
      /* storage unavailable */
    }
  }, []);

  React.useLayoutEffect(() => {
    if (step === null) return;
    const find = () => {
      const all = Array.from(document.querySelectorAll<HTMLElement>(`[data-tour="${STEPS[step].target}"]`));
      const el = all.find((e) => e.getBoundingClientRect().width > 0);
      setRect(el ? el.getBoundingClientRect() : null);
    };
    find();
    window.addEventListener("resize", find);
    window.addEventListener("scroll", find, true);
    return () => {
      window.removeEventListener("resize", find);
      window.removeEventListener("scroll", find, true);
    };
  }, [step]);

  React.useEffect(() => {
    if (step === null) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && finish();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, finish]);

  if (step === null) return null;
  const s = STEPS[step];
  const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const cardW = Math.min(320, vw - 32);
  let left = vw / 2 - cardW / 2;
  let top = vh / 2 - 90;
  if (rect) {
    const rightSpace = vw - rect.right;
    if (rightSpace > cardW + 24) {
      left = rect.right + 14;
      top = Math.min(Math.max(16, rect.top - 8), vh - 220);
    } else {
      left = Math.min(Math.max(16, rect.right - cardW), vw - cardW - 16);
      top = rect.top > 240 ? rect.top - 196 : rect.bottom + 14;
    }
  }

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-[70]" role="dialog" aria-modal="true" aria-labelledby="tour-title">
        <div className={rect ? "absolute inset-0" : "absolute inset-0 bg-black/45"} onClick={finish} aria-hidden />
        {rect && (
          <motion.div
            className="pointer-events-none absolute rounded-xl ring-2 ring-primary"
            style={{ boxShadow: "0 0 0 9999px rgba(5, 8, 20, 0.5)" }}
            initial={{ left: rect.left - 4, top: rect.top - 4, width: rect.width + 8, height: rect.height + 8, opacity: 0 }}
            animate={{ left: rect.left - 4, top: rect.top - 4, width: rect.width + 8, height: rect.height + 8, opacity: 1 }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
          />
        )}
        <motion.div
          key={step}
          className="absolute rounded-2xl border border-line bg-surface p-4 shadow-float"
          style={{ left, top, width: cardW }}
          initial={{ opacity: 0, y: 8, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ type: "spring", stiffness: 420, damping: 32 }}
        >
          <div className="flex items-start justify-between gap-3">
            <p className="text-[11.5px] font-medium uppercase tracking-wider text-primary">
              Step {step + 1} of {STEPS.length}
            </p>
            <button type="button" onClick={finish} className="-mr-1 -mt-1 rounded-lg p-1 text-muted hover:bg-surface-2" aria-label="Skip tour">
              <X className="size-4" />
            </button>
          </div>
          <h2 id="tour-title" className="mt-1 text-[15px] font-semibold text-ink">
            {s.title}
          </h2>
          <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted">{s.body}</p>
          <div className="mt-4 flex items-center justify-between">
            <div className="flex gap-1">
              {STEPS.map((_, i) => (
                <span key={i} className={`h-1.5 rounded-full transition-all ${i === step ? "w-4 bg-primary" : "w-1.5 bg-surface-3"}`} />
              ))}
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={finish}>
                Skip
              </Button>
              <Button size="sm" variant="brand" onClick={() => (step + 1 < STEPS.length ? setStep(step + 1) : finish())} autoFocus>
                {step + 1 < STEPS.length ? "Next" : "Done"}
              </Button>
            </div>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}

```

## src/components/shell/portal-shell.tsx

```tsx
"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { ShellProvider } from "@/components/shell/shell-context";
import { Sidebar } from "@/components/shell/sidebar";
import { DemoBanner, SetupBanner, Topbar } from "@/components/shell/topbar";
import { Sheet } from "@/components/ui/overlays";
import { HelpWidget } from "@/components/help/help-widget";
import { GuidedTour } from "@/components/shell/guided-tour";
import { firstName } from "@/lib/utils";
import type { ShellData } from "@/server/queries/shell";

export function PortalShell({ data, children }: { data: ShellData; children: React.ReactNode }) {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const pathname = usePathname();
  const showSetup = !data.org.onboardingComplete && data.org.kind === "client" && data.permissions.includes("workspace.manage_profile") && !pathname.startsWith("/onboarding");

  return (
    <ShellProvider value={data}>
      <div className="app-backdrop grain relative min-h-dvh">
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[80] focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2 focus:shadow-float">
          Skip to content
        </a>
        <aside className="fixed inset-y-0 left-0 z-30 hidden w-[var(--sidebar-w)] border-r border-line bg-surface/70 backdrop-blur-xl lg:block">
          <Sidebar />
        </aside>
        <Sheet open={menuOpen} onOpenChange={setMenuOpen} side="left" title="Navigation" hideHeader>
          <Sidebar onNavigate={() => setMenuOpen(false)} />
        </Sheet>

        <div className="relative z-10 lg:pl-[var(--sidebar-w)]">
          {data.org.isDemo && <DemoBanner />}
          <Topbar onOpenMenu={() => setMenuOpen(true)} />
          {showSetup && <SetupBanner />}
          <main id="main" key={pathname} className="page-in mx-auto w-full max-w-[1440px] px-4 pb-28 pt-6 sm:px-6 lg:px-8 lg:pt-8">
            {children}
          </main>
        </div>
        <HelpWidget firstName={firstName(data.user.name)} canOpenTickets={data.permissions.includes("support.use")} aiAvailable={data.helpAiAvailable} />
        <GuidedTour autoStart={data.org.onboardingComplete} />
      </div>
    </ShellProvider>
  );
}

```

## src/components/shell/shell-context.tsx

```tsx
"use client";

import * as React from "react";
import type { ShellData } from "@/server/queries/shell";
import type { Permission } from "@/lib/permissions";

const ShellContext = React.createContext<ShellData | null>(null);

export function ShellProvider({ value, children }: { value: ShellData; children: React.ReactNode }) {
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

export function useShell() {
  const v = React.useContext(ShellContext);
  if (!v) throw new Error("useShell must be used inside the portal shell");
  return v;
}

export function useCan() {
  const shell = React.useContext(ShellContext);
  return React.useCallback((p: Permission) => Boolean(shell?.permissions.includes(p)), [shell]);
}

```

## src/components/shell/sidebar.tsx

```tsx
"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import {
  Activity,
  BarChart3,
  ClipboardCheck,
  BookOpen,
  CalendarDays,
  ChevronDown,
  HeartHandshake,
  KanbanSquare,
  LayoutDashboard,
  LifeBuoy,
  Radar,
  Settings,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { AgentAvatar, Logo, StatusDot } from "@/components/brand";
import { AGENT_BY_KEY } from "@/lib/agents";
import { cn } from "@/lib/utils";
import { useShell } from "@/components/shell/shell-context";
import type { Permission } from "@/lib/permissions";

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  permission?: Permission;
  badge?: "approvals";
  tour?: string;
}

const MAIN: NavItem[] = [
  { href: "/overview", label: "Overview", icon: LayoutDashboard, tour: "overview" },
  { href: "/leads", label: "Leads", icon: Radar, permission: "leads.view" },
  { href: "/appointments", label: "Appointments", icon: CalendarDays, permission: "appointments.view" },
  { href: "/sales", label: "Sales Pipeline", icon: KanbanSquare, permission: "sales.view" },
  { href: "/retention", label: "Customer Retention", icon: HeartHandshake, permission: "retention.view" },
  { href: "/analytics", label: "Analytics", icon: BarChart3, permission: "analytics.view" },
  { href: "/approvals", label: "Approvals", icon: ShieldCheck, permission: "approvals.view", badge: "approvals", tour: "approvals" },
  { href: "/knowledge", label: "Knowledge Center", icon: BookOpen, permission: "knowledge.view" },
  { href: "/activity", label: "Activity", icon: Activity },
];

const FOOTER: NavItem[] = [
  { href: "/support", label: "Support", icon: LifeBuoy, permission: "support.use" },
  { href: "/settings", label: "Settings", icon: Settings, tour: "settings" },
];

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavLink({ item, pathname, count, trailing, onNavigate }: { item: NavItem; pathname: string; count?: number; trailing?: string; onNavigate?: () => void }) {
  const active = isActive(pathname, item.href);
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      data-tour={item.tour}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex h-9 items-center gap-3 rounded-xl px-3 text-[13.5px] font-medium transition-colors",
        active ? "text-ink" : "text-muted hover:text-ink",
      )}
    >
      {active && (
        <motion.span
          layoutId="nav-active"
          className="absolute inset-0 rounded-xl border border-line bg-surface shadow-soft"
          transition={{ type: "spring", stiffness: 520, damping: 40 }}
        />
      )}
      {active && <motion.span layoutId="nav-bar" className="absolute -left-3 top-2 h-5 w-[3px] rounded-r-full bg-primary" />}
      <span className="absolute inset-0 rounded-xl bg-surface-2 opacity-0 transition-opacity group-hover:opacity-100 [[aria-current=page]_&]:hidden" />
      <Icon className={cn("relative size-[18px] shrink-0 transition-transform duration-200 group-hover:scale-110", active ? "text-primary" : "")} />
      <span className="relative flex-1 truncate">{item.label}</span>
      {count ? (
        <span className="relative flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-white">
          {count > 99 ? "99+" : count}
        </span>
      ) : trailing ? (
        <span className="relative text-[11.5px] font-medium tabular-nums text-faint">{trailing}</span>
      ) : null}
    </Link>
  );
}

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const shell = useShell();
  const can = (p?: Permission) => !p || shell.permissions.includes(p);
  const [open, setOpen] = React.useState(true);
  const workforceActive = pathname.startsWith("/workforce") || pathname.startsWith("/chat");
  const visibleAgents = shell.agents.filter((a) => a.enabled);

  return (
    <nav aria-label="Main" className="flex h-full flex-col">
      <div className="flex h-16 shrink-0 items-center px-5">
        <Link href="/overview" onClick={onNavigate} aria-label="iAcquire overview">
          <Logo />
        </Link>
      </div>

      <div className="px-3 pb-2">
        <div className="rounded-xl border border-line bg-surface-2/60 px-3 py-2">
          <p className="truncate text-[13px] font-semibold text-ink">{shell.org.name}</p>
          <p className="truncate text-[11.5px] capitalize text-muted">{shell.org.role} workspace</p>
        </div>
      </div>

      <div className="scrollbar-thin flex-1 space-y-0.5 overflow-y-auto px-3 py-2">
        <NavLink item={MAIN[0]} pathname={pathname} onNavigate={onNavigate} />
        {shell.setup.visible && (
          <NavLink
            item={{ href: "/setup", label: "Setup", icon: ClipboardCheck, tour: "setup" }}
            pathname={pathname}
            onNavigate={onNavigate}
            count={shell.setup.needsAttention || undefined}
            trailing={shell.setup.percent === null ? undefined : `${shell.setup.percent}%`}
          />
        )}

        <div data-tour="workforce">
          <div className="flex items-center gap-1">
            <Link
              href="/workforce"
              onClick={onNavigate}
              aria-current={pathname === "/workforce" ? "page" : undefined}
              className={cn(
                "group relative flex h-9 flex-1 items-center gap-3 rounded-xl px-3 text-[13.5px] font-medium transition-colors",
                workforceActive ? "text-ink" : "text-muted hover:text-ink",
              )}
            >
              {pathname === "/workforce" && (
                <motion.span layoutId="nav-active" className="absolute inset-0 rounded-xl border border-line bg-surface shadow-soft" transition={{ type: "spring", stiffness: 520, damping: 40 }} />
              )}
              {pathname === "/workforce" && <motion.span layoutId="nav-bar" className="absolute -left-3 top-2 h-5 w-[3px] rounded-r-full bg-primary" />}
              <Sparkles className={cn("relative size-[18px] transition-transform group-hover:scale-110", workforceActive && "text-primary")} />
              <span className="relative">AI Workforce</span>
            </Link>
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              className="flex size-8 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink"
              aria-expanded={open}
              aria-label={open ? "Collapse AI employees" : "Expand AI employees"}
            >
              <ChevronDown className={cn("size-4 transition-transform duration-200", !open && "-rotate-90")} />
            </button>
          </div>
          <AnimatePresence initial={false}>
            {open && (
              <motion.ul
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                className="ml-4 space-y-0.5 overflow-hidden border-l border-line pl-2"
              >
                {visibleAgents.map((agent) => {
                  const meta = AGENT_BY_KEY[agent.role];
                  const href = `/chat/${meta.slug}`;
                  const active = pathname.startsWith(href) || pathname.startsWith(`/workforce/${meta.slug}`);
                  return (
                    <li key={agent.role}>
                      <Link
                        href={href}
                        onClick={onNavigate}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "group relative flex h-9 items-center gap-2.5 rounded-lg px-2 text-[13px] transition-colors",
                          active ? "bg-surface font-medium text-ink shadow-soft ring-1 ring-line" : "text-muted hover:bg-surface-2 hover:text-ink",
                        )}
                      >
                        <AgentAvatar role={meta} size="xs" />
                        <span className="min-w-0 flex-1 truncate">{agent.displayName}</span>
                        <StatusDot status={agent.status} />
                        <span className="sr-only">{agent.status.replace("_", " ")}</span>
                      </Link>
                    </li>
                  );
                })}
              </motion.ul>
            )}
          </AnimatePresence>
        </div>

        {MAIN.slice(1)
          .filter((i) => can(i.permission))
          .map((item) => (
            <NavLink key={item.href} item={item} pathname={pathname} onNavigate={onNavigate} count={item.badge === "approvals" ? shell.pendingApprovals : undefined} />
          ))}
      </div>

      <div className="space-y-0.5 border-t border-line px-3 py-3">
        {FOOTER.filter((i) => can(i.permission)).map((item) => (
          <NavLink key={item.href} item={item} pathname={pathname} onNavigate={onNavigate} />
        ))}
      </div>
    </nav>
  );
}

```

## src/components/shell/topbar.tsx

```tsx
"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertTriangle,
  Bell,
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
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Popover, PopoverContent, PopoverTrigger, Tooltip } from "@/components/ui/overlays";
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
  const title = TITLES.find(([re]) => re.test(pathname))?.[1] ?? "iAcquire";

  const switchOrg = async (id: string) => {
    const res = await switchOrgAction(id);
    if (!res.ok) toast.error(res.error);
    else router.push("/overview");
  };

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-bg/80 backdrop-blur-xl supports-[backdrop-filter]:bg-bg/70">
      <div className="mx-auto flex h-16 max-w-[1440px] items-center gap-2 px-4 sm:px-6 lg:px-8">
        <button
          type="button"
          onClick={onOpenMenu}
          className="-ml-1 flex size-10 items-center justify-center rounded-xl text-ink-2 hover:bg-surface-2 lg:hidden"
          aria-label="Open navigation"
        >
          <MenuIcon className="size-5" />
        </button>
        <h1 className="min-w-0 flex-1 truncate text-[16px] font-semibold tracking-tight text-ink sm:text-[17px]">{title}</h1>

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
    </header>
  );
}

export function DemoBanner() {
  return (
    <div className="border-b border-violet/20 bg-violet-soft px-4 py-2 text-center text-[12.5px] font-medium text-violet-ink">
      Demo workspace — the records here are fictional sample data for previewing the portal, not live business results.
    </div>
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


```

## src/components/admin/admin-shell.tsx

```tsx
"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "motion/react";
import {
  Activity,
  ArrowLeftRight,
  Building2,
  Gauge,
  HeartPulse,
  Inbox,
  LogOut,
  Menu as MenuIcon,
  ScrollText,
  Sparkles,
  UserPlus,
  Users,
  Wallet,
} from "lucide-react";
import { Logo } from "@/components/brand";
import { Sheet } from "@/components/ui/overlays";
import { logoutAction } from "@/app/(auth)/actions";
import { cn, initials } from "@/lib/utils";

const NAV = [
  { href: "/admin", label: "Dashboard", icon: Gauge, exact: true },
  { href: "/admin/clients", label: "Clients", icon: Building2 },
  { href: "/admin/workforce", label: "AI Workforce", icon: Sparkles },
  { href: "/admin/support", label: "Support inbox", icon: Inbox },
  { href: "/admin/health", label: "System health", icon: HeartPulse },
  { href: "/admin/usage", label: "Usage & costs", icon: Wallet },
  { href: "/admin/requests", label: "Access requests", icon: UserPlus, superOnly: true },
  { href: "/admin/team", label: "Agency team", icon: Users, superOnly: true },
  { href: "/admin/audit", label: "Audit log", icon: ScrollText, superOnly: true },
];

function Nav({ superAdmin, onNavigate }: { superAdmin: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <ul className="space-y-0.5">
      {NAV.filter((n) => !n.superOnly || superAdmin).map((n) => {
        const active = n.exact ? pathname === n.href : pathname.startsWith(n.href);
        return (
          <li key={n.href}>
            <Link
              href={n.href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cn("group relative flex h-9 items-center gap-3 rounded-xl px-3 text-[13.5px] font-medium transition-colors", active ? "text-white" : "text-white/60 hover:text-white")}
            >
              {active && <motion.span layoutId="admin-active" className="absolute inset-0 rounded-xl bg-white/10 ring-1 ring-white/10" transition={{ type: "spring", stiffness: 520, damping: 40 }} />}
              <n.icon className="relative size-[18px]" />
              <span className="relative">{n.label}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function AdminShell({
  user,
  hasWorkspace,
  children,
}: {
  user: { name: string; email: string; platformRole: string };
  hasWorkspace: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const superAdmin = user.platformRole === "agency_super_admin";
  const pathname = usePathname();
  const sidebar = (
    <div className="flex h-full flex-col bg-[#0a0c12] text-white">
      <div className="flex h-16 items-center gap-2 px-5">
        <span className="[&_span]:!text-white">
          <Logo />
        </span>
        <span className="rounded-md bg-white/10 px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-white/70">Admin</span>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-2">
        <Nav superAdmin={superAdmin} onNavigate={() => setOpen(false)} />
      </div>
      <div className="space-y-1 border-t border-white/10 p-3">
        {hasWorkspace && (
          <Link href="/overview" className="flex h-9 items-center gap-3 rounded-xl px-3 text-[13px] text-white/60 hover:bg-white/5 hover:text-white">
            <ArrowLeftRight className="size-4" /> Client portal
          </Link>
        )}
        <div className="flex items-center gap-3 rounded-xl px-2 py-2">
          <span className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-violet text-[12px] font-semibold">{initials(user.name)}</span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium">{user.name}</p>
            <p className="truncate text-[11.5px] text-white/50">{superAdmin ? "Super admin" : "Agency staff"}</p>
          </div>
          <form action={logoutAction}>
            <button type="submit" className="flex size-8 items-center justify-center rounded-lg text-white/60 hover:bg-white/10 hover:text-white" aria-label="Sign out">
              <LogOut className="size-4" />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
  return (
    <div className="app-backdrop min-h-dvh">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[248px] lg:block">{sidebar}</aside>
      <Sheet open={open} onOpenChange={setOpen} side="left" title="Admin navigation" hideHeader className="!bg-[#0a0c12]">
        {sidebar}
      </Sheet>
      <div className="lg:pl-[248px]">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-line bg-bg/80 px-4 backdrop-blur-xl lg:hidden">
          <button type="button" onClick={() => setOpen(true)} className="flex size-10 items-center justify-center rounded-xl hover:bg-surface-2" aria-label="Open admin navigation">
            <MenuIcon className="size-5" />
          </button>
          <span className="flex items-center gap-2 text-[15px] font-semibold">
            <Activity className="size-4 text-primary" /> iAcquire Admin
          </span>
        </header>
        <main key={pathname} className="page-in mx-auto w-full max-w-[1400px] px-4 pb-20 pt-6 sm:px-6 lg:px-8 lg:pt-8">
          {children}
        </main>
      </div>
    </div>
  );
}

export function AdminPageHeader({ title, description, action }: { title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
      <div className="min-w-0">
        <h1 className="text-[24px] font-semibold tracking-[-0.02em] text-ink">{title}</h1>
        {description && <p className="mt-1 text-[14px] text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}

```

## src/app/layout.tsx

```tsx
import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import { Providers } from "@/components/providers";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist", display: "swap" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono", display: "swap" });
const instrument = Instrument_Serif({ subsets: ["latin"], weight: "400", style: ["normal", "italic"], variable: "--font-instrument", display: "swap" });

export const metadata: Metadata = {
  title: { default: "iAcquire Client Portal", template: "%s · iAcquire" },
  description: "Manage leads, appointments, sales and customer relationships with a team of AI employees built around your business.",
  robots: { index: false, follow: false },
  icons: { icon: "/brand/icon.svg" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f6fa" },
    { media: "(prefers-color-scheme: dark)", color: "#07080c" },
  ],
};

// Applies the saved theme before first paint to avoid a flash. Light is the default.
const themeScript = `(function(){try{var t=localStorage.getItem('iaq-theme');var d=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.dataset.theme=d?'dark':'light';}catch(e){document.documentElement.dataset.theme='light';}})();`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Per-request CSP nonce issued by src/proxy.ts.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning className={`${geist.variable} ${geistMono.variable} ${instrument.variable}`}>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-dvh">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

```

## src/app/(portal)/layout.tsx

```tsx
import { requireOrgContext } from "@/server/tenancy/context";
import { getShellData } from "@/server/queries/shell";
import { helpAiAvailable } from "@/server/help/service";
import { PortalShell } from "@/components/shell/portal-shell";

export const dynamic = "force-dynamic";

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireOrgContext();
  const data = await getShellData(ctx, helpAiAvailable());
  return <PortalShell data={data}>{children}</PortalShell>;
}

```
