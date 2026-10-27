"use client";

import * as React from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { adminCrumbs, isNavActive } from "@/lib/admin-breadcrumb";
import { motion } from "motion/react";
import { Activity, ArrowLeftRight, BarChart3, Blocks, Boxes, Briefcase, Building2, ChevronDown, Contact, ChevronRight, Command, FolderKanban, Gauge, Handshake, HeartPulse, Inbox, Landmark, Layers, LogOut, Menu as MenuIcon, MessagesSquare, MonitorSmartphone, Moon, PanelLeftClose, PanelLeftOpen, ScrollText, Search, ShieldCheck, ShoppingBag, Sparkles, Sun, UserPlus, Users, Wallet, Wrench } from "lucide-react";
import { Logo } from "@/components/brand";
import { Dialog, Sheet, Tooltip } from "@/components/ui/overlays";
import { Input } from "@/components/ui/primitives";
import { LogoutTrigger } from "@/components/auth/logout-confirmation";
import { NotificationCenter } from "@/components/notifications/notification-center";
import { useTheme } from "@/components/providers";
import { aqiNavTarget } from "@/lib/aqi/targets";
import { useMessagesBadge } from "@/components/staff-messages/use-messages-badge";
import { navBadge, navLabel, showMessagesNav, type MessagesNavState } from "@/lib/staff-messages/nav";
import { cn, currentTime, initials } from "@/lib/utils";

const NAV = [
  { href: "/admin", label: "Dashboard", icon: Gauge, exact: true, group: "Operations" },
  // Super Admin only: the AI Platform Operations Copilot (investigations, evidence cards, confirmed actions, briefings).
  { href: "/admin/operations", label: "AQi Operations", icon: Activity, superOnly: true, group: "Operations" },
  // Super Admin only: AQi configuration, knowledge, budgets and publishing.
  { href: "/admin/aqi", label: "AQi Management", icon: Sparkles, superOnly: true, group: "Platform" },
  { href: "/admin/clients", label: "Clients", icon: Building2, group: "Operations" },
  { href: "/admin/crm", label: "Client CRMs", icon: Contact, exact: true, group: "Operations" },
  // Counts across clients (failures, setup, billing, support), never their contacts. The label is the page's own breadcrumb.
  { href: "/admin/crm/reports", label: "CRM operations", icon: BarChart3, group: "Operations" },
  // Reusable CRM configuration the agency builds once and applies to a client as an independent copy (never contacts or credentials).
  { href: "/admin/crm-blueprints", label: "CRM Blueprints", icon: Layers, group: "Operations" },
  { href: "/admin/employees", label: "AI Employees", icon: Sparkles, group: "Operations" },
  { href: "/admin/support", label: "Requests", icon: Inbox, group: "Operations" },
  // The agency team's own chat (agency.messages.use, and the module switched on by a Super Admin, who always sees the entry so the switch can be reached). It carries the unread badge.
  { href: "/admin/messages", label: "Messages", icon: MessagesSquare, messages: true, group: "Operations" },
  // The agency team's own load, from the work recorded in iAcquire. Visible to everyone on the agency team; the page itself shows only what the server allows.
  { href: "/admin/workload", label: "Staff workload", icon: Gauge, group: "Operations" },
  // Agency managers and Super Admins: the people who asked for a demo, before they are clients (agency.prospects.view; every page and action checks it again on the server).
  { href: "/admin/prospects", label: "Demo prospects", icon: Handshake, managerUp: true, group: "Operations" },
  // Managers and Super Admins: the frozen-price purchase path from an invited buyer to a created client workspace.
  { href: "/admin/purchase-intents", label: "Purchase intents", icon: ShoppingBag, managerUp: true, group: "Operations" },
  { href: "/admin/website-studio", label: "Website Studio", icon: MonitorSmartphone, group: "Client experience" },
  { href: "/admin/projects", label: "Custom projects", icon: FolderKanban, group: "Client experience" },
  { href: "/admin/maintenance", label: "Maintenance", icon: Wrench, group: "Client experience" },
  { href: "/admin/services", label: "Service catalog", icon: Boxes, superOnly: true, group: "Client experience" },
  { href: "/admin/portfolio", label: "Portfolio", icon: Briefcase, superOnly: true, group: "Client experience" },
  { href: "/admin/setup-templates", label: "Setup templates", icon: ScrollText, superOnly: true, group: "Platform" },
  { href: "/admin/integrations", label: "Integrations", icon: ArrowLeftRight, superOnly: true, group: "Platform" },
  { href: "/admin/inbox-rollout", label: "Inbox rollout", icon: Inbox, superOnly: true, group: "Platform" },
  // Super Admin only: switches proposals, signing, customer invoices and the reputation tools on per client workspace (each stays dormant until then).
  { href: "/admin/module-rollout", label: "Module rollout", icon: Blocks, superOnly: true, group: "Platform" },
  { href: "/admin/health", label: "System health", icon: HeartPulse, group: "Platform" },
  { href: "/admin/billing", label: "Billing & finance", icon: Landmark, group: "Platform" },
  { href: "/admin/usage", label: "Usage & costs", icon: Wallet, group: "Platform" },
  { href: "/admin/requests", label: "Access requests", icon: UserPlus, superOnly: true, group: "Platform" },
  { href: "/admin/team", label: "Agency team", icon: Users, superOnly: true, group: "Platform" },
  { href: "/admin/audit", label: "Audit log", icon: ScrollText, superOnly: true, group: "Platform" },
];
const GROUPS = ["Operations", "Client experience", "Platform"];

function Nav({ superAdmin, manager, messages, compact, onNavigate }: { superAdmin: boolean; manager: boolean; messages: { shown: boolean; badge: string | null; unread: number }; compact: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = React.useState<string[]>([]);
  return <nav aria-label="Agency navigation" className="space-y-4">{GROUPS.map((group) => {
    const items = NAV.filter((n) => n.group === group && (!n.superOnly || superAdmin) && (!n.managerUp || manager) && (!n.messages || messages.shown));
    const closed = !compact && collapsed.includes(group);
    if (!items.length) return null;
    return <div key={group}>
      {!compact && <button type="button" aria-expanded={!closed} className="workspace-nav-section flex min-h-8 w-full items-center justify-between px-3" onClick={() => setCollapsed((s) => s.includes(group) ? s.filter((g) => g !== group) : [...s, group])}>{group}<ChevronDown className={cn("size-3 transition-transform", closed && "-rotate-90")} /></button>}
      {!closed && <ul className="space-y-1">{items.map((n) => {
        const active = isNavActive(pathname, n.href, n.exact);
        const link = <Link href={n.href} onClick={onNavigate} data-aqi-target={aqiNavTarget(n.href, "agency")} aria-current={active ? "page" : undefined} aria-label={compact ? (n.messages ? navLabel(messages.unread) : n.label) : undefined} className={cn("workspace-nav-link group relative flex h-10 items-center gap-2 rounded-xl px-2 text-[14px] font-medium", compact && "justify-center")}>
          {active && <motion.span layoutId="admin-active" className="absolute inset-0 rounded-xl border border-[#5582ff]/25 bg-[#4268c6]/15" transition={{ type: "spring", stiffness: 460, damping: 38 }} />}
          <span className="nav-icon-box relative"><n.icon className="size-[17px]" /></span>{!compact && <span className="relative flex-1">{n.label}{n.messages && messages.unread > 0 && <span className="sr-only">, {messages.unread} unread</span>}</span>}{n.messages && messages.badge && <span data-testid="messages-badge" aria-hidden className={cn("relative min-w-5 rounded-full bg-[#305ecb] px-1.5 text-center text-[12px] font-semibold leading-5 text-white", compact && "absolute right-0.5 top-0.5 min-w-4 px-1 leading-4")}>{messages.badge}</span>}{active && !compact && <span className="relative size-1.5 rounded-full bg-[#91b1ff]" aria-hidden />}
        </Link>;
        return <li key={n.href}>{compact ? <Tooltip content={n.label}>{link}</Tooltip> : link}</li>;
      })}</ul>}
    </div>;
  })}</nav>;
}

export function AdminShell({ user, hasWorkspace, notifications, children, qaDemo = false, messages: messagesInitial }: { user: { name: string; email: string; platformRole: string }; hasWorkspace: boolean; notifications: { unread: number; timeZone: string }; children: React.ReactNode; qaDemo?: boolean; messages?: MessagesNavState }) {
  const [open, setOpen] = React.useState(false);
  const [compact, setCompact] = React.useState(false);
  const [commandOpen, setCommandOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const { resolved, setTheme } = useTheme();
  const superAdmin = user.platformRole === "agency_super_admin";
  const pathname = usePathname();
  const router = useRouter();
  const crumbs = adminCrumbs(pathname);
  const manager = superAdmin || user.platformRole === "agency_manager";
  // On the Messages pages the page itself says what is unread; elsewhere the badge asks for just the number every so often.
  const messagesNav = useMessagesBadge(messagesInitial, { paused: pathname.startsWith("/admin/messages") });
  const messages = { shown: showMessagesNav(messagesNav.state, user.platformRole), badge: navBadge(messagesNav.state, messagesNav.unread), unread: messagesNav.unread };
  const visibleNav = NAV.filter((n) => (!n.superOnly || superAdmin) && (!n.managerUp || manager) && (!n.messages || messages.shown) && n.label.toLowerCase().includes(query.toLowerCase()));
  React.useEffect(() => {
    const shortcut = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setCommandOpen((s) => !s); } };
    document.addEventListener("keydown", shortcut);
    return () => document.removeEventListener("keydown", shortcut);
  }, []);
  const sidebar = (small = false) => <div className="workspace-nav flex h-full flex-col text-white">
    <div className={cn("flex h-[76px] shrink-0 items-center px-5", small && "justify-center px-2")}>{small ? <Link href="/admin" aria-label="iAcquire dashboard"><Image src="/brand/iacquire-mark.png" alt="" width={1280} height={1280} sizes="36px" className="size-9 object-contain" /></Link> : <Link href="/admin" className="workspace-nav-brand -ml-1.5 inline-flex p-1.5" aria-label="iAcquire agency dashboard"><Logo tone="inverse" /></Link>}</div>
    {!small && <div className="mx-4 mb-4 rounded-xl border border-white/10 bg-white/[.035] px-3 py-2.5"><p className="flex items-center gap-2 text-[12px] font-semibold"><ShieldCheck className="size-3.5 text-[#9ebcff]" />Agency workspace</p><p className="mt-1 text-[12px] text-[#a6b3cd]">{superAdmin ? "Super admin access" : "Assigned client access"}</p></div>}
    <div className={cn("scrollbar-thin min-h-0 flex-1 overflow-y-auto px-3", small && "px-2")}><Nav superAdmin={superAdmin} manager={manager} messages={messages} compact={small} onNavigate={() => setOpen(false)} /></div>
    <div className="mt-3 space-y-2 border-t border-white/10 p-3">
      {hasWorkspace && <Link href="/overview" aria-label={small ? "Open client portal" : undefined} className={cn("workspace-nav-link flex min-h-10 items-center gap-3 rounded-xl px-3 text-[12px]", small && "justify-center px-1")}><ArrowLeftRight className="size-4 shrink-0" />{!small && "Client portal"}</Link>}
      <div className={cn("flex items-center gap-2 rounded-xl border border-white/10 bg-white/[.035] p-2", small && "flex-col border-0 bg-transparent p-0")}><span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-white/15 bg-[#263456] text-[12px] font-semibold">{initials(user.name)}</span>{!small && <div className="min-w-0 flex-1"><p className="truncate text-[12px] font-semibold">{user.name}</p><p className="mt-0.5 text-[12px] text-[#a6b3cd]">{superAdmin ? "Agency Super Admin" : "Agency Staff"}</p></div>}<LogoutTrigger className="flex size-9 items-center justify-center rounded-lg text-[#a6b3cd] hover:bg-white/10 hover:text-white" aria-label="Sign out"><LogOut className="size-4" /></LogoutTrigger></div>
      <button type="button" onClick={() => setCompact((s) => !s)} className="hidden min-h-8 w-full items-center justify-center gap-2 rounded-lg text-[12px] text-[#a6b3cd] hover:bg-white/5 lg:flex" aria-label={small ? "Expand navigation" : "Compact navigation"}>{small ? <PanelLeftOpen className="size-4" /> : <><PanelLeftClose className="size-3.5" /> Compact navigation</>}</button>
    </div>
  </div>;
  return <div className="app-backdrop min-h-dvh" style={{ "--admin-sidebar": compact ? "80px" : "248px" } as React.CSSProperties}>
    <a href="#admin-main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[80] focus:rounded-lg focus:bg-surface focus:p-3">Skip to content</a>
    <aside aria-label="Agency navigation" className="fixed inset-y-0 left-0 z-30 hidden w-[var(--admin-sidebar)] transition-[width] duration-200 lg:block">{sidebar(compact)}</aside>
    <Sheet open={open} onOpenChange={setOpen} side="left" title="Admin navigation" hideHeader className="!bg-[#0c101b]">{sidebar(false)}</Sheet>
    <div className="min-w-0 transition-[padding] duration-200 lg:pl-[var(--admin-sidebar)]">
      {qaDemo && <p className="border-b border-warning/20 bg-warning-soft px-4 py-2 text-center text-[12px] font-medium text-warning-ink">Local design review · synthetic records · external services disabled</p>}
      <header className="sticky top-0 z-20 flex h-16 min-w-0 items-center justify-between gap-3 border-b border-line bg-bg/90 px-4 backdrop-blur-lg sm:px-6 lg:px-8">
        <div className="flex min-w-0 items-center gap-3"><button type="button" onClick={() => setOpen(true)} className="flex size-10 shrink-0 items-center justify-center rounded-xl hover:bg-surface-2 lg:hidden" aria-label="Open admin navigation"><MenuIcon className="size-5" /></button><nav aria-label="Breadcrumb" className="min-w-0"><ol className="flex min-w-0 items-center gap-2 text-[12px]"><li className="hidden items-center gap-2 sm:flex"><Link href="/admin" className="text-muted hover:text-ink">Agency</Link><ChevronRight className="size-3 text-faint" aria-hidden /></li>{crumbs.map((crumb, i) => { const last = i === crumbs.length - 1; return <li key={`${crumb.label}-${i}`} className={cn("min-w-0 items-center gap-2", last ? "flex" : "hidden md:flex")}>{crumb.href ? <Link href={crumb.href} className="truncate text-muted hover:text-ink">{crumb.label}</Link> : <span aria-current={last ? "page" : undefined} className="truncate font-medium text-ink">{crumb.label}</span>}{!last && <ChevronRight className="size-3 shrink-0 text-faint" aria-hidden />}</li>; })}</ol></nav></div>
        <div className="flex shrink-0 items-center gap-2"><button type="button" onClick={() => { setQuery(""); setCommandOpen(true); }} className="flex h-9 items-center gap-2 rounded-xl border border-line bg-surface px-2.5 text-[12px] text-muted shadow-soft"><Search className="size-4" aria-hidden /><span className="sr-only">Search navigation</span><span className="hidden sm:block">Jump to…</span><kbd className="hidden rounded border border-line bg-surface-2 px-1.5 text-[12px] md:block">⌘ K</kbd></button><NotificationCenter initialUnread={notifications.unread} initialNow={currentTime()} timeZone={notifications.timeZone} viewAllHref="/admin/notifications" /><button type="button" onClick={() => setTheme(resolved === "light" ? "dark" : "light")} aria-label={`Switch to ${resolved === "light" ? "dark" : "light"} theme`} className="flex size-9 items-center justify-center rounded-xl border border-line bg-surface text-muted hover:text-ink">{resolved === "light" ? <Moon className="size-4" /> : <Sun className="size-4" />}</button><span className="hidden rounded-full border border-line bg-surface px-2.5 py-1.5 text-[12px] font-medium text-muted xl:block">{superAdmin ? "Super admin" : "Agency staff"}</span></div>
      </header>
      <main id="admin-main" key={pathname} className="page-in mx-auto w-full max-w-[1600px] overflow-x-clip px-4 pb-16 pt-6 sm:px-6 lg:px-8">{children}</main>
    </div>
    <Dialog open={commandOpen} onOpenChange={setCommandOpen} title={<span className="inline-flex items-center gap-2"><Command className="size-4 text-primary" /> Navigate your workspace</span>} description="Find an agency module. Results respect your access level." size="md">
      <Input autoFocus aria-label="Search agency modules" placeholder="Search clients, team, integrations…" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && visibleNav[0]) { router.push(visibleNav[0].href); setCommandOpen(false); } }} />
      <ul className="mt-3 space-y-1">{visibleNav.map((n) => <li key={n.href}><Link href={n.href} onClick={() => setCommandOpen(false)} className="flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm text-ink hover:bg-primary-soft"><n.icon className="size-4 text-primary" /><span className="flex-1">{n.label}</span><span className="text-[12px] text-muted">{n.group}</span></Link></li>)}</ul>{!visibleNav.length && <p className="py-8 text-center text-sm text-muted">No modules match your search.</p>}
    </Dialog>
  </div>;
}

export function AdminPageHeader({ title, description, action }: { title: string; description?: string; action?: React.ReactNode }) {
  return <div className="mb-6 flex flex-col justify-between gap-4 border-b border-line pb-5 sm:flex-row sm:items-end"><div className="min-w-0"><p className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-[.16em] text-primary-ink"><Activity className="size-3" /> iAcquire agency</p><h1 className="text-[27px] font-semibold tracking-[-0.045em] text-ink">{title}</h1>{description && <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-muted">{description}</p>}</div>{action && <div className="flex shrink-0 flex-wrap gap-2">{action}</div>}</div>;
}
