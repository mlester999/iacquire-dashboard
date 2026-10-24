import "server-only";
import crypto from "node:crypto";
import type { ProjectStatus, MilestoneStatus } from "@/lib/projects";
import type { ChangeOrderClassification, ChangeOrderStatus } from "@/lib/project-change-orders";
import type { PrerequisiteBlocks, PrerequisiteKind, PrerequisiteStatus } from "@/lib/project-prerequisites";

export interface RequestView {
  id: string;
  ref: string;
  orgId: string;
  title: string;
  summary: string;
  toolsUsed: string[];
  preferredDeadline: string | null;
  budgetRange: string | null;
  status: ProjectStatus;
  statusBeforeHold: ProjectStatus | null;
  serviceId: string | null;
  serviceName: string | null;
  serviceSlug: string | null;
  isAssigned: boolean;
  cancelReason: string | null;
  submittedAt: string;
  lastActivityAt: string;
  closedAt: string | null;
}

export interface RequirementView {
  key: string;
  label: string;
  answer: string;
}

export interface QuoteView {
  id: string;
  version: number;
  status: string;
  projectName: string;
  scope: string;
  deliverables: string[];
  includedIntegrations: string[];
  exclusions: string[];
  timelineText: string;
  estimatedWeeksMin: number | null;
  estimatedWeeksMax: number | null;
  oneTimeCents: number;
  ongoingMonthlyCents: number | null;
  ongoingDescription: string | null;
  revisionTerms: string;
  paymentTerms: string;
  warrantyTerms: string;
  currency: string;
  validUntil: string | null;
  contentHash: string | null;
  sentAt: string | null;
  firstViewedAt: string | null;
  createdAt: string;
  decision: { decision: "accepted" | "changes_requested" | "declined"; note: string | null; decidedAt: string; decidedByName: string | null } | null;
}

export interface MilestoneView {
  id: string;
  title: string;
  description: string | null;
  sortOrder: number;
  status: MilestoneStatus;
  dueOn: string | null;
  requiresClientApproval: boolean;
  clientApprovedAt: string | null;
  clientNote: string | null;
  completedAt: string | null;
}

export interface UpdateView {
  id: string;
  kind: string;
  body: string;
  visibility: "client" | "internal";
  authorName: string | null;
  createdAt: string;
}

export interface FileView {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  kind: string;
  visibility: "client" | "internal";
  description: string | null;
  uploadedByKind: "client" | "agency";
  createdAt: string;
}

export interface MessageView {
  id: string;
  authorKind: "client" | "agency" | "system";
  authorName: string | null;
  kind: "message" | "info_request" | "info_response";
  body: string;
  internal: boolean;
  createdAt: string;
  /** The change order this message is about, if any. */
  changeOrderId?: string | null;
}

export interface DeliveryView {
  agreedPriceCents: number;
  ongoingMonthlyCents: number | null;
  currency: string;
  scope: string;
  deliverables: string[];
  timelineText: string;
  agreedAt: string;
  startedAt: string | null;
  expectedCompletionOn: string | null;
  completedAt: string | null;
  handoverNotes: string | null;
  /** What the team recorded; null means no number was stated and the quote's own wording stands. */
  warrantyDays: number | null;
  warrantyEndsOn: string | null;
  revisionsIncluded: number | null;
  revisionsUsed: number;
}

export interface ChangeDecisionView {
  quoteVersion: number;
  decision: "accepted" | "declined";
  note: string | null;
  decidedAt: string;
  decidedByName: string | null;
}

/** One change a client asked for after the project was agreed. Declined and withdrawn ones stay in the list for good. */
export interface ChangeOrderView {
  id: string;
  ref: string;
  title: string;
  description: string;
  status: ChangeOrderStatus;
  classification: ChangeOrderClassification;
  quoteVersion: number;
  additionalCents: number | null;
  currency: string | null;
  weeksMin: number | null;
  weeksMax: number | null;
  termsText: string | null;
  validUntil: string | null;
  /** The quote is past its valid-until day in the workspace's calendar (the row still says quoted). */
  expired: boolean;
  ticketId: string | null;
  requestedAt: string;
  requestedByName: string | null;
  quotedAt: string | null;
  decidedAt: string | null;
  appliedAt: string | null;
  decisions: ChangeDecisionView[];
  /** The team's own notes. Only ever selected for the agency. */
  internalNotes?: string | null;
}

/** What an accepted change added. The agreed scope is the original scope plus these; the original is never rewritten. */
export interface ScopeAmendmentView {
  id: string;
  changeOrderId: string;
  changeRef: string;
  changeTitle: string;
  addedScope: string;
  addedCents: number;
  currency: string;
  weeksMin: number | null;
  weeksMax: number | null;
  agreedAt: string;
}

export interface PrerequisiteView {
  id: string;
  kind: PrerequisiteKind;
  label: string;
  required: boolean;
  blocks: PrerequisiteBlocks;
  status: PrerequisiteStatus;
  satisfiedAt: string | null;
  waivedAt: string | null;
  changeOrderId: string | null;
  changeStatus: string | null;
  /** What the person wrote down, and who. Only ever selected for the agency. */
  evidenceNote?: string | null;
  waivedReason?: string | null;
  recordedByName?: string | null;
}

export interface ProjectDetail {
  request: RequestView;
  requirements: RequirementView[];
  quotes: QuoteView[];
  delivery: DeliveryView | null;
  milestones: MilestoneView[];
  updates: UpdateView[];
  files: FileView[];
  messages: MessageView[];
  tickets: Array<{ id: string; ref: string; subject: string; status: string }>;
  changes: ChangeOrderView[];
  amendments: ScopeAmendmentView[];
  prerequisites: PrerequisiteView[];
}

// Date-only columns are selected `::text` so a server time zone can never shift the calendar day.
export const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
export const dateOnly = (d: Date | string | null | undefined) => {
  if (!d) return null;
  if (typeof d === "string") return d.slice(0, 10);
  return d.toISOString().slice(0, 10);
};

/**
 * Digest of the client-visible quote terms. It is stored when a quote is sent and re-checked when the client
 * decides, so a decision is always tied to the exact terms that were shown.
 */
export function quoteContentHash(q: {
  projectName: string;
  scope: string;
  deliverables: string[];
  includedIntegrations: string[];
  exclusions: string[];
  timelineText: string;
  estimatedWeeksMin: number | null;
  estimatedWeeksMax: number | null;
  oneTimeCents: number;
  ongoingMonthlyCents: number | null;
  ongoingDescription: string | null;
  revisionTerms: string;
  paymentTerms: string;
  warrantyTerms: string;
  currency: string;
  validUntil: string | null;
}): string {
  const canonical = JSON.stringify([
    q.projectName, q.scope, q.deliverables, q.includedIntegrations, q.exclusions, q.timelineText, q.estimatedWeeksMin, q.estimatedWeeksMax,
    q.oneTimeCents, q.ongoingMonthlyCents, q.ongoingDescription, q.revisionTerms, q.paymentTerms, q.warrantyTerms, q.currency, q.validUntil,
  ]);
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

export const REQUEST_COLUMNS = `r.id, r.ref, r.org_id, r.title, r.summary, r.tools_used, r.preferred_deadline::text as preferred_deadline, r.budget_range, r.status, r.status_before_hold,
  r.service_id, s.name as service_name, s.slug as service_slug, (r.assigned_to is not null) as is_assigned, r.cancel_reason,
  r.submitted_at, r.last_activity_at, r.closed_at`;

export interface RequestRow {
  id: string;
  ref: string;
  org_id: string;
  title: string;
  summary: string;
  tools_used: string[];
  preferred_deadline: Date | string | null;
  budget_range: string | null;
  status: ProjectStatus;
  status_before_hold: ProjectStatus | null;
  service_id: string | null;
  service_name: string | null;
  service_slug: string | null;
  is_assigned: boolean;
  cancel_reason: string | null;
  submitted_at: Date;
  last_activity_at: Date;
  closed_at: Date | null;
}

export const toRequestView = (r: RequestRow): RequestView => ({
  id: r.id,
  ref: r.ref,
  orgId: r.org_id,
  title: r.title,
  summary: r.summary,
  toolsUsed: r.tools_used,
  preferredDeadline: dateOnly(r.preferred_deadline),
  budgetRange: r.budget_range,
  status: r.status,
  statusBeforeHold: r.status_before_hold,
  serviceId: r.service_id,
  serviceName: r.service_name,
  serviceSlug: r.service_slug,
  isAssigned: r.is_assigned,
  cancelReason: r.cancel_reason,
  submittedAt: iso(r.submitted_at)!,
  lastActivityAt: iso(r.last_activity_at)!,
  closedAt: iso(r.closed_at),
});

export interface QuoteRow {
  id: string;
  version: number;
  status: string;
  project_name: string;
  scope: string;
  deliverables: string[];
  included_integrations: string[];
  exclusions: string[];
  timeline_text: string;
  estimated_weeks_min: number | null;
  estimated_weeks_max: number | null;
  one_time_cents: number;
  ongoing_monthly_cents: number | null;
  ongoing_description: string | null;
  revision_terms: string;
  payment_terms: string;
  warranty_terms: string;
  currency: string;
  valid_until: Date | string | null;
  content_hash: string | null;
  sent_at: Date | null;
  first_viewed_at: Date | null;
  created_at: Date;
  decision?: "accepted" | "changes_requested" | "declined" | null;
  decision_note?: string | null;
  decided_at?: Date | null;
  decided_by_name?: string | null;
}

export const toQuoteView = (q: QuoteRow): QuoteView => ({
  id: q.id,
  version: q.version,
  status: q.status,
  projectName: q.project_name,
  scope: q.scope,
  deliverables: q.deliverables,
  includedIntegrations: q.included_integrations,
  exclusions: q.exclusions,
  timelineText: q.timeline_text,
  estimatedWeeksMin: q.estimated_weeks_min,
  estimatedWeeksMax: q.estimated_weeks_max,
  oneTimeCents: q.one_time_cents,
  ongoingMonthlyCents: q.ongoing_monthly_cents,
  ongoingDescription: q.ongoing_description,
  revisionTerms: q.revision_terms,
  paymentTerms: q.payment_terms,
  warrantyTerms: q.warranty_terms,
  currency: q.currency,
  validUntil: dateOnly(q.valid_until),
  contentHash: q.content_hash,
  sentAt: iso(q.sent_at),
  firstViewedAt: iso(q.first_viewed_at),
  createdAt: iso(q.created_at)!,
  decision: q.decision ? { decision: q.decision, note: q.decision_note ?? null, decidedAt: iso(q.decided_at)!, decidedByName: q.decided_by_name ?? null } : null,
});

export const quoteHashFromRow = (q: QuoteRow) => quoteContentHash(toQuoteView(q));

/** sha256 of the canonical text of a change quote (see changeQuoteCanonical in src/lib/project-change-orders.ts). */
export const changeQuoteHash = (canonical: string) => crypto.createHash("sha256").update(canonical).digest("hex");
