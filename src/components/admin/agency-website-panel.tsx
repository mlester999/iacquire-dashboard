"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CalendarDays, Clock, Globe, MessagesSquare, ShoppingCart, TriangleAlert } from "lucide-react";
import { quoteDomainAction, recordDomainPurchasedAction } from "@/app/(admin)/admin/website-actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Input } from "@/components/ui/primitives";
import { InfoChip, StatusPill } from "@/components/ui/status";
import { Callout, IconTile, StatTile } from "@/components/admin/setup/ui";
import { websiteState } from "@/components/admin/setup/website-state";
import { domainStatusLabel, domainStatusTone } from "@/components/website/portal/domain-status";
import { formatCurrency, formatDate, formatNumber, relativeTime } from "@/lib/utils";
import { resolveTemplate } from "@/lib/website/templates";
import type { AgencyWebsiteView } from "@/server/websites/agency";
import type { DomainView } from "@/server/websites/service";

function Purchase({ orgId, d }: { orgId: string; d: DomainView }) {
  const router = useRouter();
  const [price, setPrice] = React.useState("");
  const [renews, setRenews] = React.useState("");
  const [registrar, setRegistrar] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>, ok: string) => {
    setBusy(true);
    const res = await fn();
    setBusy(false);
    if (!res.ok) return void toast.error(res.error ?? "That didn't work.");
    toast.success(ok);
    router.refresh();
  };

  return (
    <li className="space-y-3 py-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <IconTile icon={<ShoppingCart />} tone="primary" size="sm" />
        <p className="min-w-0 break-all text-[14.5px] font-semibold text-ink">{d.hostname}</p>
        <StatusPill tone={d.acquisition === "purchase_requested" && !d.purchaseCostMicros ? "warning" : "primary"}>{d.acquisition === "purchase_requested" ? (d.purchaseCostMicros ? "Waiting for the client to approve" : "Needs a price") : "Approved, ready to register"}</StatusPill>
      </div>
      {d.acquisition === "purchase_requested" && !d.purchaseCostMicros && (
        <form className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]" onSubmit={(e) => { e.preventDefault(); void act(() => quoteDomainAction(orgId, d.id, Number(price), renews), "Price sent to the client for approval."); }}>
          <div>
            <label htmlFor={`price-${d.id}`} className="mb-1.5 block text-[13px] font-medium text-ink-2">First-year price (USD)</label>
            <Input id={`price-${d.id}`} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="14.98" />
          </div>
          <div>
            <label htmlFor={`renews-${d.id}`} className="mb-1.5 block text-[13px] font-medium text-ink-2">First renewal date (optional)</label>
            <Input id={`renews-${d.id}`} type="date" value={renews} onChange={(e) => setRenews(e.target.value)} />
          </div>
          <div className="flex items-end">
            <Button type="submit" variant="brand" loading={busy} disabled={!(Number(price) > 0)}>Send quote</Button>
          </div>
        </form>
      )}
      {d.acquisition === "purchase_requested" && d.purchaseCostMicros ? (
        <Callout tone="warning" icon={<TriangleAlert />}>Quoted {formatCurrency(d.purchaseCostMicros / 1_000_000)} for the first year. Do not buy it until the client approves.</Callout>
      ) : null}
      {d.acquisition === "purchase_approved" && (
        <form className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]" onSubmit={(e) => { e.preventDefault(); void act(() => recordDomainPurchasedAction(orgId, d.id, registrar, renews), "Recorded. The client has been told it's registered."); }}>
          <Callout tone="success" className="sm:col-span-3">
            The client approved {d.purchaseCostMicros ? formatCurrency(d.purchaseCostMicros / 1_000_000) : "the price"} for the first year, billed at cost. Register it in the client&apos;s own name at a registrar, then record it here.
          </Callout>
          <div>
            <label htmlFor={`reg-${d.id}`} className="mb-1.5 block text-[13px] font-medium text-ink-2">Registrar</label>
            <Input id={`reg-${d.id}`} value={registrar} onChange={(e) => setRegistrar(e.target.value)} maxLength={80} placeholder="Where it's registered" />
          </div>
          <div>
            <label htmlFor={`renew-${d.id}`} className="mb-1.5 block text-[13px] font-medium text-ink-2">Renews on</label>
            <Input id={`renew-${d.id}`} type="date" value={renews} onChange={(e) => setRenews(e.target.value)} />
          </div>
          <div className="flex items-end">
            <Button type="submit" variant="brand" loading={busy} disabled={!registrar.trim() || !renews}>Record purchase</Button>
          </div>
        </form>
      )}
    </li>
  );
}

/** A client's website as the agency sees it: live state and health, domains, enquiry volume, and any domain waiting on us. */
export function AgencyWebsitePanel({ orgId, data, timeZone }: { orgId: string; data: AgencyWebsiteView; timeZone: string }) {
  if (!data.exists) {
    return (
      <Card>
        <EmptyState icon={<Globe className="size-5" />} title={`${data.orgName} hasn't started a website yet.`} description="Once the client opens Website Studio, its live state, health and domains appear here." />
      </Card>
    );
  }
  const tpl = data.templateKey ? resolveTemplate(data.templateKey) : null;
  const pub = data.published;
  const waiting = data.domains.filter((d) => d.acquisition === "purchase_requested" || d.acquisition === "purchase_approved");
  const state = websiteState(data);
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader className="flex-col items-stretch gap-0">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <IconTile icon={<Globe />} tone={state.tone} />
              <CardTitle className="min-w-0 break-all">{data.platformHost}</CardTitle>
            </div>
            <StatusPill tone={state.tone}>{state.label}</StatusPill>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <InfoChip>{tpl ? `${tpl.family.name} · ${tpl.variation.name}` : "Style"}</InfoChip>
            {pub && <InfoChip icon={<Clock />}><span suppressHydrationWarning>Version {pub.number} published {relativeTime(pub.publishedAt)}</span></InfoChip>}
          </div>
          {pub?.health !== "healthy" && pub?.healthDetail && <Callout tone={pub.health === "unhealthy" ? "danger" : "warning"} icon={<TriangleAlert />} className="mt-3">{pub.healthDetail}</Callout>}
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 lg:grid-cols-4">
            <StatTile icon={<CalendarDays />} tone="primary" label="Draft edited" value={<span className="text-[15px]">{formatDate(data.draftUpdatedAt, timeZone)}</span>} />
            <StatTile icon={<MessagesSquare />} tone="success" label="Enquiries (30 days)" value={formatNumber(data.enquiries.last30Days)} />
            <StatTile icon={<MessagesSquare />} tone="primary" label="Enquiries (all)" value={formatNumber(data.enquiries.total)} />
            <StatTile icon={<TriangleAlert />} tone={data.enquiries.failed ? "danger" : "neutral"} label="Couldn't reach contacts" value={formatNumber(data.enquiries.failed)} />
          </dl>
        </CardContent>
      </Card>

      {waiting.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex min-w-0 items-start gap-3">
              <IconTile icon={<ShoppingCart />} tone="warning" />
              <div className="min-w-0">
                <CardTitle>Domains waiting on you</CardTitle>
                <CardDescription>Nothing is bought until the client approves a price. Domains are registered in the client&apos;s own name and billed at cost.</CardDescription>
              </div>
            </div>
            <StatusPill tone="warning" className="hidden sm:inline-flex">{waiting.length} to action</StatusPill>
          </CardHeader>
          <CardContent className="pt-0">
            <ul className="divide-y divide-line">
              {waiting.map((d) => (
                <Purchase key={d.id} orgId={orgId} d={d} />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex-col items-stretch gap-0">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <IconTile icon={<Globe />} tone="primary" />
              <CardTitle>Domains</CardTitle>
            </div>
            <InfoChip>{data.domains.length} {data.domains.length === 1 ? "domain" : "domains"}</InfoChip>
          </div>
        </CardHeader>
        <CardContent>
          {data.domains.length === 0 && <EmptyState compact icon={<Globe className="size-5" />} title="No domains yet" description="The platform address and any custom domains appear here once they exist." />}
          <ul className="divide-y divide-line">
            {data.domains.map((d) => (
              <li key={d.id} className="management-row -mx-2 flex flex-wrap items-center justify-between gap-3 rounded-lg px-2 py-3 text-[13.5px]">
                <div className="flex min-w-0 flex-1 basis-56 items-center gap-3">
                  <IconTile icon={<Globe />} tone={domainStatusTone(d)} size="sm" />
                  <div className="min-w-0">
                    <p className="break-all font-semibold text-ink">{d.hostname}</p>
                    {(d.isPrimary || d.registrar) && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        {d.isPrimary && <StatusPill tone="primary" size="sm" dot={false}>Main</StatusPill>}
                        {d.registrar && <InfoChip className="h-5 text-[11px]">{d.registrar}{d.renewsAt ? `, renews ${formatDate(d.renewsAt, timeZone)}` : ""}</InfoChip>}
                      </div>
                    )}
                  </div>
                </div>
                <StatusPill tone={domainStatusTone(d)}>{domainStatusLabel(d)}</StatusPill>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
