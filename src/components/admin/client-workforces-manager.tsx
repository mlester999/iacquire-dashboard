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
  const verified = clients.reduce((count, client) => count + client.verified, 0);
  const setupRequired = clients.reduce((count, client) => count + Math.max(0, 6 - client.verified), 0);
  const needsAttention = clients.reduce((count, client) => count + client.issues, 0);

  return (
    <section className="module-stack" aria-labelledby="client-workforces-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/admin/workforce" className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-line bg-surface px-3 text-sm font-medium text-primary hover:bg-surface-2"><ArrowLeft className="size-4" />Internal Workforce</Link>
        <ButtonLink href="/admin/clients" variant="secondary">Open clients</ButtonLink>
      </div>
      <PageHero tone="dark" eyebrow="Client operations" icon={<Building2 className="size-5" />} title="Client Workforces" description="Each client has a separate set of employee identities, credentials and health checks. Select a client to inspect its workforce." aside={<div className="grid grid-cols-2 gap-3"><MetricCard label="Client workspaces" value={clients.length} detail="Visible under your agency access" icon={<Users className="size-4" />} /><MetricCard label="Profiles verified" value={verified} detail="From each client’s latest saved checks" tone="green" icon={<ShieldCheck className="size-4" />} /></div>} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <MetricCard label="Profiles needing setup or verification" value={setupRequired} detail="Across the six-role client workforce" icon={<Users className="size-4" />} />
        <MetricCard label="Recorded connection issues" value={needsAttention} detail="Offline or error states" tone="amber" icon={<ShieldCheck className="size-4" />} />
        <div className="relative col-span-2 lg:col-span-1"><Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted" aria-hidden /><Input aria-label="Search client workforces" placeholder="Search client or industry…" className="min-h-11 pl-9" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
      </div>

      {shown.length ? <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {shown.map((client) => {
          const ready = client.identities === 6 && client.verified === 6;
          const provisioningStatus = client.provisioning_failed
            ? "failed"
            : client.provisioning_open
              ? "in_progress"
              : client.identities === 6
                ? "profiles_configured"
                : "not_started";
          return <Card key={client.id} className="flex min-w-0 flex-col gap-4 p-4 sm:p-5">
            <div className="flex items-start gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary"><Building2 className="size-5" /></span><div className="min-w-0 flex-1"><h2 className="truncate text-sm font-semibold text-ink">{client.name}</h2><p className="mt-1 truncate text-xs text-muted">{client.industry || "Industry not recorded"}</p></div><StatusPill status={client.status} size="sm" /></div>
            <div className="grid grid-cols-2 gap-2 rounded-xl bg-surface-2 p-3 text-center sm:grid-cols-4">
              <div><p className="text-lg font-semibold text-ink">{client.identities}</p><p className="text-[10px] text-muted">Identities</p></div>
              <div><p className="text-lg font-semibold text-ink">{client.mapped}/6</p><p className="text-[10px] text-muted">Mapped</p></div>
              <div><p className="text-lg font-semibold text-ink">{client.credentialed}/6</p><p className="text-[10px] text-muted">Keys saved</p></div>
              <div><p className="text-lg font-semibold text-ink">{client.verified}/6</p><p className="text-[10px] text-muted">Verified</p></div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs"><StatusPill status={ready ? "6_profiles_verified" : client.issues ? "needs_attention" : "setup_required"} size="sm" /><span className="text-muted">{client.issues ? `${client.issues} connection issue${client.issues === 1 ? "" : "s"}` : "No recorded connection issues"}</span></div>
            <div className="flex flex-wrap items-center gap-2 text-xs"><span className="text-muted">Provisioning:</span><StatusPill status={provisioningStatus} size="sm" /><span className="ml-auto text-muted">Hermes: {client.hermes_status ?? "not_configured"}</span></div>
            <p className="text-[11px] text-muted">Last successful profile check: {client.last_success_at ? formatDateTime(client.last_success_at, timeZone) : "None recorded"}</p>
            <Link href={`/admin/clients/${client.id}?tab=workforce`} className="mt-auto flex min-h-10 items-center justify-center rounded-xl border border-line bg-surface text-sm font-medium text-primary transition hover:bg-primary-soft">Open client workforce</Link>
          </Card>;
        })}
      </div> : <Card><EmptyState icon={<Search className="size-5" />} title={query ? "No matching client workforces" : "No client workforces are visible"} description={query ? "Try another client name or industry." : "Client workforces appear here only for clients your agency role may access."} action={query ? <button type="button" className="text-sm font-medium text-primary" onClick={() => setQuery("")}>Clear search</button> : undefined} /></Card>}
    </section>
  );
}
