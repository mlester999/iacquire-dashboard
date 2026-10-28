import Link from "next/link";
import { ArrowRight, Bot, ShieldCheck } from "lucide-react";
import { AgentAvatar } from "@/components/brand";
import { Card } from "@/components/ui/primitives";
import { MetricCard, PageHero } from "@/components/ui/workspace";
import { HermesProfileMapper } from "@/components/admin/hermes-profile-mapper";
import { AgencyWorkforceControls } from "@/components/admin/agency-workforce-controls";
import { ReadinessInline } from "@/components/workforce/employee-summary";
import { AGENT_BY_KEY, agentIdentityLabel } from "@/lib/agents";
import { deriveEmployeeReadiness } from "@/lib/workforce-readiness";
import { currentTime } from "@/lib/utils";
import type { listAgencyAgents } from "@/server/admin/queries";
import type { WizardGateway } from "@/components/admin/integration-wizard";

type AgencyAgent = Awaited<ReturnType<typeof listAgencyAgents>>[number];

export function AgencyWorkforceManager({ agents, gateways, canManage, timeZone = "UTC" }: { agents: AgencyAgent[]; gateways: WizardGateway[]; canManage: boolean; timeZone?: string }) {
  const evaluatedAt = currentTime();
  const readinessFor = (agent: AgencyAgent) => deriveEmployeeReadiness({
    displayName: agent.display_name,
    enabled: agent.enabled,
    status: agent.status,
    configVersion: agent.config_version,
    configured: agent.has_config,
    lastHealthCheckAt: agent.last_health_check_at?.toISOString() ?? null,
    lastHealthOk: agent.last_health_ok,
    credentialCurrent: agent.has_credential,
    lastHealthDetail: agent.last_health_detail,
    inventoryContract: agent.tool_inventory_contract,
    inventoryDigest: agent.tool_inventory_digest,
    inventoryVerifiedAt: agent.tool_inventory_verified_at?.toISOString() ?? null,
    inventoryExpiresAt: agent.tool_inventory_expires_at?.toISOString() ?? null,
    inventoryToolCount: agent.tool_inventory_tool_count,
    identityCurrent: agent.identity_current,
    acknowledgementCurrent: agent.full_capabilities_acknowledged,
    isAgencyEmployee: true,
    taskExecuting: agent.active_run,
    extras: agent.readiness_extras,
    evaluatedAt,
  });
  const mapped = agents.filter((agent) => agent.hermes_profile).length;
  const verified = agents.filter((agent) => readinessFor(agent).stage === "ready").length;
  return (
    <section className="module-stack" aria-labelledby="agency-workforce-heading">
      <PageHero
        tone="dark"
        eyebrow="iAcquire internal operations"
        icon={<ShieldCheck className="size-5" />}
        title="Agency AI workforce"
        description="The six existing iAcquire Hermes employees mapped to the shared protected gateway. Each keeps its own profile identity and API key; nothing here creates or overwrites a profile."
        action={<Link href="/admin/employees/open" className="inline-flex min-h-10 items-center gap-1.5 rounded-xl border border-white/20 bg-white/10 px-3.5 text-[13px] font-medium text-white hover:bg-white/15">Open internal workspace <ArrowRight className="size-3.5" aria-hidden /></Link>}
        aside={<div className="grid grid-cols-2 gap-3"><MetricCard label="Profiles mapped" value={`${mapped}/${agents.length || 6}`} detail="Existing identities only" icon={<Bot className="size-4" />} /><MetricCard label="Ready for authorized work" value={verified} detail="Expired inventory refreshes before chat" tone="green" icon={<ShieldCheck className="size-4" />} /></div>}
      />
      {agents.length ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {agents.map((agent) => {
            const role = AGENT_BY_KEY[agent.role_key];
            const readiness = readinessFor(agent);
            return (
              <Card key={agent.id} className="min-w-0 space-y-4 rounded-[22px] p-4 sm:p-5">
                <div className="flex items-start gap-3">
                  <AgentAvatar role={role} size="md" />
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate text-[15px] font-semibold text-ink" title={agentIdentityLabel(agent.display_name, role)}>{agentIdentityLabel(agent.display_name, role)}</h2>
                    <p className="mt-0.5 text-xs text-muted">{role.tagline}</p>
                  </div>
                </div>
                <ReadinessInline readiness={readiness} />
                <p className="text-[12px] leading-relaxed text-muted">{readiness.title}. {readiness.description}</p>
                <div className="rounded-xl border border-line bg-surface-2/70 p-3 text-xs">
                  <p className="font-medium text-ink-2">Hermes profile</p>
                  <p className="mt-1 break-all font-mono text-[12px] text-muted">{agent.hermes_profile || "Not mapped"}</p>
                  <p className="mt-2 leading-relaxed text-muted">{agent.last_health_detail || "No profile health check recorded."}</p>
                  <div className="mt-2 border-t border-line pt-2">
                    <p className="font-medium text-ink-2">Approved runtime inventory</p>
                  <p className="mt-1 leading-relaxed text-muted">{agent.tool_inventory_contract ? `${agent.tool_inventory_tool_count ?? 0} reviewed tools · digest ${agent.tool_inventory_digest?.slice(0, 12) ?? "unknown"}…` : "Not verified"}</p>
                  <p className="mt-1 leading-relaxed text-muted">{readiness.steps.find((step) => step.key === "inventory")?.description}</p>
                  <p className="mt-1 leading-relaxed text-muted">{agent.full_capabilities_acknowledged ? "Super Admin acknowledgement current" : "Super Admin acknowledgement required"}</p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Link href={`/admin/employees/${role.slug}`} className="inline-flex min-h-9 items-center gap-1.5 text-[13px] font-medium text-primary hover:underline">Open employee profile <ArrowRight className="size-3" aria-hidden /></Link>
                  <AgencyWorkforceControls agentId={agent.id} orgId={agent.org_id} slug={role.slug} employeeName={agent.display_name || role.name} enabled={agent.enabled} />
                </div>
                {canManage && <HermesProfileMapper agentId={agent.id} roleKey={agent.role_key} currentProfile={agent.hermes_profile} currentGatewayId={agent.hermes_gateway_id} hasCredential={agent.has_credential} gateways={gateways} canManage={canManage} canReviewTools={canManage} timeZone={timeZone} />}
              </Card>
            );
          })}
        </div>
      ) : <Card className="border-dashed p-6 text-sm text-muted">No agency employee records were found in the local workforce registry. The existing Hermes profiles have not been recreated or changed.</Card>}
    </section>
  );
}
