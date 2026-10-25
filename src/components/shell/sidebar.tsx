"use client";
import * as React from "react";
import Link, { useLinkStatus } from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { PencilRuler, FileText, Receipt, Share2, Activity, BarChart3, Boxes, Inbox as InboxIcon, Briefcase, ClipboardCheck, Contact, FolderKanban, BookOpen, CalendarDays, ChevronDown, Globe, HeartHandshake, KanbanSquare, LayoutDashboard, LifeBuoy, ListChecks, MessageSquare, MessageSquareText, PanelLeftClose, PanelLeftOpen, Radar, Settings, ShieldCheck, Sparkles, ThumbsUp, TriangleAlert, Waypoints, Workflow, Wrench, Lock } from "lucide-react";
import { AgentAvatar, Logo, StatusDot } from "@/components/brand";
import { Tooltip } from "@/components/ui/overlays";
import { AvatarTile } from "@/components/ui/status";
import { AGENT_BY_KEY, canChat } from "@/lib/agents";
import { cn, initials } from "@/lib/utils";
import { useShell } from "@/components/shell/shell-context";
import { aqiNavTarget } from "@/lib/aqi/targets";
import type { Permission } from "@/lib/permissions";

interface NavItem { href: string; label: string; icon: React.ComponentType<{ className?: string }>; permission?: Permission; badge?: "approvals" | "projects" | "inbox" | "requests"; tour?: string; /** Belongs to a client's workspace only: not offered in an agency workspace (the pages and actions refuse there too). */ clientOnly?: boolean; /** A module a Super Admin switches on per workspace (an org_features name): not offered until it is on. The pages and actions check the switch again. */ feature?: string;/** Overrides the default "this path or anything under it" test for the active indicator. */ match?: (pathname: string) => boolean; }
const MAIN: NavItem[] = [
  { href: "/overview", label: "Overview", icon: LayoutDashboard, tour: "overview" },
  { href: "/inbox", label: "Inbox", icon: InboxIcon, permission: "inbox.view", badge: "inbox" },
  { href: "/leads", label: "Leads", icon: Radar, permission: "leads.view" },
  { href: "/appointments", label: "Appointments", icon: CalendarDays, permission: "appointments.view" },
  { href: "/sales", label: "Sales Pipeline", icon: KanbanSquare, permission: "sales.view" },
  { href: "/proposals", label: "Proposals", icon: FileText, permission: "proposals.view", clientOnly: true, feature: "proposals" },
  { href: "/invoices", label: "Invoices", icon: Receipt, permission: "invoices.view", clientOnly: true, feature: "invoices" },
  { href: "/retention", label: "Customer Retention", icon: HeartHandshake, permission: "retention.view" },
  { href: "/analytics", label: "Analytics", icon: BarChart3, permission: "analytics.view" },
  { href: "/approvals", label: "Approvals", icon: ShieldCheck, permission: "approvals.view", badge: "approvals", tour: "approvals" },
  { href: "/knowledge", label: "Knowledge Center", icon: BookOpen, permission: "knowledge.view" },
  { href: "/website", label: "Website", icon: Globe, permission: "website.view" },
  { href: "/social", label: "Social Media", icon: Share2, permission: "social.view", clientOnly: true },
  { href: "/activity", label: "Activity", icon: Activity },
];
// Native CRM. "Sales Pipeline" (/sales) is the GoHighLevel read-only view and is shown only where GoHighLevel owns the pipeline; likewise
// "Appointments" (/appointments) is the GoHighLevel calendar view, replaced by the native Calendar in a native workspace.
const CRM: NavItem[] = [
  { href: "/crm/contacts", label: "Contacts", icon: Contact, permission: "contacts.view" },
  { href: "/crm/pipelines", label: "Pipelines", icon: KanbanSquare, permission: "sales.view" },
  { href: "/crm/calendar", label: "Calendar", icon: CalendarDays, permission: "appointments.view" },
  { href: "/crm/tasks", label: "Tasks", icon: ListChecks, permission: "crm.view" },
  // Premium: shown with a lock to workspaces without the plan, and the page it opens explains the plan. The core CRM never needs it.
  { href: "/automation-studio", label: "Automation Studio", icon: Workflow, permission: "workflows.view" },
  { href: "/crm", label: "All CRM tools", icon: Waypoints, permission: "crm.view" },
];
const GROW: NavItem[] = [
  { href: "/add-ons", label: "Custom Projects & Add-ons", icon: Boxes, permission: "projects.view", tour: "add-ons" },
  { href: "/our-work", label: "Selected Work", icon: Briefcase, permission: "projects.view" },
  { href: "/maintenance", label: "Maintenance", icon: Wrench, permission: "maintenance.view" },
];
// Requests: everything a client asks of iAcquire, in one expandable group. "Custom Projects" is the existing My Projects area (its quotes,
// milestones and messages are unchanged); the other four are the Support & Requests pages. "Get Support" is /support itself, so it is
// active only there; a request's own page belongs to "My Requests".
const REQUEST_PATH = /^\/support\/[0-9a-f-]{36}$/i;
const REQUESTS: NavItem[] = [
  { href: "/projects", label: "Custom Projects", icon: FolderKanban, permission: "projects.view", badge: "projects" },
  { href: "/support/report-issue", label: "Report an Issue", icon: TriangleAlert, permission: "support.use" },
  { href: "/support", label: "Get Support", icon: LifeBuoy, permission: "support.use", match: (p) => p === "/support" },
  { href: "/support/feedback", label: "Provide Feedback", icon: ThumbsUp, permission: "support.use" },
  // Dormant until a Super Admin switches Request a Change on for the workspace (org_features "request_changes").
  { href: "/support/change", label: "Request a Change", icon: PencilRuler, permission: "support.use", feature: "request_changes" },
  { href: "/support/requests", label: "My Requests", icon: MessageSquareText, permission: "support.use", badge: "requests", match: (p) => p === "/support/requests" || p.startsWith("/support/requests/") || REQUEST_PATH.test(p) },
];
const FOOTER: NavItem[] = [
  { href: "/settings", label: "Settings", icon: Settings, tour: "settings" },
];
export const CLIENT_NAV = [...MAIN, ...CRM, { href: "/employees", label: "AI Employees", icon: Sparkles }, { href: "/setup", label: "Setup Center", icon: ClipboardCheck }, ...GROW, ...REQUESTS, ...FOOTER] as NavItem[];
function NavPendingBar() {
  // useLinkStatus must live inside the Link. A fixed-height bar cannot shift the row, and the
  // click feedback is visible even when the destination's server render is still in flight.
  const { pending } = useLinkStatus();
  return <span aria-hidden className={cn("pointer-events-none absolute inset-x-2 bottom-0.5 h-[2px] origin-left rounded-full bg-[#8ab4ff] transition-opacity duration-150", pending ? "opacity-100" : "opacity-0")} />;
}
function NavLink({ item, pathname, count, trailing, locked = false, onNavigate, onWarm, compact = false }: { item: NavItem; pathname: string; count?: number; trailing?: string; /** Needs a plan the workspace doesn't have: shows a lock and says so to screen readers. */ locked?: boolean; onNavigate?: () => void; onWarm: (href: string) => void; compact?: boolean }) {
  const active = item.match ? item.match(pathname) : pathname === item.href || pathname.startsWith(`${item.href}/`);
  // Warm the full route on intent. This is deliberately hover/focus only: the automatic viewport
  // prefetch on a dynamic route still runs a server render (auth + workspace lookups) for every
  // visible link, which measured 40 background RSC requests on one dashboard load. `prefetch={false}`
  // turns that off; the manual prefetch below still runs on intent, once per destination.
  const warm = () => { if (!active) onWarm(item.href); };
  const link = <Link href={item.href} prefetch={false} onClick={onNavigate} onMouseEnter={warm} onFocus={warm} onPointerDown={warm} data-aqi-target={aqiNavTarget(item.href)} data-tour={item.tour} aria-current={active ? "page" : undefined} aria-label={compact ? (locked ? `${item.label} (needs the Automation Studio plan)` : item.label) : undefined} className={cn("workspace-nav-link group relative flex h-10 items-center gap-2 rounded-xl px-2 text-[14px] font-medium", compact && "justify-center")}>
    <NavPendingBar />
    {active && <motion.span layoutId="client-nav-active" className="absolute inset-0 rounded-xl border border-[#5582ff]/25 bg-[#4268c6]/15" transition={{ type: "spring", stiffness: 460, damping: 38 }} />}
    <span className="nav-icon-box relative"><item.icon className="size-[17px]" /></span>
    {!compact && <><span className="relative min-w-0 flex-1 truncate">{item.label}</span>{locked ? <span className="relative text-[#a9bada]" title="Needs the Automation Studio plan"><Lock className="size-3.5" aria-hidden /><span className="sr-only">Needs the Automation Studio plan</span></span> : count ? <span className="relative flex min-w-5 items-center justify-center rounded-md bg-[#305ecb] px-1.5 py-0.5 text-[12px] font-semibold text-white">{count > 99 ? "99+" : count}</span> : trailing ? <span className="relative text-[12px] tabular-nums text-[#a9bada]">{trailing}</span> : null}</>}
  </Link>;
  return compact ? <Tooltip content={item.label}>{link}</Tooltip> : link;
}
export function Sidebar({ onNavigate, compact = false, onCompact }: { onNavigate?: () => void; compact?: boolean; onCompact?: () => void }) {
  const pathname = usePathname();
  const shell = useShell();
  const router = useRouter();
  // One prefetch per destination per page session. mouseenter, focus and pointerdown can all fire
  // for a single click; without this guard the browser sent the same route request twice.
  const warmed = React.useRef(new Set<string>());
  const warmRoute = React.useCallback((href: string) => {
    if (warmed.current.has(href)) return;
    warmed.current.add(href);
    router.prefetch(href);
  }, [router]);
  const can = (p?: Permission) => !p || shell.permissions.includes(p);
  const [open, setOpen] = React.useState(true);
  const [growOpen, setGrowOpen] = React.useState(true);
  const [requestsOpen, setRequestsOpen] = React.useState(true);
  const [crmOpen, setCrmOpen] = React.useState(true);
  const crmMode = shell.crmMode;
  // Native CRM pipelines replace the GoHighLevel pipeline view; a hybrid workspace keeps both while it migrates.
  const showMain = (i: NavItem) => can(i.permission) && !((i.href === "/sales" || i.href === "/appointments") && crmMode === "native") && !(i.clientOnly && shell.org.kind !== "client") && !(i.feature && !(shell.features ?? []).includes(i.feature));
  // The Requests group: what the person may open, and (for a module a Super Admin switches on per workspace) only where it is on.
  const requestItems = REQUESTS.filter((i) => can(i.permission) && !(i.feature && !(shell.features ?? []).includes(i.feature)));
  // Automation Studio builds on the iAcquire workflow engine, so it is offered wherever that engine runs (not in a GoHighLevel-only workspace).
  const crmItems = CRM.filter((i) => can(i.permission) && crmMode !== null && !((i.href === "/crm/pipelines" || i.href === "/crm/calendar" || i.href === "/automation-studio") && crmMode === "ghl"));
  // "All CRM tools" is highlighted only for CRM pages that have no entry of their own here.
  const crmActivePath = (item: NavItem) => (item.href === "/crm" && crmItems.some((i) => i.href !== "/crm" && (pathname === i.href || pathname.startsWith(`${i.href}/`))) ? "" : pathname);
  const visibleAgents = shell.agents.filter((a) => a.enabled);
  return <nav aria-label="Main" className="workspace-nav flex h-full flex-col text-white">
    <div className={cn("flex h-[76px] shrink-0 items-center px-5", compact && "justify-center px-2")}><Link href="/overview" onClick={onNavigate} aria-label="iAcquire overview" className="workspace-nav-brand -ml-1.5 inline-flex p-1.5">{compact ? <Image src="/brand/icon.svg" alt="" width={36} height={36} /> : <Logo />}</Link></div>
    {!compact && <div className="mx-4 mb-3 flex items-center gap-2.5 rounded-xl border border-white/10 bg-white/[.035] px-3 py-2.5"><AvatarTile name={shell.org.name} size="sm" /><div className="min-w-0"><p className="truncate text-[12px] font-semibold text-white" title={shell.org.name}>{shell.org.name}</p><span className="mt-1 inline-flex h-[18px] items-center rounded-full bg-white/10 px-2 text-[12px] font-medium capitalize text-[#c9d4ec] ring-1 ring-inset ring-white/10">{shell.org.role.replaceAll("_", " ")} workspace</span></div></div>}
    <div className={cn("scrollbar-thin min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-3", compact && "px-2")}>
      <NavLink onWarm={warmRoute} item={MAIN[0]} pathname={pathname} onNavigate={onNavigate} compact={compact} />
      {shell.setup.visible && <NavLink onWarm={warmRoute} item={{ href: "/setup", label: "Setup Center", icon: ClipboardCheck, tour: "setup" }} pathname={pathname} onNavigate={onNavigate} count={shell.setup.needsAttention || undefined} trailing={shell.setup.percent === null ? undefined : `${shell.setup.percent}%`} compact={compact} />}
      <div data-tour="workforce" className="pb-2"><div className="flex items-center gap-1"><div className="min-w-0 flex-1"><NavLink onWarm={warmRoute} item={{ href: "/employees", label: "AI Employees", icon: Sparkles }} pathname={pathname} onNavigate={onNavigate} compact={compact} /></div>{!compact && <button type="button" onClick={() => setOpen((o) => !o)} className="flex size-9 items-center justify-center rounded-lg text-[#a6b3cd] hover:bg-white/5 hover:text-white" aria-expanded={open} aria-label={open ? "Collapse AI employees" : "Expand AI employees"}><ChevronDown className={cn("size-3.5 transition-transform duration-200", !open && "-rotate-90")} /></button>}</div>
        <AnimatePresence initial={false}>{open && !compact && <motion.ul initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: .22 }} className="ml-6 mt-2 space-y-1 overflow-hidden border-l border-white/10 py-1 pl-3 pr-1">{visibleAgents.map((agent) => {
          const meta = AGENT_BY_KEY[agent.role]; const href = `/employees/${meta.slug}`; const chatHref = `/chat/${meta.slug}`; const active = pathname === href || pathname.startsWith(`${href}/`); const chatReady = can("agents.use") && agent.enabled && canChat(agent.status); const statusText = agent.status.replaceAll("_", " ");
          return <li key={agent.role} className="group/employee flex items-center gap-0.5"><Link href={href} prefetch={false} onClick={onNavigate} onMouseEnter={() => { if (!active) warmRoute(href); }} onFocus={() => { if (!active) warmRoute(href); }} aria-current={active ? "page" : undefined} className={cn("group flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1 text-[12px] transition-colors", active ? "bg-[#4268c6]/15 font-medium text-white" : "text-[#a6b3cd] hover:bg-white/5 hover:text-white")}><AgentAvatar role={meta} size="xs" /><span className="min-w-0 flex-1"><span className="block truncate leading-tight">{agent.displayName}</span><span aria-hidden={meta.shortName === agent.displayName ? true : undefined} className="mt-0.5 block truncate text-[12px] leading-tight text-[#a9bada]">{meta.shortName}</span></span><span title={statusText} className="flex"><StatusDot status={agent.status} label={statusText} /></span></Link>{chatReady && <Tooltip content={`Chat with ${agent.displayName} · ${meta.shortName}`} side="right"><Link href={chatHref} prefetch={false} onClick={onNavigate} onMouseEnter={() => warmRoute(chatHref)} onFocus={() => warmRoute(chatHref)} aria-label={`Chat with ${agent.displayName} · ${meta.shortName}`} className="flex size-8 shrink-0 items-center justify-center rounded-lg text-[#a6b3cd] opacity-0 transition hover:bg-white/10 hover:text-white focus-visible:opacity-100 group-hover/employee:opacity-100 group-focus-within/employee:opacity-100 [@media(hover:none)]:opacity-100"><MessageSquare className="size-3.5" /></Link></Tooltip>}</li>;
        })}</motion.ul>}</AnimatePresence>
        {can("agents.use") && <div className="mt-1"><NavLink onWarm={warmRoute} item={{ href: "/work", label: "AI Work Board", icon: ListChecks }} pathname={pathname} onNavigate={onNavigate} compact={compact} /></div>}
      </div>
      {crmItems.length > 0 && <div className="space-y-1 pb-2">{!compact && <button type="button" onClick={() => setCrmOpen((s) => !s)} aria-expanded={crmOpen} className="workspace-nav-section flex min-h-8 w-full items-center justify-between px-3">CRM<ChevronDown className={cn("size-3 transition-transform", !crmOpen && "-rotate-90")} /></button>}{(crmOpen || compact) && crmItems.map((item) => <NavLink onWarm={warmRoute} key={item.href} item={item} pathname={crmActivePath(item)} onNavigate={onNavigate} compact={compact} locked={item.href === "/automation-studio" && shell.automationStudio?.entitled === false} />)}</div>}
      {!compact && <p className="workspace-nav-section px-3 pb-1 pt-2">Business operations</p>}
      {MAIN.slice(1).filter(showMain).map((item) => <NavLink onWarm={warmRoute} key={item.href} item={item} pathname={pathname} onNavigate={onNavigate} compact={compact} count={item.badge === "approvals" ? shell.pendingApprovals : item.badge === "inbox" ? shell.inboxAttention : undefined} />)}
      {requestItems.length > 0 && <div data-tour="requests" className="space-y-1 pt-3">
        {!compact && <button type="button" id="nav-requests-toggle" onClick={() => setRequestsOpen((s) => !s)} aria-expanded={requestsOpen} aria-controls="nav-requests-list" className="workspace-nav-section flex min-h-8 w-full items-center justify-between px-3">
          <span className="inline-flex items-center gap-2">Requests{!requestsOpen && shell.requestsAttention + shell.projectsAttention > 0 && <span role="img" className="flex min-w-4 items-center justify-center rounded-md bg-[#305ecb] px-1 py-px text-[12px] font-semibold normal-case tracking-normal text-white" aria-label={`${shell.requestsAttention + shell.projectsAttention} need attention`}>{shell.requestsAttention + shell.projectsAttention}</span>}</span>
          <ChevronDown className={cn("size-3 transition-transform duration-200", !requestsOpen && "-rotate-90")} />
        </button>}
        <AnimatePresence initial={false}>{(requestsOpen || compact) && <motion.div id="nav-requests-list" role="group" aria-labelledby={compact ? undefined : "nav-requests-toggle"} aria-label={compact ? "Requests" : undefined} initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: .2 }} className="space-y-1 overflow-hidden">
          {requestItems.map((item) => <NavLink onWarm={warmRoute} key={item.href} item={item} pathname={pathname} onNavigate={onNavigate} compact={compact} count={item.badge === "projects" ? shell.projectsAttention : item.badge === "requests" ? shell.requestsAttention : undefined} />)}
        </motion.div>}</AnimatePresence>
      </div>}
      {GROW.some((i) => can(i.permission)) && <div className="space-y-1 pt-3">{!compact && <button type="button" onClick={() => setGrowOpen((s) => !s)} aria-expanded={growOpen} className="workspace-nav-section flex min-h-8 w-full items-center justify-between px-3">Grow with iAcquire<ChevronDown className={cn("size-3 transition-transform", !growOpen && "-rotate-90")} /></button>}{(growOpen || compact) && GROW.filter((i) => can(i.permission)).map((item) => <NavLink onWarm={warmRoute} key={item.href} item={item} pathname={pathname} onNavigate={onNavigate} compact={compact} />)}</div>}
    </div>
    <div className={cn("space-y-1 border-t border-white/10 p-3", compact && "px-2")}>{FOOTER.filter((i) => can(i.permission)).map((item) => <NavLink onWarm={warmRoute} key={item.href} item={item} pathname={pathname} onNavigate={onNavigate} compact={compact} />)}{!compact && <Link href="/settings/security" className="mt-2 flex items-center gap-2 rounded-xl border border-white/10 bg-white/[.035] p-2"><span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[#263456] text-[12px] font-semibold">{initials(shell.user.name)}</span><div className="min-w-0"><p className="truncate text-[12px] font-semibold">{shell.user.name}</p><p className="text-[12px] text-[#a6b3cd]">Account & security</p></div></Link>}{onCompact && <button type="button" onClick={onCompact} className="hidden min-h-8 w-full items-center justify-center gap-2 rounded-lg text-[12px] text-[#a6b3cd] hover:bg-white/5 lg:flex" aria-label={compact ? "Expand navigation" : "Compact navigation"}>{compact ? <PanelLeftOpen className="size-4" /> : <><PanelLeftClose className="size-3.5" />Compact navigation</>}</button>}</div>
  </nav>;
}
