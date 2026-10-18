// Invented sample data for the CRM Blueprints design preview (/dev/crm-blueprints-preview) and the screens' render tests. No real client,
// person, location or credential appears here: every name is made up, every ID is a placeholder, and nothing is read from a database.
// The Blueprint content is built with the package contract's own types and builders, and its summaries are derived with the contract's
// own functions, so the preview shows exactly what the real screens would.
import { placeholderForm, placeholderTemplate, placeholderWorkflow, slot } from "@/lib/crm/blueprints/builders";
import { diffContents } from "@/lib/crm/blueprints/diff";
import { compatibilityBadge, makeReport, reportForContent } from "@/lib/crm/blueprints/report";
import { deriveRequirements, modulesOf, requirementDetails, sectionCounts, totalAssets } from "@/lib/crm/blueprints/requirements";
import { BLUEPRINT_FORMAT, BLUEPRINT_SCHEMA_VERSION, type BlueprintContent, type CompatItem } from "@/lib/crm/blueprints/types";
import type {
  ApplicationDetail, ApplicationSummary, BlueprintDetail, BlueprintFolderView, BlueprintSummary, CapturePreview, ClientOption, GhlSourceView, ImportDetail,
  ImportSummary, PackageImportPreview, RollbackResult, StarterView, UpdateCandidate,
} from "@/lib/crm/blueprints/views";
import { CAPTURE_ALWAYS_EXCLUDED } from "@/lib/crm/blueprints/views";
import { emptyDraft } from "@/lib/crm/forms/spec";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const SAMPLE_IDS = {
  blueprint: id(101), ghlBlueprint: id(102), draftBlueprint: id(103), archivedBlueprint: id(104), starterBlueprint: id(105),
  folderHome: id(201), folderImported: id(202),
  clientA: id(301), clientB: id(302), clientGhl: id(303),
  application: id(401), applicationOld: id(402),
  importGhl: id(501), importFile: id(502), importFailed: id(503),
  sourceAgency: id(601), sourceClient: id(602),
  version1: id(701), version2: id(702),
};
const T0 = "2026-10-01T15:00:00.000Z";
const T1 = "2026-10-09T10:30:00.000Z";
const T2 = "2026-10-15T08:15:00.000Z";

const hours = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60 }));

/** Version 2 of an invented "Sample Plumbing Lead Engine" Blueprint. */
export const SAMPLE_CONTENT: BlueprintContent = {
  format: BLUEPRINT_FORMAT,
  schemaVersion: BLUEPRINT_SCHEMA_VERSION,
  blueprint: { key: "sample-plumbing-lead-engine", name: "Sample Plumbing Lead Engine", description: "Leads to booked jobs for a made-up plumbing business: intake, estimates, follow-ups and reviews.", industry: "home_services" },
  settings: { defaultCurrency: "USD" },
  slots: [slot("member", "dispatcher", "Dispatcher", "Takes new requests and books estimates."), slot("member", "technician", "Technician", "Visits customers for estimates.")],
  assets: {
    folders: [{ id: "folder.tag.lead-stage", kind: "tag", name: "Lead stage" }, { id: "folder.workflow.follow-ups", kind: "workflow", name: "Follow-ups" }],
    tags: [
      { id: "tag.new-lead", name: "New lead", color: "#2c5bff", description: "Came in through a form or call.", folder: "@folder.tag.lead-stage" },
      { id: "tag.estimate-booked", name: "Estimate booked", color: "#12a150", description: null, folder: "@folder.tag.lead-stage" },
      { id: "tag.emergency", name: "Emergency", color: "#d92d20", description: "Needs a same-day visit.", folder: null },
    ],
    customFields: [
      { id: "field.contact.property-type", entity: "contact", key: "property_type", label: "Property type", type: "select", options: [{ value: "house", label: "House" }, { value: "apartment", label: "Apartment" }, { value: "business", label: "Business" }], required: false, helpText: null, groupName: "Job details" },
      { id: "field.contact.issue", entity: "contact", key: "issue", label: "Issue described", type: "textarea", options: [], required: false, helpText: "In the customer's words.", groupName: "Job details" },
    ],
    customValues: [
      { id: "value.business-phone", key: "business_phone", label: "Business phone", type: "phone", value: "", required: true, groupName: "Business" },
      { id: "value.review-link", key: "review_link", label: "Review page", type: "url", value: "", required: false, groupName: "Business" },
    ],
    pipelines: [{
      id: "pipeline.jobs", name: "Jobs", description: "From first contact to a finished job.", isDefault: true,
      stages: [
        { id: "stage.jobs.new", name: "New request", kind: "open", probability: 10, color: null },
        { id: "stage.jobs.estimate", name: "Estimate booked", kind: "open", probability: 40, color: null },
        { id: "stage.jobs.quoted", name: "Quote sent", kind: "open", probability: 60, color: null },
        { id: "stage.jobs.won", name: "Job won", kind: "won", probability: 100, color: null },
        { id: "stage.jobs.lost", name: "Not going ahead", kind: "lost", probability: 0, color: null },
      ],
    }],
    calendars: [{
      id: "calendar.estimates", name: "Estimates", description: "On-site estimate visits.", assignment: "round_robin", roundRobinMode: "balanced", color: "#2c5bff", folder: null,
      bookingIntro: "Pick a time for a technician to visit.", timezone: null, hours, hosts: ["@member.technician"],
      types: [{
        id: "apptype.estimates.on-site", name: "On-site estimate", description: null, durationMinutes: 60, slotIntervalMinutes: 30, bufferBeforeMinutes: 15, bufferAfterMinutes: 15,
        minNoticeMinutes: 240, maxDaysAhead: 30, dailyLimit: 6, capacity: 1, locationKind: "in_person", locationDetail: "At the customer's address", meetingProvider: "none",
        meetingLink: null, requiresConfirmation: true, public: true, questions: [{ key: "access", label: "How do we get in?", type: "text", required: false }], color: null,
        confirmationMessage: null, allowCustomerChanges: true, changeCutoffMinutes: 120, requireEmail: false, requirePhone: true,
      }, {
        id: "apptype.estimates.video", name: "Video consultation", description: null, durationMinutes: 20, slotIntervalMinutes: null, bufferBeforeMinutes: 0, bufferAfterMinutes: 10,
        minNoticeMinutes: 60, maxDaysAhead: 14, dailyLimit: null, capacity: 1, locationKind: "video", locationDetail: null, meetingProvider: "google_meet",
        meetingLink: null, requiresConfirmation: false, public: true, questions: [], color: null, confirmationMessage: null, allowCustomerChanges: true, changeCutoffMinutes: 60,
        requireEmail: true, requirePhone: false,
      }],
    }],
    smartLists: [{
      id: "list.emergencies", entity: "contact", name: "Emergencies", description: "Contacts tagged Emergency.", folder: null,
      filter: { op: "and", conditions: [{ field: "tags", op: "has_any", value: ["@tag.emergency"] }] }, columns: ["name", "phone", "@field.contact.issue"], sort: { by: "created_at", dir: "desc" }, isDefault: false,
    }],
    assignmentRules: [{
      id: "rule.new-requests", name: "New requests to dispatch", entity: "contact", conditions: { op: "and", conditions: [] }, reassignOwned: false, strategy: "round_robin",
      respectWorkingHours: true, fallback: "unassigned", fallbackMember: null, members: [{ member: "@member.dispatcher", weight: 1, priority: 1 }],
    }],
    forms: [
      { id: "form.request-a-visit", key: "request-a-visit", name: "Request a visit", kind: "form", purpose: "contact", folder: null, draft: emptyDraft("form"), placeholder: false },
      placeholderForm("form.warranty-claim", "warranty-claim", "Warranty claim"),
    ],
    messageTemplates: [
      { id: "template.estimate-confirmed", kind: "template", key: "estimate_confirmed", name: "Estimate confirmed", channel: "sms", purpose: "service", category: "Bookings", folder: null, subject: null, body: "Hi {{contact.first_name}}, your estimate is booked. Questions? Call {{custom_values.business_phone}}.", whatsapp: null, placeholder: false },
      { id: "template.quote-follow-up", kind: "template", key: "quote_follow_up", name: "Quote follow-up", channel: "email", purpose: "service", category: "Quotes", folder: null, subject: "Your quote", body: "Hi {{contact.first_name}}, just checking in on the quote we sent.", whatsapp: null, placeholder: false },
      placeholderTemplate("template.seasonal-offer", "seasonal_offer", "Seasonal offer", "email", { purpose: "marketing" }),
    ],
    workflows: [
      {
        id: "workflow.new-request", key: "new_request", name: "New request follow-up", description: "Tags and texts every new request.", folder: "@folder.workflow.follow-ups", hourlyRunLimit: 200,
        definition: {
          trigger: { type: "contact.created" },
          steps: [
            { key: "tag", kind: "add_tag", name: "Tag as new lead", config: { tagIds: ["@tag.new-lead"] }, next: "text" },
            { key: "text", kind: "send_message", name: "Text a confirmation", config: { channel: "sms", templateId: "@template.estimate-confirmed" }, next: null },
          ],
        },
        placeholder: false,
      },
      placeholderWorkflow("workflow.review-request", "review_request", "Review request after a job"),
    ],
    reports: [{ id: "report.weekly-jobs", key: "weekly-jobs", name: "Weekly jobs", description: "Leads, estimates and won jobs.", folder: null, config: { filters: { range: "7d" }, sections: ["leads", "appointments", "deals"] } }],
  },
};

/** Version 1: before the video consultation, the warranty form and the seasonal offer were added. */
export const SAMPLE_CONTENT_V1: BlueprintContent = {
  ...SAMPLE_CONTENT,
  assets: {
    ...SAMPLE_CONTENT.assets,
    calendars: SAMPLE_CONTENT.assets.calendars.map((c) => ({ ...c, types: c.types.slice(0, 1) })),
    forms: SAMPLE_CONTENT.assets.forms.slice(0, 1),
    messageTemplates: SAMPLE_CONTENT.assets.messageTemplates.slice(0, 2),
  },
};

/** The working draft: version 2 plus an extra stage. */
export const SAMPLE_DRAFT: BlueprintContent = {
  ...SAMPLE_CONTENT,
  assets: {
    ...SAMPLE_CONTENT.assets,
    pipelines: SAMPLE_CONTENT.assets.pipelines.map((p) => ({ ...p, stages: [...p.stages.slice(0, 3), { id: "stage.jobs.scheduled", name: "Job scheduled", kind: "open" as const, probability: 80, color: null }, ...p.stages.slice(3)] })),
  },
};

const badge = compatibilityBadge(reportForContent(SAMPLE_CONTENT));

const summary = (over: Partial<BlueprintSummary> & Pick<BlueprintSummary, "id" | "key" | "name">): BlueprintSummary => ({
  description: "", industry: "general_services", status: "draft", featured: false, source: "native", sourceLabel: null, folderId: null, folderName: null, currentVersion: null,
  hasUnpublishedChanges: false, modules: [], totalAssets: 0, compatibility: "ready", compatibilityNotes: [], requirements: [], appliedTo: 0, updatedAt: T1, createdAt: T0, ...over,
});

export const SAMPLE_FOLDERS: BlueprintFolderView[] = [{ id: SAMPLE_IDS.folderHome, name: "Home services", count: 2 }, { id: SAMPLE_IDS.folderImported, name: "From GoHighLevel", count: 1 }];

export const SAMPLE_SUMMARY: BlueprintSummary = summary({
  id: SAMPLE_IDS.blueprint, key: SAMPLE_CONTENT.blueprint.key, name: SAMPLE_CONTENT.blueprint.name, description: SAMPLE_CONTENT.blueprint.description, industry: "home_services",
  status: "published", featured: true, folderId: SAMPLE_IDS.folderHome, folderName: "Home services", currentVersion: 2, hasUnpublishedChanges: true,
  modules: modulesOf(SAMPLE_CONTENT), totalAssets: totalAssets(SAMPLE_CONTENT), compatibility: badge.status, compatibilityNotes: badge.notes,
  requirements: deriveRequirements(SAMPLE_CONTENT), appliedTo: 2, updatedAt: T2,
});

export const SAMPLE_BLUEPRINTS: BlueprintSummary[] = [
  SAMPLE_SUMMARY,
  summary({
    id: SAMPLE_IDS.ghlBlueprint, key: "sample-dental-snapshot", name: "Sample Dental Snapshot", description: "Converted from an invented GoHighLevel template sub-account. Workflows and forms came over by name only.",
    industry: "healthcare_wellness", status: "draft", source: "ghl_import", sourceLabel: "GoHighLevel: Snapshot builder (sample)", folderId: SAMPLE_IDS.folderImported, folderName: "From GoHighLevel",
    modules: [{ section: "tags", label: "Tags", count: 14 }, { section: "customFields", label: "Custom fields", count: 9 }, { section: "pipelines", label: "Pipelines & stages", count: 2 }, { section: "calendars", label: "Calendars & appointment types", count: 3 }, { section: "forms", label: "Forms & surveys", count: 4 }, { section: "workflows", label: "Workflow drafts", count: 7 }],
    totalAssets: 39, compatibility: "partial", compatibilityNotes: ["11 to rebuild or review", "3 need a connection"], requirements: ["calendar_hosts", "calendar_verification", "form_rebuild", "workflow_rebuild", "workflow_activation"],
  }),
  summary({
    id: SAMPLE_IDS.draftBlueprint, key: "sample-salon-basics", name: "Sample Salon Basics", description: "Captured from an invented salon client's CRM (configuration only).", industry: "beauty_salons",
    sourceLabel: "Captured from Sample Salon Co.", folderId: SAMPLE_IDS.folderHome, folderName: "Home services",
    modules: [{ section: "tags", label: "Tags", count: 6 }, { section: "calendars", label: "Calendars & appointment types", count: 1 }, { section: "messageTemplates", label: "Message templates", count: 3 }],
    totalAssets: 10, compatibility: "needs_attention", compatibilityNotes: ["1 need a connection", "1 need mapping"], requirements: ["calendar_hosts", "calendar_verification", "sms_provider", "template_approval"],
  }),
  summary({
    id: SAMPLE_IDS.starterBlueprint, key: "starter-sample-consulting", name: "Consulting Starter (sample)", description: "An iAcquire starter added to the library.", industry: "consulting",
    status: "published", source: "starter", currentVersion: 1, modules: [{ section: "pipelines", label: "Pipelines & stages", count: 1 }, { section: "forms", label: "Forms & surveys", count: 2 }],
    totalAssets: 12, compatibility: "needs_attention", compatibilityNotes: ["2 need mapping"], requirements: ["calendar_hosts"], appliedTo: 1,
  }),
  summary({
    id: SAMPLE_IDS.archivedBlueprint, key: "sample-old-restaurant", name: "Old Restaurant Setup (sample)", description: "Retired.", industry: "restaurants", status: "archived", currentVersion: 3,
    source: "file_import", sourceLabel: "Package file: Old Restaurant Setup", totalAssets: 8, modules: [{ section: "tags", label: "Tags", count: 8 }],
  }),
];

export const SAMPLE_STARTERS: StarterView[] = [
  { key: "starter-sample-consulting", name: "Consulting Starter (sample)", description: "Discovery calls, proposals and onboarding for an advisory practice.", industry: "consulting", modules: [{ section: "pipelines", label: "Pipelines & stages", count: 1 }, { section: "forms", label: "Forms & surveys", count: 2 }, { section: "workflows", label: "Workflow drafts", count: 3 }], totalAssets: 12, requirements: ["calendar_hosts", "calendar_verification", "template_approval"], installedId: SAMPLE_IDS.starterBlueprint },
  { key: "starter-sample-auto", name: "Automotive Service Starter (sample)", description: "Service bookings, reminders and follow-ups for a repair shop.", industry: "automotive", modules: [{ section: "tags", label: "Tags", count: 8 }, { section: "calendars", label: "Calendars & appointment types", count: 2 }, { section: "messageTemplates", label: "Message templates", count: 5 }], totalAssets: 24, requirements: ["calendar_hosts", "sms_provider", "template_approval", "workflow_activation"], installedId: null },
];

// organizations.industry stores the label, as production data does.
export const SAMPLE_CLIENTS: ClientOption[] = [
  { id: SAMPLE_IDS.clientA, name: "Sample Plumbing Co.", industry: "Home Services", crmMode: "native", appliedBlueprints: [{ blueprintId: SAMPLE_IDS.blueprint, name: SAMPLE_CONTENT.blueprint.name, version: 2 }] },
  { id: SAMPLE_IDS.clientB, name: "Sample Heating & Air", industry: "Home Services", crmMode: "hybrid", appliedBlueprints: [] },
  { id: SAMPLE_IDS.clientGhl, name: "Sample Dental Group", industry: "Healthcare & Wellness", crmMode: "ghl", appliedBlueprints: [] },
];

export const SAMPLE_DETAIL: BlueprintDetail = {
  ...SAMPLE_SUMMARY,
  draft: SAMPLE_DRAFT,
  draftRevision: 7,
  draftUpdatedAt: T2,
  draftUpdatedBy: "Sample Designer",
  published: SAMPLE_CONTENT,
  unpublishedDiff: diffContents(SAMPLE_CONTENT, SAMPLE_DRAFT),
  draftWarnings: [{ severity: "warning", code: "personal", path: "assets.messageTemplates[1].body", message: "A text looks like it contains a personal email address. Use a configuration value instead.", assetId: "template.quote-follow-up" }],
  draftErrors: [],
  requirementDetails: requirementDetails(SAMPLE_CONTENT),
  versions: [
    { id: SAMPLE_IDS.version2, version: 2, digest: "b".repeat(64), schemaVersion: 1, changeSummary: "Adds a video consultation, the warranty claim form and a seasonal offer.", summaryLines: diffContents(SAMPLE_CONTENT_V1, SAMPLE_CONTENT).summary, counts: sectionCounts(SAMPLE_CONTENT), publishedBy: "Sample Admin", publishedAt: T1 },
    { id: SAMPLE_IDS.version1, version: 1, digest: "a".repeat(64), schemaVersion: 1, changeSummary: "First version.", summaryLines: [], counts: sectionCounts(SAMPLE_CONTENT_V1), publishedBy: "Sample Admin", publishedAt: T0 },
  ],
  provenance: { importId: null, sourceOrgName: null, starterKey: null },
  importReport: null,
  canDesign: true,
  canPublish: true,
  canApply: true,
};

const app = (over: Partial<ApplicationSummary> & Pick<ApplicationSummary, "id" | "orgId" | "orgName">): ApplicationSummary => ({
  blueprintId: SAMPLE_IDS.blueprint, blueprintName: SAMPLE_CONTENT.blueprint.name, version: 2, latestVersion: 2, mode: "initial", strategy: "add_missing", status: "applied",
  counts: { create: 21, link: 2, skip: 1 }, requestedBy: "Sample Admin", requestedVia: "agency", createdAt: T2, rolledBackAt: null, canRollBack: true, ...over,
});

export const SAMPLE_APPLICATIONS: ApplicationSummary[] = [
  app({ id: SAMPLE_IDS.application, orgId: SAMPLE_IDS.clientA, orgName: "Sample Plumbing Co." }),
  app({ id: SAMPLE_IDS.applicationOld, orgId: SAMPLE_IDS.clientB, orgName: "Sample Heating & Air", version: 1, counts: { create: 18, conflict: 1, skip: 2 }, requestedVia: "onboarding", createdAt: T0 }),
];

export const SAMPLE_UPDATE_CANDIDATES: UpdateCandidate[] = [
  { orgId: SAMPLE_IDS.clientB, orgName: "Sample Heating & Air", appliedVersion: 1, latestVersion: 2, lastAppliedAt: T0, changedSections: ["calendars", "forms", "messageTemplates"] },
];

export const SAMPLE_APPLICATION_DETAIL: ApplicationDetail = {
  ...SAMPLE_APPLICATIONS[0],
  requirements: deriveRequirements(SAMPLE_CONTENT),
  error: null,
  items: [
    { assetId: "tag.new-lead", assetType: "tag", section: "tags", name: "New lead", action: "create", outcome: "applied", nativeId: id(901), message: null },
    { assetId: "tag.emergency", assetType: "tag", section: "tags", name: "Emergency", action: "link", outcome: "applied", nativeId: id(902), message: "The client already had this tag; it was adopted, not duplicated." },
    { assetId: "pipeline.jobs", assetType: "pipeline", section: "pipelines", name: "Jobs", action: "create", outcome: "applied", nativeId: id(903), message: null },
    { assetId: "calendar.estimates", assetType: "calendar", section: "calendars", name: "Estimates", action: "create", outcome: "applied", nativeId: id(904), message: "Created as a draft: it takes no bookings until it is verified and activated." },
    { assetId: "form.warranty-claim", assetType: "form", section: "forms", name: "Warranty claim", action: "skip", outcome: "skipped", nativeId: null, message: "The client already has a form with this key; Add missing only keeps it." },
    { assetId: "workflow.new-request", assetType: "workflow", section: "workflows", name: "New request follow-up", action: "create", outcome: "applied", nativeId: id(905), message: "Created as a draft. It never runs on its own." },
  ],
};

export const SAMPLE_ROLLBACK: RollbackResult = {
  status: "partially_rolled_back",
  rolledBack: 4,
  kept: [{ assetId: "tag.new-lead", name: "New lead", reason: "Used on 12 contacts since it was applied." }, { assetId: "pipeline.jobs", name: "Jobs", reason: "Has 3 deals." }],
};

export const SAMPLE_SOURCES: GhlSourceView[] = [
  { ref: `agency:${SAMPLE_IDS.sourceAgency}`, kind: "ghl_agency_source", label: "Snapshot builder (sample)", locationHint: "AbC…xYz", status: "connected", verifiedAt: T1, scopes: ["locations.readonly", "opportunities.readonly", "calendars.readonly"], missingScopes: [] },
  { ref: `client:${SAMPLE_IDS.clientGhl}`, kind: "ghl_client", label: "Sample Dental Group", locationHint: "QrS…tUv", status: "permission_limited", verifiedAt: T0, scopes: ["locations.readonly"], missingScopes: ["workflows.readonly", "forms.readonly"] },
];

const ghlItems: CompatItem[] = [
  { sourceKind: "pipeline", name: "Patient journey", status: "converted", assetId: "pipeline.patient-journey", assetType: "pipeline", placeholder: false, notes: ["6 stages converted in order."], requirements: [], missingDependencies: [] },
  { sourceKind: "tag", name: "New patient", status: "ready", assetId: "tag.new-patient", assetType: "tag", placeholder: false, notes: ["GoHighLevel has no tag colours, so the default colour is used."], requirements: [], missingDependencies: [] },
  { sourceKind: "calendar", name: "Cleanings", status: "needs_mapping", assetId: "calendar.cleanings", assetType: "calendar", placeholder: false, notes: ["Hosts never travel: each client picks its own.", "Arrives as a draft calendar."], requirements: ["calendar_hosts", "calendar_verification"], missingDependencies: [] },
  { sourceKind: "calendar", name: "Video consults", status: "needs_connection", assetId: "calendar.video-consults", assetType: "calendar", placeholder: false, notes: ["Uses Google Meet."], requirements: ["google_calendar", "calendar_verification"], missingDependencies: [] },
  { sourceKind: "form", name: "New patient intake", status: "manual_review", assetId: "form.new-patient-intake", assetType: "form", placeholder: true, notes: ["The API exposes the form's name only."], requirements: ["form_rebuild"], missingDependencies: [] },
  { sourceKind: "workflow", name: "Recall reminders", status: "manual_review", assetId: "workflow.recall-reminders", assetType: "workflow", placeholder: true, notes: ["The API exposes the workflow's name and status only."], requirements: ["workflow_rebuild", "workflow_activation"], missingDependencies: [] },
  { sourceKind: "whatsapp_template", name: "Appointment reminder (WhatsApp)", status: "unsupported", assetId: null, assetType: null, placeholder: false, notes: ["There is no documented API for WhatsApp templates. Recreate it and submit it for approval."], requirements: [], missingDependencies: [] },
  { sourceKind: "custom_field", name: "Insurance file", status: "failed", assetId: null, assetType: null, placeholder: false, notes: ["File upload fields have no native equivalent yet."], requirements: [], missingDependencies: [] },
];

export const SAMPLE_IMPORT_DETAIL: ImportDetail = {
  id: SAMPLE_IDS.importGhl,
  sourceKind: "ghl_agency_source",
  sourceLabel: "Snapshot builder (sample)",
  status: "previewed",
  counts: { discovered: 8, converted: 2, partial: 4, unsupported: 1, failed: 1 },
  blueprintId: null,
  createdBy: "Sample Admin",
  createdAt: T2,
  report: makeReport(ghlItems, ["Smart Lists cannot be listed through the GoHighLevel API.", "Workflow steps and form questions are not exposed by the API, so those come over by name only."], [{ sourceKind: "Surveys", reason: "The token is missing the surveys.readonly scope." }], { conflicts: 1 }),
  content: SAMPLE_CONTENT,
  validation: { errors: [], warnings: [{ severity: "warning", code: "ghl_id", path: "assets.messageTemplates[0].body", message: "A text contains something that looks like a GoHighLevel ID. Check it before saving.", assetId: "template.estimate-confirmed" }] },
  error: null,
};

export const SAMPLE_PACKAGE_PREVIEW: PackageImportPreview = {
  id: SAMPLE_IDS.importFile,
  sourceKind: "package_file",
  sourceLabel: `Package file: ${SAMPLE_CONTENT_V1.blueprint.name}`,
  status: "previewed",
  counts: { discovered: 12, converted: 0, partial: 0, unsupported: 0, failed: 0 },
  blueprintId: null,
  createdBy: "Sample Designer",
  createdAt: T1,
  report: reportForContent(SAMPLE_CONTENT_V1),
  content: SAMPLE_CONTENT_V1,
  validation: { errors: [], warnings: [] },
  error: null,
  upgradedFrom: null,
  integrity: "valid",
  manifest: "valid",
};

export const SAMPLE_IMPORTS: ImportSummary[] = [
  { id: SAMPLE_IDS.importGhl, sourceKind: "ghl_agency_source", sourceLabel: "Snapshot builder (sample)", status: "previewed", counts: SAMPLE_IMPORT_DETAIL.counts, blueprintId: null, createdBy: "Sample Admin", createdAt: T2 },
  { id: SAMPLE_IDS.importFile, sourceKind: "package_file", sourceLabel: SAMPLE_PACKAGE_PREVIEW.sourceLabel, status: "saved", counts: { discovered: 12, converted: 12, partial: 0, unsupported: 0, failed: 0 }, blueprintId: SAMPLE_IDS.blueprint, createdBy: "Sample Designer", createdAt: T1 },
  { id: SAMPLE_IDS.importFailed, sourceKind: "package_file", sourceLabel: "Package file", status: "failed", counts: { discovered: 0, converted: 0, partial: 0, unsupported: 0, failed: 0 }, blueprintId: null, createdBy: "Sample Designer", createdAt: T0 },
];

export const SAMPLE_CAPTURE: CapturePreview = {
  orgId: SAMPLE_IDS.clientA,
  orgName: "Sample Plumbing Co.",
  alwaysExcluded: [...CAPTURE_ALWAYS_EXCLUDED],
  warnings: ["2 Smart Lists are private to one person and are left out unless you include them."],
  candidates: [
    { assetId: "tag.new-lead", assetType: "tag", section: "tags", name: "New lead", note: null, capturable: true, dependsOn: [] },
    { assetId: "tag.vip", assetType: "tag", section: "tags", name: "VIP", note: null, capturable: true, dependsOn: [] },
    { assetId: "pipeline.jobs", assetType: "pipeline", section: "pipelines", name: "Jobs", note: "5 stages", capturable: true, dependsOn: [] },
    { assetId: "list.my-hot-leads", assetType: "smartList", section: "smartLists", name: "My hot leads", note: "Private to one person, so it isn't captured.", capturable: false, dependsOn: [] },
    { assetId: "workflow.new-request", assetType: "workflow", section: "workflows", name: "New request follow-up", note: "Its notify step names a person; that becomes a role each client maps.", capturable: true, dependsOn: ["tag.new-lead"] },
  ],
};
