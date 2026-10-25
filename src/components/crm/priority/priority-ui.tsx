"use client";

import * as React from "react";
import { Flame, Snowflake, Sun, HelpCircle, RefreshCw, Sparkles, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { clearPriorityOverrideAction, reassessLeadAction, setPriorityOverrideAction } from "@/app/actions/lead-scoring";
import { SectionCard } from "@/components/crm/record-panels";
import { useCrmAction } from "@/components/crm/ui";
import { RelativeTime } from "@/components/crm/relative-time";
import { DIMENSIONS, DIMENSION_HELP, DIMENSION_TEXT, LEAD_LABEL_HELP, LEAD_LABEL_TEXT, type Dimension, type LeadLabel } from "@/lib/lead-scoring/types";
import type { PriorityView } from "@/server/lead-scoring/priority";
import type { CrmScope } from "@/server/crm/page";

// How a lead's priority looks everywhere: a compact badge for lists, and the full explained card for a contact. A label is never shown by colour alone:
// each has its own word and icon, and "insufficient data" is visibly a different thing from "cold".

const TONE: Record<LeadLabel, "warning" | "primary" | "neutral" | "outline"> = { hot: "warning", warm: "primary", cold: "neutral", insufficient_data: "outline" };
const ICON: Record<LeadLabel, React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>> = { hot: Flame, warm: Sun, cold: Snowflake, insufficient_data: HelpCircle };

export function PriorityBadge({ label, score, source, className }: { label: LeadLabel | null; score?: number | null; source?: "engine" | "human" | null; className?: string }) {
  if (!label) return <span className="text-[12.5px] text-faint">Not scored</span>;
  const Icon = ICON[label];
  return (
    <Badge tone={TONE[label]} className={className} title={`${LEAD_LABEL_TEXT[label]}. ${LEAD_LABEL_HELP[label]}${source === "human" ? " Set by a teammate." : ""}`}>
      <Icon className="size-3.5" aria-hidden />
      {LEAD_LABEL_TEXT[label]}
      {score !== null && score !== undefined && <span className="tabular-nums opacity-80">{score}</span>}
      {source === "human" && <UserRound className="size-3 opacity-70" aria-label="Set by a teammate" />}
    </Badge>
  );
}

function Bar({ earned, max }: { earned: number; max: number }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (earned / max) * 100)) : 0;
  return (
    <span className="relative block h-1.5 w-full overflow-hidden rounded-full bg-surface-3" role="presentation">
      <span className="absolute inset-y-0 left-0 rounded-full bg-primary" style={{ width: `${pct}%` }} />
    </span>
  );
}

const sign = (n: number) => (n > 0 ? `+${n}` : String(n));

/** The explained priority of one contact: why, what is missing, what to do next, and the manual override. */
export function PriorityCard({ scope, contactId, view, canEdit }: { scope: CrmScope; contactId: string; view: PriorityView; canEdit: boolean }) {
  const { run, busy } = useCrmAction();
  const [showAll, setShowAll] = React.useState(false);
  const [setting, setSetting] = React.useState(false);
  const [form, setForm] = React.useState({ label: "hot" as "hot" | "warm" | "cold", reason: "", expires: "" });
  const a = view.assessment;
  const factors = a?.factors ?? [];
  const shown = showAll ? factors : factors.slice(0, 5);
  const missing = (a?.missing ?? []).filter((m) => m.dimension !== "completeness").slice(0, 5);
  const label = view.label;

  return (
    <SectionCard
      title="Lead priority"
      action={
        <Button size="sm" variant="ghost" loading={busy("rescore")} onClick={() => run("rescore", () => reassessLeadAction(scope.orgId, contactId), (o) => (o === "created" ? "Updated." : "Nothing has changed since the last check."))} aria-label="Check this lead again">
          <RefreshCw className="size-3.5" aria-hidden />Check again
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <PriorityBadge label={label} score={view.score} source={view.source} className="h-7 px-3 text-[13px]" />
          {view.evaluatedAt && <span className="text-[12px] text-muted">Checked <RelativeTime iso={view.evaluatedAt} timezone={scope.timezone} /></span>}
          {view.queued && <Badge tone="outline">Update queued</Badge>}
        </div>

        {label ? <p className="text-[13px] leading-relaxed text-ink-2">{view.reason}</p> : <p className="text-[13px] text-muted">This lead has not been assessed yet. It is checked automatically when something about it changes, or use Check again.</p>}
        {label && <p className="text-[12.5px] text-muted">{LEAD_LABEL_HELP[label]}</p>}

        {view.override && (
          <div className="rounded-xl border border-warning/30 bg-warning-soft px-3 py-2.5 text-[12.5px] text-warning-ink" role="note">
            <p className="font-medium">{view.override.setBy ?? "A teammate"} set this to {LEAD_LABEL_TEXT[view.override.label]}{view.override.expiresAt ? <> until <RelativeTime iso={view.override.expiresAt} timezone={scope.timezone} /></> : ""}.</p>
            <p className="mt-0.5">“{view.override.reason}”</p>
            {view.engineSays && <p className="mt-1">The scoring rules say {LEAD_LABEL_TEXT[view.engineSays.label]}{view.engineSays.score !== null ? ` (${view.engineSays.score})` : ""}. They keep checking, but never replace a teammate’s call.</p>}
            {canEdit && <Button size="sm" variant="secondary" className="mt-2" loading={busy("clear")} onClick={() => run("clear", () => clearPriorityOverrideAction(scope.orgId, contactId), "Back to automatic.")}>Return to automatic</Button>}
          </div>
        )}

        {a && (
          <>
            <div>
              <p className="mb-2 text-[12px] font-medium text-muted">What it is based on</p>
              <ul className="space-y-2">
                {DIMENSIONS.filter((d) => (a.dimensions[d]?.known ?? 0) + (a.dimensions[d]?.unknown ?? 0) > 0).map((d: Dimension) => {
                  const t = a.dimensions[d];
                  return (
                    <li key={d} title={DIMENSION_HELP[d]}>
                      <div className="mb-1 flex items-baseline justify-between gap-2 text-[12.5px]">
                        <span className="font-medium text-ink">{DIMENSION_TEXT[d]}</span>
                        <span className="tabular-nums text-muted">{t.known ? `${t.earned} of ${t.max}` : "nothing known yet"}</span>
                      </div>
                      <Bar earned={t.earned} max={t.max} />
                    </li>
                  );
                })}
              </ul>
            </div>

            <div>
              <p className="mb-2 text-[12px] font-medium text-muted">Why</p>
              <ul className="space-y-2">
                {shown.map((f) => (
                  <li key={f.key} className="flex items-start gap-2 text-[13px]">
                    <span className={cn("mt-0.5 w-9 shrink-0 text-right text-[12px] font-semibold tabular-nums", f.points > 0 ? "text-success-ink" : f.points < 0 ? "text-danger-ink" : "text-muted")}>{sign(f.points)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="font-medium text-ink">{f.label}</span>
                      {f.source === "ai" && <Badge tone="violet" className="ml-1.5 h-5 px-1.5 text-[12px]"><Sparkles className="size-3" aria-hidden />From their messages</Badge>}
                      <span className="block text-[12.5px] text-muted">{f.detail}{f.evidence.length ? ` · ${f.evidence.length} record${f.evidence.length === 1 ? "" : "s"}` : ""}</span>
                    </span>
                  </li>
                ))}
                {!factors.length && <li className="text-[12.5px] text-muted">Nothing on record yet that counts for or against.</li>}
              </ul>
              {factors.length > 5 && <button type="button" onClick={() => setShowAll((v) => !v)} className="mt-2 text-[12.5px] font-medium text-primary-ink hover:underline">{showAll ? "Show fewer" : `Show all ${factors.length}`}</button>}
            </div>

            {missing.length > 0 && (
              <div>
                <p className="mb-1.5 text-[12px] font-medium text-muted">Would help to know</p>
                <ul className="list-disc space-y-0.5 pl-5 text-[12.5px] text-ink-2">
                  {missing.map((m) => <li key={m.key}>{m.label}{m.hint ? <span className="text-muted"> — {m.hint}</span> : null}</li>)}
                </ul>
              </div>
            )}

            {a.nextAction?.label && (
              <p className="rounded-xl bg-surface-2 px-3 py-2 text-[13px]"><span className="font-medium text-ink">Suggested next step:</span> <span className="text-ink-2">{a.nextAction.label}</span></p>
            )}
            <p className="text-[12px] leading-relaxed text-faint">
              Scored by rules{a.aiPoints ? ` (${a.rulePoints} points) with signals read from their messages (${a.aiPoints} points)` : ""}. The language model never sets a score. Rules v{a.profileVersion}, engine {a.engineVersion}.
            </p>
          </>
        )}

        {view.recent.length > 1 && (
          <details className="text-[12.5px]">
            <summary className="cursor-pointer font-medium text-ink-2">Recent changes</summary>
            <ul className="mt-2 space-y-1">
              {view.recent.map((r, i) => (
                <li key={r.seq} className="flex items-center gap-2 text-muted">
                  <PriorityBadge label={r.label} score={r.score} className="h-5 px-2 text-[12px]" />
                  <RelativeTime iso={r.at} timezone={scope.timezone} />
                  {i === 0 && <span className="text-faint">· latest</span>}
                </li>
              ))}
            </ul>
          </details>
        )}

        {canEdit && !view.override && (
          setting ? (
            <form
              className="space-y-3 rounded-xl border border-line p-3"
              onSubmit={async (e) => {
                e.preventDefault();
                const ok = await run("override", () => setPriorityOverrideAction(scope.orgId, contactId, { label: form.label, reason: form.reason, expiresAt: form.expires ? new Date(`${form.expires}T23:59:00`).toISOString() : null }), "Priority set.");
                if (ok) { setSetting(false); setForm({ label: "hot", reason: "", expires: "" }); }
              }}
            >
              <Field label="Priority" htmlFor="po-label">
                <Select id="po-label" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value as typeof form.label })}>
                  <option value="hot">Hot</option><option value="warm">Warm</option><option value="cold">Cold</option>
                </Select>
              </Field>
              <Field label="Why" htmlFor="po-reason" hint="Kept with your name, so the team knows the reason.">
                <Textarea id="po-reason" required minLength={3} maxLength={300} rows={2} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
              </Field>
              <Field label="Until" htmlFor="po-until" optional hint="Leave empty to keep it until you change it.">
                <Input id="po-until" type="date" value={form.expires} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setForm({ ...form, expires: e.target.value })} />
              </Field>
              <div className="flex gap-2">
                <Button type="submit" size="sm" loading={busy("override")}>Set priority</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setSetting(false)}>Cancel</Button>
              </div>
            </form>
          ) : (
            <button type="button" onClick={() => setSetting(true)} className="inline-flex min-h-11 items-center text-[12.5px] font-medium text-primary-ink hover:underline sm:min-h-0">Set the priority yourself</button>
          )
        )}
      </div>
    </SectionCard>
  );
}
