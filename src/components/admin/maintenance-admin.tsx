"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarClock, Check, ExternalLink, Gauge, Receipt, ShieldCheck,Wrench,Activity,Clock3,ArrowRight,LifeBuoy,Code2,CheckCircle2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, Input, Select } from "@/components/ui/primitives";
import { Button,ButtonLink } from "@/components/ui/button";
import { PageHero,MetricCard,SectionLabel } from "@/components/ui/workspace";
import { AvatarTile, InfoChip, RelativeTime, statusLabel, StatusPill } from "@/components/ui/status";
import { cn } from "@/lib/utils";
import { useRunner } from "@/components/projects/common";
import { activateMaintenanceAction, resolveMaintenanceAction, updateMaintenanceRequestAction } from "@/app/(admin)/admin/maintenance/actions";
import { MAINTENANCE_STATUS_LABEL, formatMoney } from "@/lib/projects";
import type { listAgencyMaintenance } from "@/server/maintenance/service";
import { formatDate } from "@/lib/utils";
import { PlanLifecycle } from "@/components/admin/plan-lifecycle";

type AgencyData = Awaited<ReturnType<typeof listAgencyMaintenance>>;
/** The plan's money side is optional here so sample data without it still draws; the real listing always has it. */
type Data = Omit<AgencyData, "subscriptions"> & { subscriptions: Array<Omit<AgencyData["subscriptions"][number], "lifecycle" | "blockedBy"> & { lifecycle?: AgencyData["subscriptions"][number]["lifecycle"]; blockedBy?: AgencyData["subscriptions"][number]["blockedBy"] }> };

export function MaintenanceAdmin({ subscriptions, requests }: Data) {
  const [planFilter,setPlanFilter]=React.useState("all");const [requestFilter,setRequestFilter]=React.useState("all");
  const active=subscriptions.filter(s=>["active","past_due","cancel_requested"].includes(s.status));const pending=subscriptions.filter(s=>s.status==="requested");const defects=requests.filter(r=>r.kind==="core_defect");
  const plans=subscriptions.filter(s=>planFilter==="all"||planFilter==="active"&&active.includes(s)||planFilter==="requested"&&s.status==="requested"||planFilter==="cancel_requested"&&s.status==="cancel_requested"||planFilter==="past_due"&&s.status==="past_due"||planFilter==="expired"&&s.status==="expired");
  const shownRequests=requests.filter(r=>requestFilter==="all"||r.kind===requestFilter);
  return (
    <div className="space-y-6">
      <PageHero tone="dark" eyebrow="Client care / Managed maintenance" title={active.length?"Keep every client system in good shape.":"Built to last. Supported with care."} icon={<ShieldCheck className="size-5"/>} description={active.length?`${active.length} active plan${active.length===1?"":"s"}, ${pending.length} enrollment request${pending.length===1?"":"s"} and ${requests.length} open maintenance item${requests.length===1?"":"s"}.`:"No plans are currently active. Optional managed maintenance keeps existing integrations and AI systems cared for after delivery."} aside={<div className="rounded-2xl border border-white/15 bg-white/5 p-5"><p className="text-[10px] font-semibold uppercase tracking-[.14em] text-blue-200">Optional managed plan</p><p className="mt-2 text-[35px] font-semibold tracking-tight">$299<span className="text-sm font-normal text-slate-300">/month</span></p><p className="mt-2 text-xs leading-relaxed text-slate-300">Monitoring, troubleshooting, reasonable adjustments and AI optimization.</p><p className="mt-3 border-t border-white/10 pt-3 text-[10px] text-slate-400">Enrollment and activation are explicit. Payment collection is not inferred.</p></div>} action={<ButtonLink href="/admin/clients" variant="secondary">View client accounts <ArrowRight className="size-4"/></ButtonLink>}/>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4"><MetricCard className="!p-4 [&>p]:!mt-2 [&_.metric-value]:!text-[26px]" label="Active plans" value={active.length} detail="Recorded maintenance agreements" tone="green" icon={<Activity className="size-4"/>}/><MetricCard className="!p-4 [&>p]:!mt-2 [&_.metric-value]:!text-[26px]" label="Pending enrollment" value={pending.length} detail="Awaiting agency activation" tone="amber" icon={<Clock3 className="size-4"/>}/><MetricCard className="!p-4 [&>p]:!mt-2 [&_.metric-value]:!text-[26px]" label="Open maintenance items" value={requests.length} detail="Focused changes and corrections" tone="blue" icon={<Wrench className="size-4"/>}/><MetricCard className="!p-4 [&>p]:!mt-2 [&_.metric-value]:!text-[26px]" label="Core defect reports" value={defects.length} detail="No charge · outside allowance" tone="neutral" icon={<ShieldCheck className="size-4"/>}/></div>
      <section aria-label="Client maintenance plans">
        <SectionLabel title="Client maintenance plans" count={subscriptions.length} description="Activation, agreements and renewals in one place." action={<div className="flex flex-wrap gap-1 rounded-xl bg-surface-2 p-1">{[{id:"all",label:"All plans"},{id:"active",label:"Active"},{id:"requested",label:"Pending"},{id:"cancel_requested",label:"Cancellation"},{id:"past_due",label:"Past due"},{id:"expired",label:"Expired"}].map(f=><button key={f.id} onClick={()=>setPlanFilter(f.id)} aria-pressed={planFilter===f.id} className={cn("min-h-8 rounded-lg px-2.5 text-xs font-medium",planFilter===f.id?"bg-surface text-ink shadow-soft":"text-muted")}>{f.label}</button>)}</div>}/>
        {subscriptions.length === 0 ? (
          <div className="flex flex-col gap-4 rounded-2xl border border-dashed border-line-strong bg-surface p-5 sm:flex-row sm:items-center"><span className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-primary-soft"><Wrench className="size-6 text-primary"/></span><div className="flex-1"><h3 className="text-base font-semibold">Ready for your first maintenance client</h3><p className="mt-1 text-xs leading-relaxed text-muted">An enrollment request appears here when an eligible client chooses the plan. Their core defect support remains separate and free under the service agreement.</p></div><ButtonLink variant="outline" size="sm" href="/admin/clients">View eligible clients <ArrowRight className="size-3.5"/></ButtonLink></div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
            {plans.map((s) => (
              <PlanCard key={s.id} s={s} />
            ))}
          </div>
        )}
        {subscriptions.length>0&&!plans.length&&<p className="rounded-xl border border-dashed border-line-strong p-4 text-xs text-muted">No plans in this state. Choose another status to see your maintenance agreements.</p>}
      </section>

      <section aria-label="Maintenance desk">
        <SectionLabel title="Maintenance desk" count={requests.length} description="Keep defects and managed changes clearly separated." action={<div className="flex gap-1 rounded-xl bg-surface-2 p-1">{[{id:"all",label:"All requests"},{id:"core_defect",label:"Defects"},{id:"managed_change",label:"Managed changes"}].map(f=><button key={f.id} onClick={()=>setRequestFilter(f.id)} aria-pressed={requestFilter===f.id} className={cn("min-h-8 rounded-lg px-2.5 text-xs font-medium",requestFilter===f.id?"bg-surface text-ink shadow-soft":"text-muted")}>{f.label}</button>)}</div>}/>
        {requests.length === 0 ? (
          <div className="flex items-center gap-4 rounded-2xl border border-line bg-surface px-5 py-4"><span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-success-soft"><CheckCircle2 className="size-5 text-success"/></span><div><h3 className="text-sm font-semibold">A clear maintenance queue</h3><p className="mt-1 text-xs text-muted">No requests are open. Client reports will appear here with their own conversation and status.</p></div></div>
        ) : (
          <Card className="overflow-hidden">
            <ul className="divide-y divide-line">
              {shownRequests.map((r) => (
                <RequestRow key={r.id} r={r} />
              ))}
            </ul>
          </Card>
        )}
        {requests.length>0&&!shownRequests.length&&<p className="rounded-xl border border-dashed border-line-strong p-4 text-xs text-muted">No open requests in this category. Your other maintenance items remain in All requests.</p>}
      </section>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[{Icon:ShieldCheck,title:"Defect correction",body:"Original setup defects. No charge and no allowance used."},{Icon:LifeBuoy,title:"Basic support",body:"Questions and guidance through the existing support inbox."},{Icon:Wrench,title:"Managed maintenance",body:"Focused upkeep within an active plan and its allowance."},{Icon:Code2,title:"Custom project work",body:"New systems and larger features are scoped and quoted separately."}].map(l=><div key={l.title} className="rounded-xl border border-line bg-surface-2/50 p-4"><l.Icon className="size-4 text-primary"/><p className="mt-2 text-xs font-semibold">{l.title}</p><p className="mt-1 text-[11px] leading-relaxed text-muted">{l.body}</p></div>)}</div>
      <p className="text-[11px] text-muted">Payment collection and verified maintenance revenue are not available in these records. PayMongo is not presented as connected.</p>
    </div>
  );
}

function PlanCard({ s }: { s: Data["subscriptions"][number] }) {
  const router = useRouter();
  const { run, isPending } = useRunner();
  const [start, setStart] = React.useState(new Date().toISOString().slice(0, 10));
  // A plan starts only once a person has checked the payment in their own billing records and says what period it pays for (a month by default).
  const [through, setThrough] = React.useState(() => { const d = new Date(); d.setUTCDate(d.getUTCDate() + 31); return d.toISOString().slice(0, 10); });
  const [paymentConfirmed, setPaymentConfirmed] = React.useState(false);
  const done = async (key: string, fn: () => Promise<{ ok: boolean; error?: string }>, msg: string) => {
    const ok = await run(key, fn as never, msg);
    if (ok !== null) router.refresh();
  };
  return (
    <Card className="min-w-0">
      <CardHeader className="flex-wrap gap-y-2">
        <div className="flex min-w-0 items-center gap-3">
          <AvatarTile name={s.orgName} />
          <div className="min-w-0">
            <CardTitle className="truncate" title={s.orgName}>{s.orgName}</CardTitle>
            <p className="mt-0.5 text-[12px] text-muted">Accepted {formatDate(s.acceptedAt, "UTC")} · terms {s.termsVersion}</p>
          </div>
        </div>
        <StatusPill tone={s.status === "active" ? "success" : s.status === "cancel_requested" || s.status === "past_due" || s.status === "expired" ? "danger" : "warning"}>{MAINTENANCE_STATUS_LABEL[s.status]}</StatusPill>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          <InfoChip icon={<Receipt />} className="tabular-nums">{formatMoney(s.monthlyPriceCents, s.currency)}/month</InfoChip>
          <InfoChip icon={<Gauge />} className="tabular-nums">{s.monthlyRequestAllowance} requests/month</InfoChip>
        </div>
        {s.requestNote && <p className="rounded-xl bg-surface-2 p-3 text-[13px] text-ink-2">“{s.requestNote}”</p>}
        {s.status === "active" || s.status === "past_due" || s.status === "cancel_requested" ? (
          <div className="grid grid-cols-1 gap-2 min-[460px]:grid-cols-3">
            {[
              { label: "Billing started", value: s.billingStartOn ? formatDate(s.billingStartOn, "UTC") : "—" },
              { label: "Next renewal", value: s.renewalOn ? formatDate(s.renewalOn, "UTC") : "—" },
              { label: "Used this month", value: `${s.used} of ${s.monthlyRequestAllowance}` },
            ].map((f) => (
              <div key={f.label} className="min-w-0 rounded-xl bg-surface-2/70 px-3 py-2 ring-1 ring-inset ring-line">
                <p className="text-[10px] font-semibold uppercase tracking-[.08em] text-muted">{f.label}</p>
                <p className="mt-0.5 truncate text-[12.5px] font-medium tabular-nums text-ink">{f.value}</p>
              </div>
            ))}
          </div>
        ) : null}
        {s.cancelNote && <p className="rounded-xl bg-warning-soft/60 p-3 text-[13px] text-warning-ink">Cancellation note: “{s.cancelNote}”</p>}
        {s.lifecycle && ["active", "past_due", "cancel_requested", "expired"].includes(s.status) && <PlanLifecycle subscriptionId={s.id} status={s.status} info={s.lifecycle} />}
        {!s.eligible && s.status === "requested" && (
          <p className="flex items-center gap-2 rounded-xl bg-warning-soft px-3 py-2 text-[12.5px] text-warning-ink ring-1 ring-inset ring-warning/25">
            <CalendarClock className="size-4 shrink-0" />
            {s.blockedBy === "setup_payment"
              ? <span>The client&apos;s setup payment isn&apos;t confirmed yet, so this can&apos;t start. <Link href={`/admin/clients/${s.orgId}?tab=billing`} className="font-medium underline underline-offset-2">Open the client&apos;s billing</Link></span>
              : "The core system isn't activated yet, so this can't start."}
          </p>
        )}
        <div className="flex flex-wrap items-end gap-2 border-t border-line pt-3">
          {s.status === "requested" && (
            <>
              <label className="text-[12px] text-muted">
                Billing starts
                <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="mt-1 h-9 w-44" />
              </label>
              <label className="text-[12px] text-muted">
                Payment covers through
                <Input type="date" value={through} onChange={(e) => setThrough(e.target.value)} className="mt-1 h-9 w-44" />
              </label>
              <label className="flex basis-full items-start gap-2 text-[12.5px] text-ink-2">
                <input type="checkbox" className="mt-0.5 size-4 rounded border-line-strong" checked={paymentConfirmed} onChange={(e) => setPaymentConfirmed(e.target.checked)} />
                <span>I confirmed this client&apos;s payment in our billing records. iAcquire doesn&apos;t detect payments, so the plan starts only on this confirmation.</span>
              </label>
              <Button size="sm" variant="brand" disabled={!s.eligible || !paymentConfirmed || !through} loading={isPending(`a-${s.id}`)} onClick={() => void done(`a-${s.id}`, () => activateMaintenanceAction(s.id, start, through, paymentConfirmed), "Plan activated")}>
                <Check className="size-3.5" /> Activate plan
              </Button>
              <Button size="sm" variant="outline" loading={isPending(`d-${s.id}`)} onClick={() => void done(`d-${s.id}`, () => resolveMaintenanceAction(s.id, "decline"), "Request declined")}>
                Decline
              </Button>
            </>
          )}
          {s.status === "cancel_requested" && (
            <Button size="sm" variant="secondary" loading={isPending(`c-${s.id}`)} onClick={() => void done(`c-${s.id}`, () => resolveMaintenanceAction(s.id, "confirm_cancellation"), "Cancellation confirmed")}>
              Confirm cancellation
            </Button>
          )}
          <Link href={`/admin/clients/${s.orgId}`} className="ml-auto inline-flex h-9 items-center gap-1 rounded-xl px-3 text-[12.5px] font-medium text-primary hover:bg-primary-soft">
            Client <ExternalLink className="size-3" />
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

function RequestRow({ r }: { r: Data["requests"][number] }) {
  const router = useRouter();
  const { run, isPending } = useRunner();
  return (
    <li className="grid gap-3 px-4 py-4 transition hover:bg-surface-2/50 md:px-5 lg:grid-cols-[1fr_190px_150px] lg:items-center">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 text-[14px] font-semibold text-ink">
          <span className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] font-normal text-muted ring-1 ring-inset ring-line">{r.ref}</span>
          {r.title}
          <StatusPill size="sm" tone={r.kind === "core_defect" ? "danger" : "primary"}>{r.kind === "core_defect" ? "Core defect" : "Managed"}</StatusPill>
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <InfoChip>{r.orgName}</InfoChip>
          <InfoChip><RelativeTime value={r.createdAt} /></InfoChip>
          <InfoChip>{r.kind === "core_defect" ? "No charge, not counted" : r.countsAgainstAllowance ? "Uses monthly allowance" : "Allowance waived"}</InfoChip>
        </div>
        <p className="mt-2 line-clamp-2 text-[12.5px] text-ink-2" title={r.description}>{r.description}</p>
      </div>
      <Select
        aria-label={`Status of ${r.ref}`}
        value={r.status}
        disabled={isPending(r.id)}
        onChange={async (e) => {
          const ok = await run(r.id, () => updateMaintenanceRequestAction(r.id, { status: e.target.value as never }), "Updated");
          if (ok !== null) router.refresh();
        }}
      >
        {["open", "in_progress", "waiting_for_client", "completed", "declined"].map((s) => (
          <option key={s} value={s}>
            {statusLabel(s)}
          </option>
        ))}
      </Select>
      <div className="flex flex-wrap gap-1.5 lg:justify-end">
        {r.kind === "managed_change" && r.countsAgainstAllowance && (
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              const ok = await run(`w-${r.id}`, () => updateMaintenanceRequestAction(r.id, { waiveAllowance: true }), "Allowance waived for this request");
              if (ok !== null) router.refresh();
            }}
          >
            Waive allowance
          </Button>
        )}
        {r.ticketId && (
          <Link href={`/admin/support/${r.ticketId}`} className="inline-flex h-9 items-center gap-1 rounded-xl px-3 text-[13px] font-medium text-primary hover:bg-primary-soft">
            Open thread
          </Link>
        )}
      </div>
    </li>
  );
}


