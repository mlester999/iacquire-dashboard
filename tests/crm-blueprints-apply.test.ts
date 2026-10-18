// Applying CRM Blueprints to client workspaces: the dry run, authorization and tenant isolation, what is created (independent drafts),
// reference conversion into each workspace's own records, re-applying, idempotency, the preview digest, conflicts with the client's own
// configuration (per strategy and per decision), updates to newer versions (customizations kept, selective by section), version
// isolation, GoHighLevel and hybrid workspaces, per-item and whole-transaction failures, rollback rules, and the setup checklist.
// Synthetic workspaces only: nothing here contacts a provider, publishes anything or sends a message.
import { beforeAll, describe, expect, it, vi } from "vitest";

const flags = vi.hoisted(() => ({ failTag: null as string | null, failNotify: false }));
vi.mock("@/server/notifications", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/notifications")>();
  return {
    ...actual,
    notifyOrgRoles: async (...args: Parameters<typeof actual.notifyOrgRoles>) => {
      if (flags.failNotify) throw new Error("simulated failure after the writes");
      return actual.notifyOrgRoles(...args);
    },
  };
});
vi.mock("@/server/crm/blueprints/native-io", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/crm/blueprints/native-io")>();
  return {
    ...actual,
    createRecord: async (...args: Parameters<typeof actual.createRecord>) => {
      const [, type, record] = args;
      if (flags.failTag && type === "tag" && (record as { name: string }).name === flags.failTag) throw Object.assign(new Error("simulated constraint"), { code: "23514" });
      return actual.createRecord(...args);
    },
  };
});

import { withSystem, withUser } from "@/server/db";
import { AppError } from "@/server/errors";
import { applyBlueprint, getApplication, planApplication, previewApplication, rollbackApplication } from "@/server/crm/blueprints/apply";
import { getBlueprintChecklist, getBlueprintChecklistForOrg } from "@/server/crm/blueprints/checklist";
import { createTag, updateTag } from "@/server/crm/tags";
import { createCustomField, setCustomFieldArchived } from "@/server/crm/fields";
import { updatePipeline, updateStage } from "@/server/crm/pipelines";
import { updateTemplate } from "@/server/crm/message-templates";
import { createContact } from "@/server/crm/contacts";
import { createOpportunity } from "@/server/crm/opportunities";
import { updateCalendar } from "@/server/calendars/setup";
import { updateCustomValue } from "@/server/crm/custom-values";
import type { ApplicationPlan, ApplyOptions, BlueprintContent } from "@/lib/crm/blueprints/types";
import type { ApplyResult } from "@/lib/crm/blueprints/views";
import { agencyUser, createOrg, createUser } from "./support/fixtures";
import { agencyPeople, crmOrg, type CrmOrg } from "./support/crm";
import { clone, confirmation, insertPublishedBlueprint, publishVersion, sampleContent, smallContent, type PublishedBlueprint } from "./support/blueprints";

type Agency = Awaited<ReturnType<typeof agencyPeople>>;
let agency: Agency;
beforeAll(async () => {
  agency = await agencyPeople();
});

const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T>(sql, params))).rows;
const items = (plan: ApplicationPlan) => Object.fromEntries(plan.items.map((i) => [i.assetId, i]));
const actions = (plan: ApplicationPlan) => Object.fromEntries(plan.items.map((i) => [i.assetId, i.action]));
const people = (c: CrmOrg) => ({ "member.closer": c.people.sales.id, "member.dispatcher": c.people.setter.id });

async function run(orgId: string, bp: PublishedBlueprint, options: ApplyOptions, version = bp.version, user = agency.superAdmin): Promise<{ plan: ApplicationPlan; result: ApplyResult }> {
  const preview = await previewApplication(user, orgId, { blueprintId: bp.blueprintId, version, options });
  const result = await applyBlueprint(user, orgId, { blueprintId: bp.blueprintId, version, options, planDigest: preview.plan.digest, idempotencyKey: confirmation() });
  return { plan: preview.plan, result };
}

const linkOf = async (orgId: string, bp: PublishedBlueprint, assetId: string) =>
  (await q<{ native_id: string }>("select native_id from crm_blueprint_links where org_id = $1 and blueprint_id = $2 and asset_id = $3", [orgId, bp.blueprintId, assetId]))[0]?.native_id ?? null;

/** How many configuration records of each kind the workspace has (archived ones included). */
async function configCounts(orgId: string) {
  const one = async (table: string, extra = "") => Number((await q<{ n: string }>(`select count(*)::text as n from ${table} where org_id = $1 ${extra}`, [orgId]))[0].n);
  return {
    folders: await one("crm_folders"), tags: await one("crm_tags"), fields: await one("crm_custom_fields"), values: await one("crm_custom_values"),
    pipelines: await one("crm_pipelines", "and provider = 'native'"), stages: await one("crm_pipeline_stages"), calendars: await one("crm_calendars"),
    types: await one("crm_appointment_types"), lists: await one("crm_smart_lists"), rules: await one("crm_assignment_rules"), forms: await one("crm_forms"),
    templates: await one("crm_message_templates"), versions: await one("crm_message_template_versions"), workflows: await one("crm_workflows"), reports: await one("crm_report_definitions"),
  };
}

/** Every saved definition of a workspace as text (drafts, filters, configs): where references to other records live. */
async function definitionsText(orgId: string): Promise<string> {
  const parts = await Promise.all([
    q("select draft from crm_forms where org_id = $1", [orgId]), q("select draft from crm_workflows where org_id = $1", [orgId]),
    q("select filter, columns from crm_smart_lists where org_id = $1", [orgId]), q("select conditions from crm_assignment_rules where org_id = $1", [orgId]),
    q("select config from crm_report_definitions where org_id = $1", [orgId]), q("select hours_template from crm_calendars where org_id = $1", [orgId]),
  ]);
  return JSON.stringify(parts);
}

const ownUuids = async (orgId: string) => new Set((await q<{ id: string }>(
  `select id from crm_tags where org_id = $1 union all select id from crm_custom_fields where org_id = $1 union all select id from crm_pipelines where org_id = $1
   union all select id from crm_pipeline_stages where org_id = $1 union all select id from crm_calendars where org_id = $1 union all select id from crm_appointment_types where org_id = $1
   union all select id from crm_assignment_rules where org_id = $1 union all select id from crm_forms where org_id = $1 union all select id from crm_message_templates where org_id = $1
   union all select id from crm_folders where org_id = $1 union all select id from crm_smart_lists where org_id = $1 union all select id from crm_report_definitions where org_id = $1
   union all select id from crm_workflows where org_id = $1 union all select id from crm_custom_values where org_id = $1 union all select user_id from organization_memberships where org_id = $1`,
  [orgId],
)).map((r) => r.id));

const UUIDS = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const LOGICAL_REF = /"@(folder|tag|field|value|pipeline|stage|calendar|apptype|list|rule|form|template|workflow|report|member|n8n|webhook)\./;

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

describe("dry run", () => {
  it("lists every change with a reason and a stable digest, and writes nothing", async () => {
    const c = await crmOrg();
    const bp = await insertPublishedBlueprint(sampleContent());
    const before = await configCounts(c.org.id);
    const options: ApplyOptions = { strategy: "add_missing", slotMappings: people(c) };
    const a = await previewApplication(agency.superAdmin, c.org.id, { blueprintId: bp.blueprintId, options });
    const b = await planApplication(agency.superAdmin, c.org.id, { blueprintId: bp.blueprintId, version: 1, options });
    expect(await configCounts(c.org.id)).toEqual(before);
    expect(await q("select 1 from crm_blueprint_applications where org_id = $1", [c.org.id])).toEqual([]);
    expect(a.plan.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(b.digest).toBe(a.plan.digest);
    expect(a.plan.mode).toBe("initial");
    expect(a.plan.items.length).toBe(49);
    expect(a.plan.items.every((i) => i.action === "create" && i.reason.length > 10)).toBe(true);
    // Dependency order: a stage comes after its pipeline, a workflow after the template it sends.
    const order = a.plan.items.map((i) => i.assetId);
    expect(order.indexOf("stage.sales.won")).toBeGreaterThan(order.indexOf("pipeline.sales"));
    expect(order.indexOf("workflow.new-lead")).toBeGreaterThan(order.indexOf("template.welcome-email"));
    expect(a.plan.requirements).toEqual(expect.arrayContaining(["calendar_hosts", "calendar_verification", "google_calendar", "meeting_link", "template_approval", "whatsapp_template_approval", "custom_values", "workflow_activation", "form_rebuild"]));
    // Roles to map: this workspace's own people (names only), and which assets use each role.
    const closer = a.slots.find((s) => s.slotId === "member.closer")!;
    expect(closer.mappedTo).toBe(c.people.sales.id);
    expect(closer.candidates.map((x) => x.id)).toContain(c.people.owner.id);
    expect(closer.candidates.every((x) => Object.keys(x).sort().join() === "id,name")).toBe(true);
    expect(closer.usedBy.map((u) => u.assetId)).toEqual(expect.arrayContaining(["calendar.estimates", "list.hot-leads", "workflow.new-lead"]));
    expect(a.workspace).toEqual({ mode: "native", switching: false, blockedSections: [] });
    // A different choice is a different plan.
    const other = await planApplication(agency.superAdmin, c.org.id, { blueprintId: bp.blueprintId, options: { strategy: "update_compatible", slotMappings: people(c) } });
    expect(other.digest).not.toBe(a.plan.digest);
  });

  it("blocks what needs a role nobody mapped, and leaves people out of drafts", async () => {
    const c = await crmOrg();
    const bp = await insertPublishedBlueprint(sampleContent());
    const plan = await planApplication(agency.superAdmin, c.org.id, { blueprintId: bp.blueprintId, options: { strategy: "add_missing" } });
    const by = items(plan);
    // A Smart List, rule condition or report filter on a role can't be kept without the person.
    expect(by["list.hot-leads"].action).toBe("blocked");
    expect(by["list.hot-leads"].reason).toMatch(/Closer/);
    expect(by["list.hot-leads"].unresolved).toContain("member.closer");
    expect(by["report.weekly-sales"].action).toBe("blocked");
    // Drafts and switched-off rules don't need the people yet; the roles are listed as unresolved.
    expect(by["workflow.new-lead"].action).toBe("create");
    expect(by["workflow.new-lead"].unresolved).toEqual(expect.arrayContaining(["member.closer", "member.dispatcher", "n8n.lead-sync", "webhook.crm-export"]));
    expect(by["rule.new-leads"].action).toBe("create");
    expect(by["calendar.estimates"].action).toBe("create");
    expect(plan.warnings.join(" ")).toMatch(/aren't mapped/);
  });

  it("refuses a person from another workspace as a role, and unknown choices", async () => {
    const c = await crmOrg();
    const other = await crmOrg();
    const bp = await insertPublishedBlueprint(smallContent());
    await expect(planApplication(agency.superAdmin, c.org.id, { blueprintId: bp.blueprintId, options: { strategy: "add_missing", slotMappings: { "member.closer": other.people.owner.id } } })).rejects.toMatchObject({ code: "invalid_input" });
    const full = await insertPublishedBlueprint(sampleContent());
    await expect(planApplication(agency.superAdmin, c.org.id, { blueprintId: full.blueprintId, options: { strategy: "add_missing", slotMappings: { "member.closer": other.people.owner.id } } })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(planApplication(agency.superAdmin, c.org.id, { blueprintId: bp.blueprintId, options: { strategy: "replace_all" as never } })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(planApplication(agency.superAdmin, c.org.id, { blueprintId: bp.blueprintId, options: { strategy: "add_missing", decisions: { "tag.nope": "copy" } } })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(planApplication(agency.superAdmin, c.org.id, { blueprintId: bp.blueprintId, options: { strategy: "add_missing", assetIds: ["tag.nope"] } })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("only applies published, unarchived versions that pass their integrity check", async () => {
    const c = await crmOrg();
    const draft = await insertPublishedBlueprint(smallContent(), { status: "draft" });
    await expect(planApplication(agency.superAdmin, c.org.id, { blueprintId: draft.blueprintId, options: { strategy: "add_missing" } })).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/no published version/) });
    const bp = await insertPublishedBlueprint(smallContent());
    await expect(planApplication(agency.superAdmin, c.org.id, { blueprintId: bp.blueprintId, version: 7, options: { strategy: "add_missing" } })).rejects.toMatchObject({ code: "not_found" });
    // A stored package edited behind the library's back fails the digest check (the version table refuses updates, so this goes around it).
    const tampered = await insertPublishedBlueprint(smallContent());
    await withSystem(async (db) => {
      await db.query("alter table crm_blueprint_versions disable trigger crm_blueprint_versions_frozen");
      await db.query("update crm_blueprint_versions set package = jsonb_set(package, '{assets,tags,0,name}', '\"Edited\"') where id = $1", [tampered.versionId]);
      await db.query("alter table crm_blueprint_versions enable trigger crm_blueprint_versions_frozen");
    });
    await expect(planApplication(agency.superAdmin, c.org.id, { blueprintId: tampered.blueprintId, options: { strategy: "add_missing" } })).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/integrity/) });
    await q("update crm_blueprints set status = 'archived', archived_at = now() where id = $1", [bp.blueprintId]);
    await expect(planApplication(agency.superAdmin, c.org.id, { blueprintId: bp.blueprintId, options: { strategy: "add_missing" } })).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/archived/) });
  });
});

// ---------------------------------------------------------------------------
// Authorization and isolation
// ---------------------------------------------------------------------------

describe("authorization and tenant isolation", () => {
  it("previews only for reachable clients and applies only as a super admin", async () => {
    const c = await crmOrg();
    const bp = await insertPublishedBlueprint(smallContent());
    const options: ApplyOptions = { strategy: "add_missing" };
    const input = { blueprintId: bp.blueprintId, options };
    // Staff not assigned to the client: the client isn't even revealed.
    await expect(previewApplication(agency.staff, c.org.id, input)).rejects.toMatchObject({ code: "not_found" });
    await q("insert into staff_assignments (org_id, user_id) values ($1, $2)", [c.org.id, agency.staff.id]);
    const plan = (await previewApplication(agency.staff, c.org.id, input)).plan;
    // Staff may preview but never apply or roll back.
    await expect(applyBlueprint(agency.staff, c.org.id, { ...input, version: 1, planDigest: plan.digest, idempotencyKey: confirmation() })).rejects.toMatchObject({ code: "forbidden" });
    // Someone with no agency role at all.
    const outsider = agencyUser(await createUser(), "agency_staff");
    outsider.platformRole = "none";
    await expect(previewApplication(outsider, c.org.id, input)).rejects.toMatchObject({ code: "forbidden" });
    await expect(applyBlueprint(outsider, c.org.id, { ...input, version: 1, planDigest: plan.digest, idempotencyKey: confirmation() })).rejects.toMatchObject({ code: "forbidden" });
    // A role changed since sign-in is refused inside the write.
    await expect(applyBlueprint({ ...agency.staff, platformRole: "agency_super_admin" }, c.org.id, { ...input, version: 1, planDigest: plan.digest, idempotencyKey: confirmation() })).rejects.toMatchObject({ code: "forbidden" });
    expect(await configCounts(c.org.id)).toMatchObject({ tags: 0, workflows: 0 });
    const { result } = await run(c.org.id, bp, options);
    expect(result.application.status).toBe("applied");
    await expect(rollbackApplication(agency.staff, c.org.id, result.application.id)).rejects.toMatchObject({ code: "forbidden" });
    // An archived client's CRM can't be changed; the agency organization is never a target.
    const archived = await createOrg({ name: "Archived Co", status: "archived" });
    await expect(run(archived.id, bp, options)).rejects.toMatchObject({ code: "conflict" });
    const agencyOrg = (await q<{ id: string }>("select id from organizations where kind = 'agency' limit 1"))[0];
    if (agencyOrg) await expect(planApplication(agency.superAdmin, agencyOrg.id, input)).rejects.toMatchObject({ code: "not_found" });
    await expect(planApplication(agency.superAdmin, "not-a-uuid", input)).rejects.toMatchObject({ code: "not_found" });
  });

  it("writes only into the target workspace, which only that client can read", async () => {
    const a = await crmOrg({ name: "Client A" });
    const b = await crmOrg({ name: "Client B" });
    const bp = await insertPublishedBlueprint(sampleContent());
    await run(a.org.id, bp, { strategy: "add_missing", slotMappings: people(a) });
    expect(await configCounts(b.org.id)).toEqual({ folders: 0, tags: 0, fields: 0, values: 0, pipelines: 0, stages: 0, calendars: 0, types: 0, lists: 0, rules: 0, forms: 0, templates: 0, versions: 0, workflows: 0, reports: 0 });
    // Every link and application item belongs to A and points at A's own records.
    const links = await q<{ org_id: string; native_id: string }>("select org_id, native_id from crm_blueprint_links where blueprint_id = $1", [bp.blueprintId]);
    expect(links.length).toBe(49);
    const mine = await ownUuids(a.org.id);
    expect(links.every((l) => l.org_id === a.org.id && mine.has(l.native_id))).toBe(true);
    // Row-level security: B's people can't see A's application, links or the records it created.
    const seenByB = await withUser(b.people.owner.id, (db) => db.query("select id from crm_blueprint_applications"));
    expect(seenByB.rows).toEqual([]);
    expect((await withUser(b.people.owner.id, (db) => db.query("select 1 from crm_blueprint_links"))).rows).toEqual([]);
    expect((await withUser(b.people.owner.id, (db) => db.query("select 1 from crm_tags where org_id = $1", [a.org.id]))).rows).toEqual([]);
    expect((await withUser(a.people.owner.id, (db) => db.query("select id from crm_blueprint_applications"))).rows.length).toBe(1);
    // The same Blueprint in B makes B's own independent copies: nothing in A refers to anything of B's.
    await run(b.org.id, bp, { strategy: "add_missing", slotMappings: people(b) });
    const bIds = await ownUuids(b.org.id);
    const aText = await definitionsText(a.org.id);
    expect([...aText.matchAll(UUIDS)].map((m) => m[0]).filter((id) => bIds.has(id))).toEqual([]);
    const aTags = await q<{ id: string }>("select id from crm_tags where org_id = $1", [a.org.id]);
    const bTags = await q<{ id: string }>("select id from crm_tags where org_id = $1", [b.org.id]);
    expect(aTags.some((t) => bTags.some((x) => x.id === t.id))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// What applying creates
// ---------------------------------------------------------------------------

describe("what applying creates", () => {
  let c: CrmOrg;
  let bp: PublishedBlueprint;
  let result: ApplyResult;
  beforeAll(async () => {
    c = await crmOrg({ name: "Fresh Client" });
    bp = await insertPublishedBlueprint(sampleContent());
    result = (await run(c.org.id, bp, { strategy: "add_missing", slotMappings: people(c) })).result;
  });

  it("records the application, links every asset, marks the workspace and tells the client", async () => {
    expect(result.replayed).toBe(false);
    expect(result.application).toMatchObject({ orgId: c.org.id, blueprintId: bp.blueprintId, version: 1, status: "applied", mode: "initial", strategy: "add_missing", requestedVia: "agency", canRollBack: true });
    expect(result.application.counts.create).toBe(49);
    const app = (await q<{ status: string; plan_digest: string; requirements: string[]; summary: { slotMappings: Record<string, string> } }>("select status, plan_digest, requirements, summary from crm_blueprint_applications where id = $1", [result.application.id]))[0];
    expect(app.summary.slotMappings).toEqual(people(c));
    expect(app.requirements).toContain("calendar_verification");
    const itemRows = await q<{ outcome: string; after_hash: string | null }>("select outcome, after_hash from crm_blueprint_application_items where application_id = $1", [result.application.id]);
    expect(itemRows.length).toBe(49);
    expect(itemRows.every((r) => r.outcome === "applied" && /^[0-9a-f]{64}$/.test(r.after_hash ?? ""))).toBe(true);
    const ws = (await q<{ blueprint_key: string; initialized_at: Date | null; default_currency: string }>("select blueprint_key, initialized_at, default_currency from crm_workspaces where org_id = $1", [c.org.id]))[0];
    expect(ws.blueprint_key).toBe(`${bp.key}@1`);
    expect(ws.initialized_at).not.toBeNull();
    expect(ws.default_currency).toBe("USD");
    const notes = await q<{ user_id: string; link: string }>("select user_id, link from notifications where org_id = $1 and kind = 'crm_blueprint_applied'", [c.org.id]);
    expect(notes.map((n) => n.user_id).sort()).toEqual([c.people.owner.id, c.people.manager.id].sort());
    expect(notes[0].link).toBe("/crm/settings/blueprints");
    const audit = await q<{ actor_kind: string; actor_user_id: string; metadata: Record<string, unknown> }>("select actor_kind, actor_user_id, metadata from audit_logs where org_id = $1 and action = 'crm.blueprint_applied'", [c.org.id]);
    expect(audit).toEqual([expect.objectContaining({ actor_kind: "agency", actor_user_id: agency.superAdmin.id })]);
    expect(JSON.stringify(audit[0].metadata)).not.toMatch(/@|[0-9a-f]{64}/);
    const detail = await getApplication(agency.superAdmin, c.org.id, result.application.id);
    expect(detail.items.length).toBe(49);
    expect(detail.items.find((i) => i.assetId === "calendar.estimates")?.message).toMatch(/draft/);
  });

  it("creates calendars as drafts that take no bookings, with no hosts", async () => {
    const cals = await q<{ name: string; status: string; public: boolean; is_default: boolean; origin: string; timezone: string | null; hours_template: unknown; members: number }>(
      "select name, status, public, is_default, origin, timezone, hours_template, (select count(*)::int from crm_calendar_members m where m.calendar_id = c.id) as members from crm_calendars c where org_id = $1 order by name",
      [c.org.id],
    );
    expect(cals).toEqual([
      expect.objectContaining({ name: "Consults", status: "draft", public: false, is_default: false, origin: "blueprint", timezone: null, members: 0 }),
      expect.objectContaining({ name: "Estimates", status: "draft", public: false, is_default: false, origin: "blueprint", timezone: "America/New_York", members: 0, hours_template: [{ weekday: 1, startMinute: 540, endMinute: 1020 }, { weekday: 3, startMinute: 540, endMinute: 1020 }] }),
    ]);
    const types = await q<{ name: string; meeting_provider: string; meeting_link: string | null; questions: unknown[] }>("select name, meeting_provider, meeting_link, questions from crm_appointment_types where org_id = $1 order by name", [c.org.id]);
    expect(types.map((t) => [t.name, t.meeting_provider])).toEqual([["On-site estimate", "none"], ["Online consult", "none"], ["Video call", "google_meet"]]);
    expect(types.find((t) => t.name === "On-site estimate")!.questions).toHaveLength(2);
  });

  it("creates workflows, templates and forms as drafts, and assignment rules off until their people are mapped", async () => {
    const flows = await q<{ status: string; published_version_id: string | null }>("select status, published_version_id from crm_workflows where org_id = $1", [c.org.id]);
    expect(flows.length).toBe(7);
    expect(flows.every((f) => f.status === "draft" && !f.published_version_id)).toBe(true);
    expect(await q("select 1 from crm_workflow_versions where org_id = $1", [c.org.id])).toEqual([]);
    const templates = await q<{ key: string; kind: string; status: string; whatsapp_template_id: string | null; current_version: number; body: string }>(
      "select t.key, t.kind, t.status, t.whatsapp_template_id, t.current_version, v.body from crm_message_templates t join crm_message_template_versions v on v.template_id = t.id and v.version = t.current_version where t.org_id = $1 order by key",
      [c.org.id],
    );
    expect(templates.every((t) => t.status === "draft" && t.current_version === 1 && !t.whatsapp_template_id)).toBe(true);
    expect(templates.find((t) => t.key === "old_promo")!.body).toBe("");
    expect(templates.find((t) => t.key === "thanks")!.kind).toBe("canned_reply");
    const forms = await q<{ key: string; status: string; questions: number }>("select key, status, jsonb_array_length(draft->'questions') as questions from crm_forms where org_id = $1 order by key", [c.org.id]);
    expect(forms).toEqual([{ key: "estimate-request", status: "draft", questions: 5 }, { key: "legacy-survey", status: "draft", questions: 0 }]);
    expect(await q("select 1 from crm_form_versions where org_id = $1", [c.org.id])).toEqual([]);
    const rules = await q<{ name: string; active: boolean; fallback: string; fallback_user_id: string | null; members: string[] }>(
      "select name, active, fallback, fallback_user_id, array(select user_id::text from crm_assignment_members m where m.rule_id = r.id) as members from crm_assignment_rules r where org_id = $1 order by name",
      [c.org.id],
    );
    expect(rules).toEqual([
      { name: "Deals", active: false, fallback: "unassigned", fallback_user_id: null, members: [] },
      { name: "New leads", active: true, fallback: "fallback_user", fallback_user_id: c.people.setter.id, members: [c.people.sales.id] },
    ]);
    const lists = await q<{ name: string; visibility: string; owner_user_id: string; is_default: boolean }>("select name, visibility, owner_user_id, is_default from crm_smart_lists where org_id = $1 order by name", [c.org.id]);
    expect(lists).toEqual([
      { name: "Big companies", visibility: "team", owner_user_id: c.people.owner.id, is_default: false },
      { name: "Hot leads", visibility: "team", owner_user_id: c.people.owner.id, is_default: true },
    ]);
    const reports = await q<{ key: string; visibility: string; owner_user_id: string | null; report: string }>("select key, visibility, owner_user_id, report from crm_report_definitions where org_id = $1 order by key", [c.org.id]);
    expect(reports).toEqual([{ key: "leads", visibility: "team", owner_user_id: c.people.owner.id, report: "leads" }, { key: "weekly-sales", visibility: "team", owner_user_id: c.people.owner.id, report: "overview" }]);
    const values = await q<{ key: string; value: string; required: boolean }>("select key, value, required from crm_custom_values where org_id = $1 order by key", [c.org.id]);
    expect(values).toEqual([{ key: "booking_link", value: "", required: true }, { key: "office_hours", value: "Mon to Fri, 9am to 5pm", required: false }]);
    const pipes = await q<{ name: string; is_default: boolean; stages: string[] }>(
      "select p.name, p.is_default, array(select s.name from crm_pipeline_stages s where s.pipeline_id = p.id order by s.position) as stages from crm_pipelines p where p.org_id = $1 order by p.name",
      [c.org.id],
    );
    expect(pipes).toEqual([{ name: "Sales", is_default: true, stages: ["New", "Quoted", "Won", "Lost"] }, { name: "Service", is_default: false, stages: ["Scheduled"] }]);
  });

  it("converts every reference into this workspace's own records", async () => {
    const id = async (table: string, where: string, value: string) => (await q<{ id: string }>(`select id from ${table} where org_id = $1 and ${where} = $2`, [c.org.id, value]))[0].id;
    const sales = await id("crm_pipelines", "name", "Sales");
    const stage = async (name: string) => (await q<{ id: string }>("select id from crm_pipeline_stages where org_id = $1 and pipeline_id = $2 and name = $3", [c.org.id, sales, name]))[0].id;
    const hot = await id("crm_tags", "name::text", "Hot lead");
    const vip = await id("crm_tags", "name::text", "VIP");
    const quote = await id("crm_tags", "name::text", "Quote sent");
    const budget = await id("crm_custom_fields", "key", "budget");
    const service = await id("crm_custom_fields", "key", "service");
    const rule = await id("crm_assignment_rules", "name", "New leads");
    const form = (await q<{ id: string; draft: { questions: Array<{ map?: string }>; actions: { tagIds: string[]; opportunity: { pipelineId: string; stageId: string }; assignmentRuleId: string } } }>("select id, draft from crm_forms where org_id = $1 and key = 'estimate-request'", [c.org.id]))[0];
    expect(form.draft.actions.tagIds).toEqual([hot]);
    expect(form.draft.actions.opportunity).toMatchObject({ pipelineId: sales, stageId: await stage("New") });
    expect(form.draft.actions.assignmentRuleId).toBe(rule);
    expect(form.draft.questions.map((x) => x.map ?? null)).toEqual(["contact.first_name", "contact.email", "custom:budget", "custom:service", null]);

    const flows = Object.fromEntries((await q<{ key: string; draft: { trigger: Record<string, unknown> & { filters?: Record<string, unknown>; inbound?: { nonce?: string } }; steps: Array<{ key: string; config: Record<string, unknown> }> } }>("select key, draft from crm_workflows where org_id = $1", [c.org.id])).map((w) => [w.key, w.draft]));
    const steps = Object.fromEntries(flows.new_lead.steps.map((s) => [s.key, s.config]));
    expect(flows.new_lead.trigger.filters).toEqual({ tagIds: [hot] });
    expect(JSON.stringify(flows.new_lead.trigger.contactFilter)).toContain(`cf:${budget}`);
    const welcome = (await q<{ id: string; content_hash: string }>("select t.id, v.content_hash from crm_message_templates t join crm_message_template_versions v on v.template_id = t.id and v.version = t.current_version where t.org_id = $1 and t.key = 'welcome_email'", [c.org.id]))[0];
    // Send steps are bound to this workspace's own template wording (the approval will be checked against the same hash).
    expect(steps.welcome).toMatchObject({ templateId: welcome.id, contentHash: welcome.content_hash });
    expect(steps.deal).toMatchObject({ pipelineId: sales, stageId: await stage("New") });
    expect(steps.move).toMatchObject({ pipelineId: sales, stageId: await stage("Quoted") });
    expect(steps.tag.tagIds).toEqual([vip]);
    expect(steps.field.field).toBe(`cf:${service}`);
    expect(steps.assign.ruleId).toBe(rule);
    expect(steps.notify.userIds).toEqual([c.people.setter.id]);
    expect(steps.task.userId).toBe(c.people.sales.id);
    // Connections nobody mapped are left out of the draft rather than guessed.
    expect("mappingId" in steps.sync).toBe(false);
    expect("subscriptionId" in steps.hook).toBe(false);
    expect((steps.check.filter as { conditions: Array<{ value: unknown }> }).conditions[0].value).toEqual([quote]);
    expect(flows.stage_moves.trigger.filters).toEqual({ pipelineId: sales, stageIds: [await stage("Won")], fromStageIds: [await stage("Quoted")] });
    const estimates = await id("crm_calendars", "name", "Estimates");
    const onsite = (await q<{ id: string }>("select id from crm_appointment_types where org_id = $1 and calendar_id = $2 and name = 'On-site estimate'", [c.org.id, estimates]))[0].id;
    expect(flows.booked.trigger.filters).toEqual({ calendarIds: [estimates], appointmentTypeIds: [onsite] });
    expect(flows.form_intake.trigger.filters).toEqual({ formIds: [form.id] });
    expect(flows.changed.trigger.filters).toEqual({ changedFields: ["cf:budget", "email"] });
    expect(flows.inbound.trigger.inbound?.nonce).toMatch(/^[A-Za-z0-9_-]{16,}$/);

    const list = (await q<{ filter: { conditions: Array<{ field: string; value?: unknown; conditions?: Array<{ value: unknown }> }> }; columns: string[] }>("select filter, columns from crm_smart_lists where org_id = $1 and name = 'Hot leads'", [c.org.id]))[0];
    expect(list.filter.conditions[0].value).toEqual([hot, vip]);
    expect(list.filter.conditions[1].field).toBe(`cf:${budget}`);
    expect(list.filter.conditions[2].conditions!.map((x) => x.value)).toEqual([[c.people.sales.id], [await stage("Quoted")], sales]);
    expect(list.columns).toEqual(["phone", `cf:${budget}`, "tags"]);
    const report = (await q<{ config: { filters: Record<string, unknown> } }>("select config from crm_report_definitions where org_id = $1 and key = 'weekly-sales'", [c.org.id]))[0];
    expect(report.config.filters).toMatchObject({ member: c.people.sales.id, pipeline: sales, range: "7d" });
    const tag = (await q<{ folder_id: string | null }>("select folder_id from crm_tags where id = $1", [hot]))[0];
    expect(tag.folder_id).toBe(await id("crm_folders", "name", "Lead status"));
    // No logical reference is left anywhere in what was written, and every ID is this workspace's own.
    const text = await definitionsText(c.org.id);
    expect(LOGICAL_REF.test(text)).toBe(false);
    const own = await ownUuids(c.org.id);
    for (const m of text.matchAll(UUIDS)) expect(own.has(m[0]), m[0]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Applying again
// ---------------------------------------------------------------------------

describe("applying again", () => {
  it("re-applying the same version changes nothing and duplicates nothing", async () => {
    const c = await crmOrg();
    const bp = await insertPublishedBlueprint(sampleContent());
    const options: ApplyOptions = { strategy: "update_compatible", slotMappings: people(c) };
    await run(c.org.id, bp, options);
    const after = await configCounts(c.org.id);
    const again = await run(c.org.id, bp, options);
    expect(again.plan.mode).toBe("update");
    expect(new Set(again.plan.items.map((i) => i.action))).toEqual(new Set(["unchanged"]));
    expect(again.result.application.status).toBe("applied");
    expect(await configCounts(c.org.id)).toEqual(after);
    expect((await q<{ n: string }>("select count(*)::text as n from crm_blueprint_links where org_id = $1", [c.org.id]))[0].n).toBe("49");
  });

  it("the same confirmation submitted twice returns the first application", async () => {
    const c = await crmOrg();
    const bp = await insertPublishedBlueprint(smallContent());
    const options: ApplyOptions = { strategy: "add_missing" };
    const preview = await previewApplication(agency.superAdmin, c.org.id, { blueprintId: bp.blueprintId, options });
    const key = confirmation();
    const input = { blueprintId: bp.blueprintId, version: 1, options, planDigest: preview.plan.digest, idempotencyKey: key };
    const first = await applyBlueprint(agency.superAdmin, c.org.id, input);
    const counts = await configCounts(c.org.id);
    // Even after the workspace changed (the old digest no longer matches), the same confirmation just returns what it did.
    await createTag(c.actor("owner"), { name: "Another tag" });
    const second = await applyBlueprint(agency.superAdmin, c.org.id, input);
    expect(second.replayed).toBe(true);
    expect(second.application.id).toBe(first.application.id);
    expect(await configCounts(c.org.id)).toEqual({ ...counts, tags: counts.tags + 1 });
    expect((await q("select id from crm_blueprint_applications where org_id = $1", [c.org.id])).length).toBe(1);
    const other = await insertPublishedBlueprint(smallContent("other-small"));
    await expect(applyBlueprint(agency.superAdmin, c.org.id, { ...input, blueprintId: other.blueprintId })).rejects.toMatchObject({ code: "conflict" });
    await expect(applyBlueprint(agency.superAdmin, c.org.id, { ...input, idempotencyKey: "short" })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("refuses a confirmation when the workspace changed since the preview, writing nothing", async () => {
    const c = await crmOrg();
    const bp = await insertPublishedBlueprint(smallContent());
    const options: ApplyOptions = { strategy: "add_missing" };
    const preview = await previewApplication(agency.superAdmin, c.org.id, { blueprintId: bp.blueprintId, options });
    expect(items(preview.plan)["tag.vip"].action).toBe("create");
    await createTag(c.actor("owner"), { name: "vip", color: "#000000" });
    await expect(applyBlueprint(agency.superAdmin, c.org.id, { blueprintId: bp.blueprintId, version: 1, options, planDigest: preview.plan.digest, idempotencyKey: confirmation() }))
      .rejects.toMatchObject({ code: "conflict", message: "The workspace changed since the preview. Preview again." });
    expect(await q("select 1 from crm_blueprint_applications where org_id = $1", [c.org.id])).toEqual([]);
    expect((await configCounts(c.org.id)).tags).toBe(1);
    const fresh = await previewApplication(agency.superAdmin, c.org.id, { blueprintId: bp.blueprintId, options });
    expect(items(fresh.plan)["tag.vip"]).toMatchObject({ action: "skip", existing: { name: "vip" } });
  });
});

// ---------------------------------------------------------------------------
// The client's own configuration
// ---------------------------------------------------------------------------

describe("conflicts with the client's own configuration", () => {
  async function workspaceWithOwnRecords() {
    const c = await crmOrg();
    const owner = c.actor("owner");
    const vip = await createTag(owner, { name: "VIP", color: "#000000", description: "Our best customers" });
    const hot = await createTag(owner, { name: "Hot lead", color: "#dc2626" });
    const service = await createCustomField(owner, { entity: "contact", label: "Service", key: "service", type: "select", options: [{ value: "repair", label: "Repair" }] });
    return { c, vip, hot, service };
  }

  it("add missing keeps the client's records, adopts identical ones, and creates the rest", async () => {
    const { c, vip, hot, service } = await workspaceWithOwnRecords();
    const bp = await insertPublishedBlueprint(smallContent());
    const { plan, result } = await run(c.org.id, bp, { strategy: "add_missing" });
    expect(actions(plan)).toMatchObject({ "tag.vip": "skip", "tag.hot-lead": "link", "field.contact.service": "skip", "pipeline.sales": "create", "workflow.welcome": "create" });
    expect(items(plan)["tag.vip"].changes).toEqual(expect.arrayContaining(["color", "description"]));
    expect(result.application.status).toBe("applied");
    expect((await q<{ color: string; description: string }>("select color, description from crm_tags where id = $1", [vip.id]))[0]).toEqual({ color: "#000000", description: "Our best customers" });
    expect(await linkOf(c.org.id, bp, "tag.hot-lead")).toBe(hot.id);
    // A skipped record is never linked, so a later update can't mistake it for the Blueprint's own.
    expect(await linkOf(c.org.id, bp, "tag.vip")).toBeNull();
    expect((await q<{ options: unknown[] }>("select options from crm_custom_fields where id = $1", [service.id]))[0].options).toHaveLength(1);
    // References still resolve to the client's records by identity.
    const wf = (await q<{ draft: { steps: Array<{ key: string; config: Record<string, unknown> }> } }>("select draft from crm_workflows where org_id = $1 and key = 'welcome'", [c.org.id]))[0];
    expect(wf.draft.steps.find((s) => s.key === "tag")!.config.tagIds).toEqual([vip.id]);
    expect(wf.draft.steps.find((s) => s.key === "field")!.config.field).toBe(`cf:${service.id}`);
  });

  it("update compatible only adds to the client's records, and asks about everything else", async () => {
    const { c, vip, service } = await workspaceWithOwnRecords();
    const bp = await insertPublishedBlueprint(smallContent());
    const { plan } = await run(c.org.id, bp, { strategy: "update_compatible" });
    const by = items(plan);
    expect(by["tag.vip"].action).toBe("conflict");
    expect(by["tag.vip"].reason).toMatch(/its own tag “VIP”/);
    expect(by["field.contact.service"].action).toBe("update");
    expect(by["tag.hot-lead"].action).toBe("link");
    // An undecided conflict is left exactly as it is.
    expect((await q<{ color: string }>("select color from crm_tags where id = $1", [vip.id]))[0].color).toBe("#000000");
    expect((await q<{ options: Array<{ value: string }> }>("select options from crm_custom_fields where id = $1", [service.id]))[0].options.map((o) => o.value)).toEqual(["repair", "install"]);
    const item = (await q<{ outcome: string; message: string }>("select outcome, message from crm_blueprint_application_items where org_id = $1 and asset_id = 'tag.vip'", [c.org.id]))[0];
    expect(item).toMatchObject({ outcome: "skipped", message: expect.stringMatching(/Needs a decision/) });
  });

  it("decisions: copy adds the Blueprint's version alongside, update replaces, skip keeps", async () => {
    const copyCase = await workspaceWithOwnRecords();
    const bp = await insertPublishedBlueprint(smallContent());
    const copy = await run(copyCase.c.org.id, bp, { strategy: "update_compatible", decisions: { "tag.vip": "copy" } });
    expect(items(copy.plan)["tag.vip"]).toMatchObject({ action: "create", decision: "copy" });
    const tags = await q<{ id: string; name: string; color: string }>("select id, name::text as name, color from crm_tags where org_id = $1 order by name", [copyCase.c.org.id]);
    expect(tags.map((t) => [t.name, t.color])).toEqual([["Hot lead", "#dc2626"], ["VIP", "#000000"], ["VIP (Blueprint)", "#7c3aed"]]);
    const copyId = tags.find((t) => t.name === "VIP (Blueprint)")!.id;
    expect(await linkOf(copyCase.c.org.id, bp, "tag.vip")).toBe(copyId);
    const wf = (await q<{ draft: { steps: Array<{ key: string; config: Record<string, unknown> }> } }>("select draft from crm_workflows where org_id = $1 and key = 'welcome'", [copyCase.c.org.id]))[0];
    expect(wf.draft.steps.find((s) => s.key === "tag")!.config.tagIds).toEqual([copyId]);

    const updateCase = await workspaceWithOwnRecords();
    const upd = await run(updateCase.c.org.id, bp, { strategy: "update_compatible", decisions: { "tag.vip": "update" } });
    expect(items(upd.plan)["tag.vip"]).toMatchObject({ action: "update", decision: "update" });
    expect((await q<{ color: string; description: string | null }>("select color, description from crm_tags where id = $1", [updateCase.vip.id]))[0]).toEqual({ color: "#7c3aed", description: null });
    expect(await linkOf(updateCase.c.org.id, bp, "tag.vip")).toBe(updateCase.vip.id);

    const skipCase = await workspaceWithOwnRecords();
    const skip = await run(skipCase.c.org.id, bp, { strategy: "update_compatible", decisions: { "tag.vip": "skip" } });
    expect(items(skip.plan)["tag.vip"]).toMatchObject({ action: "skip", decision: "skip" });
    expect((await q<{ color: string }>("select color from crm_tags where id = $1", [skipCase.vip.id]))[0].color).toBe("#000000");
  });

  it("restores an archived custom field with the same key instead of adding a second one", async () => {
    const c = await crmOrg();
    const f = await createCustomField(c.actor("owner"), { entity: "contact", label: "Old service", key: "service", type: "select", options: [{ value: "repair", label: "Repair" }] });
    await setCustomFieldArchived(c.actor("owner"), f.id, true);
    const bp = await insertPublishedBlueprint(smallContent());
    const { plan } = await run(c.org.id, bp, { strategy: "add_missing" });
    expect(items(plan)["field.contact.service"]).toMatchObject({ action: "update", existing: { id: f.id } });
    const rows = await q<{ id: string; label: string; archived_at: Date | null }>("select id, label, archived_at from crm_custom_fields where org_id = $1", [c.org.id]);
    expect(rows).toEqual([{ id: f.id, label: "Service", archived_at: null }]);
  });

  it("refuses a field type change that would break the client's values", async () => {
    const c = await crmOrg();
    const f = await createCustomField(c.actor("owner"), { entity: "contact", label: "Service", key: "service", type: "text" });
    await createContact(c.actor("owner"), { firstName: "Val", customFields: { service: "Roof repair" } });
    const bp = await insertPublishedBlueprint(smallContent());
    const plan = await planApplication(agency.superAdmin, c.org.id, { blueprintId: bp.blueprintId, options: { strategy: "update_compatible", decisions: { "field.contact.service": "update" } } });
    // "update" isn't possible for it; it stays a conflict that can only be kept or copied.
    expect(items(plan)["field.contact.service"]).toMatchObject({ action: "conflict", decision: null });
    expect(items(plan)["field.contact.service"].reason).toMatch(/holds values/);
    const copy = await run(c.org.id, bp, { strategy: "update_compatible", decisions: { "field.contact.service": "copy" } });
    expect(items(copy.plan)["field.contact.service"]).toMatchObject({ action: "create", decision: "copy" });
    const fields = await q<{ key: string; type: string }>("select key, type from crm_custom_fields where org_id = $1 order by key", [c.org.id]);
    expect(fields).toEqual([{ key: "service", type: "text" }, { key: "service_2", type: "select" }]);
    // References by key follow the copy.
    const wf = (await q<{ draft: { steps: Array<{ key: string; config: Record<string, unknown> }> } }>("select draft from crm_workflows where org_id = $1 and key = 'welcome'", [c.org.id]))[0];
    const copyId = (await q<{ id: string }>("select id from crm_custom_fields where org_id = $1 and key = 'service_2'", [c.org.id]))[0].id;
    expect(wf.draft.steps.find((s) => s.key === "field")!.config.field).toBe(`cf:${copyId}`);
    expect(f.id).not.toBe(copyId);
  });
});

// ---------------------------------------------------------------------------
// Newer versions
// ---------------------------------------------------------------------------

function version2(base: BlueprintContent): BlueprintContent {
  const v2 = clone(base);
  v2.assets.tags.find((t) => t.id === "tag.hot-lead")!.color = "#ea580c";
  v2.assets.tags.find((t) => t.id === "tag.vip")!.color = "#16a34a";
  v2.assets.messageTemplates[0].body = "Hi {{contact.first_name}}, we're open {{custom_values.office_hours}}. Reply any time.";
  v2.assets.pipelines[0].description = "Every new enquiry.";
  return v2;
}

describe("newer versions", () => {
  it("updates what the client didn't touch, keeps customizations, and asks before replacing them", async () => {
    const c = await crmOrg();
    const owner = c.actor("owner");
    const base = smallContent();
    const bp = await insertPublishedBlueprint(base);
    await run(c.org.id, bp, { strategy: "update_compatible" });
    const vip = (await linkOf(c.org.id, bp, "tag.vip"))!;
    const template = (await linkOf(c.org.id, bp, "template.welcome-email"))!;
    const newStage = (await linkOf(c.org.id, bp, "stage.sales.new"))!;
    await updateTag(owner, vip, { name: "VIP clients" });
    await updateTemplate(owner, template, { body: "Hello {{contact.first_name}}! Our hours: {{custom_values.office_hours}}." });
    await updateStage(owner, newStage, { name: "Fresh" });
    const v2 = await publishVersion(bp.blueprintId, version2(base));

    const { plan, result } = await run(c.org.id, v2, { strategy: "update_compatible" });
    expect(plan.mode).toBe("update");
    expect(actions(plan)).toMatchObject({
      "tag.hot-lead": "update", "tag.vip": "conflict", "template.welcome-email": "conflict", "pipeline.sales": "update", "stage.sales.new": "unchanged", "workflow.welcome": "unchanged",
    });
    expect(items(plan)["stage.sales.new"].reason).toMatch(/changed in this workspace since/);
    expect(result.application.version).toBe(2);
    expect((await q<{ name: string; color: string }>("select name::text as name, color from crm_tags where id = $1", [vip]))[0]).toEqual({ name: "VIP clients", color: "#7c3aed" });
    expect((await q<{ color: string }>("select color from crm_tags where org_id = $1 and name = 'Hot lead'", [c.org.id]))[0].color).toBe("#ea580c");
    expect((await q<{ body: string }>("select v.body from crm_message_templates t join crm_message_template_versions v on v.template_id = t.id and v.version = t.current_version where t.id = $1", [template]))[0].body).toMatch(/^Hello/);
    expect((await q<{ description: string }>("select description from crm_pipelines where org_id = $1 and name = 'Sales'", [c.org.id]))[0].description).toBe("Every new enquiry.");
    expect((await q<{ name: string }>("select name from crm_pipeline_stages where id = $1", [newStage]))[0].name).toBe("Fresh");

    // Deciding "update" for the customized tag replaces it (and only it).
    const decided = await run(c.org.id, v2, { strategy: "update_compatible", decisions: { "tag.vip": "update" } });
    expect(actions(decided.plan)).toMatchObject({ "tag.vip": "update", "tag.hot-lead": "unchanged", "template.welcome-email": "conflict" });
    expect((await q<{ name: string; color: string }>("select name::text as name, color from crm_tags where id = $1", [vip]))[0]).toEqual({ name: "VIP", color: "#16a34a" });
  });

  it("add missing never changes what the Blueprint added before", async () => {
    const c = await crmOrg();
    const base = smallContent();
    const bp = await insertPublishedBlueprint(base);
    await run(c.org.id, bp, { strategy: "add_missing" });
    const v2 = await publishVersion(bp.blueprintId, version2(base));
    const { plan } = await run(c.org.id, v2, { strategy: "add_missing" });
    expect(items(plan)["tag.hot-lead"]).toMatchObject({ action: "skip", reason: expect.stringMatching(/Add missing keeps/) });
    expect((await q<{ color: string }>("select color from crm_tags where org_id = $1 and name = 'Hot lead'", [c.org.id]))[0].color).toBe("#dc2626");
  });

  it("updates only the chosen sections: templates without touching a customized pipeline", async () => {
    const c = await crmOrg();
    const base = smallContent();
    const bp = await insertPublishedBlueprint(base);
    await run(c.org.id, bp, { strategy: "update_compatible" });
    const pipeline = (await linkOf(c.org.id, bp, "pipeline.sales"))!;
    await updatePipeline(c.actor("owner"), pipeline, { name: "Our sales" });
    const v2 = await publishVersion(bp.blueprintId, version2(base));
    const { plan } = await run(c.org.id, v2, { strategy: "update_compatible", sections: ["messageTemplates"] });
    expect(plan.items.map((i) => [i.assetId, i.action])).toEqual([["template.welcome-email", "update"]]);
    const t = (await q<{ status: string; current_version: number; body: string }>(
      "select t.status, t.current_version, v.body from crm_message_templates t join crm_message_template_versions v on v.template_id = t.id and v.version = t.current_version where t.org_id = $1 and t.key = 'welcome_email'",
      [c.org.id],
    ))[0];
    expect(t).toMatchObject({ status: "draft", current_version: 2, body: expect.stringMatching(/Reply any time/) });
    expect((await q<{ name: string; description: string | null }>("select name, description from crm_pipelines where id = $1", [pipeline]))[0]).toEqual({ name: "Our sales", description: null });
    expect((await q<{ color: string }>("select color from crm_tags where org_id = $1 and name = 'Hot lead'", [c.org.id]))[0].color).toBe("#dc2626");
  });

  it("keeps the people chosen at the first application when an update doesn't map them again", async () => {
    const c = await crmOrg();
    const base = sampleContent();
    const bp = await insertPublishedBlueprint(base);
    await run(c.org.id, bp, { strategy: "update_compatible", slotMappings: people(c) });
    const next = clone(base);
    next.assets.workflows[0].name = "New lead follow-up (v2)";
    const v2 = await publishVersion(bp.blueprintId, next);
    const preview = await previewApplication(agency.superAdmin, c.org.id, { blueprintId: bp.blueprintId, version: 2, options: { strategy: "update_compatible" } });
    expect(preview.slots.find((s) => s.slotId === "member.dispatcher")?.mappedTo).toBe(c.people.setter.id);
    expect(items(preview.plan)["workflow.new-lead"].action).toBe("update");
    await run(c.org.id, v2, { strategy: "update_compatible" });
    const wf = (await q<{ name: string; draft: { steps: Array<{ key: string; config: Record<string, unknown> }> } }>("select name, draft from crm_workflows where org_id = $1 and key = 'new_lead'", [c.org.id]))[0];
    expect(wf.name).toBe("New lead follow-up (v2)");
    expect(wf.draft.steps.find((s) => s.key === "notify")!.config.userIds).toEqual([c.people.setter.id]);
    expect(wf.draft.steps.find((s) => s.key === "task")!.config.userId).toBe(c.people.sales.id);
    // Clearing a role on purpose leaves it for the workspace to choose.
    const cleared = await planApplication(agency.superAdmin, c.org.id, { blueprintId: bp.blueprintId, version: 2, options: { strategy: "update_compatible", slotMappings: { "member.dispatcher": "" } } });
    expect(cleared.options.slotMappings).toEqual({ "member.closer": c.people.sales.id });
  });

  it("adds a new stage to the pipeline the client already has, where the CRM puts open stages", async () => {
    const c = await crmOrg();
    const base = smallContent();
    const bp = await insertPublishedBlueprint(base);
    await run(c.org.id, bp, { strategy: "add_missing" });
    const next = clone(base);
    next.assets.pipelines[0].stages.splice(2, 0, { id: "stage.sales.booked", name: "Booked", kind: "open", probability: 70, color: null });
    const v2 = await publishVersion(bp.blueprintId, next);
    const { plan, result } = await run(c.org.id, v2, { strategy: "add_missing" });
    expect(actions(plan)).toMatchObject({ "stage.sales.booked": "create", "pipeline.sales": "unchanged" });
    const stages = async () => (await q<{ name: string; position: number }>("select s.name, s.position from crm_pipeline_stages s join crm_pipelines p on p.id = s.pipeline_id where p.org_id = $1 and p.name = 'Sales' order by s.position", [c.org.id])).map((s) => `${s.position}:${s.name}`);
    expect(await stages()).toEqual(["1:New", "2:Quoted", "3:Booked", "4:Won", "5:Lost"]);
    // Rolling that version back takes out only the stage it added, and the positions close up.
    const rb = await rollbackApplication(agency.superAdmin, c.org.id, result.application.id);
    expect(rb).toMatchObject({ status: "rolled_back", rolledBack: 1 });
    expect(await stages()).toEqual(["1:New", "2:Quoted", "3:Won", "4:Lost"]);
  });

  it("asks before changing wording the client approved, and an update sends it back for approval", async () => {
    const c = await crmOrg();
    const base = smallContent();
    const bp = await insertPublishedBlueprint(base);
    await run(c.org.id, bp, { strategy: "update_compatible" });
    const template = (await linkOf(c.org.id, bp, "template.welcome-email"))!;
    const t = (await q<{ current_version: number; content_hash: string }>("select t.current_version, v.content_hash from crm_message_templates t join crm_message_template_versions v on v.template_id = t.id and v.version = t.current_version where t.id = $1", [template]))[0];
    const { approveTemplate } = await import("@/server/crm/message-templates");
    await approveTemplate(c.actor("owner"), template, { version: t.current_version, contentHash: t.content_hash });
    const v2 = await publishVersion(bp.blueprintId, version2(base));
    const plan = await planApplication(agency.superAdmin, c.org.id, { blueprintId: bp.blueprintId, version: 2, options: { strategy: "update_compatible" } });
    expect(items(plan)["template.welcome-email"]).toMatchObject({ action: "conflict", reason: expect.stringMatching(/approved in this workspace/) });
    await run(c.org.id, v2, { strategy: "update_compatible", decisions: { "template.welcome-email": "update" } });
    expect((await q<{ status: string; approved_version: number | null; current_version: number }>("select status, approved_version, current_version from crm_message_templates where id = $1", [template]))[0])
      .toEqual({ status: "draft", approved_version: null, current_version: 2 });
  });

  it("leaves records the client deleted deleted, and offers to bring back changed ones", async () => {
    const c = await crmOrg();
    const base = smallContent();
    const bp = await insertPublishedBlueprint(base);
    await run(c.org.id, bp, { strategy: "update_compatible" });
    const vip = (await linkOf(c.org.id, bp, "tag.vip"))!;
    const { deleteTag } = await import("@/server/crm/tags");
    await deleteTag(c.actor("owner"), vip);
    const same = await planApplication(agency.superAdmin, c.org.id, { blueprintId: bp.blueprintId, options: { strategy: "update_compatible" } });
    expect(items(same)["tag.vip"]).toMatchObject({ action: "skip", reason: expect.stringMatching(/deleted in this workspace/) });
    // What uses it, unchanged in the Blueprint, is never touched either.
    expect(items(same)["workflow.welcome"].action).toBe("unchanged");
    const v2 = await publishVersion(bp.blueprintId, version2(base));
    const changed = await planApplication(agency.superAdmin, c.org.id, { blueprintId: bp.blueprintId, version: 2, options: { strategy: "update_compatible" } });
    expect(items(changed)["tag.vip"].action).toBe("conflict");
    const back = await run(c.org.id, v2, { strategy: "update_compatible", decisions: { "tag.vip": "update" } });
    expect(items(back.plan)["tag.vip"]).toMatchObject({ action: "create", decision: "update" });
    const recreated = (await linkOf(c.org.id, bp, "tag.vip"))!;
    expect(recreated).not.toBe(vip);
    expect((await q<{ name: string; color: string }>("select name::text as name, color from crm_tags where id = $1", [recreated]))[0]).toEqual({ name: "VIP", color: "#16a34a" });
  });

  it("onboarding applies inside its own transaction, only with the content the version really has", async () => {
    const c = await crmOrg();
    const bp = await insertPublishedBlueprint(smallContent());
    const { applyContentInTx } = await import("@/server/crm/blueprints/apply");
    const content = (await q<{ package: BlueprintContent }>("select package from crm_blueprint_versions where id = $1", [bp.versionId]))[0].package;
    const base = { blueprintId: bp.blueprintId, versionId: bp.versionId, version: 1, blueprintName: "Small Sample", options: { strategy: "add_missing" as const }, via: "onboarding" as const };
    const edited = clone(content);
    edited.assets.tags[0].name = "Not what was published";
    await expect(withSystem((db) => applyContentInTx(db, agency.superAdmin, c.org.id, { ...base, content: edited, idempotencyKey: confirmation() }))).rejects.toMatchObject({ code: "conflict" });
    const res = await withSystem((db) => applyContentInTx(db, agency.superAdmin, c.org.id, { ...base, content, idempotencyKey: confirmation() }));
    expect(res.application).toMatchObject({ status: "applied", requestedVia: "onboarding" });
    expect((await configCounts(c.org.id)).tags).toBe(2);
  });

  it("keeps versions apart: each workspace gets exactly the version applied, and published versions never change", async () => {
    const base = smallContent();
    const bp = await insertPublishedBlueprint(base);
    const v2 = await publishVersion(bp.blueprintId, version2(base));
    const a = await crmOrg();
    const b = await crmOrg();
    await run(a.org.id, bp, { strategy: "add_missing" }, 1);
    await run(b.org.id, v2, { strategy: "add_missing" }, 2);
    expect((await q<{ color: string }>("select color from crm_tags where org_id = $1 and name = 'Hot lead'", [a.org.id]))[0].color).toBe("#dc2626");
    expect((await q<{ color: string }>("select color from crm_tags where org_id = $1 and name = 'Hot lead'", [b.org.id]))[0].color).toBe("#ea580c");
    expect((await q<{ applied_version: number }>("select distinct applied_version from crm_blueprint_links where org_id = $1", [a.org.id])).map((r) => r.applied_version)).toEqual([1]);
    expect((await q<{ applied_version: number }>("select distinct applied_version from crm_blueprint_links where org_id = $1", [b.org.id])).map((r) => r.applied_version)).toEqual([2]);
    expect((await q<{ blueprint_key: string }>("select blueprint_key from crm_workspaces where org_id = $1", [b.org.id]))[0].blueprint_key).toBe(`${bp.key}@2`);
    await expect(q("update crm_blueprint_versions set change_summary = 'edited' where id = $1", [bp.versionId])).rejects.toThrow();
    const detail = await getApplication(agency.superAdmin, a.org.id, (await q<{ id: string }>("select id from crm_blueprint_applications where org_id = $1", [a.org.id]))[0].id);
    expect(detail).toMatchObject({ version: 1, latestVersion: 2 });
  });
});

// ---------------------------------------------------------------------------
// GoHighLevel and hybrid workspaces
// ---------------------------------------------------------------------------

describe("GoHighLevel and hybrid workspaces", () => {
  const setMode = (orgId: string, mode: string, switching = false) =>
    q("insert into crm_workspaces (org_id, mode, switching) values ($1, $2, $3) on conflict (org_id) do update set mode = excluded.mode, switching = excluded.switching", [orgId, mode, switching]);

  it("refuses a workspace on GoHighLevel, or one switching providers", async () => {
    const c = await crmOrg();
    const bp = await insertPublishedBlueprint(smallContent());
    await setMode(c.org.id, "ghl");
    await expect(planApplication(agency.superAdmin, c.org.id, { blueprintId: bp.blueprintId, options: { strategy: "add_missing" } })).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/uses GoHighLevel as its CRM/) });
    await setMode(c.org.id, "native", true);
    await expect(planApplication(agency.superAdmin, c.org.id, { blueprintId: bp.blueprintId, options: { strategy: "add_missing" } })).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/being switched/) });
    expect((await configCounts(c.org.id)).tags).toBe(0);
  });

  it("in a hybrid workspace, blocks the sections GoHighLevel owns and everything that needs them", async () => {
    const c = await crmOrg();
    const bp = await insertPublishedBlueprint(smallContent());
    await setMode(c.org.id, "hybrid");
    await q("insert into crm_capability_providers (org_id, capability, provider) values ($1, 'tags', 'ghl')", [c.org.id]);
    const preview = await previewApplication(agency.superAdmin, c.org.id, { blueprintId: bp.blueprintId, options: { strategy: "add_missing" } });
    expect(preview.workspace.blockedSections).toEqual([{ section: "tags", reason: expect.stringMatching(/managed in GoHighLevel/) }]);
    const by = actions(preview.plan);
    expect(by).toMatchObject({ "tag.vip": "blocked", "tag.hot-lead": "blocked", "pipeline.sales": "create", "template.welcome-email": "create", "workflow.welcome": "blocked" });
    expect(items(preview.plan)["workflow.welcome"].reason).toMatch(/Hot lead|VIP/);
    await applyBlueprint(agency.superAdmin, c.org.id, { blueprintId: bp.blueprintId, version: 1, options: { strategy: "add_missing" }, planDigest: preview.plan.digest, idempotencyKey: confirmation() });
    expect(await configCounts(c.org.id)).toMatchObject({ tags: 0, workflows: 0, pipelines: 1, templates: 1 });
  });
});

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

describe("failures", () => {
  it("an asset that fails is recorded and skipped, without undoing the others", async () => {
    const c = await crmOrg();
    const bp = await insertPublishedBlueprint(smallContent());
    flags.failTag = "VIP";
    try {
      const { result } = await run(c.org.id, bp, { strategy: "add_missing" });
      expect(result.application.status).toBe("partially_applied");
    } finally {
      flags.failTag = null;
    }
    const rows = Object.fromEntries((await q<{ asset_id: string; outcome: string; message: string }>("select asset_id, outcome, message from crm_blueprint_application_items where org_id = $1", [c.org.id])).map((r) => [r.asset_id, r]));
    expect(rows["tag.vip"]).toMatchObject({ outcome: "failed", message: expect.stringMatching(/breaks one of the workspace's rules/) });
    // The workflow that adds that tag isn't written half-resolved: it waits for its tag.
    expect(rows["workflow.welcome"]).toMatchObject({ outcome: "skipped", message: expect.stringMatching(/VIP/) });
    expect(rows["tag.hot-lead"].outcome).toBe("applied");
    expect(rows["pipeline.sales"].outcome).toBe("applied");
    expect(await q<{ name: string }>("select name::text as name from crm_tags where org_id = $1", [c.org.id])).toEqual([{ name: "Hot lead" }]);
    // Applying again picks up exactly what is missing.
    const again = await run(c.org.id, bp, { strategy: "add_missing" });
    expect(actions(again.plan)).toMatchObject({ "tag.vip": "create", "workflow.welcome": "create", "tag.hot-lead": "unchanged" });
    expect(again.result.application.status).toBe("applied");
  });

  it("when the whole transaction fails, nothing is changed and a failed application is recorded", async () => {
    const c = await crmOrg();
    const bp = await insertPublishedBlueprint(smallContent());
    const preview = await previewApplication(agency.superAdmin, c.org.id, { blueprintId: bp.blueprintId, options: { strategy: "add_missing" } });
    const key = confirmation();
    flags.failNotify = true;
    try {
      await expect(applyBlueprint(agency.superAdmin, c.org.id, { blueprintId: bp.blueprintId, version: 1, options: { strategy: "add_missing" }, planDigest: preview.plan.digest, idempotencyKey: key }))
        .rejects.toMatchObject({ code: "internal", message: expect.stringMatching(/nothing was changed/) });
    } finally {
      flags.failNotify = false;
    }
    expect(await configCounts(c.org.id)).toMatchObject({ tags: 0, pipelines: 0, workflows: 0, templates: 0 });
    expect(await q("select 1 from crm_blueprint_links where org_id = $1", [c.org.id])).toEqual([]);
    const apps = await q<{ status: string; error: string; idempotency_key: string }>("select status, error, idempotency_key from crm_blueprint_applications where org_id = $1", [c.org.id]);
    expect(apps).toEqual([expect.objectContaining({ status: "failed", error: expect.stringMatching(/Nothing was changed/) })]);
    expect(apps[0].error).not.toMatch(/simulated/);
    expect((await q("select 1 from audit_logs where org_id = $1 and action = 'crm.blueprint_apply_failed' and result = 'failure'", [c.org.id])).length).toBe(1);
    // The same confirmation can be tried again once the problem is gone.
    const retry = await applyBlueprint(agency.superAdmin, c.org.id, { blueprintId: bp.blueprintId, version: 1, options: { strategy: "add_missing" }, planDigest: preview.plan.digest, idempotencyKey: key });
    expect(retry).toMatchObject({ replayed: false, application: { status: "applied" } });
  });
});

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

describe("rollback", () => {
  it("removes only what is unchanged and unused, keeps the rest with the reason, and never touches the client's own data", async () => {
    const c = await crmOrg();
    const owner = c.actor("owner");
    const bp = await insertPublishedBlueprint(smallContent());
    const { result } = await run(c.org.id, bp, { strategy: "add_missing" });
    const ours = await createTag(owner, { name: "Ours" });
    const hot = (await linkOf(c.org.id, bp, "tag.hot-lead"))!;
    const vip = (await linkOf(c.org.id, bp, "tag.vip"))!;
    const sales = (await linkOf(c.org.id, bp, "pipeline.sales"))!;
    const newStage = (await linkOf(c.org.id, bp, "stage.sales.new"))!;
    const ann = await createContact(owner, { firstName: "Ann", email: "ann@example.test", tagIds: [hot] });
    await createContact(owner, { firstName: "Bob", customFields: { service: "repair" } });
    await createOpportunity(owner, { name: "Roof", pipelineId: sales, stageId: newStage, contactId: ann.id });
    await updateTag(owner, vip, { name: "VIP clients" });

    const rb = await rollbackApplication(agency.superAdmin, c.org.id, result.application.id);
    expect(rb.status).toBe("partially_rolled_back");
    const kept = Object.fromEntries(rb.kept.map((k) => [k.assetId, k.reason]));
    expect(kept["tag.hot-lead"]).toMatch(/on 1 record/);
    expect(kept["field.contact.service"]).toMatch(/value in it/);
    expect(kept["pipeline.sales"]).toMatch(/deal/);
    // A pipeline that stays, stays whole: its unused stages (Won, Lost) aren't pulled out from under the client's deals.
    expect(kept["stage.sales.won"]).toMatch(/pipeline “Sales” stays/);
    expect(kept["tag.vip"]).toMatch(/changed in this workspace/);
    expect(Object.keys(kept).sort()).toEqual(["field.contact.service", "pipeline.sales", "stage.sales.lost", "stage.sales.new", "stage.sales.quoted", "stage.sales.won", "tag.hot-lead", "tag.vip"]);
    expect(rb.rolledBack).toBe(3);
    expect(await configCounts(c.org.id)).toMatchObject({ tags: 3, fields: 1, values: 0, pipelines: 1, stages: 4, templates: 0, workflows: 0 });
    expect((await q("select 1 from crm_tags where id = $1", [ours.id])).length).toBe(1);
    expect((await q("select 1 from contacts where org_id = $1", [c.org.id])).length).toBe(2);
    expect((await q("select 1 from crm_opportunities where org_id = $1", [c.org.id])).length).toBe(1);
    // Links of removed records are gone; kept ones stay so a later apply still recognizes them.
    expect(await linkOf(c.org.id, bp, "workflow.welcome")).toBeNull();
    expect(await linkOf(c.org.id, bp, "tag.hot-lead")).toBe(hot);
    const app = (await q<{ status: string; rolled_back_at: Date | null; rolled_back_by: string }>("select status, rolled_back_at, rolled_back_by from crm_blueprint_applications where id = $1", [result.application.id]))[0];
    expect(app).toMatchObject({ status: "partially_rolled_back", rolled_back_by: agency.superAdmin.id });
    const outcomes = Object.fromEntries((await q<{ asset_id: string; outcome: string }>("select asset_id, outcome from crm_blueprint_application_items where application_id = $1", [result.application.id])).map((r) => [r.asset_id, r.outcome]));
    expect(outcomes).toMatchObject({ "tag.hot-lead": "kept", "workflow.welcome": "rolled_back", "template.welcome-email": "rolled_back", "value.office-hours": "rolled_back" });
    expect((await q<{ blueprint_key: string | null }>("select blueprint_key from crm_workspaces where org_id = $1", [c.org.id]))[0].blueprint_key).toBeNull();
    expect((await q("select 1 from audit_logs where org_id = $1 and action = 'crm.blueprint_rolled_back'", [c.org.id])).length).toBe(1);
    await expect(rollbackApplication(agency.superAdmin, c.org.id, result.application.id)).rejects.toMatchObject({ code: "conflict" });
  });

  it("removes a whole unused pipeline with its stages", async () => {
    const c = await crmOrg();
    const bp = await insertPublishedBlueprint(smallContent());
    const { result } = await run(c.org.id, bp, { strategy: "add_missing" });
    const rb = await rollbackApplication(agency.superAdmin, c.org.id, result.application.id);
    expect(rb).toEqual({ status: "rolled_back", rolledBack: result.application.counts.create, kept: [] });
    expect(await configCounts(c.org.id)).toMatchObject({ tags: 0, fields: 0, values: 0, pipelines: 0, stages: 0, templates: 0, versions: 0, workflows: 0 });
    expect(await q("select 1 from crm_blueprint_links where org_id = $1", [c.org.id])).toEqual([]);
  });

  it("restores updated records that are unchanged since, and keeps customized ones", async () => {
    const c = await crmOrg();
    const base = smallContent();
    const bp = await insertPublishedBlueprint(base);
    await run(c.org.id, bp, { strategy: "update_compatible" });
    const v2 = await publishVersion(bp.blueprintId, version2(base));
    const second = await run(c.org.id, v2, { strategy: "update_compatible" });
    expect(actions(second.plan)).toMatchObject({ "tag.hot-lead": "update", "tag.vip": "update" });
    const vip = (await linkOf(c.org.id, bp, "tag.vip"))!;
    await updateTag(c.actor("owner"), vip, { description: "Changed by the client" });
    const rb = await rollbackApplication(agency.superAdmin, c.org.id, second.result.application.id);
    expect(rb.status).toBe("partially_rolled_back");
    expect(rb.kept.map((k) => k.assetId)).toEqual(["tag.vip"]);
    expect((await q<{ color: string }>("select color from crm_tags where org_id = $1 and name = 'Hot lead'", [c.org.id]))[0].color).toBe("#dc2626");
    const desc = (await q<{ color: string; description: string }>("select color, description from crm_tags where id = $1", [vip]))[0];
    expect(desc).toEqual({ color: "#16a34a", description: "Changed by the client" });
    // The restored record's link is back at version 1, so version 2 offers the update again; the kept one stays as version 2 left it.
    const plan = await planApplication(agency.superAdmin, c.org.id, { blueprintId: bp.blueprintId, version: 2, options: { strategy: "update_compatible" } });
    expect(actions(plan)).toMatchObject({ "tag.hot-lead": "update", "tag.vip": "unchanged" });
  });

  it("only the newest live application of a Blueprint can be rolled back", async () => {
    const c = await crmOrg();
    const base = smallContent();
    const bp = await insertPublishedBlueprint(base);
    const first = await run(c.org.id, bp, { strategy: "update_compatible" });
    const v2 = await publishVersion(bp.blueprintId, version2(base));
    const second = await run(c.org.id, v2, { strategy: "update_compatible" });
    expect(first.result.application.canRollBack).toBe(true);
    expect((await getApplication(agency.superAdmin, c.org.id, first.result.application.id)).canRollBack).toBe(false);
    await expect(rollbackApplication(agency.superAdmin, c.org.id, first.result.application.id)).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/most recent/) });
    expect((await rollbackApplication(agency.superAdmin, c.org.id, second.result.application.id)).status).toBe("rolled_back");
    expect((await rollbackApplication(agency.superAdmin, c.org.id, first.result.application.id)).status).toBe("rolled_back");
    expect(await configCounts(c.org.id)).toMatchObject({ tags: 0, pipelines: 0, workflows: 0 });
  });

  it("only unlinks a record the workspace already had", async () => {
    const c = await crmOrg();
    const hot = await createTag(c.actor("owner"), { name: "Hot lead", color: "#dc2626" });
    const bp = await insertPublishedBlueprint(smallContent());
    const { plan, result } = await run(c.org.id, bp, { strategy: "add_missing" });
    expect(items(plan)["tag.hot-lead"].action).toBe("link");
    await rollbackApplication(agency.superAdmin, c.org.id, result.application.id);
    expect((await q("select 1 from crm_tags where id = $1", [hot.id])).length).toBe(1);
    expect(await linkOf(c.org.id, bp, "tag.hot-lead")).toBeNull();
  });

  it("checks the person and the client", async () => {
    const c = await crmOrg();
    const other = await crmOrg();
    const bp = await insertPublishedBlueprint(smallContent());
    const { result } = await run(c.org.id, bp, { strategy: "add_missing" });
    await expect(rollbackApplication(agency.superAdmin, other.org.id, result.application.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(getApplication(agency.staff, c.org.id, result.application.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(rollbackApplication(agency.superAdmin, c.org.id, "nope")).rejects.toBeInstanceOf(AppError);
  });
});

// ---------------------------------------------------------------------------
// Setup checklist
// ---------------------------------------------------------------------------

describe("setup checklist", () => {
  it("lists what is left, with evidence, and never marks anything done because a Blueprint was applied", async () => {
    const c = await crmOrg();
    const bp = await insertPublishedBlueprint(sampleContent());
    const { result } = await run(c.org.id, bp, { strategy: "add_missing", slotMappings: people(c) });
    const list = await getBlueprintChecklist(c.actor("viewer"));
    const by = Object.fromEntries(list.items.map((i) => [i.key, i]));
    for (const key of ["calendar_hosts", "calendar_verification", "google_calendar", "meeting_link", "email_provider", "sms_provider", "whatsapp_provider", "whatsapp_template_approval", "template_approval",
      "assignment_members", "n8n_mapping", "webhook_endpoints", "review_links", "custom_values", "form_rebuild", "template_rebuild", "workflow_rebuild", "form_publishing", "workflow_activation"] as const) {
      expect(by[key]?.status, key).toBe("pending");
    }
    // The people were mapped when it was applied: that is evidence in the workspace.
    expect(by.member_mapping).toMatchObject({ status: "done" });
    // The workflows only send as AI employees (the sender identity), which this workspace includes: no AI task, so no Hermes item.
    expect(by.ai_employee).toMatchObject({ status: "done", required: true, path: "/settings/ai-tools" });
    expect(by.ai_employee.detail).toMatch(/included in this workspace/);
    expect(by.hermes).toBeUndefined();
    expect(by.calendar_hosts.detail).toMatch(/0 of 2 calendars have hosts/);
    expect(by.calendar_verification.detail).toMatch(/still drafts/);
    expect(by.email_provider.detail).toMatch(/isn't connected/);
    expect(by.custom_values.detail).toMatch(/Booking link/);
    expect(by.workflow_activation.required).toBe(false);
    expect(by.custom_values.path).toBe("/settings/values");
    expect(list.done).toBe(2);
    expect(list.total).toBe(list.items.length);

    // Evidence ticks items off: a filled value, a review page, hosts on a calendar.
    const owner = c.actor("owner");
    const value = (await linkOf(c.org.id, bp, "value.booking-link"))!;
    await updateCustomValue(owner, value, { value: "https://book.example.test/visit" });
    await q("insert into crm_review_destinations (org_id, platform, label, url) values ($1, 'google', 'Google', 'https://g.example.test/review')", [c.org.id]);
    const estimates = (await linkOf(c.org.id, bp, "calendar.estimates"))!;
    await updateCalendar(owner, estimates, { members: [{ userId: c.people.sales.id }] });
    const after = Object.fromEntries((await getBlueprintChecklistForOrg(c.org.id)).items.map((i) => [i.key, i]));
    expect(after.custom_values.status).toBe("done");
    expect(after.review_links.status).toBe("done");
    expect(after.calendar_hosts).toMatchObject({ status: "pending", detail: expect.stringMatching(/1 of 2 calendars has hosts/) });
    expect(after.google_calendar.detail).toMatch(/hasn't connected Google Calendar/);
    expect(after.calendar_verification.status).toBe("pending");

    // A sender employee taken out of the workspace reopens the item, naming it; pausing one keeps it included (and says so).
    await q("update agent_instances set enabled = false, status = 'disabled' where org_id = $1 and role_key = 'appointment_setter'", [c.org.id]);
    await q("update agent_instances set mode = 'paused' where org_id = $1 and role_key = 'sales_assistant'", [c.org.id]);
    const senders = (await getBlueprintChecklistForOrg(c.org.id)).items.find((i) => i.key === "ai_employee")!;
    expect(senders.status).toBe("pending");
    expect(senders.detail).toMatch(/isn't included in this workspace/);
    await q("update agent_instances set enabled = true, status = 'setup_required' where org_id = $1 and role_key = 'appointment_setter'", [c.org.id]);
    const resumed = (await getBlueprintChecklistForOrg(c.org.id)).items.find((i) => i.key === "ai_employee")!;
    expect(resumed.status).toBe("done");
    expect(resumed.detail).toMatch(/paused right now/);

    // Something iAcquire doesn't offer is "unavailable": shown, never pending forever, never counted.
    await q("update crm_blueprint_applications set requirements = array_append(requirements, 'payment_provider') where id = $1", [result.application.id]);
    const withPayments = await getBlueprintChecklistForOrg(c.org.id);
    const pay = withPayments.items.find((i) => i.key === "payment_provider")!;
    expect(pay).toMatchObject({ status: "unavailable", required: false });
    expect(withPayments.total).toBe(withPayments.items.length - 1);
  });

  it("tells a sender AI employee (included is enough) apart from an AI task (needs its AI service connected and checked)", async () => {
    const c = await crmOrg();
    const content = smallContent("ai-task-sample");
    content.assets.workflows.push({
      id: "workflow.summarize", key: "summarize", name: "Summarize new leads", description: null, folder: null, hourlyRunLimit: 100, placeholder: false,
      definition: {
        trigger: { type: "contact.tag_added", filters: { tagIds: ["@tag.vip"] } },
        steps: [{ key: "ai", kind: "ai_task", config: { roleKey: "crm_manager", instruction: "Summarize this lead for the team." } }],
      },
    });
    const bp = await insertPublishedBlueprint(content);
    const { plan } = await run(c.org.id, bp, { strategy: "add_missing" });
    expect(plan.requirements).toEqual(expect.arrayContaining(["ai_employee", "hermes"]));
    const by = Object.fromEntries((await getBlueprintChecklistForOrg(c.org.id)).items.map((i) => [i.key, i]));
    // Every employee is included in a new test workspace, so the sender is fine; the AI task's employee has no AI service connection.
    expect(by.ai_employee).toMatchObject({ status: "done", assetIds: ["workflow.welcome"] });
    expect(by.hermes).toMatchObject({ status: "pending", assetIds: ["workflow.summarize"] });
    expect(by.hermes.detail).toMatch(/isn't connected to its AI service/);
    expect(by.hermes.detail).not.toMatch(/Sales/i);

    // A Blueprint that only sends as an employee never asks for Hermes at all.
    const other = await crmOrg();
    const sendOnly = await insertPublishedBlueprint(smallContent("send-only-sample"));
    const { plan: sendPlan } = await run(other.org.id, sendOnly, { strategy: "add_missing" });
    expect(sendPlan.requirements).toContain("ai_employee");
    expect(sendPlan.requirements).not.toContain("hermes");
    const keys = (await getBlueprintChecklistForOrg(other.org.id)).items.map((i) => i.key);
    expect(keys).toContain("ai_employee");
    expect(keys).not.toContain("hermes");
  });

  it("counts a role as mapped only when every live Blueprint that names it mapped it here", async () => {
    const c = await crmOrg();
    const first = await insertPublishedBlueprint(sampleContent("roles-first"));
    await run(c.org.id, first, { strategy: "add_missing", slotMappings: people(c) });
    expect((await getBlueprintChecklistForOrg(c.org.id)).items.find((i) => i.key === "member_mapping")).toMatchObject({ status: "done" });
    // A second Blueprint declares the same role IDs and leaves them unmapped: the first one's mapping doesn't speak for it.
    const second = await insertPublishedBlueprint(sampleContent("roles-second"));
    await run(c.org.id, second, { strategy: "add_missing" });
    const roles = (await getBlueprintChecklistForOrg(c.org.id)).items.find((i) => i.key === "member_mapping")!;
    expect(roles.status).toBe("pending");
    expect(roles.detail).toMatch(/0 of 2 roles mapped/);
  });

  it("shows open needs in the data, and nothing for a workspace without any", async () => {
    const empty = await crmOrg();
    expect(await getBlueprintChecklistForOrg(empty.org.id)).toEqual({ items: [], done: 0, total: 0 });
    // A draft calendar from an import, without any Blueprint application, still needs verifying.
    await q("insert into crm_calendars (org_id, name, slug, status, origin) values ($1, 'Imported', 'imported', 'draft', 'ghl_import')", [empty.org.id]);
    const list = await getBlueprintChecklistForOrg(empty.org.id);
    expect(list.items.map((i) => [i.key, i.status])).toEqual([["calendar_hosts", "pending"], ["calendar_verification", "pending"]]);
    await expect(getBlueprintChecklist({ ...empty.actor("viewer"), can: () => false })).rejects.toMatchObject({ code: "forbidden" });
  });
});
