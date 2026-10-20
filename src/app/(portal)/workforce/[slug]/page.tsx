import { notFound, redirect } from "next/navigation";
import { requireOrgContext } from "@/server/tenancy/context";
import { editableSettings, getAgentByRole, listConfigVersions } from "@/server/workforce/service";
import { withSystem, withUser } from "@/server/db";
import { EmployeeDetail } from "@/components/workforce/employee-detail";
import { AGENT_BY_SLUG } from "@/lib/agents";
import { autonomousBlocker } from "@/server/automation/controls";
import { getEmployeeInstructionOverview } from "@/server/workforce/instructions";
import { listEmployeeKnowledge } from "@/server/workforce/knowledge";
import { ACCEPTED_UPLOADS } from "@/server/knowledge/service";
import { currentTime } from "@/lib/utils";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return { title: AGENT_BY_SLUG[slug]?.name ?? "AI employee" };
}

export default async function EmployeePage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ tab?: string; version?: string }> }) {
  const [{ slug }, { tab, version }] = await Promise.all([params, searchParams]);
  const meta = AGENT_BY_SLUG[slug];
  if (!meta) notFound();
  const ctx = await requireOrgContext();
  // The same employee screen configures an internal (agency-organization) employee for the Super Admin who
  // opened it through /admin/workforce/open?to=manage. Client workspaces keep their existing boundary; every
  // other agency role is still sent back to the admin area.
  const internalEmployee = ctx.org.kind === "agency" && ctx.user.platformRole === "agency_super_admin";
  if (ctx.org.kind !== "client" && !internalEmployee) redirect(ctx.user.platformRole === "agency_super_admin" ? "/admin/workforce" : ctx.user.platformRole === "agency_staff" ? "/admin/workforce/clients" : "/no-workspace");
  const agent = await getAgentByRole(ctx.user.id, ctx.org.orgId, meta.key);
  if (!agent) notFound();
  const canConfigure = ctx.can("agents.configure");
  const canViewKnowledge = ctx.can("knowledge.view");
  const requestedVersion = typeof version === "string" && /^[0-9a-f-]{36}$/i.test(version) ? version : null;

  const [controls, versions, settings, knowledgeView, instructionOverview, extra, acknowledgementCurrent] = await Promise.all([
    withSystem(async (db) => {
      const { rows } = await db.query<{ last_health_ok: boolean | null }>("select last_health_ok from agent_instances where id = $1 and org_id = $2", [agent.id, ctx.org.orgId]);
      const blocker = await autonomousBlocker(db, ctx.org.orgId, { enabled: agent.enabled, status: agent.status, last_health_ok: rows[0]?.last_health_ok ?? null, display_name: agent.display_name });
      const pause = await db.query("select 1 from automation_pauses where org_id = $1 and scope = 'agency' and active", [ctx.org.orgId]);
      return { autonomousBlockedReason: blocker, agencyPaused: pause.rows.length > 0 };
    }),
    canConfigure ? listConfigVersions(ctx.user.id, agent.id) : Promise.resolve([]),
    canConfigure ? withSystem((db) => editableSettings(db, agent.id, ctx.org.orgId, requestedVersion)) : Promise.resolve(null),
    canViewKnowledge ? listEmployeeKnowledge(ctx, agent.id).catch(() => null) : Promise.resolve(null),
    canConfigure
      ? getEmployeeInstructionOverview({ orgId: ctx.org.orgId, agentId: agent.id, role: meta.key, companyName: ctx.org.name })
      : Promise.resolve(null),
    withUser(ctx.user.id, async (db) => {
      const role = await db.query<{ capabilities: string[]; description: string }>("select capabilities, description from agent_roles where key = $1", [meta.key]);
      const knowledge = await db.query<{ applied: Date | null }>("select max(applied_at) as applied from company_knowledge where org_id = $1", [ctx.org.orgId]);
      const runs = await db.query<{ id: string; purpose: string; status: string; started_at: Date; finished_at: Date | null; total_tokens: number | null; tools: number; error_message: string | null }>(
        `select r.id, r.purpose, r.status, r.started_at, r.finished_at, r.total_tokens, r.error_message,
                (select count(*)::int from tool_executions t where t.run_id = r.id) as tools
         from agent_runs r where r.agent_instance_id = $1 order by r.started_at desc limit 25`,
        [agent.id],
      );
      const approvals = await db.query<{ n: number }>(
        "select count(*)::int as n from approval_requests where agent_instance_id = $1 and status = 'pending'",
        [agent.id],
      );
      return {
        capabilities: role.rows[0]?.capabilities ?? [],
        description: role.rows[0]?.description ?? meta.tagline,
        knowledgeAppliedAt: knowledge.rows[0]?.applied ? new Date(knowledge.rows[0].applied).toISOString() : null,
        runs: runs.rows.map((r) => ({ ...r, started_at: new Date(r.started_at).toISOString(), finished_at: r.finished_at ? new Date(r.finished_at).toISOString() : null })),
        pendingApprovals: approvals.rows[0]?.n ?? 0,
      };
    }),
    internalEmployee
      ? withSystem(async (db) => {
          const { rows } = await db.query<{ current: boolean | null }>(
            `select (ack.acknowledged_at >= c.checked_at) as current
               from hermes_tool_policy_acknowledgements ack
               left join agency_hermes_profile_checks c on c.agent_instance_id = ack.agent_id
              where ack.agent_id = $1`,
            [agent.id],
          );
          // An internal employee without a recorded acknowledgement is not approved.
          return rows[0]?.current === true;
        })
      : Promise.resolve(null),
  ]);

  return (
    <EmployeeDetail
      meta={meta}
      agent={{
        id: agent.id,
        displayName: agent.display_name,
        enabled: agent.enabled,
        status: agent.enabled ? agent.status : "disabled",
        lastHealthCheckAt: agent.last_health_check_at ? new Date(agent.last_health_check_at).toISOString() : null,
        lastHealthOk: agent.last_health_ok,
        lastHealthDetail: agent.last_health_detail,
        summary: agent.summary,
        configVersion: agent.config_version,
        configAppliedAt: agent.config_applied_at ? new Date(agent.config_applied_at).toISOString() : null,
        defaultTools: agent.default_tools,
        mode: agent.mode,
        providerRuntime: agent.hermes_profile ? "Hermes Agent" : "Not connected",
        assignedOrganization: ctx.org.name,
        lastActivityAt: extra.runs[0]?.started_at ?? null,
        inventoryDigest: agent.tool_inventory_digest,
        inventoryVerifiedAt: agent.tool_inventory_verified_at ? new Date(agent.tool_inventory_verified_at).toISOString() : null,
        inventoryToolCount: agent.tool_inventory_tool_count,
      }}
      canPause={ctx.can("automation.pause")}
      canGoAutonomous={ctx.can("automation.go_autonomous")}
      autonomousBlockedReason={controls.autonomousBlockedReason}
      agencyPaused={controls.agencyPaused}
      settings={settings?.settings ?? null}
      draftVersion={settings?.pendingVersion ?? null}
      draftStatus={settings?.draftStatus ?? null}
      isInternalWorkspace={ctx.org.kind === "agency"}
      knowledgeView={knowledgeView}
      instructionOverview={instructionOverview}
      canViewKnowledge={canViewKnowledge}
      canEditKnowledge={ctx.can("knowledge.edit")}
      uploadAccept={ACCEPTED_UPLOADS}
      versions={versions.map((v) => ({
        ...v,
        created_at: new Date(v.created_at).toISOString(),
        applied_at: v.applied_at ? new Date(v.applied_at).toISOString() : null,
        decided_at: v.decided_at ? new Date(v.decided_at).toISOString() : null,
      }))}
      canConfigure={canConfigure}
      canChat={ctx.can("agents.use")}
      isAgencyEmployee={internalEmployee}
      acknowledgementCurrent={acknowledgementCurrent}
      adminManageHref={internalEmployee ? `/admin/workforce/${meta.slug}` : null}
      initialTab={tab ?? "overview"}
      timeZone={ctx.org.timezone}
      now={currentTime()}
      {...extra}
    />
  );
}
