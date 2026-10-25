"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowDownToLine, BadgeCheck, Boxes, Check, CheckCircle2, Copy, FileJson, Hammer, PenLine, Plug, ShieldCheck, Sparkles, Users,
} from "lucide-react";
import { Badge } from "@/components/ui/primitives";
import { cn, formatDateTime, formatNumber, relativeTime } from "@/lib/utils";
import {
  BLUEPRINT_INDUSTRIES, BLUEPRINT_INDUSTRY_LABELS, BLUEPRINT_SOURCE_LABELS, COMPAT_LABELS, COMPAT_STATUSES, COMPAT_TONES, PLAN_ACTION_LABELS, REQUIREMENT_INFO,
  SECTION_LABELS, SLOT_KIND_LABELS, typeOfId,
  type ApplicationStatus, type AssetSection, type BlueprintIndustry, type BlueprintSource, type BlueprintStatus, type CompatReport, type CompatStatus, type CompatSummary,
  type PlanAction, type RequirementDetail, type RequirementKey, type RequirementKind, type SlotKind,
} from "@/lib/crm/blueprints/types";
import { GHL_KIND_INFO, type GhlKind } from "@/lib/crm/blueprints/ghl/inventory";

// Shared pieces of the agency's CRM Blueprints screens: addresses, permissions, the action runner, badges, requirement and compatibility
// views. Everything here renders on the server too (the screens are SSR-tested), so nothing reads the browser during render.

export const BP_BASE = "/admin/crm-blueprints";

export const bpHref = {
  library: BP_BASE,
  detail: (id: string, tab?: string) => `${BP_BASE}/${id}${tab ? `?tab=${tab}` : ""}`,
  edit: (id: string) => `${BP_BASE}/${id}/edit`,
  apply: (id: string, clientId?: string) => `${BP_BASE}/${id}/apply${clientId ? `?client=${clientId}` : ""}`,
  import: `${BP_BASE}/import`,
  imports: `${BP_BASE}/imports`,
  importDetail: (id: string) => `${BP_BASE}/imports/${id}`,
  applications: `${BP_BASE}/applications`,
  application: (orgId: string, applicationId: string) => `${BP_BASE}/applications/${orgId}/${applicationId}`,
  exportFile: (id: string, version: number) => `/api/admin/crm-blueprints/${id}/export?version=${version}`,
  clientCrm: (orgId: string) => `/admin/clients/${orgId}/crm`,
  client: (orgId: string) => `/admin/clients/${orgId}`,
};

/** What the signed-in agency person may do, from the Blueprint action table (src/server/crm/blueprints/access.ts → canDoBlueprint). */
export interface BlueprintUiPermissions {
  /** Create, edit, duplicate, archive, organize folders, add starters. */
  design: boolean;
  publish: boolean;
  /** Apply to a client and roll back (super admins). */
  apply: boolean;
  export: boolean;
  importFile: boolean;
  /** GoHighLevel import (super admins: it uses a stored connection). */
  importGhl: boolean;
  capture: boolean;
}

export const NO_PERMISSIONS: BlueprintUiPermissions = { design: false, publish: false, apply: false, export: false, importFile: false, importGhl: false, capture: false };

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string; code?: string };

export const PREVIEW_NOTICE = "Design preview only. No change was saved.";

/**
 * Runs a Blueprint action with one busy key at a time, an error toast, a success toast and a refresh of the server data. In the design
 * preview nothing is called: it says so instead.
 */
export function useBlueprintAction(preview = false) {
  const router = useRouter();
  const [pending, setPending] = React.useState<string | null>(null);
  const run = React.useCallback(
    async <T,>(key: string, fn: () => Promise<ActionResult<T>>, success?: string | ((data: T) => string | null), opts: { refresh?: boolean } = {}): Promise<T | null> => {
      if (preview) {
        toast(PREVIEW_NOTICE);
        return null;
      }
      setPending(key);
      try {
        const res = await fn();
        if (!res.ok) {
          toast.error(res.error);
          return null;
        }
        const msg = typeof success === "function" ? success(res.data) : success;
        if (msg) toast.success(msg);
        if (opts.refresh !== false) router.refresh();
        return (res.data ?? (true as unknown)) as T;
      } catch {
        toast.error("That didn't go through. Check your connection and try again.");
        return null;
      } finally {
        setPending(null);
      }
    },
    [preview, router],
  );
  return { run, pending, busy: (key: string) => pending === key };
}

/** Runs `reset` during render whenever `open` turns true, so a dialog never shows what was typed the last time it was open. */
export function useResetOnOpen(open: boolean, reset: () => void) {
  const [was, setWas] = React.useState(false);
  if (open !== was) {
    setWas(open);
    if (open) reset();
  }
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export const INDUSTRY_OPTIONS = BLUEPRINT_INDUSTRIES.map((value) => ({ value, label: BLUEPRINT_INDUSTRY_LABELS[value] }));
export const industryLabel = (i: string) => BLUEPRINT_INDUSTRY_LABELS[i as BlueprintIndustry] ?? "Other";

export const STATUS_LABEL: Record<BlueprintStatus, string> = { draft: "Draft", published: "Published", archived: "Archived" };
const STATUS_TONE: Record<BlueprintStatus, "neutral" | "success" | "outline"> = { draft: "neutral", published: "success", archived: "outline" };

export function StatusBadge({ status, className }: { status: BlueprintStatus; className?: string }) {
  return <Badge tone={STATUS_TONE[status]} className={className}>{STATUS_LABEL[status]}</Badge>;
}

const SOURCE_ICON: Record<BlueprintSource, React.ComponentType<{ className?: string }>> = { native: Boxes, starter: Sparkles, ghl_import: ArrowDownToLine, file_import: FileJson };

export function SourceBadge({ source, className }: { source: BlueprintSource; className?: string }) {
  const Icon = SOURCE_ICON[source] ?? Boxes;
  return (
    <span className={cn("inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 text-[12px] font-medium text-ink-2", source === "ghl_import" && "border-violet/25 bg-violet-soft text-violet-ink", className)}>
      <Icon className="size-3.5" aria-hidden />
      {BLUEPRINT_SOURCE_LABELS[source] ?? source}
    </span>
  );
}

export const COMPATIBILITY_LABEL = { ready: "Ready to apply", needs_attention: "Setup per client", partial: "Partly converted" } as const;
const COMPATIBILITY_TONE = { ready: "success", needs_attention: "violet", partial: "warning" } as const;
const COMPATIBILITY_HINT = {
  ready: "Nothing has to be connected, mapped or rebuilt after it is applied.",
  needs_attention: "Each client connects, maps or approves a few things after it is applied (listed on the Blueprint).",
  partial: "Some items only came over in part (for example by name only) and must be rebuilt or reviewed.",
} as const;

export function CompatibilityBadge({ value, notes, className }: { value: keyof typeof COMPATIBILITY_LABEL; notes?: string[]; className?: string }) {
  const title = [COMPATIBILITY_HINT[value], ...(notes ?? [])].join(" ");
  return <Badge tone={COMPATIBILITY_TONE[value]} className={className} title={title}>{value === "ready" ? <CheckCircle2 className="size-3.5" aria-hidden /> : null}{COMPATIBILITY_LABEL[value]}</Badge>;
}

export function compatibilityHint(value: keyof typeof COMPATIBILITY_LABEL): string {
  return COMPATIBILITY_HINT[value];
}

export function CompatStatusBadge({ status, className }: { status: CompatStatus; className?: string }) {
  return <Badge tone={COMPAT_TONES[status]} className={className}>{COMPAT_LABELS[status]}</Badge>;
}

export const APPLICATION_STATUS_LABEL: Record<ApplicationStatus, string> = {
  applied: "Applied",
  partially_applied: "Partly applied",
  failed: "Failed",
  rolled_back: "Rolled back",
  partially_rolled_back: "Partly rolled back",
};
const APPLICATION_STATUS_TONE: Record<ApplicationStatus, "success" | "warning" | "danger" | "outline" | "neutral"> = {
  applied: "success", partially_applied: "warning", failed: "danger", rolled_back: "outline", partially_rolled_back: "warning",
};

export function ApplicationStatusBadge({ status }: { status: ApplicationStatus }) {
  return <Badge tone={APPLICATION_STATUS_TONE[status] ?? "neutral"}>{APPLICATION_STATUS_LABEL[status] ?? status}</Badge>;
}

export const PLAN_ACTION_TONE: Record<PlanAction, "success" | "primary" | "neutral" | "outline" | "warning" | "danger"> = {
  create: "success", update: "primary", link: "neutral", unchanged: "outline", skip: "outline", conflict: "warning", blocked: "danger",
};

export function PlanActionBadge({ action }: { action: PlanAction }) {
  return <Badge tone={PLAN_ACTION_TONE[action] ?? "neutral"}>{PLAN_ACTION_LABELS[action] ?? action}</Badge>;
}

export const sectionLabel = (s: AssetSection | string) => SECTION_LABELS[s as AssetSection] ?? s;

/** "@member.closer" / "member.closer" → "Team member: closer". */
export function slotLabel(slot: string): string {
  const kind = typeOfId(slot) as SlotKind | null;
  const tail = slot.replace(/^@/, "").split(".").slice(1).join(" ").replace(/[-_]/g, " ");
  return kind && kind in SLOT_KIND_LABELS ? `${SLOT_KIND_LABELS[kind].label}: ${tail}` : slot;
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

/**
 * A relative time with the exact time on hover. The relative wording can differ by a minute between server and browser. `timeZone`: the
 * signed-in person's zone, so the exact time on hover is theirs (and the same on the server and in the browser).
 */
export function When({ iso, className, prefix, timeZone }: { iso: string | null | undefined; className?: string; prefix?: string; timeZone?: string }) {
  if (!iso) return <span className={className}>—</span>;
  return <time dateTime={iso} title={formatDateTime(iso, timeZone)} className={className} suppressHydrationWarning>{prefix ? `${prefix} ` : ""}{relativeTime(iso)}</time>;
}

export function CopyValue({ value, label, display, className }: { value: string; label: string; display?: string; className?: string }) {
  const [copied, setCopied] = React.useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error("Copying isn't available here. Select the text instead.");
    }
  };
  return (
    <span className={cn("inline-flex min-w-0 max-w-full items-center gap-1.5", className)}>
      <code className="min-w-0 truncate rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[12px] text-ink-2" title={value}>{display ?? value}</code>
      <button type="button" onClick={() => void copy()} aria-label={`Copy ${label}`} className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-primary sm:size-7">
        {copied ? <Check className="size-3.5 text-success-ink" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
      </button>
      <span className="sr-only" role="status">{copied ? `${label} copied` : ""}</span>
    </span>
  );
}

export function ModuleChips({ modules, max = 6, className }: { modules: Array<{ section: AssetSection; label: string; count: number }>; max?: number; className?: string }) {
  if (!modules.length) return <p className={cn("text-[12px] text-muted", className)}>No CRM assets yet.</p>;
  const shown = modules.slice(0, max);
  const rest = modules.length - shown.length;
  return (
    <ul className={cn("flex flex-wrap gap-1.5", className)} aria-label="CRM modules">
      {shown.map((m) => (
        <li key={m.section} className="inline-flex h-6 items-center gap-1 rounded-full bg-surface-2 px-2 text-[12px] font-medium text-ink-2">
          {m.label}<span className="tabular-nums text-muted">{formatNumber(m.count)}</span>
        </li>
      ))}
      {rest > 0 && <li className="inline-flex h-6 items-center rounded-full border border-dashed border-line-strong px-2 text-[12px] font-medium text-muted">+{rest} more</li>}
    </ul>
  );
}

/**
 * A plain download link (never a Next.js Link: those prefetch, and an export must only run when someone asks for it). Styled like a small
 * button.
 */
export function DownloadLink({ href, label, children, variant = "ghost", className }: { href: string; label: string; children: React.ReactNode; variant?: "ghost" | "secondary"; className?: string }) {
  return (
    <a href={href} download aria-label={label}
      className={cn("inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl px-3 text-[13px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:h-8",
        variant === "secondary" ? "border border-line bg-surface text-ink shadow-soft hover:bg-surface-2" : "text-ink-2 hover:bg-surface-2 hover:text-ink", className)}>
      {children}
    </a>
  );
}

/** A compact number tile (label, value, hint) for dense summaries. */
export function StatTile({ label, value, hint, tone = "neutral" }: { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: "neutral" | "success" | "warning" | "danger" | "violet" | "primary" }) {
  const accent = { neutral: "bg-line-strong", success: "bg-success", warning: "bg-warning", danger: "bg-danger", violet: "bg-violet", primary: "bg-primary" }[tone];
  return (
    <div className="relative min-w-0 overflow-hidden rounded-xl border border-line bg-surface px-3.5 py-3 shadow-soft">
      <span className={cn("absolute inset-y-3 left-0 w-[3px] rounded-r-full", accent)} aria-hidden />
      <dt className="text-[12px] font-medium leading-snug text-muted">{label}</dt>
      <dd className="mt-1 text-[22px] font-semibold leading-tight tracking-[-0.03em] tabular-nums text-ink">{value}</dd>
      {hint && <dd className="mt-0.5 text-[12px] leading-snug text-muted">{hint}</dd>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Setup requirements
// ---------------------------------------------------------------------------

const KIND_ICON: Record<RequirementKind, React.ComponentType<{ className?: string }>> = { connect: Plug, map: Users, fill: PenLine, rebuild: Hammer, approve: BadgeCheck, verify: ShieldCheck };
export const KIND_LABEL: Record<RequirementKind, string> = { connect: "Connect", map: "Map", fill: "Fill in", rebuild: "Rebuild", approve: "Approve", verify: "Verify" };
const OWNER_LABEL = { client: "Usually the client", agency: "The agency", either: "Client or agency" } as const;

/**
 * What a client must still connect, map, fill in, rebuild or approve after a Blueprint is applied. Applying never completes any of these: the
 * client's checklist marks each one done only on evidence in that workspace.
 */
export function RequirementList({ details, keys, assetNames, emptyText = "Nothing to connect, map or approve after applying.", compact }: {
  details?: RequirementDetail[];
  keys?: RequirementKey[];
  assetNames?: Map<string, string>;
  emptyText?: string;
  compact?: boolean;
}) {
  const items: RequirementDetail[] = details ?? (keys ?? []).map((key) => ({ key, assetIds: [], slots: [], notes: [] }));
  if (!items.length) return <p className="text-[13px] text-muted">{emptyText}</p>;
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
      {items.map((d) => {
        const info = REQUIREMENT_INFO[d.key];
        if (!info) return null;
        const Icon = KIND_ICON[info.kind];
        const names = d.assetIds.map((id) => assetNames?.get(id)).filter((n): n is string => Boolean(n));
        return (
          <li key={d.key} className="flex gap-3 px-4 py-3">
            <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-ink-2" aria-hidden><Icon className="size-4" /></span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <p className="text-[13.5px] font-semibold text-ink">{info.label}</p>
                <span className="rounded-md bg-surface-3 px-1.5 py-0.5 text-[12px] font-semibold uppercase tracking-wide text-ink-2">{KIND_LABEL[info.kind]}</span>
                {!compact && <span className="text-[12px] text-muted">{OWNER_LABEL[info.owner]}</span>}
              </div>
              {!compact && <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted">{info.description}</p>}
              {names.length > 0 && <p className="mt-1 text-[12px] text-ink-2"><span className="text-muted">For: </span>{names.slice(0, 6).join(", ")}{names.length > 6 ? ` and ${names.length - 6} more` : ""}</p>}
              {d.slots.length > 0 && <p className="mt-1 text-[12px] text-ink-2"><span className="text-muted">Roles: </span>{d.slots.map(slotLabel).join(", ")}</p>}
              {d.notes.length > 0 && <ul className="mt-1 space-y-0.5 text-[12px] text-muted">{d.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Compatibility report
// ---------------------------------------------------------------------------

/** The eight totals every conversion is summarized by. Partial items are never counted as fully supported. */
export function CompatTotals({ summary, unavailable = 0 }: { summary: CompatSummary; unavailable?: number }) {
  return (
    <dl className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
      <StatTile label="Discovered" value={formatNumber(summary.discovered)} hint={unavailable ? `${unavailable} ${unavailable === 1 ? "kind" : "kinds"} couldn't be read` : "Items found in the source"} tone="primary" />
      <StatTile label="Fully supported" value={formatNumber(summary.fullySupported)} hint="Complete native definitions" tone="success" />
      <StatTile label="Partially supported" value={formatNumber(summary.partiallySupported)} hint="Something left to map, connect or finish" tone="warning" />
      <StatTile label="Unsupported" value={formatNumber(summary.unsupported + summary.failed)} hint={summary.failed ? `${summary.failed} failed to read or validate` : "No native equivalent"} tone={summary.failed ? "danger" : "neutral"} />
      <StatTile label="Missing dependencies" value={formatNumber(summary.missingDependencies)} hint="References to things not included" tone={summary.missingDependencies ? "danger" : "neutral"} />
      <StatTile label="Mapping conflicts" value={formatNumber(summary.conflicts)} hint="Names or keys that collide" tone={summary.conflicts ? "warning" : "neutral"} />
      <StatTile label="Needs connection" value={formatNumber(summary.needsConnection)} hint="A provider must be connected per client" tone={summary.needsConnection ? "violet" : "neutral"} />
      <StatTile label="Manual review" value={formatNumber(summary.manualReview)} hint="Only partly converted, e.g. by name only" tone={summary.manualReview ? "warning" : "neutral"} />
    </dl>
  );
}

const PAGE = 40;

/** Every item of a conversion with its status, notes, requirements and missing dependencies, filterable by status. */
export function CompatItems({ report, id }: { report: CompatReport; id: string }) {
  const [status, setStatus] = React.useState<CompatStatus | "all">("all");
  const [limit, setLimit] = React.useState(PAGE);
  const counts = report.summary.byStatus;
  const list = status === "all" ? report.items : report.items.filter((i) => i.status === status);
  const shown = list.slice(0, limit);
  return (
    <div className="space-y-3">
      <div role="group" aria-label="Show items by status" className="relative scrollbar-thin -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
        <StatusChip active={status === "all"} onClick={() => { setStatus("all"); setLimit(PAGE); }} label="All" count={report.items.length} />
        {COMPAT_STATUSES.map((s) => (
          <StatusChip key={s} active={status === s} onClick={() => { setStatus(s); setLimit(PAGE); }} label={COMPAT_LABELS[s]} count={counts[s] ?? 0} disabled={!counts[s]} />
        ))}
      </div>
      <p role="status" className="text-[12px] text-muted">{list.length} {list.length === 1 ? "item" : "items"}{status === "all" ? "" : ` marked ${COMPAT_LABELS[status].toLowerCase()}`}</p>
      {shown.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line-strong px-4 py-6 text-center text-[13px] text-muted">Nothing here.</p>
      ) : (
        <ul id={`${id}-items`} className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
          {shown.map((item, i) => (
            <li key={`${item.assetId ?? item.name}-${i}`} className="px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="break-words text-[13.5px] font-semibold text-ink">{item.name}</p>
                  <p className="mt-0.5 text-[12px] text-muted">{sentence(item.sourceKind)}{item.assetType && item.assetId ? <> · <code className="font-mono text-[12px]">{item.assetId}</code></> : null}</p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                  {item.placeholder && <Badge tone="outline">Name only</Badge>}
                  <CompatStatusBadge status={item.status} />
                </div>
              </div>
              {item.notes.length > 0 && <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[12.5px] leading-relaxed text-ink-2">{item.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
              {(item.requirements.length > 0 || item.missingDependencies.length > 0) && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {item.requirements.map((k) => REQUIREMENT_INFO[k] && <span key={k} className="rounded-full bg-surface-2 px-2 py-0.5 text-[12px] font-medium text-ink-2">{REQUIREMENT_INFO[k].label}</span>)}
                  {item.missingDependencies.map((d) => <span key={d} className="rounded-full bg-danger-soft px-2 py-0.5 text-[12px] font-medium text-danger-ink">Missing: <code className="font-mono">{d}</code></span>)}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {list.length > shown.length && (
        <button type="button" onClick={() => setLimit((l) => l + PAGE)} aria-controls={`${id}-items`} className="inline-flex min-h-11 items-center rounded-xl border border-line bg-surface px-4 text-[13px] font-medium text-ink hover:bg-surface-2 sm:min-h-9">
          Show {Math.min(PAGE, list.length - shown.length)} more of {list.length - shown.length}
        </button>
      )}
    </div>
  );
}

function StatusChip({ active, onClick, label, count, disabled }: { active: boolean; onClick: () => void; label: string; count: number; disabled?: boolean }) {
  return (
    <button type="button" aria-pressed={active} disabled={disabled && !active} onClick={onClick}
      className={cn("inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-45 sm:min-h-8",
        active ? "border-primary/30 bg-primary-soft text-primary-ink" : "border-line bg-surface text-ink-2 hover:bg-surface-2")}>
      {label}<span className="rounded-full bg-surface-3 px-1.5 text-[12px] tabular-nums text-ink-2">{count}</span>
    </button>
  );
}

/** "smart_list" / "customFields" / "calendar group" → "Smart list" / "Custom fields" / "Calendar group". */
export function sentence(text: string): string {
  if (text in SECTION_LABELS) return SECTION_LABELS[text as AssetSection];
  const t = text.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * What an import report calls a part of the source it couldn't read. Reports name it by its GoHighLevel kind ("messageTemplates"), and
 * reports already saved keep that key, so it is shown with GoHighLevel's own label ("SMS & email templates"); any other text reads as a sentence.
 */
export function sourceKindLabel(kind: string): string {
  return Object.hasOwn(GHL_KIND_INFO, kind) ? GHL_KIND_INFO[kind as GhlKind].label : sentence(kind);
}

/** Section rows of an info list (label and value), as used by details panels. */
export function InfoList({ items, className }: { items: Array<{ label: string; value: React.ReactNode }>; className?: string }) {
  return (
    <dl className={cn("divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface", className)}>
      {items.map((i) => (
        <div key={i.label} className="grid gap-1 px-4 py-2.5 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-4">
          <dt className="text-[12px] font-medium text-muted">{i.label}</dt>
          <dd className="min-w-0 break-words text-[13px] text-ink">{i.value}</dd>
        </div>
      ))}
    </dl>
  );
}
