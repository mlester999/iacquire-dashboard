// Comparing two versions of a Blueprint, asset by asset (matched by logical ID), with field-level change descriptions: version comparison,
// change summaries on publish, and the update review for workspaces that applied an earlier version. Nested things are compared one by one
// (stages of a pipeline, appointment types of a calendar, questions of a form by answer key, steps of a workflow by step key), so a summary
// says "stage added: Proposal" rather than "stages changed". Pure.
import { sameJson } from "@/lib/crm/blueprints/canonical";
import {
  ASSET_SECTIONS, SECTION_LABELS,
  type AssetSection, type BlueprintContent, type CalendarAsset, type FormAsset, type PipelineAsset, type WorkflowAsset,
} from "@/lib/crm/blueprints/types";

export interface AssetChange {
  id: string;
  name: string;
  section: AssetSection;
  kind: "added" | "removed" | "changed";
  /** "label", "options", "stage added: Proposal", "step changed: welcome (config)" … */
  fields: string[];
}

export interface BlueprintDiff {
  changes: AssetChange[];
  bySection: Record<AssetSection, { added: number; removed: number; changed: number }>;
  /** "blueprint.name", "settings.defaultCurrency", "slot added: member.closer" … */
  metaChanged: string[];
  /** One line per section with changes, for change summaries. */
  summary: string[];
  /** Nothing differs. */
  empty: boolean;
}

const nameOf = (a: { name?: string; label?: string; key?: string; id: string }) => a.name ?? a.label ?? a.key ?? a.id;

/** Top-level fields that differ between two versions of one object, ignoring `skip` (compared separately). */
export function changedFields(before: Record<string, unknown>, after: Record<string, unknown>, skip: readonly string[] = []): string[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => k !== "id" && !skip.includes(k));
  return keys.filter((k) => !sameJson(before[k], after[k])).sort();
}

/** Added, removed, changed and reordered members of a nested list, matched by `keyOf`. */
function nestedChanges<T>(before: readonly T[], after: readonly T[], keyOf: (x: T) => string, label: (x: T) => string, what: string): string[] {
  const out: string[] = [];
  const b = new Map(before.map((x) => [keyOf(x), x]));
  const a = new Map(after.map((x) => [keyOf(x), x]));
  for (const x of after) if (!b.has(keyOf(x))) out.push(`${what} added: ${label(x)}`);
  for (const x of before) if (!a.has(keyOf(x))) out.push(`${what} removed: ${label(x)}`);
  for (const x of after) {
    const old = b.get(keyOf(x));
    if (old !== undefined && !sameJson(old, x)) out.push(`${what} changed: ${label(x)} (${changedFields(old as Record<string, unknown>, x as Record<string, unknown>).join(", ")})`);
  }
  const order = (xs: readonly T[]) => xs.map(keyOf).filter((k) => a.has(k) && b.has(k)).join("\u0000");
  if (order(before) !== order(after)) out.push(`${what}s reordered`);
  return out;
}

/** Field-level differences between two versions of one asset of a section. */
export function diffAsset(section: AssetSection, before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  switch (section) {
    case "pipelines": {
      const [b, a] = [before as unknown as PipelineAsset, after as unknown as PipelineAsset];
      return [...changedFields(before, after, ["stages"]), ...nestedChanges(b.stages, a.stages, (s) => s.id, (s) => s.name, "stage")];
    }
    case "calendars": {
      const [b, a] = [before as unknown as CalendarAsset, after as unknown as CalendarAsset];
      return [...changedFields(before, after, ["types"]), ...nestedChanges(b.types, a.types, (t) => t.id, (t) => t.name, "appointment type")];
    }
    case "forms": {
      const [b, a] = [before as unknown as FormAsset, after as unknown as FormAsset];
      const draft = changedFields(b.draft as unknown as Record<string, unknown>, a.draft as unknown as Record<string, unknown>, ["questions"]).map((f) => `draft.${f}`);
      return [...changedFields(before, after, ["draft"]), ...draft, ...nestedChanges(b.draft.questions, a.draft.questions, (q) => q.key, (q) => q.label || q.key, "question")];
    }
    case "workflows": {
      const [b, a] = [before as unknown as WorkflowAsset, after as unknown as WorkflowAsset];
      const trigger = sameJson(b.definition.trigger, a.definition.trigger) ? [] : ["trigger"];
      return [...changedFields(before, after, ["definition"]), ...trigger, ...nestedChanges(b.definition.steps, a.definition.steps, (s) => s.key, (s) => s.name || s.key, "step")];
    }
    default:
      return changedFields(before, after);
  }
}

export function diffContents(before: Pick<BlueprintContent, "blueprint" | "settings" | "slots" | "assets">, after: Pick<BlueprintContent, "blueprint" | "settings" | "slots" | "assets">): BlueprintDiff {
  const changes: AssetChange[] = [];
  const bySection = Object.fromEntries(ASSET_SECTIONS.map((s) => [s, { added: 0, removed: 0, changed: 0 }])) as BlueprintDiff["bySection"];
  for (const section of ASSET_SECTIONS) {
    const b = new Map((before.assets[section] as Array<{ id: string }>).map((x) => [x.id, x]));
    const a = new Map((after.assets[section] as Array<{ id: string }>).map((x) => [x.id, x]));
    for (const [id, x] of a) {
      const old = b.get(id);
      if (!old) {
        changes.push({ id, name: nameOf(x), section, kind: "added", fields: [] });
        bySection[section].added++;
      } else if (!sameJson(old, x)) {
        changes.push({ id, name: nameOf(x), section, kind: "changed", fields: diffAsset(section, old as Record<string, unknown>, x as Record<string, unknown>) });
        bySection[section].changed++;
      }
    }
    for (const [id, x] of b) {
      if (!a.has(id)) {
        changes.push({ id, name: nameOf(x), section, kind: "removed", fields: [] });
        bySection[section].removed++;
      }
    }
  }
  const metaChanged = [
    ...changedFields(before.blueprint as unknown as Record<string, unknown>, after.blueprint as unknown as Record<string, unknown>).map((f) => `blueprint.${f}`),
    ...changedFields(before.settings as unknown as Record<string, unknown>, after.settings as unknown as Record<string, unknown>).map((f) => `settings.${f}`),
    ...nestedChanges(before.slots ?? [], after.slots ?? [], (s) => s.id, (s) => s.id, "slot"),
  ];
  const summary = ASSET_SECTIONS.flatMap((s) => {
    const c = bySection[s];
    const parts = [c.added && `${c.added} added`, c.changed && `${c.changed} changed`, c.removed && `${c.removed} removed`].filter(Boolean);
    return parts.length ? [`${SECTION_LABELS[s]}: ${parts.join(", ")}`] : [];
  });
  if (metaChanged.length) summary.unshift(`Details: ${metaChanged.join(", ")}`);
  return { changes, bySection, metaChanged, summary, empty: !changes.length && !metaChanged.length };
}

/**
 * Changes to a pipeline or calendar that applying never makes in a workspace that already has it: its stages or appointment types are
 * never reordered or removed there (a matched pipeline keeps its own order, and nothing is deleted by applying).
 */
const IGNORED_ON_APPLY = /^(stages reordered|appointment types reordered|stage removed: |appointment type removed: )/;

/**
 * The sections a diff touches that an update would change: an update review lets the agency pick these one by one (templates without the
 * customized pipeline). A pipeline or calendar whose only change is a reorder or removal of its stages or types doesn't count, since
 * applying never makes those changes (the comparison itself still lists them).
 */
export function changedSections(diff: BlueprintDiff): AssetSection[] {
  return ASSET_SECTIONS.filter((s) => diff.changes.some((c) => c.section === s
    && (c.kind !== "changed" || (s !== "pipelines" && s !== "calendars") || c.fields.some((f) => !IGNORED_ON_APPLY.test(f)))));
}
