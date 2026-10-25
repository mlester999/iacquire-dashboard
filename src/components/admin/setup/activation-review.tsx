"use client";
import * as React from "react";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight, CheckCircle2, CircleDashed, ClipboardCheck, Clock3, LockKeyhole, MessageSquareQuote, ShieldCheck, TriangleAlert, UserCheck } from "lucide-react";
import { Card, EmptyState } from "@/components/ui/primitives";
import { MetricCard, PageHero, SectionLabel } from "@/components/ui/workspace";
import { ButtonLink } from "@/components/ui/button";
import { AvatarTile, InfoChip, StatusPill, statusTone, type StatusTone } from "@/components/ui/status";
import { Callout, IconTile } from "@/components/admin/setup/ui";
import type { AgencySetupSnapshot } from "@/lib/setup";
import { cn, formatDateTime, sentenceCase } from "@/lib/utils";

export interface ActivationReviewHistory {id:string;decision:string;note:string|null;createdAt:string;name:string}

/** How a saved agency decision reads. Unknown decisions fall back to the shared status vocabulary. */
function decisionTone(decision: string): StatusTone {
  const d = decision.toLowerCase();
  if (d === "sent_back" || d === "returned" || d === "changes_requested") return "warning";
  return statusTone(d);
}

export function ActivationReview({snapshot,reviews,timeZone}:{snapshot:AgencySetupSnapshot;reviews:ActivationReviewHistory[];timeZone:string}) {
  const [expanded,setExpanded]=React.useState(false);
  const required=snapshot.tasks.filter(t=>t.required&&!t.hidden&&!t.serviceExcluded&&t.requiresClientResponse);
  const approvals=required.filter(t=>!t.clientRespondedAt).length;
  const checkKeys=new Set(snapshot.tasks.filter(t=>t.required&&!t.hidden&&!t.serviceExcluded&&t.completionMode==="verified").map(t=>t.checkKey));
  const requiredChecks=snapshot.checks.filter(c=>checkKeys.has(c.key));
  const verified=requiredChecks.filter(c=>c.status==="verified").length;
  const blockers=snapshot.readiness.blockers.filter(b=>snapshot.state!=="activated"||b.code!=="not_in_review");
  const jobsBlocked=blockers.some(b=>b.code==="job_needs_attention");
  const groups=[
    {label:"Task progress",icon:ClipboardCheck,ready:snapshot.readiness.tasksComplete,description:`${snapshot.progress.completed}/${snapshot.progress.total} required preparation steps finished`},
    {label:"Technical verification",icon:ShieldCheck,ready:verified===requiredChecks.length,description:`${verified}/${requiredChecks.length} required checks verified`},
    {label:"Client decisions",icon:UserCheck,ready:approvals===0,description:approvals?`${approvals} required client responses outstanding`:"No required client responses outstanding"},
    {label:"Preparation jobs",icon:Clock3,ready:!jobsBlocked,description:jobsBlocked?"Review failed or running jobs":"No failed or running jobs recorded"},
    {label:"Agency review",icon:LockKeyhole,ready:snapshot.state==="activated",waiting:snapshot.state!=="activated",description:snapshot.state==="activated"?"Agency approval recorded":snapshot.state==="ready_for_review"?"Awaiting authorized approval":"Preparation must pass first"},
  ];
  const decisionReady=snapshot.state==="activated"||snapshot.readiness.canActivate;
  return <div className="module-stack"><Link href={`/admin/clients/${snapshot.org.id}/setup`} className="inline-flex min-h-10 w-fit items-center gap-1.5 text-[13px] font-medium text-muted transition-colors hover:text-ink"><ArrowLeft className="size-3.5"/>Client setup</Link><PageHero tone="dark" eyebrow="Activation readiness" icon={<ShieldCheck className="size-5"/>} title={`${snapshot.org.name}, ready when every gate is clear.`} description="Preparation, provider verification and agency approval are separate milestones. Review the evidence together before deciding whether this client is ready." aside={<div className="rounded-2xl border border-white/15 bg-white/5 px-5 py-4"><p className="text-[12px] uppercase tracking-wider text-white/65">Current decision</p><p className="mt-2 flex items-center gap-2 text-lg font-semibold text-white">{decisionReady?<CheckCircle2 className="size-5 text-success"/>:<LockKeyhole className="size-5 text-warning"/>}{snapshot.state==="activated"?"Agency approved":snapshot.readiness.canActivate?"Ready for review":"Readiness blocked"}</p><p className="mt-2 text-xs text-white/65">{blockers.length} blocking {blockers.length===1?"condition":"conditions"}</p></div>} action={<ButtonLink href={`/admin/clients/${snapshot.org.id}/setup`} variant="brand" size="sm">Open agency review <ArrowUpRight className="size-4"/></ButtonLink>}/>
    <div className="grid gap-3 sm:grid-cols-3"><MetricCard label="Required steps complete" value={`${snapshot.progress.completed}/${snapshot.progress.total}`} icon={<ClipboardCheck className="size-4"/>} detail="Manual work and verified technical steps"/><MetricCard label="Required checks verified" value={`${verified}/${requiredChecks.length}`} icon={<ShieldCheck className="size-4"/>} detail="Agency evidence is shown separately" tone="green"/><MetricCard label="Client responses outstanding" value={approvals} icon={<UserCheck className="size-4"/>} detail="Required approvals and information" tone="amber"/></div>
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-5">
        <Card className="overflow-hidden">
          <div className="border-b border-line px-5 py-4"><SectionLabel title="The readiness gates" description="Review every gate before recording agency approval." action={<StatusPill tone={groups.filter(g=>g.ready).length===groups.length?"success":"primary"}>{groups.filter(g=>g.ready).length} of {groups.length} clear</StatusPill>}/></div>
          <ol className="grid gap-3 p-4 sm:grid-cols-2">{groups.map((g,index)=><li key={g.label} className={cn("flex gap-3 rounded-xl p-4 ring-1 ring-inset transition-colors sm:[&:last-child:nth-child(odd)]:col-span-2",g.ready?"bg-success-soft/30 ring-success/20":"bg-surface-2/50 ring-line")}><IconTile icon={<g.icon/>} tone={g.ready?"success":"neutral"}/><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1"><p className="text-[12px] font-semibold uppercase tracking-wider text-muted">Gate {index+1}</p>{g.ready?<StatusPill tone="success" size="sm">Clear</StatusPill>:g.waiting?<StatusPill tone="neutral" size="sm">Waiting</StatusPill>:<StatusPill tone="warning" size="sm">Needs work</StatusPill>}</div><h2 className="mt-1 text-sm font-semibold text-ink">{g.label}</h2><p className="mt-1 text-[12px] leading-relaxed text-muted">{g.description}</p></div></li>)}</ol>
        </Card>
        <section><SectionLabel title="Connection evidence" description="Saved technical check results and their actual verification times." count={snapshot.checks.length}/><div className="grid gap-3 sm:grid-cols-2">{snapshot.checks.map(check=>{const good=check.status==="verified";const fail=check.status==="failed";const attested=check.status==="attested";const Icon=good?CheckCircle2:fail?TriangleAlert:CircleDashed;const tone:StatusTone=good?"success":fail?"danger":attested?"violet":"neutral";return <Card key={check.key} className={cn("flex flex-col overflow-hidden p-4",good&&"border-success/20 bg-success-soft/15",fail&&"border-danger/20 bg-danger-soft/15")}><div className="mb-3 flex items-start gap-3"><IconTile icon={<Icon/>} tone={tone} size="sm"/><div className="min-w-0 flex-1"><h3 className="text-[13px] font-semibold leading-snug text-ink">{check.label}</h3><div className="mt-1.5"><StatusPill tone={tone} size="sm">{good?"Check verified":fail?"Failed check":attested?"Agency evidence, unverified":"Not verified"}</StatusPill></div></div></div><p className="break-words text-[12px] leading-relaxed text-muted">{check.detail??"No provider test has been recorded."}</p><div className="mt-auto pt-3"><InfoChip icon={<Clock3/>} className="h-5 text-[12px]">{check.checkedAt?formatDateTime(check.checkedAt,timeZone):"Awaiting a real connection check"}</InfoChip></div></Card>})}</div></section>
      </div>
      <div className="space-y-4">
        <Card className="p-5"><div className="flex items-center justify-between gap-2"><div className="flex items-center gap-2.5"><IconTile icon={<TriangleAlert/>} tone={blockers.length?"warning":"success"} size="sm"/><h2 className="text-sm font-semibold">What needs attention</h2></div>{blockers.length>0&&<StatusPill tone="warning" size="sm" dot={false}>{blockers.length}</StatusPill>}</div>{!blockers.length?<Callout tone="success" icon={<CheckCircle2/>} className="mt-4">The recorded readiness gates are clear.</Callout>:<><p className="mt-3 text-[12.5px] text-muted">Resolve each condition in the Setup Manager.</p><ul className="mt-3 space-y-2">{(expanded?blockers:blockers.slice(0,5)).map((b,index)=><li key={`${b.code}:${index}`} className="flex gap-2.5 rounded-lg bg-warning-soft/40 px-3 py-2.5 text-[12.5px] leading-relaxed text-ink-2 ring-1 ring-inset ring-warning/15"><span className="mt-0.5 font-mono text-[12px] font-semibold tabular-nums text-warning-ink">{String(index+1).padStart(2,"0")}</span><span className="min-w-0">{b.message}</span></li>)}</ul>{blockers.length>5&&<button type="button" onClick={()=>setExpanded(!expanded)} className="mt-3 min-h-10 rounded-lg text-[12.5px] font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-primary">{expanded?"Show fewer conditions":`Show all ${blockers.length} conditions`}</button>}</>}</Card>
        <Callout tone="primary" icon={<LockKeyhole/>} title="A controlled final step" className="p-4">Agency approval records a decision. External workflows, outreach and live automation still require separate authorization.</Callout>
      </div>
    </div>
    <section><SectionLabel title="Agency decisions" description="Persisted review history, with the reviewer and decision time." count={reviews.length}/><Card className="p-5">{!reviews.length?<EmptyState compact icon={<ClipboardCheck className="size-5"/>} title="No agency decision yet." description="The first review appears here after an authorized agency decision."/>:<ol className="space-y-4">{reviews.map(r=><li key={r.id} className="flex gap-3"><AvatarTile name={r.name} size="md"/><div className="min-w-0 flex-1 space-y-2"><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-semibold text-ink">{r.name}</p><StatusPill tone={decisionTone(r.decision)}>{sentenceCase(r.decision)}</StatusPill><InfoChip icon={<Clock3/>}><time dateTime={r.createdAt}>{formatDateTime(r.createdAt,timeZone)}</time></InfoChip></div>{r.note&&<Callout tone="neutral" icon={<MessageSquareQuote/>} className="text-sm">{r.note}</Callout>}</div></li>)}</ol>}</Card></section>
  </div>;
}
