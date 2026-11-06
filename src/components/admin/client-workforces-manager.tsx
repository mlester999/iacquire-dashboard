"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft, Building2, Search, ShieldCheck, Users } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { Card, EmptyState, Input } from "@/components/ui/primitives";
import { MetricCard, PageHero } from "@/components/ui/workspace";
import { StatusPill } from "@/components/ui/status";
import type { listClientWorkforceSummaries } from "@/server/workforce/agency-registry";
import { formatDateTime } from "@/lib/utils";

type ClientWorkforce = Awaited<ReturnType<typeof listClientWorkforceSummaries>>[number];

export function ClientWorkforcesManager({ clients, timeZone }: { clients: ClientWorkforce[]; timeZone: string }) {
  const [query, setQuery] = React.useState("");
  const shown = clients.filter((client) => `${client.name} ${client.industry ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()));
  const verifiedPartners = clients.filter((client) => client.growth_partner_identities === 1 && client.growth_partner_verified === 1).length;
  const setupRequired = clients.filter((client) => client.growth_partner_identities !== 1 || client.growth_partner_verified !== 1).length;
  const needsAttention = clients.reduce((count, client) => count + client.growth_partner_issues, 0);
  const retainedNeedingChecks = clients.reduce((count, client) => count + Math.max(0, client.retained_profiles - client.retained_verified), 0);
  const retainedTotal = clients.reduce((count, client) => count + client.retained_profiles, 0);

  return (
    <section className="module-stack" aria-labelledby="client-workforces-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/admin/employees" className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-line bg-surface px-3 text-sm font-medium text-primary hover:bg-surface-2"><ArrowLeft className="size-4" />Internal profiles</Link>
        <ButtonLink href="/admin/clients" variant="secondary">Open clients</ButtonLink>
      </div>
      <PageHero tone="dark" eyebrow="Client operations" icon={<Building2 className="size-5" />} title="AI Growth Partner readiness" description="Track the current AI Growth Partner runtime for each client. Retained role profiles, credentials and health checks remain available for audit and staged migration." aside={<div className="grid grid-cols-2 gap-3"><MetricCard label="Client workspaces" value={clients.length} detail="Visible under your agency access" icon={<Users className="size-4" />} /><MetricCard label="Growth Partners verified" value={verifiedPartners} detail="Client runtimes with recorded health checks" tone="green" icon={<ShieldCheck className="size-4" />} /></div>} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <MetricCard label="Growth Partners needing checks" value={setupRequired} detail="Missing identity or verified runtime health" icon={<Users className="size-4" />} />
        <MetricCard label="Retained profiles needing checks" value={retainedNeedingChecks} detail={`Of ${retainedTotal} preserved role profiles`} icon={<Users className="size-4" />} />
        <MetricCard label="Partner connection issues" value={needsAttention} detail="Offline or error states" tone="amber" icon={<ShieldCheck className="size-4" />} />
        <div className="relative col-span-2 lg:col-span-1"><Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted" aria-hidden /><Input aria-label="Search client workspaces" placeholder="Search client or industry…" className="min-h-11 pl-9" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
      </div>

      {shown.length ? <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {shown.map((client) => {
          const ready = client.growth_partner_identities === 1 && client.growth_partner_verified === 1;
          const partnerConfigured = client.growth_partner_mapped === 1 && client.growth_partner_credentialed === 1;
          const partnerStatus = client.growth_partner_identities !== 1
            ? { label: "Not provisioned", tone: "neutral" as const }
            : ready
              ? { label: "Runtime checks passed", tone: "success" as const }
              : client.growth_partner_issues > 0
                ? { label: "Needs attention", tone: "danger" as const }
                : partnerConfigured
                  ? { label: "Awaiting health check", tone: "warning" as const }
                  : { label: "Setup required", tone: "warning" as const };
          const provisioningStatus = client.provisioning_failed
            ? "failed"
            : client.provisioning_open
              ? "in_progress"
              : client.growth_partner_identities === 1
                ? "profiles_configured"
                : "not_started";
          return <Card key={client.id} className="flex min-w-0 flex-col gap-4 p-4 sm:p-5">
            <div className="flex items-start gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary"><Building2 className="size-5" /></span><div className="min-w-0 flex-1"><h2 className="truncate text-sm font-semibold text-ink">{client.name}</h2><p className="mt-1 truncate text-xs text-muted">{client.industry || "Industry not recorded"}</p></div><StatusPill status={client.status} size="sm" /></div>
            <section className="space-y-2 rounded-xl border border-line bg-surface-2/40 p-3" aria-label="AI Growth Partner runtime">
              <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-[13px] font-semibold text-ink">AI Growth Partner</p><StatusPill tone={partnerStatus.tone} size="sm">{partnerStatus.label}</StatusPill></div>
              <div className="grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
                <div><p className="text-[13px] font-semibold text-ink">{client.growth_partner_identities === 1 ? "Present" : "Missing"}</p><p className="text-[12px] text-muted">Identity</p></div>
                <div><p className="text-[13px] font-semibold text-ink">{client.growth_partner_mapped === 1 ? "Mapped" : "Not mapped"}</p><p className="text-[12px] text-muted">Runtime profile</p></div>
                <div><p className="text-[13px] font-semibold text-ink">{client.growth_partner_credentialed === 1 ? "Saved" : "Missing"}</p><p className="text-[12px] text-muted">Credential</p></div>
                <div><p className="text-[13px] font-semibold text-ink">{client.growth_partner_verified === 1 ? "Passed" : "Not verified"}</p><p className="text-[12px] text-muted">Health check</p></div>
              </div>
            </section>
            <p className="text-[12px] text-muted">{client.growth_partner_issues ? `${client.growth_partner_issues} Growth Partner connection issue${client.growth_partner_issues === 1 ? "" : "s"} recorded` : "No Growth Partner connection issues recorded"}</p>
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line px-3 py-2 text-xs"><span className="font-medium text-ink-2">Retained role profiles</span><span className="text-muted">{client.retained_profiles} · {client.retained_verified} verified · {client.retained_mapped} mapped · {client.retained_credentialed} credentials · {client.retained_issues} issues</span></div>
            <div className="flex flex-wrap items-center gap-2 text-xs"><span className="text-muted">Provisioning:</span><StatusPill status={provisioningStatus} size="sm" /><span className="ml-auto text-muted">Hermes: {client.hermes_status ?? "not_configured"}</span></div>
            <p className="text-[12px] text-muted">Last successful Growth Partner check: {client.growth_partner_last_success_at ? formatDateTime(client.growth_partner_last_success_at, timeZone) : "None recorded"}</p>
            <Link href={`/admin/clients/${client.id}?tab=workforce`} className="mt-auto flex min-h-10 items-center justify-center rounded-xl border border-line bg-surface text-sm font-medium text-primary transition hover:bg-primary-soft">Open runtime readiness</Link>
          </Card>;
        })}
      </div> : <Card><EmptyState icon={<Search className="size-5" />} title={query ? "No matching client workspaces" : "No client workspaces are visible"} description={query ? "Try another client name or industry." : "Client workspaces appear here only for clients your agency role may access."} action={query ? <button type="button" className="text-sm font-medium text-primary" onClick={() => setQuery("")}>Clear search</button> : undefined} /></Card>}
    </section>
  );
}
