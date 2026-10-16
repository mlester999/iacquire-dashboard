import Link from "next/link";
import {
  Activity,
  ArrowRight,
  Bell,
  Bot,
  CalendarCheck2,
  CalendarClock,
  ClipboardList,
  Funnel as FunnelIcon,
  Handshake,
  HeartPulse,
  Lock,
  PlugZap,
  Radar,
  ShieldCheck,
  Target,
  TrendingUp,
  Trophy,
  Users,
} from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { getDashboard } from "@/server/queries/dashboard";
import { listIncidentsForClient } from "@/server/ops/incidents";
import { ServiceNotices } from "@/components/overview/service-notices";
import { ClosingNotice } from "@/components/offboarding/closing-notice";
import { getOffboardingForOwner } from "@/server/offboarding/service";
import { listAgents } from "@/server/workforce/service";
import { AgentAvatar } from "@/components/brand";
import { EmptyState } from "@/components/ui/primitives";
import { ButtonLink } from "@/components/ui/button";
import { ActivityChart, KpiGrid, OverviewFunnel } from "@/components/overview/overview-client";
import { ActivityFeed, AlertsList, FollowUps, NextActions, SetupChecklist, TeamGrid } from "@/components/overview/overview-panels";
import { Panel } from "@/components/overview/panel";
import { StatusPill } from "@/components/ui/status";
import { AGENT_BY_KEY } from "@/lib/agents";
import { SetupNudge } from "@/components/setup/setup-nudge";
import { PageHero } from "@/components/ui/workspace";
import { formatDate } from "@/lib/utils";

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
  const operationsReady = agents.some((agent) => agent.role_key === "operations_manager" && agent.enabled && ["online", "busy"].includes(agent.status));
  const enabledAgents = agents.filter((agent) => agent.enabled);
  const readyAgents = enabledAgents.filter((agent) => ["online", "busy"].includes(agent.status));
  const k = data.kpis;
  const metric = (m: (typeof k)[keyof typeof k]) => (m.available ? m.value : null);
  const reason = (m: (typeof k)[keyof typeof k]) => (m.available ? undefined : m.reason);

  const tiles = [
    { key: "newLeads", label: "New leads", icon: <Radar className="size-[18px]" />, definition: "Businesses researched into your review queue in the last 30 days.", href: "/leads", accent: "primary" as const },
    { key: "qualifiedLeads", label: "Qualified leads", icon: <Target className="size-[18px]" />, definition: "Researched leads you approved as a good fit in the last 30 days.", href: "/leads", accent: "violet" as const },
    { key: "appointmentsBooked", label: "Appointments booked", icon: <CalendarCheck2 className="size-[18px]" />, definition: "Non-cancelled appointments in your connected calendar during the last 30 days.", href: "/appointments", accent: "success" as const },
    { key: "upcomingMeetings", label: "Upcoming meetings", icon: <CalendarClock className="size-[18px]" />, definition: "Confirmed or new appointments scheduled after now.", href: "/appointments", accent: "primary" as const },
    { key: "activeOpportunities", label: "Active opportunities", icon: <Handshake className="size-[18px]" />, definition: "Open opportunities in your connected CRM pipeline.", href: "/sales", accent: "violet" as const },
    { key: "wonDeals", label: "Won deals", icon: <Trophy className="size-[18px]" />, definition: "Opportunities marked Won in your CRM in the last 30 days.", href: "/sales", accent: "success" as const },
    { key: "followUps", label: "Follow-ups due", icon: <ClipboardList className="size-[18px]" />, definition: "Open tasks that are overdue or due within 24 hours.", href: "/overview#tasks", accent: "warning" as const },
    { key: "customerIssues", label: "Open customer issues", icon: <HeartPulse className="size-[18px]" />, definition: "Open issues across your active customer accounts in Customer Retention.", href: "/retention", accent: "warning" as const },
    { key: "aiActivity", label: "AI tasks completed", icon: <Bot className="size-[18px]" />, definition: "AI employee runs that finished successfully in the last 30 days.", href: "/activity", accent: "primary" as const },
    { key: "pendingApprovals", label: "Pending approvals", icon: <ShieldCheck className="size-[18px]" />, definition: "Requests from your AI team waiting for a decision.", href: "/approvals", accent: "violet" as const },
  ] as const;

  return (
    <div className="space-y-6">
      <PageHero
        tone="dark"
        eyebrow={`${ctx.org.name} · ${formatDate(new Date(), ctx.org.timezone)}`}
        title={`${greeting(ctx.org.timezone)}, ${first}.`}
        description="Your team, your pipeline and the decisions that move your business forward — in one workspace."
        action={
          <>
            <ButtonLink href="/approvals" variant="secondary" size="md">
              <ShieldCheck className="size-4" /> Approvals
            </ButtonLink>
            <ButtonLink href={operationsReady ? "/chat/operations-manager" : "/workforce"} variant="brand" size="md">
              {operationsReady ? "Ask your Operations Manager" : "Review your AI team"} <ArrowRight className="size-4" />
            </ButtonLink>
          </>
        }
        aside={
          <div className="control-panel p-5">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">Your AI workforce</p>
              <StatusPill tone={readyAgents.length > 0 ? "success" : "warning"} size="sm">
                {readyAgents.length > 0 ? "Working" : "Getting ready"}
              </StatusPill>
            </div>
            <div className="mt-4 flex -space-x-2">
              {enabledAgents.map((agent) => (
                <span key={agent.id} title={agent.display_name} className="rounded-xl ring-2 ring-[var(--control-room)]">
                  <AgentAvatar role={AGENT_BY_KEY[agent.role_key]} size="md" />
                </span>
              ))}
            </div>
            <p className="mt-4 text-[22px] font-semibold leading-none tracking-tight tabular-nums text-ink">
              {readyAgents.length}
              <span className="ml-2 text-[13px] font-normal tracking-normal text-ink-2">of {enabledAgents.length} employees ready to work</span>
            </p>
            <Link href="/workforce" className="mt-3 inline-flex min-h-10 items-center gap-1.5 text-[12.5px] font-medium text-ink-2 transition hover:text-ink">
              Meet your team <ArrowRight className="size-3" />
            </Link>
          </div>
        }
      />

      <ClosingNotice view={closing} />
      <ServiceNotices incidents={notices} />

      <NextActions actions={data.nextActions} />

      <KpiGrid
        tiles={tiles.map((t) => ({
          ...t,
          value: metric(k[t.key]),
          unavailableReason: reason(k[t.key]),
        }))}
      />

      <SetupNudge />

      {setupPct < 100 && <SetupChecklist steps={data.setup} />}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Panel className="xl:col-span-2" icon={<TrendingUp />} title="AI workforce activity" description="Messages handled by your AI employees per day, last 14 days.">
          <ActivityChart data={data.activity.map((a) => ({ x: a.day, y: a.messages }))} />
        </Panel>
        <Panel icon={<FunnelIcon />} tone="violet" title="Acquisition funnel" description="Last 30 days, from research to won deals.">
          <OverviewFunnel stages={data.funnel} />
          {!data.sources.crm && (
            <div className="mt-4 flex items-start gap-3 rounded-xl bg-surface-2/70 p-3 ring-1 ring-inset ring-line">
              <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-lg bg-surface text-muted ring-1 ring-inset ring-line-strong">
                <PlugZap className="size-3.5" />
              </span>
              <p className="text-[12.5px] leading-relaxed text-muted">
                Opportunity stages appear once iAcquire connects your CRM.{" "}
                <Link href="/settings/integrations" className="font-medium text-primary-ink hover:underline">
                  Integration status
                </Link>
              </p>
            </div>
          )}
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Panel
          className="xl:col-span-2"
          icon={<Users />}
          title="Your AI team"
          description="Latest recorded connection status for each employee."
          action={
            <ButtonLink href="/workforce" variant="secondary" size="sm">
              Manage <ArrowRight className="size-3.5" />
            </ButtonLink>
          }
        >
          <TeamGrid agents={agents} />
        </Panel>

        <Panel
          icon={<Bell />}
          tone={data.alerts.length > 0 ? "warning" : "success"}
          title="Alerts"
          description="Things that need attention."
          action={data.alerts.length > 0 ? <StatusPill tone="warning" size="sm">{data.alerts.length === 1 ? "1 open" : `${data.alerts.length} open`}</StatusPill> : undefined}
        >
          <AlertsList alerts={data.alerts} />
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Panel
          id="tasks"
          icon={<ClipboardList />}
          tone={data.tasks.some((t) => t.overdue) ? "danger" : "primary"}
          title="Follow-up queue"
          description="Open follow-ups, soonest first."
          action={data.tasks.length > 0 ? <StatusPill tone={data.tasks.some((t) => t.overdue) ? "danger" : "neutral"} size="sm">{data.tasks.length === 1 ? "1 open" : `${data.tasks.length} open`}</StatusPill> : undefined}
        >
          <FollowUps tasks={data.tasks} />
        </Panel>

        <Panel
          icon={<Activity />}
          tone="neutral"
          title="Recent activity"
          description="Significant actions in your workspace."
          action={
            ctx.can("activity.view") ? (
              <ButtonLink href="/activity" variant="secondary" size="sm">
                View all <ArrowRight className="size-3.5" />
              </ButtonLink>
            ) : undefined
          }
        >
          {!ctx.can("activity.view") ? (
            <EmptyState compact icon={<Lock className="size-5" />} title="Owners and admins only" description="Activity history is available to workspace owners and admins." />
          ) : data.recent.length === 0 ? (
            <EmptyState compact icon={<Activity className="size-5" />} title="No activity yet" description="Significant actions by your team and AI employees will be listed here." />
          ) : (
            <ActivityFeed rows={data.recent.slice(0, 6)} />
          )}
        </Panel>
      </div>
    </div>
  );
}
