import { Bot, ShieldCheck } from "lucide-react";
import { AgentAvatar, AgentStatusBadge } from "@/components/brand";
import { Card } from "@/components/ui/primitives";
import { MetricCard, PageHero } from "@/components/ui/workspace";
import { HermesProfileMapper } from "@/components/admin/hermes-profile-mapper";
import { AGENT_BY_KEY } from "@/lib/agents";
import type { listAgencyAgents } from "@/server/admin/queries";
import type { WizardGateway } from "@/components/admin/integration-wizard";

type AgencyAgent = Awaited<ReturnType<typeof listAgencyAgents>>[number];

export function AgencyWorkforceManager({
  agents,
  gateways,
  canManage,
}: {
  agents: AgencyAgent[];
  gateways: WizardGateway[];
  canManage: boolean;
}) {
  const mapped = agents.filter((agent) => agent.hermes_profile).length;
  const verified = agents.filter((agent) => agent.status === "online" || agent.status === "busy").length;
  return (
    <section className="module-stack" aria-labelledby="agency-workforce-heading">
      <PageHero
        tone="dark"
        eyebrow="iAcquire internal operations"
        icon={<ShieldCheck className="size-5" />}
        title="Agency AI workforce"
        description="Map iAcquire’s six existing Hermes employees to the shared protected gateway. Each employee keeps its own profile identity and API key."
        aside={<div className="grid grid-cols-2 gap-3"><MetricCard label="Profiles mapped" value={`${mapped}/${agents.length || 6}`} detail="Existing identities only" icon={<Bot className="size-4" />} /><MetricCard label="Verified online" value={verified} detail="Latest saved health checks" tone="green" icon={<ShieldCheck className="size-4" />} /></div>}
      />
      {agents.length ? <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{agents.map((agent) => {
        const role = AGENT_BY_KEY[agent.role_key];
        return <Card key={agent.id} className="min-w-0 space-y-4 p-4 sm:p-5">
          <div className="flex items-start gap-3">
            <AgentAvatar role={role} size="md" />
            <div className="min-w-0 flex-1"><h2 className="truncate text-sm font-semibold text-ink">{agent.display_name || role.name}</h2><p className="mt-0.5 text-xs text-muted">{role.tagline}</p></div>
            <AgentStatusBadge status={agent.enabled ? agent.status : "disabled"} />
          </div>
          <div className="rounded-xl bg-surface-2 p-3 text-xs">
            <p className="font-medium text-ink-2">Hermes profile</p>
            <p className="mt-1 break-all font-mono text-muted">{agent.hermes_profile || "Not mapped"}</p>
            <p className="mt-2 leading-relaxed text-muted">{agent.last_health_detail || "No profile health check recorded."}</p>
          </div>
          {canManage && <HermesProfileMapper agentId={agent.id} employeeName={role.shortName} currentProfile={agent.hermes_profile} gateways={gateways} />}
        </Card>;
      })}</div> : <Card className="border-dashed p-6 text-sm text-muted">No agency employee records were found in the local workforce registry. The existing Hermes profiles have not been recreated or changed.</Card>}
    </section>
  );
}
