import { Bot, Calendar, Database, MessageSquare, Workflow,ShieldCheck,CheckCircle2,AlertTriangle,Plug } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { withUser } from "@/server/db";
import { Badge, Card, CardContent } from "@/components/ui/primitives";
import { RequestConnection } from "@/components/settings/request-connection";
import { relativeTime, sentenceCase } from "@/lib/utils";
import { PageHero,MetricCard } from "@/components/ui/workspace";

export const metadata = { title: "Integrations" };

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
  const tone = (s?: string) => (s === "connected" ? "success" : s === "error" ? "danger" : s === "pending" || s === "degraded" ? "warning" : "neutral");
  const label = (s?: string) => (s ? (s === "not_configured" ? "Not connected" : sentenceCase(s)) : "Not connected");

  const rows = [
    { key: "ghl", icon: Database, name: "GoHighLevel CRM", body: mapping ? `Location: ${mapping.location_name ?? "assigned"}` : "Contacts, opportunities and pipeline. Connected securely by iAcquire — you never need to share API keys.", status: st("ghl") },
    { key: "ghl_calendar", icon: Calendar, name: "Calendar", body: "Appointment availability and bookings from your GoHighLevel calendar.", status: st("ghl_calendar") },
    { key: "hermes", icon: Bot, name: "AI workforce environment", body: `${agents.online} of ${agents.total} AI employees online. Each runs in its own private environment.`, status: st("hermes") ?? { provider: "hermes", status: agents.online ? "connected" : "not_configured", detail: null, last_checked_at: null } },
    { key: "messaging", icon: MessageSquare, name: "Customer messaging (email/SMS)", body: "Sending messages to your customers. Not enabled — AI employees only prepare drafts for your approval.", status: undefined },
    { key: "automation", icon: Workflow, name: "Automation workflows", body: "Booking and follow-up automations run by iAcquire. Configured by the iAcquire team when you're ready.", status: undefined },
  ];

  return (
    <div className="space-y-5">
      <PageHero eyebrow="Workspace / Business connections" title="Your tools, working together." description="See what is connected to your business. iAcquire handles the technical setup and keeps every service scoped to your organization." icon={<Plug className="size-5"/>} aside={<div className="rounded-xl border border-primary/15 bg-surface/70 p-4"><ShieldCheck className="size-6 text-primary"/><p className="mt-2 text-sm font-semibold">Securely managed for you</p><p className="mt-1 text-xs leading-relaxed text-muted">No API keys to share or infrastructure to configure. Ask the team whenever a connection needs attention.</p></div>}/>
      <div className="grid grid-cols-2 gap-3"><MetricCard label="Verified connections" value={rows.filter(r=>r.status?.status==="connected").length} detail="From the latest recorded service checks" tone="green" icon={<CheckCircle2 className="size-4"/>}/><MetricCard label="AI employees online" value={`${agents.online}/${agents.total}`} detail="Ready employees in your private workforce" tone="blue" icon={<Bot className="size-4"/>}/></div>
      <div className="grid gap-4 md:grid-cols-2">
          {rows.map((r) => (
            <Card key={r.key} className="flex min-w-0 flex-col overflow-hidden">
              <div className="flex items-center justify-between gap-3 border-b border-line bg-surface-2/40 px-5 py-4"><span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-primary/15 bg-primary-soft text-primary-ink">
                <r.icon className="size-5" />
              </span><Badge tone={tone(r.status?.status)}>{r.status?.status==="connected"?<CheckCircle2 className="size-3"/>:r.status?.status==="error"||r.status?.status==="degraded"?<AlertTriangle className="size-3"/>:<Plug className="size-3"/>}{label(r.status?.status)}</Badge></div>
              <CardContent className="flex flex-1 flex-col pt-4"><p className="text-[15px] font-semibold tracking-tight">{r.name}</p>
                <p className="mt-2 flex-1 text-[12.5px] leading-relaxed text-muted">{r.body}</p>
                {r.status?.last_checked_at && <p className="text-[11.5px] text-faint">Checked {relativeTime(r.status.last_checked_at)}</p>}
                <div className="mt-4 flex items-center justify-between gap-2 border-t border-line pt-3"><span className="text-[11px] text-muted">{r.status?.status==="connected"?"Service check passed":"Managed by iAcquire"}</span>{r.status?.status !== "connected" && ctx.can("support.use") && <RequestConnection what={r.name}/>}</div>
              </CardContent>
            </Card>
          ))}
      </div>
      <p className="text-[12.5px] text-muted">Slack is optional and used by the iAcquire team internally. You don&apos;t need Slack to use the portal.</p>
    </div>
  );
}
