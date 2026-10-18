// CRM Blueprint package format v1: the contract every Blueprint service builds on. Schema strictness, the logical ↔ native reference mapping
// for every asset type (a package captured from one workspace and applied to another reproduces the same configuration), validation of
// dangling and mistyped references, unsafe content, secrets and IDs, digest stability, diffs, the format migration registry, setup
// requirements, the compatibility report, and the authorization helpers. Synthetic data only: nothing here contacts a provider.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { draftSchema, validateDraft, formContextFrom } from "@/lib/crm/forms/spec";
import { parseDefinition } from "@/lib/crm/workflow/spec";
import { sha256Hex } from "@/lib/crm/workflow/sha256";
import { canonicalJson } from "@/lib/crm/blueprints/canonical";
import { contentSchema, packageFileSchema, LIMITS } from "@/lib/crm/blueprints/schema";
import { validateContent, assertValidContent, scanText, BlueprintValidationError, type ValidationIssue } from "@/lib/crm/blueprints/validate";
import {
  REFERENCE_FIELDS, assetRefs, dependencyGraph, dependents, listAssets, rewriteValueTokens, sitePattern, slotUsage, topologicalOrder, valueTokenKeys, withDependencies,
} from "@/lib/crm/blueprints/refs";
import {
  copyKey, copyName, fromNative, identityKey, nativeProjection, suggestLogicalId, toNative, type ApplyResolver, type CaptureResolver,
} from "@/lib/crm/blueprints/native";
import { changedSections, diffContents } from "@/lib/crm/blueprints/diff";
import { FormatError, migrateToCurrent } from "@/lib/crm/blueprints/migrate";
import { computeManifest, deriveRequirements, modulesOf, requirementDetails, totalAssets } from "@/lib/crm/blueprints/requirements";
import { buildPackageFile, packageDigest, readPackage, serializePackage } from "@/lib/crm/blueprints/package";
import { compatibilityBadge, enforcePlaceholderRule, makeReport, reportForContent } from "@/lib/crm/blueprints/report";
import { placeholderForm, placeholderTemplate, placeholderWorkflow, slot } from "@/lib/crm/blueprints/builders";
import {
  ASSET_SECTIONS, BLUEPRINT_FORMAT, BLUEPRINT_MAX_BYTES, LOGICAL_ID, REQUIREMENT_KEYS, emptyBlueprint, isRef, typeOfId,
  type AssetType, type AssetTypeMap, type BlueprintContent, type NativeTypeMap,
} from "@/lib/crm/blueprints/types";
import {
  BLUEPRINT_ACTIONS, BLUEPRINT_PERMISSIONS, assetHash, assertIdempotencyKey, authorizeBlueprintAction, canBlueprint, canDoBlueprint, contentDigest, jsonHash,
  lockBlueprintUser, lockClientForBlueprint, nativeHash, needBlueprint, needBlueprintAction, newInboundNonce, planDigest, sha256,
} from "@/server/crm/blueprints/access";
import { roleHasPermission } from "@/lib/permissions";
import { agencyUser, createOrg, createUser } from "./support/fixtures";

const TEST_STRIPE_KEY = `sk_live_${"x".repeat(10)}`;

// ---------------------------------------------------------------------------
// A package that uses every asset type and every reference location
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

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const codes = (issues: ValidationIssue[]) => issues.map((i) => i.code);
const hasIssue = (issues: ValidationIssue[], code: string, pathPart?: string) => issues.some((i) => i.code === code && (!pathPart || i.path.includes(pathPart)));

/** Every string anywhere in a value. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => strings(x, out));
  return out;
}

// ---------------------------------------------------------------------------
// Two synthetic workspaces: logical IDs ↔ workspace IDs
// ---------------------------------------------------------------------------

interface Workspace {
  apply: ApplyResolver;
  capture: CaptureResolver;
  ids: Map<string, string>;
}

function workspace(content: BlueprintContent, seed: string): Workspace {
  const ids = new Map<string, string>();
  const reverse = new Map<string, string>();
  let n = 0;
  const all = [...listAssets(content).map((e) => e.id), ...content.slots.map((s) => s.id)];
  for (const id of all) {
    const hex = createHash("sha256").update(`${seed}:${id}:${n++}`).digest("hex");
    const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    ids.set(id, uuid);
    reverse.set(uuid, id);
  }
  const fieldKeys = new Map(content.assets.customFields.map((f) => [f.id, f.key]));
  const fieldByKey = new Map(content.assets.customFields.map((f) => [`${f.entity}:${f.key}`, f.id]));
  return {
    ids,
    apply: {
      nativeId: (id) => ids.get(id) ?? null,
      fieldKey: (id) => fieldKeys.get(id) ?? null,
      valueKey: (k) => k,
      templateHash: (id) => createHash("sha256").update(`${seed}:hash:${id}`).digest("hex"),
      newNonce: () => `nonce-${seed}-0123456789abcdef`,
    },
    capture: {
      logicalId: (target, nativeId) => {
        const id = reverse.get(nativeId);
        return id && (target === "record" ? false : typeOfId(id) === target) ? id : null;
      },
      fieldByKey: (entity, key) => fieldByKey.get(`${entity}:${key}`) ?? null,
      valueKey: (k) => k,
    },
  };
}

/** Applies every top-level asset (and its children) to a workspace, then captures it back. */
function roundTrip(content: BlueprintContent, ws: Workspace) {
  const records = new Map<string, unknown>();
  const back = new Map<string, unknown>();
  const unresolved: string[] = [];
  for (const e of listAssets(content)) {
    if (e.parentId) continue;
    if (e.type === "pipeline" || e.type === "calendar") {
      const childType = e.type === "pipeline" ? "stage" : "appointmentType";
      const children = e.type === "pipeline" ? (e.asset as AssetTypeMap["pipeline"]).stages : (e.asset as AssetTypeMap["calendar"]).types;
      const parent = toNative(e.type, e.asset as never, ws.apply);
      const kids = children.map((c) => ({ id: c.id, native: toNative(childType, c as never, ws.apply, { parentId: ws.ids.get(e.id)! }) }));
      unresolved.push(...parent.unresolved.map((u) => `${e.id}:${u.path}`), ...kids.flatMap((k) => k.native.unresolved.map((u) => `${k.id}:${u.path}`)));
      records.set(e.id, { parent: parent.value, children: kids.map((k) => k.native.value) });
      const captured = fromNative(e.type, e.id, parent.value as never, ws.capture, { children: kids.map((k) => ({ id: k.id, record: k.native.value as never })) });
      unresolved.push(...captured.unresolved.map((u) => `${e.id}:capture:${u.path}`));
      back.set(e.id, captured.value);
    } else {
      const native = toNative(e.type, e.asset as never, ws.apply);
      unresolved.push(...native.unresolved.map((u) => `${e.id}:${u.path}`));
      records.set(e.id, native.value);
      const captured = fromNative(e.type, e.id, native.value as never, ws.capture, { placeholder: Boolean((e.asset as { placeholder?: boolean }).placeholder) });
      unresolved.push(...captured.unresolved.map((u) => `${e.id}:capture:${u.path}`));
      back.set(e.id, captured.value);
    }
  }
  return { records, back, unresolved };
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe("package schema", () => {
  it("accepts the full fixture and validates it without errors", () => {
    const r = validateContent(fixture());
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    // Placeholders and drafts that a workspace still has to finish are warnings, never errors.
    expect(r.warnings.some((w) => w.assetId === "workflow.legacy")).toBe(true);
    expect(r.warnings.some((w) => w.assetId === "form.legacy-survey")).toBe(true);
    expect(r.warnings.some((w) => w.assetId === "form.estimate-request")).toBe(false);
  });

  it("refuses unknown keys everywhere: top level, assets, embedded drafts, step configs and filters", () => {
    const cases: Array<(c: BlueprintContent) => void> = [
      (c) => Object.assign(c, { extra: true }),
      (c) => Object.assign(c.assets, { contacts: [] }),
      (c) => Object.assign(c.assets.tags[0], { ghlId: "abc" }),
      (c) => Object.assign(c.assets.forms[0].draft.questions[0], { onclick: "x" }),
      (c) => Object.assign(c.assets.forms[0].draft.actions, { webhookUrl: "https://example.com" }),
      (c) => Object.assign(c.assets.workflows[0].definition.steps[1].config, { script: "run()" }),
      (c) => Object.assign(c.assets.workflows[0].definition.trigger, { code: "x" }),
      (c) => Object.assign((c.assets.smartLists[0].filter.conditions[0] as object), { sql: "1=1" }),
      (c) => Object.assign(c.assets.reports[0].config.filters, { campaign: "@tag.vip" }),
      (c) => Object.assign(c.settings, { apiKey: "x" }),
    ];
    for (const mutate of cases) {
      const c = fixture();
      mutate(c);
      expect(contentSchema.safeParse(c).success, mutate.toString()).toBe(false);
    }
  });

  it("refuses a workspace or GoHighLevel ID where a reference belongs, and references of the wrong type", () => {
    const c = fixture();
    c.assets.forms[0].draft.actions.tagIds = ["0b2c3d4e-1111-4222-8333-444455556666"];
    expect(contentSchema.safeParse(c).success).toBe(false);
    const d = fixture();
    d.assets.forms[0].draft.actions.tagIds = ["@pipeline.sales"];
    const r = validateContent(d);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.path.includes("tagIds") && /reference to a tag/.test(e.message))).toBe(true);
    const w = fixture();
    (w.assets.workflows[0].definition.steps[0].config as Record<string, unknown>).templateId = "@tag.vip";
    expect(validateContent(w).ok).toBe(false);
    const nonce = fixture();
    (nonce.assets.workflows[6].definition.trigger.inbound as Record<string, unknown>).nonce = "abcdefghijklmnopqrstuvwxyz";
    expect(validateContent(nonce).ok).toBe(false);
    const hash = fixture();
    (hash.assets.workflows[0].definition.steps[0].config as Record<string, unknown>).contentHash = "a".repeat(64);
    expect(validateContent(hash).ok).toBe(false);
  });

  it("bounds every list and string", () => {
    const c = fixture();
    c.assets.tags = Array.from({ length: LIMITS.tags + 1 }, (_, i) => ({ id: `tag.t${i}`, name: `T${i}`, color: "#64748b", description: null, folder: null }));
    expect(contentSchema.safeParse(c).success).toBe(false);
    const d = fixture();
    d.assets.tags[0].name = "x".repeat(61);
    expect(contentSchema.safeParse(d).success).toBe(false);
    const e = fixture();
    e.assets.customValues[0].value = "x".repeat(2001);
    expect(contentSchema.safeParse(e).success).toBe(false);
  });

  it("keeps the native rules the CRM itself enforces", () => {
    const pipeline = fixture();
    pipeline.assets.pipelines[0].stages.push({ id: "stage.sales.won2", name: "Won again", kind: "won", probability: null, color: null });
    expect(contentSchema.safeParse(pipeline).success).toBe(false);
    const type = fixture();
    type.assets.calendars[0].types[0].requireEmail = false;
    expect(contentSchema.safeParse(type).success).toBe(false);
    const tz = fixture();
    tz.assets.calendars[0].timezone = "Mars/Olympus";
    expect(contentSchema.safeParse(tz).success).toBe(false);
    const wa = fixture();
    wa.assets.messageTemplates[1].whatsapp = { name: "x", language: "en", category: "utility" };
    expect(contentSchema.safeParse(wa).success).toBe(false);
    const step = fixture();
    (step.assets.workflows[0].definition.steps[1].config as Record<string, unknown>).unit = "weeks";
    expect(contentSchema.safeParse(step).success).toBe(false);
  });

  it("only knows iAcquire packages of format version 1", () => {
    expect(contentSchema.safeParse({ ...fixture(), format: "ghl.snapshot" }).success).toBe(false);
    expect(contentSchema.safeParse({ ...fixture(), schemaVersion: 2 }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// References: logical → native → logical for every asset type
// ---------------------------------------------------------------------------

describe("reference mapping", () => {
  it("round-trips every asset type (logical → native → logical) without loss", () => {
    const c = fixture();
    const ws = workspace(c, "a");
    const { back, unresolved } = roundTrip(c, ws);
    expect(unresolved).toEqual([]);
    for (const e of listAssets(c)) {
      if (e.parentId) continue;
      const expected = clone(e.asset) as unknown as Record<string, unknown>;
      // The one documented, lossy rule: a fixed-link type without a link starts without one (checked below).
      if (e.id === "calendar.consults") (expected.types as Array<Record<string, unknown>>)[0].meetingProvider = "none";
      expect(back.get(e.id), e.id).toEqual(expected);
    }
    const types = new Set(listAssets(c).map((e) => e.type));
    expect([...types].sort()).toEqual([
      "appointmentType", "assignmentRule", "calendar", "customField", "customValue", "folder", "form", "messageTemplate", "pipeline", "report", "smartList", "stage", "tag", "workflow",
    ]);
  });

  it("writes native formats: workspace IDs and native encodings in every slot, no references left", () => {
    const c = fixture();
    const ws = workspace(c, "a");
    const id = (x: string) => ws.ids.get(x)!;
    const { records } = roundTrip(c, ws);
    for (const [assetId, rec] of records) for (const s of strings(rec)) expect(isRef(s), `${assetId}: ${s}`).toBe(false);

    const form = records.get("form.estimate-request") as NativeTypeMap["form"];
    expect(draftSchema.safeParse(form.draft).success).toBe(true);
    expect(form.folderId).toBe(id("folder.form.website"));
    expect(form.draft.actions.tagIds).toEqual([id("tag.hot-lead")]);
    expect(form.draft.actions.opportunity).toMatchObject({ pipelineId: id("pipeline.sales"), stageId: id("stage.sales.new") });
    expect(form.draft.actions.assignmentRuleId).toBe(id("rule.new-leads"));
    expect(form.draft.questions.map((q) => q.map ?? null)).toEqual(["contact.first_name", "contact.email", "custom:budget", "custom:service", null]);
    // The native validator accepts the resolved draft against the same workspace.
    const ctx = formContextFrom({
      tags: c.assets.tags.map((t) => ({ id: id(t.id) })),
      pipelines: c.assets.pipelines.map((p) => ({ id: id(p.id), stages: p.stages.map((s) => ({ id: id(s.id), kind: s.kind })) })),
      contactFields: c.assets.customFields.filter((f) => f.entity === "contact").map((f) => ({ key: f.key, type: f.type, label: f.label, options: f.options })),
      assignmentRules: c.assets.assignmentRules.map((r) => ({ id: id(r.id), entity: r.entity })),
    });
    expect(validateDraft(form.draft, ctx, { kind: "form" }).filter((i) => i.level === "error")).toEqual([]);

    const wf = records.get("workflow.new-lead") as NativeTypeMap["workflow"];
    const parsed = parseDefinition(wf.draft);
    expect(parsed.issues).toEqual([]);
    expect(parsed.ok).toBe(true);
    const steps = Object.fromEntries(wf.draft.steps.map((s) => [s.key, s.config as Record<string, unknown>]));
    expect(wf.draft.trigger.filters?.tagIds).toEqual([id("tag.hot-lead")]);
    expect(wf.draft.trigger.contactFilter?.conditions[0]).toMatchObject({ field: `cf:${id("field.contact.budget")}` });
    expect(steps.welcome).toMatchObject({ templateId: id("template.welcome-email"), contentHash: ws.apply.templateHash("template.welcome-email") });
    expect(steps.field.field).toBe(`cf:${id("field.contact.service")}`);
    expect(steps.assign.ruleId).toBe(id("rule.new-leads"));
    expect(steps.notify.userIds).toEqual([id("member.dispatcher")]);
    expect(steps.sync.mappingId).toBe(id("n8n.lead-sync"));
    expect(steps.hook.subscriptionId).toBe(id("webhook.crm-export"));
    expect(steps.task.userId).toBe(id("member.closer"));
    expect(steps.datewait.fieldId).toBe(id("field.contact.visit-date"));
    expect(steps.move).toMatchObject({ pipelineId: id("pipeline.sales"), stageId: id("stage.sales.quoted") });
    expect((steps.check.filter as { conditions: Array<{ field: string; value: unknown }> }).conditions.map((x) => [x.field, x.value])).toEqual([["tags", [id("tag.quote-sent")]], ["owner", [id("member.closer")]], [`cf:${id("field.contact.budget")}`, 100]]);

    const changed = records.get("workflow.changed") as NativeTypeMap["workflow"];
    expect(changed.draft.trigger.filters?.changedFields).toEqual(["cf:budget", "email"]);
    const inbound = records.get("workflow.inbound") as NativeTypeMap["workflow"];
    expect(inbound.draft.trigger.inbound).toEqual({ match: "email_or_phone", createContact: true, nonce: "nonce-a-0123456789abcdef" });
    expect(parseDefinition(inbound.draft).ok).toBe(true);
    for (const w of c.assets.workflows) expect(parseDefinition((records.get(w.id) as NativeTypeMap["workflow"]).draft).definition, w.id).not.toBeNull();

    const list = records.get("list.hot-leads") as NativeTypeMap["smartList"];
    expect(list.columns).toEqual(["phone", `cf:${id("field.contact.budget")}`, "tags"]);
    const group = list.filter.conditions[2] as { conditions: Array<{ value: unknown }> };
    expect(group.conditions.map((x) => x.value)).toEqual([[id("member.closer")], [id("stage.sales.quoted")], id("pipeline.sales")]);

    const rule = records.get("rule.new-leads") as NativeTypeMap["assignmentRule"];
    expect(rule).toMatchObject({ fallbackUserId: id("member.dispatcher"), members: [{ userId: id("member.closer"), weight: 1, priority: 50 }] });
    expect(rule.conditions).toMatchObject({ reassignOwned: false, conditions: [{ value: [id("tag.hot-lead")] }] });

    const report = records.get("report.weekly-sales") as NativeTypeMap["report"];
    expect(report).toMatchObject({ report: "overview", config: { filters: { member: id("member.closer"), pipeline: id("pipeline.sales"), range: "7d" } } });
    expect((records.get("report.leads") as NativeTypeMap["report"]).report).toBe("leads");

    const cal = records.get("calendar.estimates") as { parent: NativeTypeMap["calendar"]; children: Array<NativeTypeMap["appointmentType"]> };
    expect(cal.parent).toMatchObject({ hostIds: [id("member.closer")], folderId: id("folder.calendar.field"), timezone: "America/New_York" });
    expect(cal.children.every((t) => t.calendarId === id("calendar.estimates"))).toBe(true);
    const stages = (records.get("pipeline.sales") as { children: Array<NativeTypeMap["stage"]> }).children;
    expect(stages.map((s) => s.name)).toEqual(["New", "Quoted", "Won", "Lost"]);
    expect(stages.every((s) => s.pipelineId === id("pipeline.sales"))).toBe(true);
  });

  it("stores a fixed-link meeting without a link as no meeting, with a note", () => {
    const c = fixture();
    const t = c.assets.calendars[1].types[0];
    const r = toNative("appointmentType", t, workspace(c, "a").apply, { parentId: "11111111-1111-4111-8111-111111111111" });
    expect(r.value.meetingProvider).toBe("none");
    expect(r.notes[0]).toMatch(/meeting link/);
    expect(deriveRequirements(c)).toContain("meeting_link");
  });

  it("captured in one workspace and applied to another, a package reproduces the same configuration", () => {
    const c = fixture();
    const a = workspace(c, "a");
    const b = workspace(c, "b");
    const fromA = roundTrip(c, a);
    // Capture from A's native records, apply the captured assets to B, and read B back.
    const captured = clone({ ...c });
    for (const section of ASSET_SECTIONS) {
      (captured.assets[section] as unknown[]) = (c.assets[section] as Array<{ id: string }>).map((x) => fromA.back.get(x.id)!);
    }
    const fromB = roundTrip(captured, b);
    for (const [id, asset] of fromB.back) expect(asset, id).toEqual(fromA.back.get(id));
    // Same configuration, each workspace's own IDs.
    const formA = fromA.records.get("form.estimate-request") as NativeTypeMap["form"];
    const formB = fromB.records.get("form.estimate-request") as NativeTypeMap["form"];
    expect(formA.draft.actions.tagIds).not.toEqual(formB.draft.actions.tagIds);
    expect(formA.draft.questions).toEqual(formB.draft.questions);
  });

  it("reports what can't be resolved instead of guessing, and keeps native drafts readable", () => {
    const c = fixture();
    const ws = workspace(c, "a");
    const missing = new Set(["tag.hot-lead", "pipeline.sales", "member.closer", "n8n.lead-sync"]);
    const partial: ApplyResolver = { ...ws.apply, nativeId: (id) => (missing.has(id) ? null : ws.apply.nativeId(id)) };
    const form = toNative("form", c.assets.forms[0], partial);
    expect(form.value.draft.actions.tagIds).toEqual([]);
    expect(form.value.draft.actions.opportunity?.pipelineId).toBe("");
    expect(draftSchema.safeParse(form.value.draft).success).toBe(true);
    expect(form.unresolved).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "draft.actions.tagIds[0]", target: "tag", required: false }),
      expect.objectContaining({ path: "draft.actions.opportunity.pipelineId", target: "pipeline", required: true }),
    ]));
    const wf = toNative("workflow", c.assets.workflows[0], partial);
    const steps = Object.fromEntries(wf.value.draft.steps.map((s) => [s.key, s.config as Record<string, unknown>]));
    expect("userId" in steps.task).toBe(false);
    expect("mappingId" in steps.sync).toBe(false);
    expect(wf.value.draft.trigger.filters?.tagIds).toEqual([]);
    // Members: the contact filter's owner, the branch's owner, the task's assignee. Pipelines: the contact filter, create deal, move stage.
    expect(wf.unresolved.map((u) => u.target).sort()).toEqual(["member", "member", "member", "n8n", "pipeline", "pipeline", "pipeline", "tag", "tag"]);
    expect(wf.unresolved.filter((u) => u.required).map((u) => u.path)).toEqual(expect.arrayContaining(["definition.steps[3].config.pipelineId", "definition.steps[9].config.mappingId"]));
    // A missing template binding is reported too, and the step stays incomplete rather than bound to the wrong wording.
    const noHash = toNative("workflow", c.assets.workflows[0], { ...ws.apply, templateHash: () => null });
    expect(noHash.unresolved.some((u) => u.path.endsWith("contentHash"))).toBe(true);
    expect("contentHash" in (noHash.value.draft.steps[0].config as object)).toBe(false);
    const stage = toNative("stage", c.assets.pipelines[0].stages[0], ws.apply);
    expect(stage.unresolved).toEqual([expect.objectContaining({ path: "parent", required: true })]);
  });

  it("never captures customer records, people without a slot, nonces or template bindings", () => {
    const c = fixture();
    const ws = workspace(c, "a");
    const native = toNative("smartList", c.assets.smartLists[0], ws.apply).value;
    native.filter.conditions.push({ field: "company", op: "is_any_of", value: ["22222222-2222-4222-8222-222222222222"] });
    const captured = fromNative("smartList", "list.hot-leads", native, ws.capture);
    expect(captured.unresolved).toEqual([expect.objectContaining({ target: "record", required: true })]);
    expect(strings(captured.value).some((s) => /2222/.test(s))).toBe(false);
    const report = toNative("report", c.assets.reports[0], ws.apply).value;
    (report.config.filters as Record<string, unknown>).campaign = "33333333-3333-4333-8333-333333333333";
    const r = fromNative("report", "report.weekly-sales", report, ws.capture);
    expect("campaign" in r.value.config.filters).toBe(false);
    expect(r.unresolved).toEqual([expect.objectContaining({ target: "record" })]);
    const stranger = toNative("calendar", c.assets.calendars[0], ws.apply).value;
    stranger.hostIds.push("44444444-4444-4444-8444-444444444444");
    expect(fromNative("calendar", "calendar.estimates", stranger, ws.capture).unresolved).toEqual([expect.objectContaining({ target: "member", path: "hosts[1]" })]);
    const wf = toNative("workflow", c.assets.workflows[6], ws.apply).value;
    const back = fromNative("workflow", "workflow.inbound", wf, ws.capture).value;
    expect(back.definition.trigger.inbound).toEqual({ match: "email_or_phone", createContact: true });
    const sends = fromNative("workflow", "workflow.new-lead", toNative("workflow", c.assets.workflows[0], ws.apply).value, ws.capture).value;
    expect(strings(sends).some((s) => /^[0-9a-f]{64}$/.test(s))).toBe(false);
  });

  it("documents every reference location it maps", () => {
    const c = fixture();
    const documented = new Set(Object.entries(REFERENCE_FIELDS).flatMap(([type, rows]) => rows.map((r) => `${type}|${r.path}|${r.target}`)));
    const found = new Set<string>();
    for (const e of listAssets(c)) for (const r of assetRefs(e)) found.add(`${e.type}|${sitePattern(r.site.path)}|${r.site.target}`);
    for (const f of found) expect(documented.has(f), f).toBe(true);
    // The fixture exercises every documented location (a customer record is documented only to say it never travels).
    const unused = [...documented].filter((d) => !found.has(d) && !d.endsWith("|record"));
    expect(unused).toEqual([]);
  });

  it("rewrites configuration value tokens only when a workspace's key differs", () => {
    expect(valueTokenKeys("{{custom_values.a}} {{ custom_values.b }} {{contact.first_name}} {{custom_values.a}}")).toEqual(["a", "b"]);
    expect(rewriteValueTokens("Hi {{ custom_values.a }} / {{custom_values.b}}", (k) => (k === "a" ? "a_2" : null))).toBe("Hi {{custom_values.a_2}} / {{custom_values.b}}");
    const c = fixture();
    const ws = workspace(c, "a");
    const t = toNative("messageTemplate", c.assets.messageTemplates[0], { ...ws.apply, valueKey: (k) => (k === "booking_link" ? "booking_link_2" : k) });
    expect(t.value.body).toContain("{{custom_values.booking_link_2}}");
    const w = toNative("workflow", c.assets.workflows[0], { ...ws.apply, valueKey: (k) => (k === "office_hours" ? "hours" : k) });
    expect(JSON.stringify(w.value.draft)).toContain("{{custom_values.hours}}");
  });

  it("gives every asset one identity, the same for the asset and its workspace record", () => {
    const c = fixture();
    const ws = workspace(c, "a");
    for (const e of listAssets(c)) {
      const opts = e.parentId ? { parentId: ws.ids.get(e.parentId)! } : {};
      const rec = toNative(e.type, e.asset as never, ws.apply, opts).value as never;
      expect(identityKey(e.type, rec), e.id).toBe(identityKey(e.type, e.asset as never));
    }
    expect(identityKey("tag", { name: "  Hot   LEAD " })).toBe(identityKey("tag", { name: "hot lead" }));
    expect(identityKey("customField", { entity: "contact", key: "budget" })).not.toBe(identityKey("customField", { entity: "company", key: "budget" }));
    expect(copyName("tag", "Hot lead", new Set(["hot lead (blueprint)"]))).toBe("Hot lead (Blueprint 2)");
    expect(copyKey("form", "estimate-request", new Set(["estimate-request-2"]))).toBe("estimate-request-3");
    expect(copyKey("customField", "budget", new Set())).toBe("budget_2");
    const taken = new Set<string>(["tag.hot-lead"]);
    const id = suggestLogicalId("tag", { name: "Hot Lead!" }, taken);
    expect(id).toBe("tag.hot-lead-2");
    expect(LOGICAL_ID.test(suggestLogicalId("appointmentType", { name: "A very long appointment type name ".repeat(4) }, new Set(), "a-very-long-calendar-name-that-goes-on-and-on"))).toBe(true);
    expect(LOGICAL_ID.test(suggestLogicalId("member", { label: "Team member 1" }, new Set()))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("validation", () => {
  it("finds dangling, mistyped and misplaced references", () => {
    const c = fixture();
    c.assets.forms[0].draft.actions.tagIds = ["@tag.nope"];
    c.assets.smartLists[0].filter.conditions[0] = { field: "tags", op: "has_any", value: ["@pipeline.sales"] };
    (c.assets.workflows[0].definition.steps[4].config as Record<string, unknown>).stageId = "@stage.service.scheduled";
    c.assets.tags[1].folder = "@folder.form.website";
    c.assets.forms[0].draft.questions[2].map = "@field.company.size";
    (c.assets.workflows[0].definition.steps[8].config as Record<string, unknown>).userIds = ["@member.ghost"];
    c.assets.reports[0].config.filters.pipeline = "@pipeline.gone";
    const r = validateContent(c);
    expect(r.ok).toBe(false);
    expect(hasIssue(r.errors, "missing_ref", "assets.forms[0].draft.actions.tagIds[0]")).toBe(true);
    expect(hasIssue(r.errors, "wrong_type", "assets.smartLists[0].filter.conditions[0].value[0]")).toBe(true);
    expect(hasIssue(r.errors, "stage_not_in_pipeline", "assets.workflows[0].definition.steps[4].config.stageId")).toBe(true);
    expect(hasIssue(r.errors, "wrong_folder_kind", "assets.tags[1].folder")).toBe(true);
    expect(hasIssue(r.errors, "wrong_entity", "assets.forms[0].draft.questions[2].map")).toBe(true);
    expect(hasIssue(r.errors, "undeclared_slot", "userIds[0]")).toBe(true);
    expect(hasIssue(r.errors, "missing_ref", "assets.reports[0].config.filters.pipeline")).toBe(true);
    expect(r.errors.every((e) => e.assetId)).toBe(true);
  });

  it("refuses customer records and database IDs in filters", () => {
    const c = fixture();
    c.assets.smartLists[0].filter.conditions.push({ field: "company", op: "is_any_of", value: ["@tag.vip"] });
    c.assets.smartLists[1].filter.conditions.push({ field: "tags", op: "has_any", value: ["9f1c2d3e-aaaa-4bbb-8ccc-ddddeeeeffff"] });
    const r = validateContent(c);
    expect(hasIssue(r.errors, "not_portable")).toBe(true);
    expect(hasIssue(r.errors, "invalid_ref", "assets.smartLists[1]")).toBe(true);
    expect(hasIssue(r.errors, "database_id", "assets.smartLists[1]")).toBe(true);
  });

  it("checks filters against the CRM's own catalog", () => {
    const c = fixture();
    c.assets.smartLists[0].filter.conditions.push({ field: "favourite_colour", op: "equals", value: "red" });
    c.assets.smartLists[0].filter.conditions.push({ field: "lead_status", op: "in", value: ["hot"] });
    c.assets.smartLists[0].filter.conditions.push({ field: "@field.contact.budget", op: "contains", value: "x" });
    c.assets.assignmentRules[0].conditions.conditions.push({ field: "owner", op: "is_me" });
    const r = validateContent(c);
    expect(r.errors.filter((e) => e.code === "filter").length).toBeGreaterThanOrEqual(4);
  });

  it("keeps identities unique", () => {
    const c = fixture();
    c.assets.tags.push({ id: "tag.hot-lead-copy", name: "hot LEAD", color: "#64748b", description: null, folder: null });
    c.assets.customFields.push(field("field.contact.budget-2", "contact", "budget", "Budget again", "number"));
    c.assets.forms.push({ ...clone(c.assets.forms[1]), id: "form.other" });
    c.assets.pipelines[1].isDefault = true;
    c.assets.calendars[0].types.push(apptype("apptype.estimates.onsite-2", "ON-SITE estimate"));
    c.assets.tags.push({ id: "tag.vip", name: "Another", color: "#64748b", description: null, folder: null });
    const r = validateContent(c);
    expect(r.errors.filter((e) => e.code === "duplicate_name").length).toBeGreaterThanOrEqual(4);
    expect(hasIssue(r.errors, "duplicate_default")).toBe(true);
    expect(hasIssue(r.errors, "duplicate_id")).toBe(true);
  });

  it("runs the CRM's own form, workflow and template rules", () => {
    const c = fixture();
    c.assets.forms[0].draft.questions[1].key = "first_name";
    c.assets.workflows[1].definition.steps[0].branches = { yes: "nowhere", no: null };
    c.assets.messageTemplates[0].body = "Hi {{contact.nickname}}";
    c.assets.messageTemplates[1].body = "Hi {{custom_values.unknown_value}}";
    const r = validateContent(c);
    expect(hasIssue(r.errors, "native_form", "assets.forms[0]")).toBe(true);
    expect(hasIssue(r.errors, "native_workflow", "assets.workflows[1]")).toBe(true);
    expect(hasIssue(r.errors, "native_template", "assets.messageTemplates[0]")).toBe(true);
    // A value the package doesn't define may exist in the workspace: a warning.
    expect(hasIssue(r.warnings, "unknown_value_token", "assets.messageTemplates[1]")).toBe(true);
    // Draft completeness (a form without consent) is a warning: it can't be published until fixed.
    const d = fixture();
    d.assets.forms[0].draft.consent.text = "";
    const rd = validateContent(d);
    expect(rd.ok).toBe(true);
    expect(rd.warnings.some((w) => w.code === "native_form" && /published/.test(w.message))).toBe(true);
  });

  it("refuses code, credentials and IDs in any text, and flags personal details", () => {
    const unsafe: Array<(c: BlueprintContent) => void> = [
      (c) => { c.assets.messageTemplates[1].body = "Hello <script>alert(1)</script>"; },
      (c) => { c.assets.tags[0].description = "<img src=x onerror=alert(1)>"; },
      (c) => { c.assets.forms[0].draft.actions.after = { kind: "redirect", url: "javascript:alert(1)" }; },
      (c) => { c.assets.workflows[0].definition.steps[15].config.body = "Run ${process.env.SECRET}"; },
      (c) => { c.assets.customValues[0].value = "{% raw %}"; },
    ];
    for (const mutate of unsafe) {
      const c = fixture();
      mutate(c);
      const r = validateContent(c);
      expect(r.ok, mutate.toString()).toBe(false);
      expect(codes(r.errors), mutate.toString()).toContain("unsafe");
    }
    const secrets = [
      TEST_STRIPE_KEY,
      "pit-0123abcd-1111-2222-3333-444455556666",
      "Bearer abcdefghijklmnopqrstuvwxyz012345",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "password: hunter2hunter2",
      "AKIAABCDEFGHIJKLMNOP",
    ];
    for (const s of secrets) {
      const c = fixture();
      c.assets.customValues[0].value = s;
      const r = validateContent(c);
      expect(codes(r.errors), s).toContain("secret");
      expect(r.errors.find((e) => e.code === "secret")?.assetId).toBe("value.office-hours");
    }
    const ghl = fixture();
    ghl.assets.tags[0].description = "Imported from Ab3dEfGh1jKlMnOpQr5t";
    expect(codes(validateContent(ghl).errors)).toContain("ghl_id");
    const personal = fixture();
    personal.assets.messageTemplates[1].body = "Write to maria.santos@gmail.com or call +1 415 555 0123.";
    const rp = validateContent(personal);
    expect(rp.ok).toBe(true);
    expect(rp.warnings.filter((w) => w.code === "personal").length).toBe(2);
    expect(scanText("Contact hello@example.com")).toEqual([]);
    expect(scanText("Plain business text, open 9 to 5.")).toEqual([]);
    expect(scanText("ref 1b4e28ba-2fa1-11d2-883f-0016d3cca427").map((f) => f.kind)).toEqual(["database_id"]);
  });

  it("assertValidContent throws a readable error with every issue attached", () => {
    const c = fixture();
    c.assets.forms[0].draft.actions.tagIds = ["@tag.nope"];
    expect(() => assertValidContent(c)).toThrow(BlueprintValidationError);
    try {
      assertValidContent(c);
    } catch (e) {
      expect((e as BlueprintValidationError).issues.length).toBeGreaterThan(0);
      expect((e as Error).message).toMatch(/@tag\.nope/);
    }
    expect(assertValidContent(fixture()).blueprint.key).toBe("home-services-test");
  });

  it("validates an empty Blueprint", () => {
    const r = validateContent(emptyBlueprint({ key: "blank", name: "Blank", description: "", industry: "other" }));
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Digests, packages
// ---------------------------------------------------------------------------

function shuffleKeys<T>(v: T): T {
  if (Array.isArray(v)) return v.map(shuffleKeys) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, shuffleKeys(x)])) as T;
  return v;
}

describe("digests and package files", () => {
  it("are stable under key order and change with content", () => {
    const c = fixture();
    expect(contentDigest(shuffleKeys(c))).toBe(contentDigest(c));
    expect(contentDigest(c)).toMatch(/^[0-9a-f]{64}$/);
    expect(packageDigest(c, sha256Hex)).toBe(contentDigest(c));
    expect(sha256("abc")).toBe(sha256Hex("abc"));
    const d = fixture();
    d.assets.tags[0].color = "#000000";
    expect(contentDigest(d)).not.toBe(contentDigest(c));
    expect(jsonHash({ a: 1, b: [1, 2] })).toBe(jsonHash({ b: [1, 2], a: 1 }));
    expect(jsonHash({ b: [2, 1] })).not.toBe(jsonHash({ b: [1, 2] }));
    expect(canonicalJson({ b: 1, a: { d: undefined, c: 2 } })).toBe('{"a":{"c":2},"b":1}');
  });

  it("tell a client's customization from setup (people, connections, nonces, layout)", () => {
    const c = fixture();
    const ws = workspace(c, "a");
    const wf = toNative("workflow", c.assets.workflows[0], ws.apply).value;
    const base = nativeHash("workflow", wf);
    const mapped = clone(wf);
    for (const s of mapped.draft.steps) {
      const cfg = s.config as Record<string, unknown>;
      if (s.key === "task") cfg.userId = "55555555-5555-4555-8555-555555555555";
      if (s.key === "notify") cfg.userIds = [];
      if (s.key === "sync") cfg.mappingId = "66666666-6666-4666-8666-666666666666";
      if (s.key === "welcome") cfg.contentHash = "b".repeat(64);
      s.ui = { x: 99, y: 99 };
    }
    expect(nativeHash("workflow", mapped)).toBe(base);
    const edited = clone(wf);
    (edited.draft.steps[15].config as Record<string, unknown>).body = "A client wrote this.";
    expect(nativeHash("workflow", edited)).not.toBe(base);

    const cal = toNative("calendar", c.assets.calendars[0], ws.apply).value;
    expect(nativeHash("calendar", { ...cal, hostIds: [] })).toBe(nativeHash("calendar", cal));
    expect(nativeHash("calendar", { ...cal, hoursTemplate: [...cal.hoursTemplate].reverse() })).toBe(nativeHash("calendar", cal));
    expect(nativeHash("calendar", { ...cal, name: "Renamed" })).not.toBe(nativeHash("calendar", cal));
    const rule = toNative("assignmentRule", c.assets.assignmentRules[0], ws.apply).value;
    expect(nativeHash("assignmentRule", { ...rule, members: [], fallbackUserId: null })).toBe(nativeHash("assignmentRule", rule));
    expect(nativeHash("assignmentRule", { ...rule, strategy: "priority" })).not.toBe(nativeHash("assignmentRule", rule));
    expect(nativeProjection("tag", { name: "A", color: "#000000", description: null, folderId: null })).toEqual({ name: "A", color: "#000000", description: null, folderId: null });

    const p = c.assets.pipelines[0];
    expect(assetHash("pipeline", shuffleKeys(p))).toBe(assetHash("pipeline", p));
    // A pipeline's own fingerprint doesn't change when only a stage does: stages have their own.
    const p2 = { ...clone(p), stages: [...clone(p.stages), { id: "stage.sales.extra", name: "Extra", kind: "open" as const, probability: null, color: null }] };
    expect(assetHash("pipeline", p2)).toBe(assetHash("pipeline", p));
    expect(assetHash("tag", c.assets.tags[0])).not.toBe(assetHash("tag", { ...c.assets.tags[0], color: "#111111" }));
  });

  it("plan digests ignore order and change with any decision", () => {
    const items = [
      { assetId: "tag.a", action: "create" as const, existingId: null, decision: null },
      { assetId: "tag.b", action: "conflict" as const, existingId: "x", decision: "skip" as const },
    ];
    const base = planDigest({ versionId: "v1", options: { strategy: "add_missing", sections: ["tags", "forms"] }, items });
    expect(planDigest({ versionId: "v1", options: { strategy: "add_missing", sections: ["forms", "tags"] }, items: [...items].reverse() })).toBe(base);
    expect(planDigest({ versionId: "v1", options: { strategy: "add_missing", sections: ["tags", "forms"] }, items: [items[0], { ...items[1], decision: "copy" }] })).not.toBe(base);
    expect(planDigest({ versionId: "v2", options: { strategy: "add_missing", sections: ["tags", "forms"] }, items })).not.toBe(base);
  });

  it("export and read back with integrity, and refuse tampering", () => {
    const pkg = buildPackageFile(fixture(), { sha: sha256, exportedAt: "2026-10-17T00:00:00.000Z" });
    expect(packageFileSchema.safeParse(pkg).success).toBe(true);
    expect(pkg.integrity.digest).toBe(contentDigest(fixture()));
    expect(pkg.manifest).toEqual(computeManifest(fixture()));
    const text = serializePackage(pkg);
    const read = readPackage(text, { sha: sha256 });
    expect(read.errors).toEqual([]);
    expect(read).toMatchObject({ ok: true, integrity: "valid", manifest: "valid", upgradedFrom: null, exportedAt: "2026-10-17T00:00:00.000Z" });
    expect(read.content).toEqual(fixture());

    const tampered = JSON.parse(text);
    tampered.assets.tags[0].name = "Changed";
    expect(readPackage(tampered, { sha: sha256 })).toMatchObject({ ok: false, integrity: "mismatch", content: null });

    const unsigned = JSON.parse(text);
    delete unsigned.integrity;
    const r1 = readPackage(unsigned, { sha: sha256 });
    expect(r1.ok).toBe(true);
    expect(r1.integrity).toBe("missing");
    expect(codes(r1.warnings)).toContain("integrity");
    expect(readPackage(unsigned, { sha: sha256, requireIntegrity: true }).ok).toBe(false);

    const badManifest = JSON.parse(text);
    badManifest.manifest.counts.tags = 99;
    const r2 = readPackage(badManifest, { sha: sha256 });
    expect(r2.ok).toBe(true);
    expect(r2.manifest).toBe("mismatch");

    expect(() => buildPackageFile({ ...fixture(), assets: { ...fixture().assets, tags: [{ ...fixture().assets.tags[0], folder: "@folder.nope" }, ...fixture().assets.tags.slice(1)] } }, { sha: sha256 })).toThrow(BlueprintValidationError);
  });

  it("read nothing unsafe: oversize, non-JSON, foreign formats, newer versions, invalid content", () => {
    expect(readPackage("x".repeat(BLUEPRINT_MAX_BYTES + 1), { sha: sha256 }).errors[0].code).toBe("too_large");
    expect(readPackage("{not json", { sha: sha256 }).errors[0].code).toBe("not_json");
    const ghl = readPackage(JSON.stringify({ snapshotId: "abc", locationId: "xyz" }), { sha: sha256 });
    expect(ghl.errors[0]).toMatchObject({ code: "format" });
    expect(ghl.errors[0].message).toMatch(/GoHighLevel/);
    const newer = readPackage({ ...fixture(), schemaVersion: 2 }, { sha: sha256 });
    expect(newer.errors[0].message).toMatch(/newer iAcquire/);
    const bad = clone(fixture()) as unknown as Record<string, unknown>;
    (bad.assets as { tags: Array<Record<string, unknown>> }).tags[0].description = "<script>x</script>";
    const r = readPackage(bad, { sha: sha256 });
    expect(r.ok).toBe(false);
    expect(codes(r.errors)).toContain("unsafe");
    expect(readPackage([], { sha: sha256 }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

describe("diff", () => {
  it("describes additions, removals and nested changes", () => {
    const before = fixture();
    const after = fixture();
    after.assets.customFields[0].label = "Project budget";
    after.assets.pipelines[0].stages.splice(2, 0, { id: "stage.sales.proposal", name: "Proposal", kind: "open", probability: 70, color: null });
    after.assets.tags = after.assets.tags.filter((t) => t.id !== "tag.vip");
    after.assets.forms[0].draft.questions.push({ key: "phone", type: "phone", label: "Phone", required: false, map: "contact.phone" });
    (after.assets.workflows[0].definition.steps[1].config as Record<string, unknown>).amount = 2;
    after.assets.calendars[0].types[1].durationMinutes = 45;
    after.slots.push({ id: "member.helper", label: "Helper", description: null });
    after.blueprint.name = "Home Services v2";
    const d = diffContents(before, after);
    const byId = Object.fromEntries(d.changes.map((c) => [c.id, c]));
    expect(byId["field.contact.budget"]).toMatchObject({ kind: "changed", fields: ["label"] });
    expect(byId["pipeline.sales"].fields).toContain("stage added: Proposal");
    expect(byId["tag.vip"].kind).toBe("removed");
    expect(byId["form.estimate-request"].fields).toContain("question added: Phone");
    expect(byId["workflow.new-lead"].fields.some((f) => f.startsWith("step changed: wait1"))).toBe(true);
    expect(byId["calendar.estimates"].fields.some((f) => f.startsWith("appointment type changed: Video call"))).toBe(true);
    expect(d.metaChanged).toEqual(expect.arrayContaining(["blueprint.name", "slot added: member.helper"]));
    expect(d.summary[0]).toMatch(/^Details:/);
    expect(d.summary).toEqual(expect.arrayContaining(["Tags: 1 removed", "Custom fields: 1 changed"]));
    expect(changedSections(d)).toEqual(["tags", "customFields", "pipelines", "calendars", "forms", "workflows"]);
    expect(d.empty).toBe(false);
    expect(diffContents(before, shuffleKeys(fixture())).empty).toBe(true);
  });

  it("notices a reorder", () => {
    const after = fixture();
    after.assets.pipelines[0].stages.reverse();
    expect(diffContents(fixture(), after).changes[0].fields).toContain("stages reordered");
  });
});

// ---------------------------------------------------------------------------
// Format migrations
// ---------------------------------------------------------------------------

describe("format migrations", () => {
  it("runs registered N → N+1 steps in order", () => {
    const registry = {
      2: (p: Record<string, unknown>) => ({ ...p, settings: { ...(p.settings as object), upgraded: 2 } }),
      3: (p: Record<string, unknown>) => ({ ...p, settings: { ...(p.settings as object), upgraded: 3 }, schemaVersion: 99 }),
    };
    const original = fixture();
    const r = migrateToCurrent(original, registry, 3);
    expect(r).toMatchObject({ from: 1, to: 3, applied: [2, 3] });
    expect(r.value.schemaVersion).toBe(3);
    expect(r.value.settings).toMatchObject({ upgraded: 3 });
    // Steps never mutate the input.
    expect(original.settings).toEqual({ defaultCurrency: "USD" });
    expect(migrateToCurrent({ ...fixture(), schemaVersion: 2 }, registry, 3).applied).toEqual([3]);
    expect(migrateToCurrent(fixture()).applied).toEqual([]);
  });

  it("refuses foreign files, gaps and newer versions", () => {
    expect(() => migrateToCurrent({ format: "other" })).toThrow(FormatError);
    expect(() => migrateToCurrent("text")).toThrow(FormatError);
    expect(() => migrateToCurrent({ format: BLUEPRINT_FORMAT, schemaVersion: 0 })).toThrow(/no valid format version/);
    expect(() => migrateToCurrent({ format: BLUEPRINT_FORMAT, schemaVersion: 1 }, {}, 2)).toThrow(/no upgrade from format version 1 to 2/);
    expect(() => migrateToCurrent({ format: BLUEPRINT_FORMAT, schemaVersion: 3 }, {}, 2)).toThrow(/newer iAcquire/);
  });

  it("lets a registered upgrade feed the reader (integrity is checked on the file as exported)", () => {
    // A hypothetical version 0.9 package (written as version 1 with an old key) upgraded by an injected step to today's version 1.
    const oldPkg = { ...clone(fixture()) } as unknown as Record<string, unknown>;
    const settings = oldPkg.settings as Record<string, unknown>;
    settings.currency = settings.defaultCurrency;
    delete settings.defaultCurrency;
    oldPkg.schemaVersion = 1;
    const registry = { 2: (p: Record<string, unknown>) => {
      const s = { ...(p.settings as Record<string, unknown>) };
      s.defaultCurrency = s.currency;
      delete s.currency;
      return { ...p, settings: s };
    } };
    // The reader validates format version 1 content, so an upgrade to "2" is run here against a copy marked as version 1 of a 2-step chain.
    const migrated = migrateToCurrent(oldPkg, registry, 2);
    expect((migrated.value.settings as Record<string, unknown>).defaultCurrency).toBe("USD");
    const withDigest = { ...oldPkg, integrity: { algorithm: "sha256", digest: packageDigest(oldPkg, sha256) } };
    const read = readPackage(withDigest, { sha: sha256, registry, current: 2 });
    expect(read.integrity).toBe("valid");
    expect(read.applied).toEqual([2]);
    expect(read.upgradedFrom).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Requirements, manifest, dependency graph, compatibility report
// ---------------------------------------------------------------------------

describe("requirements and manifest", () => {
  it("derives the setup checklist from the assets", () => {
    const c = fixture();
    const keys = deriveRequirements(c);
    for (const k of [
      "calendar_hosts", "calendar_verification", "google_calendar", "meeting_link", "email_provider", "sms_provider", "whatsapp_provider", "whatsapp_template_approval",
      "template_approval", "member_mapping", "assignment_members", "n8n_mapping", "webhook_endpoints", "ai_employee", "hermes", "voice_provider", "review_links", "custom_values",
      "form_rebuild", "template_rebuild", "workflow_rebuild", "form_publishing", "workflow_activation",
    ] as const) expect(keys, k).toContain(k);
    expect(keys).not.toContain("microsoft_calendar");
    expect(keys).not.toContain("payment_provider");
    expect(keys).toEqual(REQUIREMENT_KEYS.filter((k) => keys.includes(k)));
    expect(deriveRequirements(c, ["tags", "customFields"])).toEqual([]);
    expect(deriveRequirements(c, ["calendars"])).toEqual(["calendar_hosts", "calendar_verification", "google_calendar", "meeting_link", "member_mapping"]);
    expect(deriveRequirements(c, ["tags"], ["payment_provider", "website_import"])).toEqual(["payment_provider", "website_import"]);
    const details = Object.fromEntries(requirementDetails(c).map((d) => [d.key, d]));
    expect(details.member_mapping.slots).toEqual(["member.closer", "member.dispatcher"]);
    expect(details.n8n_mapping).toMatchObject({ assetIds: ["workflow.new-lead"], slots: ["n8n.lead-sync"] });
    expect(details.custom_values.assetIds).toEqual(["value.booking-link"]);
    expect(details.google_calendar.assetIds).toEqual(["apptype.estimates.video"]);
    expect(details.voice_provider.assetIds).toEqual(["workflow.calls"]);
    expect(details.hermes.notes.join(" ")).toMatch(/crm manager/);
    // Sending "as" an AI employee is only the sender identity: the workspace must include it, but no AI task (Hermes) is involved.
    expect(details.hermes.notes.join(" ")).not.toMatch(/sales assistant|appointment setter/);
    expect(details.ai_employee.notes.join(" ")).toMatch(/sales assistant/);
    expect(details.ai_employee.notes.join(" ")).not.toMatch(/crm manager/);
  });

  it("builds a manifest and a dependency graph", () => {
    const c = fixture();
    const m = computeManifest(c);
    expect(m.counts).toMatchObject({ tags: 3, pipelines: 2, workflows: 9, assignmentRules: 2 });
    expect(m.assetIds).toContain("stage.sales.won");
    expect(m.assetIds).toContain("member.closer");
    expect(m.dependencies["form.estimate-request"]).toEqual(["field.contact.budget", "field.contact.service", "folder.form.website", "pipeline.sales", "rule.new-leads", "stage.sales.new", "tag.hot-lead"]);
    expect(m.dependencies["stage.sales.won"]).toEqual(["pipeline.sales"]);
    expect(m.dependencies["template.estimate-reminder"]).toEqual(["folder.template.reminders", "value.booking-link"]);
    expect(m.slotUse["member.closer"]).toEqual(expect.arrayContaining(["calendar.estimates", "list.hot-leads", "rule.new-leads", "report.weekly-sales", "workflow.new-lead", "workflow.assigned"]));
    expect(dependencyGraph(c)).toEqual(m.dependencies);
    expect(slotUsage(c)).toEqual(m.slotUse);
    const { order, cycle } = topologicalOrder(c);
    expect(cycle).toBeNull();
    const pos = new Map(order.map((e, i) => [e.id, i]));
    for (const [id, deps] of Object.entries(m.dependencies)) for (const d of deps) expect(pos.get(d)!, `${d} before ${id}`).toBeLessThan(pos.get(id)!);
    const closure = withDependencies(c, ["workflow.booked"]);
    for (const id of ["template.estimate-reminder", "value.booking-link", "calendar.estimates", "apptype.estimates.onsite", "apptype.estimates.video", "folder.calendar.field", "folder.template.reminders"]) expect(closure.has(id), id).toBe(true);
    expect(closure.has("pipeline.sales")).toBe(false);
    expect(dependents(c, "tag.hot-lead")).toEqual(expect.arrayContaining(["form.estimate-request", "workflow.new-lead", "workflow.inbound", "list.hot-leads", "rule.new-leads", "workflow.form-intake"]));
    expect(modulesOf(c).map((x) => x.section)).not.toContain("folders");
    expect(totalAssets(c)).toBe(listAssets(c).filter((e) => !e.parentId).length);
  });

  it("reports compatibility honestly: placeholders are never converted", () => {
    const report = reportForContent(fixture());
    const by = Object.fromEntries(report.items.map((i) => [i.assetId, i]));
    expect(by["form.legacy-survey"]).toMatchObject({ status: "manual_review", placeholder: true });
    expect(by["workflow.legacy"].status).toBe("manual_review");
    expect(by["template.old-promo"].status).toBe("manual_review");
    expect(by["calendar.estimates"].status).toBe("needs_connection");
    expect(by["calendar.consults"].status).toBe("needs_mapping");
    expect(by["rule.new-leads"].status).toBe("needs_mapping");
    expect(by["tag.vip"].status).toBe("ready");
    expect(by["template.welcome-email"].status).toBe("needs_connection");
    expect(report.items.some((i) => i.assetType === "stage")).toBe(false);
    expect(report.summary.discovered).toBe(report.items.length);
    expect(report.summary.fullySupported + report.summary.partiallySupported + report.summary.unsupported + report.summary.failed).toBe(report.summary.discovered);
    const forced = enforcePlaceholderRule({ sourceKind: "form", name: "X", status: "converted", assetId: null, assetType: "form", placeholder: true, notes: [], requirements: [], missingDependencies: [] });
    expect(forced.status).toBe("manual_review");
    const r = makeReport([forced, { ...forced, placeholder: false, status: "unsupported" }], ["Smart Lists can't be listed through the API."], [{ sourceKind: "workflow", reason: "missing scope" }]);
    expect(r.summary).toMatchObject({ discovered: 2, manualReview: 1, unsupported: 1 });
    expect(compatibilityBadge(r).status).toBe("partial");
    expect(compatibilityBadge(reportForContent({ assets: { ...fixture().assets, calendars: [], messageTemplates: [], workflows: [], forms: [], assignmentRules: [], customValues: [], smartLists: [], reports: [] }, slots: [] })).status).toBe("ready");
  });
});

// ---------------------------------------------------------------------------
// Authorization (in-memory database)
// ---------------------------------------------------------------------------

describe("authorization", () => {
  it("follows the agency matrix", () => {
    const staff = { platformRole: "agency_staff" as const };
    const admin = { platformRole: "agency_super_admin" as const };
    const client = { platformRole: "none" as const };
    expect(canBlueprint(staff, "crm.blueprints.view")).toBe(true);
    expect(canBlueprint(staff, "crm.blueprints.design")).toBe(true);
    expect(canBlueprint(staff, "crm.blueprints.publish")).toBe(false);
    expect(canBlueprint(staff, "crm.blueprints.apply")).toBe(false);
    for (const p of BLUEPRINT_PERMISSIONS) {
      expect(canBlueprint(admin, p)).toBe(true);
      expect(canBlueprint(client, p)).toBe(false);
      // The same answer as the shared matrix seeded into role_permissions.
      expect(canBlueprint(staff, p)).toBe(roleHasPermission("agency_staff", p));
    }
    expect(() => needBlueprint(staff, "crm.blueprints.apply")).toThrow(AppError);
    expect(canDoBlueprint(staff, "capture")).toBe(true);
    expect(canDoBlueprint(staff, "apply")).toBe(false);
    // A GoHighLevel import reads a stored credential: super admins only, although staff can design.
    expect(canDoBlueprint(staff, "import_ghl")).toBe(false);
    expect(canDoBlueprint(admin, "import_ghl")).toBe(true);
    expect(() => needBlueprintAction(staff, "import_ghl")).toThrow(AppError);
    expect(() => needBlueprintAction(staff, "export")).not.toThrow();
    expect(canDoBlueprint(client, "list")).toBe(false);
    for (const [action, spec] of Object.entries(BLUEPRINT_ACTIONS)) if (spec.writes) expect(spec.client, action).toBe(true);
    expect(assertIdempotencyKey("abcdefghijklmnop")).toBe("abcdefghijklmnop");
    expect(() => assertIdempotencyKey("short")).toThrow(AppError);
    expect(newInboundNonce()).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  });

  it("checks people and client access inside the transaction", async () => {
    const admin = agencyUser(await createUser({ platformRole: "agency_super_admin" }), "agency_super_admin");
    const staff = agencyUser(await createUser({ platformRole: "agency_staff" }), "agency_staff");
    const clientPerson = agencyUser(await createUser(), "agency_staff");
    clientPerson.platformRole = "none";
    const assigned = await createOrg({ name: "Assigned Client" });
    const other = await createOrg({ name: "Other Client" });
    const archived = await createOrg({ name: "Archived Client", status: "archived" });
    await withSystem((db) => db.query("insert into staff_assignments (org_id, user_id) values ($1, $2)", [assigned.id, staff.id]));

    await withSystem(async (db) => {
      expect((await lockClientForBlueprint(db, admin, other.id)).name).toBe("Other Client");
      expect((await lockClientForBlueprint(db, staff, assigned.id)).id).toBe(assigned.id);
      await expect(lockClientForBlueprint(db, staff, other.id)).rejects.toMatchObject({ code: "not_found" });
      await expect(lockClientForBlueprint(db, admin, "not-a-uuid")).rejects.toMatchObject({ code: "not_found" });
      await expect(lockClientForBlueprint(db, clientPerson, assigned.id)).rejects.toMatchObject({ code: "forbidden" });
      await lockBlueprintUser(db, staff, "crm.blueprints.design");
      await expect(lockBlueprintUser(db, staff, "crm.blueprints.apply")).rejects.toMatchObject({ code: "forbidden" });
      // A role changed since sign-in is refused even when the old role would have been allowed.
      await expect(lockBlueprintUser(db, { ...staff, platformRole: "agency_super_admin" }, "crm.blueprints.view")).rejects.toMatchObject({ code: "forbidden" });
      expect(await authorizeBlueprintAction(db, staff, "list")).toBeNull();
      expect((await authorizeBlueprintAction(db, staff, "capture", assigned.id))?.id).toBe(assigned.id);
      await expect(authorizeBlueprintAction(db, staff, "preview_apply", other.id)).rejects.toMatchObject({ code: "not_found" });
      await expect(authorizeBlueprintAction(db, staff, "apply", assigned.id)).rejects.toMatchObject({ code: "forbidden" });
      expect((await authorizeBlueprintAction(db, admin, "apply", assigned.id))?.id).toBe(assigned.id);
      await expect(authorizeBlueprintAction(db, admin, "apply", archived.id)).rejects.toMatchObject({ code: "conflict" });
      await expect(authorizeBlueprintAction(db, admin, "apply")).rejects.toMatchObject({ code: "invalid_input" });
      await expect(authorizeBlueprintAction(db, staff, "import_ghl")).rejects.toMatchObject({ code: "forbidden" });
      expect(await authorizeBlueprintAction(db, admin, "import_ghl")).toBeNull();
      expect((await authorizeBlueprintAction(db, admin, "import_ghl_client", assigned.id))?.id).toBe(assigned.id);
      // The agency organization itself is never a target.
      const { rows } = await db.query<{ id: string }>("select id from organizations where kind = 'agency' limit 1");
      if (rows[0]) await expect(lockClientForBlueprint(db, admin, rows[0].id)).rejects.toMatchObject({ code: "not_found" });
    });
    await withSystem((db) => db.query("update users set status = 'disabled' where id = $1", [staff.id]));
    await withSystem(async (db) => {
      await expect(lockBlueprintUser(db, staff, "crm.blueprints.view")).rejects.toMatchObject({ code: "forbidden" });
    });
  });
});

describe("builders", () => {
  it("make honest placeholders that validate and are reported for manual review", () => {
    const c = emptyBlueprint({ key: "imported", name: "Imported", description: "", industry: "other" });
    c.assets.forms.push(placeholderForm("form.contact-us", "contact-us", "Contact us"));
    c.assets.workflows.push(placeholderWorkflow("workflow.nurture", "nurture", "  Nurture  "));
    c.assets.messageTemplates.push(placeholderTemplate("template.promo", "promo", "Promo", "whatsapp", { purpose: "marketing" }));
    c.slots.push(slot("member", "closer", "Closer"));
    c.assets.calendars.push({ ...fixture().assets.calendars[1], hosts: ["@member.closer"], assignment: "round_robin" });
    const r = validateContent(c);
    expect(r.errors).toEqual([]);
    expect(c.assets.workflows[0].name).toBe("Nurture");
    const report = reportForContent(c);
    for (const id of ["form.contact-us", "workflow.nurture", "template.promo"]) expect(report.items.find((i) => i.assetId === id)?.status, id).toBe("manual_review");
    expect(deriveRequirements(c)).toEqual(expect.arrayContaining(["form_rebuild", "workflow_rebuild", "template_rebuild", "whatsapp_provider", "workflow_activation"]));
    expect(deriveRequirements(c)).not.toContain("template_approval");
  });
});

// Exhaustiveness: every asset type has documented reference fields and a projection.
describe("contract coverage", () => {
  it("covers every asset type", () => {
    const types = Object.keys(REFERENCE_FIELDS).sort();
    expect(types).toEqual([...new Set(listAssets(fixture()).map((e) => e.type as AssetType))].sort());
  });
});
