"use client";

import * as React from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { adminCrumbs } from "@/lib/admin-breadcrumb";
import { motion } from "motion/react";
import { Activity, ArrowLeftRight, Boxes, Briefcase, Building2, ChevronDown, Contact, ChevronRight, Command, FolderKanban, Gauge, HeartPulse, Inbox, Landmark, LogOut, Menu as MenuIcon, MonitorSmartphone, Moon, PanelLeftClose, PanelLeftOpen, ScrollText, Search, ShieldCheck, Sparkles, Sun, UserPlus, Users, Wallet, Wrench } from "lucide-react";
import { Logo } from "@/components/brand";
import { Dialog, Sheet, Tooltip } from "@/components/ui/overlays";
import { Input } from "@/components/ui/primitives";
import { useTheme } from "@/components/providers";
import { LogoutTrigger } from "@/components/auth/logout-confirmation";
import { cn, initials } from "@/lib/utils";

const NAV = [
  { href: "/admin", label: "Dashboard", icon: Gauge, exact: true, group: "Operations" },
  { href: "/admin/clients", label: "Clients", icon: Building2, group: "Operations" },
  { href: "/admin/crm", label: "Client CRMs", icon: Contact, group: "Operations" },
  { href: "/admin/workforce", label: "Internal Workforce", icon: Sparkles, exact: true, superOnly: true, group: "Operations" },
  { href: "/admin/workforce/clients", label: "Client Workforces", icon: Building2, exact: true, group: "Operations" },
  { href: "/admin/support", label: "Support inbox", icon: Inbox, group: "Operations" },
  { href: "/admin/website-studio", label: "Website Studio", icon: MonitorSmartphone, group: "Client experience" },
  { href: "/admin/projects", label: "Custom projects", icon: FolderKanban, group: "Client experience" },
  { href: "/admin/maintenance", label: "Maintenance", icon: Wrench, group: "Client experience" },
  { href: "/admin/services", label: "Service catalog", icon: Boxes, superOnly: true, group: "Client experience" },
  { href: "/admin/portfolio", label: "Portfolio", icon: Briefcase, superOnly: true, group: "Client experience" },
  { href: "/admin/setup-templates", label: "Setup templates", icon: ScrollText, superOnly: true, group: "Platform" },
  { href: "/admin/integrations", label: "Integrations", icon: ArrowLeftRight, superOnly: true, group: "Platform" },
  { href: "/admin/health", label: "System health", icon: HeartPulse, group: "Platform" },
  { href: "/admin/billing", label: "Billing & finance", icon: Landmark, group: "Platform" },
  { href: "/admin/usage", label: "Usage & costs", icon: Wallet, group: "Platform" },
  { href: "/admin/requests", label: "Access requests", icon: UserPlus, superOnly: true, group: "Platform" },
  { href: "/admin/team", label: "Agency team", icon: Users, superOnly: true, group: "Platform" },
  { href: "/admin/audit", label: "Audit log", icon: ScrollText, superOnly: true, group: "Platform" },
];
const GROUPS = ["Operations", "Client experience", "Platform"];

function Nav({ superAdmin, compact, onNavigate }: { superAdmin: boolean; compact: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = React.useState<string[]>([]);
  return <nav aria-label="Agency navigation" className="space-y-4">{GROUPS.map((group) => {
    const items = NAV.filter((n) => n.group === group && (!n.superOnly || superAdmin));
    const closed = !compact && collapsed.includes(group);
    if (!items.length) return null;
    return <div key={group}>
      {!compact && <button type="button" aria-expanded={!closed} className="workspace-nav-section flex min-h-8 w-full items-center justify-between px-3" onClick={() => setCollapsed((s) => s.includes(group) ? s.filter((g) => g !== group) : [...s, group])}>{group}<ChevronDown className={cn("size-3 transition-transform", closed && "-rotate-90")} /></button>}
      {!closed && <ul className="space-y-1">{items.map((n) => {
        const active = n.exact ? pathname === n.href : pathname.startsWith(n.href);
        const link = <Link href={n.href} onClick={onNavigate} aria-current={active ? "page" : undefined} aria-label={compact ? n.label : undefined} className={cn("workspace-nav-link group relative flex h-10 items-center gap-2 rounded-xl px-2 text-[13px] font-medium", compact && "justify-center")}>
          {active && <motion.span layoutId="admin-active" className="absolute inset-0 rounded-xl border border-[#5582ff]/25 bg-[#4268c6]/15" transition={{ type: "spring", stiffness: 460, damping: 38 }} />}
          <span className="nav-icon-box relative"><n.icon className="size-[17px]" /></span>{!compact && <span className="relative flex-1">{n.label}</span>}{active && !compact && <span className="relative size-1.5 rounded-full bg-[#91b1ff]" aria-hidden />}
        </Link>;
        return <li key={n.href}>{compact ? <Tooltip content={n.label}>{link}</Tooltip> : link}</li>;
      })}</ul>}
    </div>;
  })}</nav>;
}

export function AdminShell({ user, hasWorkspace, children, qaDemo = false }: { user: { name: string; email: string; platformRole: string }; hasWorkspace: boolean; children: React.ReactNode; qaDemo?: boolean }) {
  const [open, setOpen] = React.useState(false);
  const [compact, setCompact] = React.useState(false);
  const [commandOpen, setCommandOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const { resolved, setTheme } = useTheme();
  const superAdmin = user.platformRole === "agency_super_admin";
  const pathname = usePathname();
  const router = useRouter();
  const crumbs = adminCrumbs(pathname);
  const visibleNav = NAV.filter((n) => (!n.superOnly || superAdmin) && n.label.toLowerCase().includes(query.toLowerCase()));
  React.useEffect(() => {
    const shortcut = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setCommandOpen((s) => !s); } };
    document.addEventListener("keydown", shortcut);
    return () => document.removeEventListener("keydown", shortcut);
  }, []);
  const sidebar = (small = false) => <div className="workspace-nav flex h-full flex-col text-white">
    <div className={cn("flex h-[76px] shrink-0 items-center px-5", small && "justify-center px-2")}>{small ? <Link href="/admin" aria-label="iAcquire dashboard"><Image src="/brand/icon.svg" alt="" width={36} height={36} /></Link> : <Link href="/admin" className="[&_span]:!text-white" aria-label="iAcquire agency dashboard"><Logo /></Link>}</div>
    {!small && <div className="mx-4 mb-4 rounded-xl border border-white/10 bg-white/[.035] px-3 py-2.5"><p className="flex items-center gap-2 text-[12px] font-semibold"><ShieldCheck className="size-3.5 text-[#9ebcff]" />Agency workspace</p><p className="mt-1 text-[11px] text-[#a6b3cd]">{superAdmin ? "Super admin access" : "Assigned client access"}</p></div>}
    <div className={cn("scrollbar-thin min-h-0 flex-1 overflow-y-auto px-3", small && "px-2")}><Nav superAdmin={superAdmin} compact={small} onNavigate={() => setOpen(false)} /></div>
    <div className="mt-3 space-y-2 border-t border-white/10 p-3">
      {hasWorkspace && <Link href="/overview" aria-label={small ? "Open client portal" : undefined} className={cn("workspace-nav-link flex min-h-10 items-center gap-3 rounded-xl px-3 text-[12px]", small && "justify-center px-1")}><ArrowLeftRight className="size-4 shrink-0" />{!small && "Client portal"}</Link>}
      <div className={cn("flex items-center gap-2 rounded-xl border border-white/10 bg-white/[.035] p-2", small && "flex-col border-0 bg-transparent p-0")}><span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-white/15 bg-[#263456] text-[12px] font-semibold">{initials(user.name)}</span>{!small && <div className="min-w-0 flex-1"><p className="truncate text-[12px] font-semibold">{user.name}</p><p className="mt-0.5 text-[10px] text-[#a6b3cd]">{superAdmin ? "Agency Super Admin" : "Agency Staff"}</p></div>}<LogoutTrigger className="flex size-9 items-center justify-center rounded-lg text-[#a6b3cd] hover:bg-white/10 hover:text-white" aria-label="Sign out"><LogOut className="size-4" /></LogoutTrigger></div>
      <button type="button" onClick={() => setCompact((s) => !s)} className="hidden min-h-8 w-full items-center justify-center gap-2 rounded-lg text-[11px] text-[#a6b3cd] hover:bg-white/5 lg:flex" aria-label={small ? "Expand sidebar" : "Compact sidebar"}>{small ? <PanelLeftOpen className="size-4" /> : <><PanelLeftClose className="size-3.5" /> Compact navigation</>}</button>
    </div>
  </div>;
  return <div className="app-backdrop min-h-dvh" style={{ "--admin-sidebar": compact ? "80px" : "248px" } as React.CSSProperties}>
    <a href="#admin-main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[80] focus:rounded-lg focus:bg-surface focus:p-3">Skip to content</a>
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-[var(--admin-sidebar)] transition-[width] duration-200 lg:block">{sidebar(compact)}</aside>
    <Sheet open={open} onOpenChange={setOpen} side="left" title="Admin navigation" hideHeader className="!bg-[#0c101b]">{sidebar(false)}</Sheet>
    <div className="min-w-0 transition-[padding] duration-200 lg:pl-[var(--admin-sidebar)]">
      {qaDemo && <p className="border-b border-warning/20 bg-warning-soft px-4 py-2 text-center text-[11px] font-medium text-warning-ink">Local design review · synthetic records · external services disabled</p>}
      <header className="sticky top-0 z-20 flex h-16 min-w-0 items-center justify-between gap-3 border-b border-line bg-bg/90 px-4 backdrop-blur-lg sm:px-6 lg:px-8">
        <div className="flex min-w-0 items-center gap-3"><button type="button" onClick={() => setOpen(true)} className="flex size-10 shrink-0 items-center justify-center rounded-xl hover:bg-surface-2 lg:hidden" aria-label="Open admin navigation"><MenuIcon className="size-5" /></button><nav aria-label="Breadcrumb" className="min-w-0"><ol className="flex min-w-0 items-center gap-2 text-[12px]"><li className="hidden items-center gap-2 sm:flex"><Link href="/admin" className="text-muted hover:text-ink">Agency</Link><ChevronRight className="size-3 text-faint" aria-hidden /></li>{crumbs.map((crumb, i) => { const last = i === crumbs.length - 1; return <li key={`${crumb.label}-${i}`} className={cn("min-w-0 items-center gap-2", last ? "flex" : "hidden md:flex")}>{crumb.href ? <Link href={crumb.href} className="truncate text-muted hover:text-ink">{crumb.label}</Link> : <span aria-current={last ? "page" : undefined} className="truncate font-medium text-ink">{crumb.label}</span>}{!last && <ChevronRight className="size-3 shrink-0 text-faint" aria-hidden />}</li>; })}</ol></nav></div>
        <div className="flex shrink-0 items-center gap-2"><button type="button" onClick={() => { setQuery(""); setCommandOpen(true); }} className="flex h-9 items-center gap-2 rounded-xl border border-line bg-surface px-2.5 text-[12px] text-muted shadow-soft" aria-label="Search navigation"><Search className="size-4" /><span className="hidden sm:block">Jump to…</span><kbd className="hidden rounded border border-line bg-surface-2 px-1.5 text-[10px] md:block">⌘ K</kbd></button><button type="button" onClick={() => setTheme(resolved === "light" ? "dark" : "light")} aria-label={`Switch to ${resolved === "light" ? "dark" : "light"} theme`} className="flex size-9 items-center justify-center rounded-xl border border-line bg-surface text-muted hover:text-ink">{resolved === "light" ? <Moon className="size-4" /> : <Sun className="size-4" />}</button><span className="hidden rounded-full border border-line bg-surface px-2.5 py-1.5 text-[10px] font-medium text-muted xl:block">{superAdmin ? "Super admin" : "Agency staff"}</span></div>
      </header>
      <main id="admin-main" key={pathname} className="page-in mx-auto w-full max-w-[1600px] px-4 pb-16 pt-6 sm:px-6 lg:px-8">{children}</main>
    </div>
    <Dialog open={commandOpen} onOpenChange={setCommandOpen} title={<span className="inline-flex items-center gap-2"><Command className="size-4 text-primary" /> Navigate your workspace</span>} description="Find an agency module. Results respect your access level." size="md">
      <Input autoFocus aria-label="Search agency modules" placeholder="Search clients, team, integrations…" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && visibleNav[0]) { router.push(visibleNav[0].href); setCommandOpen(false); } }} />
      <ul className="mt-3 space-y-1">{visibleNav.map((n) => <li key={n.href}><Link href={n.href} onClick={() => setCommandOpen(false)} className="flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm text-ink hover:bg-primary-soft"><n.icon className="size-4 text-primary" /><span className="flex-1">{n.label}</span><span className="text-[11px] text-muted">{n.group}</span></Link></li>)}</ul>{!visibleNav.length && <p className="py-8 text-center text-sm text-muted">No modules match your search.</p>}
    </Dialog>
  </div>;
}

export function AdminPageHeader({ title, description, action }: { title: string; description?: string; action?: React.ReactNode }) {
  return <div className="mb-6 flex flex-col justify-between gap-4 border-b border-line pb-5 sm:flex-row sm:items-end"><div className="min-w-0"><p className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[.16em] text-primary-ink"><Activity className="size-3" /> iAcquire agency</p><h1 className="text-[27px] font-semibold tracking-[-0.045em] text-ink">{title}</h1>{description && <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-muted">{description}</p>}</div>{action && <div className="flex shrink-0 flex-wrap gap-2">{action}</div>}</div>;
}
