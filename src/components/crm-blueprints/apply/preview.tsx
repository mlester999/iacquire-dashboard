"use client";

import * as React from "react";
import { AlertTriangle, ChevronDown, Info, Lock, Plug } from "lucide-react";
import { Badge, Card, Select } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import {
  ASSET_TYPE_LABELS, PLAN_ACTION_LABELS, REQUIREMENT_INFO, SECTION_LABELS, SLOT_KIND_LABELS,
  type ConflictDecision, type PlanAction, type PlanItem, type RequirementDetail,
} from "@/lib/crm/blueprints/types";
import type { ApplyPreview, SlotMappingView } from "@/lib/crm/blueprints/views";
import { DECISION_TEXT, canReplaceInPlace, countLines, groupPlan, type PlanSectionGroup } from "@/components/crm-blueprints/apply/plan-model";

// The dry run as the wizard shows it: counts per action, every item grouped by section with the reason, the record it matches, what
// differs and (for conflicts) the decision to take; the roles to map; what the client still needs afterwards.

export const ACTION_TONE: Record<PlanAction, "success" | "primary" | "neutral" | "outline" | "warning" | "danger"> = {
  create: "success", update: "primary", link: "neutral", unchanged: "neutral", skip: "outline", conflict: "warning", blocked: "danger",
};

export function ActionCounts({ counts, className }: { counts: Partial<Record<PlanAction, number>>; className?: string }) {
  const lines = countLines(counts);
  if (!lines.length) return <p className={cn("text-[13px] text-muted", className)}>Nothing to do.</p>;
  return (
    <ul className={cn("flex flex-wrap gap-1.5", className)} aria-label="Changes by kind">
      {lines.map((l) => <li key={l.action}><Badge tone={ACTION_TONE[l.action]}>{l.count} {l.label.toLowerCase()}</Badge></li>)}
    </ul>
  );
}

/** Every planned item, by section. Conflicts carry their decision select; changing one runs the dry run again. */
export function PlanGroups({ preview, decisions, onDecide, disabled }: {
  preview: ApplyPreview;
  decisions: Record<string, ConflictDecision>;
  onDecide: (assetId: string, d: ConflictDecision | null) => void;
  disabled: boolean;
}) {
  const groups = React.useMemo(() => groupPlan(preview.plan), [preview.plan]);
  if (!groups.length) return <Card className="p-5 text-[13px] text-muted">The chosen sections have nothing in this version.</Card>;
  return (
    <div className="space-y-3">
      {groups.map((g) => <SectionGroup key={g.section} group={g} decisions={decisions} onDecide={onDecide} disabled={disabled} />)}
    </div>
  );
}

function SectionGroup({ group, decisions, onDecide, disabled }: { group: PlanSectionGroup; decisions: Record<string, ConflictDecision>; onDecide: (assetId: string, d: ConflictDecision | null) => void; disabled: boolean }) {
  const attention = group.counts.conflict + group.counts.blocked;
  const [open, setOpen] = React.useState(attention > 0 || group.items.length <= 6);
  const id = `plan-${group.section}`;
  return (
    <Card className="overflow-hidden">
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)} className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left hover:bg-surface-2/60">
        <ChevronDown className={cn("size-4 shrink-0 text-muted transition-transform", open && "rotate-180")} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-semibold text-ink">{group.label}</span>
          <span className="block text-[12px] text-muted">{group.items.length} {group.items.length === 1 ? "item" : "items"}{group.undecided ? ` · ${group.undecided} waiting for a decision` : ""}</span>
        </span>
        <ActionCounts counts={group.counts} />
      </button>
      {open && (
        <ul id={id} className="divide-y divide-line border-t border-line">
          {group.items.map((item) => <PlanRow key={item.assetId} item={item} decision={decisions[item.assetId] ?? item.decision ?? null} onDecide={onDecide} disabled={disabled} />)}
        </ul>
      )}
    </Card>
  );
}

function PlanRow({ item, decision: chosen, onDecide, disabled }: { item: PlanItem; decision: ConflictDecision | null; onDecide: (assetId: string, d: ConflictDecision | null) => void; disabled: boolean }) {
  const nested = item.assetType === "stage" || item.assetType === "appointmentType";
  const selectId = `decide-${item.assetId}`;
  // A replacement the record can't take is never shown as chosen (the wizard also forgets it once the dry run comes back without it).
  const decision = chosen === "update" && !canReplaceInPlace(item) ? null : chosen;
  return (
    <li className={cn("space-y-2 px-4 py-3", nested && "pl-8 sm:pl-10")}>
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="break-words text-[13.5px] font-medium text-ink">{item.name} <span className="font-normal text-muted">· {ASSET_TYPE_LABELS[item.assetType]}</span></p>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted">{item.reason}</p>
        </div>
        <Badge tone={ACTION_TONE[item.action]}>{item.decision ? `Decided: ${DECISION_TEXT[item.decision].label.toLowerCase()}` : PLAN_ACTION_LABELS[item.action]}</Badge>
      </div>
      {item.existing && (
        <p className="text-[12.5px] text-ink-2">In the client&apos;s CRM: <span className="font-medium">“{item.existing.name}”</span></p>
      )}
      {item.changes.length > 0 && (
        <div className="rounded-xl bg-surface-2 px-3 py-2">
          <p className="text-[12px] font-semibold text-ink-2">{item.action === "update" || item.action === "conflict" ? "What differs" : "Details"}</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[12.5px] text-ink-2">
            {item.changes.slice(0, 12).map((c, i) => <li key={i} className="break-words">{c}</li>)}
            {item.changes.length > 12 && <li className="list-none text-muted">and {item.changes.length - 12} more</li>}
          </ul>
        </div>
      )}
      {item.unresolved.length > 0 && (
        <p className="flex gap-1.5 text-[12.5px] text-warning-ink"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />Not resolved in this workspace: {item.unresolved.slice(0, 5).join(", ")}{item.unresolved.length > 5 ? ` and ${item.unresolved.length - 5} more` : ""}</p>
      )}
      {/* A decided conflict comes back as what was decided (skip, create, update) with its decision, so it keeps its select to change it. */}
      {(item.action === "conflict" || item.decision) && (
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={selectId} className="text-[12.5px] font-medium text-ink-2">Decision</label>
          <div className="min-w-[16rem] flex-1 sm:flex-none">
            <Select id={selectId} value={decision ?? ""} disabled={disabled} onChange={(e) => onDecide(item.assetId, (e.target.value || null) as ConflictDecision | null)}>
              <option value="">Decide later (left untouched)</option>
              {/* "Use the Blueprint's version" only where the record can be replaced in place (not a field whose type would change, say). */}
              {(Object.keys(DECISION_TEXT) as ConflictDecision[]).filter((d) => d !== "update" || canReplaceInPlace(item)).map((d) => <option key={d} value={d}>{DECISION_TEXT[d].label}</option>)}
            </Select>
          </div>
          {decision && <span className="text-[12px] text-muted">{DECISION_TEXT[decision].description}</span>}
        </div>
      )}
    </li>
  );
}

/** Roles the applied assets use, each mapped to one of the client's own people or connections (or left for the client). */
export function SlotMappings({ slots, value, onChange, disabled }: { slots: SlotMappingView[]; value: Record<string, string>; onChange: (slotId: string, target: string | null) => void; disabled: boolean }) {
  const used = slots.filter((s) => s.usedBy.length);
  if (!used.length) return null;
  return (
    <Card className="space-y-3 p-4">
      <div>
        <h3 className="text-[14px] font-semibold text-ink">Roles to map</h3>
        <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted">The Blueprint names roles, never people. Map them to this client&apos;s own people and connections now, or leave them: the client&apos;s setup checklist then asks for them.</p>
      </div>
      <ul className="space-y-3">
        {used.map((s) => {
          const id = `slot-${s.slotId}`;
          const chosen = value[s.slotId] ?? "";
          return (
            <li key={s.slotId} className="grid gap-2 rounded-xl border border-line p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,16rem)] sm:items-center">
              <div className="min-w-0">
                <label htmlFor={id} className="text-[13px] font-medium text-ink">{s.label} <span className="font-normal text-muted">· {SLOT_KIND_LABELS[s.kind].label}</span></label>
                <p className="text-[12px] text-muted">Used by {s.usedBy.slice(0, 3).map((u) => u.name).join(", ")}{s.usedBy.length > 3 ? ` and ${s.usedBy.length - 3} more` : ""}</p>
              </div>
              {s.candidates.length ? (
                <Select id={id} value={chosen} disabled={disabled} onChange={(e) => onChange(s.slotId, e.target.value || null)}>
                  <option value="">Leave for the client</option>
                  {s.candidates.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              ) : (
                <p className="flex gap-1.5 text-[12.5px] text-muted"><Plug className="mt-0.5 size-3.5 shrink-0" aria-hidden />{s.kind === "member" ? "Nobody in this workspace can take it yet." : s.kind === "n8n" ? "No verified n8n automation for this client yet." : "No active webhook endpoint in this workspace yet."}</p>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/** "After applying, this client still needs…": every requirement with what it is about, in plain words. Never marked done here. */
export function StillNeeds({ details, items }: { details: RequirementDetail[]; items: PlanItem[] }) {
  if (!details.length) return null;
  const names = new Map(items.map((i) => [i.assetId, i.name]));
  return (
    <Card className="space-y-3 p-4">
      <div>
        <h3 className="text-[14px] font-semibold text-ink">After applying, this client still needs…</h3>
        <p className="mt-0.5 text-[12.5px] text-muted">Applying never connects, maps or approves anything. Each of these appears on the client&apos;s setup checklist until there is evidence it is done.</p>
      </div>
      <ul className="space-y-2">
        {details.map((d) => {
          const info = REQUIREMENT_INFO[d.key];
          const about = d.assetIds.map((id) => names.get(id)).filter((x): x is string => !!x);
          return (
            <li key={d.key} className="rounded-xl border border-line px-3 py-2.5">
              <p className="text-[13px] font-medium text-ink">{info.label}</p>
              <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted">{info.description}</p>
              {about.length > 0 && <p className="mt-1 text-[12px] text-ink-2">For {about.slice(0, 4).join(", ")}{about.length > 4 ? ` and ${about.length - 4} more` : ""}.</p>}
              {d.notes.map((n, i) => <p key={i} className="mt-1 text-[12px] text-muted">{n}</p>)}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

export function PlanWarnings({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null;
  return (
    <Card className="space-y-2 border-warning/30 p-4">
      <h3 className="flex items-center gap-2 text-[14px] font-semibold text-warning-ink"><AlertTriangle className="size-4" aria-hidden />Worth knowing</h3>
      <ul className="list-disc space-y-1 pl-5 text-[12.5px] leading-relaxed text-ink-2">{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
    </Card>
  );
}

export function BlockedSections({ preview }: { preview: ApplyPreview }) {
  const blocked = preview.workspace.blockedSections;
  if (!blocked.length && preview.workspace.mode !== "hybrid") return null;
  return (
    <p className="flex gap-2 rounded-2xl border border-line bg-surface-2 px-4 py-3 text-[12.5px] leading-relaxed text-ink-2">
      <Lock className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
      <span>
        This client&apos;s CRM is hybrid.{" "}
        {blocked.length ? <>These sections are left alone because GoHighLevel manages them: {blocked.map((b) => SECTION_LABELS[b.section]).join(", ")}.</> : "Every chosen section is managed in iAcquire, so it can be applied."}
      </span>
    </p>
  );
}

export function PreviewNote({ children }: { children: React.ReactNode }) {
  return <p className="flex gap-2 text-[12.5px] leading-relaxed text-muted"><Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />{children}</p>;
}
