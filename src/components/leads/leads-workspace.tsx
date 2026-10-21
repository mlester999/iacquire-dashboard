"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Clock,
  Download,
  ExternalLink,
  Info,
  Loader2,
  MapPin,
  Radar,
  RefreshCw,
  Search,
  Send,
  ShieldAlert,
  Target,
  X,
} from "lucide-react";
import { AgentAvatar, AgentStatusBadge } from "@/components/brand";
import { Button, ButtonLink } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { AvatarTile, InfoChip, StatusPill, type StatusTone } from "@/components/ui/status";
import { AccentTop, IconTile, Panel } from "@/components/overview/panel";
import { Segmented, Sheet, Switch, Tabs } from "@/components/ui/overlays";
import { PageHero,CoverageBar } from "@/components/ui/workspace";
import { createResearchAction, requestCrmImportAction, retryResearchAction, reviewLeadsAction, saveTargetingAction } from "@/app/actions/leads";
import { AGENT_BY_KEY, type AgentStatus } from "@/lib/agents";
import { WorkJobPanel } from "@/components/work/job-progress";
import { cn, formatDateTime, relativeTime, sentenceCase } from "@/lib/utils";

interface Lead {
  id: string;
  business_name: string;
  website: string | null;
  domain: string | null;
  industry: string | null;
  location: string | null;
  score: number | null;
  score_breakdown: Record<string, number>;
  qualification_summary: string | null;
  buying_signals: string[];
  evidence: Array<{ url: string; observed_at?: string | null; summary?: string | null }>;
  duplicate_status: string;
  duplicate_matches?: Array<{ kind: "lead" | "crm_company"; id: string; label: string; domain: string | null }>;
  public_contact?: { name?: string | null; role?: string | null; email?: string | null; phone?: string | null; source_url?: string | null };
  review_status: "pending" | "approved" | "rejected";
  crm_sync_status: string;
  created_at: string;
}

interface ResearchRequest {
  id: string;
  prompt: string;
  campaign_type: string;
  status: string;
  result_count: number;
  failure_reason: string | null;
  created_at: string;
  completed_at: string | null;
  requested_by_name: string | null;
  work_job_id: string | null;
  job_status: string | null;
  job_stage: string | null;
  job_stage_label: string | null;
  job_progress: Record<string, unknown> | null;
}

interface Targeting {
  industries: string[];
  countries: string[];
  regions: string[];
  businessSize: string;
  servicesNeeded: string[];
  keywords: string[];
  customerType: string;
  buyingSignals: string[];
  excluded: string[];
  minimumCriteria: string;
  influencer: { enabled: boolean; platform: string; niche: string; region: string; minFollowers: number; engagementCriteria: string; objective: string };
}

const SCORE_LABELS: Record<string, [string, number]> = {
  service_fit: ["Service fit", 30],
  problem_evidence: ["Problem evidence", 25],
  buying_intent: ["Buying signal", 20],
  market_fit: ["Market fit", 15],
  source_quality: ["Source quality", 10],
};

function ScorePill({ score }: { score: number | null }) {
  if (score === null) return <StatusPill tone="neutral" size="sm" dot={false}>No score</StatusPill>;
  const tone: StatusTone = score >= 75 ? "success" : score >= 50 ? "primary" : "neutral";
  return (
    <span title={`Fit score ${score} of 100`} className="inline-flex items-center gap-2">
      <StatusPill tone={tone} dot={false} className="min-w-10 justify-center tabular-nums">{score}</StatusPill>
      <span aria-hidden className="hidden h-1.5 w-12 overflow-hidden rounded-full bg-surface-3 lg:block"><span className={cn("block h-full rounded-full", tone === "success" ? "bg-success" : tone === "primary" ? "bg-primary" : "bg-faint")} style={{ width: `${Math.max(4, Math.min(100, score))}%` }} /></span>
    </span>
  );
}

const SYNC_TONE: Record<string, StatusTone> = { not_synced: "neutral", awaiting_approval: "warning", blocked: "warning", synced: "success", failed: "danger" };
const REVIEW_TONE: Record<Lead["review_status"], StatusTone> = { pending: "warning", approved: "success", rejected: "danger" };

function DuplicateChip({ status }: { status: string }) {
  return status === "no_match" ? <InfoChip icon={<CheckCircle2 />}>No duplicates</InfoChip> : <StatusPill tone="warning" size="sm">{sentenceCase(status)}</StatusPill>;
}

const SYNC_LABEL: Record<string, string> = {
  not_synced: "Not in CRM",
  awaiting_approval: "Import awaiting approval",
  blocked: "CRM import on hold",
  synced: "In CRM",
  failed: "CRM import failed",
};

export function LeadsWorkspace(props: {
  leads: Lead[];
  requests: ResearchRequest[];
  targeting: Targeting;
  hunterReady: boolean;
  hunterStatus: AgentStatus;
  canResearch: boolean;
  canReview: boolean;
  canExport: boolean;
  initialTab: string;
  timeZone: string;
}) {
  const [tab, setTab] = React.useState(props.initialTab);
  const pending = props.leads.filter((l) => l.review_status === "pending");
  return (
    <div className="space-y-6">
      <PageHero eyebrow="Lead intelligence" title="Find the right fit. Build a stronger pipeline." description="Research businesses that match your ideal customer. Review the evidence, keep the right ones and approve what happens next. Nobody is contacted automatically." icon={<Radar className="size-4"/>} action={props.canExport && props.leads.length > 0 ? (
          <ButtonLink href="/api/leads/export" variant="secondary" prefetch={false}>
            <Download className="size-4" /> Export CSV
          </ButtonLink>
        ):undefined} aside={<div className="rounded-2xl border border-line bg-surface/80 p-5"><p className="text-[11px] font-medium uppercase tracking-wider text-muted">Your research pipeline</p><div className="mt-3 flex items-baseline gap-2"><strong className="text-[32px] font-semibold tracking-tight">{props.leads.length}</strong><span className="text-[13px] text-muted">researched leads</span></div><div className="mt-4"><CoverageBar label="Lead review status" parts={[{label:"Review",count:pending.length,color:"var(--warning)"},{label:"Approved",count:props.leads.filter(lead=>lead.review_status==="approved").length,color:"var(--success)"},{label:"Other",count:props.leads.length-pending.length-props.leads.filter(lead=>lead.review_status==="approved").length,color:"var(--muted)"}]}/></div></div>}/>
      <HunterBanner ready={props.hunterReady} status={props.hunterStatus} />
      <div data-aqi-target="leads.tabs">
      <Tabs
        id="leads-tabs"
        value={tab}
        onValueChange={setTab}
        items={[
          { value: "review", label: "Review queue", count: pending.length },
          { value: "all", label: "All leads", count: props.leads.length },
          { value: "research", label: "Research" },
          { value: "targeting", label: "Targeting rules" },
        ]}
      >
      {tab === "review" && <LeadTable leads={pending} canReview={props.canReview} timeZone={props.timeZone} emptyTitle="No leads waiting for review" emptyBody="New research results appear here for you to approve or reject." mode="review" />}
      {tab === "all" && <LeadTable leads={props.leads} canReview={props.canReview} timeZone={props.timeZone} emptyTitle="No leads yet" emptyBody="Run a research request to start building your pipeline." mode="all" />}
      {tab === "research" && <ResearchPanel {...props} />}
      {tab === "targeting" && <TargetingForm targeting={props.targeting} canEdit={props.canResearch} />}
      </Tabs>
      </div>
    </div>
  );
}

function HunterBanner({ ready, status }: { ready: boolean; status: AgentStatus }) {
  const meta = AGENT_BY_KEY.lead_hunter;
  return (
    <div className="card-surface relative flex flex-col gap-3 overflow-hidden rounded-2xl p-4 sm:flex-row sm:items-center">
      <AccentTop tone={ready ? "success" : "warning"} />
      <AgentAvatar role={meta} size="md" className="relative" />
      <div className="relative min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-[14px] font-semibold">
          Lead Hunter <AgentStatusBadge status={status} />
        </p>
        <p className="mt-0.5 text-[13px] text-muted">{ready ? "Ready to research from approved public sources." : "Research can be saved now, but nothing runs until the Lead Hunter is connected and online."}</p>
      </div>
    </div>
  );
}

function LeadTable({ leads, canReview, timeZone, emptyTitle, emptyBody, mode }: { leads: Lead[]; canReview: boolean; timeZone: string; emptyTitle: string; emptyBody: string; mode: "review" | "all" }) {
  const router = useRouter();
  const [selected, setSelected] = React.useState<string[]>([]);
  const [open, setOpen] = React.useState<Lead | null>(null);
  const [query, setQuery] = React.useState("");
  const [status, setStatus] = React.useState("all");
  const [sort, setSort] = React.useState("newest");
  const [busy, setBusy] = React.useState(false);
  const filtered = leads.filter(
    (l) => (status === "all" || l.review_status === status) && (!query || `${l.business_name} ${l.industry ?? ""} ${l.location ?? ""}`.toLowerCase().includes(query.toLowerCase())),
  ).sort((a, b) => sort === "score" ? (b.score ?? -1) - (a.score ?? -1) : sort === "name" ? a.business_name.localeCompare(b.business_name) : new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const review = async (ids: string[], decision: "approve" | "reject") => {
    setBusy(true);
    try {
      const res = await reviewLeadsAction(ids, decision);
      if (!res.ok) return toast.error(res.error);
      toast.success(`${res.data.updated} lead${res.data.updated === 1 ? "" : "s"} ${decision === "approve" ? "approved" : "rejected"}`);
      setSelected([]);
      setOpen(null);
      router.refresh();
    } catch {
      toast.error("We couldn't confirm the review. Refresh to check its status before trying again.");
    } finally {
      setBusy(false);
    }
  };
  const importToCrm = async (ids: string[]) => {
    setBusy(true);
    try {
      const res = await requestCrmImportAction(ids);
      if (!res.ok) return toast.error(res.error);
      toast.success("Import request sent to the Approval Center", { action: { label: "Open", onClick: () => router.push("/approvals") } });
      setSelected([]);
      router.refresh();
    } catch {
      toast.error("We couldn't confirm the import request. Check the Approval Center before trying again.");
    } finally {
      setBusy(false);
    }
  };

  if (!leads.length) {
    return (
      <Card>
        <EmptyState icon={<Radar className="size-5" />} title={emptyTitle} description={emptyBody} />
      </Card>
    );
  }
  const selectedLeads = leads.filter((l) => selected.includes(l.id));
  return (
    <Card className="overflow-hidden" data-aqi-target="leads.review-table">
      <div className="flex flex-col gap-3 border-b border-line p-4 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
          <label htmlFor={`lead-search-${mode}`} className="sr-only">
            Search leads
          </label>
          <Input id={`lead-search-${mode}`} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name, industry or location" className="pl-9" />
        </div>
        <Select value={sort} onChange={(event) => setSort(event.target.value)} aria-label="Sort leads" className="sm:max-w-44">
          <option value="newest">Newest research</option><option value="score">Highest fit score</option><option value="name">Business A–Z</option>
        </Select>
        {mode === "all" && (
          <Segmented
            id="lead-status"
            ariaLabel="Filter by review status"
            size="sm"
            value={status}
            onChange={setStatus}
            options={[
              { value: "all", label: "All" },
              { value: "pending", label: "Pending" },
              { value: "approved", label: "Approved" },
              { value: "rejected", label: "Rejected" },
            ]}
          />
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5 text-[12px] text-muted"><span>{filtered.length} of {leads.length} leads</span>{canReview && <label className="flex min-h-11 cursor-pointer items-center gap-2 md:hidden"><input type="checkbox" className="size-4 accent-[var(--primary)]" checked={filtered.length > 0 && filtered.every((lead) => selected.includes(lead.id))} onChange={(event) => setSelected(event.target.checked ? filtered.map((lead) => lead.id) : [])} /> Select visible leads</label>}</div>
      <AnimatePresence>
        {selected.length > 0 && canReview && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden border-b border-line bg-primary-soft/40">
            <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
              <span className="text-[13px] font-medium">{selected.length} selected{selected.some((id) => !filtered.some((lead) => lead.id === id)) ? " · includes leads hidden by these filters" : ""}</span>
              <div className="ml-auto flex flex-wrap gap-2">
                {selectedLeads.some((l) => l.review_status === "pending") && (
                  <>
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => review(selected, "reject")}>
                      <X className="size-3.5" /> Reject
                    </Button>
                    <Button size="sm" disabled={busy} onClick={() => review(selected, "approve")}>
                      <Check className="size-3.5" /> Approve
                    </Button>
                  </>
                )}
                {selectedLeads.some((l) => l.review_status === "approved") && (
                  <Button size="sm" variant="brand" disabled={busy} onClick={() => importToCrm(selected)}>
                    <Send className="size-3.5" /> Send approved to CRM
                  </Button>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="divide-y divide-line md:hidden">
        {filtered.map((lead) => (
          <article key={lead.id} className={cn("px-4 py-4", selected.includes(lead.id) && "bg-primary-soft/30")}>
            <div className="flex items-start gap-3">
              {canReview && (
                <label className="flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-lg hover:bg-surface-2">
                  <input type="checkbox" aria-label={`Select ${lead.business_name}`} className="size-4 accent-[var(--primary)]" checked={selected.includes(lead.id)} onChange={() => toggle(lead.id)} />
                </label>
              )}
              <button type="button" onClick={() => setOpen(lead)} className="flex min-w-0 flex-1 items-start gap-3 rounded-lg text-left focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary">
                <AvatarTile name={lead.business_name} size="md" />
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-[14px] font-semibold text-ink">{lead.business_name}</span>
                  <span className="mt-0.5 block text-[12px] text-muted">{lead.industry ?? "Industry unknown"}</span>
                  <span className="mt-2.5 flex flex-wrap items-center gap-1.5">
                    <ScorePill score={lead.score} />
                    <StatusPill tone={REVIEW_TONE[lead.review_status]}>{sentenceCase(lead.review_status)}</StatusPill>
                    {lead.review_status === "approved" && <StatusPill tone={SYNC_TONE[lead.crm_sync_status] ?? "neutral"} size="sm">{SYNC_LABEL[lead.crm_sync_status] ?? sentenceCase(lead.crm_sync_status)}</StatusPill>}
                  </span>
                  <span className="mt-2 flex flex-wrap items-center gap-1.5">
                    <InfoChip icon={<MapPin />}>{lead.location ?? "Location not recorded"}</InfoChip>
                    <DuplicateChip status={lead.duplicate_status} />
                    <InfoChip icon={<Clock />}><span suppressHydrationWarning>{relativeTime(lead.created_at)}</span></InfoChip>
                  </span>
                </span>
              </button>
            </div>
          </article>
        ))}
      </div>
      <div className="scrollbar-thin hidden overflow-x-auto md:block">
        <table className="workspace-table w-full min-w-[760px] text-left text-[13.5px]">
          <thead className="bg-surface-2/60 text-[12px] text-muted">
            <tr>
              {canReview && (
                <th className="w-10 px-4 py-3">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    className="size-4 accent-[var(--primary)]"
                    checked={filtered.length > 0 && filtered.every((l) => selected.includes(l.id))}
                    onChange={(e) => setSelected(e.target.checked ? filtered.map((l) => l.id) : [])}
                  />
                </th>
              )}
              <th className="px-3 py-3 font-medium">Business</th>
              <th className="px-3 py-3 font-medium">Location</th>
              <th className="px-3 py-3 font-medium">Fit score</th>
              <th className="px-3 py-3 font-medium">Status</th>
              <th className="px-3 py-3 font-medium">Duplicates</th>
              <th className="px-4 py-3 text-right font-medium">Researched</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {filtered.map((l) => (
              <tr key={l.id} className={cn("cursor-pointer transition hover:bg-surface-2/60", selected.includes(l.id) && "bg-primary-soft/30")} onClick={() => setOpen(l)}>
                {canReview && (
                  <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" aria-label={`Select ${l.business_name}`} className="size-4 accent-[var(--primary)]" checked={selected.includes(l.id)} onChange={() => toggle(l.id)} />
                  </td>
                )}
                <td className="px-3 py-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <AvatarTile name={l.business_name} size="md" />
                    <div className="min-w-0">
                      <button type="button" onClick={() => setOpen(l)} title={l.business_name} className="block max-w-[260px] truncate rounded-md text-left font-semibold text-ink hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary">{l.business_name}</button>
                      <p className="mt-0.5 max-w-[260px] truncate text-[12px] text-muted" title={l.industry ?? undefined}>{l.industry ?? "Industry unknown"}</p>
                    </div>
                  </div>
                </td>
                <td className="px-3 py-3">{l.location ? <InfoChip icon={<MapPin />}>{l.location}</InfoChip> : <span className="text-faint">—</span>}</td>
                <td className="px-3 py-3">
                  <ScorePill score={l.score} />
                </td>
                <td className="px-3 py-3">
                  <div className="flex flex-col items-start gap-1">
                    <StatusPill tone={REVIEW_TONE[l.review_status]}>{sentenceCase(l.review_status)}</StatusPill>
                    {l.review_status === "approved" && <StatusPill tone={SYNC_TONE[l.crm_sync_status] ?? "neutral"} size="sm">{SYNC_LABEL[l.crm_sync_status] ?? sentenceCase(l.crm_sync_status)}</StatusPill>}
                  </div>
                </td>
                <td className="px-3 py-3"><DuplicateChip status={l.duplicate_status} /></td>
                <td className="px-4 py-3 text-right text-[12.5px] tabular-nums text-muted" title={formatDateTime(l.created_at, timeZone)}><span suppressHydrationWarning>{relativeTime(l.created_at)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {filtered.length === 0 && <EmptyState compact icon={<Search className="size-5"/>} title="No matching leads" description="Try another search or review status." action={<Button variant="secondary" size="sm" onClick={() => { setQuery(""); setStatus("all"); }}>Clear filters</Button>}/>}
      <LeadSheet lead={open} onClose={() => setOpen(null)} canReview={canReview} timeZone={timeZone} onReview={review} onImport={importToCrm} busy={busy} />
    </Card>
  );
}

function LeadSheet({ lead, onClose, canReview, timeZone, onReview, onImport, busy }: { lead: Lead | null; onClose: () => void; canReview: boolean; timeZone: string; onReview: (ids: string[], d: "approve" | "reject") => void; onImport: (ids: string[]) => void; busy: boolean }) {
  return (
    <Sheet open={Boolean(lead)} onOpenChange={(o) => !o && onClose()} title={lead?.business_name ?? "Lead"} description={lead ? [lead.industry, lead.location].filter(Boolean).join(" · ") : undefined}>
      {lead && (
        <div className="space-y-6 p-5">
          <div className="flex flex-wrap gap-2">
            <StatusPill tone={REVIEW_TONE[lead.review_status]}>{sentenceCase(lead.review_status)}</StatusPill>
            {lead.review_status === "approved" && <StatusPill tone={SYNC_TONE[lead.crm_sync_status] ?? "neutral"}>{SYNC_LABEL[lead.crm_sync_status] ?? sentenceCase(lead.crm_sync_status)}</StatusPill>}
          </div>
          <div className="flex items-center gap-4 rounded-2xl border border-line bg-surface-2/50 p-4">
            <div className="text-center">
              <p className="text-[32px] font-semibold leading-none tracking-tight tabular-nums">{lead.score ?? "—"}</p>
              <p className="mt-1 text-[11.5px] text-muted">of 100</p>
            </div>
            <p className="text-[12.5px] leading-relaxed text-muted">A research-priority score from cited evidence. It is not a measure of interest or consent.</p>
          </div>
          <div className="space-y-2.5">
            {Object.entries(SCORE_LABELS).map(([k, [label, max]]) => {
              const v = lead.score_breakdown?.[k] ?? 0;
              return (
                <div key={k}>
                  <div className="mb-1 flex justify-between text-[12.5px]">
                    <span className="text-ink-2">{label}</span>
                    <span className="tabular-nums text-muted">
                      {v} / {max}
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-surface-2">
                    <div className="h-1.5 rounded-full" style={{ width: `${(v / max) * 100}%`, background: "var(--series-1)" }} />
                  </div>
                </div>
              );
            })}
          </div>
          {lead.qualification_summary && (
            <div>
              <p className="mb-1 text-[12px] font-medium uppercase tracking-wider text-faint">Why it may fit</p>
              <p className="text-[13.5px] leading-relaxed">{lead.qualification_summary}</p>
            </div>
          )}
          {lead.buying_signals.length > 0 && (
            <div>
              <p className="mb-2 text-[12px] font-medium uppercase tracking-wider text-faint">Signals</p>
              <div className="flex flex-wrap gap-1.5">
                {lead.buying_signals.map((s) => (
                  <Badge key={s} tone="violet">
                    {s}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          <div>
            <p className="mb-2 text-[12px] font-medium uppercase tracking-wider text-faint">Source evidence</p>
            {lead.evidence.length === 0 ? (
              <p className="flex items-center gap-2.5 rounded-xl bg-warning-soft p-3 text-[13px] text-warning-ink ring-1 ring-inset ring-warning/25">
                <AlertCircle className="size-4 shrink-0" /> No cited sources — treat with caution.
              </p>
            ) : (
              <ul className="space-y-2">
                {lead.evidence.map((e, i) => (
                  <li key={i} className="rounded-xl border border-line p-3">
                    <a href={e.url} target="_blank" rel="noopener noreferrer nofollow" className="flex items-center gap-1.5 break-all text-[13px] font-medium text-primary hover:underline">
                      {e.url} <ExternalLink className="size-3 shrink-0" />
                    </a>
                    {e.summary && <p className="mt-1 text-[12.5px] text-muted">{e.summary}</p>}
                    {e.observed_at && <p className="mt-0.5 text-[11.5px] text-faint">Observed {formatDateTime(e.observed_at, timeZone)}</p>}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <dl className="grid grid-cols-2 gap-3 text-[12.5px]">
            <div className="rounded-xl bg-surface-2 p-3">
              <dt className="text-muted">Duplicate check</dt>
              <dd className="mt-1.5">
                {lead.duplicate_status === "no_match" ? <StatusPill tone="success" size="sm">No match</StatusPill> : <StatusPill tone="warning" size="sm">{sentenceCase(lead.duplicate_status)}</StatusPill>}
                {Boolean(lead.duplicate_matches?.length) && (
                  <ul className="mt-1.5 space-y-0.5 text-[11.5px] text-warning-ink">
                    {lead.duplicate_matches!.slice(0, 3).map((match) => (
                      <li key={`${match.kind}:${match.id}`}>
                        {match.kind === "crm_company" ? "CRM company" : "Existing lead"}: {match.label}
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
            </div>
            {lead.public_contact && (lead.public_contact.name || lead.public_contact.email || lead.public_contact.phone) && (
              <div className="rounded-xl bg-surface-2 p-3">
                <dt className="text-muted">Public business contact</dt>
                <dd className="mt-1 space-y-0.5 text-[12px] text-ink-2">
                  {lead.public_contact.name && <p>{lead.public_contact.name}{lead.public_contact.role ? ` · ${lead.public_contact.role}` : ""}</p>}
                  {lead.public_contact.email && <p className="break-all">{lead.public_contact.email}</p>}
                  {lead.public_contact.phone && <p>{lead.public_contact.phone}</p>}
                  {lead.public_contact.source_url && <a href={lead.public_contact.source_url} target="_blank" rel="noopener noreferrer nofollow" className="text-primary hover:underline">Source</a>}
                </dd>
              </div>
            )}
            <div className="rounded-xl bg-surface-2 p-3">
              <dt className="text-muted">CRM</dt>
              <dd className="mt-1.5"><StatusPill tone={SYNC_TONE[lead.crm_sync_status] ?? "neutral"} size="sm">{SYNC_LABEL[lead.crm_sync_status] ?? sentenceCase(lead.crm_sync_status)}</StatusPill></dd>
            </div>
          </dl>
          <div className="flex items-start gap-3 rounded-xl bg-surface-2 p-3 text-[12.5px] text-muted">
            <IconTile tone="neutral" size="sm"><ShieldAlert /></IconTile>
            <div className="flex flex-wrap items-center gap-1.5">
              <StatusPill tone="warning" size="sm">Contact consent unknown</StatusPill>
              <StatusPill tone="neutral" size="sm">Outreach blocked until separately approved</StatusPill>
            </div>
          </div>
          {canReview && (
            <div className="flex flex-wrap gap-2 border-t border-line pt-4">
              {lead.review_status === "pending" && (
                <>
                  <Button variant="secondary" disabled={busy} onClick={() => onReview([lead.id], "reject")}>
                    <X className="size-4" /> Reject
                  </Button>
                  <Button disabled={busy} onClick={() => onReview([lead.id], "approve")}>
                    <Check className="size-4" /> Approve lead
                  </Button>
                </>
              )}
              {lead.review_status === "approved" && ["not_synced", "blocked", "failed"].includes(lead.crm_sync_status) && (
                <Button variant="brand" disabled={busy} onClick={() => onImport([lead.id])}>
                  <Send className="size-4" /> Request CRM import
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}

function ResearchPanel({ requests, hunterReady, canResearch, timeZone }: { requests: ResearchRequest[]; hunterReady: boolean; canResearch: boolean; timeZone: string }) {
  const router = useRouter();
  const [prompt, setPrompt] = React.useState("");
  const [campaign, setCampaign] = React.useState<"business" | "influencer">("business");
  const [pending, setPending] = React.useState(false);
  const [activeJobId, setActiveJobId] = React.useState<string | null>(null);
  const running = requests.some((r) => r.status === "queued" || r.status === "running" || r.job_status === "queued" || r.job_status === "running");

  React.useEffect(() => {
    if (!running) return;
    const t = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(t);
  }, [running, router]);

  const submit = async () => {
    setPending(true);
    const res = await createResearchAction(prompt, campaign);
    setPending(false);
    if (!res.ok) return toast.error(res.error);
    toast[res.data.status === "queued" ? "success" : "info"](res.data.status === "queued" ? "Research started" : "Request saved — it will run once your Lead Hunter is online");
    setActiveJobId(res.data.jobId ?? null);
    setPrompt("");
    router.refresh();
  };
  const statusBadge = (s: string) => {
    const map: Record<string, ["success" | "primary" | "warning" | "danger" | "neutral", string]> = {
      waiting_for_agent: ["warning", "Waiting for Lead Hunter"],
      queued: ["primary", "Queued"],
      running: ["primary", "Researching"],
      completed: ["success", "Completed"],
      failed: ["danger", "Failed"],
      cancelled: ["neutral", "Cancelled"],
    };
    const [tone, label] = map[s] ?? ["neutral", sentenceCase(s)];
    return (
      <StatusPill tone={tone} icon={s === "running" ? <Loader2 className="size-3 animate-spin" aria-hidden /> : undefined}>
        {label}
      </StatusPill>
    );
  };
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
      <Panel className="lg:col-span-2" icon={<Radar />} tone="primary" title="New research request" description="Describe who you want to find. Your targeting rules are applied automatically." bodyClassName="space-y-4">
          <Segmented id="campaign" ariaLabel="Campaign type" value={campaign} onChange={setCampaign} options={[{ value: "business", label: "Businesses" }, { value: "influencer", label: "Influencer partners" }]} />
          <Field label="What should the Lead Hunter look for?" htmlFor="research-prompt">
            <Textarea id="research-prompt" data-aqi-target="leads.research" rows={4} maxLength={1000} value={prompt} onChange={(e) => setPrompt(e.target.value)} disabled={!canResearch} placeholder="Find businesses in California that may need appointment automation." />
          </Field>
          {campaign === "influencer" && (
            <p className="flex items-start gap-2 rounded-xl bg-surface-2 p-3 text-[12.5px] text-muted">
              <Info className="mt-0.5 size-3.5 shrink-0" /> Influencer research uses public, permitted sources only. iAcquire never scrapes profiles or sends automated DMs.
            </p>
          )}
          {!hunterReady && (
            <p className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning-soft/50 p-3 text-[12.5px] text-warning-ink">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" /> The Lead Hunter isn&apos;t online yet, so this request will be saved but not run.
            </p>
          )}
          <Button variant="brand" className="w-full" loading={pending} disabled={!canResearch || prompt.trim().length < 3} onClick={submit}>
            <Radar className="size-4" /> {hunterReady ? "Start research" : "Save request"}
          </Button>
          {activeJobId && (
            <WorkJobPanel
              jobId={activeJobId}
              compact
              onDone={() => {
                router.refresh();
              }}
            />
          )}
          {!canResearch && <p className="text-[12.5px] text-muted">Only owners and admins can request research.</p>}
      </Panel>
      <Panel className="lg:col-span-3" icon={<Clock />} tone="neutral" title="Research history" description="Real status of every request.">
          {requests.length === 0 ? (
            <EmptyState compact icon={<Radar className="size-5" />} title="No research requests yet" description="Describe the businesses you want to find and your Lead Hunter will research them from approved public sources." />
          ) : (
            <ul className="divide-y divide-line">
              {requests.map((r) => (
                <li key={r.id} className="py-3.5">
                  <div className="flex flex-wrap items-center gap-2">
                    {statusBadge(r.status)}
                    {r.campaign_type === "influencer" && <StatusPill tone="violet" dot={false}>Influencer</StatusPill>}
                    <span className="ml-auto"><InfoChip icon={<Clock />}>{formatDateTime(r.created_at, timeZone)}</InfoChip></span>
                  </div>
                  <p className="mt-2 text-[13.5px] leading-snug text-ink">{r.prompt}</p>
                  {r.job_stage_label && (r.job_status === "running" || r.job_status === "queued") && (
                    <p className="mt-1.5 flex items-center gap-1.5 text-[12px] text-primary-ink">
                      <Loader2 className="size-3.5 animate-spin" aria-hidden /> {r.job_stage_label}…
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {r.status === "completed" && <InfoChip icon={<CheckCircle2 />}>{r.result_count} result{r.result_count === 1 ? "" : "s"} added to review</InfoChip>}
                    {r.status !== "completed" && r.failure_reason && <span className="text-[12px] text-danger-ink">{r.failure_reason}</span>}
                    {r.requested_by_name && <InfoChip>{r.requested_by_name}</InfoChip>}
                  </div>
                  {(r.status === "waiting_for_agent" || r.status === "failed" || r.status === "cancelled" || r.job_status === "failed") && hunterReady && canResearch && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="-ml-2 mt-1"
                      onClick={async () => {
                        const res = await retryResearchAction(r.id);
                        if (!res.ok) return toast.error(res.error);
                        toast.success("Research started");
                        router.refresh();
                      }}
                    >
                      <RefreshCw className="size-3.5" /> Run now
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
      </Panel>
    </div>
  );
}

function TagInput({ id, label, values, onChange, placeholder, disabled, hint }: { id: string; label: string; values: string[]; onChange: (v: string[]) => void; placeholder: string; disabled?: boolean; hint?: string }) {
  const [draft, setDraft] = React.useState("");
  const add = () => {
    const v = draft.trim().replace(/,$/, "");
    if (v && !values.includes(v) && values.length < 20) onChange([...values, v.slice(0, 120)]);
    setDraft("");
  };
  return (
    <Field label={label} htmlFor={id} optional hint={hint}>
      <div className={cn("flex min-h-11 flex-wrap items-center gap-1.5 rounded-xl border border-line-strong bg-surface px-2 py-1.5 shadow-soft focus-within:border-primary focus-within:ring-4 focus-within:ring-primary/12", disabled && "opacity-60")}>
        {values.map((v) => (
          <span key={v} className="inline-flex items-center gap-1 rounded-lg bg-surface-2 px-2 py-1 text-[12.5px]">
            {v}
            {!disabled && (
              <button type="button" onClick={() => onChange(values.filter((x) => x !== v))} aria-label={`Remove ${v}`} className="text-muted hover:text-ink">
                <X className="size-3" />
              </button>
            )}
          </span>
        ))}
        <input
          id={id}
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            } else if (e.key === "Backspace" && !draft && values.length) onChange(values.slice(0, -1));
          }}
          onBlur={add}
          placeholder={values.length ? "" : placeholder}
          className="h-7 min-w-[120px] flex-1 bg-transparent px-1 text-[14px] outline-none placeholder:text-faint"
        />
      </div>
    </Field>
  );
}

function TargetingForm({ targeting, canEdit }: { targeting: Targeting; canEdit: boolean }) {
  const router = useRouter();
  const [t, setT] = React.useState<Targeting>(targeting);
  const [saving, setSaving] = React.useState(false);
  const set = <K extends keyof Targeting>(k: K, v: Targeting[K]) => setT((p) => ({ ...p, [k]: v }));
  const dirty = JSON.stringify(t) !== JSON.stringify(targeting);
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <Panel className="lg:col-span-2" icon={<Target />} tone="violet" title="Who should we look for?" description="Press Enter after each item. These rules shape every research request." bodyClassName="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <TagInput id="t-ind" label="Industries" values={t.industries} onChange={(v) => set("industries", v)} placeholder="e.g. Dental clinics" disabled={!canEdit} />
            <TagInput id="t-countries" label="Countries" values={t.countries} onChange={(v) => set("countries", v)} placeholder="e.g. United States" disabled={!canEdit} />
            <TagInput id="t-regions" label="Regions or cities" values={t.regions} onChange={(v) => set("regions", v)} placeholder="e.g. California" disabled={!canEdit} />
            <TagInput id="t-services" label="Services they need" values={t.servicesNeeded} onChange={(v) => set("servicesNeeded", v)} placeholder="e.g. Appointment booking" disabled={!canEdit} />
            <TagInput id="t-keywords" label="Keywords" values={t.keywords} onChange={(v) => set("keywords", v)} placeholder="e.g. online booking" disabled={!canEdit} />
            <TagInput id="t-signals" label="Buying signals" values={t.buyingSignals} onChange={(v) => set("buyingSignals", v)} placeholder="e.g. Hiring a receptionist" disabled={!canEdit} />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Business size" htmlFor="t-size">
              <Select id="t-size" value={t.businessSize} disabled={!canEdit} onChange={(e) => set("businessSize", e.target.value)}>
                {[["any", "Any size"], ["solo", "Solo"], ["2-10", "2–10 people"], ["11-50", "11–50 people"], ["51-200", "51–200 people"], ["200+", "200+ people"]].map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Customer type" htmlFor="t-type">
              <Select id="t-type" value={t.customerType} disabled={!canEdit} onChange={(e) => set("customerType", e.target.value)}>
                <option value="b2b">Businesses (B2B)</option>
                <option value="b2c">Consumers (B2C)</option>
                <option value="both">Both</option>
              </Select>
            </Field>
          </div>
          <TagInput id="t-excluded" label="Exclude these businesses or domains" values={t.excluded} onChange={(v) => set("excluded", v)} placeholder="e.g. competitor.com" disabled={!canEdit} />
          <Field label="Minimum qualification criteria" htmlFor="t-min" optional>
            <Textarea id="t-min" rows={2} maxLength={1000} value={t.minimumCriteria} disabled={!canEdit} onChange={(e) => set("minimumCriteria", e.target.value)} placeholder="e.g. Has a website and at least 5 employees" />
          </Field>
      </Panel>
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Influencer partnerships</CardTitle>
              <CardDescription>Optional campaign type.</CardDescription>
            </div>
            <Switch checked={t.influencer.enabled} disabled={!canEdit} onCheckedChange={(v) => set("influencer", { ...t.influencer, enabled: v })} aria-label="Enable influencer partnerships" />
          </CardHeader>
          {t.influencer.enabled && (
            <CardContent className="space-y-3">
              <Field label="Platform" htmlFor="i-platform">
                <Select id="i-platform" value={t.influencer.platform} disabled={!canEdit} onChange={(e) => set("influencer", { ...t.influencer, platform: e.target.value })}>
                  {["instagram", "tiktok", "youtube", "linkedin", "x", "other"].map((p) => (
                    <option key={p} value={p}>
                      {p === "x" ? "X" : sentenceCase(p)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Niche" htmlFor="i-niche" optional>
                <Input id="i-niche" value={t.influencer.niche} disabled={!canEdit} maxLength={120} onChange={(e) => set("influencer", { ...t.influencer, niche: e.target.value })} />
              </Field>
              <Field label="Region" htmlFor="i-region" optional>
                <Input id="i-region" value={t.influencer.region} disabled={!canEdit} maxLength={120} onChange={(e) => set("influencer", { ...t.influencer, region: e.target.value })} />
              </Field>
              <Field label="Minimum followers" htmlFor="i-min" optional>
                <Input id="i-min" inputMode="numeric" value={String(t.influencer.minFollowers || "")} disabled={!canEdit} onChange={(e) => set("influencer", { ...t.influencer, minFollowers: Number(e.target.value.replace(/\D/g, "")) || 0 })} />
              </Field>
              <Field label="Engagement criteria" htmlFor="i-eng" optional>
                <Input id="i-eng" value={t.influencer.engagementCriteria} disabled={!canEdit} maxLength={300} onChange={(e) => set("influencer", { ...t.influencer, engagementCriteria: e.target.value })} />
              </Field>
              <Field label="Partnership objective" htmlFor="i-obj" optional>
                <Input id="i-obj" value={t.influencer.objective} disabled={!canEdit} maxLength={300} onChange={(e) => set("influencer", { ...t.influencer, objective: e.target.value })} />
              </Field>
            </CardContent>
          )}
        </Card>
        {canEdit && (
          <Button
            variant="brand"
            className="w-full"
            disabled={!dirty}
            loading={saving}
            onClick={async () => {
              setSaving(true);
              const res = await saveTargetingAction(t);
              setSaving(false);
              if (!res.ok) return toast.error(res.error);
              toast.success("Targeting rules saved");
              router.refresh();
            }}
          >
            <CheckCircle2 className="size-4" /> Save targeting rules
          </Button>
        )}
      </div>
    </div>
  );
}
