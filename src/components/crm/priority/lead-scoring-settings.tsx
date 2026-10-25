"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Badge, Field, Input, Select } from "@/components/ui/primitives";
import { SectionCard } from "@/components/crm/record-panels";
import { PageTitle, ReadOnlyNotice, useCrmAction } from "@/components/crm/ui";
import { backfillLeadScoresAction, saveScoringProfileAction } from "@/app/actions/lead-scoring";
import { PRESET_KEYS, PRESET_TEXT, type CriterionOverride, type PresetKey } from "@/lib/lead-scoring/criteria";
import { DIMENSION_TEXT, LEAD_LABELS, LEAD_LABEL_HELP, LEAD_LABEL_TEXT, type Dimension, type LeadLabel } from "@/lib/lead-scoring/types";
import { PriorityBadge } from "@/components/crm/priority/priority-ui";
import type { CriterionView, ScoringProfile } from "@/server/lead-scoring/profile";
import type { ScoringStats } from "@/server/lead-scoring/priority";
import type { CrmScope } from "@/server/crm/page";

// Settings → Lead Scoring. The score is made by rules from what the lead did and what the workspace recorded; a language model may only read a
// customer's own messages for a closed set of signals (and only if switched on here). Nothing about who a person is can be used.

const list = (v: unknown) => (Array.isArray(v) ? (v as string[]).join(", ") : "");
const toList = (s: string) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean).slice(0, 50);

interface ParamField { key: string; label: string; kind: "list" | "number"; hint?: string }
const PARAMS: Record<string, ParamField[]> = {
  service_area: [
    { key: "cities", label: "Cities", kind: "list" }, { key: "regions", label: "Regions or states", kind: "list" }, { key: "countries", label: "Country codes", kind: "list", hint: "For example US, PH" },
    { key: "postalPrefixes", label: "Postal code starts with", kind: "list" },
  ],
  source_quality: [{ key: "high", label: "Best sources", kind: "list", hint: "As written in the lead source, for example referral" }, { key: "low", label: "Weakest sources", kind: "list" }],
  tag_signal: [{ key: "positive", label: "Tags that help", kind: "list" }, { key: "negative", label: "Tags that count against", kind: "list" }],
  deal_value: [{ key: "minValue", label: "Smallest deal you want", kind: "number" }, { key: "targetValue", label: "Your target deal size", kind: "number" }],
};

export function LeadScoringSettings({ scope, profile, criteria, fields, stats, canConfigure }: {
  scope: CrmScope;
  profile: ScoringProfile;
  criteria: CriterionView[];
  fields: Array<{ key: string; label: string; usable: boolean }>;
  stats: ScoringStats;
  canConfigure: boolean;
}) {
  const { run, busy } = useCrmAction();
  const [enabled, setEnabled] = React.useState(profile.enabled);
  const [preset, setPreset] = React.useState<PresetKey>(profile.preset);
  const [hot, setHot] = React.useState(profile.hotMin);
  const [warm, setWarm] = React.useState(profile.warmMin);
  const [minSignals, setMinSignals] = React.useState(profile.minSignals);
  const [ai, setAi] = React.useState(profile.aiExtractionEnabled);
  const [aiLimit, setAiLimit] = React.useState(profile.aiDailyLimit);
  const [over, setOver] = React.useState<Record<string, CriterionOverride>>(profile.criteria);
  const [version, setVersion] = React.useState(profile.version);
  const disabled = !canConfigure;
  const problem = warm >= hot ? "Hot must start above where Warm starts." : null;

  const criterion = (c: CriterionView) => {
    const o = over[c.key] ?? {};
    const enabledNow = o.enabled ?? c.enabled;
    return { enabled: enabledNow, weight: o.weight ?? c.weight, params: { ...c.params, ...(o.params ?? {}) } };
  };
  const patch = (key: string, next: CriterionOverride) => setOver((cur) => ({ ...cur, [key]: { ...(cur[key] ?? {}), ...next } }));

  const save = async () => {
    const out = await run("save", () => saveScoringProfileAction(scope.orgId, { expectedVersion: version, enabled, preset, criteria: over, hotMin: hot, warmMin: warm, minSignals, aiExtractionEnabled: ai, aiDailyLimit: aiLimit }), "Saved. Scores will update shortly.");
    if (out) setVersion(out.version);
  };

  const grouped = (["intent", "engagement", "urgency", "fit", "completeness"] as Dimension[]).map((d) => [d, criteria.filter((c) => c.dimension === d)] as const).filter(([, list]) => list.length);

  return (
    <div className="space-y-5">
      <PageTitle title="Lead scoring" description="Every lead gets a Hot, Warm or Cold label with the reasons behind it. Rules make the score from what the lead did and what you have recorded. Nothing about who a person is can be used." />
      {scope.readOnly && <ReadOnlyNotice />}
      {!canConfigure && !scope.readOnly && <p className="rounded-xl bg-surface-2 px-3 py-2 text-[13px] text-muted" role="note">Only a workspace owner or manager can change how leads are scored.</p>}

      <SectionCard title="Where it stands">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div><p className="text-[12px] text-muted">Contacts</p><p className="text-[20px] font-semibold tabular-nums text-ink">{stats.contacts}</p></div>
          <div><p className="text-[12px] text-muted">Assessed</p><p className="text-[20px] font-semibold tabular-nums text-ink">{stats.scored}</p></div>
          <div><p className="text-[12px] text-muted">Waiting to be checked</p><p className="text-[20px] font-semibold tabular-nums text-ink">{stats.queued}</p></div>
          <div><p className="text-[12px] text-muted">Set by hand</p><p className="text-[20px] font-semibold tabular-nums text-ink">{stats.overridden}</p></div>
        </div>
        <ul className="mt-4 flex flex-wrap gap-2" aria-label="Leads by label">
          {LEAD_LABELS.map((l: LeadLabel) => <li key={l} title={LEAD_LABEL_HELP[l]}><PriorityBadge label={l} className="h-7 px-3 text-[14px]" /><span className="sr-only">{LEAD_LABEL_TEXT[l]}</span> <span className="ml-1 text-[14px] tabular-nums text-ink">{stats.byLabel[l]}</span></li>)}
        </ul>
        <p className="mt-3 text-[13px] text-muted">
          {stats.changedLast7Days} label change{stats.changedLast7Days === 1 ? "" : "s"} and {stats.becameHotLast7Days} lead{stats.becameHotLast7Days === 1 ? "" : "s"} turned hot in the last 7 days.
          {stats.ai.callsToday > 0 && ` Today the model read messages ${stats.ai.callsToday} time${stats.ai.callsToday === 1 ? "" : "s"} (about ${stats.ai.estimatedInputTokens + stats.ai.estimatedOutputTokens} tokens, estimated).`}
        </p>
        {canConfigure && stats.scored < stats.contacts && (
          <div className="mt-3"><Button size="sm" variant="secondary" loading={busy("backfill")} onClick={() => run("backfill", () => backfillLeadScoresAction(scope.orgId), (r) => `${r.queued} contact${r.queued === 1 ? "" : "s"} queued to be scored.`)}>Score contacts that have not been assessed</Button></div>
        )}
      </SectionCard>

      <SectionCard title="How leads are scored">
        <div className="space-y-4">
          <label className="flex min-h-11 items-start gap-3 text-[14px] sm:min-h-0">
            <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]" checked={enabled} disabled={disabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span><span className="font-medium text-ink">Score leads automatically</span><span className="block text-[13px] text-muted">When something about a lead changes, they are checked again after a short pause. Turn this off to stop.</span></span>
          </label>
          <Field label="Start from" htmlFor="ls-preset" hint={PRESET_TEXT[preset].help}>
            <Select id="ls-preset" value={preset} disabled={disabled} onChange={(e) => setPreset(e.target.value as PresetKey)}>
              {PRESET_KEYS.map((k) => <option key={k} value={k}>{PRESET_TEXT[k].label}</option>)}
            </Select>
          </Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Hot starts at" htmlFor="ls-hot"><Input id="ls-hot" type="number" min={2} max={100} value={hot} disabled={disabled} onChange={(e) => setHot(Number(e.target.value))} /></Field>
            <Field label="Warm starts at" htmlFor="ls-warm"><Input id="ls-warm" type="number" min={1} max={99} value={warm} disabled={disabled} onChange={(e) => setWarm(Number(e.target.value))} /></Field>
            <Field label="Signals needed to score" htmlFor="ls-min" hint="Fewer than this and the lead shows Insufficient data, never Cold."><Input id="ls-min" type="number" min={1} max={10} value={minSignals} disabled={disabled} onChange={(e) => setMinSignals(Number(e.target.value))} /></Field>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="What counts">
        <div className="space-y-5">
          {grouped.map(([dim, items]) => (
            <fieldset key={dim} className="space-y-3" disabled={disabled}>
              <legend className="mb-1 text-[13px] font-semibold text-ink">{DIMENSION_TEXT[dim]}</legend>
              {items.map((c) => {
                const v = criterion(c);
                return (
                  <div key={c.key} className="rounded-xl border border-line p-3">
                    <div className="flex flex-wrap items-center gap-3">
                      <label className="flex min-h-11 flex-1 items-center gap-3 text-[14px] sm:min-h-0">
                        <input type="checkbox" className="size-4 shrink-0 accent-[var(--primary)]" checked={v.enabled} onChange={(e) => patch(c.key, { enabled: e.target.checked })} />
                        <span className="min-w-0"><span className="font-medium text-ink">{c.label}</span>
                          {c.kind === "penalty" && <Badge tone="outline" className="ml-2">Counts against</Badge>}
                          {c.source === "ai" && <Badge tone="violet" className="ml-2">From messages</Badge>}
                          {c.fieldMissing && <Badge tone="warning" className="ml-2">Field not created yet</Badge>}
                        </span>
                      </label>
                      <label className="flex items-center gap-2 text-[13px] text-muted">Points
                        <Input aria-label={`Points for ${c.label}`} className="h-9 w-20" type="number" min={0} max={25} value={v.weight} onChange={(e) => patch(c.key, { weight: Number(e.target.value) })} />
                      </label>
                    </div>
                    {v.enabled && PARAMS[c.key] && (
                      <div className="mt-3 grid gap-3 sm:grid-cols-2">
                        {PARAMS[c.key].map((p) => (
                          <Field key={p.key} label={p.label} htmlFor={`ls-${c.key}-${p.key}`} hint={p.hint}>
                            {p.kind === "list"
                              ? <Input id={`ls-${c.key}-${p.key}`} defaultValue={list(v.params[p.key])} onBlur={(e) => patch(c.key, { params: { ...v.params, [p.key]: toList(e.target.value) } as never })} placeholder="Separate with commas" />
                              : <Input id={`ls-${c.key}-${p.key}`} type="number" min={0} defaultValue={typeof v.params[p.key] === "number" ? (v.params[p.key] as number) : ""} onBlur={(e) => patch(c.key, { params: { ...v.params, [p.key]: e.target.value === "" ? undefined : Number(e.target.value) } as never })} />}
                          </Field>
                        ))}
                      </div>
                    )}
                    {v.enabled && c.key.startsWith("field:") && (
                      <div className="mt-3 grid gap-3 sm:grid-cols-2">
                        <Field label="Counts when the field" htmlFor={`ls-${c.key}-op`}>
                          <Select id={`ls-${c.key}-op`} value={String(v.params.op ?? "present")} onChange={(e) => patch(c.key, { params: { ...v.params, op: e.target.value } as never })}>
                            <option value="present">Is filled in</option><option value="eq">Equals</option><option value="in">Is one of</option><option value="gte">Is at least</option><option value="lte">Is at most</option>
                          </Select>
                        </Field>
                        {String(v.params.op ?? "present") !== "present" && (
                          <Field label={String(v.params.op) === "in" ? "Values (comma separated)" : "Value"} htmlFor={`ls-${c.key}-val`}>
                            <Input id={`ls-${c.key}-val`} defaultValue={String(v.params.op) === "in" ? list(v.params.values) : String(v.params.value ?? "")}
                              onBlur={(e) => patch(c.key, { params: String(v.params.op) === "in" ? { ...v.params, values: toList(e.target.value) } : { ...v.params, value: e.target.value } } as never)} />
                          </Field>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </fieldset>
          ))}
          <p className="text-[13px] text-muted">
            Your own contact fields: {fields.filter((f) => f.usable).length ? fields.filter((f) => f.usable).map((f) => f.label).join(", ") : "none yet"}.
            {fields.some((f) => !f.usable) && " Fields about who a person is (such as age or gender) are not offered and can never be used."}
          </p>
        </div>
      </SectionCard>

      <SectionCard title="Reading their messages (optional)">
        <div className="space-y-3">
          <label className="flex min-h-11 items-start gap-3 text-[14px] sm:min-h-0">
            <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]" checked={ai} disabled={disabled} onChange={(e) => setAi(e.target.checked)} />
            <span><span className="font-medium text-ink">Let a language model read a customer’s recent messages for signals</span>
              <span className="block text-[13px] text-muted">It fills in a short fixed form: what they want, when, and whether they asked for a quote or a visit. It sees only the message text with phone numbers and emails removed, never their name or record, and never sets a score: your rules turn its answers into points. Every answer must point to a message or it is ignored. Off by default.</span></span>
          </label>
          {ai && <Field label="Most reads per day" htmlFor="ls-ailimit" hint="A hard stop for the whole workspace."><Input id="ls-ailimit" type="number" min={0} max={5000} value={aiLimit} disabled={disabled} onChange={(e) => setAiLimit(Number(e.target.value))} /></Field>}
        </div>
      </SectionCard>

      {problem && canConfigure && <p className="rounded-xl border border-danger/30 bg-danger-soft px-4 py-3 text-[13px] text-danger-ink" role="alert">{problem}</p>}
      {canConfigure && <div className="sticky bottom-0 -mx-1 flex items-center gap-3 border-t border-line bg-bg/90 px-1 py-3 backdrop-blur"><Button loading={busy("save")} disabled={Boolean(problem)} onClick={save}>Save</Button></div>}
    </div>
  );
}
