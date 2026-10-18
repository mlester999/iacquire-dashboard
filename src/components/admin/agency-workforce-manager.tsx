import Link from "next/link";
import { ArrowRight, Bot, ShieldCheck } from "lucide-react";
import { AgentAvatar, AgentStatusBadge } from "@/components/brand";
import { Card } from "@/components/ui/primitives";
import { MetricCard, PageHero } from "@/components/ui/workspace";
import { HermesProfileMapper } from "@/components/admin/hermes-profile-mapper";
import { AgencyWorkforceControls } from "@/components/admin/agency-workforce-controls";
import { AGENT_BY_KEY } from "@/lib/agents";
import type { listAgencyAgents } from "@/server/admin/queries";
import type { WizardGateway } from "@/components/admin/integration-wizard";

type AgencyAgent = Awaited<ReturnType<typeof listAgencyAgents>>[number];

export function AgencyWorkforceManager({
  agents,
  gateways,
  canManage,
  timeZone = "UTC",
}: {
  agents: AgencyAgent[];
  gateways: WizardGateway[];
  canManage: boolean;
  timeZone?: string;
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
        action={
          <Link href="/admin/workforce/open" className="inline-flex min-h-10 items-center gap-1.5 rounded-xl border border-white/20 bg-white/10 px-3.5 text-[12.5px] font-medium text-white hover:bg-white/15">
            Open internal workspace <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        }
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
            {["provisioning", "setup_required", "offline", "error"].includes(agent.status) && (
              <p className="mt-2 font-medium text-warning-ink">Why this employee is not online</p>
            )}
            <p className="mt-1 leading-relaxed text-muted">{agent.last_health_detail || "No profile health check recorded."}</p>
            <div className="mt-2 border-t border-line pt-2">
              <p className="font-medium text-ink-2">Complete tool inventory</p>
              <p className="mt-1 leading-relaxed text-muted">
                {agent.tool_inventory_contract
                  ? `${agent.tool_inventory_tool_count ?? 0} reviewed tool${agent.tool_inventory_tool_count === 1 ? "" : "s"} · digest ${agent.tool_inventory_digest?.slice(0, 12) ?? "unknown"}…`
                  : "Not verified"}
              </p>
              {agent.tool_inventory_detail && <p className="mt-1 leading-relaxed text-muted">{agent.tool_inventory_detail}</p>}
            </div>
          </div>
          <Link href={`/admin/workforce/${role.slug}`} className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-primary hover:underline">
            Open employee profile <ArrowRight className="size-3" aria-hidden />
          </Link>
          <AgencyWorkforceControls agentId={agent.id} orgId={agent.org_id} slug={role.slug} employeeName={agent.display_name || role.name} enabled={agent.enabled} />
          {canManage && <HermesProfileMapper
            agentId={agent.id}
            roleKey={agent.role_key}
            currentProfile={agent.hermes_profile}
            currentGatewayId={agent.hermes_gateway_id}
            hasCredential={agent.has_credential}
            gateways={gateways}
            canManage={canManage}
            canReviewTools={canManage}
            timeZone={timeZone}
          />}
        </Card>;
      })}</div> : <Card className="border-dashed p-6 text-sm text-muted">No agency employee records were found in the local workforce registry. The existing Hermes profiles have not been recreated or changed.</Card>}
    </section>
  );
}
