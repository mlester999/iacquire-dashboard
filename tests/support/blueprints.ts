// Synthetic CRM Blueprint content and library rows for the apply and capture tests. Original sample configuration only (no customer data);
// nothing here contacts a provider. Library rows are inserted directly, so these tests don't depend on the library service.
import crypto from "node:crypto";
import { withSystem } from "@/server/db";
import { contentDigest } from "@/server/crm/blueprints/access";
import { sectionCounts } from "@/lib/crm/blueprints/requirements";
import { BLUEPRINT_FORMAT, type AssetTypeMap, type BlueprintContent } from "@/lib/crm/blueprints/types";

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export const apptype = (id: string, name: string, extra: Partial<AssetTypeMap["appointmentType"]> = {}): AssetTypeMap["appointmentType"] => ({
  id, name, description: null, durationMinutes: 60, slotIntervalMinutes: null, bufferBeforeMinutes: 0, bufferAfterMinutes: 15, minNoticeMinutes: 120, maxDaysAhead: 60,
  dailyLimit: null, capacity: 1, locationKind: "in_person", locationDetail: "At the customer's home", meetingProvider: "none", meetingLink: null, requiresConfirmation: false,
  public: true, questions: [], color: null, confirmationMessage: null, allowCustomerChanges: true, changeCutoffMinutes: 0, requireEmail: true, requirePhone: false, ...extra,
});

export const field = (id: string, entity: "contact" | "company" | "opportunity", key: string, label: string, type: AssetTypeMap["customField"]["type"], options: Array<{ value: string; label: string }> = []): AssetTypeMap["customField"] => ({
  id, entity, key, label, type, options, required: false, helpText: null, groupName: null,
});

export const SERVICE_OPTIONS = [{ value: "repair", label: "Repair" }, { value: "install", label: "Install" }];

/**
 * A Home Services Blueprint that uses every asset type and most reference locations: folders, tags, fields of every record type, values
 * (one required and empty), two pipelines, a calendar with a Google Meet type and one with a fixed-link type that has no link, Smart Lists
 * (one filtering on a person), assignment rules, a full form and a placeholder survey, templates on every channel (a placeholder too),
 * workflows touching tags, stages, forms, calendars, fields, templates, people, n8n and webhooks, and two saved reports.
 */
export function sampleContent(key = "home-services-sample"): BlueprintContent {
  return {
    format: BLUEPRINT_FORMAT,
    schemaVersion: 1,
    blueprint: { key, name: "Home Services Sample", description: "Synthetic test Blueprint.", industry: "home_services" },
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
            { op: "and", conditions: [{ field: "opportunity", op: "in_stage", value: ["@stage.sales.quoted"] }, { field: "opportunity", op: "in_pipeline", value: ["@pipeline.sales"] }] },
          ] }, strategy: "weighted", respectWorkingHours: false, fallback: "unassigned", fallbackMember: null, members: [],
        },
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
                ] },
              ] },
            },
            steps: [
              { key: "welcome", kind: "send_message", config: { templateId: "@template.welcome-email", channel: "email", sendAs: "sales_assistant", businessHoursOnly: true }, next: "wait1", ui: { x: 10, y: 20 } },
              { key: "wait1", kind: "wait", config: { mode: "duration", amount: 1, unit: "days" }, next: "check" },
              { key: "check", kind: "branch", config: { subject: "contact", filter: { op: "and", conditions: [{ field: "tags", op: "has_any", value: ["@tag.quote-sent"] }, { field: "@field.contact.budget", op: "gt", value: 100 }] }, reply: null }, branches: { yes: "deal", no: "task" } },
              { key: "deal", kind: "create_opportunity", config: { name: "{{contact.full_name}}", pipelineId: "@pipeline.sales", stageId: "@stage.sales.new", ownerFromContact: true, skipIfOpenInPipeline: true }, next: "move" },
              { key: "move", kind: "move_stage", config: { pipelineId: "@pipeline.sales", stageId: "@stage.sales.quoted" }, next: "tag" },
              { key: "tag", kind: "add_tag", config: { tagIds: ["@tag.vip"] }, next: "field" },
              { key: "field", kind: "update_field", config: { subject: "contact", field: "@field.contact.service", value: "repair" }, next: "assign" },
              { key: "assign", kind: "assign", config: { subject: "contact", to: "rule", ruleId: "@rule.new-leads", onlyIfUnassigned: true }, next: "notify" },
              { key: "notify", kind: "notify_team", config: { roles: ["owner"], userIds: ["@member.dispatcher"], title: "New hot lead ({{custom_values.office_hours}})" }, next: "sync" },
              { key: "sync", kind: "n8n", config: { mappingId: "@n8n.lead-sync", includeContact: true }, next: "hook" },
              { key: "hook", kind: "webhook", config: { subscriptionId: "@webhook.crm-export", includeContact: false }, next: "review" },
              { key: "review", kind: "request_review", config: { templateId: "@template.review-whatsapp", channel: "whatsapp", businessHoursOnly: true }, next: null },
              { key: "task", kind: "create_task", config: { title: "Call {{contact.first_name}}", priority: "high", assignee: "user", userId: "@member.closer", dueIn: { amount: 2, unit: "hours" } }, next: "end" },
              { key: "end", kind: "end", config: {} },
            ],
          },
        },
        {
          id: "workflow.stage-moves", key: "stage_moves", name: "Stage moves", description: null, folder: null, hourlyRunLimit: 100, placeholder: false,
          definition: {
            trigger: { type: "opportunity.stage_changed", filters: { pipelineId: "@pipeline.sales", stageIds: ["@stage.sales.won"], fromStageIds: ["@stage.sales.quoted"] } },
            steps: [{ key: "done", kind: "end", config: {} }],
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
          id: "workflow.inbound", key: "inbound", name: "Inbound leads", description: null, folder: null, hourlyRunLimit: 500, placeholder: false,
          definition: { trigger: { type: "inbound_webhook", inbound: { match: "email_or_phone", createContact: true } }, steps: [{ key: "t", kind: "add_tag", config: { tagIds: ["@tag.hot-lead"] } }] },
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

/** A small Blueprint: a tag, a field, a value, a pipeline with stages, a template and a workflow that uses them. */
export function smallContent(key = "small-sample"): BlueprintContent {
  const full = sampleContent(key);
  return {
    ...full,
    blueprint: { ...full.blueprint, name: "Small Sample" },
    slots: [],
    assets: {
      folders: [],
      tags: [
        { id: "tag.hot-lead", name: "Hot lead", color: "#dc2626", description: null, folder: null },
        { id: "tag.vip", name: "VIP", color: "#7c3aed", description: null, folder: null },
      ],
      customFields: [field("field.contact.service", "contact", "service", "Service", "select", SERVICE_OPTIONS)],
      customValues: [{ id: "value.office-hours", key: "office_hours", label: "Office hours", type: "text", value: "Mon to Fri, 9am to 5pm", required: false, groupName: null }],
      pipelines: [clone(full.assets.pipelines[0])],
      calendars: [],
      smartLists: [],
      assignmentRules: [],
      forms: [],
      messageTemplates: [clone(full.assets.messageTemplates[1])],
      workflows: [{
        id: "workflow.welcome", key: "welcome", name: "Welcome", description: null, folder: null, hourlyRunLimit: 500, placeholder: false,
        definition: {
          trigger: { type: "contact.tag_added", filters: { tagIds: ["@tag.hot-lead"] } },
          steps: [
            { key: "welcome", kind: "send_message", config: { templateId: "@template.welcome-email", channel: "email", sendAs: "sales_assistant", businessHoursOnly: true }, next: "deal" },
            { key: "deal", kind: "create_opportunity", config: { name: "{{contact.full_name}}", pipelineId: "@pipeline.sales", stageId: "@stage.sales.new", ownerFromContact: true, skipIfOpenInPipeline: true }, next: "tag" },
            { key: "tag", kind: "add_tag", config: { tagIds: ["@tag.vip"] }, next: "field" },
            { key: "field", kind: "update_field", config: { subject: "contact", field: "@field.contact.service", value: "repair" } },
          ],
        },
      }],
      reports: [],
    },
  };
}

export interface PublishedBlueprint {
  blueprintId: string;
  key: string;
  versionId: string;
  version: number;
}

/**
 * Inserts a published Blueprint straight into the agency library (version 1 of `content`), as the library service would after publishing.
 * The digest is the real integrity digest, so applying checks it like any published version.
 */
export async function insertPublishedBlueprint(content: BlueprintContent, opts: { name?: string; status?: "published" | "draft" } = {}): Promise<PublishedBlueprint> {
  const key = `${content.blueprint.key.slice(0, 50)}-${crypto.randomBytes(3).toString("hex")}`;
  const c: BlueprintContent = { ...clone(content), blueprint: { ...content.blueprint, key } };
  return withSystem(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `insert into crm_blueprints (key, name, description, industry, source_kind, status, draft_package, current_version)
       values ($1, $2, $3, $4, 'native', $5, $6, $7) returning id`,
      [key, opts.name ?? c.blueprint.name, c.blueprint.description, c.blueprint.industry, opts.status ?? "published", JSON.stringify(c), opts.status === "draft" ? null : 1],
    );
    if (opts.status === "draft") return { blueprintId: rows[0].id, key, versionId: "", version: 0 };
    const v = await db.query<{ id: string }>(
      "insert into crm_blueprint_versions (blueprint_id, version, schema_version, package, digest, counts) values ($1, 1, 1, $2, $3, $4) returning id",
      [rows[0].id, JSON.stringify(c), contentDigest(c), JSON.stringify(sectionCounts(c))],
    );
    return { blueprintId: rows[0].id, key, versionId: v.rows[0].id, version: 1 };
  });
}

/** Publishes the next version of a Blueprint inserted above (or captured), as the library would. */
export async function publishVersion(blueprintId: string, content: BlueprintContent): Promise<PublishedBlueprint> {
  return withSystem(async (db) => {
    const b = (await db.query<{ key: string; current_version: number | null }>("select key, current_version from crm_blueprints where id = $1 for update", [blueprintId])).rows[0];
    const c: BlueprintContent = { ...clone(content), blueprint: { ...content.blueprint, key: b.key } };
    const version = (b.current_version ?? 0) + 1;
    const v = await db.query<{ id: string }>(
      "insert into crm_blueprint_versions (blueprint_id, version, schema_version, package, digest, counts) values ($1, $2, 1, $3, $4, $5) returning id",
      [blueprintId, version, JSON.stringify(c), contentDigest(c), JSON.stringify(sectionCounts(c))],
    );
    await db.query("update crm_blueprints set status = 'published', current_version = $2, draft_package = $3 where id = $1", [blueprintId, version, JSON.stringify(c)]);
    return { blueprintId, key: b.key, versionId: v.rows[0].id, version };
  });
}

/** Publishes a Blueprint's current working draft (for example one captured from a client) as its next version. */
export async function publishDraft(blueprintId: string): Promise<PublishedBlueprint> {
  const draft = (await withSystem((db) => db.query<{ draft_package: BlueprintContent }>("select draft_package from crm_blueprints where id = $1", [blueprintId]))).rows[0].draft_package;
  return publishVersion(blueprintId, draft);
}

/** A fresh idempotency key for one confirmation. */
export const confirmation = () => `test-${crypto.randomBytes(12).toString("hex")}`;
