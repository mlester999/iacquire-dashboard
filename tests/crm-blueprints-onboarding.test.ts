// CRM Blueprints in onboarding: creating a client on iAcquire Native CRM (or GoHighLevel) with a blank CRM, a published Blueprint or an
// iAcquire starter; the Blueprint is applied after the client is committed, recorded as an onboarding application, and a failure never undoes
// the client or its invitation. Also the client's "Blueprints & setup" page and the agency's Blueprint card. Synthetic data only: nothing
// here contacts a provider.
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { agencyActor, memberActor, startSupportSession } from "@/server/crm/actor";
import { scopeFor } from "@/server/crm/page";
import {
  applyOnboardingBlueprint, blueprintRetryPath, createClientTenant, createTenantSchema, listOnboardingBlueprintChoices, onboardingIdempotencyKey,
} from "@/server/admin/tenants";
import { createBlueprint, listStarters, publishBlueprint, saveDraft } from "@/server/crm/blueprints/library";
import { BLUEPRINT_FORMAT, type AssetTypeMap, type BlueprintContent } from "@/lib/crm/blueprints/types";
import { CRM_NAV, navFor } from "@/lib/crm/nav";
import { INDUSTRY_OPTIONS, industryKeyForLabel, rankForIndustry } from "@/components/crm/blueprints/industry";
import { draftNotes } from "@/components/crm/blueprints/labels";
import { countsSummary, OnboardingBlueprintOutcome } from "@/components/crm/blueprints/onboarding-result";
import { OnboardingBlueprintPicker, choiceFor } from "@/components/crm/blueprints/onboarding-picker";
import { BlueprintSetupScreen, placeFor } from "@/components/crm/blueprints/setup-screen";
import { blueprintRows, ClientBlueprintCardView, loadClientBlueprintCard } from "@/components/crm/blueprints/client-blueprint-card";
import { BlueprintsView, loadBlueprintSetup } from "@/components/crm/views/blueprints-view";
import type { ApplicationSummary } from "@/lib/crm/blueprints/views";
import { addMember, agencyUser, createUser, ctxFor, uid } from "./support/fixtures";

// Lets a test make the apply step fail after the client was committed; every other call goes to the real apply engine.
const h = vi.hoisted(() => ({ failApply: null as Error | null }));
vi.mock("@/server/crm/blueprints/apply", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/server/crm/blueprints/apply")>();
  return {
    ...mod,
    applyBlueprint: async (...args: Parameters<typeof mod.applyBlueprint>) => {
      if (h.failApply) throw h.failApply;
      return mod.applyBlueprint(...args);
    },
  };
});

afterEach(() => {
  h.failApply = null;
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const apptype = (id: string, name: string): AssetTypeMap["appointmentType"] => ({
  id, name, description: null, durationMinutes: 60, slotIntervalMinutes: null, bufferBeforeMinutes: 0, bufferAfterMinutes: 15, minNoticeMinutes: 120, maxDaysAhead: 60,
  dailyLimit: null, capacity: 1, locationKind: "in_person", locationDetail: "At the customer's home", meetingProvider: "none", meetingLink: null, requiresConfirmation: false,
  public: true, questions: [], color: null, confirmationMessage: null, allowCustomerChanges: true, changeCutoffMinutes: 0, requireEmail: true, requirePhone: false,
});

function content(name = "Onboarding Home Services"): BlueprintContent {
  return {
    format: BLUEPRINT_FORMAT,
    schemaVersion: 1,
    blueprint: { key: "onboarding-home-services", name, description: "Synthetic onboarding fixture.", industry: "home_services" },
    settings: { defaultCurrency: null },
    slots: [],
    assets: {
      folders: [],
      tags: [
        { id: "tag.hot-lead", name: "Hot lead", color: "#dc2626", description: null, folder: null },
        { id: "tag.quote-sent", name: "Quote sent", color: "#2563eb", description: null, folder: null },
      ],
      customFields: [
        { id: "field.contact.budget", entity: "contact", key: "budget", label: "Budget", type: "number", options: [], required: false, helpText: null, groupName: null },
        { id: "field.contact.service", entity: "contact", key: "service", label: "Service", type: "select", options: [{ value: "repair", label: "Repair" }, { value: "install", label: "Install" }], required: false, helpText: null, groupName: null },
      ],
      customValues: [{ id: "value.booking-link", key: "booking_link", label: "Booking link", type: "url", value: "", required: true, groupName: null }],
      pipelines: [
        {
          id: "pipeline.sales", name: "Sales", description: null, isDefault: true, stages: [
            { id: "stage.sales.new", name: "New", kind: "open", probability: 10, color: null },
            { id: "stage.sales.quoted", name: "Quoted", kind: "open", probability: 50, color: null },
            { id: "stage.sales.won", name: "Won", kind: "won", probability: 100, color: null },
            { id: "stage.sales.lost", name: "Lost", kind: "lost", probability: 0, color: null },
          ],
        },
      ],
      calendars: [
        {
          id: "calendar.estimates", name: "Estimates", description: null, assignment: "single", roundRobinMode: "balanced", color: null, folder: null, bookingIntro: null,
          timezone: "America/New_York", hours: [{ weekday: 1, startMinute: 540, endMinute: 1020 }], hosts: [], types: [apptype("apptype.estimates.onsite", "On-site estimate")],
        },
      ],
      smartLists: [],
      assignmentRules: [],
      forms: [
        {
          id: "form.estimate-request", key: "estimate-request", name: "Estimate request", kind: "form", purpose: "quote", folder: null, placeholder: false,
          draft: {
            questions: [
              { key: "first_name", type: "short_text", label: "First name", required: true, width: "half", map: "contact.first_name" },
              { key: "email", type: "email", label: "Email", required: true, width: "half", map: "contact.email" },
              { key: "budget", type: "number", label: "Budget", required: false, map: "@field.contact.budget" },
            ],
            consent: { text: "I agree to be contacted by email or text message about my estimate request.", marketing: { enabled: false, text: "Send me occasional news and offers." } },
            actions: {
              tagIds: ["@tag.hot-lead"], opportunity: { pipelineId: "@pipeline.sales", stageId: "@stage.sales.new", name: "{{contact.full_name}} – {{form.name}}", valueQuestion: "budget" },
              assignmentRuleId: null, notify: { roles: ["owner"], contactOwner: false }, after: { kind: "message", message: "Thanks! We'll be in touch." },
            },
            settings: { title: "", intro: "", submitLabel: "Send" },
          },
        },
      ],
      messageTemplates: [
        {
          id: "template.estimate-reminder", kind: "template", key: "estimate_reminder", name: "Estimate reminder", channel: "sms", purpose: "service", category: null, folder: null,
          subject: null, body: "Hi {{contact.first_name}}, rebook any time: {{custom_values.booking_link}}", whatsapp: null, placeholder: false,
        },
      ],
      workflows: [
        {
          id: "workflow.new-lead", key: "new_lead", name: "New lead follow-up", description: null, folder: null, hourlyRunLimit: 500, placeholder: false,
          definition: {
            trigger: { type: "contact.tag_added", filters: { tagIds: ["@tag.hot-lead"] }, reentry: "once" },
            steps: [
              { key: "deal", kind: "create_opportunity", config: { name: "{{contact.full_name}}", pipelineId: "@pipeline.sales", stageId: "@stage.sales.new", ownerFromContact: true, skipIfOpenInPipeline: true }, next: "tag" },
              { key: "tag", kind: "add_tag", config: { tagIds: ["@tag.quote-sent"] }, next: "move" },
              { key: "move", kind: "move_stage", config: { pipelineId: "@pipeline.sales", stageId: "@stage.sales.quoted" }, next: null },
            ],
          },
        },
      ],
      reports: [],
    },
  };
}

async function superAdmin() {
  return agencyUser(await createUser({ platformRole: "agency_super_admin", name: "Agency Admin" }), "agency_super_admin");
}

/** A published Blueprint in the library, built through the library's own create → save → publish. */
async function publishedBlueprint(admin: Awaited<ReturnType<typeof superAdmin>>, c: BlueprintContent = content()) {
  const { id } = await createBlueprint(admin, { name: c.blueprint.name, industry: c.blueprint.industry, from: { kind: "blank" } });
  const saved = await saveDraft(admin, id, { content: c, revision: 1 });
  expect(saved.errors).toEqual([]);
  const published = await publishBlueprint(admin, id, { revision: saved.revision });
  return { id, revision: saved.revision, ...published };
}

const newClient = (extra: Partial<Parameters<typeof createClientTenant>[1]> = {}) => ({
  name: `Onboard Co ${uid()}`,
  ownerEmail: `owner-${uid()}@example.test`,
  industry: "Home Services",
  enabledRoles: ["lead_hunter" as const],
  ...extra,
});

async function rows<T extends Record<string, unknown>>(sql: string, params: unknown[]) {
  return (await withSystem((db) => db.query<T>(sql, params))).rows;
}

async function crmCounts(orgId: string) {
  const [r] = await rows<Record<string, number>>(
    `select (select count(*)::int from crm_tags where org_id = $1) as tags,
            (select count(*)::int from crm_custom_fields where org_id = $1) as fields,
            (select count(*)::int from crm_custom_values where org_id = $1) as "values",
            (select count(*)::int from crm_pipeline_stages where org_id = $1) as stages,
            (select count(*)::int from crm_forms where org_id = $1) as forms,
            (select count(*)::int from crm_calendars where org_id = $1) as calendars,
            (select count(*)::int from crm_message_templates where org_id = $1) as templates,
            (select count(*)::int from crm_workflows where org_id = $1) as workflows,
            (select count(*)::int from crm_blueprint_applications where org_id = $1) as applications`,
    [orgId],
  );
  return r;
}

async function ownerActor(orgId: string) {
  const [org] = await rows<{ id: string; name: string; slug: string }>("select id, name, slug from organizations where id = $1", [orgId]);
  const owner = await createUser({ name: "Client Owner" });
  await addMember(orgId, owner.id, "owner");
  return memberActor(ctxFor(owner, org, "owner"));
}

/** Every string inside a JSON value. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => strings(x, out));
  return out;
}

// ---------------------------------------------------------------------------
// Creating a client with a Blueprint
// ---------------------------------------------------------------------------

describe("creating a client with a published Blueprint", () => {
  it("populates the new workspace with its own records and records an onboarding application", async () => {
    const admin = await superAdmin();
    const bp = await publishedBlueprint(admin);
    const res = await createClientTenant(admin, newClient({ blueprint: { kind: "blueprint", blueprintId: bp.id } }));
    const orgId = res.orgId;

    expect(res.crmMode).toBe("native");
    expect(res.blueprint).toMatchObject({ status: "applied", blueprintId: bp.id, version: 1 });
    expect(res.blueprint?.applicationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.blueprint?.requirements).toEqual(expect.arrayContaining(["calendar_verification", "custom_values", "form_publishing", "workflow_activation"]));
    expect(res.blueprint?.retryPath).toBe(`/admin/crm-blueprints/${bp.id}/apply?client=${orgId}`);

    // The client and its invitation exist as before; the industry label is what organizations.industry stores.
    const [org] = await rows<{ industry: string; status: string }>("select industry, status from organizations where id = $1", [orgId]);
    expect(org).toEqual({ industry: "Home Services", status: "invited" });
    expect(await rows("select 1 from invitations where org_id = $1 and revoked_at is null and accepted_at is null", [orgId])).toHaveLength(1);
    const [ws] = await rows<{ mode: string; blueprint_key: string | null; initialized_at: Date | null }>("select mode, blueprint_key, initialized_at from crm_workspaces where org_id = $1", [orgId]);
    expect(ws.mode).toBe("native");
    expect(ws.initialized_at).not.toBeNull();

    const tags = await rows<{ id: string; name: string }>("select id, name::text as name from crm_tags where org_id = $1 order by name", [orgId]);
    expect(tags.map((t) => t.name)).toEqual(["Hot lead", "Quote sent"]);
    const fields = await rows<{ id: string; key: string }>("select id, key from crm_custom_fields where org_id = $1 order by key", [orgId]);
    expect(fields.map((f) => f.key)).toEqual(["budget", "service"]);
    const pipelines = await rows<{ id: string; name: string }>("select id, name from crm_pipelines where org_id = $1", [orgId]);
    expect(pipelines.map((p) => p.name)).toEqual(["Sales"]);
    const stages = await rows<{ id: string; name: string; pipeline_id: string }>("select id, name, pipeline_id from crm_pipeline_stages where org_id = $1 order by position", [orgId]);
    expect(stages.map((s) => s.name)).toEqual(["New", "Quoted", "Won", "Lost"]);
    expect(new Set(stages.map((s) => s.pipeline_id))).toEqual(new Set([pipelines[0].id]));

    // Forms arrive as drafts whose references are this workspace's own ids.
    const [form] = await rows<{ status: string; draft: { actions: { tagIds: string[]; opportunity: { pipelineId: string; stageId: string } }; questions: Array<{ key: string; map?: string }> } }>(
      "select status, draft from crm_forms where org_id = $1 and key = 'estimate-request'", [orgId],
    );
    expect(form.status).toBe("draft");
    expect(form.draft.actions.tagIds).toEqual([tags.find((t) => t.name === "Hot lead")!.id]);
    expect(form.draft.actions.opportunity).toMatchObject({ pipelineId: pipelines[0].id, stageId: stages.find((s) => s.name === "New")!.id });
    expect(strings(form.draft).some((s) => s.startsWith("@"))).toBe(false);

    // Calendars arrive as drafts: not public, not the default, no hosts; their appointment types come along.
    const [cal] = await rows<{ id: string; status: string; public: boolean; is_default: boolean; origin: string; timezone: string | null }>(
      "select id, status, public, is_default, origin, timezone from crm_calendars where org_id = $1", [orgId],
    );
    expect(cal).toMatchObject({ status: "draft", public: false, is_default: false, origin: "blueprint", timezone: "America/New_York" });
    expect(await rows("select 1 from crm_calendar_members where calendar_id = $1", [cal.id])).toHaveLength(0);
    expect((await rows<{ name: string }>("select name from crm_appointment_types where org_id = $1 and calendar_id = $2", [orgId, cal.id])).map((t) => t.name)).toEqual(["On-site estimate"]);

    // Workflows arrive as drafts (nothing runs), wired to this workspace's tags, pipeline and stages.
    const [wf] = await rows<{ status: string; draft: unknown }>("select status, draft from crm_workflows where org_id = $1 and key = 'new_lead'", [orgId]);
    expect(wf.status).toBe("draft");
    const wfStrings = strings(wf.draft);
    expect(wfStrings).toEqual(expect.arrayContaining([tags[0].id, tags[1].id, pipelines[0].id, stages[0].id, stages[1].id]));
    expect(wfStrings.some((s) => s.startsWith("@"))).toBe(false);

    const [tpl] = await rows<{ status: string }>("select status from crm_message_templates where org_id = $1 and key = 'estimate_reminder'", [orgId]);
    expect(tpl.status).toBe("draft");

    const apps = await rows<{ id: string; requested_via: string; strategy: string; idempotency_key: string; version_id: string; requested_by: string }>(
      "select id, requested_via, strategy, idempotency_key, version_id, requested_by from crm_blueprint_applications where org_id = $1", [orgId],
    );
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({ id: res.blueprint!.applicationId, requested_via: "onboarding", strategy: "add_missing", requested_by: admin.id });
    expect(apps[0].idempotency_key).toBe(onboardingIdempotencyKey(orgId, bp.versionId));

    const [audit] = await rows<{ metadata: { crmMode: string; blueprint: { blueprintId: string } } }>("select metadata from audit_logs where org_id = $1 and action = 'tenant.created'", [orgId]);
    expect(audit.metadata).toMatchObject({ crmMode: "native", blueprint: { blueprintId: bp.id } });
  });

  it("gives each new client independent copies that never point at another client's records", async () => {
    const admin = await superAdmin();
    const bp = await publishedBlueprint(admin);
    const a = await createClientTenant(admin, newClient({ blueprint: { kind: "blueprint", blueprintId: bp.id } }));
    const b = await createClientTenant(admin, newClient({ blueprint: { kind: "blueprint", blueprintId: bp.id } }));
    expect(a.blueprint?.status).toBe("applied");
    expect(b.blueprint?.status).toBe("applied");

    const idsOf = async (orgId: string) => new Set((await rows<{ id: string }>(
      `select id from crm_tags where org_id = $1 union all select id from crm_pipelines where org_id = $1 union all select id from crm_pipeline_stages where org_id = $1
       union all select id from crm_custom_fields where org_id = $1`, [orgId])).map((r) => r.id));
    const aIds = await idsOf(a.orgId);
    const bIds = await idsOf(b.orgId);
    expect([...aIds].some((id) => bIds.has(id))).toBe(false);

    const formsOf = async (orgId: string) => strings((await rows<{ draft: unknown }>("select draft from crm_forms where org_id = $1", [orgId])).map((r) => r.draft));
    expect((await formsOf(b.orgId)).some((s) => aIds.has(s))).toBe(false);
    const wfOf = async (orgId: string) => strings((await rows<{ draft: unknown }>("select draft from crm_workflows where org_id = $1", [orgId])).map((r) => r.draft));
    expect((await wfOf(b.orgId)).some((s) => aIds.has(s))).toBe(false);

    // A client customizing its copy changes nothing for the other.
    await withSystem((db) => db.query("update crm_tags set name = 'Very hot lead' where org_id = $1 and name = 'Hot lead'", [a.orgId]));
    expect((await rows<{ name: string }>("select name::text as name from crm_tags where org_id = $1 order by name", [b.orgId])).map((t) => t.name)).toEqual(["Hot lead", "Quote sent"]);
  });

  it("does not apply twice for the same client and version", async () => {
    const admin = await superAdmin();
    const bp = await publishedBlueprint(admin);
    const res = await createClientTenant(admin, newClient({ blueprint: { kind: "blueprint", blueprintId: bp.id } }));
    const before = await crmCounts(res.orgId);
    const again = await applyOnboardingBlueprint(admin, res.orgId, { kind: "blueprint", blueprintId: bp.id });
    expect(again.status).not.toBe("failed");
    expect(again.applicationId).toBe(res.blueprint!.applicationId);
    expect(await crmCounts(res.orgId)).toEqual(before);
  });

  it("installs a chosen iAcquire starter into the library and applies it", async () => {
    const admin = await superAdmin();
    const starter = (await listStarters(admin)).find((s) => !s.installedId);
    expect(starter).toBeTruthy();
    const res = await createClientTenant(admin, newClient({ blueprint: { kind: "starter", starterKey: starter!.key } }));
    expect(res.blueprint?.status).toBe("applied");
    const [bp] = await rows<{ id: string; source_kind: string; status: string }>("select id, source_kind, status from crm_blueprints where starter_key = $1", [starter!.key]);
    expect(bp).toMatchObject({ id: res.blueprint!.blueprintId, source_kind: "starter", status: "published" });
    const [app] = await rows<{ blueprint_id: string; requested_via: string }>("select blueprint_id, requested_via from crm_blueprint_applications where org_id = $1", [res.orgId]);
    expect(app).toEqual({ blueprint_id: bp.id, requested_via: "onboarding" });
    // Nothing a starter brings is live: calendars and workflows are drafts.
    expect(await rows("select 1 from crm_calendars where org_id = $1 and status <> 'draft'", [res.orgId])).toHaveLength(0);
    expect(await rows("select 1 from crm_workflows where org_id = $1 and status <> 'draft'", [res.orgId])).toHaveLength(0);
  });

  it("offers published Blueprints and not-yet-installed starters to super admins only", async () => {
    const admin = await superAdmin();
    const bp = await publishedBlueprint(admin);
    const { id: draftId } = await createBlueprint(admin, { name: "Draft only", industry: "consulting", from: { kind: "blank" } });
    const choices = await listOnboardingBlueprintChoices(admin);
    expect(choices.canApply).toBe(true);
    expect(choices.canInstallStarters).toBe(true);
    expect(choices.blueprints.map((b) => b.id)).toContain(bp.id);
    expect(choices.blueprints.map((b) => b.id)).not.toContain(draftId);
    expect(choices.blueprints.every((b) => b.status === "published" && b.currentVersion !== null)).toBe(true);
    expect(choices.starters.every((s) => s.installedId === null)).toBe(true);

    const staff = agencyUser(await createUser({ platformRole: "agency_staff" }), "agency_staff");
    await expect(listOnboardingBlueprintChoices(staff)).rejects.toThrow(/super admins/);
  });
});

// ---------------------------------------------------------------------------
// Blank, GoHighLevel, refusals and failures
// ---------------------------------------------------------------------------

describe("the other ways to start a client", () => {
  it("a blank CRM creates nothing", async () => {
    const admin = await superAdmin();
    const res = await createClientTenant(admin, newClient());
    expect(res.blueprint).toBeNull();
    expect(res.crmMode).toBe("native");
    expect(await crmCounts(res.orgId)).toEqual({ tags: 0, fields: 0, values: 0, stages: 0, forms: 0, calendars: 0, templates: 0, workflows: 0, applications: 0 });
    const [ws] = await rows<{ mode: string; blueprint_key: string | null }>("select mode, blueprint_key from crm_workspaces where org_id = $1", [res.orgId]);
    expect(ws).toEqual({ mode: "native", blueprint_key: null });
  });

  it("GoHighLevel mode records the mode and applies nothing", async () => {
    const admin = await superAdmin();
    const res = await createClientTenant(admin, newClient({ crmMode: "ghl" }));
    expect(res.crmMode).toBe("ghl");
    expect(res.blueprint).toBeNull();
    const [ws] = await rows<{ mode: string; updated_by: string }>("select mode, updated_by from crm_workspaces where org_id = $1", [res.orgId]);
    expect(ws).toEqual({ mode: "ghl", updated_by: admin.id });
    expect(await crmCounts(res.orgId)).toMatchObject({ tags: 0, calendars: 0, workflows: 0, applications: 0 });
    // No location is assumed: the mapping is still to be made.
    expect(await rows("select 1 from ghl_location_mappings where org_id = $1", [res.orgId])).toHaveLength(0);
  });

  it("refuses a Blueprint for a GoHighLevel client before creating anything", async () => {
    const admin = await superAdmin();
    const bp = await publishedBlueprint(admin);
    const input = newClient({ crmMode: "ghl", blueprint: { kind: "blueprint", blueprintId: bp.id } });
    expect(createTenantSchema.safeParse(input).success).toBe(false);
    await expect(createClientTenant(admin, input)).rejects.toThrow(/GoHighLevel/);
    expect(await rows("select 1 from organizations where name = $1", [input.name])).toHaveLength(0);
  });

  it("refuses an unknown or unpublished Blueprint before creating anything", async () => {
    const admin = await superAdmin();
    const missing = newClient({ blueprint: { kind: "blueprint", blueprintId: "00000000-0000-4000-8000-000000000000" } });
    await expect(createClientTenant(admin, missing)).rejects.toMatchObject({ code: "not_found" });
    const { id } = await createBlueprint(admin, { name: "Unpublished", industry: "consulting", from: { kind: "blank" } });
    const unpublished = newClient({ blueprint: { kind: "blueprint", blueprintId: id } });
    await expect(createClientTenant(admin, unpublished)).rejects.toMatchObject({ code: "conflict" });
    const unknownStarter = newClient({ blueprint: { kind: "starter", starterKey: "no-such-starter" } });
    await expect(createClientTenant(admin, unknownStarter)).rejects.toMatchObject({ code: "not_found" });
    for (const input of [missing, unpublished, unknownStarter]) expect(await rows("select 1 from organizations where name = $1", [input.name])).toHaveLength(0);
  });

  it("an apply failure leaves the client and the invitation, says why, and links to a retry", async () => {
    const admin = await superAdmin();
    const bp = await publishedBlueprint(admin);
    h.failApply = new AppError("conflict", "The workspace changed since the preview. Preview again.");
    const res = await createClientTenant(admin, newClient({ blueprint: { kind: "blueprint", blueprintId: bp.id } }));
    expect(res.blueprint).toMatchObject({ status: "failed", blueprintId: bp.id, error: "The workspace changed since the preview. Preview again." });
    expect(res.blueprint?.applicationId).toBeUndefined();
    expect(res.blueprint?.retryPath).toBe(blueprintRetryPath(res.orgId, bp.id));
    expect(res.inviteLink).toMatch(/\/invite\//);
    expect(await rows("select 1 from organizations where id = $1", [res.orgId])).toHaveLength(1);
    expect(await rows("select 1 from invitations where org_id = $1 and revoked_at is null", [res.orgId])).toHaveLength(1);
    expect(await crmCounts(res.orgId)).toMatchObject({ tags: 0, applications: 0 });
    const [audit] = await rows<{ result: string; metadata: { blueprintId: string; code: string } }>("select result, metadata from audit_logs where org_id = $1 and action = 'tenant.blueprint_apply_failed'", [res.orgId]);
    expect(audit).toMatchObject({ result: "failure", metadata: { blueprintId: bp.id, code: "conflict" } });

    // An unexpected error never leaks its details.
    h.failApply = new Error("connect ECONNREFUSED 10.0.0.1:5432 password=hunter2");
    const res2 = await createClientTenant(admin, newClient({ blueprint: { kind: "blueprint", blueprintId: bp.id } }));
    expect(res2.blueprint?.status).toBe("failed");
    expect(res2.blueprint?.error).toBe("Something went wrong on our side. Please try again.");

    // Retrying once the problem is gone applies it.
    h.failApply = null;
    const retried = await applyOnboardingBlueprint(admin, res.orgId, { kind: "blueprint", blueprintId: bp.id });
    expect(retried.status).toBe("applied");
    expect((await crmCounts(res.orgId)).applications).toBe(1);
  });

  it("staff can't create clients, with or without a Blueprint", async () => {
    const admin = await superAdmin();
    const bp = await publishedBlueprint(admin);
    const staff = agencyUser(await createUser({ platformRole: "agency_staff" }), "agency_staff");
    const input = newClient({ blueprint: { kind: "blueprint", blueprintId: bp.id } });
    await expect(createClientTenant(staff, input)).rejects.toThrow(/does not allow creating client workspaces/);
    await expect(createClientTenant(staff, newClient())).rejects.toThrow(/does not allow creating client workspaces/);
    expect(await rows("select 1 from organizations where name = $1", [input.name])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The client's "Blueprints & setup" page and the agency's Blueprint card
// ---------------------------------------------------------------------------

describe("Blueprints & setup", () => {
  it("lists what was applied and a checklist that follows the workspace's own evidence", async () => {
    const admin = await superAdmin();
    const bp = await publishedBlueprint(admin);
    const res = await createClientTenant(admin, newClient({ blueprint: { kind: "blueprint", blueprintId: bp.id } }));
    const actor = await ownerActor(res.orgId);
    const scope = await scopeFor(actor, "/crm");

    const data = await loadBlueprintSetup(actor);
    expect(data.mode).toBe("native");
    expect(data.applications).toEqual([expect.objectContaining({ id: res.blueprint!.applicationId, version: 1, status: "applied", via: "onboarding" })]);
    const [cal] = await rows<{ id: string }>("select id from crm_calendars where org_id = $1", [res.orgId]);
    expect(data.draftCalendars).toEqual([{ id: cal.id, name: "Estimates", hosts: 0 }]);
    const item = (k: string) => data.checklist.items.find((i) => i.key === k);
    expect(item("calendar_verification")?.status).toBe("pending");
    expect(item("custom_values")?.status).toBe("pending");
    expect(item("workflow_activation")?.status).toBe("pending");

    let html = renderToStaticMarkup(React.createElement(BlueprintSetupScreen, { scope, data }));
    expect(html).toContain("Blueprints &amp; setup");
    expect(html).toContain("Version 1 · During onboarding");
    expect(html).toContain(`href="/crm/calendars/${cal.id}"`);
    expect(html).toContain("Verify &amp; activate");
    expect(html).toMatch(/data-checklist-key="custom_values" data-status="pending"/);
    expect(html).toContain('href="/crm/settings/values"');

    // Filling in the value is the evidence that marks it done; applying the Blueprint never did.
    await withSystem((db) => db.query("update crm_custom_values set value = 'https://example.test/book' where org_id = $1 and key = 'booking_link'", [res.orgId]));
    const after = await loadBlueprintSetup(actor);
    expect(after.checklist.items.find((i) => i.key === "custom_values")?.status).toBe("done");
    expect(after.checklist.done).toBe(data.checklist.done + 1);
    html = renderToStaticMarkup(React.createElement(BlueprintSetupScreen, { scope, data: after }));
    expect(html).toMatch(/data-checklist-key="custom_values" data-status="done"/);

    // Another client's workspace shows nothing of this one.
    const other = await createClientTenant(admin, newClient());
    const otherData = await loadBlueprintSetup(await ownerActor(other.orgId));
    expect(otherData.applications).toEqual([]);
    expect(otherData.draftCalendars).toEqual([]);
    expect(otherData.checklist.items).toEqual([]);
  });

  it("the agency sees the same page inside a recorded support session, worded for the agency", async () => {
    const admin = await superAdmin();
    const bp = await publishedBlueprint(admin);
    const res = await createClientTenant(admin, newClient({ blueprint: { kind: "blueprint", blueprintId: bp.id } }));
    await expect(agencyActor(admin, res.orgId)).rejects.toThrow(/support session/);
    await startSupportSession(admin, res.orgId, { mode: "read", reason: "Check the onboarding setup" });
    const actor = await agencyActor(admin, res.orgId);
    const base = `/admin/clients/${res.orgId}/crm`;
    const scope = await scopeFor(actor, base);
    const html = renderToStaticMarkup(await BlueprintsView({ actor, scope }));
    expect(html).toContain("Version 1 · During onboarding");
    expect(html).toContain(`href="${base}/settings/values"`);
    // A read-only session can't open Lead Assignment, so the page says where it's done instead of linking.
    expect(html).not.toContain(`href="${base}/settings/assignment"`);
    const [audit] = await rows<{ metadata: { section: string } }>("select metadata from audit_logs where org_id = $1 and action = 'crm.support_view' order by created_at desc limit 1", [res.orgId]);
    expect(audit.metadata.section).toBe("crm_blueprints");
  });

  it("the agency card shows the mode, the applied version, an available update and the checklist", async () => {
    const admin = await superAdmin();
    const bp = await publishedBlueprint(admin);
    const res = await createClientTenant(admin, newClient({ blueprint: { kind: "blueprint", blueprintId: bp.id } }));
    let card = await loadClientBlueprintCard(admin, res.orgId);
    expect(card).not.toBeNull();
    expect(card!.error).toBeNull();
    expect(card!.mode).toBe("native");
    expect(card!.blueprints).toEqual([expect.objectContaining({ blueprintId: bp.id, version: 1, via: "onboarding", status: "applied", updateAvailable: false })]);
    expect(card!.checklist && card!.checklist.total).toBeGreaterThan(0);

    // A newer version is offered for review, never pushed.
    const c2 = content();
    c2.assets.tags.push({ id: "tag.repeat", name: "Repeat customer", color: "#16a34a", description: null, folder: null });
    const saved = await saveDraft(admin, bp.id, { content: c2, revision: bp.revision });
    await publishBlueprint(admin, bp.id, { revision: saved.revision });
    card = await loadClientBlueprintCard(admin, res.orgId);
    expect(card!.blueprints[0]).toMatchObject({ version: 1, latestVersion: 2, updateAvailable: true });
    expect(await rows("select 1 from crm_tags where org_id = $1 and name = 'Repeat customer'", [res.orgId])).toHaveLength(0);

    const html = renderToStaticMarkup(React.createElement(ClientBlueprintCardView, { data: card!, timeZone: "UTC" }));
    expect(html).toContain("CRM Blueprint");
    expect(html).toContain("Version 2 available");
    expect(html).toContain(`href="/admin/crm-blueprints/${bp.id}/apply?client=${res.orgId}"`);
    expect(html).toContain(`href="/admin/crm-blueprints?capture=${res.orgId}"`);
    expect(html).toContain("Capture as Blueprint");
    expect(html).toContain(`href="/admin/crm-blueprints?client=${res.orgId}"`);
    expect(html).toContain(`href="/admin/clients/${res.orgId}/crm/settings/blueprints"`);

    // Staff see the card without the super-admin actions; a client role never gets one.
    const staffUser = await createUser({ platformRole: "agency_staff" });
    await withSystem((db) => db.query("insert into staff_assignments (org_id, user_id, assigned_by) values ($1, $2, $3)", [res.orgId, staffUser.id, admin.id]));
    const staffCard = await loadClientBlueprintCard(agencyUser(staffUser, "agency_staff"), res.orgId);
    expect(staffCard).toMatchObject({ canApply: false, canPreview: true, canCapture: true });
    const staffHtml = renderToStaticMarkup(React.createElement(ClientBlueprintCardView, { data: staffCard!, timeZone: "UTC" }));
    expect(staffHtml).not.toContain("Apply a Blueprint");
    expect(staffHtml).not.toContain("Review update");
    // They can run the update's dry run for this client (the apply page shows it read-only), labelled as a preview.
    expect(staffHtml).toContain("Preview the update");
    expect(staffHtml).toContain(`href="/admin/crm-blueprints/${bp.id}/apply?client=${res.orgId}"`);
    // Staff who design Blueprints can still capture this client's configuration (the library re-checks their access to it).
    expect(staffHtml).toContain(`href="/admin/crm-blueprints?capture=${res.orgId}"`);
    const viewerCard = await loadClientBlueprintCard(agencyUser(staffUser, "agency_staff"), res.orgId);
    const noDesign = renderToStaticMarkup(React.createElement(ClientBlueprintCardView, { data: { ...viewerCard!, canCapture: false, canApply: false }, timeZone: "UTC" }));
    expect(noDesign).not.toContain("Capture as Blueprint");
    expect(noDesign).not.toContain("?capture=");

    const ghl = await createClientTenant(admin, newClient({ crmMode: "ghl" }));
    const ghlCard = await loadClientBlueprintCard(admin, ghl.orgId);
    expect(ghlCard!.mode).toBe("ghl");
    const ghlHtml = renderToStaticMarkup(React.createElement(ClientBlueprintCardView, { data: ghlCard!, timeZone: "UTC" }));
    expect(ghlHtml).toContain("Blueprints apply to iAcquire Native CRM only");
    expect(ghlHtml).not.toContain("Apply a Blueprint");
    expect(ghlHtml).not.toContain("Capture as Blueprint");
  });

  it("is in the CRM navigation for everyone who can open the CRM, in the client portal and the agency view", () => {
    const item = CRM_NAV.find((s) => s.key === "settings")!.items.find((i) => i.path === "/settings/blueprints");
    expect(item).toMatchObject({ label: "Blueprints & setup", permission: "crm.view" });
    for (const mode of ["client", "agency"] as const) {
      expect(navFor((p) => p === "crm.view", mode).flatMap((s) => s.items).some((i) => i.path === "/settings/blueprints")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Pure pieces of the dialog and the screens
// ---------------------------------------------------------------------------

describe("onboarding helpers", () => {
  it("maps industry labels to Blueprint industries and ranks Blueprints for one", () => {
    expect(INDUSTRY_OPTIONS.map((o) => o.label)).toContain("Healthcare & Wellness");
    expect(industryKeyForLabel("Real Estate")).toBe("real_estate");
    expect(industryKeyForLabel(" real estate ")).toBe("real_estate");
    expect(industryKeyForLabel("Dentistry")).toBeNull();
    expect(industryKeyForLabel("")).toBeNull();
    const items = [
      { name: "Zeta general", industry: "general_services" as const },
      { name: "Alpha salon", industry: "beauty_salons" as const, featured: true },
      { name: "Beta homes", industry: "real_estate" as const },
      { name: "Alpha homes", industry: "real_estate" as const },
    ];
    expect(rankForIndustry(items, "real_estate").map((i) => i.name)).toEqual(["Alpha homes", "Beta homes", "Zeta general", "Alpha salon"]);
    expect(rankForIndustry(items, null).map((i) => i.name)).toEqual(["Alpha salon", "Alpha homes", "Beta homes", "Zeta general"]);
  });

  it("turns a selection into the server's choice", () => {
    expect(choiceFor("blank")).toBeNull();
    expect(choiceFor("bp:3f0c9d52-0000-4000-8000-000000000001")).toEqual({ kind: "blueprint", blueprintId: "3f0c9d52-0000-4000-8000-000000000001" });
    expect(choiceFor("st:real-estate")).toEqual({ kind: "starter", starterKey: "real-estate" });
  });

  it("explains drafts only for the modules a Blueprint has, and summarizes counts plainly", () => {
    expect(draftNotes([{ section: "calendars", label: "Calendars", count: 1 }, { section: "workflows", label: "Workflows", count: 2 }]).map((n) => n.key)).toEqual(["calendars", "workflows"]);
    expect(draftNotes([{ section: "tags", label: "Tags", count: 3 }])).toEqual([]);
    expect(countsSummary({ create: 12, link: 2, skip: 0 })).toBe("12 created, 2 already matched");
    expect(countsSummary(undefined)).toBe("");
  });

  it("shows why a GoHighLevel client can't take a Blueprint, and what an outcome means", () => {
    const html = renderToStaticMarkup(React.createElement(OnboardingBlueprintPicker, {
      value: "blank", onChange: () => undefined, industry: null, loading: false, error: null, onRetry: () => undefined,
      choices: { blueprints: [], starters: [], canApply: true, canInstallStarters: true },
      disabledReason: "GoHighLevel clients keep their pipelines in GoHighLevel.",
    }));
    expect(html).toMatch(/<fieldset[^>]*disabled/);
    expect(html).toContain("GoHighLevel clients keep their pipelines in GoHighLevel.");

    const failed = renderToStaticMarkup(React.createElement(OnboardingBlueprintOutcome, {
      orgId: "org-1", crmMode: "native", chosenName: "Home Services",
      result: { status: "failed", blueprintId: "bp-1", blueprintName: null, version: null, error: "It broke.", retryPath: "/admin/crm-blueprints/bp-1/apply?client=org-1" },
    }));
    expect(failed).toContain("The client and the invitation were created");
    expect(failed).toContain('href="/admin/crm-blueprints/bp-1/apply?client=org-1"');
    const ghl = renderToStaticMarkup(React.createElement(OnboardingBlueprintOutcome, { orgId: "org-1", crmMode: "ghl", result: null }));
    expect(ghl).toContain("no Blueprint was applied");
  });

  it("links a checklist item only to screens the viewer can open", () => {
    expect(placeFor("/settings/values", { base: "/crm", can: { "crm.view": true } })).toEqual({ label: "Configuration Values", href: "/crm/settings/values" });
    expect(placeFor("/settings/assignment", { base: "/crm", can: { "crm.view": true } })).toEqual({ label: "Lead Assignment", href: null });
    expect(placeFor(null, { base: "/crm", can: {} })).toBeNull();
  });

  it("keeps one row per Blueprint, preferring a live application, and offers updates only for live ones", () => {
    const app = (over: Partial<ApplicationSummary>): ApplicationSummary => ({
      id: uid(), orgId: "o", orgName: "O", blueprintId: "b1", blueprintName: "One", version: 1, latestVersion: 2, mode: "initial", strategy: "add_missing",
      status: "applied", counts: {}, requestedBy: null, requestedVia: "agency", createdAt: "2026-10-01T00:00:00.000Z", rolledBackAt: null, canRollBack: false, ...over,
    });
    const rowsOut = blueprintRows([
      app({ id: "old", createdAt: "2026-10-01T00:00:00.000Z" }),
      app({ id: "undone", createdAt: "2026-10-05T00:00:00.000Z", status: "rolled_back", rolledBackAt: "2026-10-06T00:00:00.000Z" }),
      app({ id: "other", blueprintId: "b2", blueprintName: "Two", latestVersion: 1, createdAt: "2026-10-03T00:00:00.000Z" }),
    ]);
    expect(rowsOut.map((r) => [r.applicationId, r.updateAvailable])).toEqual([["other", false], ["old", true]]);

    // A partly undone newer application is not live: the live v1 stays the row, and v2 is offered as its update.
    const partlyUndone = blueprintRows([
      app({ id: "v1", createdAt: "2026-10-01T00:00:00.000Z" }),
      app({ id: "v2-partly-undone", version: 2, createdAt: "2026-10-05T00:00:00.000Z", status: "partially_rolled_back", rolledBackAt: "2026-10-06T00:00:00.000Z" }),
    ]);
    expect(partlyUndone.map((r) => [r.applicationId, r.version, r.status, r.updateAvailable])).toEqual([["v1", 1, "applied", true]]);

    // When the only application is partly undone it is still shown, but no update is offered for it.
    const onlyPartly = blueprintRows([app({ id: "v1-partly", status: "partially_rolled_back", rolledBackAt: "2026-10-06T00:00:00.000Z" })]);
    expect(onlyPartly.map((r) => [r.applicationId, r.status, r.updateAvailable])).toEqual([["v1-partly", "partially_rolled_back", false]]);
  });
});
