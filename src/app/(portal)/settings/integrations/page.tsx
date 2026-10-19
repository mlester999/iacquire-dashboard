import Link from "next/link";
import { ArrowRight, Bot, Calendar, CheckCircle2, Clock, Database, Info, MapPin, MessageSquare, Plug, ShieldCheck, TriangleAlert, Workflow, type LucideIcon } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { withUser } from "@/server/db";
import { Card } from "@/components/ui/primitives";
import { RequestConnection } from "@/components/settings/request-connection";
import { AccentStrip, IconTile, Notice } from "@/components/settings/panel";
import { InfoChip, StatusPill, type StatusTone } from "@/components/ui/status";
import { relativeTime, sentenceCase } from "@/lib/utils";
import { MetricCard, SectionLabel } from "@/components/ui/workspace";
import { buildClientCrmCards, type ClientCardStatus } from "@/lib/integrations/client-tools";
import type { CapabilityProvider, CrmMode } from "@/lib/crm/types";

export const metadata = { title: "Integrations" };

const tone = (s?: string): StatusTone => (s === "connected" ? "success" : s === "configured" ? "primary" : s === "error" ? "danger" : s === "pending" || s === "degraded" ? "warning" : "neutral");
const label = (s?: string) => (s ? (s === "not_configured" ? "Not connected" : sentenceCase(s)) : "Not connected");
const stateIcon = (s?: string) => (s === "connected" || s === "configured" ? <CheckCircle2 className="size-3" aria-hidden /> : s === "error" || s === "degraded" ? <TriangleAlert className="size-3" aria-hidden /> : <Plug className="size-3" aria-hidden />);
const iso = (value: Date | null | undefined) => (value ? new Date(value).toISOString() : null);

interface Row {
  key: string;
  icon: LucideIcon;
  name: string;
  body: string;
  fact?: string;
  status?: ClientCardStatus;
  statusLabel?: string;
  check?: string;
  link?: { href: string; label: string };
}

export default async function IntegrationsPage() {
  const ctx = await requireOrgContext("integrations.view");
  const canSeeCrm = ctx.can("crm.view");
  const { statuses, agents, mapping, workspace, capabilities, counts } = await withUser(ctx.user.id, async (db) => {
    const statuses = (await db.query<{ provider: string; status: string; detail: string | null; last_checked_at: Date | null }>(
      "select provider, status, detail, last_checked_at from integration_status where org_id = $1",
      [ctx.org.orgId],
    )).rows;
    const agents = (await db.query<{ online: number; total: number }>(
      "select count(*) filter (where status in ('online','busy'))::int as online, count(*) filter (where enabled)::int as total from agent_instances where org_id = $1",
      [ctx.org.orgId],
    )).rows[0];
    const mapping = (await db.query<{ location_name: string | null; status: string; verified_at: Date | null }>(
      "select location_name, status, verified_at from ghl_location_mappings where org_id = $1",
      [ctx.org.orgId],
    )).rows[0] ?? null;
    // CRM ownership and counts are only read for someone who may open the CRM. Without it, the CRM cards are left out.
    const workspace = canSeeCrm
      ? (await db.query<{ mode: CrmMode }>("select mode from crm_workspaces where org_id = $1", [ctx.org.orgId])).rows[0] ?? null
      : null;
    const capabilities = canSeeCrm
      ? (await db.query<{ capability: string; provider: CapabilityProvider }>("select capability, provider from crm_capability_providers where org_id = $1", [ctx.org.orgId])).rows
      : [];
    const counts = canSeeCrm
      ? (await db.query<{
          contacts: number; pipelines: number; active_calendars: number; connected_calendars: number;
          enabled_channels: number; tested_channels: number; active_workflows: number;
        }>(
          `select
             (select count(*)::int from contacts where org_id = $1 and deleted_at is null) as contacts,
             (select count(*)::int from crm_pipelines where org_id = $1 and provider = 'native' and archived_at is null) as pipelines,
             (select count(*)::int from crm_calendars where org_id = $1 and status = 'active' and archived_at is null) as active_calendars,
             (select count(*)::int from crm_calendar_connections where org_id = $1 and status = 'connected') as connected_calendars,
             (select count(*)::int from messaging_channels where org_id = $1 and enabled) as enabled_channels,
             (select count(*)::int from messaging_channels where org_id = $1 and capability_tested_at is not null) as tested_channels,
             (select count(*)::int from crm_workflows where org_id = $1 and status = 'active' and archived_at is null) as active_workflows`,
          [ctx.org.orgId],
        )).rows[0]
      : null;
    return { statuses, agents, mapping, workspace, capabilities, counts };
  });
  const st = (p: string) => statuses.find((s) => s.provider === p);
  const cardStatus = (provider: string): ClientCardStatus | null => {
    const s = st(provider);
    return s ? { provider: s.provider, status: s.status, detail: s.detail, last_checked_at: iso(s.last_checked_at) } : null;
  };

  const mode: CrmMode = workspace?.mode ?? "native";
  const owner = (capability: "contacts" | "calendars"): CapabilityProvider => {
    if (mode === "hybrid") return capabilities.find((c) => c.capability === capability)?.provider ?? "native";
    return mode === "ghl" ? "ghl" : "native";
  };
  const crmCards = canSeeCrm
    ? buildClientCrmCards({
        mode,
        owners: { crm: owner("contacts"), calendars: owner("calendars") },
        counts: {
          contacts: counts?.contacts ?? 0,
          pipelines: counts?.pipelines ?? 0,
          activeCalendars: counts?.active_calendars ?? 0,
          connectedCalendars: counts?.connected_calendars ?? 0,
          enabledChannels: counts?.enabled_channels ?? 0,
          testedChannels: counts?.tested_channels ?? 0,
          activeWorkflows: counts?.active_workflows ?? 0,
        },
        ghl: {
          locationName: mapping?.location_name ?? null,
          mappingStatus: mapping?.status ?? null,
          verifiedAt: iso(mapping?.verified_at),
          crmCheck: cardStatus("ghl"),
          calendarCheck: cardStatus("ghl_calendar"),
        },
      })
    : [];
  const crmIcons: Record<string, LucideIcon> = { native_crm: Database, ghl_crm: Database, native_calendar: Calendar, ghl_calendar: Calendar };

  const enabledChannels = counts?.enabled_channels ?? 0;
  const testedChannels = counts?.tested_channels ?? 0;
  const activeWorkflows = counts?.active_workflows ?? 0;
  const rows: Row[] = [
    ...crmCards.map((card) => ({ ...card, icon: crmIcons[card.key] ?? Database })),
    {
      key: "hermes",
      icon: Bot,
      name: "AI workforce environment",
      body: `${agents?.online ?? 0} of ${agents?.total ?? 0} AI employees online. Each runs in its own private environment.`,
      status: cardStatus("hermes") ?? { provider: "hermes", status: agents?.online ? "connected" : "not_configured", detail: null, last_checked_at: null },
    },
    {
      key: "messaging",
      icon: MessageSquare,
      name: "Customer messaging",
      body: enabledChannels
        ? `${enabledChannels} channel${enabledChannels === 1 ? "" : "s"} on. Email, SMS and WhatsApp send through iAcquire with consent checks and delivery tracking.`
        : "No messaging channel is on yet. Turn one on when you're ready; AI employees prepare drafts for approval until then.",
      fact: testedChannels ? `${testedChannels} tested` : undefined,
      status: enabledChannels ? { provider: "native_messaging", status: "configured", detail: null, last_checked_at: null } : undefined,
      statusLabel: enabledChannels ? "Configured" : "Not enabled",
      check: enabledChannels ? "Built into iAcquire" : "Managed by iAcquire",
    },
    {
      key: "automation",
      icon: Workflow,
      name: "Automation workflows",
      body: activeWorkflows
        ? `${activeWorkflows} workflow${activeWorkflows === 1 ? "" : "s"} active. Follow-ups, reminders and bookings run in iAcquire under your approvals.`
        : "Follow-ups, reminders and bookings run in iAcquire. Nothing runs before you review and activate it.",
      status: activeWorkflows ? { provider: "native_workflows", status: "configured", detail: null, last_checked_at: null } : { provider: "native_workflows", status: "not_configured", detail: null, last_checked_at: null },
      statusLabel: activeWorkflows ? "Active" : "Not active",
      check: "Built into iAcquire",
    },
  ];
  // Built-in tools are not "verified connections"; only a recorded service check counts here.
  const connected = rows.filter((r) => r.status?.status === "connected" && r.check !== "Built into iAcquire").length;
  const hasGhl = rows.some((r) => r.key.startsWith("ghl"));

  return (
    <div className="space-y-6">
      <section>
        <SectionLabel title="Your tools, working together." description="See what is connected to your business. iAcquire handles the technical setup and keeps every service scoped to your organization." />
        <Notice tone="primary" icon={<ShieldCheck />} title="Securely managed for you">
          No API keys to share or infrastructure to configure. Ask the team whenever a connection needs attention.
        </Notice>
      </section>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <MetricCard label="Verified connections" value={connected} detail="From the latest recorded service checks" tone="green" icon={<CheckCircle2 className="size-4" />} />
        <MetricCard label="AI employees online" value={`${agents?.online ?? 0}/${agents?.total ?? 0}`} detail="Ready employees in your private workforce" tone="blue" icon={<Bot className="size-4" />} />
      </div>
      <div className="grid gap-4 md:grid-cols-2" data-aqi-target="settings.integrations.list">
        {rows.map((r) => {
          const s = r.status?.status;
          const t = tone(s);
          return (
            <Card key={r.key} className="relative flex min-w-0 flex-col overflow-hidden">
              <AccentStrip tone={t} />
              <div className="flex items-start gap-3.5 px-5 pb-0 pt-6">
                <IconTile icon={<r.icon />} tone={s === "connected" || s === "configured" ? "success" : t === "neutral" ? "primary" : t} size="lg" />
                <div className="min-w-0 flex-1">
                  <h3 className="text-[15px] font-semibold leading-snug tracking-tight text-ink">{r.name}</h3>
                  <div className="mt-2">
                    <StatusPill tone={t} icon={stateIcon(s)}>{r.statusLabel ?? label(s)}</StatusPill>
                  </div>
                </div>
              </div>
              <div className="flex flex-1 flex-col gap-3 px-5 pb-5 pt-4">
                <p className="flex-1 text-[13px] leading-relaxed text-muted">{r.body}</p>
                {(r.fact || r.status?.last_checked_at) && (
                  <div className="flex flex-wrap gap-1.5">
                    {r.fact && <InfoChip icon={<MapPin aria-hidden />}>{r.key.startsWith("ghl") ? `Location: ${r.fact}` : r.fact}</InfoChip>}
                    {r.status?.last_checked_at && <InfoChip icon={<Clock aria-hidden />}>Checked {relativeTime(r.status.last_checked_at)}</InfoChip>}
                  </div>
                )}
              </div>
              <div className="flex min-h-14 flex-wrap items-center justify-between gap-2 border-t border-line bg-surface-2/50 px-5 py-2.5">
                {r.link ? (
                  <Link href={r.link.href} className="inline-flex items-center gap-1 text-[12px] font-semibold text-primary hover:underline">
                    {r.link.label} <ArrowRight className="size-3" aria-hidden />
                  </Link>
                ) : (
                  <InfoChip className="min-w-0" icon={<ShieldCheck aria-hidden />}>{r.check ?? (s === "connected" ? "Service check passed" : "Managed by iAcquire")}</InfoChip>
                )}
                {s !== "connected" && ctx.can("support.use") && !r.link && r.check !== "Built into iAcquire" && <span data-aqi-target="settings.integrations.request"><RequestConnection what={r.name} /></span>}
              </div>
            </Card>
          );
        })}
      </div>
      {!hasGhl && (
        <Notice tone="neutral" icon={<Plug />} title="GoHighLevel is optional">
          New workspaces start on iAcquire CRM; no GoHighLevel account is required. If you already run your business in GoHighLevel, ask iAcquire to connect it — existing GoHighLevel workspaces keep their configuration.
          {ctx.can("support.use") && <span className="ml-1 inline-block"><RequestConnection what="GoHighLevel" /></span>}
        </Notice>
      )}
      <Notice tone="neutral" icon={<Info />}>
        Slack is optional and used by the iAcquire team internally. You don&apos;t need Slack to use the portal.
      </Notice>
    </div>
  );
}
