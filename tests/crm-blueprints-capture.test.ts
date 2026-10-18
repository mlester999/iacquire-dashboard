// Capturing a Blueprint from a client's Native CRM: configuration only. Customer data (contacts, companies, deals, conversations, tasks,
// notes, AI memories) and secrets never reach the package; people become roles; private lists and reports stay private; filters on
// specific people are left out with a warning; values are kept only when asked; and a capture applied to another workspace reproduces
// the same configuration there. Synthetic workspaces only: nothing here contacts a provider.
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { captureFromClient, previewCapture } from "@/server/crm/blueprints/capture";
import { applyBlueprint, previewApplication } from "@/server/crm/blueprints/apply";
import { createSmartList } from "@/server/crm/smart-lists";
import { createContact } from "@/server/crm/contacts";
import { createCompany } from "@/server/crm/companies";
import { createOpportunity } from "@/server/crm/opportunities";
import { createTask } from "@/server/crm/tasks";
import { addNote } from "@/server/crm/notes";
import { updateCustomValue, createCustomValue } from "@/server/crm/custom-values";
import { validateContent } from "@/lib/crm/blueprints/validate";
import { listAssets } from "@/lib/crm/blueprints/refs";
import type { ApplyOptions, BlueprintContent } from "@/lib/crm/blueprints/types";
import { agencyUser, createUser } from "./support/fixtures";
import { agencyPeople, crmOrg, type CrmOrg } from "./support/crm";
import { confirmation, insertPublishedBlueprint, publishDraft, sampleContent, type PublishedBlueprint } from "./support/blueprints";

const TEST_STRIPE_KEY = `sk_live_${"x".repeat(10)}`;

type Agency = Awaited<ReturnType<typeof agencyPeople>>;
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T>(sql, params))).rows;
const ALL_SECTIONS = ["folders", "tags", "customFields", "customValues", "pipelines", "calendars", "smartLists", "assignmentRules", "forms", "messageTemplates", "workflows", "reports"] as const;

/** The sample without n8n and webhook steps (a capture can't carry a step whose connection the source never mapped). */
function captureSample(): BlueprintContent {
  const c = sampleContent("capture-source");
  const wf = c.assets.workflows[0];
  wf.definition.steps = wf.definition.steps.filter((s) => s.key !== "sync" && s.key !== "hook");
  wf.definition.steps.find((s) => s.key === "notify")!.next = "review";
  c.slots = c.slots.filter((s) => s.id.startsWith("member."));
  return c;
}

async function applyTo(c: CrmOrg, bp: PublishedBlueprint, agency: Agency, mappings: Record<string, string>) {
  const options: ApplyOptions = { strategy: "add_missing", slotMappings: mappings };
  const preview = await previewApplication(agency.superAdmin, c.org.id, { blueprintId: bp.blueprintId, version: bp.version, options });
  return applyBlueprint(agency.superAdmin, c.org.id, { blueprintId: bp.blueprintId, version: bp.version, options, planDigest: preview.plan.digest, idempotencyKey: confirmation() });
}

const draftOf = async (blueprintId: string) => (await q<{ draft_package: BlueprintContent; source_kind: string; source_org_id: string; status: string; source_label: string }>(
  "select draft_package, source_kind, source_org_id, status, source_label from crm_blueprints where id = $1",
  [blueprintId],
))[0];

/** Strings that only exist in the source workspace's customer data, credentials and people. */
const CUSTOMER = ["Ann Customer", "ann.customer@clientmail.test", "5555550123", "Acme Customer Ltd", "Ann's new roof", "gate code 4321", "card ends 4242", "prefers mornings", "Call Ann about the roof"];

let agency: Agency;
let src: CrmOrg;
let srcBp: PublishedBlueprint;
let secretTemplateName: string;
beforeAll(async () => {
  agency = await agencyPeople();
  src = await crmOrg({ name: "Source Roofing" });
  srcBp = await insertPublishedBlueprint(captureSample());
  await applyTo(src, srcBp, agency, { "member.closer": src.people.sales.id, "member.dispatcher": src.people.setter.id });
  const owner = src.actor("owner");
  // Customer data the capture must never touch.
  const ann = await createContact(owner, { firstName: "Ann", lastName: "Customer", email: "ann.customer@clientmail.test", phone: "+15555550123" });
  const company = await createCompany(owner, { name: "Acme Customer Ltd" });
  const sales = (await q<{ native_id: string }>("select native_id from crm_blueprint_links where org_id = $1 and asset_id = 'pipeline.sales'", [src.org.id]))[0].native_id;
  const stage = (await q<{ native_id: string }>("select native_id from crm_blueprint_links where org_id = $1 and asset_id = 'stage.sales.new'", [src.org.id]))[0].native_id;
  await createOpportunity(owner, { name: "Ann's new roof", pipelineId: sales, stageId: stage, contactId: ann.id, companyId: company.id });
  await createTask(owner, { title: "Call Ann about the roof", contactId: ann.id });
  await addNote(owner, "contact", ann.id, "Her gate code 4321 is on the side.");
  await q("insert into contact_memories (org_id, contact_id, kind, content, created_by_kind, confirmed_by, confirmed_at) values ($1, $2, 'confirmed_fact', 'Ann prefers mornings', 'human', $3, now())", [src.org.id, ann.id, src.people.owner.id]);
  const conv = await q<{ id: string }>("insert into conversations (org_id, contact_id, channel) values ($1, $2, 'sms') returning id", [src.org.id, ann.id]);
  await q("insert into conversation_messages (org_id, conversation_id, direction, author_kind, body, status) values ($1, $2, 'inbound', 'contact', 'My card ends 4242', 'received')", [src.org.id, conv[0].id]);
  // A private list, a filter on one person, a filled value, and a template someone pasted a credential into.
  await createSmartList(owner, { name: "My callbacks", filter: { op: "and", conditions: [{ field: "lead_status", op: "in", value: ["new"] }] }, visibility: "private" });
  const booking = (await q<{ native_id: string }>("select native_id from crm_blueprint_links where org_id = $1 and asset_id = 'value.booking-link'", [src.org.id]))[0].native_id;
  await updateCustomValue(owner, booking, { value: "https://book.example.test/roofing" });
  await createCustomValue(owner, { key: "partner_note", label: "Partner note", value: `Partner portal key ${TEST_STRIPE_KEY}` }).catch(async () => {
    await q("insert into crm_custom_values (org_id, key, label, value) values ($1, 'partner_note', 'Partner note', $2)", [src.org.id, `Partner portal key ${TEST_STRIPE_KEY}`]);
  });
  secretTemplateName = "Partner handoff";
  const t = await q<{ id: string }>("insert into crm_message_templates (org_id, kind, key, name, channel) values ($1, 'template', 'partner_handoff', $2, 'sms') returning id", [src.org.id, secretTemplateName]);
  await q("insert into crm_message_template_versions (org_id, template_id, version, body, content_hash) values ($1, $2, 1, $3, $4)", [src.org.id, t[0].id, `Use token ${TEST_STRIPE_KEY} to log in.`, "a".repeat(64)]);
});

describe("capture preview", () => {
  it("lists the configuration that can be captured, says what never travels, and why some things are left out", async () => {
    const p = await previewCapture(agency.superAdmin, src.org.id);
    expect(p.orgName).toBe("Source Roofing");
    expect(p.alwaysExcluded.join(" ")).toMatch(/Contacts, companies and deals/);
    const byName = Object.fromEntries(p.candidates.map((c) => [c.name, c]));
    expect(byName["My callbacks"]).toMatchObject({ capturable: false, note: expect.stringMatching(/Private/) });
    expect(byName["Hot leads"]).toMatchObject({ capturable: true, note: expect.stringMatching(/specific people/) });
    expect(byName["Estimate request"].dependsOn).toEqual(expect.arrayContaining(["tag.hot-lead", "pipeline.sales", "rule.new-leads", "field.contact.budget"]));
    expect(byName["Weekly sales"].note).toMatch(/one team member/);
    // Candidates are configuration only.
    expect(p.candidates.every((c) => !["contact", "company", "opportunity"].includes(c.assetType))).toBe(true);
    expect(JSON.stringify(p)).not.toMatch(/Ann|clientmail|4242/);
  });

  it("needs design access to that client", async () => {
    await expect(previewCapture(agency.staff, src.org.id)).rejects.toMatchObject({ code: "not_found" });
    const outsider = agencyUser(await createUser(), "agency_staff");
    outsider.platformRole = "none";
    await expect(previewCapture(outsider, src.org.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(captureFromClient(agency.staff, src.org.id, { name: "Nope", industry: "other", sections: ["tags"], includeValues: false })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("capturing", () => {
  it("saves configuration only, as a native draft Blueprint with the client as its source", async () => {
    const res = await captureFromClient(agency.superAdmin, src.org.id, { name: "Roofing Starter", industry: "home_services", sections: [...ALL_SECTIONS], includeValues: false });
    const row = await draftOf(res.blueprintId);
    // The client is recorded by ID only: the library is shared with staff who aren't assigned to it, so its name isn't in the label.
    expect(row).toMatchObject({ source_kind: "native", source_org_id: src.org.id, status: "draft", source_label: "Captured from a client workspace" });
    expect(await q("select 1 from crm_blueprint_versions where blueprint_id = $1", [res.blueprintId])).toEqual([]);
    const content = row.draft_package;
    expect(validateContent(content).errors).toEqual([]);
    const text = JSON.stringify(content);
    // Customer data, credentials, workspace IDs: none of it.
    for (const s of CUSTOMER) expect(text, s).not.toContain(s);
    expect(text).not.toMatch(/sk_live_/);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(text).not.toMatch(/Sales Person|Setter Person|@example\.test/);
    // The template holding a credential is left out, with a warning that says why.
    expect(content.assets.messageTemplates.map((t) => t.name)).not.toContain(secretTemplateName);
    expect(res.warnings.some((w) => w.message.includes(secretTemplateName) && /left out/.test(w.message))).toBe(true);
    // What has only a name travels as a placeholder, never as a finished definition.
    expect(content.assets.messageTemplates.find((t) => t.key === "old_promo")).toMatchObject({ placeholder: true, body: "" });
    expect(content.assets.forms.find((f) => f.key === "legacy-survey")?.placeholder).toBe(true);
    expect(content.assets.workflows.find((w) => w.key === "legacy")?.placeholder).toBe(true);
    expect(content.assets.forms.find((f) => f.key === "estimate-request")?.placeholder).toBe(false);
    // Values without their contents; private lists stay private; a filter on one person is dropped (and said so).
    expect(content.assets.customValues.every((v) => v.value === "")).toBe(true);
    expect(res.warnings.some((w) => /without their contents/.test(w.message))).toBe(true);
    expect(content.assets.smartLists.map((l) => l.name).sort()).toEqual(["Big companies", "Hot leads"]);
    const hot = content.assets.smartLists.find((l) => l.name === "Hot leads")!;
    expect(JSON.stringify(hot.filter)).not.toMatch(/owner/);
    expect(res.warnings.some((w) => /Hot leads/.test(w.message) && /specific people/.test(w.message))).toBe(true);
    expect("member" in content.assets.reports.find((r) => r.key === "weekly-sales")!.config.filters).toBe(false);
    // People became roles, labelled by role, never by name.
    expect(content.slots.map((s) => s.label).sort()).toEqual(["Appointment Setter", "Sales Representative"]);
    const rule = content.assets.assignmentRules.find((r) => r.name === "New leads")!;
    expect(rule.members.map((m) => m.member)).toEqual(["@member.sales-representative"]);
    expect(rule.fallbackMember).toBe("@member.appointment-setter");
    // Workspace-only values never travel: an inbound URL's nonce, a send step's binding to this workspace's wording.
    const inbound = content.assets.workflows.find((w) => w.key === "inbound")!;
    expect(inbound.definition.trigger.inbound).toEqual({ match: "email_or_phone", createContact: true });
    expect(text).not.toMatch(/contentHash/);
    const audit = await q<{ actor_kind: string; target_id: string; metadata: { includeValues: boolean } }>("select actor_kind, target_id, metadata from audit_logs where org_id = $1 and action = 'crm.blueprint_captured'", [src.org.id]);
    expect(audit.find((a) => a.target_id === res.blueprintId)).toMatchObject({ actor_kind: "agency", metadata: expect.objectContaining({ includeValues: false }) });
  });

  it("keeps values only when asked, and never one that looks like a credential", async () => {
    const res = await captureFromClient(agency.superAdmin, src.org.id, { name: "Roofing With Values", industry: "home_services", sections: ["customValues"], includeValues: true });
    const values = Object.fromEntries((await draftOf(res.blueprintId)).draft_package.assets.customValues.map((v) => [v.key, v.value]));
    expect(values).toMatchObject({ booking_link: "https://book.example.test/roofing", office_hours: "Mon to Fri, 9am to 5pm", partner_note: "" });
    expect(res.warnings.some((w) => /Partner note/.test(w.message) && /credential/.test(w.message))).toBe(true);
  });

  it("captures only what was chosen, and brings along what that needs", async () => {
    const preview = await previewCapture(agency.superAdmin, src.org.id);
    const intake = preview.candidates.find((c) => c.name === "Form intake")!;
    const res = await captureFromClient(agency.superAdmin, src.org.id, { name: "Intake Only", industry: "general_services", sections: ["workflows"], assetIds: [intake.assetId], includeValues: false });
    const content = (await draftOf(res.blueprintId)).draft_package;
    expect(content.assets.workflows.map((w) => w.key)).toEqual(["form_intake"]);
    // The form it starts from, and what the form needs (tags, pipeline and stages, fields, the assignment rule, folders).
    expect(content.assets.forms.map((f) => f.key)).toEqual(["estimate-request"]);
    expect(content.assets.pipelines.map((p) => p.name)).toEqual(["Sales"]);
    expect(content.assets.assignmentRules.map((r) => r.name)).toEqual(["New leads"]);
    expect(content.assets.reports).toEqual([]);
    expect(content.assets.calendars).toEqual([]);
    expect(res.warnings.some((w) => w.code === "dependencies_added")).toBe(true);
    expect(validateContent(content).errors).toEqual([]);
    await expect(captureFromClient(agency.superAdmin, src.org.id, { name: "Nothing", industry: "other", sections: ["workflows"], assetIds: ["list.my-callbacks"], includeValues: false })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(captureFromClient(agency.superAdmin, src.org.id, { name: "", industry: "other", sections: ["tags"], includeValues: false })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("refuses a workspace on GoHighLevel, and leaves out what GoHighLevel owns in a hybrid one", async () => {
    const c = await crmOrg();
    await q("insert into crm_workspaces (org_id, mode) values ($1, 'ghl') on conflict (org_id) do update set mode = 'ghl'", [c.org.id]);
    await expect(previewCapture(agency.superAdmin, c.org.id)).rejects.toMatchObject({ code: "conflict" });
    const h = await crmOrg();
    const bp = await insertPublishedBlueprint(captureSample());
    await applyTo(h, bp, agency, { "member.closer": h.people.sales.id, "member.dispatcher": h.people.setter.id });
    await q("update crm_workspaces set mode = 'hybrid' where org_id = $1", [h.org.id]);
    await q("insert into crm_capability_providers (org_id, capability, provider) values ($1, 'workflows', 'ghl')", [h.org.id]);
    const p = await previewCapture(agency.superAdmin, h.org.id);
    expect(p.candidates.filter((c) => c.assetType === "workflow").every((c) => !c.capturable && /GoHighLevel/.test(c.note ?? ""))).toBe(true);
  });
});

describe("capture → apply round trip", () => {
  it("applied to another workspace, a capture reproduces the same configuration there, independently", async () => {
    const first = await captureFromClient(agency.superAdmin, src.org.id, { name: "Roofing Round Trip", industry: "home_services", sections: [...ALL_SECTIONS], includeValues: true });
    const published = await publishDraft(first.blueprintId);
    const dst = await crmOrg({ name: "Destination Roofing" });
    const res = await applyTo(dst, published, agency, { "member.sales-representative": dst.people.sales.id, "member.appointment-setter": dst.people.setter.id });
    expect(res.application.status).toBe("applied");
    expect(res.application.counts.blocked ?? 0).toBe(0);
    // Capturing the destination gives back exactly what was captured from the source.
    const second = await captureFromClient(agency.superAdmin, dst.org.id, { name: "Roofing Round Trip Back", industry: "home_services", sections: [...ALL_SECTIONS], includeValues: true });
    const a = (await draftOf(first.blueprintId)).draft_package;
    const b = (await draftOf(second.blueprintId)).draft_package;
    expect(b.assets).toEqual(a.assets);
    expect(b.slots).toEqual(a.slots);
    expect(listAssets(b).length).toBeGreaterThan(40);
    // Independent copies: none of the destination's records is one of the source's, and the destination needs nothing from GoHighLevel.
    const ids = async (orgId: string) => new Set((await q<{ id: string }>("select id from crm_tags where org_id = $1 union all select id from crm_workflows where org_id = $1 union all select id from crm_forms where org_id = $1", [orgId])).map((r) => r.id));
    const [s, d] = [await ids(src.org.id), await ids(dst.org.id)];
    expect([...d].some((id) => s.has(id))).toBe(false);
    expect((await q<{ mode: string }>("select mode from crm_workspaces where org_id = $1", [dst.org.id]))[0].mode).toBe("native");
    expect(await q("select 1 from ghl_location_mappings where org_id = $1", [dst.org.id])).toEqual([]);
    // The destination's own customer data stays empty: a Blueprint carries none.
    expect(await q("select 1 from contacts where org_id = $1", [dst.org.id])).toEqual([]);
    expect(await q("select 1 from crm_opportunities where org_id = $1", [dst.org.id])).toEqual([]);
  });
});
