// Compatibility reports: the honest, item-by-item account of what an import, a capture or a package produced. Shared by GoHighLevel imports,
// package imports, captures and starters, so every source is summarized the same way. Pure.
//
// The one rule enforced here for every source: an item that only carries a name (a placeholder) is never "ready" or "converted".
import { listAssets, type AssetEntry } from "@/lib/crm/blueprints/refs";
import { requirementDetails } from "@/lib/crm/blueprints/requirements";
import {
  COMPAT_STATUSES, REQUIREMENT_INFO,
  type BlueprintContent, type CompatItem, type CompatReport, type CompatStatus, type CompatSummary, type RequirementKey,
} from "@/lib/crm/blueprints/types";

/** Fully supported: became a complete native definition. Partially: converted with something left to map, connect or finish. */
const FULL: readonly CompatStatus[] = ["ready", "converted"];
const PARTIAL: readonly CompatStatus[] = ["needs_mapping", "needs_connection", "manual_review"];

export function summarize(items: readonly CompatItem[], extra: { conflicts?: number } = {}): CompatSummary {
  const byStatus = Object.fromEntries(COMPAT_STATUSES.map((s) => [s, 0])) as Record<CompatStatus, number>;
  for (const i of items) byStatus[i.status]++;
  return {
    discovered: items.length,
    fullySupported: items.filter((i) => FULL.includes(i.status)).length,
    partiallySupported: items.filter((i) => PARTIAL.includes(i.status)).length,
    unsupported: byStatus.unsupported,
    failed: byStatus.failed,
    missingDependencies: items.reduce((n, i) => n + i.missingDependencies.length, 0),
    conflicts: extra.conflicts ?? 0,
    needsMapping: byStatus.needs_mapping,
    needsConnection: byStatus.needs_connection,
    manualReview: byStatus.manual_review,
    byStatus,
  };
}

/** Whatever status a converter chose, an item that only carries a name comes out as manual review. */
export function enforcePlaceholderRule(item: CompatItem): CompatItem {
  if (item.placeholder && (item.status === "ready" || item.status === "converted")) {
    return { ...item, status: "manual_review", notes: [...item.notes, "Only the name could be brought over, so this must be rebuilt before use."] };
  }
  return item;
}

export function makeReport(items: CompatItem[], limitations: string[] = [], unavailable: CompatReport["unavailable"] = [], extra: { conflicts?: number } = {}): CompatReport {
  const fixed = items.map(enforcePlaceholderRule);
  return { items: fixed, summary: summarize(fixed, extra), limitations, unavailable };
}

const TYPE_NOTES: Partial<Record<AssetEntry["type"], string>> = {
  calendar: "Each workspace assigns its own hosts. The calendar stays a draft, taking no bookings, until it is verified there.",
  messageTemplate: "Arrives as a draft: nothing is sent until a sender is connected and the wording is approved in the workspace.",
  form: "Arrives as a draft: it takes no submissions until it is published in the workspace.",
  workflow: "Arrives as a draft. Workflows never run on their own.",
  assignmentRule: "Arrives switched off unless all its people are mapped when it's applied (one that only keeps the existing owner needs nobody); then it starts assigning at once.",
};

/** The status an asset's requirements imply: placeholders need review; then connections; then mapping; otherwise ready. */
function statusFor(placeholder: boolean, keys: readonly RequirementKey[]): CompatStatus {
  if (placeholder) return "manual_review";
  if (keys.some((k) => REQUIREMENT_INFO[k].kind === "connect")) return "needs_connection";
  if (keys.some((k) => REQUIREMENT_INFO[k].kind === "map" || REQUIREMENT_INFO[k].kind === "fill")) return "needs_mapping";
  return "ready";
}

/**
 * A report for package content: one item per top-level asset (stages and appointment types travel with their parent), with the
 * requirements that asset brings and what they mean for its status.
 */
export function reportForContent(content: Pick<BlueprintContent, "assets" | "slots">, limitations: string[] = []): CompatReport {
  const entries = listAssets(content);
  const parentOf = new Map(entries.filter((e) => e.parentId).map((e) => [e.id, e.parentId!]));
  const reqs = new Map<string, Set<RequirementKey>>();
  const notes = new Map<string, string[]>();
  for (const d of requirementDetails(content)) {
    for (const id of d.assetIds) {
      const owner = parentOf.get(id) ?? id;
      reqs.set(owner, (reqs.get(owner) ?? new Set()).add(d.key));
      for (const n of d.notes) if (!(notes.get(owner) ?? []).includes(n)) notes.set(owner, [...(notes.get(owner) ?? []), n]);
    }
  }
  const items = entries.filter((e) => !e.parentId).map((e): CompatItem => {
    const placeholder = Boolean((e.asset as { placeholder?: boolean }).placeholder);
    const keys = [...(reqs.get(e.id) ?? [])];
    const itemNotes = [...(TYPE_NOTES[e.type] ? [TYPE_NOTES[e.type]!] : []), ...(notes.get(e.id) ?? [])];
    return { sourceKind: e.section, name: e.name, status: statusFor(placeholder, keys), assetId: e.id, assetType: e.type, placeholder, notes: itemNotes, requirements: keys, missingDependencies: [] };
  });
  return makeReport(items, limitations);
}

/** The compatibility badge of a library card: "ready" when nothing needs attention, "partial" when something was only partly converted. */
export function compatibilityBadge(report: Pick<CompatReport, "summary">): { status: "ready" | "needs_attention" | "partial"; notes: string[] } {
  const s = report.summary;
  const notes: string[] = [];
  if (s.manualReview) notes.push(`${s.manualReview} to rebuild or review`);
  if (s.unsupported) notes.push(`${s.unsupported} not supported`);
  if (s.failed) notes.push(`${s.failed} failed`);
  if (s.needsConnection) notes.push(`${s.needsConnection} need a connection`);
  if (s.needsMapping) notes.push(`${s.needsMapping} need mapping`);
  const status = s.manualReview || s.unsupported || s.failed ? "partial" : s.needsConnection || s.needsMapping ? "needs_attention" : "ready";
  return { status, notes };
}
