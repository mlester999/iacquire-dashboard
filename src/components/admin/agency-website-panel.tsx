"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Globe, ShoppingCart } from "lucide-react";
import { quoteDomainAction, recordDomainPurchasedAction } from "@/app/(admin)/admin/website-actions";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Input } from "@/components/ui/primitives";
import { domainStatusLabel, domainStatusTone } from "@/components/website/portal/domain-status";
import { formatCurrency, formatDate, relativeTime } from "@/lib/utils";
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
      <p className="flex flex-wrap items-center gap-2 text-[14.5px] font-semibold">
        <ShoppingCart className="size-4 text-muted" aria-hidden /> {d.hostname}
        <Badge tone="primary">{d.acquisition === "purchase_requested" ? (d.purchaseCostMicros ? "Waiting for the client to approve" : "Needs a price") : "Approved, ready to register"}</Badge>
      </p>
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
        <p className="text-[13px] text-muted">Quoted {formatCurrency(d.purchaseCostMicros / 1_000_000)} for the first year. Do not buy it until the client approves.</p>
      ) : null}
      {d.acquisition === "purchase_approved" && (
        <form className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]" onSubmit={(e) => { e.preventDefault(); void act(() => recordDomainPurchasedAction(orgId, d.id, registrar, renews), "Recorded. The client has been told it's registered."); }}>
          <p className="sm:col-span-3 text-[13px] text-muted">
            The client approved {d.purchaseCostMicros ? formatCurrency(d.purchaseCostMicros / 1_000_000) : "the price"} for the first year, billed at cost. Register it in the client&apos;s own name at a registrar, then record it here.
          </p>
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
        <CardContent className="py-8 text-center text-[14px] text-muted">
          <Globe className="mx-auto mb-3 size-6" aria-hidden />
          {data.orgName} hasn&apos;t started a website yet.
        </CardContent>
      </Card>
    );
  }
  const tpl = data.templateKey ? resolveTemplate(data.templateKey) : null;
  const pub = data.published;
  const waiting = data.domains.filter((d) => d.acquisition === "purchase_requested" || d.acquisition === "purchase_approved");
  const state = !pub ? { tone: "neutral" as const, label: "Not published" } : pub.health === "healthy" ? { tone: "success" as const, label: "Live and confirmed" } : pub.health === "unhealthy" ? { tone: "danger" as const, label: "Published, failing its check" } : { tone: "warning" as const, label: "Published, not yet confirmed" };
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader className="flex-col items-stretch gap-0">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle>{data.platformHost}</CardTitle>
            <Badge tone={state.tone}>{state.label}</Badge>
          </div>
          <CardDescription>
            {tpl ? `${tpl.family.name} · ${tpl.variation.name}` : "Style"}
            {pub ? ` · version ${pub.number} published ${relativeTime(pub.publishedAt)}` : ""}
            {pub?.health !== "healthy" && pub?.healthDetail ? ` · ${pub.healthDetail}` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-4 text-[13.5px] sm:grid-cols-4">
            <div><dt className="text-muted">Draft edited</dt><dd className="font-medium">{formatDate(data.draftUpdatedAt, timeZone)}</dd></div>
            <div><dt className="text-muted">Enquiries (30 days)</dt><dd className="font-medium tabular-nums">{data.enquiries.last30Days}</dd></div>
            <div><dt className="text-muted">Enquiries (all)</dt><dd className="font-medium tabular-nums">{data.enquiries.total}</dd></div>
            <div><dt className="text-muted">Couldn&apos;t reach contacts</dt><dd className={data.enquiries.failed ? "font-medium text-danger-ink" : "font-medium tabular-nums"}>{data.enquiries.failed}</dd></div>
          </dl>
        </CardContent>
      </Card>

      {waiting.length > 0 && (
        <Card>
          <CardHeader className="flex-col items-stretch gap-0">
            <CardTitle>Domains waiting on you</CardTitle>
            <CardDescription>Nothing is bought until the client approves a price. Domains are registered in the client&apos;s own name and billed at cost.</CardDescription>
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
          <CardTitle>Domains</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-line">
            {data.domains.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5 text-[13.5px]">
                <span className="min-w-0 break-all font-medium">
                  {d.hostname}
                  {d.isPrimary ? <span className="ml-2 text-[12px] font-normal text-muted">main</span> : null}
                  {d.registrar ? <span className="ml-2 text-[12px] font-normal text-muted">{d.registrar}{d.renewsAt ? `, renews ${formatDate(d.renewsAt, timeZone)}` : ""}</span> : null}
                </span>
                <Badge tone={domainStatusTone(d)}>{domainStatusLabel(d)}</Badge>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
