import { Bot, Calendar, CheckCircle2, Clock, Database, Info, MapPin, MessageSquare, Plug, ShieldCheck, TriangleAlert, Workflow, type LucideIcon } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { withUser } from "@/server/db";
import { Card } from "@/components/ui/primitives";
import { RequestConnection } from "@/components/settings/request-connection";
import { AccentStrip, IconTile, Notice } from "@/components/settings/panel";
import { InfoChip, StatusPill, type StatusTone } from "@/components/ui/status";
import { relativeTime, sentenceCase } from "@/lib/utils";
import { MetricCard, SectionLabel } from "@/components/ui/workspace";

export const metadata = { title: "Integrations" };

const tone = (s?: string): StatusTone => (s === "connected" ? "success" : s === "error" ? "danger" : s === "pending" || s === "degraded" ? "warning" : "neutral");
const label = (s?: string) => (s ? (s === "not_configured" ? "Not connected" : sentenceCase(s)) : "Not connected");
const stateIcon = (s?: string) => (s === "connected" ? <CheckCircle2 className="size-3" aria-hidden /> : s === "error" || s === "degraded" ? <TriangleAlert className="size-3" aria-hidden /> : <Plug className="size-3" aria-hidden />);

export default async function IntegrationsPage() {
  const ctx = await requireOrgContext("integrations.view");
  const { statuses, agents, mapping } = await withUser(ctx.user.id, async (db) => {
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
    )).rows[0];
    return { statuses, agents, mapping };
  });
  const st = (p: string) => statuses.find((s) => s.provider === p);

  const rows: Array<{ key: string; icon: LucideIcon; name: string; body: string; fact?: string; status: { provider: string; status: string; detail: string | null; last_checked_at: Date | null } | undefined }> = [
    { key: "ghl", icon: Database, name: "GoHighLevel CRM", body: "Contacts, opportunities and pipeline. Connected securely by iAcquire — you never need to share API keys.", fact: mapping ? mapping.location_name ?? "Assigned" : undefined, status: st("ghl") },
    { key: "ghl_calendar", icon: Calendar, name: "Calendar", body: "Appointment availability and bookings from your GoHighLevel calendar.", status: st("ghl_calendar") },
    { key: "hermes", icon: Bot, name: "AI workforce environment", body: `${agents.online} of ${agents.total} AI employees online. Each runs in its own private environment.`, status: st("hermes") ?? { provider: "hermes", status: agents.online ? "connected" : "not_configured", detail: null, last_checked_at: null } },
    { key: "messaging", icon: MessageSquare, name: "Customer messaging (email/SMS)", body: "Sending messages to your customers. Not enabled — AI employees only prepare drafts for your approval.", status: undefined },
    { key: "automation", icon: Workflow, name: "Automation workflows", body: "Booking and follow-up automations run by iAcquire. Configured by the iAcquire team when you're ready.", status: undefined },
  ];
  const connected = rows.filter((r) => r.status?.status === "connected").length;

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
        <MetricCard label="AI employees online" value={`${agents.online}/${agents.total}`} detail="Ready employees in your private workforce" tone="blue" icon={<Bot className="size-4" />} />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {rows.map((r) => {
          const s = r.status?.status;
          const t = tone(s);
          return (
            <Card key={r.key} className="relative flex min-w-0 flex-col overflow-hidden">
              <AccentStrip tone={t} />
              <div className="flex items-start gap-3.5 px-5 pb-0 pt-6">
                <IconTile icon={<r.icon />} tone={s === "connected" ? "success" : t === "neutral" ? "primary" : t} size="lg" />
                <div className="min-w-0 flex-1">
                  <h3 className="text-[15px] font-semibold leading-snug tracking-tight text-ink">{r.name}</h3>
                  <div className="mt-2">
                    <StatusPill tone={t} icon={stateIcon(s)}>{label(s)}</StatusPill>
                  </div>
                </div>
              </div>
              <div className="flex flex-1 flex-col gap-3 px-5 pb-5 pt-4">
                <p className="flex-1 text-[13px] leading-relaxed text-muted">{r.body}</p>
                {(r.fact || r.status?.last_checked_at) && (
                  <div className="flex flex-wrap gap-1.5">
                    {r.fact && <InfoChip icon={<MapPin aria-hidden />}>Location: {r.fact}</InfoChip>}
                    {r.status?.last_checked_at && <InfoChip icon={<Clock aria-hidden />}>Checked {relativeTime(r.status.last_checked_at)}</InfoChip>}
                  </div>
                )}
              </div>
              <div className="flex min-h-14 flex-wrap items-center justify-between gap-2 border-t border-line bg-surface-2/50 px-5 py-2.5">
                {s === "connected" ? (
                  <InfoChip className="min-w-0" icon={<ShieldCheck aria-hidden />}>Service check passed</InfoChip>
                ) : (
                  <InfoChip className="min-w-0" icon={<ShieldCheck aria-hidden />}>Managed by iAcquire</InfoChip>
                )}
                {s !== "connected" && ctx.can("support.use") && <RequestConnection what={r.name} />}
              </div>
            </Card>
          );
        })}
      </div>
      <Notice tone="neutral" icon={<Info />}>
        Slack is optional and used by the iAcquire team internally. You don&apos;t need Slack to use the portal.
      </Notice>
    </div>
  );
}
