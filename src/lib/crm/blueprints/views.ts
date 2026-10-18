// View models the Blueprint services return to the agency library, the import, capture and apply flows, onboarding, and the client's CRM.
// Plain data only (dates are ISO strings), so server components can hand them to client components unchanged. No I/O here.
import type { BlueprintDiff } from "@/lib/crm/blueprints/diff";
import type { ValidationIssue } from "@/lib/crm/blueprints/validate";
import type {
  ApplicationPlan, ApplicationStatus, ApplyOptions, ApplyStrategy, AssetSection, AssetType, BlueprintContent, BlueprintIndustry, BlueprintSource,
  BlueprintStatus, CompatReport, PlanAction, RequirementDetail, RequirementKey, SlotKind,
} from "@/lib/crm/blueprints/types";

export interface BlueprintFolderView {
  id: string;
  name: string;
  count: number;
}

export interface ModuleView {
  section: AssetSection;
  label: string;
  count: number;
}

/** One card in the library. Technical detail stays in BlueprintDetail. */
export interface BlueprintSummary {
  id: string;
  key: string;
  name: string;
  description: string;
  industry: BlueprintIndustry;
  status: BlueprintStatus;
  featured: boolean;
  source: BlueprintSource;
  sourceLabel: string | null;
  folderId: string | null;
  folderName: string | null;
  /** Latest published version, if any. */
  currentVersion: number | null;
  /** The working draft differs from the latest published version. */
  hasUnpublishedChanges: boolean;
  /** Sections with assets in the latest published version (or the draft when never published), with counts. */
  modules: ModuleView[];
  totalAssets: number;
  /** ready: nothing to finish. needs_attention: connections or mapping per workspace. partial: something was only partly converted. */
  compatibility: "ready" | "needs_attention" | "partial";
  /** Short notes for the compatibility badge ("3 to rebuild or review"). */
  compatibilityNotes: string[];
  requirements: RequirementKey[];
  /** Client workspaces with a live (not rolled back) application of this Blueprint. */
  appliedTo: number;
  updatedAt: string;
  createdAt: string;
}

export interface VersionView {
  id: string;
  version: number;
  digest: string;
  schemaVersion: number;
  changeSummary: string;
  summaryLines: string[];
  counts: Record<AssetSection, number>;
  publishedBy: string | null;
  publishedAt: string;
}

export interface BlueprintDetail extends BlueprintSummary {
  draft: BlueprintContent;
  draftRevision: number;
  draftUpdatedAt: string;
  draftUpdatedBy: string | null;
  /** Latest published content, null when never published. */
  published: BlueprintContent | null;
  /** The draft compared with the latest published version (null when never published). */
  unpublishedDiff: BlueprintDiff | null;
  draftWarnings: ValidationIssue[];
  draftErrors: ValidationIssue[];
  requirementDetails: RequirementDetail[];
  versions: VersionView[];
  /** Origin details: the import it came from, the client it was captured from (name only), the starter. */
  provenance: { importId: string | null; sourceOrgName: string | null; starterKey: string | null };
  /** The import report when this Blueprint came from GoHighLevel or a package file. */
  importReport: CompatReport | null;
  canDesign: boolean;
  canPublish: boolean;
  canApply: boolean;
}

/** One asset as the inspection panel shows it: what it is, what it depends on, what it needs. */
export interface AssetView {
  id: string;
  type: AssetType;
  section: AssetSection;
  name: string;
  parentId: string | null;
  dependsOn: string[];
  usedBy: string[];
  slots: string[];
  requirements: RequirementKey[];
  placeholder: boolean;
}

export interface StarterView {
  key: string;
  name: string;
  description: string;
  industry: BlueprintIndustry;
  modules: ModuleView[];
  totalAssets: number;
  requirements: RequirementKey[];
  /** Already added to the library (the Blueprint's id). */
  installedId: string | null;
}

export interface CompareView {
  blueprintId: string;
  from: { version: number | "draft"; digest: string | null };
  to: { version: number | "draft"; digest: string | null };
  diff: BlueprintDiff;
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

/** A slot as the apply preview asks the agency to map it: the workspace's candidates, and what is already chosen. */
export interface SlotMappingView {
  slotId: string;
  kind: SlotKind;
  label: string;
  description: string | null;
  /** Assets that use it. */
  usedBy: Array<{ assetId: string; name: string }>;
  /** People (active members), verified n8n mappings or active webhook endpoints of the workspace. Names only, no contact details. */
  candidates: Array<{ id: string; name: string }>;
  /** The candidate chosen (in the options, or remembered from an earlier application). */
  mappedTo: string | null;
}

export interface ApplyPreview {
  plan: ApplicationPlan;
  slots: SlotMappingView[];
  requirementDetails: RequirementDetail[];
  /** The workspace's CRM mode and why sections are blocked, in plain words. */
  workspace: { mode: "native" | "ghl" | "hybrid"; switching: boolean; blockedSections: Array<{ section: AssetSection; reason: string }> };
}

export interface ApplicationSummary {
  id: string;
  orgId: string;
  orgName: string;
  blueprintId: string;
  blueprintName: string;
  version: number;
  /** The Blueprint's latest published version, to show "update available". */
  latestVersion: number | null;
  mode: "initial" | "update";
  strategy: ApplyStrategy;
  status: ApplicationStatus;
  counts: Partial<Record<PlanAction, number>>;
  requestedBy: string | null;
  requestedVia: "agency" | "onboarding";
  createdAt: string;
  rolledBackAt: string | null;
  /** Only the newest live application of a Blueprint in a workspace can be rolled back. */
  canRollBack: boolean;
  /**
   * Set by the library's application list (listApplications): this is the newest live application of its Blueprint in the workspace and
   * part of the latest version still isn't applied there (a newer version, or sections a section-limited update left out). False on every
   * other row. Undefined where it isn't computed.
   */
  updateAvailable?: boolean;
}

export interface ApplicationItemView {
  assetId: string;
  assetType: AssetType;
  section: AssetSection;
  name: string;
  action: PlanAction;
  outcome: "applied" | "skipped" | "failed" | "rolled_back" | "kept";
  nativeId: string | null;
  message: string | null;
}

export interface ApplicationDetail extends ApplicationSummary {
  requirements: RequirementKey[];
  items: ApplicationItemView[];
  error: string | null;
}

export interface ApplyResult {
  application: ApplicationSummary;
  /** True when this confirmation had already been applied (same idempotency key): nothing new was done. */
  replayed: boolean;
}

export interface RollbackResult {
  status: ApplicationStatus;
  rolledBack: number;
  /** Kept because the client changed or used them since (a tag on contacts, a field with values, a pipeline with deals). */
  kept: Array<{ assetId: string; name: string; reason: string }>;
}

/** Workspaces that applied an earlier version of a Blueprint and could review the latest one. Nothing is pushed automatically. */
export interface UpdateCandidate {
  orgId: string;
  orgName: string;
  /**
   * The version the client has as a whole: its newest full application, when a later section-limited one left part of a newer version out
   * (the newest live version otherwise).
   */
  appliedVersion: number;
  latestVersion: number;
  lastAppliedAt: string;
  /** Sections of the latest version the client doesn't have yet (what changed since appliedVersion, less what was applied since). */
  changedSections: AssetSection[];
}

export interface ClientOption {
  id: string;
  name: string;
  industry: string | null;
  crmMode: "native" | "ghl" | "hybrid";
  /** The Blueprints live in the client, each with the version it has as a whole (as UpdateCandidate.appliedVersion). */
  appliedBlueprints: Array<{ blueprintId: string; name: string; version: number }>;
}

// ---------------------------------------------------------------------------
// Imports (GoHighLevel and package files)
// ---------------------------------------------------------------------------

export interface GhlSourceView {
  /** "client:<orgId>" for a client's connected location, "agency:<sourceId>" for an agency template sub-account. */
  ref: string;
  kind: "ghl_client" | "ghl_agency_source";
  label: string;
  /** Masked: first and last 3 characters. */
  locationHint: string;
  status: string;
  verifiedAt: string | null;
  scopes: string[];
  missingScopes: string[];
}

export interface ImportSummary {
  id: string;
  sourceKind: "ghl_client" | "ghl_agency_source" | "package_file";
  sourceLabel: string;
  status: "previewed" | "saved" | "discarded" | "failed";
  counts: { discovered: number; converted: number; partial: number; unsupported: number; failed: number };
  blueprintId: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface ImportDetail extends ImportSummary {
  report: CompatReport;
  /** The proposed Blueprint content (GoHighLevel-free). Null when nothing could be converted. */
  content: BlueprintContent | null;
  validation: { errors: ValidationIssue[]; warnings: ValidationIssue[] };
  error: string | null;
}

export interface PackageImportPreview extends ImportDetail {
  /** The format version the file was written in, when it was upgraded. */
  upgradedFrom: number | null;
  integrity: "valid" | "missing" | "mismatch";
  manifest: "valid" | "missing" | "mismatch";
}

// ---------------------------------------------------------------------------
// Capture from a client workspace
// ---------------------------------------------------------------------------

export interface CaptureCandidate {
  /** The logical ID the record would get. */
  assetId: string;
  assetType: AssetType;
  section: AssetSection;
  name: string;
  /** Why it is excluded by default or cannot be captured (a private Smart List, a filter on specific companies, an unmapped person). */
  note: string | null;
  capturable: boolean;
  /** Other candidates it needs (included automatically when it is selected). */
  dependsOn: string[];
}

export interface CapturePreview {
  orgId: string;
  orgName: string;
  candidates: CaptureCandidate[];
  /** What a capture never includes, stated plainly for the agency. */
  alwaysExcluded: string[];
  warnings: string[];
}

/** Said on every capture screen, so nobody wonders whether customer data travels. */
export const CAPTURE_ALWAYS_EXCLUDED = [
  "Contacts, companies and deals",
  "Messages, conversations and call recordings",
  "Appointments and bookings",
  "Form submissions and review requests",
  "Connected accounts, OAuth credentials, API keys and provider tokens",
  "Payment details",
  "People (hosts, owners and assignees become roles each workspace maps)",
  "AI employee memories",
] as const;

// ---------------------------------------------------------------------------
// The client's setup checklist after a Blueprint
// ---------------------------------------------------------------------------

export type ChecklistStatus = "done" | "pending" | "unavailable";

export interface ChecklistItem {
  key: RequirementKey;
  label: string;
  description: string;
  status: ChecklistStatus;
  /** What the evidence shows ("2 of 3 calendars have hosts"). Never claims a connection without evidence. */
  detail: string;
  /** Where in the CRM to do it, relative to the CRM base ("/calendars"), when there is a place. */
  path: string | null;
  required: boolean;
  /** The assets and slots it is about. */
  assetIds: string[];
  slots: string[];
}

export interface SetupChecklist {
  items: ChecklistItem[];
  done: number;
  total: number;
}

export interface CalendarCheck {
  key: "hosts" | "hours" | "timezone" | "types" | "connections" | "slots" | "meeting" | "booking";
  label: string;
  ok: boolean;
  detail: string;
}

export interface CalendarVerification {
  calendarId: string;
  ok: boolean;
  checks: CalendarCheck[];
  activated: boolean;
}

export type { ApplicationPlan, ApplyOptions, BlueprintDiff };
