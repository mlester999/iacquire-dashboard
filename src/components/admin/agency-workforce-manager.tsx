"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Activity, ArrowLeft, Bot, ShieldCheck, Stethoscope } from "lucide-react";
import { AgentAvatar, AgentStatusBadge } from "@/components/brand";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/primitives";
import { MetricCard, PageHero } from "@/components/ui/workspace";
import { StatusPill } from "@/components/ui/status";
import { HermesProfileMapper } from "@/components/admin/hermes-profile-mapper";
import { testAllAgencyProfilesAction } from "@/app/(admin)/admin/actions";
import { AGENT_BY_KEY, AGENCY_HERMES_PROFILE_IDS } from "@/lib/agents";
import type { listAgencyAgents } from "@/server/admin/queries";
import type { WizardGateway } from "@/components/admin/integration-wizard";
import type { AgencyProfileVerification } from "@/server/workforce/agency";
import { formatDateTime } from "@/lib/utils";

type AgencyAgent = Awaited<ReturnType<typeof listAgencyAgents>>[number];

export function AgencyWorkforceManager({
  agents,
  gateways,
  canManage,
  timeZone,
}: {
  agents: AgencyAgent[];
  gateways: WizardGateway[];
  canManage: boolean;
  timeZone: string;
}) {
  const router = useRouter();
  const [testing, setTesting] = React.useState(false);
  const [testError, setTestError] = React.useState<string | null>(null);
  const [results, setResults] = React.useState<AgencyProfileVerification[] | null>(null);
  const mapped = agents.filter((agent) => agent.hermes_profile === AGENCY_HERMES_PROFILE_IDS[agent.role_key] && agent.hermes_gateway_id).length;
  const verified = agents.filter((agent) => agent.profile_check_status === "verified" && agent.profile_identity_verified === true).length;
  const pendingApprovals = agents.reduce((total, agent) => total + agent.pending_approvals, 0);
  const recentRuns = agents.reduce((total, agent) => total + agent.runs_30d, 0);

  async function testAll() {
    setTesting(true);
    setTestError(null);
    try {
      const result = await testAllAgencyProfilesAction();
      if (!result.ok) throw new Error(result.error);
      setResults(result.data.results);
      router.refresh();
    } catch (reason) {
      setTestError(reason instanceof Error ? reason.message : "The profile checks could not be completed.");
    } finally {
      setTesting(false);
    }
  }

  return (
    <section className="module-stack" aria-labelledby="agency-workforce-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/admin/integrations" className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-line bg-surface px-3 text-sm font-medium text-primary hover:bg-surface-2">
          <ArrowLeft className="size-4" /> Hermes integration wizard
        </Link>
        <ButtonLink href="/admin/workforce/clients" variant="secondary">View client workforces</ButtonLink>
      </div>
      <PageHero
        tone="dark"
        eyebrow="iAcquire internal operations"
        icon={<ShieldCheck className="size-5" />}
        title="Internal Workforce"
        description="These six agency employees belong to iAcquire. Client employees are managed in the separate Client Workforces view."
        aside={<div className="grid grid-cols-2 gap-3"><MetricCard label="Profiles mapped" value={`${mapped}/6`} detail="Exact existing Hermes identities" icon={<Bot className="size-4" />} /><MetricCard label="Profiles verified" value={`${verified}/6`} detail="Read-only identity and API checks" tone="green" icon={<ShieldCheck className="size-4" />} /></div>}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <MetricCard label="Pending approvals" value={pendingApprovals} detail="Open requests for agency employees" icon={<ShieldCheck className="size-4" />} />
        <MetricCard label="Recent activity" value={recentRuns} detail="Recorded runs in the last 30 days" tone="violet" icon={<Activity className="size-4" />} />
        <div className="col-span-2 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-surface p-4 lg:col-span-1">
          <div><p className="text-sm font-semibold text-ink">Profile verification</p><p className="mt-1 text-xs leading-relaxed text-muted">Each check reads the saved profile with its own key. No AI task is started.</p></div>
          {canManage && <Button onClick={() => void testAll()} loading={testing} variant="secondary"><Stethoscope className="size-4" />Test all six</Button>}
        </div>
      </div>

      {gateways.length > 0 && <Card className="flex flex-wrap items-center gap-3 p-4">
        <ShieldCheck className="size-5 text-primary" />
        <div className="min-w-0 flex-1"><p className="text-sm font-semibold text-ink">Shared gateway health</p><p className="mt-1 text-xs text-muted">Gateway connectivity and profile identity checks are reported separately.</p></div>
        <div className="flex flex-wrap gap-2">{gateways.map((gateway) => <span key={gateway.id} className="inline-flex items-center gap-2 rounded-xl bg-surface-2 px-3 py-2 text-xs"><span className="font-medium text-ink">{gateway.label}</span><StatusPill status={gateway.status} size="sm" />{gateway.lastHealthCheckAt && <span className="text-muted">{formatDateTime(gateway.lastHealthCheckAt, timeZone)}</span>}</span>)}</div>
      </Card>}

      {testError && <p className="rounded-xl bg-danger-soft p-3 text-sm text-danger-ink" role="alert">{testError}</p>}
      {results && <Card className="space-y-3 p-4" aria-live="polite">
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold text-ink">Latest profile test results</h2><p className="text-xs text-muted">{results.filter((item) => item.checked).length} checked · {results.filter((item) => item.ok).length} verified · {results.filter((item) => !item.checked).length} not configured</p></div>
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{results.map((item) => <li key={item.roleKey} className="min-w-0 rounded-xl border border-line p-3">
          <div className="flex items-center justify-between gap-2"><p className="text-xs font-semibold text-ink">{AGENT_BY_KEY[item.roleKey].shortName}</p><StatusPill status={item.status} size="sm" /></div>
          <p className="mt-1 break-all font-mono text-[10px] text-muted">{item.profile}</p>
          <p className="mt-2 text-xs leading-relaxed text-muted">{item.detail}</p>
        </li>)}</ul>
      </Card>}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {agents.map((agent) => {
          const role = AGENT_BY_KEY[agent.role_key];
          const test = results?.find((item) => item.roleKey === agent.role_key);
          return <Card key={agent.id} className="min-w-0 space-y-4 p-4 sm:p-5">
            <div className="flex items-start gap-3">
              <AgentAvatar role={role} size="md" />
              <div className="min-w-0 flex-1"><h2 className="truncate text-sm font-semibold text-ink">{role.shortName}</h2><p className="mt-0.5 text-xs text-muted">{role.tagline}</p></div>
              <AgentStatusBadge status={agent.enabled ? agent.status : "disabled"} />
            </div>
            <dl className="grid grid-cols-2 gap-2 rounded-xl bg-surface-2 p-3 text-xs">
              <div><dt className="text-muted">Hermes identity</dt><dd className="mt-1 break-all font-mono text-ink">{agent.hermes_profile || "Not mapped"}</dd></div>
              <div><dt className="text-muted">Profile credential</dt><dd className="mt-1 text-ink">{agent.has_credential ? "Saved in Vault" : "Not configured"}</dd></div>
              <div><dt className="text-muted">Configuration</dt><dd className="mt-1 text-ink">{agent.has_config ? "Applied" : "Setup required"}</dd></div>
              <div><dt className="text-muted">Tool permissions</dt><dd className="mt-1 text-ink">{agent.tool_permissions_status === "verified" ? "Verified" : agent.tool_permissions_status === "restricted" ? "Review needed" : agent.tool_permissions_status === "incomplete" ? "Inventory incomplete" : agent.tool_permissions_status === "unavailable" ? "Not verified" : "Not checked"}</dd></div>
              <div><dt className="text-muted">Pending approvals</dt><dd className="mt-1 text-ink">{agent.pending_approvals}</dd></div>
              <div><dt className="text-muted">Runs, 30 days</dt><dd className="mt-1 text-ink">{agent.runs_30d}</dd></div>
              <div className="col-span-2"><dt className="text-muted">Last verified profile check</dt><dd className="mt-1 text-ink">{agent.profile_verified_at ? formatDateTime(agent.profile_verified_at, timeZone) : "No successful profile check"}</dd></div>
            </dl>
            <div className="rounded-xl border border-line p-3 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2"><p className="font-medium text-ink">Connection evidence</p><StatusPill status={agent.gateway_status ?? "not_configured"} size="sm" /></div>
              <p className="mt-2 leading-relaxed text-muted">{test?.detail ?? agent.profile_check_detail ?? "No profile health check recorded."}</p>
              {agent.last_activity_at && <p className="mt-2 text-[11px] text-muted">Latest recorded run: {formatDateTime(agent.last_activity_at, timeZone)}</p>}
            </div>
            <HermesProfileMapper agentId={agent.id} roleKey={agent.role_key} currentProfile={agent.hermes_profile} currentGatewayId={agent.hermes_gateway_id} hasCredential={agent.has_credential} gateways={gateways} canManage={canManage} />
          </Card>;
        })}
      </div>
    </section>
  );
}
