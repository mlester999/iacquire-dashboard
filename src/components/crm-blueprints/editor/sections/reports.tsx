"use client";

import * as React from "react";
import { Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { CHANNEL_LABELS, RANGE_LABELS, RANGE_PRESETS, REPORT_CHANNELS, REPORT_SECTIONS, SECTION_INFO, type RangePreset, type ReportChannel, type ReportSection } from "@/components/crm/reports/spec";
import { CREATED_VIA, CREATED_VIA_LABELS, type CreatedVia } from "@/lib/crm/types";
import { FORM_KEY_RE } from "@/lib/crm/forms/spec";
import { toRef, type ReportAsset } from "@/lib/crm/blueprints/types";
import { keysIn, updateAsset } from "@/components/crm-blueprints/editor/model";
import { AssetWorkspace, DetailCard, DetailHeader, FieldGrid, FolderSelect, IssueNotes, SectionNote, SlotSelect, issuesOf, orNull, useAdder, useEditor } from "@/components/crm-blueprints/editor/parts";
import { KeyInput } from "@/components/crm-blueprints/editor/inputs";

export function ReportsSection() {
  const { content, remove, issues } = useEditor();
  const add = useAdder("reports");
  const items = content.assets.reports.map((r) => ({ id: r.id, name: r.name, detail: r.config.sections.map((s) => SECTION_INFO[s]?.label ?? s).join(", ") }));
  return (
    <>
      <AssetWorkspace
        section="reports"
        title="Report definitions"
        intro="Saved reports a client's team starts with. They are shared with the team, and every number comes from that client's own data."
        items={items}
        addLabel="Add report"
        onAdd={add.open}
        emptyText="Add the reports this kind of business reviews each week or month."
      >
        {(id) => {
          const r = content.assets.reports.find((x) => x.id === id)!;
          return (
            <DetailCard>
              <DetailHeader id={r.id} title={r.name} kind="Report" onRemove={() => remove(r.id, r.name)} />
              <IssueNotes issues={issuesOf(issues, r.id)} />
              <ReportForm key={r.id} report={r} />
            </DetailCard>
          );
        }}
      </AssetWorkspace>
      {add.dialog}
    </>
  );
}

function ReportForm({ report: r }: { report: ReportAsset }) {
  const { content, edit, readOnly } = useEditor();
  const set = (patch: Partial<ReportAsset>) => edit((c) => updateAsset(c, "reports", r.id, (x) => ({ ...x, ...patch })));
  const setFilters = (patch: Partial<ReportAsset["config"]["filters"]>) => {
    const filters = { ...r.config.filters, ...patch } as Record<string, unknown>;
    for (const k of Object.keys(filters)) if (filters[k] === undefined || filters[k] === "") delete filters[k];
    set({ config: { ...r.config, filters: filters as ReportAsset["config"]["filters"] } });
  };
  const toggleSection = (s: ReportSection, on: boolean) => {
    const next = on ? REPORT_SECTIONS.filter((x) => x === s || r.config.sections.includes(x)) : r.config.sections.filter((x) => x !== s);
    set({ config: { ...r.config, sections: next } });
  };
  const taken = keysIn(content, "reports").filter((k) => k !== r.key);
  const f = r.config.filters;
  return (
    <div className="space-y-4">
      <FieldGrid>
        <Field label="Name" htmlFor="rp-name"><Input id="rp-name" value={r.name} maxLength={80} disabled={readOnly} onChange={(e) => set({ name: e.target.value })} /></Field>
        <Field label="Key" htmlFor="rp-key" hint="How a client's CRM recognises this report when the Blueprint is applied again.">
          <KeyInput id="rp-key" value={r.key} pattern={FORM_KEY_RE} taken={taken} disabled={readOnly} invalidText="Lower-case letters, numbers and hyphens inside (48 at most)." onCommit={(key) => set({ key })} />
        </Field>
        <FolderSelect id="rp-folder" kind="report" value={r.folder} onChange={(folder) => set({ folder })} />
      </FieldGrid>
      <Field label="Description" htmlFor="rp-desc" optional><Textarea id="rp-desc" rows={2} maxLength={300} value={r.description ?? ""} disabled={readOnly} onChange={(e) => set({ description: orNull(e.target.value) })} /></Field>
      <fieldset className="space-y-2">
        <legend className="text-[13px] font-medium text-ink-2">Sections</legend>
        {!r.config.sections.length && <p className="text-[12.5px] text-danger-ink" role="status">Pick at least one section.</p>}
        <div className="grid gap-2 sm:grid-cols-2">
          {REPORT_SECTIONS.map((s) => (
            <label key={s} className="flex min-h-11 cursor-pointer items-start gap-2.5 rounded-xl border border-line px-3 py-2.5 has-[:checked]:border-primary/40 has-[:checked]:bg-primary-soft/40">
              <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-primary" checked={r.config.sections.includes(s)} disabled={readOnly} onChange={(e) => toggleSection(s, e.target.checked)} />
              <span className="min-w-0">
                <span className="block text-[13px] font-medium text-ink">{SECTION_INFO[s].label}</span>
                <span className="block text-[12px] leading-relaxed text-muted">{SECTION_INFO[s].description}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <SectionNote>Filters a section doesn&apos;t use are named on that section in the client&apos;s report. A team member filter is a role each client maps to one of its own people.</SectionNote>
      <FieldGrid>
        <Field label="Period" htmlFor="rp-range">
          <Select id="rp-range" value={f.range} disabled={readOnly} onChange={(e) => {
            const range = e.target.value as RangePreset;
            setFilters(range === "custom" ? { range } : { range, from: undefined, to: undefined });
          }}>
            {RANGE_PRESETS.map((p) => <option key={p} value={p}>{RANGE_LABELS[p]}</option>)}
          </Select>
        </Field>
        {f.range === "custom" && (
          <div className="grid grid-cols-2 gap-2">
            <Field label="From" htmlFor="rp-from"><Input id="rp-from" type="date" value={f.from ?? ""} disabled={readOnly} onChange={(e) => setFilters({ from: e.target.value || undefined })} /></Field>
            <Field label="To" htmlFor="rp-to"><Input id="rp-to" type="date" value={f.to ?? ""} disabled={readOnly} onChange={(e) => setFilters({ to: e.target.value || undefined })} /></Field>
          </div>
        )}
        <SlotSelect id="rp-member" kind="member" label="Team member" value={f.member ?? null} noneLabel="Everyone" onChange={(member) => setFilters({ member: member ?? undefined })} />
        <Field label="Lead source" htmlFor="rp-source" optional>
          <Select id="rp-source" value={f.source ?? ""} disabled={readOnly} onChange={(e) => setFilters({ source: (e.target.value || undefined) as CreatedVia | undefined })}>
            <option value="">Every source</option>
            {CREATED_VIA.map((v) => <option key={v} value={v}>{CREATED_VIA_LABELS[v]}</option>)}
          </Select>
        </Field>
        <Field label="Pipeline" htmlFor="rp-pipeline" optional>
          <Select id="rp-pipeline" value={f.pipeline ?? ""} disabled={readOnly} onChange={(e) => setFilters({ pipeline: e.target.value || undefined })}>
            <option value="">Every pipeline</option>
            {content.assets.pipelines.map((p) => <option key={p.id} value={toRef(p.id)}>{p.name}</option>)}
            {f.pipeline && !content.assets.pipelines.some((p) => toRef(p.id) === f.pipeline) && <option value={f.pipeline}>{f.pipeline} (not in this Blueprint)</option>}
          </Select>
        </Field>
        <Field label="Channel" htmlFor="rp-channel" optional>
          <Select id="rp-channel" value={f.channel ?? ""} disabled={readOnly} onChange={(e) => setFilters({ channel: (e.target.value || undefined) as ReportChannel | undefined })}>
            <option value="">Every channel</option>
            {REPORT_CHANNELS.map((c) => <option key={c} value={c}>{CHANNEL_LABELS[c]}</option>)}
          </Select>
        </Field>
      </FieldGrid>
    </div>
  );
}
