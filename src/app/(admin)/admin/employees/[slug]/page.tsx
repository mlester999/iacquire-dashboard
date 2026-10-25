import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowUpRight, BookOpen, ShieldCheck, Sparkles } from "lucide-react";
import { requireAgency } from "@/server/tenancy/context";
import { withSystem } from "@/server/db";
import { ensureAgencyWorkspace } from "@/server/workforce/agency";
import { getProvisioningBundle } from "@/server/workforce/provisioning";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/primitives";
import { CopyTextButton } from "@/components/ui/copy-button";
import { AgencyWorkforceControls } from "@/components/admin/agency-workforce-controls";
import { EmployeeProfileHero, ReadinessChecklist } from "@/components/workforce/employee-summary";
import { deriveEmployeeReadiness, internalAcknowledgementIsCurrent, internalIdentityIsCurrent, readinessClockNow } from "@/lib/workforce-readiness";
import { AGENT_BY_SLUG, AGENCY_HERMES_PROFILE_IDS, type AgentStatus } from "@/lib/agents";
import { agentToolLabel } from "@/lib/agent-tools";
import { formatDateTime, sentenceCase } from "@/lib/utils";

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
      hermes_gateway_id: string | null;
      last_health_check_at: Date | null;
      last_health_ok: boolean | null;
      last_health_detail: string | null;
      tool_inventory_contract: string | null;
      tool_inventory_digest: string | null;
      tool_inventory_verified_at: Date | null;
      tool_inventory_expires_at: Date | null;
      tool_inventory_tool_count: number | null;
      tool_inventory_detail: string | null;
      credential_ready: boolean;
      active_config_version_id: string | null;
      default_tools: string[];
      config_version: number | null;
      config_summary: string | null;
      config_applied_at: Date | null;
      active_run: boolean;
    }>(
      `select a.id, a.org_id, a.display_name, a.enabled, a.status, a.mode, a.hermes_profile, a.last_health_check_at,
              a.last_health_ok, a.last_health_detail, a.active_config_version_id, a.hermes_gateway_id, r.default_tools,
              a.tool_inventory_contract, a.tool_inventory_digest, a.tool_inventory_verified_at, a.tool_inventory_expires_at,
              a.tool_inventory_tool_count, a.tool_inventory_detail,
              (cred.id is not null and cred.revoked_at is null and
               (cred.credential_reference_id is null or (cred_ref.id is not null and cred_ref.revoked_at is null))) as credential_ready,
              exists(select 1 from agent_runs running where running.agent_instance_id=a.id and running.status='running') as active_run,
              v.version as config_version, v.summary as config_summary, v.applied_at as config_applied_at
       from agent_instances a join agent_roles r on r.key = a.role_key
       left join agent_config_versions v on v.id = a.active_config_version_id
       left join integration_credentials cred on cred.id=a.credential_id and cred.org_id=a.org_id and cred.provider='hermes'
       left join credential_references cred_ref on cred_ref.id=cred.credential_reference_id and cred_ref.org_id=a.org_id and cred_ref.provider='hermes'
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
    const { rows: check } = await db.query<{
      profile_check_status: string | null; profile_check_profile_id: string | null; profile_check_gateway_id: string | null;
      identity_verified: boolean | null; api_contract_verified: boolean | null; tool_permissions_status: string | null; checked_at: Date | null;
      acknowledged_at: Date | null; acknowledged_profile: string | null; acknowledged_policy_id: string | null; internal_policy_id: string | null;
      acknowledged_config_version_id: string | null; acknowledged_inventory_digest: string | null; agent_policy_override_id: string | null;
    }>(
      `select c.status as profile_check_status,c.profile_id as profile_check_profile_id,c.gateway_id as profile_check_gateway_id,
              c.identity_verified,c.api_contract_verified,c.tool_permissions_status,c.checked_at,
              ack.acknowledged_at,ack.verified_profile as acknowledged_profile,ack.policy_id as acknowledged_policy_id,
              ack_policy.id as internal_policy_id,
              ack_history.policy_snapshot->>'activeConfigVersionId' as acknowledged_config_version_id,
              ack_history.policy_snapshot->>'inventoryDigest' as acknowledged_inventory_digest,
              agent_policy.id as agent_policy_override_id
         from agent_instances a
         left join agency_hermes_profile_checks c on c.agent_instance_id=a.id and c.org_id=a.org_id
         left join hermes_tool_policy_acknowledgements ack on ack.agent_id=a.id
         left join hermes_tool_policies ack_policy on ack_policy.id=ack.policy_id and ack_policy.scope_kind='internal_agency' and ack_policy.name='Full Hermes Capabilities'
         left join hermes_tool_policies agent_policy on agent_policy.scope_kind='agent' and agent_policy.agent_id=a.id
         left join lateral (
           select h.policy_snapshot from hermes_tool_policy_history h
           where h.agent_id=a.id and h.action='full_capabilities_acknowledged'
           order by h.occurred_at desc,h.id desc limit 1
         ) ack_history on true
        where a.id=$1`,
      [agent.id],
    );
    const verification = check[0];
    const identityEvidence = {
      expectedProfile: AGENCY_HERMES_PROFILE_IDS[meta.key],
      savedProfile: agent.hermes_profile,
      savedGatewayId: agent.hermes_gateway_id,
      checkedProfile: verification?.profile_check_profile_id ?? null,
      checkedGatewayId: verification?.profile_check_gateway_id ?? null,
      checkStatus: verification?.profile_check_status ?? null,
      identityVerified: verification?.identity_verified ?? null,
      apiContractVerified: verification?.api_contract_verified ?? null,
      toolPermissionsStatus: verification?.tool_permissions_status ?? null,
      checkedAt: verification?.checked_at ?? null,
      configAppliedAt: agent.config_applied_at,
    };
    const identityCurrent = internalIdentityIsCurrent(identityEvidence);
    const acknowledgementCurrent = internalAcknowledgementIsCurrent({
      ...identityEvidence,
      acknowledgedAt: verification?.acknowledged_at ?? null,
      acknowledgedProfile: verification?.acknowledged_profile ?? null,
      acknowledgedPolicyId: verification?.acknowledged_policy_id ?? null,
      expectedPolicyId: verification?.internal_policy_id ?? null,
      activeConfigVersionId: agent.active_config_version_id,
      acknowledgedConfigVersionId: verification?.acknowledged_config_version_id ?? null,
      inventoryDigest: agent.tool_inventory_digest,
      acknowledgedInventoryDigest: verification?.acknowledged_inventory_digest ?? null,
      credentialReady: agent.credential_ready,
      hasAgentPolicyOverride: Boolean(verification?.agent_policy_override_id),
    });
    return { agent, runs, pendingApprovals: approvals[0]?.n ?? 0, knowledge: knowledge[0] ?? { notes: 0, documents: 0, last_used: null }, identityCurrent, acknowledgementCurrent };
  });
  if (!data) {
    return (
      <div className="module-stack">
        <Link href="/admin/employees" className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink"><ArrowLeft className="size-3.5" /> AI Employees</Link>
        <Card className="border-dashed p-8 text-sm text-muted">This internal employee record doesn&apos;t exist in the agency workspace yet.</Card>
      </div>
    );
  }
  const { agent, runs, pendingApprovals, knowledge, identityCurrent, acknowledgementCurrent } = data;
  const readiness = deriveEmployeeReadiness({
    displayName: agent.display_name,
    enabled: agent.enabled,
    status: agent.status,
    configVersion: agent.config_version,
    lastHealthCheckAt: agent.last_health_check_at?.toISOString() ?? null,
    lastHealthOk: agent.last_health_ok,
    lastHealthDetail: agent.last_health_detail,
    inventoryContract: agent.tool_inventory_contract,
    inventoryDigest: agent.tool_inventory_digest,
    inventoryVerifiedAt: agent.tool_inventory_verified_at?.toISOString() ?? null,
    inventoryExpiresAt: agent.tool_inventory_expires_at?.toISOString() ?? null,
    inventoryToolCount: agent.tool_inventory_tool_count,
    credentialCurrent: agent.credential_ready,
    identityCurrent,
    acknowledgementCurrent,
    isAgencyEmployee: true,
    taskExecuting: agent.active_run,
    evaluatedAt: readinessClockNow(),
  });
  const bundle = await getProvisioningBundle(agent.id);

  return (
    <div className="module-stack space-y-6">
      <Link href="/admin/employees" className="inline-flex items-center gap-1.5 text-[13px] text-muted transition hover:text-ink"><ArrowLeft className="size-3.5" /> Internal AI Employees</Link>
      <EmployeeProfileHero
        dark
        meta={meta}
        displayName={agent.display_name}
        eyebrow="iAcquire internal employee"
        description={`${meta.tagline} This employee works in iAcquire's own workspace and is never routed to a client tenant.`}
        readiness={readiness}
        actions={<AgencyWorkforceControls agentId={agent.id} orgId={agent.org_id} slug={meta.slug} employeeName={agent.display_name} enabled={agent.enabled} dark />}
        footer={
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[12px] text-slate-300">
            <span className="inline-flex items-center gap-1.5"><Sparkles className="size-3.5 text-blue-200" /> {agent.config_version ? `Configuration v${agent.config_version}` : "No applied configuration"}</span>
            <span className="inline-flex items-center gap-1.5"><ShieldCheck className="size-3.5 text-blue-200" /> {agent.tool_inventory_tool_count ?? 0} approved tools</span>
            <span className="inline-flex items-center gap-1.5"><BookOpen className="size-3.5 text-blue-200" /> {knowledge.notes + knowledge.documents} usable knowledge</span>
            <Link href="/approvals" className="inline-flex items-center gap-1.5 text-blue-200 hover:text-white">{pendingApprovals} pending approvals <ArrowUpRight className="size-3" /></Link>
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_365px]">
        <div className="space-y-6">
          <Card>
            <CardHeader><div><CardTitle>Profile and runtime</CardTitle><CardDescription>What is configured and what has actually been verified.</CardDescription></div></CardHeader>
            <CardContent className="space-y-4">
              <dl className="grid gap-4 sm:grid-cols-2">
                <div><dt className="text-[12px] font-medium uppercase tracking-wide text-muted">Role</dt><dd className="mt-1 text-[13.5px] font-medium">{meta.name}</dd></div>
                <div><dt className="text-[12px] font-medium uppercase tracking-wide text-muted">Assigned organization</dt><dd className="mt-1 text-[13.5px] font-medium">{workspace.name}</dd></div>
                <div><dt className="text-[12px] font-medium uppercase tracking-wide text-muted">Provider runtime</dt><dd className="mt-1 text-[13.5px] font-medium">{agent.hermes_profile ? "Hermes Agent" : "Not connected"}</dd></div>
                <div><dt className="text-[12px] font-medium uppercase tracking-wide text-muted">Profile identifier</dt><dd className="mt-1 break-all font-mono text-[12px]">{agent.hermes_profile ?? "Not mapped"}</dd></div>
                <div><dt className="text-[12px] font-medium uppercase tracking-wide text-muted">Enabled</dt><dd className="mt-1 text-[13.5px] font-medium">{agent.enabled ? "Yes" : "No"}</dd></div>
                <div><dt className="text-[12px] font-medium uppercase tracking-wide text-muted">Operating mode</dt><dd className="mt-1 text-[13.5px] font-medium">{sentenceCase(agent.mode.replaceAll("_", " "))}</dd></div>
                <div><dt className="text-[12px] font-medium uppercase tracking-wide text-muted">Last verified activity</dt><dd className="mt-1 text-[13.5px] font-medium">{agent.last_health_check_at ? formatDateTime(agent.last_health_check_at, workspace.timezone) : "Never checked"}</dd></div>
                <div><dt className="text-[12px] font-medium uppercase tracking-wide text-muted">Connection detail</dt><dd className="mt-1 text-[13px] text-muted">{agent.last_health_detail ?? "No connection check recorded."}</dd></div>
              </dl>
              <div className="rounded-xl border border-line bg-surface-2/60 p-3.5">
                <p className="text-[12px] font-semibold text-ink-2">{agent.last_health_ok ? "Hermes connection verified" : "Hermes connection not verified"}</p>
                <p className="mt-1 text-[12.5px] leading-relaxed text-muted">{readiness.description}</p>
              </div>
              <div>
                <p className="mb-2 text-[12px] font-semibold">Configured role guidance</p>
                <ul className="grid gap-1.5 sm:grid-cols-2">{agent.default_tools.map((tool) => <li key={tool} className="text-[12.5px] text-ink-2">• {agentToolLabel(tool)}</li>)}</ul>
                <p className="mt-2 text-[12px] text-muted">These labels describe instruction guidance, not callable Hermes tools. Internal Operations Manager chat receives a read-only, tenant-scoped snapshot of agency tasks, approvals and persisted workforce activity; it cannot create approvals or save summaries.</p>
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-6 md:grid-cols-2">
            <Card>
              <CardHeader><div><CardTitle>Configuration summary</CardTitle><CardDescription>The active version, in plain English.</CardDescription></div></CardHeader>
              <CardContent className="space-y-3">
                <p className="text-[13px] leading-relaxed text-ink-2">{agent.config_summary ?? "No configuration has been applied yet."}</p>
                <Link href={`/admin/employees/open?role=${meta.slug}&to=manage`} className="inline-flex min-h-10 w-full items-center justify-between gap-2 rounded-xl border border-line bg-surface px-3 text-[12.5px] font-medium text-primary hover:bg-surface-2">
                  Open configuration and knowledge <ArrowUpRight className="size-3.5" />
                </Link>
                <p className="text-[12px] leading-relaxed text-muted">Configuration changes are versioned. Draft testing never edits this employee&apos;s active configuration.</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><div><CardTitle>Approved runtime inventory</CardTitle><CardDescription>Recorded by the authenticated health check, never inferred.</CardDescription></div></CardHeader>
              <CardContent className="space-y-2 text-[12.5px]">
                {agent.tool_inventory_contract ? (
                  <>
                    <div className="flex items-center justify-between gap-3"><span className="text-muted">Contract</span><span className="text-right font-mono text-[12px]">{agent.tool_inventory_contract}</span></div>
                    <div className="flex items-center justify-between gap-3"><span className="text-muted">Tools</span><span className="font-medium">{agent.tool_inventory_tool_count ?? 0}</span></div>
                    <div className="flex items-center justify-between gap-3"><span className="text-muted">Digest</span><span className="font-mono text-[12px]">{agent.tool_inventory_digest?.slice(0, 12)}…</span></div>
                    <div className="flex items-center justify-between gap-3"><span className="text-muted">Valid until</span><span className="text-right">{agent.tool_inventory_expires_at ? formatDateTime(agent.tool_inventory_expires_at, workspace.timezone) : "Not recorded"}</span></div>
                    {agent.tool_inventory_detail && <p className="rounded-xl bg-surface-2 p-3 text-[12px] leading-relaxed text-muted">{agent.tool_inventory_detail}</p>}
                  </>
                ) : (
                  <div className="rounded-xl border border-warning/25 bg-warning-soft/40 p-3 text-[12px] leading-relaxed text-warning-ink">
                    No approved inventory is recorded. Apply the configuration, then use <strong>Check</strong> in the header to run the authenticated connection check.
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>

        <div className="space-y-6">
          <ReadinessChecklist readiness={readiness} action={<Link href={`/admin/employees/open?role=${meta.slug}&to=manage`} className="inline-flex min-h-9 items-center gap-1.5 rounded-xl border border-line bg-surface px-3 text-[12px] font-medium text-primary hover:bg-surface-2">Configure <ArrowUpRight className="size-3.5" /></Link>} />
          <Card>
            <CardHeader><div><CardTitle>Recorded activity</CardTitle><CardDescription>The latest saved runs. Tokens come from the provider when reported.</CardDescription></div></CardHeader>
            <CardContent>
              {runs.length ? (
                <ul className="divide-y divide-line">
                  {runs.map((run) => (
                    <li key={run.id} className="flex flex-wrap items-center gap-2 py-2.5 text-[12.5px]">
                      <span className="min-w-0 flex-1">{formatDateTime(run.started_at, workspace.timezone)}</span>
                      <Badge tone={run.status === "completed" ? "success" : run.status === "cancelled" ? "neutral" : run.status === "running" ? "primary" : "danger"}>{sentenceCase(run.status)}</Badge>
                      <span className="text-muted">{run.total_tokens ?? "—"} tokens</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="py-4 text-[13px] text-muted">No runs recorded yet.</p>}
            </CardContent>
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader><div><CardTitle className="flex items-center gap-2"><BookOpen className="size-4" /> SOUL.md (managed by iAcquire)</CardTitle><CardDescription>The profile identity file used by the Hermes administrator. It is not editable from the portal and no portal save rewrites it.</CardDescription></div></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex justify-end"><CopyTextButton text={bundle.soul} label="Copy SOUL.md" /></div>
          <pre tabIndex={0} aria-label="SOUL.md content" className="scrollbar-thin max-h-80 overflow-auto whitespace-pre-wrap rounded-xl border border-line bg-surface-2 p-3 font-mono text-[12px] leading-relaxed text-ink-2">{bundle.soul}</pre>
          <p className="text-[12px] leading-relaxed text-muted">Client-specific instructions are sent with each run beneath this identity and the protected iAcquire policy. That keeps a model or instruction change from destroying the employee&apos;s identity or history.</p>
        </CardContent>
      </Card>
    </div>
  );
}
