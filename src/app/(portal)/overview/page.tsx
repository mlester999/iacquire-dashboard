import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  CalendarCheck2,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  Circle,
  ClipboardList,
  Handshake,
  HeartPulse,
  Info,
  Radar,
  ShieldCheck,
  Target,
  Trophy,
  XCircle,
} from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { getDashboard } from "@/server/queries/dashboard";
import { listIncidentsForClient } from "@/server/ops/incidents";
import { ServiceNotices } from "@/components/overview/service-notices";
import { ClosingNotice } from "@/components/offboarding/closing-notice";
import { getOffboardingForOwner } from "@/server/offboarding/service";
import { listAgents } from "@/server/workforce/service";
import { AgentAvatar, AgentStatusBadge } from "@/components/brand";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, ProgressBar } from "@/components/ui/primitives";
import { ButtonLink } from "@/components/ui/button";
import { ActivityChart, KpiGrid, OverviewFunnel } from "@/components/overview/overview-client";
import { AGENT_BY_KEY } from "@/lib/agents";
import { describeAction } from "@/lib/activity";
import { SetupNudge } from "@/components/setup/setup-nudge";
import { PageHero } from "@/components/ui/workspace";
import { cn, formatDate, relativeTime } from "@/lib/utils";

export const metadata = { title: "Overview" };

function greeting(timeZone: string) {
  let hour = new Date().getUTCHours();
  try {
    hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone }).format(new Date()));
  } catch {
    /* default to UTC */
  }
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

export default async function OverviewPage() {
  const ctx = await requireOrgContext();
  const [data, agents, notices, closing] = await Promise.all([getDashboard(ctx), listAgents(ctx.user.id, ctx.org.orgId), listIncidentsForClient(ctx), getOffboardingForOwner(ctx)]);
  const first = ctx.user.fullName.split(" ")[0] || "there";
  const setupDone = data.setup.filter((s) => s.done).length;
  const setupPct = Math.round((setupDone / data.setup.length) * 100);
  const operationsReady=agents.some(agent=>agent.role_key==="operations_manager"&&agent.enabled&&["online","busy"].includes(agent.status));
  const k = data.kpis;
  const metric = (m: (typeof k)[keyof typeof k]) => (m.available ? m.value : null);
  const reason = (m: (typeof k)[keyof typeof k]) => (m.available ? undefined : m.reason);
  // Workspaces on iAcquire's own CRM count native calendars and deals, managed under /crm; the others read their connected GoHighLevel copies.
  const nativeDeals = data.sources.native.opportunities;
  const nativeCalendar = data.sources.native.appointments;

  const tiles = [
    { key: "newLeads", label: "New leads", icon: <Radar className="size-[18px]" />, definition: "Businesses researched into your review queue in the last 30 days.", href: "/leads", accent: "primary" as const },
    { key: "qualifiedLeads", label: "Qualified leads", icon: <Target className="size-[18px]" />, definition: "Researched leads you approved as a good fit in the last 30 days.", href: "/leads", accent: "violet" as const },
    { key: "appointmentsBooked", label: "Appointments booked", icon: <CalendarCheck2 className="size-[18px]" />, definition: nativeCalendar ? "Non-cancelled appointments on your iAcquire CRM calendars during the last 30 days." : "Non-cancelled appointments in your connected calendar during the last 30 days.", href: "/appointments", accent: "success" as const },
    { key: "upcomingMeetings", label: "Upcoming meetings", icon: <CalendarClock className="size-[18px]" />, definition: "Confirmed or new appointments scheduled after now.", href: "/appointments", accent: "primary" as const },
    { key: "activeOpportunities", label: "Active opportunities", icon: <Handshake className="size-[18px]" />, definition: nativeDeals ? "Open deals in your iAcquire CRM pipelines." : "Open opportunities in your connected CRM pipeline.", href: nativeDeals ? "/crm/opportunities" : "/sales", accent: "violet" as const },
    { key: "wonDeals", label: "Won deals", icon: <Trophy className="size-[18px]" />, definition: nativeDeals ? "Deals marked Won in your iAcquire CRM in the last 30 days." : "Opportunities marked Won in your CRM in the last 30 days.", href: nativeDeals ? "/crm/opportunities" : "/sales", accent: "success" as const },
    { key: "followUps", label: "Follow-ups due", icon: <ClipboardList className="size-[18px]" />, definition: "Open tasks that are overdue or due within 24 hours.", href: "/overview#tasks", accent: "warning" as const },
    { key: "customerIssues", label: "Open customer issues", icon: <HeartPulse className="size-[18px]" />, definition: "Open issues across your active customer accounts in Customer Retention.", href: "/retention", accent: "warning" as const },
    { key: "aiActivity", label: "AI tasks completed", icon: <Bot className="size-[18px]" />, definition: "AI employee runs that finished successfully in the last 30 days.", href: "/activity", accent: "primary" as const },
    { key: "pendingApprovals", label: "Pending approvals", icon: <ShieldCheck className="size-[18px]" />, definition: "Requests from your AI team waiting for a decision.", href: "/approvals", accent: "violet" as const },
  ] as const;

  return (
    <div className="space-y-6">
      <PageHero target="overview.hero" tone="dark" eyebrow={`${ctx.org.name} · ${formatDate(new Date(),ctx.org.timezone)}`} title={`${greeting(ctx.org.timezone)}, ${first}.`} description="Your team, your pipeline and the decisions that move your business forward — in one workspace." action={<>
          <ButtonLink href="/approvals" variant="secondary" size="md">
            <ShieldCheck className="size-4" /> Approvals
          </ButtonLink>
          <ButtonLink href={operationsReady?"/chat/operations-manager":"/workforce"} variant="brand" size="md">
            {operationsReady?"Ask your Operations Manager":"Review your AI team"} <ArrowRight className="size-4" />
          </ButtonLink>
        </>} aside={<div className="rounded-2xl border border-white/15 bg-white/5 p-5"><p className="text-[11px] font-medium uppercase tracking-wider text-slate-300">Your AI workforce</p><div className="mt-3 flex -space-x-2">{agents.filter(agent=>agent.enabled).map(agent=><span key={agent.id} className="rounded-xl border-2 border-[#11192c]"><AgentAvatar role={AGENT_BY_KEY[agent.role_key]} size="md"/></span>)}</div><p className="mt-4 text-[20px] font-semibold">{agents.filter(agent=>agent.enabled&&["online","busy"].includes(agent.status)).length}<span className="ml-2 text-[13px] font-normal text-slate-300">employees ready to work</span></p><Link href="/workforce" className="mt-2 inline-flex items-center gap-1.5 text-[12px] text-blue-200">Meet your team<ArrowRight className="size-3"/></Link></div>}/>

      <ClosingNotice view={closing} />
      <ServiceNotices incidents={notices} />

      {data.nextActions.length>0&&<section aria-label="What needs your attention" data-aqi-target="overview.next-actions" className="control-panel grid gap-3 p-4 md:grid-cols-3">{data.nextActions.map((action,index)=><Link key={action.title} href={action.href} className="flex items-start gap-3 rounded-xl px-2 py-2 transition hover:bg-surface"><span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-[11px] font-semibold text-primary-ink">0{index+1}</span><span className="min-w-0"><strong className="block text-[13px] font-semibold">{action.title}</strong><span className="mt-1 block text-[12px] leading-relaxed text-muted">{action.body}</span><span className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-blue-200">{action.cta}<ArrowRight className="size-3"/></span></span></Link>)}</section>}

      <div data-aqi-target="overview.kpis">
        <KpiGrid
          tiles={tiles.map((t) => ({
            ...t,
            value: metric(k[t.key]),
            unavailableReason: reason(k[t.key]),
          }))}
        />
      </div>

      <SetupNudge />

      {setupPct < 100 && (
        <Card className="overflow-hidden">
          <details className="group">
            <summary className="flex min-h-16 cursor-pointer list-none flex-wrap items-center gap-3 px-5 py-4 [&::-webkit-details-marker]:hidden">
              <span className="flex size-9 items-center justify-center rounded-xl bg-primary-soft text-primary-ink"><ClipboardList className="size-4" aria-hidden/></span>
              <span className="min-w-0 flex-1"><strong className="block text-[14px] font-semibold">Make the workspace yours</strong><span className="mt-0.5 block text-[12px] text-muted">{setupDone} of {data.setup.length} getting-started steps complete</span></span>
              <ChevronDown className="size-4 shrink-0 text-muted transition-transform group-open:rotate-180" aria-hidden/>
            </summary>
          <div className="grid gap-6 p-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] lg:items-center">
            <div>
              <p className="text-[12.5px] font-medium uppercase tracking-wider text-primary">Getting started</p>
              <h3 className="mt-1 text-[18px] font-semibold tracking-tight">Make the workspace yours</h3>
              <p className="mt-1 text-[13.5px] text-muted">{setupDone} of {data.setup.length} getting-started steps complete. Your full system setup is tracked separately above.</p>
              <ProgressBar value={setupPct} className="mt-4" label="Setup progress" />
            </div>
            <ul className="grid gap-2 sm:grid-cols-2">
              {data.setup.map((s) => (
                <li key={s.key}>
                  <Link
                    href={s.href}
                    className={cn(
                      "flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-[13px] transition",
                      s.done ? "border-transparent bg-success-soft/60 text-success-ink" : "border-line bg-surface hover:border-primary/30 hover:text-ink",
                    )}
                  >
                    {s.done ? <CheckCircle2 className="size-4 shrink-0" /> : <Circle className="size-4 shrink-0 text-faint" />}
                    <span className={cn("truncate", !s.done && "text-ink-2")}>{s.label}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          </details>
        </Card>
      )}



      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="min-w-0 xl:col-span-2">
          <CardHeader>
            <div>
              <CardTitle>AI workforce activity</CardTitle>
              <CardDescription>Messages handled by your AI employees per day, last 14 days.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <ActivityChart data={data.activity.map((a) => ({ x: a.day, y: a.messages }))} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Acquisition funnel</CardTitle>
              <CardDescription>Last 30 days, from research to won deals.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <OverviewFunnel stages={data.funnel} />
            {!data.sources.crm && (
              <p className="mt-4 rounded-xl bg-surface-2 px-3 py-2 text-[12.5px] text-muted">
                Opportunity stages appear once iAcquire connects your CRM. <Link href="/settings/integrations" className="font-medium text-primary underline underline-offset-2">Integration status</Link>
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2" data-aqi-target="overview.ai-team">
          <CardHeader>
            <div>
              <CardTitle>Your AI team</CardTitle>
              <CardDescription>Latest recorded connection status for each employee.</CardDescription>
            </div>
            <ButtonLink href="/workforce" variant="ghost" size="sm">
              Manage <ArrowRight className="size-3.5" />
            </ButtonLink>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {agents.map((a) => {
                const meta = AGENT_BY_KEY[a.role_key];
                return (
                  <li key={a.id}>
                    <Link
                      href={a.enabled ? `/chat/${meta.slug}` : `/workforce/${meta.slug}`}
                      className="group flex h-full items-center gap-3 rounded-xl border border-line bg-surface p-3 transition hover:-translate-y-0.5 hover:border-line-strong hover:shadow-card"
                    >
                      <AgentAvatar role={meta} size="md" />
                      <div className="min-w-0">
                        <p className="truncate text-[13.5px] font-semibold text-ink">{a.display_name}</p>
                        <AgentStatusBadge status={a.enabled?a.status:"disabled"} />
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Alerts</CardTitle>
              <CardDescription>Things that need attention.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-2.5">
            {data.alerts.length === 0 ? (
              <div className="flex items-center gap-3 rounded-xl bg-success-soft/60 px-3.5 py-3 text-[13px] text-success-ink">
                <CheckCircle2 className="size-4" /> No alerts right now.
              </div>
            ) : (
              data.alerts.map((a, i) => (
                <Link key={i} href={a.href} className="flex items-start gap-3 rounded-xl border border-line px-3.5 py-3 transition hover:bg-surface-2">
                  {a.tone === "critical" ? (
                    <XCircle className="mt-0.5 size-4 shrink-0 text-danger" />
                  ) : a.tone === "warning" ? (
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                  ) : (
                    <Info className="mt-0.5 size-4 shrink-0 text-primary" />
                  )}
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium text-ink">{a.title}</span>
                    <span className="block text-[12.5px] text-muted">{a.body}</span>
                  </span>
                </Link>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card id="tasks">
          <CardHeader>
            <div>
              <CardTitle>Follow-up queue</CardTitle>
              <CardDescription>Open follow-ups, soonest first.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {data.tasks.length === 0 ? (
              <p className="py-6 text-center text-[13px] text-muted">No open tasks.</p>
            ) : (
              <ul className="space-y-2">
                {data.tasks.map((t) => (
                  <li key={t.id} className="flex items-start gap-3 rounded-xl px-1 py-1.5">
                    <Circle className={cn("mt-0.5 size-4 shrink-0", t.overdue ? "text-danger" : "text-faint")} />
                    <div className="min-w-0">
                      <p className="text-[13.5px] text-ink">{t.title}</p>
                      <p className={cn("text-[12px]", t.overdue ? "text-danger-ink" : "text-muted")}>
                        {t.due_at ? `${t.overdue ? "Overdue · " : "Due "}${relativeTime(t.due_at)}` : "No due date"}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Recent activity</CardTitle>
              <CardDescription>Significant actions in your workspace.</CardDescription>
            </div>
            {ctx.can("activity.view") && (
              <ButtonLink href="/activity" variant="ghost" size="sm">
                All
              </ButtonLink>
            )}
          </CardHeader>
          <CardContent>
            {!ctx.can("activity.view") ? (
              <p className="py-6 text-center text-[13px] text-muted">Activity history is available to owners and admins.</p>
            ) : data.recent.length === 0 ? (
              <p className="py-6 text-center text-[13px] text-muted">No activity yet.</p>
            ) : (
              <ol className="relative space-y-3 border-l border-line pl-4">
                {data.recent.map((r) => (
                  <li key={r.id} className="relative">
                    <span className={cn("absolute -left-[21px] top-1.5 size-2.5 rounded-full ring-4 ring-surface", r.result === "success" ? "bg-primary" : r.result === "denied" ? "bg-warning" : "bg-danger")} />
                    <p className="text-[13px] text-ink">
                      <span className="font-medium">{r.actor ?? "System"}</span> {describeAction(r.action, r.agent)}
                    </p>
                    <p className="text-[12px] text-faint">{relativeTime(r.at)}</p>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
