import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, BookOpen, Bot, History, ShieldCheck, Sparkles } from "lucide-react";
import { requireAgency } from "@/server/tenancy/context";
import { withSystem } from "@/server/db";
import { ensureAgencyWorkspace } from "@/server/workforce/agency";
import { getProvisioningBundle } from "@/server/workforce/provisioning";
import { AgentAvatar, AgentStatusBadge } from "@/components/brand";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/primitives";
import { MetricCard, PageHero, SectionLabel } from "@/components/ui/workspace";
import { CopyTextButton } from "@/components/ui/copy-button";
import { AgencyWorkforceControls } from "@/components/admin/agency-workforce-controls";
import { AGENT_BY_SLUG, type AgentStatus } from "@/lib/agents";
import { agentToolLabel } from "@/lib/agent-tools";
import { formatDateTime, relativeTime, sentenceCase } from "@/lib/utils";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return { title: AGENT_BY_SLUG[slug]?.name ?? "AI employee" };
}

export default async function AgencyEmployeePage({ params }: { params: Promise<{ slug: string }> }) {
  const [{ slug }, user] = await Promise.all([params, requireAgency("super_admin")]);
  const meta = AGENT_BY_SLUG[slug];
  if (!meta) notFound();
  const workspace = await ensureAgencyWorkspace(user);
  if (!workspace) notFound();
  const data = await withSystem(async (db) => {
    const { rows } = await db.query<{
      id: string;
      org_id: string;
      display_name: string;
      enabled: boolean;
      status: AgentStatus;
      mode: string;
      hermes_profile: string | null;
      last_health_check_at: Date | null;
      last_health_ok: boolean | null;
      last_health_detail: string | null;
      tool_inventory_contract: string | null;
      tool_inventory_digest: string | null;
      tool_inventory_verified_at: Date | null;
      tool_inventory_expires_at: Date | null;
      tool_inventory_tool_count: number | null;
      tool_inventory_detail: string | null;
      active_config_version_id: string | null;
      default_tools: string[];
      config_version: number | null;
      config_summary: string | null;
      config_applied_at: Date | null;
    }>(
      `select a.id, a.org_id, a.display_name, a.enabled, a.status, a.mode, a.hermes_profile, a.last_health_check_at,
              a.last_health_ok, a.last_health_detail, a.active_config_version_id, r.default_tools,
              a.tool_inventory_contract, a.tool_inventory_digest, a.tool_inventory_verified_at, a.tool_inventory_expires_at,
              a.tool_inventory_tool_count, a.tool_inventory_detail,
              v.version as config_version, v.summary as config_summary, v.applied_at as config_applied_at
       from agent_instances a join agent_roles r on r.key = a.role_key
       left join agent_config_versions v on v.id = a.active_config_version_id
       where a.org_id = $1 and a.role_key = $2`,
      [workspace.orgId, meta.key],
    );
    const agent = rows[0];
    if (!agent) return null;
    const { rows: runs } = await db.query<{ id: string; purpose: string; status: string; started_at: Date; finished_at: Date | null; total_tokens: number | null; error_message: string | null; tools: number }>(
      `select r.id, r.purpose, r.status, r.started_at, r.finished_at, r.total_tokens, r.error_message,
              (select count(*)::int from tool_executions t where t.run_id = r.id) as tools
       from agent_runs r where r.agent_instance_id = $1 order by r.started_at desc limit 12`,
      [agent.id],
    );
    const { rows: approvals } = await db.query<{ n: number }>(
      "select count(*)::int as n from approval_requests where agent_instance_id = $1 and status = 'pending'",
      [agent.id],
    );
    const { rows: knowledge } = await db.query<{ notes: number; documents: number; last_used: Date | null }>(
      `select
         (select count(*)::int from employee_knowledge_entries where agent_instance_id = $1 and status = 'approved' and content <> '') as notes,
         (select count(*)::int from knowledge_documents
           where org_id = $2 and (agent_instance_id is null or agent_instance_id = $1)
             and status = 'ready' and extracted_text is not null and applied_at is not null) as documents,
         greatest(
           (select max(last_used_at) from employee_knowledge_entries where agent_instance_id = $1),
           (select max(last_used_at) from knowledge_documents
             where org_id = $2 and (agent_instance_id is null or agent_instance_id = $1))
         ) as last_used`,
      [agent.id, workspace.orgId],
    );
    return { agent, runs, pendingApprovals: approvals[0]?.n ?? 0, knowledge: knowledge[0] ?? { notes: 0, documents: 0, last_used: null } };
  });
  if (!data) {
    return (
      <div className="module-stack">
        <Link href="/admin/workforce" className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink"><ArrowLeft className="size-3.5" /> AI Workforce</Link>
        <Card className="border-dashed p-8 text-sm text-muted">This internal employee record doesn&apos;t exist in the agency workspace yet.</Card>
      </div>
    );
  }
  const { agent, runs, pendingApprovals, knowledge } = data;
  const online = agent.enabled && (agent.status === "online" || agent.status === "busy");
  const bundle = await getProvisioningBundle(agent.id);
  return (
    <div className="module-stack space-y-6">
      <Link href="/admin/workforce" className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink"><ArrowLeft className="size-3.5" /> AI Workforce</Link>
      <PageHero
        tone="dark"
        eyebrow="iAcquire internal employee"
        icon={<Bot className="size-5" />}
        title={agent.display_name}
        description={`${meta.tagline} This employee works in iAcquire's own workspace and is never routed to a client tenant.`}
        action={<AgencyWorkforceControls agentId={agent.id} orgId={agent.org_id} slug={meta.slug} employeeName={agent.display_name} enabled={agent.enabled} />}
        aside={<div className="flex items-center gap-4 rounded-2xl border border-white/15 bg-white/5 p-5"><AgentAvatar role={meta} size="xl" /><div><p className="text-[11px] font-medium uppercase tracking-wider text-slate-300">Internal identity</p><p className="mt-2 text-[14px] font-semibold text-white">{meta.shortName}</p><div className="mt-2"><AgentStatusBadge status={agent.enabled ? agent.status : "disabled"} /></div></div></div>}
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <MetricCard label="Configuration" value={agent.config_version ? `v${agent.config_version}` : "Not set"} detail={agent.config_applied_at ? `Applied ${relativeTime(agent.config_applied_at)}` : "No applied version"} icon={<Sparkles className="size-4" />} tone="blue" />
        <MetricCard label="Pending approvals" value={pendingApprovals} detail="Customer-facing actions wait for a person." icon={<ShieldCheck className="size-4" />} tone="amber" href="/approvals" />
        <MetricCard label="Usable knowledge" value={knowledge.notes + knowledge.documents} detail={knowledge.last_used ? `Last used ${relativeTime(knowledge.last_used)}` : "Not used in a run yet"} icon={<BookOpen className="size-4" />} tone="violet" />
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader><div><CardTitle>Profile and runtime</CardTitle><CardDescription>What is configured, and what has actually been verified.</CardDescription></div></CardHeader>
          <CardContent className="space-y-4">
            <dl className="grid gap-4 sm:grid-cols-2">
              <div><dt className="text-[11px] font-medium uppercase tracking-wide text-muted">Role</dt><dd className="mt-1 text-[13.5px] font-medium">{meta.name}</dd></div>
              <div><dt className="text-[11px] font-medium uppercase tracking-wide text-muted">Assigned organization</dt><dd className="mt-1 text-[13.5px] font-medium">{workspace.name}</dd></div>
              <div><dt className="text-[11px] font-medium uppercase tracking-wide text-muted">Provider runtime</dt><dd className="mt-1 text-[13.5px] font-medium">{agent.hermes_profile ? "Hermes Agent" : "Not connected"}</dd></div>
              <div><dt className="text-[11px] font-medium uppercase tracking-wide text-muted">Profile identifier</dt><dd className="mt-1 break-all font-mono text-[12px]">{agent.hermes_profile ?? "Not mapped"}</dd></div>
              <div><dt className="text-[11px] font-medium uppercase tracking-wide text-muted">Enabled</dt><dd className="mt-1 text-[13.5px] font-medium">{agent.enabled ? "Yes" : "No"}</dd></div>
              <div><dt className="text-[11px] font-medium uppercase tracking-wide text-muted">Operating mode</dt><dd className="mt-1 text-[13.5px] font-medium">{sentenceCase(agent.mode.replaceAll("_", " "))}</dd></div>
              <div><dt className="text-[11px] font-medium uppercase tracking-wide text-muted">Last verified activity</dt><dd className="mt-1 text-[13.5px] font-medium">{agent.last_health_check_at ? formatDateTime(agent.last_health_check_at, workspace.timezone) : "Never checked"}</dd></div>
              <div><dt className="text-[11px] font-medium uppercase tracking-wide text-muted">Connection detail</dt><dd className="mt-1 text-[13px] text-muted">{agent.last_health_detail ?? "No connection check recorded."}</dd></div>
              <div><dt className="text-[11px] font-medium uppercase tracking-wide text-muted">Complete tool inventory</dt><dd className="mt-1 text-[13px] text-muted">{agent.tool_inventory_contract ? `${agent.tool_inventory_tool_count ?? 0} tools verified${agent.tool_inventory_expires_at ? ` · valid until ${formatDateTime(agent.tool_inventory_expires_at, workspace.timezone)}` : ""}${agent.tool_inventory_digest ? ` · ${agent.tool_inventory_digest.slice(0, 12)}…` : ""}` : "Not verified"}</dd></div>
              {agent.tool_inventory_detail && <div className="sm:col-span-2"><dt className="text-[11px] font-medium uppercase tracking-wide text-muted">Inventory detail</dt><dd className="mt-1 text-[13px] text-muted">{agent.tool_inventory_detail}</dd></div>}
            </dl>
            <div className="rounded-xl border border-line bg-surface-2/60 p-3.5">
              <p className="text-[12px] font-semibold text-ink-2">{online ? "Verified online" : "Not verified online"}</p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
                {online
                  ? "The latest authenticated health check passed. Chat is available through the internal workspace."
                  : "A saved profile or API key alone is not treated as online. Use Check after the profile is mapped and the configuration is applied."}
              </p>
            </div>
            <div>
              <p className="mb-2 text-[12px] font-semibold">Authorized tools</p>
              <ul className="grid gap-1.5 sm:grid-cols-2">
                {agent.default_tools.map((tool) => <li key={tool} className="text-[12.5px] text-ink-2">• {agentToolLabel(tool)}</li>)}
              </ul>
              <p className="mt-2 text-[11.5px] text-muted">Tool access is granted by the iAcquire platform and enforced by the provider profile and connection health check.</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><div><CardTitle>Configuration summary</CardTitle><CardDescription>The active version, in plain English.</CardDescription></div></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-[13px] leading-relaxed text-ink-2">{agent.config_summary ?? "No configuration has been applied yet."}</p>
            <Link href={`/admin/workforce/open?role=${meta.slug}&to=manage`} className="inline-flex min-h-10 w-full items-center justify-center rounded-xl border border-line bg-surface px-3 text-[12.5px] font-medium text-primary hover:bg-surface-2">
              Open configuration and knowledge
            </Link>
            <p className="text-[11.5px] leading-relaxed text-muted">Configuration changes are versioned. Draft testing never edits this employee&apos;s active configuration.</p>
          </CardContent>
        </Card>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><div><CardTitle className="flex items-center gap-2"><BookOpen className="size-4" /> SOUL.md (managed by iAcquire)</CardTitle><CardDescription>The profile identity file used by the Hermes administrator. It is not editable from the portal and no portal save rewrites it.</CardDescription></div></CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-end"><CopyTextButton text={bundle.soul} label="Copy SOUL.md" /></div>
            <pre tabIndex={0} aria-label="SOUL.md content" className="scrollbar-thin max-h-80 overflow-auto whitespace-pre-wrap rounded-xl border border-line bg-surface-2 p-3 font-mono text-[11.5px] leading-relaxed text-ink-2">{bundle.soul}</pre>
            <p className="text-[11.5px] leading-relaxed text-muted">Client-specific instructions are sent with each run beneath this identity and the protected iAcquire policy. That keeps a model or instruction change from destroying the employee&apos;s identity or history.</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><div><CardTitle className="flex items-center gap-2"><History className="size-4" /> Recorded activity</CardTitle><CardDescription>The latest saved runs. Tokens come from the provider when reported.</CardDescription></div></CardHeader>
          <CardContent>
            {runs.length ? (
              <ul className="divide-y divide-line">
                {runs.map((run) => (
                  <li key={run.id} className="flex flex-wrap items-center gap-2 py-2.5 text-[12.5px]">
                    <span className="min-w-0 flex-1">{formatDateTime(run.started_at, workspace.timezone)}</span>
                    <Badge tone={run.status === "completed" ? "success" : run.status === "cancelled" ? "neutral" : run.status === "running" ? "primary" : "danger"}>{sentenceCase(run.status)}</Badge>
                    <span className="text-muted">{run.total_tokens ?? "—"} tokens</span>
                    <span className="text-muted">{run.tools} tools</span>
                    {run.error_message && <span className="w-full text-danger-ink">{run.error_message}</span>}
                  </li>
                ))}
              </ul>
            ) : <p className="py-4 text-[13px] text-muted">No runs recorded yet.</p>}
          </CardContent>
        </Card>
      </div>
      <SectionLabel title="How this page fits together" description="The internal workforce uses the same employee registry, chat backend, versioning, knowledge and approval system as client employees. Only the tenant boundary differs." />
    </div>
  );
}
