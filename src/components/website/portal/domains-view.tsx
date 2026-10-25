"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CalendarClock, CheckCircle2, Circle, Copy, Globe, Landmark, Plus, ShoppingCart, Star, Trash2 } from "lucide-react";
import {
  addDomainAction, approveDomainPurchaseAction, changeSubdomainAction, checkLiveAction, checkSslAction, removeDomainAction, requestDomainPurchaseAction, setPrimaryDomainAction, verifyDomainAction,
} from "@/app/actions/website";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Input } from "@/components/ui/primitives";
import { InfoChip, StatusPill } from "@/components/ui/status";
import { domainStatusLabel, domainStatusTone } from "@/components/website/portal/domain-status";
import { formatCurrency, formatDate, relativeTime } from "@/lib/utils";
import type { DnsInstructions } from "@/server/websites/domains";
import type { DomainView } from "@/server/websites/service";

type Act = () => Promise<{ ok: boolean; error?: string }>;

function CopyValue({ label, value }: { label: string; value: string }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copied.`);
    } catch {
      toast.error("Couldn't copy. Select the text and copy it instead.");
    }
  };
  return (
    <div className="flex items-start gap-2 rounded-xl bg-surface-2/70 p-2.5 ring-1 ring-inset ring-line">
      <div className="min-w-0 flex-1">
        <p className="text-[12px] font-semibold uppercase tracking-[.12em] text-muted">{label}</p>
        <p className="break-all font-mono text-[13px] text-ink">{value}</p>
      </div>
      <button type="button" onClick={() => void copy()} aria-label={`Copy ${label}`} className="grid size-10 shrink-0 place-items-center rounded-lg text-ink-2 ring-1 ring-inset ring-line hover:bg-surface-3 hover:text-ink focus-visible:outline-2 focus-visible:outline-primary sm:size-9">
        <Copy className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}

function Step({ done, title, children }: { done: boolean | null; title: string; children?: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span aria-hidden className={`mt-0.5 grid size-8 shrink-0 place-items-center rounded-full ring-1 ring-inset ${done === true ? "bg-success-soft text-success-ink ring-success/20" : done === false ? "bg-warning-soft text-warning-ink ring-warning/25" : "bg-surface-2 text-faint ring-line"}`}>
        {done === true ? <CheckCircle2 className="size-4" /> : <Circle className="size-4" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-[14px] font-semibold">
          {title}
          {done === true ? <StatusPill tone="success" size="sm">Done</StatusPill> : done === false ? <StatusPill tone="warning" size="sm">To do</StatusPill> : <StatusPill tone="neutral" size="sm">Up next</StatusPill>}
        </p>
        {children && <div className="mt-1.5 space-y-2 text-[14px] leading-relaxed text-muted">{children}</div>}
      </div>
    </li>
  );
}

function DomainCard({ d, dns, canManage, canApprove, hasPublished, run, busy }: {
  d: DomainView; dns: DnsInstructions | null; canManage: boolean; canApprove: boolean; hasPublished: boolean; run: (key: string, fn: Act, ok?: string) => Promise<void>; busy: string | null;
}) {
  const [confirmRemove, setConfirmRemove] = React.useState(false);
  const pre = d.acquisition === "purchase_requested" || d.acquisition === "purchase_approved";
  const verified = d.status === "verified" || d.status === "active";
  const b = (k: string) => busy === `${d.id}:${k}`;
  return (
    <Card>
      <CardHeader className="flex-col items-stretch gap-0">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex min-w-0 items-center gap-3 break-all">
            <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary-ink ring-1 ring-inset ring-line"><Globe className="size-4" /></span> {d.hostname}
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            {d.isPrimary && <StatusPill tone="primary" icon={<Star className="size-3" aria-hidden />}>Main address</StatusPill>}
            <StatusPill tone={domainStatusTone(d)}>{domainStatusLabel(d)}</StatusPill>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {d.acquisition === "purchase_requested" && (
          <div className="space-y-3 rounded-xl bg-surface-2/70 p-4 text-[14px] ring-1 ring-inset ring-line">
            {d.purchaseCostMicros ? (
              <>
                <p className="flex items-center gap-2 font-medium"><span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary-ink"><ShoppingCart className="size-4" /></span> We found it for {formatCurrency(d.purchaseCostMicros / 1_000_000)} for the first year.</p>
                <p className="text-muted">This is the registrar&apos;s price, passed on at cost with no markup, and it renews yearly. It&apos;s registered in your business&apos;s name. Nothing is bought until you approve.</p>
                {canApprove ? (
                  <Button type="button" variant="brand" size="sm" loading={b("approve")} disabled={busy !== null} onClick={() => void run(`${d.id}:approve`, () => approveDomainPurchaseAction(d.id), "Approved. We'll register it and let you know.")}>
                    Approve {formatCurrency(d.purchaseCostMicros / 1_000_000)} for the first year
                  </Button>
                ) : <p className="text-muted">The business owner needs to approve this.</p>}
              </>
            ) : (
              <p className="text-muted">We&apos;re checking whether this name is available and what it costs. We&apos;ll send you a price to approve. Nothing is bought until you say yes.</p>
            )}
          </div>
        )}
        {d.acquisition === "purchase_approved" && <p className="rounded-xl bg-surface-2/70 p-4 text-[14px] text-muted ring-1 ring-inset ring-line">Approved. We&apos;re registering it in your business&apos;s name and will tell you as soon as it&apos;s done.</p>}
        {d.acquisition === "purchased" && d.registrar && (
          <div className="flex flex-wrap items-center gap-2">
            <InfoChip icon={<Landmark />}>Registered with {d.registrar}</InfoChip>
            {d.renewsAt && <InfoChip icon={<CalendarClock />}>Renews {formatDate(d.renewsAt)}</InfoChip>}
            {d.purchaseCostMicros ? <InfoChip>{formatCurrency(d.purchaseCostMicros / 1_000_000)} first year, at cost</InfoChip> : null}
          </div>
        )}

        {!pre && dns && (
          <ol className="space-y-4" aria-label={`Steps to connect ${d.hostname}`}>
            <Step done={verified} title="Prove you own it">
              {!verified && (
                <>
                  <p>At your domain provider, add this DNS record. It only proves ownership; it doesn&apos;t change where your domain points.</p>
                  <CopyValue label={`${dns.verifyRecord.type} record name`} value={dns.verifyRecord.name} />
                  <CopyValue label="Value" value={dns.verifyRecord.value} />
                </>
              )}
              {d.dnsDetail && <p>{d.dnsDetail}{d.dnsCheckedAt ? ` Checked ${relativeTime(d.dnsCheckedAt)}.` : ""}</p>}
              {canManage && !verified && <Button type="button" variant="secondary" size="sm" loading={b("verify")} disabled={busy !== null} onClick={() => void run(`${d.id}:verify`, () => verifyDomainAction(d.id))}>Check ownership</Button>}
            </Step>
            <Step done={verified ? d.routingOk === true : null} title="Point it at your website">
              {verified && dns.routing && d.routingOk !== true && (
                <>
                  <p>{dns.routing.note}</p>
                  <CopyValue label={`${dns.routing.type} record name`} value={dns.routing.name} />
                  <CopyValue label="Points to" value={dns.routing.value} />
                </>
              )}
              {verified && !dns.routing && <p>Our connection address isn&apos;t configured yet. Ask us to finish setting this up.</p>}
              {verified && d.routingOk === true && <p>It points to your website.</p>}
              {canManage && verified && d.routingOk !== true && <Button type="button" variant="secondary" size="sm" loading={b("verify")} disabled={busy !== null} onClick={() => void run(`${d.id}:verify`, () => verifyDomainAction(d.id))}>Check again</Button>}
            </Step>
            <Step done={verified ? d.sslStatus === "ready" : null} title="Secure connection (HTTPS)">
              {verified && d.sslDetail && <p>{d.sslDetail}</p>}
              {verified && !d.sslDetail && <p>The certificate is issued automatically once the address points to your site. This can take a few minutes.</p>}
              {canManage && verified && d.sslStatus !== "ready" && <Button type="button" variant="secondary" size="sm" loading={b("ssl")} disabled={busy !== null} onClick={() => void run(`${d.id}:ssl`, () => checkSslAction(d.id))}>Check certificate</Button>}
            </Step>
            <Step done={verified ? d.liveOk === true : null} title="Your site answers on it">
              {verified && !hasPublished && <p>Publish your website first, then check it here.</p>}
              {verified && d.liveOk === true && <p>Confirmed live{d.liveCheckedAt ? ` ${relativeTime(d.liveCheckedAt)}` : ""}.</p>}
              {verified && d.liveOk === false && <p>It didn&apos;t answer with your website. Check the steps above, then try again.</p>}
              {canManage && verified && d.liveOk !== true && <Button type="button" variant="secondary" size="sm" loading={b("live")} disabled={busy !== null || !hasPublished} onClick={() => void run(`${d.id}:live`, () => checkLiveAction(d.id))}>Check my site</Button>}
            </Step>
          </ol>
        )}

        {canManage && (
          <div className="flex flex-wrap gap-2 border-t border-line pt-3">
            {!d.isPrimary && verified && (
              <Button type="button" variant="secondary" size="sm" loading={b("primary")} disabled={busy !== null} onClick={() => void run(`${d.id}:primary`, () => setPrimaryDomainAction(d.id), "This is now your main address.")}>
                <Star className="size-3.5" /> Make main address
              </Button>
            )}
            {d.kind === "custom" && (
              <Button type="button" variant="secondary" size="sm" className="text-danger-ink" disabled={busy !== null} onClick={() => setConfirmRemove(true)}>
                <Trash2 className="size-3.5" /> Remove
              </Button>
            )}
          </div>
        )}
      </CardContent>
      <Dialog
        open={confirmRemove} onOpenChange={setConfirmRemove} title={`Remove ${d.hostname}?`} size="sm"
        description="Visitors will stop reaching your site on this address. Your website itself isn't affected, and you can add the domain again later."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmRemove(false)}>Keep it</Button>
            <Button variant="danger" onClick={() => { setConfirmRemove(false); void run(`${d.id}:remove`, () => removeDomainAction(d.id), "Domain removed."); }}>Remove</Button>
          </>
        }
      />
    </Card>
  );
}

export function DomainsView({
  platformHost, subdomain, domains, instructions, canManage, canApprove, hasPublished, baseDomain,
}: {
  platformHost: string; subdomain: string; domains: DomainView[]; instructions: Record<string, DnsInstructions>; canManage: boolean; canApprove: boolean; hasPublished: boolean; baseDomain: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [hostname, setHostname] = React.useState("");
  const [buyName, setBuyName] = React.useState("");
  const [sub, setSub] = React.useState(subdomain);
  const [subOpen, setSubOpen] = React.useState(false);

  const run = async (key: string, fn: Act, ok?: string) => {
    setBusy(key);
    const res = await fn();
    setBusy(null);
    if (!res.ok) return void toast.error(res.error ?? "That didn't work. Try again.");
    if (ok) toast.success(ok);
    router.refresh();
  };

  const custom = domains.filter((d) => d.kind === "custom");
  const platform = domains.find((d) => d.kind === "platform");

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex-col items-stretch gap-0">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle>Your included address</CardTitle>
            {platform && <StatusPill tone={domainStatusTone(platform)}>{domainStatusLabel(platform)}</StatusPill>}
          </div>
          <CardDescription>This works as soon as you publish, with no setup. You can keep it, or connect your own domain below.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2.5">
            <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-2 text-muted ring-1 ring-inset ring-line"><Globe className="size-4" /></span>
            <p className="min-w-0 break-all text-[15px] font-semibold">{platformHost}</p>
            {platform?.isPrimary && <StatusPill tone="primary" icon={<Star className="size-3" aria-hidden />}>Main address</StatusPill>}
          </div>
          {canManage && <Button type="button" variant="secondary" size="sm" onClick={() => { setSub(subdomain); setSubOpen(true); }}>Change address</Button>}
        </CardContent>
      </Card>

      {custom.map((d) => (
        <DomainCard key={d.id} d={d} dns={instructions[d.id] ?? null} canManage={canManage} canApprove={canApprove} hasPublished={hasPublished} run={run} busy={busy} />
      ))}

      {canManage && (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader className="flex-col items-stretch gap-0">
              <CardTitle>Connect a domain you own</CardTitle>
              <CardDescription>For example yourbusiness.com or www.yourbusiness.com. We&apos;ll show you the exact records to add.</CardDescription>
            </CardHeader>
            <CardContent>
              <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); void run("add", () => addDomainAction(hostname), "Domain added. Follow the steps to connect it.").then(() => setHostname("")); }}>
                <label htmlFor="add-domain" className="sr-only">Domain name</label>
                <Input id="add-domain" value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="yourbusiness.com" maxLength={253} autoComplete="off" />
                <Button type="submit" variant="brand" loading={busy === "add"} disabled={!hostname.trim() || busy !== null}><Plus className="size-4" /> Add</Button>
              </form>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex-col items-stretch gap-0">
              <CardTitle>Need a domain?</CardTitle>
              <CardDescription>Tell us the name you&apos;d like. We check it&apos;s free, send you the price, and only register it after you approve. It&apos;s registered in your business&apos;s name.</CardDescription>
            </CardHeader>
            <CardContent>
              <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); void run("buy", () => requestDomainPurchaseAction(buyName), "Request sent. We'll come back with a price.").then(() => setBuyName("")); }}>
                <label htmlFor="buy-domain" className="sr-only">Domain name you&apos;d like</label>
                <Input id="buy-domain" value={buyName} onChange={(e) => setBuyName(e.target.value)} placeholder="yourbusiness.com" maxLength={253} autoComplete="off" />
                <Button type="submit" variant="secondary" loading={busy === "buy"} disabled={!buyName.trim() || busy !== null}>Request</Button>
              </form>
            </CardContent>
          </Card>
        </div>
      )}

      <Dialog
        open={subOpen} onOpenChange={setSubOpen} title="Change your included address" size="sm"
        description="The old address stops working straight away. Only do this if you haven't shared it yet, or you'll update where it's been shared."
        footer={
          <>
            <Button variant="ghost" onClick={() => setSubOpen(false)}>Cancel</Button>
            <Button variant="brand" loading={busy === "sub"} disabled={sub === subdomain || busy !== null} onClick={() => void run("sub", () => changeSubdomainAction(sub), "Address changed.").then(() => setSubOpen(false))}>Change address</Button>
          </>
        }
      >
        <label htmlFor="sub-input" className="mb-1.5 block text-[14px] font-medium text-ink-2">New address</label>
        <div className="flex items-center gap-2">
          <Input id="sub-input" value={sub} onChange={(e) => setSub(e.target.value.toLowerCase())} maxLength={42} autoComplete="off" spellCheck={false} />
          <span className="shrink-0 text-[14px] text-muted">.{baseDomain}</span>
        </div>
      </Dialog>
    </div>
  );
}
