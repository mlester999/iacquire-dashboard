// Regressions for defects found in review of CRM Blueprints: provenance that named clients to staff who can't reach them, appointment
// types made bookable on a live calendar, contact details captured as configuration values, a checklist that forgot open work, rollbacks
// that broke client data, lost links or approvals, updates that went missing after a section-limited apply, activation without a meeting
// link, roles that couldn't be cleared, a hybrid dry run that promised what the apply skipped, template kinds changed in place, and stage
// reorders offered as updates. Synthetic workspaces on the in-memory database only: nothing here contacts a provider.
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { applyBlueprint, planApplication, previewApplication, rollbackApplication } from "@/server/crm/blueprints/apply";
import { captureFromClient } from "@/server/crm/blueprints/capture";
import { getBlueprintChecklistForOrg } from "@/server/crm/blueprints/checklist";
import { createBlueprint, getBlueprint, getImport, listApplications, listBlueprints, listClientOptions, listImports, listUpdateCandidates, saveImport } from "@/server/crm/blueprints/library";
import { activateCalendar } from "@/server/calendars/activation";
import { loadBookingContext } from "@/server/calendars/availability";
import { createAppointmentType, createCalendar, setHostAvailability, updateCalendar } from "@/server/calendars/setup";
import { createTag, updateTag } from "@/server/crm/tags";
import { createContact } from "@/server/crm/contacts";
import { createCustomValue } from "@/server/crm/custom-values";
import { approveTemplate } from "@/server/crm/message-templates";
import { ghlBlueprintMeta } from "@/lib/crm/blueprints/ghl/convert";
import { changedSections, diffContents } from "@/lib/crm/blueprints/diff";
import { withheldValue } from "@/lib/crm/blueprints/validate";
import type { ApplyOptions, BlueprintContent } from "@/lib/crm/blueprints/types";
import { agencyUser, createUser } from "./support/fixtures";
import { agencyPeople, crmOrg } from "./support/crm";
import { clone, confirmation, insertPublishedBlueprint, publishVersion, sampleContent, smallContent, type PublishedBlueprint } from "./support/blueprints";

const TEST_STRIPE_KEY = `sk_live_${"x".repeat(10)}`;

type Agency = Awaited<ReturnType<typeof agencyPeople>>;
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T>(sql, params))).rows;
const acts = (plan: { items: Array<{ assetId: string; action: string }> }) => Object.fromEntries(plan.items.map((i) => [i.assetId, i.action]));

let agency: Agency;
beforeAll(async () => {
  agency = await agencyPeople();
});

async function run(orgId: string, bp: PublishedBlueprint, options: ApplyOptions, version = bp.version) {
  const preview = await previewApplication(agency.superAdmin, orgId, { blueprintId: bp.blueprintId, version, options });
  const result = await applyBlueprint(agency.superAdmin, orgId, { blueprintId: bp.blueprintId, version, options, planDigest: preview.plan.digest, idempotencyKey: confirmation() });
  return { preview, plan: preview.plan, result };
}

const linkOf = async (orgId: string, blueprintId: string, assetId: string) =>
  (await q<{ native_id: string }>("select native_id from crm_blueprint_links where org_id = $1 and blueprint_id = $2 and asset_id = $3", [orgId, blueprintId, assetId]))[0]?.native_id ?? null;

// ---------------------------------------------------------------------------
// Provenance: the library names a client only to people who can reach it
// ---------------------------------------------------------------------------

describe("library provenance and unassigned staff", () => {
  const CLIENT = "Confidential Dental Clinic";
  let unassigned: ReturnType<typeof agencyUser>;
  let assigned: ReturnType<typeof agencyUser>;
  let clientId: string;
  let captured: string;
  beforeAll(async () => {
    unassigned = agencyUser(await createUser({ platformRole: "agency_staff", name: "Unassigned Staff" }), "agency_staff");
    assigned = agencyUser(await createUser({ platformRole: "agency_staff", name: "Assigned Staff" }), "agency_staff");
    const src = await crmOrg({ name: CLIENT });
    clientId = src.org.id;
    await q("insert into staff_assignments (org_id, user_id) values ($1, $2)", [clientId, assigned.id]);
    await createTag(src.actor("owner"), { name: "Implant lead" });
    captured = (await captureFromClient(agency.superAdmin, clientId, { name: "Dental starter", industry: "healthcare_wellness", sections: ["tags"], includeValues: false })).blueprintId;
  });

  it("a capture never stores the client's name, and is never found by it", async () => {
    const forStaff = await getBlueprint(unassigned, captured);
    expect(forStaff.provenance.sourceOrgName).toBeNull();
    expect(JSON.stringify([forStaff.sourceLabel, forStaff.description, forStaff.name])).not.toMatch(/Confidential/);
    expect((await listBlueprints(unassigned, { search: "confidential dental" })).map((b) => b.id)).not.toContain(captured);
    // A copy made by someone who can't reach the client carries nothing of it either.
    const dup = await createBlueprint(unassigned, { name: "Dental copy", industry: "other", from: { kind: "duplicate", blueprintId: captured, version: "draft" } });
    expect((await getBlueprint(unassigned, dup.id)).sourceLabel).not.toMatch(/Confidential/);
    // Someone who can reach the client is told which one it was.
    expect((await getBlueprint(agency.superAdmin, captured)).provenance.sourceOrgName).toBe(CLIENT);
    expect((await getBlueprint(assigned, captured)).provenance.sourceOrgName).toBe(CLIENT);
  });

  it("a label stored before (naming the client) is shown and searched only for people who can reach that client", async () => {
    await q("update crm_blueprints set source_label = $2 where id = $1", [captured, `Captured from ${CLIENT}`]);
    expect((await getBlueprint(unassigned, captured)).sourceLabel).toBe("Captured from a client workspace");
    expect((await listBlueprints(unassigned, { search: "confidential dental" })).map((b) => b.id)).not.toContain(captured);
    expect((await listBlueprints(unassigned, { search: "dental starter" })).find((b) => b.id === captured)?.sourceLabel).toBe("Captured from a client workspace");
    const dup = await createBlueprint(unassigned, { name: "Second copy", industry: "other", from: { kind: "duplicate", blueprintId: captured, version: "draft" } });
    expect((await q<{ source_label: string }>("select source_label from crm_blueprints where id = $1", [dup.id]))[0].source_label).not.toMatch(/Confidential/);
    expect((await getBlueprint(assigned, captured)).sourceLabel).toBe(`Captured from ${CLIENT}`);
    expect((await listBlueprints(assigned, { search: "confidential dental" })).map((b) => b.id)).toContain(captured);
    expect((await listBlueprints(agency.superAdmin, { search: "confidential dental" })).map((b) => b.id)).toContain(captured);
  });

  it("the report of an import from a client's own GoHighLevel location reaches only people who can reach that client", async () => {
    const bp = await insertPublishedBlueprint(smallContent("ghl-client-bp"));
    await q("update crm_blueprints set source_kind = 'ghl_import', source_label = $3, source_org_id = $2 where id = $1", [bp.blueprintId, clientId, CLIENT]);
    const report = {
      items: [{ sourceKind: "funnel", name: "Secret Launch Funnel 2027", status: "unsupported", assetId: null, assetType: null, placeholder: false, notes: [], requirements: [], missingDependencies: [] }],
      limitations: [], unavailable: [], summary: { discovered: 1, fullySupported: 0, partiallySupported: 0, unsupported: 1, failed: 0 },
    };
    const imp = (await q<{ id: string }>(
      "insert into crm_blueprint_imports (source_kind, source_org_id, source_label, status, report, blueprint_id, saved_at) values ('ghl_client', $1, $2, 'saved', $3::jsonb, $4, now()) returning id",
      [clientId, CLIENT, JSON.stringify(report), bp.blueprintId],
    ))[0].id;
    await expect(getImport(unassigned, imp)).rejects.toMatchObject({ code: "not_found" });
    const forStaff = await getBlueprint(unassigned, bp.blueprintId);
    expect(forStaff.provenance.importId).toBeNull();
    expect(forStaff.importReport).toBeNull();
    expect(JSON.stringify(forStaff)).not.toMatch(/Secret Launch Funnel|Confidential/);
    const forAdmin = await getBlueprint(agency.superAdmin, bp.blueprintId);
    expect(forAdmin.provenance.importId).toBe(imp);
    expect(forAdmin.importReport?.items.map((i) => i.name)).toContain("Secret Launch Funnel 2027");
    expect((await getBlueprint(assigned, bp.blueprintId)).provenance.importId).toBe(imp);
  });

  it("saving a client's GoHighLevel import stores no client name; the import itself is named after the client for those who reach it", async () => {
    const content = smallContent("ghl-client-save");
    content.blueprint = { ...content.blueprint, ...ghlBlueprintMeta({ label: "ignored", locationName: CLIENT, importedOn: new Date("2026-10-17T00:00:00Z"), clientSource: true }) };
    const imp = (await q<{ id: string }>(
      "insert into crm_blueprint_imports (source_kind, source_org_id, source_label, status, report, package, created_by) values ('ghl_client', $1, $2, 'previewed', '{}'::jsonb, $3::jsonb, $4) returning id",
      [clientId, "A client's GoHighLevel location", JSON.stringify(content), agency.superAdmin.id],
    ))[0].id;
    expect((await getImport(agency.superAdmin, imp)).sourceLabel).toBe(CLIENT);
    expect((await listImports(agency.superAdmin)).find((i) => i.id === imp)?.sourceLabel).toBe(CLIENT);
    expect((await listImports(unassigned)).map((i) => i.id)).not.toContain(imp);
    const { blueprintId } = await saveImport(agency.superAdmin, imp, {});
    const row = (await q<{ name: string; key: string; description: string; source_label: string; source_org_id: string }>(
      "select name, key, description, source_label, source_org_id from crm_blueprints where id = $1", [blueprintId],
    ))[0];
    expect(row.source_org_id).toBe(clientId);
    expect(JSON.stringify(row)).not.toMatch(/Confidential/);
    expect(row).toMatchObject({ name: "GoHighLevel import", source_label: "Imported from a client's GoHighLevel location" });
    expect(row.key).toMatch(/^ghl-import/);
    expect((await listBlueprints(unassigned, { search: "confidential" })).map((b) => b.id)).not.toContain(blueprintId);
  });

  it("the proposed details of a client's import never name the client; an agency template's still do", () => {
    const client = ghlBlueprintMeta({ label: CLIENT, locationName: CLIENT, importedOn: new Date("2026-10-17T00:00:00Z"), clientSource: true });
    expect(client).toMatchObject({ key: "ghl-import", name: "GoHighLevel import" });
    expect(JSON.stringify(client)).not.toMatch(/Confidential/);
    const agencyTemplate = ghlBlueprintMeta({ label: "Snapshot builder", locationName: "Builder Location", importedOn: new Date("2026-10-17T00:00:00Z") });
    expect(agencyTemplate).toMatchObject({ key: "ghl-builder-location", name: "Builder Location" });
    expect(agencyTemplate.description).toContain("Snapshot builder");
  });
});

// ---------------------------------------------------------------------------
// Appointment types added to a calendar that already takes bookings
// ---------------------------------------------------------------------------

describe("appointment types on a live calendar", () => {
  it("arrive with online booking off, and a later update never turns booking back on or off", async () => {
    const c = await crmOrg({ name: "Live Calendar Co" });
    const owner = c.actor("owner");
    await setHostAvailability(owner, c.people.owner.id, { timezone: "UTC", rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1020 })) });
    const cal = await createCalendar(owner, { name: "Estimates", assignment: "round_robin", public: true, members: [{ userId: c.people.owner.id }] });
    await createAppointmentType(owner, cal.id, { name: "Existing type", durationMinutes: 30 });
    const content = sampleContent("live-cal");
    const bp = await insertPublishedBlueprint(content);
    const options: ApplyOptions = { strategy: "add_missing", sections: ["folders", "calendars"] };
    const { plan } = await run(c.org.id, bp, options);
    expect(acts(plan)).toMatchObject({ "calendar.estimates": "skip", "apptype.estimates.onsite": "create", "apptype.estimates.video": "create", "calendar.consults": "create" });
    const onsite = plan.items.find((i) => i.assetId === "apptype.estimates.onsite")!;
    expect(onsite.reason).toMatch(/live calendar “Estimates” with online booking off/);
    expect(plan.warnings.join(" ")).toMatch(/already takes bookings.*online booking off.*On-site estimate/);
    const types = await q<{ id: string; name: string; public: boolean; cal: string }>(
      "select t.id, t.name, t.public, c.name as cal from crm_appointment_types t join crm_calendars c on c.id = t.calendar_id where t.org_id = $1", [c.org.id],
    );
    const byName = Object.fromEntries(types.map((t) => [t.name, t]));
    expect(byName["On-site estimate"].public).toBe(false);
    expect(byName["Video call"].public).toBe(false);
    expect(byName["Existing type"].public).toBe(true);
    // The new draft calendar's type keeps the Blueprint's setting: the draft takes no bookings until it is verified and activated.
    expect(byName["Online consult"].public).toBe(true);
    const ctx = await withSystem((db) => loadBookingContext(db, c.org.id, byName["On-site estimate"].id));
    expect(ctx.type.public).toBe(false);

    // The workspace turns booking on; a newer version that changes the type updates it without calling that a customization, and
    // leaves booking as the workspace set it.
    await q("update crm_appointment_types set public = true where id = $1", [byName["On-site estimate"].id]);
    const v2 = clone(content);
    v2.assets.calendars[0].types[0].durationMinutes = 90;
    v2.assets.calendars[0].types[0].public = false;
    const pub = await publishVersion(bp.blueprintId, v2);
    const second = await run(c.org.id, pub, { strategy: "update_compatible", sections: ["folders", "calendars"] });
    expect(acts(second.plan)["apptype.estimates.onsite"]).toBe("update");
    const after = (await q<{ public: boolean; duration_minutes: number }>("select public, duration_minutes from crm_appointment_types where id = $1", [byName["On-site estimate"].id]))[0];
    expect(after).toEqual({ public: true, duration_minutes: 90 });
  });
});

// ---------------------------------------------------------------------------
// Capturing configuration values
// ---------------------------------------------------------------------------

describe("capturing values", () => {
  it("never keeps contact details, even when values are included; the value is left out, never the whole asset", async () => {
    const src = await crmOrg({ name: "Values Source" });
    const owner = src.actor("owner");
    await createCustomValue(owner, { key: "owner_email", label: "Owner email", type: "email", value: "maria.santos@valuessource.com" });
    await createCustomValue(owner, { key: "owner_mobile", label: "Owner mobile", type: "phone", value: "+14155550199" });
    await createCustomValue(owner, { key: "tagline", label: "Tagline", value: "Roofs that last" });
    const res = await captureFromClient(agency.superAdmin, src.org.id, { name: "Values capture", industry: "other", sections: ["customValues"], includeValues: true });
    const draft = (await q<{ draft_package: BlueprintContent }>("select draft_package from crm_blueprints where id = $1", [res.blueprintId]))[0].draft_package;
    const values = Object.fromEntries(draft.assets.customValues.map((v) => [v.key, v.value]));
    expect(values).toEqual({ owner_email: "", owner_mobile: "", tagline: "Roofs that last" });
    expect(JSON.stringify(draft)).not.toMatch(/maria\.santos|4155550199/);
    for (const label of ["Owner email", "Owner mobile"]) {
      expect(res.warnings.some((w) => w.code === "captured_note" && w.message.includes(label) && /contact details/.test(w.message)), label).toBe(true);
    }
  });

  it("the shared rule withholds credentials, code, record IDs and contact details", () => {
    expect(withheldValue("API key", "api_key", "abc")).toBe("secret_name");
    expect(withheldValue("Note", "note", "x".repeat(2001))).toBe("too_long");
    expect(withheldValue("Note", "note", `Use ${TEST_STRIPE_KEY}`)).toBe("secret");
    expect(withheldValue("Note", "note", "<script>alert(1)</script>")).toBe("unsafe");
    expect(withheldValue("Note", "note", "Record 3f2c1a4e-7b6d-4c1e-9a2b-1c2d3e4f5a6b")).toBe("record_id");
    expect(withheldValue("Office", "office", "Call (415) 555-0199")).toBe("personal");
    expect(withheldValue("Office", "office", "Mon to Fri, 9am to 5pm")).toBeNull();
    expect(withheldValue("Booking", "booking", "https://book.example.test/roofing")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The setup checklist after a section-limited update
// ---------------------------------------------------------------------------

describe("setup checklist", () => {
  it("keeps what earlier applications still need after an update applied to some sections only", async () => {
    const c = await crmOrg();
    const base = sampleContent();
    const bp = await insertPublishedBlueprint(base);
    await run(c.org.id, bp, { strategy: "add_missing" });
    const before = await getBlueprintChecklistForOrg(c.org.id);
    const open = before.items.filter((i) => i.status !== "done").map((i) => i.key);
    expect(open).toEqual(expect.arrayContaining(["member_mapping", "form_publishing", "workflow_activation", "meeting_link"]));
    const v2 = clone(base);
    v2.assets.messageTemplates[0].body = `${v2.assets.messageTemplates[0].body} See you soon.`;
    const pub = await publishVersion(bp.blueprintId, v2);
    await run(c.org.id, pub, { strategy: "update_compatible", sections: ["messageTemplates"] });
    const after = await getBlueprintChecklistForOrg(c.org.id);
    const keys = after.items.map((i) => i.key);
    for (const k of open) expect(keys, k).toContain(k);
    expect(after.total).toBeGreaterThanOrEqual(before.total);
  });
});

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

describe("rolling back an update", () => {
  it("keeps a field whose new choice the client started using", async () => {
    const c = await crmOrg();
    const v1: BlueprintContent = smallContent();
    v1.assets.customFields[0].options = [{ value: "repair", label: "Repair" }];
    const bp = await insertPublishedBlueprint(v1);
    await run(c.org.id, bp, { strategy: "update_compatible" });
    const v2 = clone(v1);
    v2.assets.customFields[0].options = [{ value: "repair", label: "Repair" }, { value: "install", label: "Install" }];
    const pub = await publishVersion(bp.blueprintId, v2);
    const second = await run(c.org.id, pub, { strategy: "update_compatible" });
    expect(acts(second.plan)["field.contact.service"]).toBe("update");
    await createContact(c.actor("owner"), { firstName: "Ivy", customFields: { service: "install" } });
    const rb = await rollbackApplication(agency.superAdmin, c.org.id, second.result.application.id);
    expect(rb.status).toBe("partially_rolled_back");
    expect(rb.kept.find((k) => k.assetId === "field.contact.service")?.reason).toMatch(/still used by records here/);
    const f = (await q<{ options: Array<{ value: string }> }>("select options from crm_custom_fields where org_id = $1 and key = 'service'", [c.org.id]))[0];
    expect(f.options.map((o) => o.value)).toEqual(["repair", "install"]);
    const vals = await q<{ value_text: string }>("select v.value_text from crm_field_values v join crm_custom_fields f on f.id = v.field_id where f.org_id = $1 and f.key = 'service'", [c.org.id]);
    expect(vals.map((v) => v.value_text)).toEqual(["install"]);
  });

  it("keeps a field whose new type already holds values", async () => {
    const c = await crmOrg();
    const v1: BlueprintContent = smallContent();
    v1.assets.customFields.push({ id: "field.contact.budget", entity: "contact", key: "budget", label: "Budget", type: "text", options: [], required: false, helpText: null, groupName: null });
    const bp = await insertPublishedBlueprint(v1);
    await run(c.org.id, bp, { strategy: "update_compatible" });
    const v2 = clone(v1);
    v2.assets.customFields[1].type = "number";
    const pub = await publishVersion(bp.blueprintId, v2);
    const second = await run(c.org.id, pub, { strategy: "update_compatible" });
    expect(acts(second.plan)["field.contact.budget"]).toBe("update");
    await createContact(c.actor("owner"), { firstName: "Num", customFields: { budget: 1500 } });
    const rb = await rollbackApplication(agency.superAdmin, c.org.id, second.result.application.id);
    expect(rb.status).toBe("partially_rolled_back");
    expect(rb.kept.find((k) => k.assetId === "field.contact.budget")?.reason).toMatch(/already holds values/);
    expect((await q<{ type: string }>("select type from crm_custom_fields where org_id = $1 and key = 'budget'", [c.org.id]))[0].type).toBe("number");
    const vals = await q<{ value_number: string }>("select v.value_number from crm_field_values v join crm_custom_fields f on f.id = v.field_id where f.org_id = $1 and f.key = 'budget'", [c.org.id]);
    expect(vals.map((v) => Number(v.value_number))).toEqual([1500]);
  });

  it("keeps the wording the client approved after the update", async () => {
    const c = await crmOrg();
    const base = smallContent();
    const bp = await insertPublishedBlueprint(base);
    await run(c.org.id, bp, { strategy: "update_compatible" });
    const v2 = clone(base);
    v2.assets.messageTemplates[0].body = `${v2.assets.messageTemplates[0].body} See you soon.`;
    const pub = await publishVersion(bp.blueprintId, v2);
    const second = await run(c.org.id, pub, { strategy: "update_compatible" });
    const t = (await q<{ id: string; current_version: number; content_hash: string }>(
      "select t.id, t.current_version, v.content_hash from crm_message_templates t join crm_message_template_versions v on v.template_id = t.id and v.version = t.current_version where t.org_id = $1 and t.key = 'welcome_email'",
      [c.org.id],
    ))[0];
    await approveTemplate(c.actor("owner"), t.id, { version: t.current_version, contentHash: t.content_hash });
    const rb = await rollbackApplication(agency.superAdmin, c.org.id, second.result.application.id);
    expect(rb.kept.find((k) => k.assetId === "template.welcome-email")?.reason).toMatch(/approved in this workspace/);
    expect((await q("select status, approved_version, current_version from crm_message_templates where id = $1", [t.id]))[0]).toEqual({ status: "approved", approved_version: 2, current_version: 2 });
  });
});

describe("rolling back a copy or a re-added record", () => {
  it("links the asset back to the client's own record, so a later apply still recognizes it", async () => {
    const c = await crmOrg();
    const base = smallContent();
    const bp = await insertPublishedBlueprint(base);
    await run(c.org.id, bp, { strategy: "update_compatible" });
    const original = (await linkOf(c.org.id, bp.blueprintId, "tag.hot-lead"))!;
    await updateTag(c.actor("owner"), original, { name: "Hot leads!!" });
    const v2 = clone(base);
    v2.assets.tags[0].color = "#16a34a";
    const pub = await publishVersion(bp.blueprintId, v2);
    expect(acts(await planApplication(agency.superAdmin, c.org.id, { blueprintId: bp.blueprintId, version: 2, options: { strategy: "update_compatible" } }))["tag.hot-lead"]).toBe("conflict");
    const second = await run(c.org.id, pub, { strategy: "update_compatible", decisions: { "tag.hot-lead": "copy" } });
    expect(acts(second.plan)["tag.hot-lead"]).toBe("create");
    expect(await linkOf(c.org.id, bp.blueprintId, "tag.hot-lead")).not.toBe(original);
    await rollbackApplication(agency.superAdmin, c.org.id, second.result.application.id);
    expect(await linkOf(c.org.id, bp.blueprintId, "tag.hot-lead")).toBe(original);
    expect(acts(await planApplication(agency.superAdmin, c.org.id, { blueprintId: bp.blueprintId, version: 2, options: { strategy: "update_compatible" } }))["tag.hot-lead"]).toBe("conflict");
    expect(acts(await planApplication(agency.superAdmin, c.org.id, { blueprintId: bp.blueprintId, version: 1, options: { strategy: "add_missing" } }))["tag.hot-lead"]).toBe("unchanged");
  });

  it("keeps respecting a record the client deleted after a re-added one is rolled back", async () => {
    const c = await crmOrg();
    const base = smallContent();
    const bp = await insertPublishedBlueprint(base);
    await run(c.org.id, bp, { strategy: "update_compatible" });
    const original = (await linkOf(c.org.id, bp.blueprintId, "tag.vip"))!;
    await q("delete from crm_tags where id = $1", [original]);
    const v2 = clone(base);
    v2.assets.tags[1].color = "#16a34a";
    const pub = await publishVersion(bp.blueprintId, v2);
    const second = await run(c.org.id, pub, { strategy: "update_compatible", decisions: { "tag.vip": "update" } });
    expect(acts(second.plan)["tag.vip"]).toBe("create");
    await rollbackApplication(agency.superAdmin, c.org.id, second.result.application.id);
    expect(await linkOf(c.org.id, bp.blueprintId, "tag.vip")).toBe(original);
    expect(acts(await planApplication(agency.superAdmin, c.org.id, { blueprintId: bp.blueprintId, version: 1, options: { strategy: "add_missing" } }))["tag.vip"]).toBe("skip");
  });
});

// ---------------------------------------------------------------------------
// Updates after a section-limited apply
// ---------------------------------------------------------------------------

describe("update review after a section-limited update", () => {
  it("still offers the sections of the newer version that weren't applied", async () => {
    const c = await crmOrg();
    const base = smallContent();
    const bp = await insertPublishedBlueprint(base);
    await run(c.org.id, bp, { strategy: "update_compatible" });
    const v2 = clone(base);
    v2.assets.messageTemplates[0].body = `${v2.assets.messageTemplates[0].body} See you soon.`;
    v2.assets.pipelines[0].description = "Now with a description.";
    const pub = await publishVersion(bp.blueprintId, v2);
    const candidate = async () => (await listUpdateCandidates(agency.superAdmin, bp.blueprintId)).find((x) => x.orgId === c.org.id);
    const client = async () => (await listClientOptions(agency.superAdmin)).find((x) => x.id === c.org.id)!.appliedBlueprints.find((b) => b.blueprintId === bp.blueprintId);
    const newestRow = async () => (await listApplications(agency.superAdmin, { orgId: c.org.id, blueprintId: bp.blueprintId })).find((a) => a.canRollBack);
    expect(await candidate()).toMatchObject({ appliedVersion: 1, latestVersion: 2, changedSections: ["pipelines", "messageTemplates"] });

    await run(c.org.id, pub, { strategy: "update_compatible", sections: ["messageTemplates"] });
    expect(await candidate()).toMatchObject({ appliedVersion: 1, latestVersion: 2, changedSections: ["pipelines"] });
    expect(await client()).toMatchObject({ version: 1 });
    expect(await newestRow()).toMatchObject({ version: 2, updateAvailable: true });

    // Narrowed to some assets, an apply doesn't count as the whole section.
    await run(c.org.id, pub, { strategy: "update_compatible", sections: ["pipelines"], assetIds: ["stage.sales.new"] });
    expect((await candidate())?.changedSections).toEqual(["pipelines"]);

    await run(c.org.id, pub, { strategy: "update_compatible", sections: ["pipelines"] });
    expect(await candidate()).toBeUndefined();
    expect(await client()).toMatchObject({ version: 2 });
    expect(await newestRow()).toMatchObject({ version: 2, updateAvailable: false });
  });
});

// ---------------------------------------------------------------------------
// Calendar activation and the meeting link a Blueprint asked for
// ---------------------------------------------------------------------------

describe("activating a Blueprint calendar", () => {
  it("is refused until the fixed meeting link is added, as the checklist says", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const bp = await insertPublishedBlueprint(sampleContent());
    await run(c.org.id, bp, { strategy: "add_missing", slotMappings: { "member.closer": c.people.sales.id, "member.dispatcher": c.people.setter.id } });
    const cal = (await q<{ id: string }>("select id from crm_calendars where org_id = $1 and name = 'Consults'", [c.org.id]))[0];
    const owner = c.actor("owner");
    await setHostAvailability(owner, c.people.owner.id, { timezone: "Asia/Manila", rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMinute: 0, endMinute: 1440 })) });
    await updateCalendar(owner, cal.id, { members: [{ userId: c.people.owner.id }] });
    const refused = await activateCalendar(owner, cal.id);
    expect(refused.activated).toBe(false);
    const connections = refused.verification.checks.find((k) => k.key === "connections")!;
    expect(connections).toMatchObject({ ok: false });
    expect(connections.detail).toMatch(/Online consult needs the meeting link/);
    expect((await getBlueprintChecklistForOrg(c.org.id)).items.find((i) => i.key === "meeting_link")?.status).toBe("pending");

    await q("update crm_appointment_types set meeting_provider = 'custom_link', meeting_link = 'https://meet.example.com/consult' where calendar_id = $1", [cal.id]);
    const ok = await activateCalendar(owner, cal.id);
    expect(ok.activated).toBe(true);
    expect((await getBlueprintChecklistForOrg(c.org.id)).items.find((i) => i.key === "meeting_link")?.status).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// Roles remembered from an earlier application
// ---------------------------------------------------------------------------

describe("clearing a remembered role", () => {
  it("an empty mapping leaves the role for the client, and later updates stop remembering it", async () => {
    const c = await crmOrg();
    const bp = await insertPublishedBlueprint(sampleContent());
    await run(c.org.id, bp, { strategy: "add_missing", slotMappings: { "member.closer": c.people.sales.id, "member.dispatcher": c.people.setter.id } });
    const remembered = await previewApplication(agency.superAdmin, c.org.id, { blueprintId: bp.blueprintId, options: { strategy: "update_compatible" } });
    expect(remembered.slots.find((s) => s.slotId === "member.closer")?.mappedTo).toBe(c.people.sales.id);
    const options: ApplyOptions = { strategy: "update_compatible", slotMappings: { "member.closer": "" } };
    const { preview, result } = await run(c.org.id, bp, options);
    expect(preview.plan.options.slotMappings).toEqual({ "member.dispatcher": c.people.setter.id });
    expect(preview.slots.find((s) => s.slotId === "member.closer")?.mappedTo).toBeNull();
    expect(preview.slots.find((s) => s.slotId === "member.dispatcher")?.mappedTo).toBe(c.people.setter.id);
    const summary = (await q<{ summary: { slotMappings: Record<string, string> } }>("select summary from crm_blueprint_applications where id = $1", [result.application.id]))[0].summary;
    expect(summary.slotMappings).toEqual({ "member.dispatcher": c.people.setter.id });
    const later = await previewApplication(agency.superAdmin, c.org.id, { blueprintId: bp.blueprintId, options: { strategy: "update_compatible" } });
    expect(later.slots.find((s) => s.slotId === "member.closer")?.mappedTo).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Hybrid workspaces
// ---------------------------------------------------------------------------

describe("a hybrid workspace with a section GoHighLevel owns", () => {
  it("applies exactly what the dry run promised for what depends on that section", async () => {
    const c = await crmOrg();
    await createTag(c.actor("owner"), { name: "Hot lead", color: "#dc2626" });
    await createTag(c.actor("owner"), { name: "VIP", color: "#7c3aed" });
    await q("insert into crm_workspaces (org_id, mode, switching) values ($1, 'hybrid', false) on conflict (org_id) do update set mode = excluded.mode, switching = excluded.switching", [c.org.id]);
    await q("insert into crm_capability_providers (org_id, capability, provider) values ($1, 'tags', 'ghl')", [c.org.id]);
    const bp = await insertPublishedBlueprint(smallContent());
    const { plan, result } = await run(c.org.id, bp, { strategy: "add_missing" });
    expect(acts(plan)).toMatchObject({ "tag.hot-lead": "blocked", "tag.vip": "blocked", "workflow.welcome": "create" });
    const rows = await q<{ asset_id: string; action: string; outcome: string }>("select asset_id, action, outcome from crm_blueprint_application_items where application_id = $1", [result.application.id]);
    for (const r of rows) {
      if (r.action === "create" || r.action === "update" || r.action === "link") expect(r.outcome, r.asset_id).toBe("applied");
      if (r.action === "blocked") expect(r.outcome, r.asset_id).toBe("skipped");
    }
    expect(rows.find((r) => r.asset_id === "workflow.welcome")?.outcome).toBe("applied");
  });
});

// ---------------------------------------------------------------------------
// A template and a canned reply that share a key
// ---------------------------------------------------------------------------

describe("templates and canned replies", () => {
  const only = (key: string, t: BlueprintContent["assets"]["messageTemplates"][number]): BlueprintContent => {
    const c = smallContent(key);
    return { ...c, assets: { ...c.assets, tags: [], customFields: [], customValues: [], pipelines: [], workflows: [], messageTemplates: [t] } };
  };
  const canned = { id: "template.thanks", kind: "canned_reply", key: "thanks", name: "Thanks", channel: null, purpose: "service", category: null, folder: null, subject: null, body: "Thanks for your message!", whatsapp: null, placeholder: false } as const;
  const sms = { ...canned, kind: "template", channel: "sms", body: "Thanks {{contact.first_name}}!" } as const;

  for (const [from, to, label] of [[canned, sms, "a canned reply never becomes a template"], [sms, canned, "a template never becomes a canned reply"]] as const) {
    it(label, async () => {
      const c = await crmOrg();
      await run(c.org.id, await insertPublishedBlueprint(only("kind-a", { ...from })), { strategy: "add_missing" });
      const b = await insertPublishedBlueprint(only("kind-b", { ...to }));
      const first = (await planApplication(agency.superAdmin, c.org.id, { blueprintId: b.blueprintId, version: 1, options: { strategy: "update_compatible" } })).items[0];
      expect(first.action).toBe("conflict");
      expect(first.reason).toMatch(/so it can't become/);
      expect(first.reason).toMatch(/keep the workspace's version, or add the Blueprint's as a copy/);
      const decided = await run(c.org.id, b, { strategy: "update_compatible", decisions: { "template.thanks": "update" } });
      expect(decided.plan.items[0].action).toBe("conflict");
      const rows = await q<{ kind: string; current_version: number }>("select kind, current_version from crm_message_templates where org_id = $1", [c.org.id]);
      expect(rows).toEqual([{ kind: from.kind, current_version: 1 }]);
    });
  }
});

// ---------------------------------------------------------------------------
// What an update review offers
// ---------------------------------------------------------------------------

describe("changed sections", () => {
  it("leave out a pipeline or calendar whose stages or types were only reordered or removed (applying never does that)", () => {
    const base = sampleContent();
    const reordered = clone(base);
    reordered.assets.pipelines[0].stages.reverse();
    reordered.assets.calendars[0].types.reverse();
    const d = diffContents(base, reordered);
    expect(d.changes.find((x) => x.id === "pipeline.sales")?.fields).toContain("stages reordered");
    expect(changedSections(d)).toEqual([]);
    const removed = clone(base);
    removed.assets.pipelines[0].stages = removed.assets.pipelines[0].stages.filter((s) => s.id !== "stage.sales.quoted");
    expect(changedSections(diffContents(base, removed))).toEqual([]);
    const added = clone(base);
    added.assets.pipelines[0].stages.splice(1, 0, { id: "stage.sales.proposal", name: "Proposal", kind: "open", probability: 70, color: null });
    expect(changedSections(diffContents(base, added))).toEqual(["pipelines"]);
    const renamed = clone(reordered);
    renamed.assets.pipelines[0].name = "Sales 2";
    expect(changedSections(diffContents(base, renamed))).toEqual(["pipelines"]);
  });
});
