/**
 * Shared (server + browser) types for AQi Operations, the Super Admin AI Platform Operations
 * Copilot. Nothing here grants access: the server resolves the viewer, validates every scope and
 * checks every tool again. These are only the shapes that cross the wire.
 */
import { SETUP_REQUIRED_LABEL } from "@/lib/agents";

/** Honest platform states. There is deliberately no percentage and no unqualified "green". */
export type OpsHealthState = "healthy" | "degraded" | "unavailable" | "unknown" | "not_configured";

export const OPS_STATE_LABEL: Record<OpsHealthState, string> = {
  healthy: "Healthy",
  degraded: "Degraded",
  unavailable: "Unavailable",
  unknown: "Unknown",
  not_configured: "Not configured",
};

export const OPS_SCOPE_TYPES = ["platform", "tenant", "employee", "workflow", "ticket", "incident"] as const;
export type OpsScopeType = (typeof OPS_SCOPE_TYPES)[number];

/** What the browser asks for. The server never trusts the label or the organization. */
export interface OpsScopeRequest {
  type: OpsScopeType;
  id?: string | null;
}

/** What the server verified. `orgId` is the tenant the scope belongs to, when it belongs to one. */
export interface OpsScope {
  type: OpsScopeType;
  id: string | null;
  label: string;
  orgId: string | null;
  orgName: string | null;
}

export const PLATFORM_SCOPE: OpsScope = { type: "platform", id: null, label: "Entire platform", orgId: null, orgName: null };

export function opsScopeKey(scope: Pick<OpsScope, "type" | "id">): string {
  return scope.type === "platform" ? "platform" : `${scope.type}:${scope.id ?? ""}`;
}

export type OpsRisk = "read" | "low" | "medium" | "high" | "critical";
export type OpsApproval = "none" | "confirm" | "confirm_with_reason" | "typed_confirmation";

/** Evidence the narrative may cite as [E1]. One entry per tool run. */
export interface OpsEvidence {
  id: string;
  tool: string;
  label: string;
  /** The system the data was read from, e.g. "Incident engine (incidents table)". */
  source: string;
  retrievedAt: string;
  href?: string | null;
}

export type OpsToolStatus = "running" | "ok" | "partial" | "denied" | "error" | "timeout" | "unavailable";

export interface OpsToolRun {
  id: string;
  toolId: string;
  title: string;
  status: OpsToolStatus;
  durationMs?: number;
  note?: string;
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

interface CardBase {
  id: string;
  title: string;
  /** When the underlying data was read. Cards never imply they are live. */
  asOf: string;
  source: string;
  /** Re-runs the read tool that produced this card. Only read tools can be refreshed. */
  refresh?: { toolId: string; args: Record<string, unknown> };
}

export interface OpsLink {
  label: string;
  href: string;
}

export interface OpsMetric {
  label: string;
  value: string;
  detail?: string;
  state?: OpsHealthState;
}

export interface OpsHealthCard extends CardBase {
  kind: "health";
  state: OpsHealthState;
  summary: string;
  components: Array<{ key: string; label: string; state: OpsHealthState; detail: string; href?: string }>;
  unavailable: string[];
  links: OpsLink[];
}

export interface OpsIncidentRow {
  id: string;
  severity: "info" | "warning" | "critical";
  status: string;
  title: string;
  org: string | null;
  source: string;
  detectedAt: string;
  lastSeenAt: string;
  occurrences: number;
  href: string;
}

export interface OpsIncidentsCard extends CardBase {
  kind: "incidents";
  open: number;
  critical: number;
  rows: OpsIncidentRow[];
  truncated: boolean;
}

export interface OpsWorkspaceCard extends CardBase {
  kind: "workspace";
  orgId: string;
  name: string;
  status: string;
  state: OpsHealthState;
  metrics: OpsMetric[];
  blockers: Array<{ title: string; detail: string; href?: string }>;
  links: OpsLink[];
}

export type OpsEmployeeState =
  | "working" | "scheduled" | "queued" | "waiting_for_approval" | "blocked" | "idle" | "offline" | "setup_required" | "failed" | "unknown";

export const OPS_EMPLOYEE_STATE_LABEL: Record<OpsEmployeeState, string> = {
  working: "Working",
  scheduled: "Scheduled",
  queued: "Queued",
  waiting_for_approval: "Waiting for approval",
  blocked: "Blocked",
  idle: "Idle",
  offline: "Offline",
  setup_required: SETUP_REQUIRED_LABEL,
  failed: "Failed",
  unknown: "Unknown",
};

export interface OpsEmployeeRow {
  id: string;
  name: string;
  role: string;
  org: string;
  orgId: string;
  state: OpsEmployeeState;
  /** The recorded fact the state is based on, in plain words. */
  evidence: string;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  href: string;
}

export interface OpsEmployeesCard extends CardBase {
  kind: "employees";
  counts: Partial<Record<OpsEmployeeState, number>>;
  rows: OpsEmployeeRow[];
  truncated: boolean;
  notes: string[];
}

export interface OpsTimelineEvent {
  at: string;
  label: string;
  detail?: string;
  tone?: "neutral" | "success" | "warning" | "danger";
}

export interface OpsTimelineCard extends CardBase {
  kind: "timeline";
  events: OpsTimelineEvent[];
  verdict?: string;
}

export interface OpsTicketRow {
  id: string;
  ref: string;
  subject: string;
  org: string;
  type: string;
  status: string;
  priority: string;
  ageHours: number;
  escalated: boolean;
  href: string;
}

export interface OpsTicketsCard extends CardBase {
  kind: "tickets";
  total: number;
  rows: OpsTicketRow[];
  groups?: Array<{ label: string; count: number }>;
}

export interface OpsTableCard extends CardBase {
  kind: "table";
  columns: Array<{ key: string; label: string; align?: "left" | "right" }>;
  /** A row may carry `_href`, a deep link for its first cell. */
  rows: Array<Record<string, string | number | null>>;
  caption?: string;
  truncated?: boolean;
}

export interface OpsChartCard extends CardBase {
  kind: "chart";
  unit: string;
  series: Array<{ label: string; value: number; detail?: string }>;
  caption?: string;
}

export interface OpsMetricsCard extends CardBase {
  kind: "metrics";
  metrics: OpsMetric[];
  methodology?: string;
  caveats?: string[];
  period?: string;
}

export interface OpsActionPreviewCard extends CardBase {
  kind: "action_preview";
  actionId: string;
  toolId: string;
  headline: string;
  risk: Exclude<OpsRisk, "read">;
  approval: Exclude<OpsApproval, "none">;
  effects: string[];
  target: string;
  reversible: string;
  /** Text the administrator must type for typed confirmation. */
  confirmPhrase?: string;
  expiresAt: string;
  status: "proposed" | "executing" | "succeeded" | "verification_failed" | "failed" | "cancelled" | "expired";
}

export interface OpsActionResultCard extends CardBase {
  kind: "action_result";
  actionId: string;
  status: "succeeded" | "verification_failed" | "failed";
  headline: string;
  observed: string[];
  link?: OpsLink;
}

export interface OpsBriefingCard extends CardBase {
  kind: "briefing";
  period: { from: string; to: string; hours: number };
  summary: string;
  noteworthy: boolean;
  sections: Array<{ key: string; title: string; state: OpsHealthState; items: Array<{ text: string; href?: string }> }>;
  recommended: Array<{ text: string; href?: string }>;
  sources: string[];
}

export interface OpsScopePickerCard extends CardBase {
  kind: "scope_picker";
  body: string;
  options: Array<{ type: OpsScopeType; id: string; label: string; detail: string | null }>;
}

export interface OpsNoticeCard extends CardBase {
  kind: "notice";
  tone: "info" | "warning" | "danger";
  body: string;
  links?: OpsLink[];
  /** Offer a Copy button (for a drafted reply the administrator will edit and send themselves). */
  copyable?: boolean;
}

export type OpsCard =
  | OpsHealthCard
  | OpsIncidentsCard
  | OpsWorkspaceCard
  | OpsEmployeesCard
  | OpsTimelineCard
  | OpsTicketsCard
  | OpsTableCard
  | OpsChartCard
  | OpsMetricsCard
  | OpsActionPreviewCard
  | OpsActionResultCard
  | OpsScopePickerCard
  | OpsBriefingCard
  | OpsNoticeCard;

/** Stored on an operations message. Everything here was produced by a server tool, never by the model. */
export interface OpsMessageContext {
  scope: OpsScope;
  cards: OpsCard[];
  evidence: OpsEvidence[];
  tools: OpsToolRun[];
  actionIds: string[];
  /** Why no narrative was written, when the provider could not be used. */
  narrative: "model" | "evidence_only";
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export interface OpsOverviewTile {
  key: string;
  label: string;
  state: OpsHealthState;
  /** What was measured, in words. Never a made-up percentage. */
  headline: string;
  detail: string;
  /** Present only when the number comes from a real source. */
  value: number | null;
  href: string;
  /** Question to hand to AQi to investigate this tile. */
  ask: string;
}

export interface OpsOverview {
  generatedAt: string;
  tiles: OpsOverviewTile[];
  /** Components with no data source in this deployment, so nobody mistakes silence for health. */
  notConfigured: Array<{ label: string; needs: string }>;
  durationMs: number;
}
