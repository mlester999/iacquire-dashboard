// The Blueprint editor and the Apply-to-client wizard: the pure rules behind both screens. Logical IDs generated from names (and kept when
// renamed), new assets that start valid, what refers to an asset and removing it with or without its references, renaming a configuration
// value everywhere its token is used, where a validation issue belongs, the size check before a save, the bridge that lets the CRM's own
// form, workflow and filter builders edit a package without changing anything they don't touch, and the wizard's plan grouping, client
// eligibility, update framing, idempotency keys and "workspace changed" handling. Synthetic data only; nothing here touches a database.
import { beforeAll, describe, expect, it, vi } from "vitest";

// The editor's and wizard's server actions run against the real library and apply services (in-memory database). Only the session and
// cache revalidation are stood in for, the way the other Blueprint action tests do.
const session = vi.hoisted(() => ({ user: null as null | import("@/server/auth/service").SessionUser }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/tenancy/context", async () => {
  const { AppError: E } = await import("@/server/errors");
  return {
    requireAgencyOrThrow: async () => {
      if (!session.user) throw new E("unauthenticated", "Sign in to continue.");
      return session.user;
    },
  };
});
import { validateContent } from "@/lib/crm/blueprints/validate";
import { assetRefs, listAssets } from "@/lib/crm/blueprints/refs";
import { validateDefinition } from "@/lib/crm/workflow/spec";
import { validateDraft, formContextFrom } from "@/lib/crm/forms/spec";
import { validationContextOf } from "@/components/crm/workflows/editor-logic";
import {
  ASSET_SECTIONS, BLUEPRINT_FORMAT, BLUEPRINT_MAX_BYTES, LOGICAL_ID, emptyBlueprint, refId,
  type AssetTypeMap, type BlueprintContent, type PlanItem,
} from "@/lib/crm/blueprints/types";
import type { ApplyPreview, ClientOption, SlotMappingView } from "@/lib/crm/blueprints/views";
import {
  addAsset, detailsChanged, idsWithChildren, indexIssues, issueLocation, keyFromName, mapAssetReferences, moveItem, newAppointmentType, newAsset, newLogicalId, newSlot,
  newStage, referencesTo, removeAsset, renameValueKey, saveBlockers, saveSizeProblem, sectionForPath, slotUseCounts, stripReferences, takenIds, updateAsset,
} from "@/components/crm-blueprints/editor/model";
import {
  EDITOR_TEMPLATE_HASH, filterEditProblem, filterFromBuilder, filterOptionsFor, filterToBuilder, formFromEditor, formOptionsFor, formToEditor, namesSourceFor, standinId,
  workflowFromEditor, workflowOptionsFor, workflowToEditor,
} from "@/components/crm-blueprints/editor/bridge";
import { blueprintTemplateCheck } from "@/components/crm-blueprints/editor/template-check";
import { withSystem } from "@/server/db";
import {
  applyBlueprintToClientAction, blueprintChangedSectionsAction, clientBlueprintChecklistAction, previewBlueprintApplyAction, saveBlueprintDraftAction,
} from "@/app/actions/crm-blueprint-editor";
import { agencyPeople, crmOrg } from "./support/crm";
import { insertPublishedBlueprint, publishVersion, smallContent } from "./support/blueprints";
import {
  RULES_ON_TEXT, adoptRememberedMappings, assignmentRulesAdded, canReplaceInPlace, clientBlueprintState, clientEligibility, countLines, decisionsFor, groupPlan, initialSections,
  isWorkspaceChanged, keyForAttempt, newIdempotencyKey, reconcileDecisions, searchClients, sectionsWithAssets, shortDigest, slotMappingsToSend, summarizePlan,
  undecidedConflicts, versionsNewestFirst, withDecisions,
} from "@/components/crm-blueprints/apply/plan-model";

const TEST_STRIPE_KEY = `sk_live_${"x".repeat(10)}`;

// ---------------------------------------------------------------------------
// A package that uses every asset type (the same shape as the format contract's fixture)
// ---------------------------------------------------------------------------

const apptype = (id: string, name: string, extra: Partial<AssetTypeMap["appointmentType"]> = {}): AssetTypeMap["appointmentType"] => ({
  id, name, description: null, durationMinutes: 60, slotIntervalMinutes: null, bufferBeforeMinutes: 0, bufferAfterMinutes: 15, minNoticeMinutes: 120, maxDaysAhead: 60,
  dailyLimit: null, capacity: 1, locationKind: "in_person", locationDetail: "At the customer's home", meetingProvider: "none", meetingLink: null, requiresConfirmation: false,
  public: true, questions: [], color: null, confirmationMessage: null, allowCustomerChanges: true, changeCutoffMinutes: 0, requireEmail: true, requirePhone: false, ...extra,
});

const field = (id: string, entity: "contact" | "company" | "opportunity", key: string, label: string, type: AssetTypeMap["customField"]["type"], options: Array<{ value: string; label: string }> = []): AssetTypeMap["customField"] => ({
  id, entity, key, label, type, options, required: false, helpText: null, groupName: null,
});

const SERVICE_OPTIONS = [{ value: "repair", label: "Repair" }, { value: "install", label: "Install" }];

function fixture(): BlueprintContent {
  return {
    format: BLUEPRINT_FORMAT,
    schemaVersion: 1,
    blueprint: { key: "home-services-test", name: "Home Services Test", description: "Synthetic test fixture.", industry: "home_services" },
    settings: { defaultCurrency: "USD" },
    slots: [
      { id: "member.closer", label: "Closer", description: null },
      { id: "member.dispatcher", label: "Dispatcher", description: "Handles scheduling." },
      { id: "n8n.lead-sync", label: "Lead sync", description: null },
      { id: "webhook.crm-export", label: "CRM export", description: null },
    ],
    assets: {
      folders: [
        { id: "folder.tag.lead-status", kind: "tag", name: "Lead status" },
        { id: "folder.form.website", kind: "form", name: "Website" },
        { id: "folder.workflow.follow-up", kind: "workflow", name: "Follow-up" },
        { id: "folder.template.reminders", kind: "template", name: "Reminders" },
        { id: "folder.list.sales", kind: "smart_list", name: "Sales" },
        { id: "folder.calendar.field", kind: "calendar", name: "Field visits" },
        { id: "folder.report.weekly", kind: "report", name: "Weekly" },
      ],
      tags: [
        { id: "tag.hot-lead", name: "Hot lead", color: "#dc2626", description: null, folder: "@folder.tag.lead-status" },
        { id: "tag.quote-sent", name: "Quote sent", color: "#2563eb", description: "A quote went out.", folder: null },
        { id: "tag.vip", name: "VIP", color: "#7c3aed", description: null, folder: "@folder.tag.lead-status" },
      ],
      customFields: [
        field("field.contact.budget", "contact", "budget", "Budget", "number"),
        field("field.contact.service", "contact", "service", "Service", "select", SERVICE_OPTIONS),
        field("field.contact.visit-date", "contact", "visit_date", "Visit date", "date"),
        field("field.company.size", "company", "size", "Size", "number"),
        field("field.opportunity.source-detail", "opportunity", "source_detail", "Source detail", "text"),
      ],
      customValues: [
        { id: "value.office-hours", key: "office_hours", label: "Office hours", type: "text", value: "Mon to Fri, 9am to 5pm", required: false, groupName: null },
        { id: "value.booking-link", key: "booking_link", label: "Booking link", type: "url", value: "", required: true, groupName: "Links" },
      ],
      pipelines: [
        {
          id: "pipeline.sales", name: "Sales", description: null, isDefault: true, stages: [
            { id: "stage.sales.new", name: "New", kind: "open", probability: 10, color: null },
            { id: "stage.sales.quoted", name: "Quoted", kind: "open", probability: 50, color: "#ca8a04" },
            { id: "stage.sales.won", name: "Won", kind: "won", probability: 100, color: null },
            { id: "stage.sales.lost", name: "Lost", kind: "lost", probability: 0, color: null },
          ],
        },
        { id: "pipeline.service", name: "Service", description: "Jobs after the sale.", isDefault: false, stages: [{ id: "stage.service.scheduled", name: "Scheduled", kind: "open", probability: null, color: null }] },
      ],
      calendars: [
        {
          id: "calendar.estimates", name: "Estimates", description: null, assignment: "round_robin", roundRobinMode: "balanced", color: "#059669", folder: "@folder.calendar.field",
          bookingIntro: "Book a free estimate.", timezone: "America/New_York", hours: [{ weekday: 1, startMinute: 540, endMinute: 1020 }, { weekday: 3, startMinute: 540, endMinute: 1020 }], hosts: ["@member.closer"],
          types: [
            apptype("apptype.estimates.onsite", "On-site estimate", { questions: [{ key: "access", label: "Gate code or access notes", type: "text", required: false }, { key: "kind", label: "Kind of job", type: "select", required: true, options: ["Repair", "Install"] }] }),
            apptype("apptype.estimates.video", "Video call", { durationMinutes: 30, locationKind: "video", locationDetail: null, meetingProvider: "google_meet" }),
          ],
        },
        {
          id: "calendar.consults", name: "Consults", description: "Phone consultations.", assignment: "single", roundRobinMode: "balanced", color: null, folder: null, bookingIntro: null,
          timezone: null, hours: [], hosts: [], types: [apptype("apptype.consults.link", "Online consult", { durationMinutes: 30, locationKind: "video", locationDetail: null, meetingProvider: "custom_link", meetingLink: null })],
        },
      ],
      smartLists: [
        {
          id: "list.hot-leads", entity: "contact", name: "Hot leads", description: null, folder: "@folder.list.sales",
          filter: {
            op: "and", conditions: [
              { field: "tags", op: "has_any", value: ["@tag.hot-lead", "@tag.vip"] },
              { field: "@field.contact.budget", op: "gte", value: 1000 },
              { op: "or", conditions: [
                { field: "owner", op: "is_any_of", value: ["@member.closer"] },
                { field: "opportunity", op: "in_stage", value: ["@stage.sales.quoted"] },
                { field: "opportunity", op: "in_pipeline", value: "@pipeline.sales" },
              ] },
              { field: "lead_status", op: "in", value: ["new", "open"] },
            ],
          },
          columns: ["phone", "@field.contact.budget", "tags"], sort: { by: "created_at", dir: "desc" }, isDefault: true,
        },
        {
          id: "list.big-companies", entity: "company", name: "Big companies", description: null, folder: null,
          filter: { op: "and", conditions: [{ field: "@field.company.size", op: "gt", value: 50 }] }, columns: ["@field.company.size"], sort: {}, isDefault: false,
        },
      ],
      assignmentRules: [
        {
          id: "rule.new-leads", name: "New leads", entity: "contact", conditions: { op: "and", conditions: [{ field: "tags", op: "has_any", value: ["@tag.hot-lead"] }] }, reassignOwned: false,
          strategy: "round_robin", respectWorkingHours: true, fallback: "fallback_user", fallbackMember: "@member.dispatcher", members: [{ member: "@member.closer", weight: 1, priority: 50 }],
        },
        {
          id: "rule.deals", name: "Deals", entity: "opportunity", reassignOwned: true,
          conditions: { op: "or", conditions: [
            { field: "@field.contact.budget", op: "gt", value: 0 },
            { field: "owner", op: "is_any_of", value: ["@member.closer"] },
            { op: "and", conditions: [{ field: "opportunity", op: "in_stage", value: ["@stage.sales.quoted"] }, { field: "opportunity", op: "in_pipeline", value: ["@pipeline.sales"] }] },
          ] }, strategy: "weighted", respectWorkingHours: false, fallback: "unassigned", fallbackMember: null, members: [] },
      ],
      forms: [
        {
          id: "form.estimate-request", key: "estimate-request", name: "Estimate request", kind: "form", purpose: "quote", folder: "@folder.form.website", placeholder: false,
          draft: {
            questions: [
              { key: "first_name", type: "short_text", label: "First name", required: true, width: "half", map: "contact.first_name" },
              { key: "email", type: "email", label: "Email", required: true, width: "half", map: "contact.email" },
              { key: "budget", type: "number", label: "Budget", required: false, map: "@field.contact.budget" },
              { key: "service", type: "single_choice", label: "Service", required: true, display: "radio", options: SERVICE_OPTIONS, map: "@field.contact.service" },
              { key: "utm_source", type: "hidden", label: "UTM source", required: false, source: { kind: "param", param: "utm_source" } },
            ],
            consent: { text: "I agree to be contacted by email or text message about my estimate request.", marketing: { enabled: false, text: "Send me occasional news and offers." } },
            actions: {
              tagIds: ["@tag.hot-lead"], opportunity: { pipelineId: "@pipeline.sales", stageId: "@stage.sales.new", name: "{{contact.full_name}} – {{form.name}}", valueQuestion: "budget" },
              assignmentRuleId: "@rule.new-leads", notify: { roles: ["owner"], contactOwner: true }, after: { kind: "message", message: "Thanks! We'll be in touch." },
            },
            settings: { title: "", intro: "", submitLabel: "Send" },
          },
        },
        {
          id: "form.legacy-survey", key: "legacy-survey", name: "Legacy survey", kind: "survey", purpose: "survey", folder: null, placeholder: true,
          draft: {
            questions: [], consent: { text: "", marketing: { enabled: false, text: "" } },
            actions: { tagIds: [], opportunity: null, assignmentRuleId: null, notify: { roles: [], contactOwner: false }, after: { kind: "message", message: "Thanks." } },
            settings: { title: "", intro: "", submitLabel: "Send" },
          },
        },
      ],
      messageTemplates: [
        { id: "template.estimate-reminder", kind: "template", key: "estimate_reminder", name: "Estimate reminder", channel: "sms", purpose: "service", category: "Reminders", folder: "@folder.template.reminders", subject: null, body: "Hi {{contact.first_name}}, your estimate is on {{appointment.date}}. Rebook: {{custom_values.booking_link}}", whatsapp: null, placeholder: false },
        { id: "template.welcome-email", kind: "template", key: "welcome_email", name: "Welcome email", channel: "email", purpose: "service", category: null, folder: null, subject: "Welcome to {{business.name}}", body: "Hi {{contact.first_name}}, our hours are {{custom_values.office_hours}}.", whatsapp: null, placeholder: false },
        { id: "template.review-whatsapp", kind: "template", key: "review_whatsapp", name: "Review request", channel: "whatsapp", purpose: "service", category: null, folder: null, subject: null, body: "Hi {{contact.first_name}}, how did we do? {{review.link}}", whatsapp: { name: "review_request", language: "en_US", category: "utility" }, placeholder: false },
        { id: "template.thanks", kind: "canned_reply", key: "thanks", name: "Thanks", channel: null, purpose: "service", category: null, folder: null, subject: null, body: "Thanks for your message!", whatsapp: null, placeholder: false },
        { id: "template.old-promo", kind: "template", key: "old_promo", name: "Old promo", channel: "email", purpose: "marketing", category: null, folder: null, subject: null, body: "", whatsapp: null, placeholder: true },
      ],
      workflows: [
        {
          id: "workflow.new-lead", key: "new_lead", name: "New lead follow-up", description: null, folder: "@folder.workflow.follow-up", hourlyRunLimit: 500, placeholder: false,
          definition: {
            trigger: {
              type: "contact.tag_added", filters: { tagIds: ["@tag.hot-lead"] }, reentry: "once",
              contactFilter: { op: "and", conditions: [
                { field: "@field.contact.budget", op: "gte", value: 500 },
                { field: "tags", op: "has_none", value: ["@tag.vip"] },
                { op: "or", conditions: [
                  { field: "owner", op: "is_any_of", value: ["@member.closer"] },
                  { field: "opportunity", op: "in_stage", value: ["@stage.sales.quoted"] },
                  { field: "opportunity", op: "in_pipeline", value: ["@pipeline.sales"] },
                ] },
              ] },
            },
            steps: [
              { key: "welcome", kind: "send_message", config: { templateId: "@template.welcome-email", channel: "email", sendAs: "sales_assistant", businessHoursOnly: true }, next: "wait1", ui: { x: 10, y: 20 } },
              { key: "wait1", kind: "wait", config: { mode: "duration", amount: 1, unit: "days" }, next: "check" },
              { key: "check", kind: "branch", config: { subject: "contact", filter: { op: "and", conditions: [{ field: "tags", op: "has_any", value: ["@tag.quote-sent"] }, { field: "owner", op: "is_any_of", value: ["@member.closer"] }, { field: "@field.contact.budget", op: "gt", value: 100 }] }, reply: null }, branches: { yes: "deal", no: "task" } },
              { key: "deal", kind: "create_opportunity", config: { name: "{{contact.full_name}}", pipelineId: "@pipeline.sales", stageId: "@stage.sales.new", ownerFromContact: true, skipIfOpenInPipeline: true }, next: "move" },
              { key: "move", kind: "move_stage", config: { pipelineId: "@pipeline.sales", stageId: "@stage.sales.quoted" }, next: "tag" },
              { key: "tag", kind: "add_tag", config: { tagIds: ["@tag.vip"] }, next: "field" },
              { key: "field", kind: "update_field", config: { subject: "contact", field: "@field.contact.service", value: "repair" }, next: "assign" },
              { key: "assign", kind: "assign", config: { subject: "contact", to: "rule", ruleId: "@rule.new-leads", onlyIfUnassigned: true }, next: "notify" },
              { key: "notify", kind: "notify_team", config: { roles: ["owner"], userIds: ["@member.dispatcher"], title: "New hot lead ({{custom_values.office_hours}})" }, next: "sync" },
              { key: "sync", kind: "n8n", config: { mappingId: "@n8n.lead-sync", includeContact: true }, next: "hook" },
              { key: "hook", kind: "webhook", config: { subscriptionId: "@webhook.crm-export", includeContact: false }, next: "ai" },
              { key: "ai", kind: "ai_task", config: { roleKey: "crm_manager", instruction: "Summarize this lead for the team." }, next: "review" },
              { key: "review", kind: "request_review", config: { templateId: "@template.review-whatsapp", channel: "whatsapp", businessHoursOnly: true }, next: null },
              { key: "task", kind: "create_task", config: { title: "Call {{contact.first_name}}", priority: "high", assignee: "user", userId: "@member.closer", dueIn: { amount: 2, unit: "hours" } }, next: "datewait" },
              { key: "datewait", kind: "wait", config: { mode: "until_date", source: "contact_field", fieldId: "@field.contact.visit-date", offset: { amount: 1, unit: "days", direction: "before" }, ifMissing: "continue" }, next: "note" },
              { key: "note", kind: "internal_note", config: { subject: "contact", body: "Reminder sent." }, next: "remove" },
              { key: "remove", kind: "remove_tag", config: { tagIds: ["@tag.hot-lead"] }, next: "end" },
              { key: "end", kind: "end", config: {} },
            ],
          },
        },
        {
          id: "workflow.stage-moves", key: "stage_moves", name: "Stage moves", description: null, folder: null, hourlyRunLimit: 100, placeholder: false,
          definition: {
            trigger: { type: "opportunity.stage_changed", filters: { pipelineId: "@pipeline.sales", stageIds: ["@stage.sales.won"], fromStageIds: ["@stage.sales.quoted"] } },
            steps: [
              { key: "check", kind: "branch", config: { subject: "opportunity", filter: { op: "and", conditions: [{ field: "pipeline", op: "in", value: ["@pipeline.sales"] }, { field: "stage", op: "in", value: ["@stage.sales.won"] }] } }, branches: { yes: "done", no: null } },
              { key: "done", kind: "end", config: {} },
            ],
          },
        },
        {
          id: "workflow.booked", key: "booked", name: "Booked", description: null, folder: null, hourlyRunLimit: 500, placeholder: false,
          definition: {
            trigger: { type: "appointment.booked", filters: { calendarIds: ["@calendar.estimates"], appointmentTypeIds: ["@apptype.estimates.onsite"] } },
            steps: [{ key: "remind", kind: "send_message", config: { templateId: "@template.estimate-reminder", channel: "sms", sendAs: "appointment_setter", businessHoursOnly: true } }],
          },
        },
        {
          id: "workflow.form-intake", key: "form_intake", name: "Form intake", description: null, folder: null, hourlyRunLimit: 500, placeholder: false,
          definition: { trigger: { type: "form.submitted", filters: { formIds: ["@form.estimate-request"] } }, steps: [{ key: "t", kind: "add_tag", config: { tagIds: ["@tag.quote-sent"] } }] },
        },
        {
          id: "workflow.changed", key: "changed", name: "Budget changed", description: null, folder: null, hourlyRunLimit: 500, placeholder: false,
          definition: { trigger: { type: "contact.updated", filters: { changedFields: ["@field.contact.budget", "email"] } }, steps: [{ key: "n", kind: "internal_note", config: { subject: "contact", body: "Budget changed." } }] },
        },
        {
          id: "workflow.assigned", key: "assigned", name: "Assigned to closer", description: null, folder: null, hourlyRunLimit: 500, placeholder: false,
          definition: { trigger: { type: "contact.assigned", filters: { assigneeIds: ["@member.closer"] } }, steps: [{ key: "n", kind: "internal_note", config: { subject: "contact", body: "Assigned." } }] },
        },
        {
          id: "workflow.inbound", key: "inbound", name: "Inbound leads", description: null, folder: null, hourlyRunLimit: 500, placeholder: false,
          definition: { trigger: { type: "inbound_webhook", inbound: { match: "email_or_phone", createContact: true } }, steps: [{ key: "t", kind: "add_tag", config: { tagIds: ["@tag.hot-lead"] } }] },
        },
        {
          id: "workflow.calls", key: "calls", name: "Missed calls", description: null, folder: null, hourlyRunLimit: 500, placeholder: false,
          definition: { trigger: { type: "call.completed", filters: { callStatuses: ["no_answer"] } }, steps: [{ key: "t", kind: "create_task", config: { title: "Call back", priority: "normal", assignee: "contact_owner" } }] },
        },
        { id: "workflow.legacy", key: "legacy", name: "Legacy automation", description: null, folder: null, hourlyRunLimit: 500, placeholder: true, definition: { trigger: { type: "manual" }, steps: [] } },
      ],
      reports: [
        { id: "report.weekly-sales", key: "weekly-sales", name: "Weekly sales", description: null, folder: "@folder.report.weekly", config: { filters: { range: "7d", member: "@member.closer", pipeline: "@pipeline.sales", channel: "sms" }, sections: ["deals", "pipeline"] } },
        { id: "report.leads", key: "leads", name: "Leads", description: "Where leads come from.", folder: null, config: { filters: { range: "30d", source: "website_form" }, sections: ["leads"] } },
      ],
    },
  };
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const errorsOf = (c: BlueprintContent) => validateContent(c).errors;
const allRefs = (c: BlueprintContent) => listAssets(c).flatMap((e) => assetRefs(e).map((r) => r.value));

// ---------------------------------------------------------------------------
// The editor's model
// ---------------------------------------------------------------------------

describe("Blueprint editor: logical IDs and keys", () => {
  it("generates IDs from names, following the schemes, and never reuses one", () => {
    const c = fixture();
    expect(newLogicalId(c, "tag", { name: "Follow up" })).toBe("tag.follow-up");
    expect(newLogicalId(c, "tag", { name: "Hot lead" })).toBe("tag.hot-lead-2");
    expect(newLogicalId(c, "customField", { key: "roof_type", entity: "contact" })).toBe("field.contact.roof_type");
    expect(newLogicalId(c, "stage", { name: "Qualified" }, "pipeline.sales")).toBe("stage.sales.qualified");
    expect(newLogicalId(c, "appointmentType", { name: "Site visit" }, "calendar.estimates")).toBe("apptype.estimates.site-visit");
    expect(newLogicalId(c, "member", { name: "Office manager", label: "Office manager" })).toBe("member.office-manager");
    expect(newLogicalId(c, "form", { key: "estimate-request" })).toBe("form.estimate-request-2");
    for (const id of ["tag.follow-up", "field.contact.roof_type", "stage.sales.qualified"]) expect(LOGICAL_ID.test(id)).toBe(true);
    // Accents and symbols are folded, and an empty name still yields a valid ID.
    expect(newLogicalId(c, "tag", { name: "Été & Co!" })).toBe("tag.ete-co");
    expect(LOGICAL_ID.test(newLogicalId(c, "tag", { name: "???" }))).toBe(true);
  });

  it("keeps an asset's ID when it is renamed, so references keep working", () => {
    const c = fixture();
    const renamed = updateAsset(c, "tags", "tag.hot-lead", (t) => ({ ...t, name: "Warm lead" }));
    expect(renamed.assets.tags.find((t) => t.name === "Warm lead")?.id).toBe("tag.hot-lead");
    expect(errorsOf(renamed).filter((e) => e.code === "missing_ref")).toEqual([]);
  });

  it("makes keys in each type's own alphabet, unique among the taken ones", () => {
    expect(keyFromName("customField", "Budget range", [])).toBe("budget_range");
    expect(keyFromName("customField", "2nd phone", [])).toBe("x_2nd_phone");
    expect(keyFromName("customValue", "Booking link", ["booking_link"])).toBe("booking_link_2");
    expect(keyFromName("form", "Quote request", [])).toBe("quote-request");
    expect(keyFromName("report", "Weekly sales", ["weekly-sales"])).toBe("weekly-sales-2");
    expect(keyFromName("workflow", "New lead follow-up", [])).toBe("new-lead-follow-up");
    expect(keyFromName("form", "!!!", [])).toBe("x");
    expect(keyFromName("customField", "x".repeat(80), []).length).toBeLessThanOrEqual(48);
  });

  it("starts every new asset valid, with an ID made from its name", () => {
    let c = emptyBlueprint({ key: "editor-test", name: "Editor test", description: "", industry: "other" });
    const add = <S extends (typeof ASSET_SECTIONS)[number]>(section: S, input: Parameters<typeof newAsset>[2]) => {
      const a = newAsset(c, section, input);
      c = addAsset(c, section, a);
      return a;
    };
    add("folders", { name: "Website", kind: "form" });
    const tag = add("tags", { name: "New lead" });
    add("customFields", { name: "Budget", entity: "contact" });
    add("customValues", { name: "Booking link" });
    const pipeline = add("pipelines", { name: "Sales" }) as AssetTypeMap["pipeline"];
    const calendar = add("calendars", { name: "Consultations" }) as AssetTypeMap["calendar"];
    add("smartLists", { name: "New leads", entity: "contact" });
    add("assignmentRules", { name: "Share leads", entity: "contact" });
    add("forms", { name: "Contact us" });
    const template = add("messageTemplates", { name: "Welcome" }) as AssetTypeMap["messageTemplate"];
    add("workflows", { name: "Welcome flow" });
    add("reports", { name: "Monthly leads" });
    expect(tag.id).toBe("tag.new-lead");
    expect(pipeline.id).toBe("pipeline.sales");
    expect(pipeline.stages.map((s) => s.id)).toEqual(["stage.sales.new", "stage.sales.qualified", "stage.sales.won", "stage.sales.lost"]);
    expect(pipeline.isDefault).toBe(true);
    expect(calendar.types[0].id).toBe("apptype.consultations.consultation");
    // A template starts without wording, which is the one thing a new asset still needs.
    expect(errorsOf(c).map((e) => issueLocation(e, c).assetId)).toEqual([template.id]);
    c = updateAsset(c, "messageTemplates", template.id, (t) => ({ ...t, subject: "Welcome", body: "Hi {{contact.first_name}}, thanks for getting in touch." }));
    expect(errorsOf(c)).toEqual([]);
    // A second pipeline doesn't take the default away from the first.
    expect((newAsset(c, "pipelines", { name: "Service" }) as AssetTypeMap["pipeline"]).isDefault).toBe(false);
    // Every ID is unique across the package.
    const ids = [...takenIds(c)];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("adds stages and appointment types under their parent's ID", () => {
    const c = fixture();
    expect(newStage(c, "pipeline.sales", "Negotiation").id).toBe("stage.sales.negotiation");
    expect(newStage(c, "pipeline.sales", "Won").id).toBe("stage.sales.won-2");
    expect(newAppointmentType(c, "calendar.consults", "Follow-up call").id).toBe("apptype.consults.follow-up-call");
  });

  it("makes roles from their label", () => {
    const c = fixture();
    expect(newSlot(c, "member", "Closer").id).toBe("member.closer-2");
    expect(newSlot(c, "webhook", "Accounting export").id).toBe("webhook.accounting-export");
  });

  it("moves items within bounds", () => {
    expect(moveItem([1, 2, 3], 0, 1)).toEqual([2, 1, 3]);
    expect(moveItem([1, 2, 3], 0, -1)).toEqual([1, 2, 3]);
    expect(moveItem([1, 2, 3], 2, 1)).toEqual([1, 2, 3]);
  });
});

describe("Blueprint editor: references and removal", () => {
  it("lists everything that refers to an asset, grouped by the asset holding the reference", () => {
    const c = fixture();
    const refs = referencesTo(c, ["tag.hot-lead"]);
    expect(refs.map((r) => r.assetId).sort()).toEqual(["form.estimate-request", "list.hot-leads", "rule.new-leads", "workflow.inbound", "workflow.new-lead"].sort());
    expect(refs.find((r) => r.assetId === "form.estimate-request")!.places).toEqual(["draft.actions.tagIds[0]"]);
    // A pipeline is referred to through its stages too; its own stages are not listed as users.
    const pipelineRefs = referencesTo(c, idsWithChildren(c, "pipeline.sales"));
    expect(pipelineRefs.some((r) => r.assetId === "pipeline.sales")).toBe(false);
    expect(pipelineRefs.map((r) => r.assetId)).toEqual(expect.arrayContaining(["form.estimate-request", "workflow.stage-moves", "report.weekly-sales", "list.hot-leads"]));
    // Configuration values are used by their tokens.
    const valueRefs = referencesTo(c, ["value.booking-link"]);
    expect(valueRefs).toEqual([expect.objectContaining({ assetId: "template.estimate-reminder", kind: "token", places: ["{{custom_values.booking_link}}"] })]);
    // Roles are referred to like assets.
    expect(referencesTo(c, ["member.dispatcher"]).map((r) => r.assetId).sort()).toEqual(["rule.new-leads", "workflow.new-lead"]);
    expect(referencesTo(c, ["tag.quote-sent"]).map((r) => r.assetId).sort()).toEqual(["workflow.form-intake", "workflow.new-lead"]);
  });

  it("removes an asset and clears every reference to it, leaving the rest untouched", () => {
    const c = fixture();
    const next = removeAsset(c, "tag.vip", { stripRefs: true });
    expect(next.assets.tags.map((t) => t.id)).toEqual(["tag.hot-lead", "tag.quote-sent"]);
    expect(allRefs(next).filter((v) => v === "@tag.vip")).toEqual([]);
    // The Smart List keeps its other tag; the workflow's tag step keeps nothing, which validation then asks a person to fix.
    const list = next.assets.smartLists.find((s) => s.id === "list.hot-leads")!;
    expect((list.filter.conditions[0] as { value: string[] }).value).toEqual(["@tag.hot-lead"]);
    expect(errorsOf(next).some((e) => e.code === "missing_ref")).toBe(false);
    // Nothing else moved.
    const without = (x: BlueprintContent) => ({ ...x.assets, tags: [], smartLists: [], workflows: [] });
    expect(without(next)).toEqual(without(c));
  });

  it("can remove an asset and leave its references for validation to report", () => {
    const next = removeAsset(fixture(), "tag.quote-sent", { stripRefs: false });
    expect(next.assets.tags.some((t) => t.id === "tag.quote-sent")).toBe(false);
    const missing = errorsOf(next).filter((e) => e.code === "missing_ref");
    expect(missing.map((e) => e.assetId).sort()).toEqual(["workflow.form-intake", "workflow.new-lead"]);
  });

  it("removes a stage from its pipeline and an appointment type from its calendar", () => {
    const c = fixture();
    const noQuoted = removeAsset(c, "stage.sales.quoted", { stripRefs: true });
    expect(noQuoted.assets.pipelines[0].stages.map((s) => s.id)).toEqual(["stage.sales.new", "stage.sales.won", "stage.sales.lost"]);
    expect(allRefs(noQuoted)).not.toContain("@stage.sales.quoted");
    const noVideo = removeAsset(c, "apptype.estimates.video", { stripRefs: true });
    expect(noVideo.assets.calendars[0].types.map((t) => t.id)).toEqual(["apptype.estimates.onsite"]);
  });

  it("removing a pipeline clears references to its stages too", () => {
    const next = removeAsset(fixture(), "pipeline.sales", { stripRefs: true });
    const left = allRefs(next).filter((v) => v.startsWith("@pipeline.sales") || v.startsWith("@stage.sales."));
    expect(left).toEqual([]);
    expect(next.assets.reports.find((r) => r.id === "report.weekly-sales")!.config.filters.pipeline).toBeUndefined();
  });

  it("removing a role drops it from hosts, members and steps, and a rule without its fallback person leaves records unassigned", () => {
    const c = fixture();
    const next = removeAsset(c, "member.dispatcher", { stripRefs: true });
    expect(next.slots.map((s) => s.id)).not.toContain("member.dispatcher");
    const rule = next.assets.assignmentRules.find((r) => r.id === "rule.new-leads")!;
    expect(rule.fallback).toBe("unassigned");
    expect(rule.fallbackMember).toBeNull();
    const notify = next.assets.workflows[0].definition.steps.find((s) => s.key === "notify")!;
    expect(notify.config.userIds).toEqual([]);
    expect(errorsOf(next).filter((e) => e.code === "undeclared_slot")).toEqual([]);
    const noCloser = removeAsset(c, "member.closer", { stripRefs: true });
    expect(noCloser.assets.calendars[0].hosts).toEqual([]);
  });

  it("removing a folder unfiles what was in it", () => {
    const next = removeAsset(fixture(), "folder.tag.lead-status", { stripRefs: true });
    expect(next.assets.tags.filter((t) => t.folder !== null).length).toBe(0);
  });

  it("maps every reference of one asset in place", () => {
    const rule = fixture().assets.assignmentRules[0];
    const mapped = mapAssetReferences("assignmentRule", rule, (v) => (v === "@member.closer" ? null : v));
    expect(mapped.members).toEqual([]);
    expect(mapped.fallbackMember).toBe("@member.dispatcher");
    expect(rule.members.length).toBe(1);
    expect(stripReferences(fixture(), []).assets).toEqual(fixture().assets);
  });

  it("counts what uses each role", () => {
    expect(slotUseCounts(fixture())).toMatchObject({ "member.closer": expect.any(Number), "n8n.lead-sync": 1, "webhook.crm-export": 1 });
  });

  it("renames a configuration value's key everywhere its token is used", () => {
    const next = renameValueKey(fixture(), "value.booking-link", "booking_url");
    expect(next.assets.customValues.find((v) => v.id === "value.booking-link")!.key).toBe("booking_url");
    expect(next.assets.messageTemplates[0].body).toContain("{{custom_values.booking_url}}");
    expect(next.assets.messageTemplates[0].body).not.toContain("booking_link");
    const office = renameValueKey(fixture(), "value.office-hours", "hours");
    expect(office.assets.messageTemplates[1].body).toContain("{{custom_values.hours}}");
    expect(office.assets.workflows[0].definition.steps.find((s) => s.key === "notify")!.config.title).toBe("New hot lead ({{custom_values.hours}})");
    expect(errorsOf(office)).toEqual([]);
    expect(renameValueKey(fixture(), "value.missing", "x")).toEqual(fixture());
  });
});

describe("Blueprint editor: issues, saving and links", () => {
  it("places each issue in its section, asset and nested asset", () => {
    const c = fixture();
    const at = (path: string, assetId: string | null = null) => issueLocation({ path, assetId }, c);
    expect(at("assets.pipelines[0].stages[1].name")).toEqual({ section: "pipelines", assetId: "pipeline.sales", nestedId: "stage.sales.quoted" });
    expect(at("assets.calendars[0].types[1]")).toEqual({ section: "calendars", assetId: "calendar.estimates", nestedId: "apptype.estimates.video" });
    expect(at("assets.forms[0].draft.actions.tagIds[0]")).toEqual({ section: "forms", assetId: "form.estimate-request", nestedId: null });
    expect(at("slots", "member.closer")).toEqual({ section: "slots", assetId: "member.closer", nestedId: null });
    expect(at("", "stage.sales.won")).toEqual({ section: "pipelines", assetId: "pipeline.sales", nestedId: "stage.sales.won" });
    expect(at("blueprint.name")).toEqual({ section: "details", assetId: null, nestedId: null });
    expect(at("assets.tags")).toEqual({ section: "tags", assetId: null, nestedId: null });
  });

  it("indexes issues by section and asset", () => {
    const c = clone(fixture());
    c.assets.tags[0].color = "red";
    const r = validateContent(c);
    const index = indexIssues([...r.errors, ...r.warnings], c);
    expect(index.bySection.tags.errors).toBeGreaterThan(0);
    expect(index.byAsset.get("tag.hot-lead")?.length).toBeGreaterThan(0);
    expect(saveBlockers(r.errors).length).toBeGreaterThan(0);
  });

  it("knows which problems stop a save, and which only stop publishing", () => {
    const dangling = removeAsset(fixture(), "tag.quote-sent", { stripRefs: false });
    expect(saveBlockers(errorsOf(dangling))).toEqual([]);
    const secret = clone(fixture());
    secret.assets.customValues[0].value = TEST_STRIPE_KEY;
    const blockers = saveBlockers(errorsOf(secret));
    expect(blockers.map((b) => b.code)).toContain("secret");
  });

  it("refuses to send a draft over the package limit", () => {
    const c = clone(fixture());
    expect(saveSizeProblem(c)).toBeNull();
    c.assets.tags = Array.from({ length: 300 }, (_, i) => ({ id: `tag.t${i}`, name: `Tag ${i}`, color: "#2563eb", description: "x".repeat(300), folder: null }));
    c.assets.customValues = Array.from({ length: 200 }, (_, i) => ({ id: `value.v${i}`, key: `v${i}`, label: `V${i}`, type: "text" as const, value: "y".repeat(2000), required: false, groupName: null }));
    c.assets.messageTemplates = Array.from({ length: 200 }, (_, i) => ({ ...fixture().assets.messageTemplates[1], id: `template.m${i}`, key: `m${i}`, name: `M${i}`, body: "z".repeat(4900) }));
    expect(saveSizeProblem(c)).toMatch(/at most 1,000 KB/);
    expect(BLUEPRINT_MAX_BYTES).toBeLessThan(2_000_000);
  });

  it("tells whether the library card's details changed", () => {
    const c = fixture();
    expect(detailsChanged({ name: c.blueprint.name, description: c.blueprint.description, industry: c.blueprint.industry }, c)).toBe(false);
    expect(detailsChanged({ name: "Old", description: c.blueprint.description, industry: c.blueprint.industry }, c)).toBe(true);
  });

  it("opens the matching section for the CRM screens the reused builders link to", () => {
    expect(sectionForPath("/tags")).toBe("tags");
    expect(sectionForPath("settings/assignment")).toBe("assignmentRules");
    expect(sectionForPath("/templates?x=1")).toBe("messageTemplates");
    expect(sectionForPath("/settings/api")).toBe("slots");
    expect(sectionForPath("/workflows/")).toBe("workflows");
    expect(sectionForPath("calendars")).toBe("calendars");
    expect(sectionForPath("/contacts")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The bridge to the CRM's own builders
// ---------------------------------------------------------------------------

describe("Blueprint editor: the CRM's own builders on a package", () => {
  it("gives the builders a stand-in UUID for each asset and role, the same every time", () => {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(standinId("tag.vip")).toMatch(UUID);
    expect(standinId("tag.vip")).toBe(standinId("tag.vip"));
    const c = fixture();
    const all = [...listAssets(c).map((e) => e.id), ...c.slots.map((x) => x.id)];
    expect(new Set(all.map(standinId)).size).toBe(all.length);
    const form = formOptionsFor(c);
    expect(form.tags.every((t) => UUID.test(t.id))).toBe(true);
    expect(form.pipelines[0].stages.map((x) => x.id)).toEqual(["stage.sales.new", "stage.sales.quoted", "stage.sales.won", "stage.sales.lost"].map(standinId));
    expect(form.contactFields.map((f) => f.key)).toEqual(["budget", "service", "visit_date"]);
    // The same options with references as IDs, for readable summaries of package conditions.
    const wf = workflowOptionsFor(c, "ref");
    expect(wf.members.map((m) => m.id)).toEqual(["@member.closer", "@member.dispatcher"]);
    expect(wf.n8nMappings.map((m) => m.id)).toEqual(["@n8n.lead-sync"]);
    expect(wf.templates.map((t) => t.id)).toEqual(["@template.estimate-reminder", "@template.welcome-email", "@template.review-whatsapp"]);
    expect(wf.templates.every((t) => t.contentHash === EDITOR_TEMPLATE_HASH)).toBe(true);
    expect(wf.unapprovedTemplates.map((t) => t.id)).toEqual(["@template.old-promo"]);
    expect(wf.opportunityFields.map((f) => f.id)).toEqual(["@field.opportunity.source-detail"]);
    expect(namesSourceFor(c).tags?.[0].id).toBe("@tag.hot-lead");
  });

  it("keeps references to things missing from the package exactly as written through an edit", () => {
    const c = fixture();
    const f = clone(c.assets.forms[0]);
    f.draft.questions[2].map = "@field.contact.gone";
    f.draft.actions.tagIds = ["@tag.hot-lead", "@tag.gone"];
    const editor = formToEditor(f, c);
    expect(editor.unresolved.map((u) => u.value).sort()).toEqual(["@field.contact.gone", "@tag.gone"]);
    expect(formFromEditor(editor.value, f, c)).toEqual(f.draft);
    const w = clone(c.assets.workflows.find((x) => x.id === "workflow.changed")!);
    w.definition.trigger.filters!.changedFields = ["@field.contact.gone", "email"];
    expect(workflowFromEditor(workflowToEditor(w, c).value, w, c)).toEqual(w.definition);
  });

  it("round-trips every form through the form builder unchanged", () => {
    const c = fixture();
    for (const f of c.assets.forms) {
      const editor = formToEditor(f, c);
      expect(editor.unresolved).toEqual([]);
      expect(JSON.stringify(editor.value)).not.toMatch(/@field\./);
      expect(formFromEditor(editor.value, f, c)).toEqual(f.draft);
    }
    const budget = formToEditor(c.assets.forms[0], c).value.questions.find((q) => q.key === "budget")!;
    expect(budget.map).toBe("custom:budget");
  });

  it("turns a field chosen in the form builder into the package's field reference", () => {
    const c = fixture();
    const f = c.assets.forms[0];
    const editor = formToEditor(f, c).value;
    editor.questions.push({ key: "visit", type: "date", label: "Preferred visit date", required: false, map: "custom:visit_date" });
    editor.actions.tagIds = [...editor.actions.tagIds, standinId("tag.vip")];
    const back = formFromEditor(editor, f, c);
    expect(back.questions.at(-1)!.map).toBe("@field.contact.visit-date");
    expect(back.actions.tagIds).toEqual(["@tag.hot-lead", "@tag.vip"]);
    const next = updateAsset(c, "forms", f.id, (x) => ({ ...x, draft: back }));
    expect(errorsOf(next)).toEqual([]);
  });

  it("the form builder's own checks accept a package form as the builder sees it", () => {
    const c = fixture();
    const options = formOptionsFor(c);
    const ctx = formContextFrom({ tags: options.tags, pipelines: options.pipelines, contactFields: options.contactFields, assignmentRules: options.assignmentRuleRefs.map((r) => ({ ...r, active: true })) });
    const issues = validateDraft(formToEditor(c.assets.forms[0], c).value, ctx, { kind: "form" });
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
  });

  it("round-trips every workflow through the workflow builder unchanged (no nonce, no template binding left behind)", () => {
    const c = fixture();
    for (const w of c.assets.workflows) {
      const editor = workflowToEditor(w, c);
      expect(editor.unresolved).toEqual([]);
      expect(workflowFromEditor(editor.value, w, c)).toEqual(w.definition);
    }
    const inbound = workflowToEditor(c.assets.workflows.find((w) => w.id === "workflow.inbound")!, c).value;
    expect(inbound.trigger.inbound?.nonce).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    const welcome = workflowToEditor(c.assets.workflows[0], c).value.steps.find((s) => s.key === "welcome")!;
    expect((welcome.config as { contentHash?: string }).contentHash).toBe(EDITOR_TEMPLATE_HASH);
    const changed = workflowToEditor(c.assets.workflows.find((w) => w.id === "workflow.changed")!, c).value;
    expect(changed.trigger.filters?.changedFields).toEqual(["cf:budget", "email"]);
  });

  it("the workflow builder's own checks accept a package workflow as the builder sees it", () => {
    const c = fixture();
    const ctx = validationContextOf(workflowOptionsFor(c));
    for (const w of c.assets.workflows.filter((x) => !x.placeholder)) {
      const issues = validateDefinition(workflowToEditor(w, c).value, ctx).filter((i) => i.level === "error");
      expect({ id: w.id, issues }).toEqual({ id: w.id, issues: [] });
    }
  });

  it("a step added in the builder comes back as references", () => {
    const c = fixture();
    const w = c.assets.workflows.find((x) => x.id === "workflow.form-intake")!;
    const def = workflowToEditor(w, c).value;
    def.steps = [
      { ...def.steps[0], next: "send" },
      { key: "send", kind: "send_message", config: { templateId: standinId("template.estimate-reminder"), contentHash: EDITOR_TEMPLATE_HASH, channel: "sms", sendAs: "appointment_setter", businessHoursOnly: true } },
    ] as typeof def.steps;
    const back = workflowFromEditor(def, w, c);
    expect(back.steps[1].config).toEqual({ templateId: "@template.estimate-reminder", channel: "sms", sendAs: "appointment_setter", businessHoursOnly: true });
    expect(errorsOf(updateAsset(c, "workflows", w.id, (x) => ({ ...x, definition: back })))).toEqual([]);
  });

  it("round-trips contact and company filters through the filter builder", () => {
    const c = fixture();
    for (const s of c.assets.smartLists) {
      const entity = s.entity === "company" ? "company" : "contact";
      const b = filterToBuilder(s.filter, entity, c);
      expect(JSON.stringify(b)).not.toMatch(/"field":"@/);
      expect(filterFromBuilder(b, entity, c)).toEqual(s.filter);
    }
    const b = filterToBuilder(c.assets.smartLists[0].filter, "contact", c);
    expect((b.conditions[1] as { field: string }).field).toBe("cf:@field.contact.budget");
    expect(filterOptionsFor(c, "company").customFields.map((f) => f.id)).toEqual(["@field.company.size"]);
  });

  it("edits only the safe subset of the filter language with the builder", () => {
    const c = fixture();
    expect(filterEditProblem(c.assets.smartLists[0].filter, "contact", c)).toBeNull();
    expect(filterEditProblem(c.assets.smartLists[1].filter, "company", c)).toBeNull();
    expect(filterEditProblem({ op: "and", conditions: [] }, "opportunity", c)).toMatch(/Deal Smart Lists/);
    expect(filterEditProblem({ op: "and", conditions: [{ field: "company", op: "is_any_of", value: ["x"] }] }, "contact", c)).toMatch(/doesn't offer/);
    expect(filterEditProblem({ op: "and", conditions: [{ field: "@field.contact.gone", op: "eq", value: 1 }] }, "contact", c)).toMatch(/isn't a contact field/);
    expect(filterEditProblem({ op: "and", conditions: [{ field: "@field.company.size", op: "gt", value: 1 }] }, "contact", c)).toMatch(/isn't a contact field/);
    expect(filterEditProblem({ op: "and", conditions: [{ field: "made_up", op: "eq" }] }, "contact", c)).toMatch(/doesn't offer/);
    const deep = { op: "and" as const, conditions: [{ op: "or" as const, conditions: [{ op: "and" as const, conditions: [{ field: "tags", op: "has_any", value: ["@tag.vip"] }] }] }] };
    expect(filterEditProblem(deep, "contact", c)).toMatch(/two levels/);
  });

  it("checks templates with this Blueprint's values, and treats a value it doesn't define as a note", () => {
    const c = fixture();
    expect(blueprintTemplateCheck(c.assets.messageTemplates[0], c).errors).toEqual([]);
    const t = { ...c.assets.messageTemplates[0], body: "Hi {{contact.first_name}}, see {{custom_values.parking_info}}" };
    const check = blueprintTemplateCheck(t, c);
    expect(check.errors).toEqual([]);
    expect(check.warnings.some((w) => w.code === "unknown_custom_value")).toBe(true);
    expect(blueprintTemplateCheck({ ...t, body: "Hi {{contact.firstname}}" }, c).errors.map((e) => e.code)).toContain("unknown_token");
  });

  it("offers step kinds with notes about what this Blueprint still needs", async () => {
    const { blueprintKindChoices } = await import("@/components/crm-blueprints/editor/bridge");
    const empty = emptyBlueprint({ key: "empty-bp", name: "Empty", description: "", industry: "other" });
    const notes = Object.fromEntries(blueprintKindChoices(workflowOptionsFor(empty)).map((k) => [k.kind, k.note]));
    expect(notes.send_message).toMatch(/message template/);
    expect(notes.n8n).toMatch(/Roles/);
    expect(notes.add_tag).toMatch(/tags/);
    expect(notes.wait).toBeNull();
    const full = Object.fromEntries(blueprintKindChoices(workflowOptionsFor(fixture())).map((k) => [k.kind, k.note]));
    expect(full.send_message).toBeNull();
    expect(full.request_review).toBeNull();
    expect(full.webhook).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The Apply-to-client wizard
// ---------------------------------------------------------------------------

// As the dry run says it: a conflict, decided or not, can take "update" unless told otherwise; nothing else can (apply.ts finish()).
const item = (assetId: string, action: PlanItem["action"], extra: Partial<PlanItem> = {}): PlanItem => ({
  assetId, assetType: extra.assetType ?? "tag", section: extra.section ?? "tags", name: assetId, action, reason: "Because.", existing: null, changes: [], decision: null,
  updatable: action === "conflict" || !!extra.decision, dependsOn: [], unresolved: [], ...extra,
});

const client = (id: string, crmMode: ClientOption["crmMode"], applied: ClientOption["appliedBlueprints"] = [], name = id, industry: string | null = null): ClientOption => ({ id, name, industry, crmMode, appliedBlueprints: applied });

describe("Apply wizard: choosing a client", () => {
  it("refuses GoHighLevel clients with the reason, and notes what a hybrid client keeps", () => {
    expect(clientEligibility({ crmMode: "native" })).toEqual({ ok: true, reason: null, note: null });
    const ghl = clientEligibility({ crmMode: "ghl" });
    expect(ghl.ok).toBe(false);
    expect(ghl.reason).toMatch(/GoHighLevel/);
    expect(clientEligibility({ crmMode: "hybrid" }).note).toMatch(/GoHighLevel manages/);
  });

  it("knows which version a client has and whether an update is available", () => {
    const c = client("a", "native", [{ blueprintId: "bp", name: "BP", version: 2 }, { blueprintId: "other", name: "Other", version: 5 }]);
    expect(clientBlueprintState(c, "bp", 3)).toEqual({ appliedVersion: 2, updateAvailable: true });
    expect(clientBlueprintState(c, "bp", 2)).toEqual({ appliedVersion: 2, updateAvailable: false });
    expect(clientBlueprintState(c, "new", 3)).toEqual({ appliedVersion: null, updateAvailable: false });
  });

  it("searches by name or industry, ignoring case and accents, eligible clients first", () => {
    const list = [client("1", "ghl", [], "Acme Roofing", "home services"), client("2", "native", [], "Café Lumière", "restaurants"), client("3", "native", [], "Beta Roofing")];
    expect(searchClients(list, "roof").map((c) => c.id)).toEqual(["3", "1"]);
    expect(searchClients(list, "cafe lumiere").map((c) => c.id)).toEqual(["2"]);
    expect(searchClients(list, "RESTAURANT").map((c) => c.id)).toEqual(["2"]);
    expect(searchClients(list, "").map((c) => c.id)).toEqual(["3", "2", "1"]);
  });
});

describe("Apply wizard: options", () => {
  it("orders versions newest first and lists the sections a version has", () => {
    const v = (version: number) => ({ id: `v${version}`, version, digest: "d", schemaVersion: 1, changeSummary: "", summaryLines: [], counts: { tags: version, forms: 0 } as never, publishedBy: null, publishedAt: "2026-10-01T00:00:00Z" });
    expect(versionsNewestFirst([v(1), v(3), v(2)]).map((x) => x.version)).toEqual([3, 2, 1]);
    expect(sectionsWithAssets({ tags: 2, forms: 0, workflows: 1 })).toEqual(["tags", "workflows"]);
  });

  it("starts a first application with every section, and an update review with what changed", () => {
    const available = ["tags", "pipelines", "messageTemplates"] as const;
    expect(initialSections(available, null)).toEqual(["tags", "pipelines", "messageTemplates"]);
    expect(initialSections(available, ["messageTemplates"])).toEqual(["messageTemplates"]);
    expect(initialSections(available, ["reports"])).toEqual(["tags", "pipelines", "messageTemplates"]);
  });
});

describe("Apply wizard: the dry run", () => {
  const plan = {
    items: [
      item("tag.a", "create"),
      item("pipeline.sales", "update", { section: "pipelines", assetType: "pipeline" }),
      item("stage.sales.new", "unchanged", { section: "pipelines", assetType: "stage" }),
      item("stage.sales.won", "conflict", { section: "pipelines", assetType: "stage" }),
      // Decided conflicts come back from the dry run as what was decided, carrying the decision (apply.ts conflict()).
      item("template.x", "create", { section: "messageTemplates", assetType: "messageTemplate", decision: "copy" }),
      item("template.y", "skip", { section: "messageTemplates", assetType: "messageTemplate", decision: "skip" }),
      item("form.f", "blocked", { section: "forms", assetType: "form" }),
      item("tag.b", "link"),
      item("tag.c", "skip"),
    ],
  };

  it("groups items by section in package order, keeping nested items with their parent", () => {
    const groups = groupPlan(plan);
    expect(groups.map((g) => g.section)).toEqual(["tags", "pipelines", "forms", "messageTemplates"]);
    expect(groups[1].items.map((i) => i.assetId)).toEqual(["pipeline.sales", "stage.sales.new", "stage.sales.won"]);
    expect(groups[1].counts).toMatchObject({ update: 1, unchanged: 1, conflict: 1 });
    expect(groups[1].undecided).toBe(1);
    expect(groups[3].undecided).toBe(0);
  });

  it("summarizes what confirming does, counting decided conflicts by their decision", () => {
    expect(summarizePlan(plan)).toEqual({ creates: 2, updates: 1, untouched: 4, undecided: 1, blocked: 1 });
    expect(undecidedConflicts(plan).map((i) => i.assetId)).toEqual(["stage.sales.won"]);
    expect(countLines({ create: 2, conflict: 1, skip: 0 })).toEqual([{ action: "create", label: "Create", count: 2 }, { action: "conflict", label: "Needs a decision", count: 1 }]);
  });

  it("sends decisions for items that are still conflicts or that a decision settled, and nothing else", () => {
    expect(decisionsFor(plan, { "stage.sales.won": "update", "tag.a": "copy" })).toEqual({ "stage.sales.won": "update" });
    expect(decisionsFor(null, { "tag.a": "copy" })).toEqual({ "tag.a": "copy" });
    // A decision the dry run took is sent again, so the preview it made stays current (it used to be dropped, leaving the preview stale for good).
    expect(decisionsFor(plan, { "template.x": "copy", "template.y": "skip", "stage.sales.won": "skip" })).toEqual({ "template.x": "copy", "template.y": "skip", "stage.sales.won": "skip" });
  });

  it("forgets a decision the dry run couldn't take, so the select, the dry run and the confirmation agree", () => {
    const after = {
      items: [
        // "Use the Blueprint's version" refused: the field's type can't change in place, so it stays an undecided conflict.
        item("field.contact.service", "conflict", { section: "customFields", assetType: "customField", updatable: false }),
        // A copy that can't be made is blocked.
        item("template.z", "blocked", { section: "messageTemplates", assetType: "messageTemplate" }),
        item("template.x", "create", { section: "messageTemplates", assetType: "messageTemplate", decision: "copy" }),
      ],
    };
    const sent = { "field.contact.service": "update", "template.z": "copy", "template.x": "copy", "tag.gone": "skip" } as const;
    const r = reconcileDecisions(after, sent);
    expect(r.kept).toEqual({ "template.x": "copy" });
    expect(r.dropped).toEqual(["field.contact.service", "template.z", "tag.gone"]);
    // Only items still in the plan are named to the person; one whose section was left out is just dropped.
    expect(r.refused.map((i) => i.assetId)).toEqual(["field.contact.service", "template.z"]);
    expect(reconcileDecisions(after, undefined)).toEqual({ kept: {}, dropped: [], refused: [] });
    // The options planned again keep build()'s key order, so the preview's key matches the wizard's own.
    const opts = { strategy: "add_missing" as const, sections: ["customFields" as const], decisions: { ...sent }, slotMappings: { "member.closer": "u1" } };
    expect(JSON.stringify(withDecisions(opts, r.kept))).toBe(JSON.stringify({ strategy: "add_missing", sections: ["customFields"], decisions: { "template.x": "copy" }, slotMappings: { "member.closer": "u1" } }));
    expect(withDecisions(opts, {})).toEqual({ strategy: "add_missing", sections: ["customFields"], slotMappings: { "member.closer": "u1" } });
    // "Use the Blueprint's version" is offered unless the dry run says the record can't be replaced in place.
    expect(canReplaceInPlace(after.items[0])).toBe(false);
    expect(canReplaceInPlace(after.items[2])).toBe(true);
  });

  it("lists the lead assignment rules a plan adds, for the note that the mapped ones arrive switched on", () => {
    const p = { items: [item("rule.new-leads", "create", { section: "assignmentRules", assetType: "assignmentRule" }), item("rule.old", "unchanged", { section: "assignmentRules", assetType: "assignmentRule" }), item("tag.a", "create")] };
    expect(assignmentRulesAdded(p).map((i) => i.assetId)).toEqual(["rule.new-leads"]);
    expect(RULES_ON_TEXT).toMatch(/arrives switched on and starts assigning/);
  });

  it("takes in remembered role mappings once, never over a choice the person made", () => {
    const slots: SlotMappingView[] = [
      { slotId: "member.closer", kind: "member", label: "Closer", description: null, usedBy: [], candidates: [{ id: "u1", name: "Ana" }], mappedTo: "u1" },
      { slotId: "member.setter", kind: "member", label: "Setter", description: null, usedBy: [], candidates: [{ id: "u1", name: "Ana" }], mappedTo: "u9" },
      { slotId: "n8n.sync", kind: "n8n", label: "Sync", description: null, usedBy: [], candidates: [], mappedTo: null },
    ];
    expect(adoptRememberedMappings(slots, {}, new Set())).toEqual({ "member.closer": "u1" });
    expect(adoptRememberedMappings(slots, {}, new Set(["member.closer"]))).toBeNull();
    expect(adoptRememberedMappings(slots, { "member.closer": "u1" }, new Set())).toBeNull();
    expect(slotMappingsToSend({ "member.closer": "u1", "member.setter": "" })).toEqual({ "member.closer": "u1" });
    // A role the person set to "Leave for the client" is sent as "", so the dry run clears a remembered mapping instead of keeping it.
    expect(slotMappingsToSend({ "member.closer": "u1", "member.setter": "", "n8n.sync": "" }, new Set(["member.setter"]))).toEqual({ "member.closer": "u1", "member.setter": "" });
  });
});

describe("Apply wizard: confirming", () => {
  it("makes URL-safe idempotency keys the apply service accepts", () => {
    const fixed = newIdempotencyKey((n) => new Uint8Array(n).map((_, i) => i * 11));
    expect(fixed).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(newIdempotencyKey((n) => new Uint8Array(n).map((_, i) => i * 11))).toBe(fixed);
    const a = newIdempotencyKey();
    const b = newIdempotencyKey();
    expect(a).toMatch(/^[A-Za-z0-9_-]{16,80}$/);
    expect(a).not.toBe(b);
  });

  it("reuses one key per attempt on a retry, and makes a new one when the plan changes", () => {
    let n = 0;
    const make = () => `key-${++n}-padding-padding`;
    const first = keyForAttempt(null, "d1", make);
    expect(keyForAttempt(first, "d1", make)).toBe(first);
    const second = keyForAttempt(first, "d2", make);
    expect(second).toEqual({ digest: "d2", key: "key-2-padding-padding" });
  });

  it("recognises the refusal that means the workspace changed since the preview", () => {
    expect(isWorkspaceChanged({ ok: false, code: "conflict", error: "The workspace changed since the preview. Preview again." })).toBe(true);
    expect(isWorkspaceChanged({ ok: false, code: "conflict", error: "This client is archived, so its CRM can't be changed." })).toBe(false);
    expect(isWorkspaceChanged({ ok: false, code: "forbidden", error: "Preview again." })).toBe(false);
    expect(isWorkspaceChanged({ ok: true })).toBe(false);
    expect(shortDigest("a".repeat(64))).toBe("aaaaaa…aaaa");
  });

  it("keeps the preview types the wizard renders in step with the apply service", () => {
    const preview: ApplyPreview = {
      plan: { orgId: "o", blueprintId: "b", versionId: "v", version: 1, mode: "initial", options: { strategy: "add_missing" }, items: plan0(), counts: { create: 1, update: 0, link: 0, unchanged: 0, skip: 0, conflict: 0, blocked: 0 }, requirements: [], warnings: [], digest: "0".repeat(64) },
      slots: [], requirementDetails: [], workspace: { mode: "native", switching: false, blockedSections: [] },
    };
    expect(groupPlan(preview.plan)[0].label).toBe("Tags");
  });
});

function plan0(): PlanItem[] {
  return [item("tag.a", "create")];
}

describe("fixture sanity", () => {
  it("is a valid package that uses every section", () => {
    const c = fixture();
    expect(c.format).toBe(BLUEPRINT_FORMAT);
    expect(validateContent(c).errors).toEqual([]);
    for (const s of ASSET_SECTIONS) expect(c.assets[s].length).toBeGreaterThan(0);
    expect(refId("@tag.vip")).toBe("tag.vip");
  });
});

// ---------------------------------------------------------------------------
// The actions behind both screens, against the real services
// ---------------------------------------------------------------------------

describe("Editor and wizard actions (in-memory database)", () => {
  let agency: Awaited<ReturnType<typeof agencyPeople>>;
  beforeAll(async () => {
    agency = await agencyPeople();
  });
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T>(sql, params))).rows;
  const revisionOf = async (id: string) => Number((await q<{ draft_revision: number }>("select draft_revision from crm_blueprints where id = $1", [id]))[0].draft_revision);
  const draftOf = async (id: string) => (await q<{ draft_package: BlueprintContent }>("select draft_package from crm_blueprints where id = $1", [id]))[0].draft_package;

  it("saves the editor's draft with its revision, and refuses a stale one with the conflict the editor recognises", async () => {
    session.user = agency.superAdmin;
    const bp = await insertPublishedBlueprint(smallContent("editor-save"));
    const draft = await draftOf(bp.blueprintId);
    const rev = await revisionOf(bp.blueprintId);
    // An edit made the way the editor makes it: a new tag with a generated reference, used by the workflow's tag step.
    const tag = newAsset(draft, "tags", { name: "Needs follow-up" });
    let next = addAsset(draft, "tags", tag);
    next = updateAsset(next, "workflows", "workflow.welcome", (w) => ({
      ...w, definition: { ...w.definition, steps: w.definition.steps.map((st) => (st.key === "tag" ? { ...st, config: { tagIds: [`@${tag.id}`] } } : st)) },
    }));
    const saved = await saveBlueprintDraftAction(bp.blueprintId, { content: next, revision: rev });
    expect(saved).toEqual({ ok: true, data: { revision: rev + 1, errors: 0, warnings: expect.any(Number) } });
    expect((await draftOf(bp.blueprintId)).assets.tags.map((t) => t.id)).toContain("tag.needs-follow-up");
    // Someone else's save moved the revision on: the editor's older revision is refused.
    const stale = await saveBlueprintDraftAction(bp.blueprintId, { content: next, revision: rev });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.code).toBe("conflict");
      expect(stale.error).toMatch(/someone saved/i);
    }
  });

  it("refuses malformed, oversized and signed-out saves before the library runs", async () => {
    session.user = agency.superAdmin;
    const other = "22222222-2222-4222-8222-222222222222";
    expect(await saveBlueprintDraftAction("not-a-uuid", { content: smallContent(), revision: 1 })).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await saveBlueprintDraftAction(other, { content: null, revision: 1 })).toMatchObject({ ok: false, code: "invalid_input" });
    const huge = clone(smallContent());
    huge.assets.messageTemplates = Array.from({ length: 220 }, (_, i) => ({ ...smallContent().assets.messageTemplates[0], id: `template.t${i}`, key: `t${i}`, body: "y".repeat(4990) }));
    const big = await saveBlueprintDraftAction(other, { content: huge, revision: 1 });
    expect(big).toMatchObject({ ok: false, code: "invalid_input" });
    if (!big.ok) expect(big.error).toMatch(/at most 1000 KB/);
    session.user = null;
    expect(await saveBlueprintDraftAction(other, { content: smallContent(), revision: 1 })).toMatchObject({ ok: false, code: "unauthenticated" });
  });

  it("runs the dry run, applies with an idempotency key, replays a retry, and re-plans when the workspace changed", async () => {
    session.user = agency.superAdmin;
    const client = await crmOrg();
    const bp = await insertPublishedBlueprint(smallContent("wizard-flow"));
    const sections: Array<(typeof ASSET_SECTIONS)[number]> = ["tags", "customFields", "customValues", "pipelines", "messageTemplates", "workflows"];
    const options = { strategy: "add_missing" as const, sections };
    const preview = await previewBlueprintApplyAction(client.org.id, { blueprintId: bp.blueprintId, version: 1, options });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(groupPlan(preview.data.plan).map((g) => g.section)).toEqual(sections);
    expect(summarizePlan(preview.data.plan).creates).toBe(preview.data.plan.items.length);
    expect(preview.data.requirementDetails.map((d) => d.key)).toEqual(expect.arrayContaining(["template_approval", "workflow_activation"]));
    expect(preview.data.workspace.mode).toBe("native");
    // The dry run writes nothing.
    expect(await q("select 1 from crm_blueprint_applications where org_id = $1", [client.org.id])).toEqual([]);

    const attempt = keyForAttempt(null, preview.data.plan.digest);
    const confirm = { blueprintId: bp.blueprintId, version: 1, options, planDigest: preview.data.plan.digest };
    const applied = await applyBlueprintToClientAction(client.org.id, { ...confirm, idempotencyKey: attempt.key });
    expect(applied).toMatchObject({ ok: true, data: { replayed: false, application: { status: "applied", version: 1 } } });
    if (!applied.ok) return;
    // A retry of the same attempt sends the same key and gets the first result back.
    const retry = await applyBlueprintToClientAction(client.org.id, { ...confirm, idempotencyKey: keyForAttempt(attempt, preview.data.plan.digest).key });
    expect(retry).toMatchObject({ ok: true, data: { replayed: true, application: { id: applied.data.application.id } } });
    // A new attempt on the old preview: the workspace changed (everything exists now), so it is refused and the wizard previews again.
    const stale = await applyBlueprintToClientAction(client.org.id, { ...confirm, idempotencyKey: newIdempotencyKey() });
    expect(stale.ok).toBe(false);
    expect(isWorkspaceChanged(stale)).toBe(true);
    const again = await previewBlueprintApplyAction(client.org.id, { blueprintId: bp.blueprintId, version: 1, options });
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(again.data.plan.digest).not.toBe(preview.data.plan.digest);
      expect(summarizePlan(again.data.plan).creates).toBe(0);
    }
    // The client's checklist after applying is evidence-based: nothing is done just because a Blueprint was applied.
    const checklist = await clientBlueprintChecklistAction(client.org.id);
    expect(checklist.ok).toBe(true);
    if (checklist.ok) {
      expect(checklist.data.items.length).toBeGreaterThan(0);
      expect(checklist.data.items.find((i) => i.key === "template_approval")?.status).toBe("pending");
    }
  });

  it("lets assigned staff preview but not apply, and hides other clients from them", async () => {
    const client = await crmOrg();
    const bp = await insertPublishedBlueprint(smallContent("wizard-staff"));
    const input = { blueprintId: bp.blueprintId, version: 1, options: { strategy: "add_missing" as const } };
    session.user = agency.staff;
    expect(await previewBlueprintApplyAction(client.org.id, input)).toMatchObject({ ok: false, code: "not_found" });
    expect(await clientBlueprintChecklistAction(client.org.id)).toMatchObject({ ok: false, code: "not_found" });
    await q("insert into staff_assignments (org_id, user_id) values ($1, $2)", [client.org.id, agency.staff.id]);
    const preview = await previewBlueprintApplyAction(client.org.id, input);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const refused = await applyBlueprintToClientAction(client.org.id, { ...input, planDigest: preview.data.plan.digest, idempotencyKey: newIdempotencyKey() });
    expect(refused).toMatchObject({ ok: false, code: "forbidden" });
    expect(await q("select 1 from crm_blueprint_applications where org_id = $1", [client.org.id])).toEqual([]);
  });

  it("refuses a GoHighLevel client with the reason, and malformed wizard input", async () => {
    session.user = agency.superAdmin;
    const client = await crmOrg();
    const bp = await insertPublishedBlueprint(smallContent("wizard-ghl"));
    await q("insert into crm_workspaces (org_id, mode) values ($1, 'ghl') on conflict (org_id) do update set mode = 'ghl'", [client.org.id]);
    const res = await previewBlueprintApplyAction(client.org.id, { blueprintId: bp.blueprintId, version: 1, options: { strategy: "add_missing" } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/GoHighLevel/);
    expect(await previewBlueprintApplyAction(client.org.id, { blueprintId: bp.blueprintId, version: 0, options: { strategy: "add_missing" } })).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await previewBlueprintApplyAction(client.org.id, { blueprintId: bp.blueprintId, version: 1, options: { strategy: "replace_all" as never } })).toMatchObject({ ok: false, code: "invalid_input" });
    const bad = { blueprintId: bp.blueprintId, version: 1, options: { strategy: "add_missing" as const } };
    expect(await applyBlueprintToClientAction(client.org.id, { ...bad, planDigest: "nope", idempotencyKey: newIdempotencyKey() })).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await applyBlueprintToClientAction(client.org.id, { ...bad, planDigest: "a".repeat(64), idempotencyKey: "short" })).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("tells an update review which sections a newer version changes", async () => {
    session.user = agency.superAdmin;
    const content = smallContent("wizard-update");
    const bp = await insertPublishedBlueprint(content);
    const v2 = clone(content);
    v2.assets.messageTemplates[0].body = `${v2.assets.messageTemplates[0].body} We look forward to working with you.`;
    await publishVersion(bp.blueprintId, v2);
    expect(await blueprintChangedSectionsAction(bp.blueprintId, 1, 2)).toEqual({ ok: true, data: ["messageTemplates"] });
    expect(await blueprintChangedSectionsAction(bp.blueprintId, 2, 2)).toEqual({ ok: true, data: [] });
  });
});
