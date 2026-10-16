"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Building2, CheckCircle2, Clock3, Eye, Gauge, Lock, SlidersHorizontal, Trash2, TriangleAlert } from "lucide-react";
import { clearFairUsePolicyAction, saveFairUsePolicyAction } from "@/app/(admin)/admin/commercial-actions";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, EmptyState, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { AvatarTile, InfoChip, RelativeTime, StatusPill, type StatusTone } from "@/components/ui/status";
import { SectionLabel } from "@/components/ui/workspace";
import { FAIR_USE_METRICS, METRIC_INFO, STATE_LABEL, formatMetricValue, type FairUseMetric, type FairUseState } from "@/lib/fair-use";
import {  } from "@/lib/utils";
import type { FleetRow, PolicyRow } from "@/server/fairuse/service";
import type { ReviewRow } from "@/server/inactivity/service";

const GB = 1024 ** 3;
const TONE: Record<FairUseState, StatusTone> = { unset: "neutral", ok: "success", warning: "warning", over: "danger" };
const SEVERITY: FairUseState[] = ["over", "warning", "ok", "unset"];
/** The card headline is the worst measure the client has: one glance says whether anything needs attention. */
const worstState = (states: FairUseState[]): FairUseState => SEVERITY.find((s) => states.includes(s)) ?? "unset";

/** Storage is entered in gigabytes; every other measure is a plain count. */
const toStored = (metric: FairUseMetric, text: string): number | null => {
  const t = text.trim();
  if (t === "") return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return Number.NaN;
  return METRIC_INFO[metric].unit === "bytes" ? Math.round(n * GB) : Math.round(n);
};
const unitHint = (metric: FairUseMetric) => (METRIC_INFO[metric].unit === "bytes" ? "GB" : "count");

export function FairUseAdmin({ fleet, policies, reviews, clients, canManage }: { fleet: FleetRow[]; policies: PolicyRow[]; reviews: ReviewRow[]; clients: Array<{ id: string; name: string }>; canManage: boolean }) {
  const router = useRouter();
  const [scope, setScope] = React.useState("");
  const [metric, setMetric] = React.useState<FairUseMetric>("storage_bytes");
  const [warn, setWarn] = React.useState("");
  const [limit, setLimit] = React.useState("");
  const [enforcement, setEnforcement] = React.useState<"report_only" | "block_new">("report_only");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  const open = reviews.filter((r) => r.status === "open");

  const save = async () => {
    const w = toStored(metric, warn);
    const l = toStored(metric, limit);
    if (Number.isNaN(w) || Number.isNaN(l)) return void toast.error("Enter a number of zero or more, or leave the field empty.");
    if (w === null && l === null) return void toast.error("Set a warning level, a limit, or both.");
    setBusy("save");
    const res = await saveFairUsePolicyAction({ orgId: scope || null, metric, warn: w, limit: l, enforcement: METRIC_INFO[metric].canBlock ? enforcement : "report_only", note: note.trim() || undefined });
    setBusy(null);
    if (!res.ok) return void toast.error(res.error ?? "That didn't save.");
    toast.success("Threshold saved");
    setWarn("");
    setLimit("");
    setNote("");
    router.refresh();
  };
  const clear = async (id: string) => {
    setBusy(id);
    const res = await clearFairUsePolicyAction(id);
    setBusy(null);
    if (!res.ok) return void toast.error(res.error ?? "That didn't work.");
    toast.success("Threshold removed");
    router.refresh();
  };

  return (
    <div className="space-y-8">
      <section>
        <SectionLabel title="Fair use" description="What each client actually uses, measured from recorded data. No limit is built in: until you set a number from real provider costs, a measure reads “No limit set”, and nothing is ever switched off by a measure other than new file uploads." />
        {fleet.length === 0 ? (
          <Card><EmptyState compact icon={<Gauge className="size-5" />} title="No measurements yet" description="Measurements are recorded by the scheduled check. They will appear here after its first run." /></Card>
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {fleet.map((f) => {
              const worst = worstState(f.metrics.map((m) => m.state));
              return (
                <Card key={f.orgId} className="min-w-0 p-5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <AvatarTile name={f.name} />
                      <Link href={`/admin/clients/${f.orgId}?tab=usage`} className="min-w-0 truncate text-[15px] font-semibold hover:text-primary-ink" title={f.name}>{f.name}</Link>
                    </div>
                    <StatusPill tone={TONE[worst]} size="sm">{worst === "unset" ? "No limits set" : STATE_LABEL[worst]}</StatusPill>
                  </div>
                  <dl className="mt-4 divide-y divide-line overflow-hidden rounded-xl border border-line">
                    {f.metrics.map((m) => (
                      <div key={m.metric} className="management-row flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5 text-[13px]">
                        <dt className="min-w-0 flex-1 basis-32 truncate text-ink-2" title={METRIC_INFO[m.metric].label}>{METRIC_INFO[m.metric].label}</dt>
                        <dd className="flex items-center justify-end gap-3">
                          <span className="min-w-16 whitespace-nowrap text-right font-semibold tabular-nums">{m.valueText}</span>
                          <span className="flex w-[9.75rem] justify-end"><StatusPill tone={TONE[m.state]} size="sm">{STATE_LABEL[m.state]}</StatusPill></span>
                        </dd>
                      </div>
                    ))}
                  </dl>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      <section>
        <SectionLabel title="Thresholds" count={policies.length} description="A setting for one client overrides the setting for all clients. Only file storage can be set to refuse new uploads; it never deletes anything and never touches a website." />
        <Card className="space-y-5 p-5">
          {policies.length === 0 ? (
            <EmptyState compact icon={<Gauge className="size-5" />} title="No thresholds are set" description="Clients see their real usage with “No limit set” until you choose a number." />
          ) : (
            <ul className="divide-y divide-line">
              {policies.map((p) => (
                <li key={p.id} className="flex flex-wrap items-start justify-between gap-3 py-4 first:pt-0 last:pb-0">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[14px] font-semibold">{p.label}</span>
                      <InfoChip icon={<Building2 />}>{p.orgName ?? "All clients"}</InfoChip>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {p.warn !== null ? <InfoChip icon={<TriangleAlert />}>Warn at {formatMetricValue(p.metric, p.warn)}</InfoChip> : <InfoChip>No separate warning (80% of the limit)</InfoChip>}
                      {p.limit !== null ? <InfoChip icon={<Gauge />}>Limit {formatMetricValue(p.metric, p.limit)}</InfoChip> : <InfoChip>No limit</InfoChip>}
                      {p.enforcement === "block_new" ? <StatusPill tone="warning" size="sm" icon={<Lock className="size-3" aria-hidden />}>Refuses new uploads when over</StatusPill> : <StatusPill tone="neutral" size="sm" icon={<Eye className="size-3" aria-hidden />}>Report only</StatusPill>}
                    </div>
                    {p.note && <p className="mt-2.5 border-l-2 border-line-strong pl-3 text-[12.5px] leading-relaxed text-muted">{p.note}</p>}
                  </div>
                  {canManage && <Button size="sm" variant="outline" loading={busy === p.id} onClick={() => clear(p.id)} aria-label={`Remove the ${p.label} threshold for ${p.orgName ?? "all clients"}`}><Trash2 className="size-3.5" aria-hidden />Remove</Button>}
                </li>
              ))}
            </ul>
          )}

          {canManage ? (
            <div className="space-y-4 rounded-2xl border border-line bg-surface-2/40 p-4 sm:p-5">
              <div className="flex items-center gap-2.5"><span className="flex size-8 items-center justify-center rounded-lg bg-primary-soft text-primary-ink" aria-hidden><SlidersHorizontal className="size-4" /></span><p className="text-[14px] font-semibold">Set a threshold</p></div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Applies to" htmlFor="fu-scope">
                  <Select id="fu-scope" value={scope} onChange={(e) => setScope(e.target.value)}>
                    <option value="">All clients</option>
                    {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </Select>
                </Field>
                <Field label="Measure" htmlFor="fu-metric">
                  <Select id="fu-metric" value={metric} onChange={(e) => { const m = e.target.value as FairUseMetric; setMetric(m); if (!METRIC_INFO[m].canBlock) setEnforcement("report_only"); }}>
                    {FAIR_USE_METRICS.map((m) => <option key={m} value={m}>{METRIC_INFO[m].label} ({METRIC_INFO[m].window})</option>)}
                  </Select>
                </Field>
                <Field label={`Warn at (${unitHint(metric)})`} htmlFor="fu-warn" optional>
                  <Input id="fu-warn" inputMode="decimal" value={warn} onChange={(e) => setWarn(e.target.value)} />
                </Field>
                <Field label={`Limit (${unitHint(metric)})`} htmlFor="fu-limit" optional>
                  <Input id="fu-limit" inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} />
                </Field>
              </div>
              {METRIC_INFO[metric].canBlock && (
                <Field label="When over the limit" htmlFor="fu-enforce" hint="Refusing new uploads never removes anything the client already has.">
                  <Select id="fu-enforce" value={enforcement} onChange={(e) => setEnforcement(e.target.value as typeof enforcement)}>
                    <option value="report_only">Only report it</option>
                    <option value="block_new">Refuse new uploads</option>
                  </Select>
                </Field>
              )}
              <Field label="Note" htmlFor="fu-note" optional hint="For example, the provider cost this number is based on.">
                <Textarea id="fu-note" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
              <Button loading={busy === "save"} onClick={save} className="w-full sm:w-auto">Save threshold</Button>
            </div>
          ) : (
            <p className="flex items-center gap-2 border-t border-line pt-4 text-[12.5px] text-muted"><Lock className="size-3.5" aria-hidden />Only super admins can change thresholds.</p>
          )}
        </Card>
      </section>

      <section>
        <SectionLabel title="Quiet accounts" count={open.length} description="Workspaces with no sign of activity for 180 days. The owner is reminded; nothing is switched off or deleted without a decision." />
        {open.length === 0 ? (
          <Card><EmptyState compact icon={<CheckCircle2 className="size-5" />} title="No quiet accounts" description="Every workspace has shown activity recently." /></Card>
        ) : (
          <Card className="overflow-hidden">
            <ul className="divide-y divide-line">
              {open.map((r) => (
                <li key={r.id} className="management-row flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-warning-soft text-warning-ink"><Clock3 className="size-4" aria-hidden /></span>
                    <div className="min-w-0">
                      <p className="truncate text-[14px] font-semibold" title={r.orgName}>{r.orgName}</p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <StatusPill tone="warning" size="sm">{r.inactiveDays} days quiet</StatusPill>
                        <InfoChip>{r.noticesSent} {r.noticesSent === 1 ? "notice" : "notices"} sent</InfoChip>
                        <InfoChip><RelativeTime value={r.openedAt} prefix="Flagged " /></InfoChip>
                      </div>
                    </div>
                  </div>
                  <ButtonLink href={`/admin/clients/${r.orgId}/offboarding`} variant="secondary" size="sm">Review</ButtonLink>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>
    </div>
  );
}
