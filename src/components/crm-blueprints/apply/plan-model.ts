// The Apply-to-client wizard's rules that aren't drawing: which clients can take a Blueprint and why not, whether a client has an update to
// review, the dry run grouped by section, what a confirmation will and won't do, the idempotency key a confirmation carries (one per
// attempt, reused on a retry), and how a "the workspace changed" refusal is recognised. Pure (no "use client").
import {
  ASSET_SECTIONS, PLAN_ACTIONS, PLAN_ACTION_LABELS, SECTION_LABELS,
  type ApplicationPlan, type ApplyOptions, type AssetSection, type ConflictDecision, type PlanAction, type PlanItem,
} from "@/lib/crm/blueprints/types";
import type { ClientOption, SlotMappingView, VersionView } from "@/lib/crm/blueprints/views";

// ---------------------------------------------------------------------------
// Choosing a client
// ---------------------------------------------------------------------------

export interface ClientEligibility {
  ok: boolean;
  /** Why it can't be chosen, in plain words. */
  reason: string | null;
  /** Something to know before choosing it (a hybrid workspace has sections GoHighLevel owns). */
  note: string | null;
}

export function clientEligibility(c: Pick<ClientOption, "crmMode">): ClientEligibility {
  if (c.crmMode === "ghl") {
    return { ok: false, reason: "This client uses GoHighLevel as its CRM, so a Blueprint can't be applied. Move its CRM to iAcquire in its CRM provider settings first.", note: null };
  }
  if (c.crmMode === "hybrid") {
    return { ok: true, reason: null, note: "Hybrid CRM: sections GoHighLevel manages for this client are left alone and shown as blocked." };
  }
  return { ok: true, reason: null, note: null };
}

export interface ClientBlueprintState {
  /** The version of this Blueprint the client has (its latest live application), or null. */
  appliedVersion: number | null;
  /** A newer published version exists for the client to review. */
  updateAvailable: boolean;
}

export function clientBlueprintState(c: Pick<ClientOption, "appliedBlueprints">, blueprintId: string, latestVersion: number | null): ClientBlueprintState {
  const applied = c.appliedBlueprints.filter((b) => b.blueprintId === blueprintId).map((b) => b.version);
  const appliedVersion = applied.length ? Math.max(...applied) : null;
  return { appliedVersion, updateAvailable: appliedVersion !== null && latestVersion !== null && latestVersion > appliedVersion };
}

/** Clients matching a search (name or industry, case and accent insensitive), eligible ones first, then by name. */
export function searchClients<T extends Pick<ClientOption, "name" | "industry" | "crmMode">>(clients: readonly T[], query: string): T[] {
  const fold = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const q = fold(query.trim());
  return clients
    .filter((c) => !q || fold(c.name).includes(q) || fold(c.industry ?? "").includes(q))
    .sort((a, b) => Number(clientEligibility(b).ok) - Number(clientEligibility(a).ok) || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Published versions, newest first. */
export function versionsNewestFirst(versions: readonly VersionView[]): VersionView[] {
  return [...versions].sort((a, b) => b.version - a.version);
}

/** The sections a version has assets in, in package order. */
export function sectionsWithAssets(counts: Partial<Record<AssetSection, number>>): AssetSection[] {
  return ASSET_SECTIONS.filter((s) => (counts[s] ?? 0) > 0);
}

/**
 * The sections the options start with. A first application takes every section the version has; an update review starts with the sections
 * that changed since the client's version (when they are known), so an untouched customized pipeline isn't even reviewed unless chosen.
 */
export function initialSections(available: readonly AssetSection[], changed: readonly AssetSection[] | null): AssetSection[] {
  if (!changed) return [...available];
  const picked = available.filter((s) => changed.includes(s));
  return picked.length ? picked : [...available];
}

export const STRATEGY_TEXT = {
  add_missing: {
    label: "Add what's missing",
    description: "Creates what the client doesn't have yet. Everything that already exists stays exactly as it is, even where the Blueprint differs.",
  },
  update_compatible: {
    label: "Add and update compatible items",
    description: "Also updates items this Blueprint created that the client hasn't changed, and makes additive changes (new options, new stages). Anything the client customized, or any change that could break their data, waits for your decision.",
  },
} as const;

export const NEVER_TEXT = "Applying never deletes anything in the client's CRM and never silently replaces their changes.";

export const DECISION_TEXT: Record<ConflictDecision, { label: string; description: string }> = {
  skip: { label: "Keep the client's version", description: "Leave it exactly as it is." },
  update: { label: "Use the Blueprint's version", description: "Replace it with the Blueprint's version. The client's changes to it are overwritten." },
  copy: { label: "Add the Blueprint's version alongside", description: "Keep theirs and add the Blueprint's version under a new name." },
};

// ---------------------------------------------------------------------------
// The dry run
// ---------------------------------------------------------------------------

export interface PlanSectionGroup {
  section: AssetSection;
  label: string;
  items: PlanItem[];
  counts: Record<PlanAction, number>;
  /** Conflicts in this section nobody has decided yet. */
  undecided: number;
}

const emptyCounts = (): Record<PlanAction, number> => Object.fromEntries(PLAN_ACTIONS.map((a) => [a, 0])) as Record<PlanAction, number>;

/** The plan's items by section (package order), keeping the plan's own order inside a section (a stage right after its pipeline). */
export function groupPlan(plan: Pick<ApplicationPlan, "items">): PlanSectionGroup[] {
  const by = new Map<AssetSection, PlanItem[]>();
  for (const i of plan.items) by.set(i.section, [...(by.get(i.section) ?? []), i]);
  return ASSET_SECTIONS.filter((s) => by.has(s)).map((section) => {
    const items = by.get(section)!;
    const counts = emptyCounts();
    for (const i of items) counts[i.action]++;
    return { section, label: SECTION_LABELS[section], items, counts, undecided: items.filter((i) => i.action === "conflict" && !i.decision).length };
  });
}

/** The actions with at least one item, in a fixed order, with their labels ("3 Create · 1 Needs a decision"). */
export function countLines(counts: Partial<Record<PlanAction, number>>): Array<{ action: PlanAction; label: string; count: number }> {
  return PLAN_ACTIONS.filter((a) => (counts[a] ?? 0) > 0).map((a) => ({ action: a, label: PLAN_ACTION_LABELS[a], count: counts[a] ?? 0 }));
}

export function undecidedConflicts(plan: Pick<ApplicationPlan, "items">): PlanItem[] {
  return plan.items.filter((i) => i.action === "conflict" && !i.decision);
}

export interface PlanSummary {
  /** Items that will be created in the client's CRM (including conflicts decided as "copy"). */
  creates: number;
  /** Items that will be changed (including conflicts decided as "update"). */
  updates: number;
  /** Items left exactly as they are: already matching, up to date, skipped, or decided as "keep". */
  untouched: number;
  /** Conflicts left undecided: they are left untouched too. */
  undecided: number;
  blocked: number;
}

export function summarizePlan(plan: Pick<ApplicationPlan, "items">): PlanSummary {
  const s: PlanSummary = { creates: 0, updates: 0, untouched: 0, undecided: 0, blocked: 0 };
  for (const i of plan.items) {
    if (i.action === "create") s.creates++;
    else if (i.action === "update") s.updates++;
    else if (i.action === "blocked") s.blocked++;
    else if (i.action === "conflict") {
      if (i.decision === "copy") s.creates++;
      else if (i.decision === "update") s.updates++;
      else if (i.decision === "skip") s.untouched++;
      else s.undecided++;
    } else s.untouched++;
  }
  return s;
}

/**
 * The decisions to send with the next dry run: the ones chosen for items that are still conflicts, or that a decision already settled
 * (the dry run turns a decided conflict into what was decided: "skip" + skip, "create" + copy, "update" + update). Others are dropped.
 */
export function decisionsFor(plan: Pick<ApplicationPlan, "items"> | null, chosen: Record<string, ConflictDecision>): Record<string, ConflictDecision> {
  if (!plan) return { ...chosen };
  const open = new Set(plan.items.filter((i) => i.action === "conflict" || i.decision).map((i) => i.assetId));
  return Object.fromEntries(Object.entries(chosen).filter(([id]) => open.has(id)));
}

/** Whether a conflict (decided or not) can take "Use the Blueprint's version": the dry run says so for each item (PlanItem.updatable). */
export function canReplaceInPlace(item: Pick<PlanItem, "updatable">): boolean {
  return item.updatable;
}

/**
 * The decisions a dry run actually used, out of the ones it was sent. It takes a decision only where it can: a record that can't be replaced
 * in place ignores "Use the Blueprint's version" (it stays a conflict, undecided), and a copy that can't be made is blocked. Those are
 * `refused`; a decision for an item the plan no longer has (its section was left out) is dropped too. The wizard forgets every dropped one
 * and plans again without them, so the decision shown, the dry run and what is confirmed always agree.
 */
export function reconcileDecisions(plan: Pick<ApplicationPlan, "items">, sent: Readonly<Record<string, ConflictDecision>> | undefined): {
  kept: Record<string, ConflictDecision>;
  dropped: string[];
  refused: PlanItem[];
} {
  const byId = new Map(plan.items.map((i) => [i.assetId, i]));
  const kept: Record<string, ConflictDecision> = {};
  const dropped: string[] = [];
  const refused: PlanItem[] = [];
  for (const [id, d] of Object.entries(sent ?? {})) {
    const item = byId.get(id);
    if (item && item.decision === d) kept[id] = d;
    else {
      dropped.push(id);
      if (item) refused.push(item);
    }
  }
  return { kept, dropped, refused };
}

/** Options without the dropped decisions, keeping the key order build() uses (so the preview's key matches the wizard's own). */
export function withDecisions(options: ApplyOptions, decisions: Record<string, ConflictDecision>): ApplyOptions {
  const out: ApplyOptions = { strategy: options.strategy };
  if (options.sections) out.sections = options.sections;
  if (options.assetIds) out.assetIds = options.assetIds;
  if (Object.keys(decisions).length) out.decisions = decisions;
  if (options.slotMappings) out.slotMappings = options.slotMappings;
  return out;
}

/** Lead assignment rules a plan adds. One whose people are all mapped (or that needs nobody) arrives switched on and assigns new leads at once. */
export function assignmentRulesAdded(plan: Pick<ApplicationPlan, "items">): PlanItem[] {
  return plan.items.filter((i) => i.assetType === "assignmentRule" && i.action === "create");
}

export const RULES_ON_TEXT =
  "A lead assignment rule whose people are all mapped (or that needs nobody, like one that keeps the existing owner) arrives switched on and starts assigning new contacts or deals straight away. The others stay switched off until their people are mapped.";

/**
 * The mappings an earlier application of this Blueprint left for this client, taken into the wizard's choices for roles nobody has touched
 * yet, so the select shows them and the options the wizard sends say what the dry run uses (it keeps a remembered mapping unless the role is
 * sent cleared, see slotMappingsToSend). Null when nothing new was adopted.
 */
export function adoptRememberedMappings(slots: readonly SlotMappingView[], chosen: Readonly<Record<string, string>>, touched: ReadonlySet<string>): Record<string, string> | null {
  const next = { ...chosen };
  let changed = false;
  for (const s of slots) {
    if (!s.mappedTo || touched.has(s.slotId) || next[s.slotId] || !s.candidates.some((c) => c.id === s.mappedTo)) continue;
    next[s.slotId] = s.mappedTo;
    changed = true;
  }
  return changed ? next : null;
}

/**
 * The slot mappings to send: roles mapped to someone, and "" for each role the person set to "Leave for the client" (`touched`). The dry run
 * keeps a mapping remembered from an earlier application unless the role is sent as "", so a cleared role must be sent to stay cleared. A
 * role nobody touched and nobody is mapped to is left out.
 */
export function slotMappingsToSend(chosen: Readonly<Record<string, string>>, touched: ReadonlySet<string> = new Set()): Record<string, string> {
  return Object.fromEntries(Object.entries(chosen).filter(([id, v]) => !!v || touched.has(id)).map(([id, v]) => [id, v || ""]));
}

/** A short form of a digest for people to compare ("3f9a…c21e"). */
export const shortDigest = (d: string) => (d.length > 12 ? `${d.slice(0, 6)}…${d.slice(-4)}` : d);

// ---------------------------------------------------------------------------
// Confirming
// ---------------------------------------------------------------------------

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * A new idempotency key for one confirmation: 32 URL-safe characters from 24 random bytes (access.ts accepts 16 to 80). The wizard keeps it
 * for that attempt and sends the same key again on a retry, so a confirmation that reached the server twice is applied once.
 */
export function newIdempotencyKey(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const bytes = random(24);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63] + B64URL[n & 63];
  }
  return out;
}

/**
 * Whether a refusal means the client's workspace changed since the dry run (apply.ts re-plans under the workspace lock and refuses with
 * "The workspace changed since the preview. Preview again."). The wizard then runs the dry run again instead of only showing the error.
 */
export function isWorkspaceChanged(res: { ok: boolean; code?: string; error?: string }): boolean {
  return !res.ok && res.code === "conflict" && /changed since the preview|preview again/i.test(res.error ?? "");
}

/** The key of one confirmation attempt: kept while the plan it confirms is the same, new once the plan (its digest) changes. */
export function keyForAttempt(current: { digest: string; key: string } | null, digest: string, make: () => string = newIdempotencyKey): { digest: string; key: string } {
  return current && current.digest === digest ? current : { digest, key: make() };
}
