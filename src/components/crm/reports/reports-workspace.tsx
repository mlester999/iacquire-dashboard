"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Archive, BarChart3, Download, EyeOff, Info, LayoutList, Loader2, Lock, MoreHorizontal, Pencil, Pin, PinOff, RotateCcw, Save, SlidersHorizontal, Users,
} from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Badge, Card, EmptyState, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { Dialog, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Popover, PopoverContent, PopoverTrigger } from "@/components/ui/overlays";
import { ConfirmDialog, PageTitle, ReadOnlyNotice, useCrmAction } from "@/components/crm/ui";
import { archiveReportAction, pinReportAction, saveReportAction, updateReportAction } from "@/app/actions/crm-reports";
import {
  FILTER_LABELS, RANGE_LABELS, RANGE_PRESETS, REPORT_CHANNELS, CHANNEL_LABELS, REPORT_SECTIONS, SECTION_INFO, SOURCE_OPTIONS, activeFilters, customRangeIssue, reportSearch, todayIn,
  type RangePreset, type ReportConfig, type ReportFilters, type ReportSection,
} from "@/components/crm/reports/spec";
import { periodText } from "@/components/crm/reports/format";
import {
  AiBody, AppointmentsBody, DealsBody, FollowUpsBody, IntegrationsBody, LeadsBody, MessagingBody, PipelineBody, UsageBody, WorkflowsBody, WorkloadBody, type SectionContext,
} from "@/components/crm/reports/sections";
import type { CrmReport, ReportOptions, SavedReportView, SectionPayloads, SectionResult } from "@/components/crm/reports/types";
import type { CrmScope } from "@/server/crm/page";
import { cn, timeZoneLabel } from "@/lib/utils";

export interface ReportsWorkspaceProps {
  scope: CrmScope;
  report: CrmReport;
  options: ReportOptions;
  saved: SavedReportView[];
  /** The saved report this page was opened from, if any. */
  active: SavedReportView | null;
  /** The sections asked for in the address (null: every section). */
  requested: ReportSection[] | null;
  /** The sections this person may see, in order. */
  available: ReportSection[];
  notices: string[];
  canExport: boolean;
  canShare: boolean;
  canSave: boolean;
}

const sameConfig = (a: ReportConfig, b: ReportConfig) => JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
function normalize(c: ReportConfig) {
  const f: Record<string, string> = { range: c.filters.range };
  for (const k of ["from", "to", "member", "source", "pipeline", "campaign", "channel"] as const) if (c.filters[k]) f[k] = String(c.filters[k]);
  return { f, s: REPORT_SECTIONS.filter((s) => c.sections.includes(s)) };
}

/** The CRM reports screen: filters in the address bar, saved definitions, every section computed by the server, and a CSV download. */
export function ReportsWorkspace({ scope, report, options, saved, active, requested, available, notices, canExport, canShare, canSave }: ReportsWorkspaceProps) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const base = `${scope.base}/reports`;
  const sectionsNow = requested ?? null;
  const config: ReportConfig = { filters: report.filters, sections: requested ?? [...REPORT_SECTIONS] };
  const changed = active ? !sameConfig(active.config, config) : false;

  const hrefFor = React.useCallback(
    (filters: ReportFilters, sections: ReportSection[] | null, savedId: string | null) => {
      const qs = new URLSearchParams(reportSearch(filters, { sections, savedId }));
      // With a saved report open, the period is always written out, so the page uses these filters rather than reloading the saved ones.
      if (savedId && !qs.has("range")) qs.set("range", filters.range);
      const s = qs.toString();
      return `${base}${s ? `?${s}` : ""}`;
    },
    [base],
  );
  const go = (href: string) => startTransition(() => router.push(href, { scroll: false }));
  const apply = (patch: Partial<ReportFilters>, sections: ReportSection[] | null = sectionsNow) => {
    const next: ReportFilters = { ...report.filters, ...patch };
    for (const k of Object.keys(next) as Array<keyof ReportFilters>) if (next[k] === undefined || next[k] === "") delete next[k];
    if (next.range !== "custom") {
      delete next.from;
      delete next.to;
    }
    go(hrefFor(next, sections, active?.id ?? null));
  };

  const exportQs = new URLSearchParams(reportSearch(report.filters, { sections: sectionsNow, savedId: active?.id ?? null }));
  if (!exportQs.has("range")) exportQs.set("range", report.filters.range);
  if (scope.orgId) exportQs.set("org", scope.orgId);

  const ctx: SectionContext = { base: scope.base, timezone: report.timezone, period: report.period, can: (p) => Boolean(scope.can[p as keyof typeof scope.can]), agency: scope.agency };
  const filtered = activeFilters(report.filters);
  const periodLabel = report.filters.range === "custom" ? periodText(report.period.from, report.period.to) : `${RANGE_LABELS[report.filters.range]} · ${periodText(report.period.from, report.period.to)}`;

  return (
    <div className="space-y-5">
      <PageTitle
        title={active ? active.name : "Reports"}
        description={
          active?.description ?? (
            <>Counted from this workspace&rsquo;s own records only. Days run midnight to midnight in {timeZoneLabel(report.timezone)}. Nothing is estimated: a section with no records says so.</>
          )
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {canExport && (
              // `download` makes this an ordinary browser download: the app router leaves the click alone, so the export (its rate limit
              // and audit entry included) runs exactly once per click instead of once for a client navigation and again for the file.
              <ButtonLink href={`/api/crm/reports/export?${exportQs}`} variant="secondary" size="sm" prefetch={false} download>
                <Download className="size-4" aria-hidden />Export CSV
              </ButtonLink>
            )}
            {canSave && active?.editable && changed && <UpdateSavedButton orgId={scope.orgId} report={active} config={config} />}
            {canSave && <SaveReportButton orgId={scope.orgId} config={config} canShare={canShare} labels={report.filterLabels} onSaved={(id) => go(hrefFor(report.filters, sectionsNow, id))} />}
          </div>
        }
      />

      {scope.agency && <ReadOnlyNotice>You&rsquo;re viewing this client&rsquo;s reports in a support session. Saving and exporting reports stay with the client&rsquo;s own team.</ReadOnlyNotice>}

      {notices.length > 0 && (
        <div role="status" className="flex items-start gap-2 rounded-2xl border border-warning/30 bg-warning-soft px-4 py-3 text-[14px] text-warning-ink">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
          <div className="space-y-1">{notices.map((n) => <p key={n}>{n}</p>)}</div>
        </div>
      )}

      <div className="grid gap-5 2xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-5">
          <FilterBar
            // Remounts when the applied filters change, so the controls always start from what the report shows.
            key={JSON.stringify(report.filters)}
            report={report}
            options={options}
            available={available}
            requested={requested}
            pending={pending}
            onApply={apply}
            onSections={(s) => apply({}, s)}
            onReset={() => go(hrefFor({ range: "30d" }, null, active?.id ?? null))}
          />

          <div aria-live="polite" className="sr-only">{pending ? "Updating the report…" : ""}</div>
          <div aria-busy={pending || undefined} className={cn("space-y-5 transition-opacity", pending && "opacity-60")}>
            {report.sections.length > 1 && (
              <nav aria-label="Report sections" className="relative scrollbar-thin -mx-1 flex max-w-full gap-1 overflow-x-auto px-1 py-0.5 lg:mx-0 lg:flex-wrap lg:overflow-visible lg:px-0">
                {report.sections.map((s) => (
                  <a key={s.section} href={`#report-${s.section}`} className="inline-flex min-h-11 shrink-0 items-center rounded-xl border border-line bg-surface px-3 text-[13px] font-medium text-ink-2 hover:bg-surface-2 sm:min-h-8">
                    {SECTION_INFO[s.section].label}
                  </a>
                ))}
              </nav>
            )}

            {report.sections.length === 0 ? (
              <Card>
                <EmptyState
                  icon={<EyeOff className="size-5" />}
                  title="Nothing to show"
                  description={report.hidden.length ? "The sections in this report need permissions you don't have." : "Pick at least one section."}
                />
              </Card>
            ) : (
              report.sections.map((s) => <SectionCard key={s.section} result={s} ctx={ctx} periodLabel={periodLabel} />)
            )}

            {report.hidden.length > 0 && (
              <Card className="p-4">
                <h2 className="flex items-center gap-2 text-[14px] font-semibold text-ink"><EyeOff className="size-4 text-muted" aria-hidden />Not included</h2>
                <ul className="mt-2 space-y-1 text-[14px] text-muted">
                  {report.hidden.map((h) => <li key={h.section}><span className="font-medium text-ink-2">{SECTION_INFO[h.section].label}</span>: {h.reason}</li>)}
                </ul>
              </Card>
            )}
            <p className="text-[12px] text-faint" suppressHydrationWarning>
              Computed {new Date(report.generatedAt).toLocaleString("en-US", { timeZone: report.timezone, dateStyle: "medium", timeStyle: "short" })} ({timeZoneLabel(report.timezone)}).
              {filtered.length > 0 && ` Filtered by ${filtered.map((k) => FILTER_LABELS[k].toLowerCase()).join(", ")}.`}
            </p>
          </div>
        </div>

        <aside className="order-first min-w-0 xl:order-none">
          <SavedReports orgId={scope.orgId} saved={saved} activeId={active?.id ?? null} base={base} canShare={canShare} canSave={canSave} />
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

function FilterBar({ report, options, available, requested, pending, onApply, onSections, onReset }: {
  report: CrmReport;
  options: ReportOptions;
  available: ReportSection[];
  requested: ReportSection[] | null;
  pending: boolean;
  onApply: (patch: Partial<ReportFilters>) => void;
  onSections: (s: ReportSection[] | null) => void;
  onReset: () => void;
}) {
  const f = report.filters;
  const id = React.useId();
  const [range, setRange] = React.useState<RangePreset>(f.range);
  const [from, setFrom] = React.useState(f.from ?? report.period.from);
  const [to, setTo] = React.useState(f.to ?? report.period.to);
  const [error, setError] = React.useState<string | null>(null);
  const today = todayIn(report.timezone);
  const any = activeFilters(f).length > 0 || f.range !== "30d" || requested !== null;

  const applyCustom = (e: React.FormEvent) => {
    e.preventDefault();
    const issue = customRangeIssue(from, to, today);
    setError(issue);
    if (!issue) onApply({ range: "custom", from, to });
  };

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-[14px] font-semibold text-ink"><SlidersHorizontal className="size-4 text-muted" aria-hidden />Filters</h2>
        <div className="flex items-center gap-2">
          {pending && <span className="inline-flex items-center gap-1.5 text-[12px] text-muted"><Loader2 className="size-3.5 animate-spin" aria-hidden />Updating</span>}
          {any && <Button variant="ghost" size="sm" onClick={onReset}><RotateCcw className="size-3.5" aria-hidden />Reset</Button>}
        </div>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Period" htmlFor={`${id}-range`}>
          <Select
            id={`${id}-range`}
            value={range}
            onChange={(e) => {
              const v = e.target.value as RangePreset;
              setRange(v);
              if (v !== "custom") onApply({ range: v });
            }}
          >
            {RANGE_PRESETS.map((r) => <option key={r} value={r}>{RANGE_LABELS[r]}</option>)}
          </Select>
        </Field>
        <Field label={FILTER_LABELS.member} htmlFor={`${id}-member`}>
          <Select id={`${id}-member`} value={f.member ?? ""} onChange={(e) => onApply({ member: e.target.value || undefined })}>
            <option value="">Everyone</option>
            {options.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
        </Field>
        <Field label={FILTER_LABELS.source} htmlFor={`${id}-source`} hint="How the contact was created.">
          <Select id={`${id}-source`} value={f.source ?? ""} onChange={(e) => onApply({ source: (e.target.value || undefined) as ReportFilters["source"] })}>
            <option value="">All sources</option>
            {SOURCE_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </Select>
        </Field>
        {options.pipelines.length > 0 && (
          <Field label={FILTER_LABELS.pipeline} htmlFor={`${id}-pipeline`}>
            <Select id={`${id}-pipeline`} value={f.pipeline ?? ""} onChange={(e) => onApply({ pipeline: e.target.value || undefined })}>
              <option value="">All pipelines</option>
              {options.pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
        )}
        {options.campaigns.length > 0 && (
          <Field label={FILTER_LABELS.campaign} htmlFor={`${id}-campaign`}>
            <Select id={`${id}-campaign`} value={f.campaign ?? ""} onChange={(e) => onApply({ campaign: e.target.value || undefined })}>
              <option value="">All campaigns</option>
              {options.campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
        )}
        <Field label={FILTER_LABELS.channel} htmlFor={`${id}-channel`}>
          <Select id={`${id}-channel`} value={f.channel ?? ""} onChange={(e) => onApply({ channel: (e.target.value || undefined) as ReportFilters["channel"] })}>
            <option value="">All channels</option>
            {REPORT_CHANNELS.map((c) => <option key={c} value={c}>{CHANNEL_LABELS[c]}</option>)}
          </Select>
        </Field>
      </div>
      {range === "custom" && (
        <form onSubmit={applyCustom} className="mt-3 flex flex-wrap items-end gap-2" noValidate>
          <Field label="From" htmlFor={`${id}-from`} className="w-full sm:w-44">
            <Input id={`${id}-from`} type="date" value={from} max={today} onChange={(e) => setFrom(e.target.value)} aria-invalid={Boolean(error) || undefined} aria-describedby={error ? `${id}-range-error` : undefined} />
          </Field>
          <Field label="To" htmlFor={`${id}-to`} className="w-full sm:w-44">
            <Input id={`${id}-to`} type="date" value={to} max={today} onChange={(e) => setTo(e.target.value)} aria-invalid={Boolean(error) || undefined} aria-describedby={error ? `${id}-range-error` : undefined} />
          </Field>
          <Button type="submit" size="md">Apply dates</Button>
          {error && <p id={`${id}-range-error`} role="alert" className="w-full text-[13px] text-danger-ink">{error}</p>}
        </form>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <SectionsPicker available={available} requested={requested} onChange={onSections} />
        <p className="text-[13px] text-muted">
          {requested ? `${requested.filter((s) => available.includes(s)).length} of ${available.length} sections` : `All ${available.length} sections you can see`}
        </p>
      </div>
    </Card>
  );
}

function SectionsPicker({ available, requested, onChange }: { available: ReportSection[]; requested: ReportSection[] | null; onChange: (s: ReportSection[] | null) => void }) {
  const [open, setOpen] = React.useState(false);
  const [picked, setPicked] = React.useState<ReportSection[]>(requested ?? available);
  const onOpenChange = (o: boolean) => {
    if (o) setPicked(requested ? requested.filter((s) => available.includes(s)) : available);
    setOpen(o);
  };
  const toggle = (s: ReportSection) => setPicked((p) => (p.includes(s) ? p.filter((x) => x !== s) : REPORT_SECTIONS.filter((x) => x === s || p.includes(x))));
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="secondary" size="sm"><LayoutList className="size-4" aria-hidden />Sections</Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(22rem,calc(100vw-2rem))] p-3">
        <fieldset>
          <legend className="px-1 text-[14px] font-semibold text-ink">Show these sections</legend>
          <div className="mt-2 max-h-[50vh] space-y-0.5 overflow-y-auto">
            {available.map((s) => (
              <label key={s} className="flex min-h-11 cursor-pointer items-start gap-2.5 rounded-lg px-1.5 py-1.5 hover:bg-surface-2 sm:min-h-9">
                <input type="checkbox" className="mt-0.5 size-4 accent-[var(--primary)]" checked={picked.includes(s)} onChange={() => toggle(s)} />
                <span className="min-w-0">
                  <span className="block text-[14px] font-medium text-ink-2">{SECTION_INFO[s].label}</span>
                  <span className="block text-[12px] leading-snug text-muted">{SECTION_INFO[s].description}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
          <Button variant="ghost" size="sm" onClick={() => setPicked(picked.length === available.length ? [] : available)}>{picked.length === available.length ? "Clear all" : "Select all"}</Button>
          <Button
            size="sm"
            disabled={!picked.length}
            onClick={() => {
              setOpen(false);
              onChange(picked.length === available.length ? null : picked);
            }}
          >
            Show {picked.length || ""} section{picked.length === 1 ? "" : "s"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function SectionCard({ result, ctx, periodLabel }: { result: CrmReport["sections"][number]; ctx: SectionContext; periodLabel: string }) {
  const info = SECTION_INFO[result.section];
  const headingId = `report-${result.section}-title`;
  return (
    <Card id={`report-${result.section}`} role="region" className="scroll-mt-24 p-4 sm:p-5" aria-labelledby={headingId}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id={headingId} className="text-[15px] font-semibold tracking-tight text-ink">{info.label}</h2>
          <p className="mt-0.5 text-[14px] text-muted">{info.description}</p>
        </div>
        <Badge tone={info.dated ? "neutral" : "primary"}>{info.dated ? periodLabel : "Current state"}</Badge>
      </div>
      {(result.notes.length > 0 || result.ignored.length > 0) && (
        <div className="mt-3 space-y-1 rounded-xl bg-surface-2 px-3 py-2 text-[13px] text-muted">
          {result.notes.map((n) => <p key={n}>{n}</p>)}
          {result.ignored.length > 0 && <p>The {result.ignored.map((k) => FILTER_LABELS[k].toLowerCase()).join(" and ")} filter{result.ignored.length === 1 ? " doesn't" : "s don't"} apply to this section.</p>}
        </div>
      )}
      <div className="@container mt-4">
        {result.empty ? (
          <EmptyState
            compact
            icon={<BarChart3 className="size-5" />}
            title="No data yet"
            description={info.dated ? "Nothing was recorded for this period with these filters." : "Nothing is set up here yet."}
          />
        ) : (
          <SectionBody result={result} ctx={ctx} />
        )}
      </div>
      <p className="mt-4 border-t border-line pt-3 text-[12px] text-faint">Counted from: {info.sources}</p>
    </Card>
  );
}

function SectionBody({ result, ctx }: { result: SectionResult; ctx: SectionContext }) {
  switch (result.section) {
    case "leads":
      return <LeadsBody data={result.data as SectionPayloads["leads"]} ctx={ctx} />;
    case "appointments":
      return <AppointmentsBody data={result.data as SectionPayloads["appointments"]} ctx={ctx} />;
    case "deals":
      return <DealsBody data={result.data as SectionPayloads["deals"]} ctx={ctx} />;
    case "pipeline":
      return <PipelineBody data={result.data as SectionPayloads["pipeline"]} ctx={ctx} />;
    case "messaging":
      return <MessagingBody data={result.data as SectionPayloads["messaging"]} ctx={ctx} />;
    case "followups":
      return <FollowUpsBody data={result.data as SectionPayloads["followups"]} ctx={ctx} />;
    case "workload":
      return <WorkloadBody data={result.data as SectionPayloads["workload"]} ctx={ctx} />;
    case "ai":
      return <AiBody data={result.data as SectionPayloads["ai"]} ctx={ctx} />;
    case "workflows":
      return <WorkflowsBody data={result.data as SectionPayloads["workflows"]} ctx={ctx} />;
    case "integrations":
      return <IntegrationsBody data={result.data as SectionPayloads["integrations"]} ctx={ctx} />;
    case "usage":
      return <UsageBody data={result.data as SectionPayloads["usage"]} ctx={ctx} />;
  }
}

// ---------------------------------------------------------------------------
// Saved reports
// ---------------------------------------------------------------------------

function configSummary(config: ReportConfig, labels: Partial<Record<keyof ReportFilters, string>>): string[] {
  const out = [config.filters.range === "custom" && config.filters.from && config.filters.to ? `${periodText(config.filters.from, config.filters.to)} (fixed dates)` : `${RANGE_LABELS[config.filters.range]} (moves with time)`];
  for (const k of activeFilters(config.filters)) out.push(`${FILTER_LABELS[k]}: ${labels[k] ?? "chosen"}`);
  out.push(config.sections.length === REPORT_SECTIONS.length ? "Every section" : `${config.sections.length} section${config.sections.length === 1 ? "" : "s"}: ${config.sections.map((s) => SECTION_INFO[s].label).join(", ")}`);
  return out;
}

function ReportDetailsForm({ id, name, setName, description, setDescription, visibility, setVisibility, canShare, canPrivate = true, error }: {
  id: string; name: string; setName: (v: string) => void; description: string; setDescription: (v: string) => void; visibility: "private" | "team"; setVisibility: (v: "private" | "team") => void;
  canShare: boolean; canPrivate?: boolean; error: string | null;
}) {
  return (
    <div className="space-y-4">
      <Field label="Name" htmlFor={`${id}-name`} error={error}>
        <Input id={`${id}-name`} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoComplete="off" required aria-invalid={Boolean(error) || undefined} />
      </Field>
      <Field label="Description" htmlFor={`${id}-desc`} optional hint={`${description.length}/300`}>
        <Textarea id={`${id}-desc`} value={description} maxLength={300} rows={2} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <fieldset>
        <legend className="text-[14px] font-medium text-ink-2">Who can open it</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {([
            { value: "private", icon: Lock, title: "Only me", body: "A private report is yours alone." },
            { value: "team", icon: Users, title: "My team", body: canShare ? "Everyone who can see reports here." : "Needs the “Export reports” permission." },
          ] as const).map((o) => {
            const off = o.value === "team" ? !canShare : !canPrivate;
            return (
            <label key={o.value} className={cn("flex min-h-11 cursor-pointer items-start gap-2.5 rounded-xl border p-3", visibility === o.value ? "border-primary/40 bg-primary-soft/50" : "border-line", off && "cursor-not-allowed opacity-60")}>
              <input type="radio" name={`${id}-visibility`} value={o.value} className="mt-0.5 accent-[var(--primary)]" checked={visibility === o.value} disabled={off} onChange={() => setVisibility(o.value)} />
              <span><span className="flex items-center gap-1.5 text-[14px] font-medium text-ink"><o.icon className="size-3.5" aria-hidden />{o.title}</span><span className="block text-[12px] text-muted">{o.body}</span></span>
            </label>
            );
          })}
        </div>
      </fieldset>
    </div>
  );
}

function SaveReportButton({ orgId, config, canShare, labels, onSaved }: { orgId: string | null; config: ReportConfig; canShare: boolean; labels: CrmReport["filterLabels"]; onSaved: (id: string) => void }) {
  const id = React.useId();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [visibility, setVisibility] = React.useState<"private" | "team">("private");
  const [error, setError] = React.useState<string | null>(null);
  const { run, busy } = useCrmAction();
  const submit = async () => {
    const n = name.replace(/\s+/g, " ").trim();
    if (!n) return setError("Name the report.");
    setError(null);
    const out = await run("save", () => saveReportAction(orgId, { name: n, description: description.trim() || null, config, visibility }), "Report saved.");
    if (out && typeof out === "object" && "id" in out) {
      setOpen(false);
      setName("");
      setDescription("");
      onSaved(out.id);
    }
  };
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}><Save className="size-4" aria-hidden />Save report</Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Save this report"
        description="Saves the filters and sections, not the numbers: a saved report is recomputed from your records every time it opens."
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={busy("save")} onClick={submit}>Save report</Button></>}
      >
        <div className="space-y-4">
          <ReportDetailsForm id={id} name={name} setName={setName} description={description} setDescription={setDescription} visibility={visibility} setVisibility={setVisibility} canShare={canShare} error={error} />
          <div className="rounded-xl bg-surface-2 px-3 py-2.5">
            <p className="text-[12px] font-medium text-muted">What it remembers</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[13px] text-ink-2">{configSummary(config, labels).map((l) => <li key={l}>{l}</li>)}</ul>
          </div>
        </div>
      </Dialog>
    </>
  );
}

function UpdateSavedButton({ orgId, report, config }: { orgId: string | null; report: SavedReportView; config: ReportConfig }) {
  const { run, busy } = useCrmAction();
  return (
    <Button variant="secondary" size="sm" loading={busy("update")} onClick={() => run("update", () => updateReportAction(orgId, report.id, { config }), `“${report.name}” now uses these filters.`)}>
      <Save className="size-4" aria-hidden />Save changes
    </Button>
  );
}

function SavedReports({ orgId, saved, activeId, base, canShare, canSave }: { orgId: string | null; saved: SavedReportView[]; activeId: string | null; base: string; canShare: boolean; canSave: boolean }) {
  const { run, busy } = useCrmAction();
  const router = useRouter();
  const [editing, setEditing] = React.useState<SavedReportView | null>(null);
  const [archiving, setArchiving] = React.useState<SavedReportView | null>(null);
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[14px] font-semibold text-ink">Saved reports</h2>
        {activeId && <Link href={base} className="text-[13px] font-medium text-primary hover:underline">New report</Link>}
      </div>
      {!saved.length ? (
        <p className="mt-2 text-[13px] leading-relaxed text-muted">{canSave ? "Save a set of filters and sections to open it again in one click. Saved reports always show current numbers." : "No saved reports yet."}</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {saved.map((r) => (
            <li key={r.id} className={cn("group flex items-start gap-1 rounded-xl", r.id === activeId && "bg-primary-soft/60")}>
              <Link href={`${base}?report=${r.id}`} aria-current={r.id === activeId ? "page" : undefined} className="flex min-h-11 min-w-0 flex-1 items-start gap-2 rounded-xl px-2 py-2 hover:bg-surface-2">
                {r.pinned ? <Pin className="mt-0.5 size-3.5 shrink-0 text-primary" aria-label="Pinned" /> : r.visibility === "private" ? <Lock className="mt-0.5 size-3.5 shrink-0 text-muted" aria-label="Private" /> : <Users className="mt-0.5 size-3.5 shrink-0 text-muted" aria-label="Team" />}
                <span className="min-w-0">
                  <span className="block truncate text-[14px] font-medium text-ink">{r.name}</span>
                  <span className="block truncate text-[12px] text-muted">{r.visibility === "private" ? "Only you" : r.mine ? "Shared with your team" : `Shared by ${r.ownerName ?? "a former team member"}`}</span>
                </span>
              </Link>
              {r.editable && canSave && (
                <Menu>
                  <MenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${r.name}`} className="mt-1 shrink-0"><MoreHorizontal className="size-4" aria-hidden /></Button>
                  </MenuTrigger>
                  <MenuContent>
                    <MenuItem disabled={busy(`pin:${r.id}`)} onSelect={() => run(`pin:${r.id}`, () => pinReportAction(orgId, r.id, !r.pinned), r.pinned ? "Unpinned." : "Pinned to the top.")}>
                      {r.pinned ? <PinOff className="size-4" aria-hidden /> : <Pin className="size-4" aria-hidden />}{r.pinned ? "Unpin" : "Pin to top"}
                    </MenuItem>
                    <MenuItem onSelect={() => setEditing(r)}><Pencil className="size-4" aria-hidden />Rename or share</MenuItem>
                    <MenuSeparator />
                    <MenuItem destructive onSelect={() => setArchiving(r)}><Archive className="size-4" aria-hidden />Archive</MenuItem>
                  </MenuContent>
                </Menu>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && <EditSavedDialog orgId={orgId} report={editing} canShare={canShare} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={Boolean(archiving)}
        onOpenChange={(o) => !o && setArchiving(null)}
        title="Archive this saved report?"
        description={archiving?.visibility === "team" ? "It disappears for everyone on your team. Your records and the numbers aren't affected." : "It disappears from your list. Your records and the numbers aren't affected."}
        confirmLabel="Archive"
        danger
        loading={archiving ? busy(`archive:${archiving.id}`) : false}
        onConfirm={async () => {
          if (!archiving) return;
          const target = archiving;
          if (await run(`archive:${target.id}`, () => archiveReportAction(orgId, target.id), "Report archived.")) {
            setArchiving(null);
            if (target.id === activeId) router.push(base);
          }
        }}
      />
    </Card>
  );
}

function EditSavedDialog({ orgId, report, canShare, onClose }: { orgId: string | null; report: SavedReportView; canShare: boolean; onClose: () => void }) {
  const id = React.useId();
  const [name, setName] = React.useState(report.name);
  const [description, setDescription] = React.useState(report.description ?? "");
  const [visibility, setVisibility] = React.useState(report.visibility);
  const [error, setError] = React.useState<string | null>(null);
  const { run, busy } = useCrmAction();
  // Making someone else's team report private would take it away from its owner; only they can.
  const shareOk = canShare || report.visibility === "team";
  const submit = async () => {
    const n = name.replace(/\s+/g, " ").trim();
    if (!n) return setError("Name the report.");
    setError(null);
    if (await run("edit", () => updateReportAction(orgId, report.id, { name: n, description: description.trim() || null, ...(visibility !== report.visibility ? { visibility } : {}) }), "Report updated.")) onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Rename or share"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy("edit")} onClick={submit}>Save</Button></>}
    >
      <ReportDetailsForm id={id} name={name} setName={setName} description={description} setDescription={setDescription} visibility={visibility} setVisibility={setVisibility} canShare={shareOk} canPrivate={report.mine || report.visibility === "private"} error={error} />
      {!report.mine && <p className="mt-3 text-[13px] text-muted">{report.ownerName ?? "Another team member"} saved this report. Only they can make it private again.</p>}
    </Dialog>
  );
}
