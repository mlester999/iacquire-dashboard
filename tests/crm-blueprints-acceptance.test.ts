// The CRM Blueprints & Snapshots acceptance scenario, end to end on the in-memory database:
//   an authorized GoHighLevel source (an agency template sub-account) → inspect it → extract what the official API supports → convert →
//   an honest report of what couldn't come over → save as a Blueprint → finish it and publish → create a fresh client through onboarding,
//   which applies it → the client's own pipelines, tags, fields, forms, scheduling definitions and workflow drafts, wired to that client's ids
//   → the client customizes them, and the agency's next version never overwrites that → a second client sees none of it → every GoHighLevel
//   call was a GET to the official host and the source is unchanged → the native CRM runs those assets with no GoHighLevel connection
//   (verify and activate a calendar and book it, publish and submit a form, test-run a workflow draft).
// GoHighLevel is a mocked fetch that answers documented GET routes on the official host only (payloads shaped like the documented responses);
// nothing here contacts a provider, publishes a website or sends a message.
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ user: null as null | import("@/server/auth/service").SessionUser }));
vi.mock("@/server/tenancy/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/tenancy/context")>();
  return {
    ...actual,
    requireAgency: async () => {
      if (!session.user) throw new Error("signed out");
      return session.user;
    },
  };
});

import { withSystem, withUser } from "@/server/db";
import { memberActor, type CrmActor } from "@/server/crm/actor";
import { listGhlSources, runGhlImport, saveGhlTemplateSource, testGhlTemplateSource } from "@/server/crm/blueprints/ghl";
import { getBlueprint, getImport, inspectAssets, publishBlueprint, saveDraft, saveImport } from "@/server/crm/blueprints/library";
import { applyBlueprint, planApplication, previewApplication } from "@/server/crm/blueprints/apply";
import { getBlueprintChecklist } from "@/server/crm/blueprints/checklist";
import { createClientTenant } from "@/server/admin/tenants";
import { listTags, updateTag } from "@/server/crm/tags";
import { addStage, listPipelines } from "@/server/crm/pipelines";
import { getForm, publishForm, saveFormDraft, updateFormSettings } from "@/server/crm/forms/definitions";
import { handleHostedSubmit, hostedFormToken, type PublicRequestMeta } from "@/server/crm/forms/public";
import { processFormSubmissions } from "@/server/crm/forms/process";
import { getWorkflow, saveWorkflowDraft } from "@/server/crm/workflows/definitions";
import { startTestRun } from "@/server/crm/workflows/runs";
import { setCalendarPublic, updateCalendar } from "@/server/calendars/setup";
import { activateCalendar, verifyCalendar } from "@/server/calendars/activation";
import { bookingPageActor, bookNativeAppointment } from "@/server/calendars/booking";
import { GHL_API_ORIGIN, GHL_IMPORT_SCOPES, GHL_KIND_INFO, GHL_TEMPLATES_UNAVAILABLE } from "@/lib/crm/blueprints/ghl/inventory";
import type { BlueprintContent, CompatItem, FormAsset, MessageTemplateAsset, WorkflowAsset } from "@/lib/crm/blueprints/types";
import type { ImportDetail } from "@/lib/crm/blueprints/views";
import type { RawFields } from "@/lib/crm/forms/logic";
import { ClientBlueprintCardView, loadClientBlueprintCard } from "@/components/crm/blueprints/client-blueprint-card";
import CrmBlueprintsPage from "@/app/(admin)/admin/crm-blueprints/page";
import { addMember, agencyUser, createUser, ctxFor, uid } from "./support/fixtures";

const TEST_STRIPE_KEY = `sk_live_${"x".repeat(10)}`;

// ---------------------------------------------------------------------------
// The GoHighLevel template sub-account, as its documented read-only API describes it
// ---------------------------------------------------------------------------

const TOKEN = "pit-acce0001-1111-2222-3333-444455556666";
const LOC = "BrightSmilesTpl00001";
const gid = (prefix: string, n: number) => `${prefix}${String(n).padStart(20 - prefix.length, "0")}`;
const ID = {
  company: gid("Comp", 7), pipeline: gid("Pipe", 1), stage: (n: number) => gid("Stg", n), tag: (n: number) => gid("Tag", n), field: (n: number) => gid("Fld", n),
  value: (n: number) => gid("Val", n), group: gid("Grp", 1), cal: (n: number) => gid("Cal", n), user: (n: number) => gid("User", n), form: (n: number) => gid("Form", n),
  survey: gid("Srv", 1), workflow: (n: number) => `5f0c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5${n}`, design: "6a1b2c3d4e5f6a7b8c9d0e1f", funnel: gid("Fun", 1),
};
const ALL_GHL_IDS = [
  ID.company, ID.pipeline, ID.group, ID.survey, ID.design, ID.funnel,
  ...[1, 2, 3, 4].map(ID.stage), ...[1, 2].map(ID.tag), ...[1, 2, 3].map(ID.field), ...[1, 2, 3].map(ID.value), ...[1, 2, 3].map(ID.cal), ...[1, 2].map(ID.user),
  ...[1, 2].map(ID.form), ...[1, 2].map(ID.workflow),
];

const weekdays = [{ daysOfTheWeek: [1, 2, 3, 4, 5], hours: [{ openHour: 9, openMinute: 0, closeHour: 17, closeMinute: 0 }] }];
const cal = (n: number, extra: Record<string, unknown>) => ({ id: ID.cal(n), locationId: LOC, isActive: true, slug: `cal-${n}`, widgetSlug: `cal-${n}`, widgetType: "classic", notifications: [], ...extra });

/** Every documented GET route the import reads, keyed by path. Deep-frozen: reading it can never change it. */
const SOURCE = deepFreeze({
  [`/locations/${LOC}`]: { location: { id: LOC, companyId: ID.company, name: "Bright Smiles Template", timezone: "America/Chicago", email: "owner@brightsmiles.example" } },
  "/opportunities/pipelines": {
    pipelines: [{
      id: ID.pipeline, name: "Patient Journey", locationId: LOC,
      stages: [{ id: ID.stage(1), name: "New Lead", position: 0 }, { id: ID.stage(2), name: "Consult Booked", position: 1 }, { id: ID.stage(3), name: "Won", position: 2 }, { id: ID.stage(4), name: "Lost", position: 3 }],
    }],
  },
  [`/locations/${LOC}/tags`]: { tags: [{ id: ID.tag(1), name: "VIP", locationId: LOC }, { id: ID.tag(2), name: "New patient", locationId: LOC }] },
  [`/locations/${LOC}/customFields`]: {
    customFields: [
      { id: ID.field(1), name: "Insurance Provider", fieldKey: "contact.insurance_provider", dataType: "TEXT", position: 0, model: "contact", locationId: LOC },
      { id: ID.field(2), name: "Preferred Service", fieldKey: "contact.preferred_service", dataType: "SINGLE_OPTIONS", position: 1, picklistOptions: ["Cleaning", "Whitening"], model: "contact", locationId: LOC },
      { id: ID.field(3), name: "X-Ray Upload", fieldKey: "contact.xray_upload", dataType: "FILE_UPLOAD", position: 2, model: "contact", locationId: LOC },
    ],
  },
  [`/locations/${LOC}/customValues`]: {
    customValues: [
      { id: ID.value(1), name: "Booking Link", fieldKey: "{{ custom_values.booking_link }}", value: "https://book.example.com/smile", locationId: LOC },
      { id: ID.value(2), name: "Promo Code", fieldKey: "{{ custom_values.promo_code }}", value: "SMILE10", locationId: LOC },
      { id: ID.value(3), name: "Payment API Key", fieldKey: "{{ custom_values.payment_api_key }}", value: TEST_STRIPE_KEY, locationId: LOC },
    ],
  },
  "/calendars/groups": { groups: [{ id: ID.group, name: "Dental Team", description: "Everyone who sees patients", slug: "dental-team", isActive: true, locationId: LOC }] },
  "/calendars/": {
    calendars: [
      cal(1, {
        name: "New Patient Consult", description: "<p>A first visit for <b>new</b> patients.</p>", calendarType: "round_robin", eventType: "RoundRobin_OptimizeForEqualDistribution",
        groupId: ID.group, teamMembers: [{ userId: ID.user(1), priority: 1, isPrimary: true }, { userId: ID.user(2), priority: 0.5 }],
        locationConfigurations: [{ kind: "physical", location: "12 Example Street" }], slotDuration: 45, slotDurationUnit: "mins", slotInterval: 15, slotIntervalUnit: "mins",
        allowBookingAfter: 2, allowBookingAfterUnit: "hours", allowBookingFor: 8, allowBookingForUnit: "weeks", openHours: weekdays, formId: ID.form(1), autoConfirm: true,
        formSubmitType: "ThankYouMessage", formSubmitThanksMessage: "Thanks! See you soon.", eventColor: "#2563EB",
      }),
      cal(2, { name: "Video Check-in", calendarType: "event", teamMembers: [{ userId: ID.user(1) }], locationConfigurations: [{ kind: "google_conference" }], slotDuration: 30, slotDurationUnit: "mins", openHours: weekdays }),
      cal(3, { name: "Spa Services", calendarType: "service_booking" }),
    ],
  },
  "/forms/": { forms: [{ id: ID.form(1), name: "New Patient Intake", locationId: LOC }, { id: ID.form(2), name: "Contact Us", locationId: LOC }], total: 2 },
  "/surveys/": { surveys: [{ id: ID.survey, name: "Satisfaction Survey", locationId: LOC }], total: 1 },
  "/workflows/": {
    workflows: [
      { id: ID.workflow(1), name: "Appointment Reminder", status: "published", version: 3, locationId: LOC },
      { id: ID.workflow(2), name: "Lead Nurture", status: "draft", version: 1, locationId: LOC },
    ],
  },
  "/emails/builder": { id: ID.design, name: "Monthly Newsletter", templateType: "builder", isPlainText: false, previewUrl: "https://example.com/preview", version: "1" },
  "/funnels/funnel/list": { funnels: [{ _id: ID.funnel, name: "Smile Landing", type: "funnel", locationId: LOC, steps: [{ id: "s1", name: "Opt-in" }, { id: "s2", name: "Thanks" }] }], count: 1, traceId: "t" },
});
const SOURCE_BEFORE = JSON.stringify(SOURCE);

function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object") {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}

interface Call { url: URL; method: string; body: unknown }
/** Every request any code made while GoHighLevel was reachable, and the mock that answered: documented GET routes on the official host only. */
const ghlCalls: Call[] = [];
function mockGhl() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    ghlCalls.push({ url, method, body: init?.body ?? null });
    if (method !== "GET" || url.origin !== GHL_API_ORIGIN) return new Response("refused", { status: 405 });
    const route = (SOURCE as Record<string, unknown>)[url.pathname];
    return route === undefined ? new Response("not found", { status: 404 }) : Response.json(route);
  });
}

/** While the native CRM works, nothing may reach the network at all: any request is recorded and fails. */
const offlineCalls: string[] = [];
function noNetwork() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    offlineCalls.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    throw new Error("No network in the native CRM part of the acceptance scenario.");
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Monday 19 October 2026, 08:00 in Chicago (the template's time zone). Bookings and form submissions happen at this instant.
const NOW = new Date("2026-10-19T13:00:00Z");

const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows as T[];
const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await q<T>(sql, params))[0];

/** Every string inside a JSON value. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => strings(x, out));
  return out;
}
const UUIDS = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const named = <T extends { name: string }>(list: readonly T[], name: string): T => {
  const found = list.find((x) => x.name === name);
  if (!found) throw new Error(`Nothing named ${name}: ${list.map((x) => x.name).join(", ")}`);
  return found;
};

/** The configuration records of one workspace, with their ids. */
async function workspaceIds(orgId: string): Promise<Set<string>> {
  return new Set((await q<{ id: string }>(
    `select id from crm_tags where org_id = $1 union all select id from crm_custom_fields where org_id = $1 union all select id from crm_custom_values where org_id = $1
     union all select id from crm_pipelines where org_id = $1 union all select id from crm_pipeline_stages where org_id = $1 union all select id from crm_calendars where org_id = $1
     union all select id from crm_appointment_types where org_id = $1 union all select id from crm_forms where org_id = $1 union all select id from crm_workflows where org_id = $1
     union all select id from crm_message_templates where org_id = $1 union all select id from crm_folders where org_id = $1
     union all select user_id from organization_memberships where org_id = $1`,
    [orgId],
  )).map((r) => r.id));
}

/** Where references to other records live: form and workflow drafts, calendar hours. */
async function definitions(orgId: string): Promise<unknown[]> {
  return [
    ...(await q<{ draft: unknown }>("select draft from crm_forms where org_id = $1", [orgId])).map((r) => r.draft),
    ...(await q<{ draft: unknown }>("select draft from crm_workflows where org_id = $1", [orgId])).map((r) => r.draft),
  ];
}

async function ownerOf(orgId: string): Promise<{ actor: CrmActor; userId: string }> {
  const org = (await one<{ id: string; name: string; slug: string }>("select id, name, slug from organizations where id = $1", [orgId]))!;
  const owner = await createUser({ name: "Client Owner" });
  await addMember(orgId, owner.id, "owner");
  return { actor: memberActor(ctxFor(owner, org, "owner")), userId: owner.id };
}

const raw = (o: Record<string, string>): RawFields => new Map(Object.entries(o).map(([k, v]) => [k, [v]]));
const visitor = (): PublicRequestMeta => ({ origin: "https://app.example.test", host: "app.example.test", secFetchSite: "same-origin", ip: "203.0.113.77", now: NOW });

// ---------------------------------------------------------------------------
// The scenario. Each step builds on the one before (vitest runs them in order).
// ---------------------------------------------------------------------------

let admin: ReturnType<typeof agencyUser>;
let staff: ReturnType<typeof agencyUser>;
let sourceRef: string;
let imported: ImportDetail;
let blueprintId: string;
let versionId: string;
let A: { orgId: string; slug: string; owner: CrmActor; ownerId: string };
let B: { orgId: string; owner: CrmActor; ownerId: string };
/** Client A's records by name, as onboarding created them. */
const a = { tags: new Map<string, string>(), stages: new Map<string, string>(), pipelineId: "", forms: new Map<string, string>(), workflows: new Map<string, string>(), calendars: new Map<string, string>(), types: new Map<string, string>() };

beforeAll(async () => {
  admin = agencyUser(await createUser({ platformRole: "agency_super_admin", name: "Agency Admin" }), "agency_super_admin");
  staff = agencyUser(await createUser({ platformRole: "agency_staff", name: "Agency Staff" }), "agency_staff");
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("CRM Blueprints acceptance: from a GoHighLevel template sub-account to a working native CRM", () => {
  it("1. selects an authorized GoHighLevel source and inspects it (one identity check, read-only scopes)", async () => {
    const spy = mockGhl();
    try {
      const { id } = await saveGhlTemplateSource(admin, { label: "Bright Smiles template", locationId: LOC, token: TOKEN, scopes: [...GHL_IMPORT_SCOPES] });
      const view = await testGhlTemplateSource(admin, id);
      expect(view).toMatchObject({ kind: "ghl_agency_source", status: "connected", missingScopes: [] });
      expect(view.locationHint).not.toContain(LOC);
      sourceRef = view.ref;
      expect((await listGhlSources(admin)).map((s) => s.ref)).toContain(sourceRef);
      // Only super admins may read a stored agency credential; staff can't even list sources.
      await expect(listGhlSources(staff)).rejects.toMatchObject({ code: "forbidden" });
      await expect(runGhlImport(staff, { sourceRef, includeValues: true, includePlaceholders: true })).rejects.toMatchObject({ code: "forbidden" });
      // The token never comes back.
      expect(JSON.stringify(await listGhlSources(admin))).not.toContain(TOKEN);
    } finally {
      spy.mockRestore();
    }
  });

  it("2. extracts what the official API supports and converts it, with GoHighLevel IDs kept out of the content", async () => {
    const spy = mockGhl();
    try {
      imported = await runGhlImport(admin, { sourceRef, includeValues: true, includePlaceholders: true }, { now: () => NOW });
    } finally {
      spy.mockRestore();
    }
    expect(imported.status).toBe("previewed");
    const c = imported.content!;
    expect(c).not.toBeNull();
    expect(imported.validation.errors).toEqual([]);
    // Inspect the extracted assets.
    expect(c.assets.pipelines.map((p) => [p.name, p.stages.map((s) => s.name)])).toEqual([["Patient Journey", ["New Lead", "Consult Booked", "Won", "Lost"]]]);
    expect(c.assets.pipelines[0].stages.map((s) => s.kind)).toEqual(["open", "open", "won", "lost"]);
    expect(c.assets.tags.map((t) => t.name).sort()).toEqual(["New patient", "VIP"]);
    expect(c.assets.customFields.map((f) => f.label).sort()).toEqual(["Insurance Provider", "Preferred Service"]);
    expect(c.assets.calendars.map((x) => x.name).sort()).toEqual(["New Patient Consult", "Video Check-in"]);
    const consult = named(c.assets.calendars, "New Patient Consult");
    expect(consult).toMatchObject({ assignment: "round_robin", timezone: "America/Chicago" });
    expect(consult.hosts).toHaveLength(2);
    expect(consult.hours.length).toBe(5);
    expect(consult.folder).toMatch(/^@folder\./);
    expect(c.slots.every((s) => s.id.startsWith("member.calendar-host-"))).toBe(true);
    const values = Object.fromEntries(c.assets.customValues.map((v) => [v.label, v]));
    expect(values["Booking Link"].value).toBe("https://book.example.com/smile");
    // A credential never travels: the value is emptied and must be filled in by each client.
    expect(values["Payment API Key"]).toMatchObject({ value: "", required: true });
    const json = JSON.stringify(c);
    for (const ghlId of ALL_GHL_IDS) expect(json, ghlId).not.toContain(ghlId);
    expect(json).not.toContain(TOKEN);
    expect(json).not.toContain("sk_live_");
  });

  it("3. reports what couldn't come over honestly: Smart Lists, snapshot contents, workflow steps, form questions, WhatsApp templates", async () => {
    const report = (await getImport(admin, imported.id)).report;
    const lim = report.limitations.join("\n");
    expect(lim).toContain(GHL_KIND_INFO.smartLists.limitation);
    expect(lim).toContain(GHL_KIND_INFO.snapshots.limitation);
    expect(lim).toMatch(/snapshot share link installs the snapshot into another GoHighLevel account; it is not a file/);
    expect(lim).toContain(GHL_KIND_INFO.workflows.limitation);
    expect(lim).toMatch(/never its triggers, actions or steps/);
    expect(lim).toContain(GHL_KIND_INFO.forms.limitation);
    expect(lim).toMatch(/never its questions/);
    expect(lim).toMatch(/WhatsApp templates: GoHighLevel documents no API for them/);
    expect(report.unavailable).toEqual(expect.arrayContaining([{ sourceKind: "messageTemplates", reason: GHL_TEMPLATES_UNAVAILABLE }]));

    const item = (name: string): CompatItem => named(report.items, name);
    // Name-only items are placeholders for manual review, never "converted".
    for (const name of ["New Patient Intake", "Contact Us", "Satisfaction Survey", "Appointment Reminder", "Lead Nurture"]) {
      expect(item(name)).toMatchObject({ status: "manual_review", placeholder: true });
    }
    expect(item("Appointment Reminder").notes.join(" ")).toMatch(/steps/);
    // What can't be represented natively is unsupported, with the reason.
    expect(item("X-Ray Upload").status).toBe("unsupported");
    expect(item("Spa Services")).toMatchObject({ status: "unsupported", notes: [expect.stringMatching(/Service booking calendars/)] });
    expect(item("Monthly Newsletter").status).toBe("unsupported");
    expect(item("Smile Landing").status).toBe("unsupported");
    // Fully representable configuration is converted; a calendar needing Google is "needs connection"; the emptied credential "needs mapping".
    expect(item("VIP").status).toBe("converted");
    expect(item("Patient Journey").status).toBe("converted");
    expect(item("Video Check-in").status).toBe("needs_connection");
    expect(item("Payment API Key").status).toBe("needs_mapping");
    const s = report.summary;
    expect(s.discovered).toBe(report.items.length);
    expect(s.unsupported).toBe(report.items.filter((i) => i.status === "unsupported").length);
    expect(s.manualReview).toBeGreaterThanOrEqual(5);
    expect(report.items.filter((i) => i.placeholder).every((i) => i.status !== "converted" && i.status !== "ready")).toBe(true);
  });

  it("4. saves it as a Blueprint, finishes what only came over by name, and publishes it", async () => {
    ({ blueprintId } = await saveImport(admin, imported.id, { name: "Bright Smiles (from GoHighLevel)", industry: "healthcare_wellness" }));
    const detail = await getBlueprint(admin, blueprintId);
    expect(detail).toMatchObject({ source: "ghl_import", status: "draft", currentVersion: null });
    expect(detail.importReport?.limitations.length).toBeGreaterThan(0);
    const assets = await inspectAssets(admin, blueprintId);
    expect(assets.filter((x) => x.placeholder).map((x) => x.name).sort()).toEqual(["Appointment Reminder", "Contact Us", "Lead Nurture", "New Patient Intake", "Satisfaction Survey"]);

    // The agency rebuilds the intake form and the reminder workflow in the Blueprint editor, and adds a welcome message GoHighLevel couldn't export.
    const c: BlueprintContent = JSON.parse(JSON.stringify(detail.draft));
    const ref = (id: string) => `@${id}`;
    const pipeline = c.assets.pipelines[0];
    const stage = (name: string) => named(pipeline.stages, name).id;
    const tag = (name: string) => named(c.assets.tags, name).id;
    const insurance = c.assets.customFields.find((f) => f.label === "Insurance Provider")!;
    const intake = named(c.assets.forms, "New Patient Intake") as FormAsset;
    intake.placeholder = false;
    intake.purpose = "appointment_request";
    intake.draft = {
      questions: [
        { key: "first_name", type: "short_text", label: "First name", required: true, width: "half", map: "contact.first_name" },
        { key: "last_name", type: "short_text", label: "Last name", required: false, width: "half", map: "contact.last_name" },
        { key: "email", type: "email", label: "Email", required: true, width: "half", map: "contact.email" },
        { key: "insurance", type: "short_text", label: "Insurance provider", required: false, width: "half", map: ref(insurance.id) },
      ],
      consent: { text: "I agree to be contacted by email or text message about my visit.", marketing: { enabled: false, text: "Send me occasional news and offers." } },
      actions: {
        tagIds: [ref(tag("New patient"))], opportunity: { pipelineId: ref(pipeline.id), stageId: ref(stage("New Lead")), name: "{{contact.full_name}} – {{form.name}}", valueQuestion: null },
        assignmentRuleId: null, notify: { roles: ["owner"], contactOwner: false }, after: { kind: "message", message: "Thanks! We'll confirm your visit." },
      },
      settings: { title: "New patient intake", intro: "Tell us a little about yourself.", submitLabel: "Send" },
    };
    const reminder = named(c.assets.workflows, "Appointment Reminder") as WorkflowAsset;
    reminder.placeholder = false;
    reminder.definition = {
      trigger: { type: "form.submitted", filters: { formIds: [ref(intake.id)] } },
      steps: [
        { key: "tag", kind: "add_tag", config: { tagIds: [ref(tag("VIP"))] }, next: "deal" },
        { key: "deal", kind: "create_opportunity", config: { name: "{{contact.full_name}}", pipelineId: ref(pipeline.id), stageId: ref(stage("Consult Booked")), ownerFromContact: true, skipIfOpenInPipeline: true }, next: null },
      ],
    } as WorkflowAsset["definition"];
    const welcome: MessageTemplateAsset = {
      id: "template.welcome-email", kind: "template", key: "welcome_email", name: "Welcome email", channel: "email", purpose: "service", category: null, folder: null,
      subject: "Welcome to the practice", body: "Hi {{contact.first_name}}, thanks for choosing us. Reply to this email with any questions.", whatsapp: null, placeholder: false,
    };
    c.assets.messageTemplates.push(welcome);
    c.assets.workflows.push({
      id: "workflow.welcome-email", key: "welcome_email", name: "Welcome email", description: "Welcomes each new patient.", folder: null, hourlyRunLimit: 200, placeholder: false,
      definition: {
        trigger: { type: "contact.tag_added", filters: { tagIds: [ref(tag("New patient"))] } },
        steps: [{ key: "welcome", kind: "send_message", config: { templateId: ref(welcome.id), channel: "email", sendAs: "sales_assistant", businessHoursOnly: true } }],
      },
    } as WorkflowAsset);
    const saved = await saveDraft(admin, blueprintId, { content: c, revision: detail.draftRevision });
    expect(saved.errors).toEqual([]);
    const published = await publishBlueprint(admin, blueprintId, { revision: saved.revision, changeSummary: "Imported from GoHighLevel; intake form and reminder rebuilt." });
    expect(published.version).toBe(1);
    versionId = published.versionId;

    const after = await getBlueprint(admin, blueprintId);
    expect(after).toMatchObject({ status: "published", currentVersion: 1 });
    // Sending "as" an AI employee needs that employee included, not a Hermes AI task.
    expect(after.requirements).toEqual(expect.arrayContaining(["ai_employee", "calendar_hosts", "calendar_verification", "google_calendar", "form_rebuild", "workflow_rebuild", "custom_values"]));
    expect(after.requirements).not.toContain("hermes");
  });

  it("5. creates a fresh client through onboarding, which applies the Blueprint to it", async () => {
    const res = await createClientTenant(admin, {
      name: `Acceptance Dental ${uid()}`, ownerEmail: `owner-${uid()}@example.test`, industry: "Healthcare & Wellness", timezone: "America/Chicago",
      enabledRoles: ["sales_assistant"], blueprint: { kind: "blueprint", blueprintId },
    });
    expect(res.crmMode).toBe("native");
    expect(res.blueprint).toMatchObject({ status: "applied", blueprintId, version: 1 });
    const app = (await one<{ requested_via: string; version_id: string; strategy: string }>("select requested_via, version_id, strategy from crm_blueprint_applications where org_id = $1", [res.orgId]))!;
    expect(app).toEqual({ requested_via: "onboarding", version_id: versionId, strategy: "add_missing" });
    const org = (await one<{ slug: string }>("select slug from organizations where id = $1", [res.orgId]))!;
    const owner = await ownerOf(res.orgId);
    A = { orgId: res.orgId, slug: org.slug, owner: owner.actor, ownerId: owner.userId };

    // The agency's client page offers the next steps: apply another Blueprint (the library filtered for this client) or capture it.
    const card = (await loadClientBlueprintCard(admin, A.orgId))!;
    const html = renderToStaticMarkup(React.createElement(ClientBlueprintCardView, { data: card, timeZone: "UTC" }));
    expect(html).toContain(`href="/admin/crm-blueprints?client=${A.orgId}"`);
    expect(html).toContain(`href="/admin/crm-blueprints?capture=${A.orgId}"`);
    session.user = admin;
    const page = (await CrmBlueprintsPage({ searchParams: Promise.resolve({ client: A.orgId }) })) as React.ReactElement<{ applyFor: { id: string } | null }>;
    expect(page.props.applyFor).toMatchObject({ id: A.orgId, crmMode: "native", appliedBlueprints: [expect.objectContaining({ blueprintId, version: 1 })] });
    const ignored = (await CrmBlueprintsPage({ searchParams: Promise.resolve({ client: "00000000-0000-4000-8000-000000000000" }) })) as React.ReactElement<{ applyFor: unknown }>;
    expect(ignored.props.applyFor).toBeNull();
    session.user = staff;
    const forStaff = (await CrmBlueprintsPage({ searchParams: Promise.resolve({ client: A.orgId }) })) as React.ReactElement<{ applyFor: unknown }>;
    expect(forStaff.props.applyFor).toBeNull();
    session.user = null;
  });

  it("6. gives the client its own pipelines, tags, fields, forms, scheduling definitions and workflow drafts, wired to its own ids", async () => {
    for (const t of await q<{ id: string; name: string }>("select id, name::text as name from crm_tags where org_id = $1", [A.orgId])) a.tags.set(t.name, t.id);
    expect([...a.tags.keys()].sort()).toEqual(["New patient", "VIP"]);
    expect((await q<{ label: string }>("select label from crm_custom_fields where org_id = $1 order by label", [A.orgId])).map((f) => f.label)).toEqual(["Insurance Provider", "Preferred Service"]);
    const values = await q<{ key: string; value: string; required: boolean }>("select key, value, required from crm_custom_values where org_id = $1 order by key", [A.orgId]);
    expect(values.find((v) => v.key === "booking_link")?.value).toBe("https://book.example.com/smile");
    expect(values.find((v) => v.key === "payment_api_key")).toMatchObject({ value: "", required: true });

    const pipe = (await one<{ id: string; name: string; provider: string }>("select id, name, provider from crm_pipelines where org_id = $1 and name = 'Patient Journey'", [A.orgId]))!;
    expect(pipe.provider).toBe("native");
    a.pipelineId = pipe.id;
    for (const s of await q<{ id: string; name: string; pipeline_id: string }>("select id, name, pipeline_id from crm_pipeline_stages where org_id = $1 order by position", [A.orgId])) {
      expect(s.pipeline_id).toBe(pipe.id);
      a.stages.set(s.name, s.id);
    }
    expect([...a.stages.keys()]).toEqual(["New Lead", "Consult Booked", "Won", "Lost"]);

    // Scheduling: draft calendars (no bookings, no page, not the default, no hosts yet) with their appointment types and suggested hours.
    for (const c of await q<{ id: string; name: string; status: string; public: boolean; is_default: boolean; origin: string; timezone: string; folder_id: string | null; hours: number }>(
      "select id, name, status, public, is_default, origin, timezone, folder_id, jsonb_array_length(hours_template) as hours from crm_calendars where org_id = $1", [A.orgId],
    )) {
      expect(c).toMatchObject({ status: "draft", public: false, is_default: false, origin: "blueprint", timezone: "America/Chicago" });
      expect(Number(c.hours)).toBe(5);
      a.calendars.set(c.name, c.id);
    }
    expect([...a.calendars.keys()].sort()).toEqual(["New Patient Consult", "Video Check-in"]);
    expect(await q("select 1 from crm_calendar_members where org_id = $1", [A.orgId])).toHaveLength(0);
    for (const t of await q<{ id: string; name: string; calendar_id: string; meeting_provider: string; duration_minutes: number }>(
      "select id, name, calendar_id, meeting_provider, duration_minutes from crm_appointment_types where org_id = $1", [A.orgId],
    )) a.types.set(t.name, t.id);
    expect(a.types.size).toBe(2);
    const folder = (await one<{ name: string; kind: string }>("select f.name, f.kind from crm_calendars c join crm_folders f on f.id = c.folder_id where c.id = $1", [a.calendars.get("New Patient Consult")]))!;
    expect(folder).toEqual({ name: "Dental Team", kind: "calendar" });

    // Forms and workflows arrive as drafts; the finished ones point at this client's own tags, fields, pipeline, stages and forms.
    for (const f of await q<{ id: string; name: string; status: string }>("select id, name, status from crm_forms where org_id = $1", [A.orgId])) {
      expect(f.status).toBe("draft");
      a.forms.set(f.name, f.id);
    }
    expect([...a.forms.keys()].sort()).toEqual(["Contact Us", "New Patient Intake", "Satisfaction Survey"]);
    for (const w of await q<{ id: string; name: string; status: string }>("select id, name, status from crm_workflows where org_id = $1", [A.orgId])) {
      expect(w.status).toBe("draft");
      a.workflows.set(w.name, w.id);
    }
    expect([...a.workflows.keys()].sort()).toEqual(["Appointment Reminder", "Lead Nurture", "Welcome email"]);
    const intake = (await one<{ draft: { actions: { tagIds: string[]; opportunity: { pipelineId: string; stageId: string } } } }>("select draft from crm_forms where id = $1", [a.forms.get("New Patient Intake")]))!;
    expect(intake.draft.actions.tagIds).toEqual([a.tags.get("New patient")]);
    expect(intake.draft.actions.opportunity).toMatchObject({ pipelineId: a.pipelineId, stageId: a.stages.get("New Lead") });
    const reminder = strings((await one<{ draft: unknown }>("select draft from crm_workflows where id = $1", [a.workflows.get("Appointment Reminder")]))!.draft);
    expect(reminder).toEqual(expect.arrayContaining([a.forms.get("New Patient Intake"), a.tags.get("VIP"), a.pipelineId, a.stages.get("Consult Booked")]));
    expect((await one<{ status: string }>("select status from crm_message_templates where org_id = $1 and key = 'welcome_email'", [A.orgId]))?.status).toBe("draft");

    // No logical "@…" reference is left, and every id a definition names is one of this workspace's own records.
    const own = await workspaceIds(A.orgId);
    const defs = await definitions(A.orgId);
    expect(strings(defs).filter((s) => s.startsWith("@"))).toEqual([]);
    for (const id of JSON.stringify(defs).match(UUIDS) ?? []) expect(own.has(id), id).toBe(true);
    const everything = JSON.stringify(await q(`select draft from crm_forms where org_id = $1 union all select draft from crm_workflows where org_id = $1
      union all select hours_template from crm_calendars where org_id = $1`, [A.orgId]));
    for (const ghlId of ALL_GHL_IDS) expect(everything, ghlId).not.toContain(ghlId);
  });

  it("7. shows the client's setup checklist with evidence: a sender employee included, no Hermes task, placeholders to rebuild", async () => {
    const list = await getBlueprintChecklist(A.owner);
    const by = Object.fromEntries(list.items.map((i) => [i.key, i]));
    // The welcome workflow sends as the sales assistant, which onboarding included for this client.
    expect(by.ai_employee).toMatchObject({ status: "done" });
    expect(by.hermes).toBeUndefined();
    for (const key of ["calendar_hosts", "calendar_verification", "google_calendar", "form_rebuild", "workflow_rebuild", "custom_values", "form_publishing", "email_provider", "template_approval"] as const) {
      expect(by[key]?.status, key).toBe("pending");
    }
    expect(by.form_rebuild.detail).toMatch(/Contact Us/);
    expect(by.workflow_rebuild.detail).toMatch(/Lead Nurture/);
    expect(by.custom_values.detail).toMatch(/Payment API Key/);
    // Applying a Blueprint never ticks anything that needs evidence.
    expect(list.done).toBe(list.items.filter((i) => i.status === "done").length);
    expect(list.items.filter((i) => i.status === "done").map((i) => i.key)).toEqual(["ai_employee"]);
  });

  it("8. lets the client customize its copies (rename a tag, add a stage, edit a form), and the agency's next version never overwrites them", async () => {
    await updateTag(A.owner, a.tags.get("VIP")!, { name: "VIP patient" });
    const extra = await addStage(A.owner, a.pipelineId, { name: "Insurance check", afterStageId: a.stages.get("New Lead") });
    const form = await getForm(A.owner, a.forms.get("New Patient Intake")!);
    const edited = { ...form.draft, questions: form.draft.questions.map((x) => (x.key === "insurance" ? { ...x, label: "Dental insurance (if any)" } : x)), settings: { ...form.draft.settings, intro: "Our own words." } };
    const savedForm = await saveFormDraft(A.owner, form.id, { draft: edited, expectedRevision: form.draftRevision });
    expect(savedForm.issues.filter((i) => i.level === "error")).toEqual([]);

    // The agency publishes version 2: VIP gets a description, a new tag and stage, and new wording on the intake form.
    const detail = await getBlueprint(admin, blueprintId);
    const c: BlueprintContent = JSON.parse(JSON.stringify(detail.draft));
    named(c.assets.tags, "VIP").description = "Long-standing patients";
    c.assets.tags.push({ id: "tag.recall-due", name: "Recall due", color: "#16a34a", description: null, folder: null });
    c.assets.pipelines[0].stages.splice(2, 0, { id: `stage.${c.assets.pipelines[0].id.split(".").pop()}.treatment-plan`, name: "Treatment plan", kind: "open", probability: 60, color: null });
    (named(c.assets.forms, "New Patient Intake") as FormAsset).draft.settings.intro = "The agency's new wording.";
    const saved = await saveDraft(admin, blueprintId, { content: c, revision: detail.draftRevision });
    expect(saved.errors).toEqual([]);
    const v2 = await publishBlueprint(admin, blueprintId, { revision: saved.revision, changeSummary: "Recall tag and treatment stage." });
    expect(v2.version).toBe(2);
    // Nothing reaches the client by itself.
    expect(await q("select 1 from crm_tags where org_id = $1 and name = 'Recall due'", [A.orgId])).toHaveLength(0);

    // The agency reviews the update for this client: the client's own changes are conflicts left as they are; the rest is added.
    const options = { strategy: "update_compatible" as const };
    const preview = await previewApplication(admin, A.orgId, { blueprintId, version: 2, options });
    const items = Object.fromEntries(preview.plan.items.map((i) => [i.name, i]));
    expect(preview.plan.mode).toBe("update");
    expect(items["VIP"]).toMatchObject({ action: "conflict", existing: { name: "VIP patient" } });
    expect(items["VIP"].reason).toMatch(/changed in this workspace/);
    expect(items["New Patient Intake"].action).toBe("conflict");
    expect(items["Recall due"].action).toBe("create");
    expect(items["Treatment plan"].action).toBe("create");
    const res = await applyBlueprint(admin, A.orgId, { blueprintId, version: 2, options, planDigest: preview.plan.digest, idempotencyKey: `acceptance-update-${uid()}${uid()}` });
    expect(["applied", "partially_applied"]).toContain(res.application.status);

    const names = (await q<{ name: string }>("select name::text as name from crm_tags where org_id = $1 order by name", [A.orgId])).map((t) => t.name);
    expect(names).toEqual(["New patient", "Recall due", "VIP patient"]);
    const vip = (await one<{ description: string | null }>("select description from crm_tags where id = $1", [a.tags.get("VIP")]))!;
    expect(vip.description).toBeNull();
    const stages = (await q<{ id: string; name: string }>("select id, name from crm_pipeline_stages where org_id = $1 and pipeline_id = $2 order by position", [A.orgId, a.pipelineId])).map((s) => s.name);
    expect(stages).toEqual(expect.arrayContaining(["New Lead", "Insurance check", "Consult Booked", "Treatment plan", "Won", "Lost"]));
    expect(stages).toHaveLength(6);
    expect((await one<{ id: string }>("select id from crm_pipeline_stages where id = $1", [extra.id]))?.id).toBe(extra.id);
    const after = await getForm(A.owner, form.id);
    expect(after.draft.settings.intro).toBe("Our own words.");
    expect(after.draft.questions.find((x) => x.key === "insurance")?.label).toBe("Dental insurance (if any)");

    // Applying the same version again changes nothing.
    const before = JSON.stringify(await q("select id, name::text from crm_tags where org_id = $1 order by id", [A.orgId]));
    const again = await planApplication(admin, A.orgId, { blueprintId, version: 2, options: { strategy: "add_missing" } });
    expect(again.items.filter((i) => i.action === "create" || i.action === "update")).toEqual([]);
    expect(JSON.stringify(await q("select id, name::text from crm_tags where org_id = $1 order by id", [A.orgId]))).toBe(before);
  });

  it("9. keeps a second client's copy separate, and that client can't see any of the first client's records (row-level security and services)", async () => {
    const res = await createClientTenant(admin, { name: `Second Dental ${uid()}`, ownerEmail: `owner-${uid()}@example.test`, enabledRoles: ["sales_assistant"], blueprint: { kind: "blueprint", blueprintId } });
    expect(res.blueprint?.status).toBe("applied");
    const owner = await ownerOf(res.orgId);
    B = { orgId: res.orgId, owner: owner.actor, ownerId: owner.userId };

    // Its own copies of the latest version, independent of the first client's customizations.
    expect((await listTags(B.owner)).map((t) => t.name).sort()).toEqual(["New patient", "Recall due", "VIP"]);
    const aIds = await workspaceIds(A.orgId);
    const bIds = await workspaceIds(B.orgId);
    expect([...bIds].filter((id) => aIds.has(id))).toEqual([]);
    expect(strings(await definitions(B.orgId)).filter((s) => aIds.has(s))).toEqual([]);

    // Row-level security: signed in as the second client's owner, none of the first client's rows exist.
    for (const table of ["crm_tags", "crm_custom_fields", "crm_custom_values", "crm_pipelines", "crm_pipeline_stages", "crm_calendars", "crm_appointment_types", "crm_forms", "crm_workflows", "crm_message_templates", "crm_blueprint_links", "crm_blueprint_applications"]) {
      const seen = await withUser(B.ownerId, (db) => db.query(`select 1 from ${table} where org_id = $1`, [A.orgId]));
      expect(seen.rows, table).toEqual([]);
      const all = await withUser(B.ownerId, (db) => db.query<{ org_id: string }>(`select distinct org_id from ${table}`));
      expect(all.rows.every((r) => r.org_id === B.orgId), table).toBe(true);
    }
    // Services: the first client's records are simply not found for the second client.
    await expect(getForm(B.owner, a.forms.get("New Patient Intake")!)).rejects.toMatchObject({ code: "not_found" });
    await expect(getWorkflow(B.owner, a.workflows.get("Appointment Reminder")!)).rejects.toMatchObject({ code: "not_found" });
    await expect(startTestRun(B.owner, a.workflows.get("Appointment Reminder")!, { source: "draft" })).rejects.toMatchObject({ code: "not_found" });
    await expect(updateTag(B.owner, a.tags.get("VIP")!, { name: "Taken over" })).rejects.toMatchObject({ code: "not_found" });
    await expect(verifyCalendar(B.owner, a.calendars.get("New Patient Consult")!)).rejects.toMatchObject({ code: "not_found" });
    expect((await listPipelines(B.owner)).flatMap((p) => p.stages.map((s) => s.id)).some((id) => aIds.has(id))).toBe(false);
    const bChecklist = await getBlueprintChecklist(B.owner);
    expect(JSON.stringify(bChecklist)).not.toContain(A.orgId);
    // An agency staff member who isn't assigned to the first client can't even preview applying to it.
    await expect(planApplication(staff, A.orgId, { blueprintId, options: { strategy: "add_missing" } })).rejects.toMatchObject({ code: "not_found" });
    expect((await one<{ name: string }>("select name::text as name from crm_tags where id = $1", [a.tags.get("VIP")]))?.name).toBe("VIP patient");
  });

  it("10. read GoHighLevel only with GETs to the official host, and left the source exactly as it was", () => {
    expect(ghlCalls.length).toBeGreaterThan(10);
    expect(ghlCalls.every((c) => c.method === "GET")).toBe(true);
    expect(ghlCalls.every((c) => c.url.origin === "https://services.leadconnectorhq.com")).toBe(true);
    expect(ghlCalls.every((c) => c.body === null)).toBe(true);
    // Only the documented read routes, and never the snapshot, templates or a write endpoint.
    const paths = new Set(ghlCalls.map((c) => c.url.pathname));
    for (const p of paths) expect(Object.keys(SOURCE), p).toContain(p);
    expect([...paths].some((p) => /snapshot|templates|contacts|opportunities\/(?!pipelines)/.test(p))).toBe(false);
    expect(JSON.stringify(SOURCE)).toBe(SOURCE_BEFORE);
    // The identity check ran before anything else in each read, and the token only ever went in the Authorization header.
    expect(ghlCalls[0].url.pathname).toBe(`/locations/${LOC}`);
    expect(ghlCalls.some((c) => c.url.search.includes(TOKEN))).toBe(false);
  });

  it("11. runs those assets in the native CRM with no GoHighLevel connection: activate and book a calendar, publish and submit a form, test-run a workflow draft", async () => {
    for (const orgId of [A.orgId, B.orgId]) {
      expect((await one<{ mode: string }>("select mode from crm_workspaces where org_id = $1", [orgId]))?.mode).toBe("native");
      expect(await q("select 1 from integration_connections where org_id = $1 and provider = 'ghl'", [orgId])).toHaveLength(0);
      expect(await q("select 1 from ghl_location_mappings where org_id = $1", [orgId])).toHaveLength(0);
    }
    const spy = noNetwork();
    try {
      // Calendar: draft until verified. The client assigns a host, takes the suggested hours, and activates it.
      const consult = a.calendars.get("New Patient Consult")!;
      const draftCheck = await verifyCalendar(A.owner, consult, { now: NOW });
      expect(draftCheck.ok).toBe(false);
      expect(draftCheck.checks.find((c) => c.key === "hosts")?.ok).toBe(false);
      await updateCalendar(A.owner, consult, { members: [{ userId: A.ownerId }], useHoursTemplate: true });
      const activated = await activateCalendar(A.owner, consult, { now: NOW });
      expect(activated.activated).toBe(true);
      expect(activated.verification.firstOpenTime).not.toBeNull();
      await setCalendarPublic(A.owner, consult, true);
      const booked = await bookNativeAppointment(await bookingPageActor(A.orgId), {
        typeId: a.types.get("New Patient Consult")!, startAt: new Date(activated.verification.firstOpenTime!.start), via: "booking_page", now: NOW,
        contact: { firstName: "Paula", lastName: "Patient", email: `paula-${uid()}@example.test` },
      });
      expect(booked).toMatchObject({ created: true, hostIds: [A.ownerId] });
      // The Google Meet calendar can't go live without the host's connected Google Calendar.
      const video = a.calendars.get("Video Check-in")!;
      await updateCalendar(A.owner, video, { members: [{ userId: A.ownerId }] });
      const refused = await activateCalendar(A.owner, video, { now: NOW });
      expect(refused.activated).toBe(false);
      expect(refused.verification.checks.find((c) => c.key === "connections")?.ok).toBe(false);
      expect((await one<{ status: string }>("select status from crm_calendars where id = $1", [video]))?.status).toBe("draft");

      // Form: the client publishes its edited intake form on a hosted page, and a visitor submits it.
      const formId = a.forms.get("New Patient Intake")!;
      await updateFormSettings(A.owner, formId, { hosted: true });
      await publishForm(A.owner, formId);
      const form = await getForm(A.owner, formId);
      const sent = await handleHostedSubmit(visitor(), raw({
        org: A.slug, key: form.key, t: hostedFormToken(A.slug, form.key, NOW.getTime() - 10_000),
        "q.first_name": "Nora", "q.last_name": "Newpatient", "q.email": "nora.newpatient@example.test", "q.insurance": "Example Dental Plan", consent: "yes",
      }));
      expect(sent).toMatchObject({ ok: true, status: 201 });
      await processFormSubmissions({ now: NOW, limit: 50 });
      const sub = (await one<{ status: string; contact_id: string; opportunity_id: string }>("select status, contact_id, opportunity_id from crm_form_submissions where form_id = $1", [formId]))!;
      expect(sub.status).toBe("processed");
      const tags = (await q<{ tag_id: string }>("select tag_id from crm_contact_tags where contact_id = $1", [sub.contact_id])).map((t) => t.tag_id);
      expect(tags).toEqual([a.tags.get("New patient")]);
      const deal = (await one<{ provider: string; pipeline_ref: string; stage_ref: string }>("select provider, pipeline_ref, stage_ref from crm_opportunities where id = $1", [sub.opportunity_id]))!;
      expect(deal).toEqual({ provider: "native", pipeline_ref: a.pipelineId, stage_ref: a.stages.get("New Lead") });
      const insurance = await one<{ value_text: string | null; field_org: string }>(
        `select v.value_text, f.org_id as field_org from crm_field_values v join crm_custom_fields f on f.id = v.field_id
         where v.entity = 'contact' and v.entity_id = $1 and f.label = 'Insurance Provider'`, [sub.contact_id],
      );
      expect(insurance).toEqual({ value_text: "Example Dental Plan", field_org: A.orgId });

      // Workflow: the rebuilt reminder is a draft, so the submission started nothing; a test run walks it for that contact without doing anything.
      expect(await q("select 1 from crm_workflow_runs where org_id = $1 and started_via <> 'test'", [A.orgId])).toHaveLength(0);
      const wf = a.workflows.get("Appointment Reminder")!;
      const test = await startTestRun(A.owner, wf, { source: "draft", contactId: sub.contact_id });
      expect(test.issues.filter((i) => i.level === "error")).toEqual([]);
      expect(test.steps.map((s) => s.stepKey)).toEqual(["tag", "deal"]);
      expect(test.steps.every((s) => s.outcome !== "would_fail")).toBe(true);
      expect((await q<{ tag_id: string }>("select tag_id from crm_contact_tags where contact_id = $1", [sub.contact_id])).map((t) => t.tag_id)).toEqual([a.tags.get("New patient")]);
      // The client can rebuild a placeholder workflow too, entirely natively.
      const nurture = await getWorkflow(A.owner, a.workflows.get("Lead Nurture")!);
      const rebuilt = await saveWorkflowDraft(A.owner, nurture.id, {
        expectedRevision: nurture.draftRevision,
        definition: { trigger: { type: "manual" }, steps: [{ key: "tag", kind: "add_tag", config: { tagIds: [(await one<{ id: string }>("select id from crm_tags where org_id = $1 and name = 'Recall due'", [A.orgId]))!.id] } }] },
      });
      expect(rebuilt.issues.filter((i) => i.level === "error")).toEqual([]);
    } finally {
      spy.mockRestore();
    }
    // Nothing in the native part reached the network.
    expect(offlineCalls).toEqual([]);
  });
});
