"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Clock, Gauge } from "lucide-react";
import { clearFairUsePolicyAction, saveFairUsePolicyAction } from "@/app/(admin)/admin/commercial-actions";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { SectionLabel } from "@/components/ui/workspace";
import { FAIR_USE_METRICS, METRIC_INFO, STATE_LABEL, formatMetricValue, type FairUseMetric, type FairUseState } from "@/lib/fair-use";
import { relativeTime } from "@/lib/utils";
import type { FleetRow, PolicyRow } from "@/server/fairuse/service";
import type { ReviewRow } from "@/server/inactivity/service";

const GB = 1024 ** 3;
const TONE: Record<FairUseState, "neutral" | "success" | "warning" | "danger"> = { unset: "neutral", ok: "success", warning: "warning", over: "danger" };

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
          <EmptyState title="No measurements yet" description="Measurements are recorded by the scheduled check. They will appear here after its first run." />
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {fleet.map((f) => (
              <Card key={f.orgId} className="p-5">
                <Link href={`/admin/clients/${f.orgId}?tab=usage`} className="text-[15px] font-semibold hover:underline">{f.name}</Link>
                <dl className="mt-3 space-y-2">
                  {f.metrics.map((m) => (
                    <div key={m.metric} className="flex items-center justify-between gap-3 text-[13px]">
                      <dt className="text-muted">{METRIC_INFO[m.metric].label}</dt>
                      <dd className="flex items-center gap-2"><span className="tabular-nums">{m.valueText}</span><Badge tone={TONE[m.state]}>{STATE_LABEL[m.state]}</Badge></dd>
                    </div>
                  ))}
                </dl>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section>
        <SectionLabel title="Thresholds" count={policies.length} description="A setting for one client overrides the setting for all clients. Only file storage can be set to refuse new uploads; it never deletes anything and never touches a website." />
        <Card className="space-y-5 p-5">
          {policies.length === 0 ? (
            <p className="flex items-start gap-2 text-[13.5px] leading-relaxed text-muted"><Gauge className="mt-0.5 size-4 shrink-0" aria-hidden />No thresholds are set. Clients see their real usage with “No limit set”.</p>
          ) : (
            <ul className="divide-y divide-line">
              {policies.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                  <div className="min-w-0 text-[13.5px]">
                    <p className="font-medium">{p.label} <span className="font-normal text-muted">· {p.orgName ?? "All clients"}</span></p>
                    <p className="text-[12.5px] text-muted">
                      {p.warn !== null ? `Warn at ${formatMetricValue(p.metric, p.warn)}` : "No separate warning (80% of the limit)"}
                      {p.limit !== null ? ` · limit ${formatMetricValue(p.metric, p.limit)}` : " · no limit"}
                      {p.enforcement === "block_new" ? " · refuses new uploads when over" : " · report only"}
                    </p>
                    {p.note && <p className="mt-0.5 text-[12.5px] text-muted">{p.note}</p>}
                  </div>
                  {canManage && <Button size="sm" variant="ghost" loading={busy === p.id} onClick={() => clear(p.id)}>Remove</Button>}
                </li>
              ))}
            </ul>
          )}

          {canManage ? (
            <div className="space-y-4 border-t border-line pt-5">
              <p className="text-[13.5px] font-semibold">Set a threshold</p>
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
              <Button loading={busy === "save"} onClick={save}>Save threshold</Button>
            </div>
          ) : (
            <p className="border-t border-line pt-4 text-[12.5px] text-muted">Only super admins can change thresholds.</p>
          )}
        </Card>
      </section>

      <section>
        <SectionLabel title="Quiet accounts" count={open.length} description="Workspaces with no sign of activity for 180 days. The owner is reminded; nothing is switched off or deleted without a decision." />
        {open.length === 0 ? (
          <Card className="p-5"><p className="text-[13.5px] text-muted">No quiet accounts.</p></Card>
        ) : (
          <Card className="overflow-hidden">
            <ul className="divide-y divide-line">
              {open.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-warning-soft text-warning-ink"><Clock className="size-4" aria-hidden /></span>
                    <div className="min-w-0">
                      <p className="truncate text-[14px] font-medium">{r.orgName}</p>
                      <p className="text-[12.5px] text-muted">{r.inactiveDays} days quiet · {r.noticesSent} notice{r.noticesSent === 1 ? "" : "s"} sent · flagged {relativeTime(r.openedAt)}</p>
                    </div>
                  </div>
                  <Link href={`/admin/clients/${r.orgId}/offboarding`} className="text-[13px] font-medium text-primary-ink hover:underline">Review</Link>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>
    </div>
  );
}
