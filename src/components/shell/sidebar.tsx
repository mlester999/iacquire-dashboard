"use client";
import * as React from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { Activity, BarChart3, Boxes, Inbox as InboxIcon, Briefcase, ClipboardCheck, Contact, FolderKanban, BookOpen, CalendarDays, ChevronDown, Globe, HeartHandshake, KanbanSquare, LayoutDashboard, LifeBuoy, ListChecks, PanelLeftClose, PanelLeftOpen, Radar, Settings, ShieldCheck, Sparkles, Waypoints, Wrench } from "lucide-react";
import { AgentAvatar, Logo, StatusDot } from "@/components/brand";
import { Tooltip } from "@/components/ui/overlays";
import { AGENT_BY_KEY } from "@/lib/agents";
import { cn, initials } from "@/lib/utils";
import { useShell } from "@/components/shell/shell-context";
import type { Permission } from "@/lib/permissions";

interface NavItem { href: string; label: string; icon: React.ComponentType<{ className?: string }>; permission?: Permission; badge?: "approvals" | "projects" | "inbox"; tour?: string; }
const MAIN: NavItem[] = [
  { href: "/overview", label: "Overview", icon: LayoutDashboard, tour: "overview" },
  { href: "/inbox", label: "Inbox", icon: InboxIcon, permission: "inbox.view", badge: "inbox" },
  { href: "/leads", label: "Leads", icon: Radar, permission: "leads.view" },
  { href: "/appointments", label: "Appointments", icon: CalendarDays, permission: "appointments.view" },
  { href: "/sales", label: "Sales Pipeline", icon: KanbanSquare, permission: "sales.view" },
  { href: "/retention", label: "Customer Retention", icon: HeartHandshake, permission: "retention.view" },
  { href: "/analytics", label: "Analytics", icon: BarChart3, permission: "analytics.view" },
  { href: "/approvals", label: "Approvals", icon: ShieldCheck, permission: "approvals.view", badge: "approvals", tour: "approvals" },
  { href: "/knowledge", label: "Knowledge Center", icon: BookOpen, permission: "knowledge.view" },
  { href: "/website", label: "Website", icon: Globe, permission: "website.view" },
  { href: "/activity", label: "Activity", icon: Activity },
];
// Native CRM. "Sales Pipeline" (/sales) is the GoHighLevel read-only view and is shown only where GoHighLevel owns the pipeline.
const CRM: NavItem[] = [
  { href: "/crm/contacts", label: "Contacts", icon: Contact, permission: "contacts.view" },
  { href: "/crm/pipelines", label: "Pipelines", icon: KanbanSquare, permission: "sales.view" },
  { href: "/crm/tasks", label: "Tasks", icon: ListChecks, permission: "crm.view" },
  { href: "/crm", label: "All CRM tools", icon: Waypoints, permission: "crm.view" },
];
const GROW: NavItem[] = [
  { href: "/add-ons", label: "Custom Projects & Add-ons", icon: Boxes, permission: "projects.view", tour: "add-ons" },
  { href: "/projects", label: "My Projects", icon: FolderKanban, permission: "projects.view", badge: "projects" },
  { href: "/our-work", label: "Selected Work", icon: Briefcase, permission: "projects.view" },
  { href: "/maintenance", label: "Maintenance", icon: Wrench, permission: "maintenance.view" },
];
const FOOTER: NavItem[] = [
  { href: "/support", label: "Support", icon: LifeBuoy, permission: "support.use" },
  { href: "/settings", label: "Settings", icon: Settings, tour: "settings" },
];
export const CLIENT_NAV = [...MAIN, ...CRM, { href: "/workforce", label: "AI Workforce", icon: Sparkles }, { href: "/setup", label: "Setup Center", icon: ClipboardCheck }, ...GROW, ...FOOTER] as NavItem[];
function NavLink({ item, pathname, count, trailing, onNavigate, compact = false }: { item: NavItem; pathname: string; count?: number; trailing?: string; onNavigate?: () => void; compact?: boolean }) {
  const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
  const link = <Link href={item.href} onClick={onNavigate} data-tour={item.tour} aria-current={active ? "page" : undefined} aria-label={compact ? item.label : undefined} className={cn("workspace-nav-link group relative flex h-10 items-center gap-2 rounded-xl px-2 text-[13px] font-medium", compact && "justify-center")}>
    {active && <motion.span layoutId="client-nav-active" className="absolute inset-0 rounded-xl border border-[#5582ff]/25 bg-[#4268c6]/15" transition={{ type: "spring", stiffness: 460, damping: 38 }} />}
    <span className="nav-icon-box relative"><item.icon className="size-[17px]" /></span>
    {!compact && <><span className="relative min-w-0 flex-1 truncate">{item.label}</span>{count ? <span className="relative flex min-w-5 items-center justify-center rounded-md bg-[#305ecb] px-1.5 py-0.5 text-[10px] font-semibold text-white">{count > 99 ? "99+" : count}</span> : trailing ? <span className="relative text-[11px] tabular-nums text-[#a9bada]">{trailing}</span> : null}</>}
  </Link>;
  return compact ? <Tooltip content={item.label}>{link}</Tooltip> : link;
}
export function Sidebar({ onNavigate, compact = false, onCompact }: { onNavigate?: () => void; compact?: boolean; onCompact?: () => void }) {
  const pathname = usePathname();
  const shell = useShell();
  const can = (p?: Permission) => !p || shell.permissions.includes(p);
  const [open, setOpen] = React.useState(true);
  const [growOpen, setGrowOpen] = React.useState(true);
  const [crmOpen, setCrmOpen] = React.useState(true);
  const crmMode = shell.crmMode;
  // Native CRM pipelines replace the GoHighLevel pipeline view; a hybrid workspace keeps both while it migrates.
  const showMain = (i: NavItem) => can(i.permission) && !(i.href === "/sales" && crmMode === "native");
  const crmItems = CRM.filter((i) => can(i.permission) && crmMode !== null && !(i.href === "/crm/pipelines" && crmMode === "ghl"));
  // "All CRM tools" is highlighted only for CRM pages that have no entry of their own here.
  const crmActivePath = (item: NavItem) => (item.href === "/crm" && crmItems.some((i) => i.href !== "/crm" && (pathname === i.href || pathname.startsWith(`${i.href}/`))) ? "" : pathname);
  const visibleAgents = shell.agents.filter((a) => a.enabled);
  return <nav aria-label="Main" className="workspace-nav flex h-full flex-col text-white">
    <div className={cn("flex h-[76px] shrink-0 items-center px-5", compact && "justify-center px-2")}><Link href="/overview" onClick={onNavigate} aria-label="iAcquire overview" className="[&_span]:!text-white">{compact ? <Image src="/brand/icon.svg" alt="" width={36} height={36} /> : <Logo />}</Link></div>
    {!compact && <div className="mx-4 mb-3 rounded-xl border border-white/10 bg-white/[.035] px-3 py-2.5"><p className="truncate text-[12px] font-semibold text-white">{shell.org.name}</p><p className="mt-1 text-[10px] capitalize text-[#a6b3cd]">{shell.org.role} workspace</p></div>}
    <div className={cn("scrollbar-thin min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-3", compact && "px-2")}>
      <NavLink item={MAIN[0]} pathname={pathname} onNavigate={onNavigate} compact={compact} />
      {shell.setup.visible && <NavLink item={{ href: "/setup", label: "Setup Center", icon: ClipboardCheck, tour: "setup" }} pathname={pathname} onNavigate={onNavigate} count={shell.setup.needsAttention || undefined} trailing={shell.setup.percent === null ? undefined : `${shell.setup.percent}%`} compact={compact} />}
      <div data-tour="workforce" className="pb-2"><div className="flex items-center gap-1"><div className="min-w-0 flex-1"><NavLink item={{ href: "/workforce", label: "AI Workforce", icon: Sparkles }} pathname={pathname} onNavigate={onNavigate} compact={compact} /></div>{!compact && <button type="button" onClick={() => setOpen((o) => !o)} className="flex size-9 items-center justify-center rounded-lg text-[#a6b3cd] hover:bg-white/5 hover:text-white" aria-expanded={open} aria-label={open ? "Collapse AI employees" : "Expand AI employees"}><ChevronDown className={cn("size-3.5 transition-transform duration-200", !open && "-rotate-90")} /></button>}</div>
        <AnimatePresence initial={false}>{open && !compact && <motion.ul initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: .22 }} className="ml-5 space-y-1 overflow-hidden border-l border-white/10 pl-2">{visibleAgents.map((agent) => {
          const meta = AGENT_BY_KEY[agent.role]; const href = `/chat/${meta.slug}`; const active = pathname.startsWith(href) || pathname.startsWith(`/workforce/${meta.slug}`);
          return <li key={agent.role}><Link href={href} onClick={onNavigate} aria-current={active ? "page" : undefined} className={cn("group flex min-h-9 items-center gap-2 rounded-lg px-2 text-[12px] transition-colors", active ? "bg-[#4268c6]/15 font-medium text-white" : "text-[#a6b3cd] hover:bg-white/5 hover:text-white")}><AgentAvatar role={meta} size="xs" /><span className="min-w-0 flex-1 truncate">{agent.displayName}</span><StatusDot status={agent.status} /><span className="sr-only">{agent.status.replaceAll("_", " ")}</span></Link></li>;
        })}</motion.ul>}</AnimatePresence>
      </div>
      {crmItems.length > 0 && <div className="space-y-1 pb-2">{!compact && <button type="button" onClick={() => setCrmOpen((s) => !s)} aria-expanded={crmOpen} className="workspace-nav-section flex min-h-8 w-full items-center justify-between px-3">CRM<ChevronDown className={cn("size-3 transition-transform", !crmOpen && "-rotate-90")} /></button>}{(crmOpen || compact) && crmItems.map((item) => <NavLink key={item.href} item={item} pathname={crmActivePath(item)} onNavigate={onNavigate} compact={compact} />)}</div>}
      {!compact && <p className="workspace-nav-section px-3 pb-1 pt-2">Business operations</p>}
      {MAIN.slice(1).filter(showMain).map((item) => <NavLink key={item.href} item={item} pathname={pathname} onNavigate={onNavigate} compact={compact} count={item.badge === "approvals" ? shell.pendingApprovals : item.badge === "inbox" ? shell.inboxAttention : undefined} />)}
      {GROW.some((i) => can(i.permission)) && <div className="space-y-1 pt-3">{!compact && <button type="button" onClick={() => setGrowOpen((s) => !s)} aria-expanded={growOpen} className="workspace-nav-section flex min-h-8 w-full items-center justify-between px-3">Grow with iAcquire<ChevronDown className={cn("size-3 transition-transform", !growOpen && "-rotate-90")} /></button>}{(growOpen || compact) && GROW.filter((i) => can(i.permission)).map((item) => <NavLink key={item.href} item={item} pathname={pathname} onNavigate={onNavigate} compact={compact} count={item.badge === "projects" ? shell.projectsAttention : undefined} />)}</div>}
    </div>
    <div className={cn("space-y-1 border-t border-white/10 p-3", compact && "px-2")}>{FOOTER.filter((i) => can(i.permission)).map((item) => <NavLink key={item.href} item={item} pathname={pathname} onNavigate={onNavigate} compact={compact} />)}{!compact && <Link href="/settings/security" className="mt-2 flex items-center gap-2 rounded-xl border border-white/10 bg-white/[.035] p-2"><span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[#263456] text-[11px] font-semibold">{initials(shell.user.name)}</span><div className="min-w-0"><p className="truncate text-[12px] font-semibold">{shell.user.name}</p><p className="text-[10px] text-[#a6b3cd]">Account & security</p></div></Link>}{onCompact && <button type="button" onClick={onCompact} className="hidden min-h-8 w-full items-center justify-center gap-2 rounded-lg text-[11px] text-[#a6b3cd] hover:bg-white/5 lg:flex" aria-label={compact ? "Expand sidebar" : "Compact sidebar"}>{compact ? <PanelLeftOpen className="size-4" /> : <><PanelLeftClose className="size-3.5" />Compact navigation</>}</button>}</div>
  </nav>;
}
