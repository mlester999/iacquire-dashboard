// The agency Blueprint library (src/server/crm/blueprints/library.ts) against the in-memory database: who may do what, draft revisions,
// frozen versions and publish refusals, compare and restore, starters, folders and library filters, package export → import round trips,
// refused packages (tampered, malformed, oversize, unsafe, secret, customer IDs, newer format), GoHighLevel imports saved through the same
// flow, and application history scoped to the clients each person can reach. Synthetic data only; nothing contacts a provider.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem, type Queryable } from "@/server/db";
import { packageDigest } from "@/lib/crm/blueprints/package";
import { reportForContent } from "@/lib/crm/blueprints/report";
import { validateContent } from "@/lib/crm/blueprints/validate";
import { sha256, type AgencyUser } from "@/server/crm/blueprints/access";
import { BLUEPRINT_FORMAT, BLUEPRINT_MAX_BYTES, type BlueprintContent } from "@/lib/crm/blueprints/types";
import { keyFromName, selectAssets, suffixKey, summaryLines, capChanges } from "@/server/crm/blueprints/library/content";
import {
  archiveBlueprint, compareVersions, compareView, createBlueprint, createLibraryFolder, deleteLibraryFolder, discardImport, exportPackage, getBlueprint,
  getImport, getStarterContent, getVersionContent, inspectAssets, insertBlueprint, installStarter, libraryCounts, listApplications, listBlueprints,
  listClientOptions, listImports, listLibraryFolders, listStarters, listUpdateCandidates, listVersions, previewPackageImport, publishBlueprint,
  renameLibraryFolder, restoreVersionToDraft, saveDraft, saveImport, unarchiveBlueprint, updateBlueprintDetails,
} from "@/server/crm/blueprints/library";
import { agencyUser, createOrg, createUser, uid } from "./support/fixtures";
import { agencyPeople } from "./support/crm";

// ---------------------------------------------------------------------------
// Synthetic content
// ---------------------------------------------------------------------------

function content(key = "test-roofing", name = "Roofing Test"): BlueprintContent {
  return {
    // A literal rather than the imported constant: the starters mock below builds content before imports are ready.
    format: "iacquire.crm-blueprint",
    schemaVersion: 1,
    blueprint: { key, name, description: "Synthetic test Blueprint.", industry: "home_services" },
    settings: { defaultCurrency: "USD" },
    slots: [{ id: "member.closer", label: "Closer", description: null }],
    assets: {
      folders: [{ id: "folder.tag.lead-status", kind: "tag", name: "Lead status" }],
      tags: [
        { id: "tag.hot-lead", name: "Hot lead", color: "#dc2626", description: null, folder: "@folder.tag.lead-status" },
        { id: "tag.quote-sent", name: "Quote sent", color: "#2563eb", description: "A quote went out.", folder: null },
      ],
      customFields: [
        { id: "field.contact.budget", entity: "contact", key: "budget", label: "Budget", type: "number", options: [], required: false, helpText: null, groupName: null },
      ],
      customValues: [
        { id: "value.office-hours", key: "office_hours", label: "Office hours", type: "text", value: "Mon to Fri, 9am to 5pm", required: false, groupName: null },
      ],
      pipelines: [
        {
          id: "pipeline.sales", name: "Sales", description: null, isDefault: true, stages: [
            { id: "stage.sales.new", name: "New", kind: "open", probability: 10, color: null },
            { id: "stage.sales.won", name: "Won", kind: "won", probability: 100, color: null },
            { id: "stage.sales.lost", name: "Lost", kind: "lost", probability: 0, color: null },
          ],
        },
      ],
      calendars: [
        {
          id: "calendar.estimates", name: "Estimates", description: null, assignment: "single", roundRobinMode: "balanced", color: null, folder: null,
          bookingIntro: null, timezone: "America/New_York", hours: [{ weekday: 1, startMinute: 540, endMinute: 1020 }], hosts: ["@member.closer"],
          types: [{
            id: "apptype.estimates.onsite", name: "On-site estimate", description: null, durationMinutes: 60, slotIntervalMinutes: null, bufferBeforeMinutes: 0,
            bufferAfterMinutes: 15, minNoticeMinutes: 120, maxDaysAhead: 60, dailyLimit: null, capacity: 1, locationKind: "in_person", locationDetail: "At the customer's home",
            meetingProvider: "none", meetingLink: null, requiresConfirmation: false, public: true, questions: [], color: null, confirmationMessage: null,
            allowCustomerChanges: true, changeCutoffMinutes: 0, requireEmail: true, requirePhone: false,
          }],
        },
      ],
      smartLists: [
        {
          id: "list.hot-leads", entity: "contact", name: "Hot leads", description: null, folder: null,
          filter: { op: "and", conditions: [{ field: "tags", op: "has_any", value: ["@tag.hot-lead"] }] }, columns: ["phone", "@field.contact.budget"], sort: {}, isDefault: false,
        },
      ],
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
              tagIds: ["@tag.hot-lead"], opportunity: { pipelineId: "@pipeline.sales", stageId: "@stage.sales.new", name: "{{contact.full_name}}", valueQuestion: "budget" },
              assignmentRuleId: null, notify: { roles: ["owner"], contactOwner: true }, after: { kind: "message", message: "Thanks! We'll be in touch." },
            },
            settings: { title: "", intro: "", submitLabel: "Send" },
          },
        },
      ],
      messageTemplates: [
        {
          id: "template.estimate-reminder", kind: "template", key: "estimate_reminder", name: "Estimate reminder", channel: "sms", purpose: "service", category: null, folder: null,
          subject: null, body: "Hi {{contact.first_name}}, your estimate is on {{appointment.date}}. Our hours: {{custom_values.office_hours}}", whatsapp: null, placeholder: false,
        },
      ],
      workflows: [
        {
          id: "workflow.form-intake", key: "form_intake", name: "Form intake", description: null, folder: null, hourlyRunLimit: 500, placeholder: false,
          definition: { trigger: { type: "form.submitted", filters: { formIds: ["@form.estimate-request"] } }, steps: [{ key: "t", kind: "add_tag", config: { tagIds: ["@tag.quote-sent"] } }] },
        },
      ],
      reports: [
        { id: "report.weekly-sales", key: "weekly-sales", name: "Weekly sales", description: null, folder: null, config: { filters: { range: "7d", member: "@member.closer", pipeline: "@pipeline.sales" }, sections: ["deals"] } },
      ],
    },
  };
}

/** A synthetic starter (the real starters are tested with their own package). */
function starterContent(): BlueprintContent {
  return { ...content("test-starter-plumbing", "Plumbing starter"), blueprint: { key: "test-starter-plumbing", name: "Plumbing starter", description: "A synthetic starter.", industry: "home_services" } };
}

vi.mock("@/lib/crm/blueprints/starters", () => {
  const starter = starterContent();
  return { STARTER_BLUEPRINTS: [starter], getStarter: (key: string) => (key === starter.blueprint.key ? starterContent() : null) };
});

const STARTER = starterContent();

/** A package file built by hand (so it can hold what an export never would), with a correct digest. */
function handPackage(c: unknown): string {
  return JSON.stringify({ ...(c as object), integrity: { algorithm: "sha256", digest: packageDigest(c as BlueprintContent, sha256) }, exportedAt: new Date().toISOString(), generator: "test" });
}

let admin: AgencyUser;
let staff: AgencyUser;
let clientPerson: AgencyUser;

beforeAll(async () => {
  ({ superAdmin: admin, staff } = await agencyPeople());
  clientPerson = { ...agencyUser(await createUser(), "agency_staff"), platformRole: "none" };
});

async function publishedBlueprint(key = `bp-${uid()}`, name = "Roofing Test"): Promise<{ id: string; revision: number }> {
  const { id } = await createBlueprint(admin, { name, key, industry: "home_services", from: { kind: "blank" } });
  const saved = await saveDraft(admin, id, { content: content(key, name), revision: 1 });
  await publishBlueprint(admin, id, { revision: saved.revision });
  return { id, revision: saved.revision };
}

// ---------------------------------------------------------------------------

describe("the fixture", () => {
  it("is valid package content", () => {
    expect(validateContent(content()).errors).toEqual([]);
  });

  it("keys, selections and change lists", () => {
    expect(keyFromName("Home Services – Roofing!")).toBe("home-services-roofing");
    expect(keyFromName("AB")).toBe("ab-blueprint");
    expect(keyFromName("€€")).toBe("blueprint");
    expect(suffixKey("a".repeat(64), 12)).toHaveLength(64);
    const picked = selectAssets(content(), ["workflow.form-intake"]);
    // A workflow brings the form it starts from, and the form what it uses; nothing else.
    expect(picked.assets.workflows.map((w) => w.id)).toEqual(["workflow.form-intake"]);
    expect(picked.assets.forms.map((f) => f.id)).toEqual(["form.estimate-request"]);
    expect(picked.assets.tags.map((t) => t.id).sort()).toEqual(["tag.hot-lead", "tag.quote-sent"]);
    expect(picked.assets.pipelines[0].stages).toHaveLength(3);
    expect(picked.assets.calendars).toEqual([]);
    expect(picked.assets.reports).toEqual([]);
    expect(picked.slots).toEqual([]);
    expect(validateContent(picked).errors).toEqual([]);
    expect(() => selectAssets(content(), ["tag.nope"])).toThrow(/aren't in this import/);
    expect(summaryLines([], 1)).toEqual(["First published version"]);
    expect(summaryLines([{ id: "tag.a", name: "A", section: "tags", kind: "added", fields: [] }, { id: "tag.b", name: "B", section: "tags", kind: "changed", fields: ["color"] }], 2)).toEqual(["Tags: 1 added, 1 changed"]);
    const huge = Array.from({ length: 4000 }, (_, i) => ({ id: `tag.t${i}`, name: `Tag ${i}`, section: "tags" as const, kind: "changed" as const, fields: Array.from({ length: 30 }, () => "x".repeat(300)) }));
    expect(new TextEncoder().encode(JSON.stringify(capChanges(huge))).length).toBeLessThanOrEqual(120_000);
  });
});

describe("permissions", () => {
  it("lets staff browse and design, super admins publish, and no client user in", async () => {
    await expect(listBlueprints(clientPerson)).rejects.toMatchObject({ code: "forbidden" });
    await expect(createBlueprint(clientPerson, { name: "Nope", industry: "other", from: { kind: "blank" } })).rejects.toMatchObject({ code: "forbidden" });
    await expect(listApplications(clientPerson)).rejects.toMatchObject({ code: "forbidden" });
    await expect(listImports(clientPerson)).rejects.toMatchObject({ code: "forbidden" });

    const { id } = await createBlueprint(staff, { name: "Staff draft", industry: "consulting", from: { kind: "blank" } });
    const saved = await saveDraft(staff, id, { content: content("ignored-key", "Staff draft"), revision: 1 });
    expect(saved.revision).toBe(2);
    await expect(publishBlueprint(staff, id, { revision: 2 })).rejects.toMatchObject({ code: "forbidden" });
    await expect(installStarter(staff, STARTER.blueprint.key)).rejects.toMatchObject({ code: "forbidden" });

    const detail = await getBlueprint(staff, id);
    expect(detail).toMatchObject({ canDesign: true, canPublish: false, canApply: false, status: "draft", currentVersion: null });
    // The editor can't change the library key.
    expect(detail.draft.blueprint.key).toBe(detail.key);
    expect((await getBlueprint(admin, id)).canPublish).toBe(true);
    expect(await publishBlueprint(admin, id, { revision: 2 })).toMatchObject({ version: 1 });
    expect((await getBlueprint(admin, id)).canApply).toBe(true);
    expect((await getBlueprint(staff, id)).canApply).toBe(false);

    // A role taken away after sign-in is refused, even though the session still says "staff".
    const demoted = await agencyPeople();
    await withSystem((db) => db.query("update users set platform_role = 'none' where id = $1", [demoted.staff.id]));
    await expect(listBlueprints(demoted.staff)).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("drafts", () => {
  it("saves with revisions, refuses stale ones, and never stores code or credentials", async () => {
    const { id } = await createBlueprint(staff, { name: "Draft Rev", industry: "home_services", from: { kind: "blank" } });
    const first = await saveDraft(staff, id, { content: content("x", "Draft Rev"), revision: 1 });
    expect(first.revision).toBe(2);
    expect(first.errors).toEqual([]);
    // Someone else saved meanwhile: the editor that opened revision 1 is refused.
    await expect(saveDraft(admin, id, { content: content("x", "Other"), revision: 1 })).rejects.toMatchObject({ code: "conflict" });
    // Saving identical content changes nothing.
    expect((await saveDraft(staff, id, { content: content("x", "Draft Rev"), revision: 2 })).revision).toBe(2);

    const secret = content("x", "Draft Rev");
    secret.assets.tags[1].description = `Key: ${"sk_" + "live_" + "Q".repeat(24)}`;
    await expect(saveDraft(staff, id, { content: secret, revision: 2 })).rejects.toMatchObject({ code: "invalid_input" });
    const script = content("x", "Draft Rev");
    script.assets.messageTemplates[0].body = "Hi <script>alert(1)</script>";
    await expect(saveDraft(staff, id, { content: script, revision: 2 })).rejects.toMatchObject({ code: "invalid_input" });
    const malformed = { ...content("x", "Draft Rev"), extra: true };
    await expect(saveDraft(staff, id, { content: malformed as unknown as BlueprintContent, revision: 2 })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(saveDraft(staff, id, { content: "nope" as unknown as BlueprintContent, revision: 2 })).rejects.toMatchObject({ code: "invalid_input" });
    expect((await getBlueprint(staff, id)).draftRevision).toBe(2);

    // A dangling reference can sit in a draft (it only blocks publishing) and is reported.
    const dangling = content("x", "Draft Rev");
    dangling.assets.tags[0].folder = "@folder.tag.missing";
    const r = await saveDraft(staff, id, { content: dangling, revision: 2 });
    expect(r.revision).toBe(3);
    expect(r.errors.map((e) => e.code)).toContain("missing_ref");
    const detail = await getBlueprint(staff, id);
    expect(detail.draftErrors.map((e) => e.code)).toContain("missing_ref");
    await expect(publishBlueprint(admin, id, { revision: 3 })).rejects.toMatchObject({ code: "invalid_input" });

    // Details are part of the package: renaming moves the draft on, so an editor on the old revision reloads.
    const renamed = await updateBlueprintDetails(staff, id, { name: "Draft Renamed", description: "Now described." });
    expect(renamed.revision).toBe(4);
    const after = await getBlueprint(staff, id);
    expect(after).toMatchObject({ name: "Draft Renamed", description: "Now described.", draftRevision: 4 });
    expect(after.draft.blueprint).toMatchObject({ name: "Draft Renamed", description: "Now described." });
    await expect(saveDraft(staff, id, { content: content("x", "Draft Rev"), revision: 3 })).rejects.toMatchObject({ code: "conflict" });
    // Library-only details (featured) don't touch the draft.
    expect((await updateBlueprintDetails(staff, id, { featured: true })).revision).toBe(4);
    await expect(updateBlueprintDetails(staff, id, { name: "" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(updateBlueprintDetails(staff, id, { industry: "space" as never })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(getBlueprint(staff, "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ code: "not_found" });
    await expect(getBlueprint(staff, "not-an-id")).rejects.toMatchObject({ code: "not_found" });
  });

  it("gives every Blueprint its own key", async () => {
    const key = `keyed-${uid()}`;
    const a = await createBlueprint(staff, { name: "Keyed", key, industry: "other", from: { kind: "blank" } });
    await expect(createBlueprint(staff, { name: "Keyed again", key, industry: "other", from: { kind: "blank" } })).rejects.toMatchObject({ code: "conflict" });
    await expect(createBlueprint(staff, { name: "Bad key", key: "-x", industry: "other", from: { kind: "blank" } })).rejects.toMatchObject({ code: "invalid_input" });
    // Without an explicit key the name's key gets the next free suffix.
    const name = `Same Name ${uid()}`;
    const b = await createBlueprint(staff, { name, industry: "other", from: { kind: "blank" } });
    const c = await createBlueprint(staff, { name, industry: "other", from: { kind: "blank" } });
    expect((await getBlueprint(staff, c.id)).key).toBe(`${(await getBlueprint(staff, b.id)).key}-2`);
    expect((await getBlueprint(staff, a.id)).key).toBe(key);
  });
});

describe("publishing", () => {
  it("freezes versions and refuses what shouldn't be published", async () => {
    const key = `pub-${uid()}`;
    const { id } = await createBlueprint(staff, { name: "Pub", key, industry: "home_services", from: { kind: "blank" } });
    await expect(publishBlueprint(admin, id, { revision: 1 })).rejects.toMatchObject({ code: "invalid_input", message: expect.stringContaining("at least one asset") });
    const saved = await saveDraft(staff, id, { content: content(key, "Pub"), revision: 1 });
    await expect(publishBlueprint(admin, id, { revision: 1 })).rejects.toMatchObject({ code: "conflict" });
    await expect(publishBlueprint(admin, id, { revision: saved.revision, changeSummary: "<script>x</script>" })).rejects.toMatchObject({ code: "invalid_input" });
    const v1 = await publishBlueprint(admin, id, { revision: saved.revision });
    expect(v1.version).toBe(1);
    await expect(publishBlueprint(admin, id, { revision: saved.revision })).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("Nothing changed") });

    // Edit the draft: the card says there are unpublished changes, and version 1 stays exactly as it was.
    const edited = content(key, "Pub");
    edited.assets.tags.push({ id: "tag.vip", name: "VIP", color: "#7c3aed", description: null, folder: null });
    const r2 = await saveDraft(staff, id, { content: edited, revision: saved.revision });
    const card = (await listBlueprints(staff, { search: key })).find((b) => b.id === id)!;
    expect(card).toMatchObject({ status: "published", currentVersion: 1, hasUnpublishedChanges: true });
    expect(card.modules.find((m) => m.section === "tags")?.count).toBe(2);
    expect((await getVersionContent(staff, id, 1)).assets.tags).toHaveLength(2);
    expect((await getBlueprint(staff, id)).unpublishedDiff?.changes).toEqual([expect.objectContaining({ id: "tag.vip", kind: "added" })]);

    const v2 = await publishBlueprint(admin, id, { revision: r2.revision, changeSummary: "Adds a VIP tag." });
    expect(v2.version).toBe(2);
    const versions = await listVersions(staff, id);
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    expect(versions[0]).toMatchObject({ changeSummary: "Adds a VIP tag.", summaryLines: ["Tags: 1 added"], schemaVersion: 1 });
    expect(versions[0].counts.tags).toBe(3);
    expect(versions[0].publishedBy).toBe("Agency Admin");
    expect(versions[1].summaryLines).toEqual(["First published version"]);
    expect(versions[1].changeSummary).toMatch(/^First version: /);
    expect(versions[0].digest).toMatch(/^[0-9a-f]{64}$/);
    expect(versions[0].digest).not.toBe(versions[1].digest);

    // Frozen in the database too.
    await expect(withSystem((db) => db.query("update crm_blueprint_versions set change_summary = 'changed' where blueprint_id = $1", [id]))).rejects.toThrow();
    expect((await getVersionContent(staff, id, 1)).assets.tags.map((t) => t.id)).toEqual(["tag.hot-lead", "tag.quote-sent"]);

    // Archived: nothing changes until it is unarchived, and it comes back published.
    await archiveBlueprint(staff, id);
    expect((await getBlueprint(staff, id))).toMatchObject({ status: "archived", canPublish: false, canApply: false });
    await expect(saveDraft(staff, id, { content: edited, revision: r2.revision })).rejects.toMatchObject({ code: "conflict" });
    await expect(publishBlueprint(admin, id, { revision: r2.revision })).rejects.toMatchObject({ code: "conflict" });
    await expect(updateBlueprintDetails(staff, id, { name: "Renamed" })).rejects.toMatchObject({ code: "conflict" });
    expect((await listBlueprints(staff, { search: key })).map((b) => b.id)).not.toContain(id);
    expect((await listBlueprints(staff, { search: key, collection: "archived" })).map((b) => b.id)).toContain(id);
    await unarchiveBlueprint(staff, id);
    expect((await getBlueprint(staff, id)).status).toBe("published");

    const { rows } = await withSystem((db) => db.query<{ action: string; org_id: string | null; actor_kind: string }>(
      "select action, org_id, actor_kind from audit_logs where target_id = $1 order by id", [id],
    ));
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(["crm.blueprint_created", "crm.blueprint_draft_saved", "crm.blueprint_published", "crm.blueprint_archived", "crm.blueprint_unarchived"]));
    expect(rows.every((r) => r.org_id === null && r.actor_kind === "agency")).toBe(true);
  });

  it("compares versions and restores one to the draft", async () => {
    const key = `cmp-${uid()}`;
    const { id, revision } = await publishedBlueprint(key, "Compare");
    const changed = content(key, "Compare");
    changed.assets.tags[0].color = "#000000";
    changed.assets.pipelines[0].stages.splice(1, 0, { id: "stage.sales.quoted", name: "Quoted", kind: "open", probability: 50, color: null });
    const r = await saveDraft(staff, id, { content: changed, revision });
    await publishBlueprint(admin, id, { revision: r.revision });

    const diff = await compareVersions(staff, id, 1, 2);
    expect(diff.empty).toBe(false);
    expect(diff.changes.find((c) => c.id === "tag.hot-lead")).toMatchObject({ kind: "changed", fields: ["color"] });
    expect(diff.changes.find((c) => c.id === "pipeline.sales")?.fields).toContain("stage added: Quoted");
    expect((await compareVersions(staff, id, 2, "draft")).empty).toBe(true);
    const view = await compareView(staff, id, 1, "draft");
    expect(view.from.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(view.to).toMatchObject({ version: "draft", digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    await expect(compareVersions(staff, id, 1, 9)).rejects.toMatchObject({ code: "not_found" });
    await expect(compareVersions(staff, id, 0 as never, 1)).rejects.toMatchObject({ code: "invalid_input" });

    await updateBlueprintDetails(staff, id, { name: "Compare (kept name)" });
    const restored = await restoreVersionToDraft(staff, id, 1);
    const draft = await getVersionContent(staff, id, "draft");
    expect(draft.assets).toEqual((await getVersionContent(staff, id, 1)).assets);
    // The library details stay as they are now.
    expect(draft.blueprint.name).toBe("Compare (kept name)");
    expect((await getBlueprint(staff, id)).draftRevision).toBe(restored.revision);
    const v3 = await publishBlueprint(admin, id, { revision: restored.revision });
    expect(v3.version).toBe(3);
    expect((await compareVersions(staff, id, 1, 3)).changes).toEqual([]);
    expect((await listVersions(staff, id)).map((v) => v.version)).toEqual([3, 2, 1]);

    const assets = await inspectAssets(staff, id, 3);
    expect(assets.find((a) => a.id === "tag.hot-lead")?.usedBy).toEqual(expect.arrayContaining(["form.estimate-request", "list.hot-leads"]));
    expect(assets.find((a) => a.id === "calendar.estimates")).toMatchObject({ slots: ["member.closer"], requirements: expect.arrayContaining(["calendar_hosts", "calendar_verification"]) });
    expect(assets.find((a) => a.id === "stage.sales.new")?.parentId).toBe("pipeline.sales");
  });

  it("duplicates a draft or a version as a new draft", async () => {
    const key = `dup-${uid()}`;
    const { id } = await publishedBlueprint(key, "Original");
    const copy = await createBlueprint(staff, { name: "Copy", industry: "consulting", from: { kind: "duplicate", blueprintId: id, version: 1 } });
    const d = await getBlueprint(staff, copy.id);
    expect(d).toMatchObject({ status: "draft", source: "native", industry: "consulting", name: "Copy", draftRevision: 1 });
    expect(d.sourceLabel).toContain("Copy of “Original” (version 1)");
    expect(d.draft.assets).toEqual((await getVersionContent(staff, id, 1)).assets);
    expect(d.draft.blueprint.key).toBe(d.key);
    expect(d.draft.blueprint.description).toBe("Synthetic test Blueprint.");
    await expect(createBlueprint(staff, { name: "Copy", industry: "consulting", from: { kind: "duplicate", blueprintId: id, version: 7 } })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("starters", () => {
  it("installs a starter once, published, and copies it on request", async () => {
    const before = await listStarters(staff);
    expect(before).toEqual([expect.objectContaining({ key: STARTER.blueprint.key, installedId: null, industry: "home_services" })]);
    expect(before[0].totalAssets).toBeGreaterThan(5);
    expect(before[0].requirements).toContain("calendar_verification");
    expect((await getStarterContent(staff, STARTER.blueprint.key)).blueprint.key).toBe(STARTER.blueprint.key);
    await expect(getStarterContent(staff, "nope")).rejects.toMatchObject({ code: "not_found" });

    const [a, b] = await Promise.all([installStarter(admin, STARTER.blueprint.key), installStarter(admin, STARTER.blueprint.key)]);
    expect(a.id).toBe(b.id);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    const installed = await getBlueprint(staff, a.id);
    expect(installed).toMatchObject({ source: "starter", status: "published", currentVersion: 1, hasUnpublishedChanges: false, key: STARTER.blueprint.key });
    expect(installed.provenance.starterKey).toBe(STARTER.blueprint.key);
    expect((await listStarters(staff))[0].installedId).toBe(a.id);
    await expect(installStarter(admin, "no-such-starter")).rejects.toMatchObject({ code: "not_found" });

    const copy = await createBlueprint(staff, { name: "My plumbing", industry: "home_services", from: { kind: "starter", starterKey: STARTER.blueprint.key } });
    const c = await getBlueprint(staff, copy.id);
    expect(c).toMatchObject({ source: "native", status: "draft", key: "my-plumbing" });
    expect(c.sourceLabel).toContain("Plumbing starter");
    expect(c.provenance.starterKey).toBeNull();
    expect(c.draft.assets).toEqual(validateContent(STARTER).content!.assets);
    await expect(createBlueprint(staff, { name: "X", industry: "other", from: { kind: "starter", starterKey: "missing" } })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("folders and the library", () => {
  it("filters, searches, sorts and counts", async () => {
    const tag = uid();
    const folder = await createLibraryFolder(staff, `Trades ${tag}`);
    await expect(createLibraryFolder(staff, `trades ${tag}`)).rejects.toMatchObject({ code: "conflict" });
    await expect(createLibraryFolder(staff, "  ")).rejects.toMatchObject({ code: "invalid_input" });
    await expect(createLibraryFolder(clientPerson, "No")).rejects.toMatchObject({ code: "forbidden" });
    const other = await createLibraryFolder(staff, `Other ${tag}`);
    await expect(renameLibraryFolder(staff, other.id, `Trades ${tag}`)).rejects.toMatchObject({ code: "conflict" });
    await renameLibraryFolder(staff, other.id, `Misc ${tag}`);

    const inFolder = await createBlueprint(staff, { name: `Zeta ${tag}`, industry: "automotive", folderId: folder.id, from: { kind: "blank" } });
    const loose = await createBlueprint(staff, { name: `Alpha ${tag}`, industry: "beauty_salons", from: { kind: "blank" } });
    await updateBlueprintDetails(staff, loose.id, { featured: true });
    await expect(createBlueprint(staff, { name: "Bad folder", industry: "other", folderId: "00000000-0000-4000-8000-000000000000", from: { kind: "blank" } })).rejects.toMatchObject({ code: "invalid_input" });

    const ids = (bs: Array<{ id: string }>) => bs.map((b) => b.id);
    expect(ids(await listBlueprints(staff, { folderId: folder.id }))).toEqual([inFolder.id]);
    expect(ids(await listBlueprints(staff, { search: tag, folderId: null }))).toEqual([loose.id]);
    expect(ids(await listBlueprints(staff, { search: tag, sort: "name" }))).toEqual([loose.id, inFolder.id]);
    expect(ids(await listBlueprints(staff, { search: tag.toUpperCase(), industry: "automotive" }))).toEqual([inFolder.id]);
    expect(ids(await listBlueprints(staff, { search: tag, collection: "featured" }))).toEqual([loose.id]);
    expect(ids(await listBlueprints(staff, { search: tag, collection: "drafts" })).sort()).toEqual([inFolder.id, loose.id].sort());
    expect(ids(await listBlueprints(staff, { search: tag, collection: "published" }))).toEqual([]);
    expect(ids(await listBlueprints(staff, { search: tag, collection: "imported_ghl" }))).toEqual([]);
    expect(ids(await listBlueprints(staff, { search: tag, collection: "native" })).sort()).toEqual([inFolder.id, loose.id].sort());
    // Unknown filter values from an address bar are ignored, not errors.
    expect(ids(await listBlueprints(staff, { search: tag, collection: "bogus" as never, sort: "bogus" as never, industry: "bogus" as never })).sort()).toEqual([inFolder.id, loose.id].sort());
    expect(await listBlueprints(staff, { folderId: "not-a-uuid" })).toEqual([]);

    const folders = await listLibraryFolders(staff);
    expect(folders.find((f) => f.id === folder.id)).toMatchObject({ name: `Trades ${tag}`, count: 1 });
    expect(folders.find((f) => f.id === other.id)).toMatchObject({ name: `Misc ${tag}`, count: 0 });

    const counts = await libraryCounts(staff);
    expect(counts.collections.all).toBeGreaterThanOrEqual(2);
    expect(counts.collections.featured).toBeGreaterThanOrEqual(1);
    expect(counts.industries.automotive).toBeGreaterThanOrEqual(1);

    await deleteLibraryFolder(staff, folder.id);
    expect((await getBlueprint(staff, inFolder.id)).folderId).toBeNull();
    await expect(deleteLibraryFolder(staff, folder.id)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("package files", () => {
  it("round-trips an export through the import preview into a new draft", async () => {
    const key = `rt-${uid()}`;
    const { id } = await publishedBlueprint(key, "Round Trip");
    await expect(exportPackage(clientPerson, id, 1)).rejects.toMatchObject({ code: "forbidden" });
    const file = await exportPackage(staff, id, 1);
    expect(file.filename).toBe(`${key}-v1.iacquire-blueprint.json`);
    const parsed = JSON.parse(file.json);
    expect(parsed).toMatchObject({ format: BLUEPRINT_FORMAT, schemaVersion: 1, integrity: { algorithm: "sha256" } });
    expect(parsed.integrity.digest).toBe((await listVersions(staff, id))[0].digest);
    expect(parsed.manifest.counts.tags).toBe(2);
    await expect(exportPackage(staff, id, 2)).rejects.toMatchObject({ code: "not_found" });

    const preview = await previewPackageImport(staff, file.json);
    expect(preview).toMatchObject({ status: "previewed", integrity: "valid", manifest: "valid", upgradedFrom: null, sourceKind: "package_file", blueprintId: null });
    expect(preview.validation.errors).toEqual([]);
    expect(preview.content).toEqual(await getVersionContent(staff, id, 1));
    expect(preview.report.summary.discovered).toBe(preview.report.items.length);
    expect(preview.report.items.find((i) => i.assetId === "calendar.estimates")?.status).toBe("needs_mapping");
    expect(preview.counts.discovered).toBe(preview.report.items.length);

    const saved = await saveImport(staff, preview.id, {});
    const bp = await getBlueprint(staff, saved.blueprintId);
    expect(bp).toMatchObject({ source: "file_import", status: "draft", key: `${key}-2`, sourceLabel: "Package file: Round Trip" });
    expect(bp.draft.assets).toEqual(preview.content!.assets);
    expect(bp.provenance.importId).toBe(preview.id);
    expect(bp.importReport?.summary.discovered).toBe(preview.report.summary.discovered);
    // Saving twice returns the same Blueprint; a saved import can't be discarded.
    expect((await saveImport(staff, preview.id, {})).blueprintId).toBe(saved.blueprintId);
    await expect(discardImport(staff, preview.id)).rejects.toMatchObject({ code: "conflict" });
    expect((await getImport(staff, preview.id))).toMatchObject({ status: "saved", blueprintId: saved.blueprintId });
    expect((await listImports(staff)).find((i) => i.id === preview.id)).toMatchObject({ status: "saved", sourceLabel: "Package file: Round Trip" });

    // Only some assets, with what they depend on, under other details.
    const second = await previewPackageImport(staff, file.json);
    const partial = await saveImport(staff, second.id, { name: "Just intake", key: `intake-${key}`, industry: "consulting", assetIds: ["workflow.form-intake"] });
    const p = await getBlueprint(staff, partial.blueprintId);
    expect(p).toMatchObject({ name: "Just intake", key: `intake-${key}`, industry: "consulting" });
    expect(p.draft.assets.calendars).toEqual([]);
    expect(p.draft.assets.forms.map((f) => f.id)).toEqual(["form.estimate-request"]);
    expect(p.draftErrors).toEqual([]);
    await expect(saveImport(staff, (await previewPackageImport(staff, file.json)).id, { assetIds: ["tag.unknown"] })).rejects.toMatchObject({ code: "invalid_input" });

    // Discarding keeps the history and drops the proposed content.
    const third = await previewPackageImport(staff, file.json);
    await discardImport(staff, third.id);
    const discarded = await getImport(staff, third.id);
    expect(discarded).toMatchObject({ status: "discarded", content: null });
    await expect(saveImport(staff, third.id, {})).rejects.toMatchObject({ code: "conflict" });
    await expect(getImport(staff, "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ code: "not_found" });
  });

  it("refuses tampered, malformed, oversize, unsafe, secret, customer-ID and newer-format packages", async () => {
    const { id } = await publishedBlueprint(`bad-${uid()}`, "Refusals");
    const file = await exportPackage(staff, id, 1);
    const errorCode = async (json: string) => {
      const p = await previewPackageImport(staff, json);
      expect(p.status).toBe("failed");
      expect(p.content).toBeNull();
      expect(p.error).toBeTruthy();
      const stored = await withSystem((db) => db.query<{ package: unknown; status: string }>("select package, status from crm_blueprint_imports where id = $1", [p.id]));
      expect(stored.rows[0]).toEqual({ package: null, status: "failed" });
      await expect(saveImport(staff, p.id, {})).rejects.toMatchObject({ code: "conflict" });
      return p.validation.errors.map((e) => e.code);
    };

    const tampered = JSON.parse(file.json);
    tampered.assets.tags[0].name = "Changed after export";
    expect(await errorCode(JSON.stringify(tampered))).toContain("integrity");
    expect(await errorCode("this is not json")).toContain("not_json");
    expect(await errorCode("[1, 2, 3]")).toContain("format");
    expect(await errorCode(JSON.stringify({ snapshot: "https://app.gohighlevel.com/snapshot/abc" }))).toContain("format");
    expect(await errorCode(" ".repeat(BLUEPRINT_MAX_BYTES + 10))).toContain("too_large");
    // Fewer characters than the limit, but more bytes: the size is checked in bytes before anything is parsed.
    const multibyte = JSON.stringify({ format: BLUEPRINT_FORMAT, schemaVersion: 1, pad: "é".repeat(Math.ceil(BLUEPRINT_MAX_BYTES / 2) + 10) });
    expect(multibyte.length).toBeLessThan(BLUEPRINT_MAX_BYTES);
    expect(await errorCode(multibyte)).toContain("too_large");

    const unsafe = content("unsafe", "Unsafe");
    unsafe.assets.tags[1].description = "<img src=x onerror=alert(1)>";
    expect(await errorCode(handPackage(unsafe))).toContain("unsafe");
    const secret = content("secret", "Secret");
    secret.assets.customValues[0].value = `${"sk_" + "live_"}${"Z".repeat(30)}`;
    expect(await errorCode(handPackage(secret))).toContain("secret");
    const dbId = content("dbid", "Database ID");
    dbId.assets.tags[1].description = "Copied from 3f2b1c4d-1111-4222-8333-444455556666";
    expect(await errorCode(handPackage(dbId))).toContain("database_id");
    const future = { ...content("future", "Future"), schemaVersion: 2 };
    expect(await errorCode(handPackage(future))).toContain("format");
    const strict = { ...content("strict", "Strict"), contacts: [{ email: "a@b.example" }] };
    expect(await errorCode(handPackage(strict))).toContain("schema");

    // A package without an integrity digest is accepted for review, with a warning saying so.
    const noDigest = await previewPackageImport(staff, JSON.stringify(content("nodigest", "No digest")));
    expect(noDigest).toMatchObject({ status: "previewed", integrity: "missing", manifest: "missing" });
    expect(noDigest.validation.warnings.map((w) => w.code)).toContain("integrity");
    expect(noDigest.report.limitations.join(" ")).toContain("no integrity digest");
    await expect(previewPackageImport(staff, 42 as unknown as string)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(previewPackageImport(clientPerson, file.json)).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("GoHighLevel imports", () => {
  it("are saved through the same flow by super admins and scoped to reachable clients", async () => {
    const ghlContent = content("ghl-roofing", "Roofing snapshot");
    ghlContent.assets.workflows.push({ id: "workflow.legacy", key: "legacy", name: "Legacy follow-up", description: null, folder: null, hourlyRunLimit: 500, placeholder: true, definition: { trigger: { type: "manual" }, steps: [] } });
    const report = reportForContent(ghlContent, ["Smart Lists cannot be listed through the GoHighLevel API."]);
    report.items.push({ sourceKind: "smart_list", name: "Hot leads (GHL)", status: "unsupported", assetId: null, assetType: null, placeholder: false, notes: ["No API."], requirements: [], missingDependencies: [] });
    report.summary.unsupported = 1;
    report.summary.discovered = report.items.length;
    const { sourceId, importId, clientImportId } = await withSystem(async (db) => {
      const src = await db.query<{ id: string }>("insert into crm_blueprint_ghl_sources (label, location_id, status) values ('Roofing template', $1, 'connected') returning id", [`TplLoc${uid()}${uid()}`.slice(0, 20)]);
      const imp = await db.query<{ id: string }>(
        `insert into crm_blueprint_imports (source_kind, ghl_source_id, source_label, status, report, package, created_by)
         values ('ghl_agency_source', $1, 'GoHighLevel: Roofing template', 'previewed', $2::jsonb, $3::jsonb, $4) returning id`,
        [src.rows[0].id, JSON.stringify(report), JSON.stringify(ghlContent), admin.id],
      );
      const org = await createOrgInTx(db);
      const cimp = await db.query<{ id: string }>(
        `insert into crm_blueprint_imports (source_kind, source_org_id, source_label, status, report, package, created_by)
         values ('ghl_client', $1, 'GoHighLevel: Unassigned client', 'previewed', $2::jsonb, $3::jsonb, $4) returning id`,
        [org, JSON.stringify(report), JSON.stringify(ghlContent), admin.id],
      );
      return { sourceId: src.rows[0].id, importId: imp.rows[0].id, clientImportId: cimp.rows[0].id };
    });
    expect(sourceId).toBeTruthy();

    // Staff can see an agency template import, but saving it reads GoHighLevel data: super admins only.
    expect((await getImport(staff, importId)).report.summary.unsupported).toBe(1);
    await expect(saveImport(staff, importId, {})).rejects.toMatchObject({ code: "forbidden" });
    await expect(discardImport(staff, importId)).rejects.toMatchObject({ code: "forbidden" });
    const saved = await saveImport(admin, importId, {});
    const bp = await getBlueprint(staff, saved.blueprintId);
    expect(bp).toMatchObject({ source: "ghl_import", sourceLabel: "GoHighLevel: Roofing template", status: "draft", compatibility: "partial" });
    expect(bp.compatibilityNotes.join(" ")).toContain("couldn't be brought over");
    expect(bp.compatibilityNotes.join(" ")).toContain("to rebuild or review");
    expect(bp.importReport?.limitations).toContain("Smart Lists cannot be listed through the GoHighLevel API.");
    expect((await listBlueprints(staff, { collection: "imported_ghl", search: "ghl-roofing" })).map((b) => b.id)).toContain(saved.blueprintId);
    expect((await listBlueprints(staff, { collection: "native", search: "ghl-roofing" })).map((b) => b.id)).not.toContain(saved.blueprintId);

    // An import from a client's own location is invisible to staff who aren't assigned to that client.
    expect((await listImports(staff)).map((i) => i.id)).not.toContain(clientImportId);
    expect((await listImports(admin)).map((i) => i.id)).toContain(clientImportId);
    await expect(getImport(staff, clientImportId)).rejects.toMatchObject({ code: "not_found" });
    await expect(saveImport(staff, clientImportId, {})).rejects.toMatchObject({ code: "not_found" });
    expect((await getImport(admin, clientImportId)).status).toBe("previewed");
  });
});

async function createOrgInTx(db: Queryable): Promise<string> {
  const { rows } = await db.query<{ id: string }>("insert into organizations (name, slug, kind, status) values ($1, $2, 'client', 'active') returning id", [`Hidden ${uid()}`, `hidden-${uid()}`]);
  return rows[0].id;
}

describe("applications", () => {
  it("are listed only for reachable clients, with the newest live one rollback-able", async () => {
    const a = await createOrg({ name: `Assigned ${uid()}` });
    const b = await createOrg({ name: `Unassigned ${uid()}` });
    const archivedOrg = await createOrg({ name: `Archived ${uid()}`, status: "archived" });
    await withSystem((db) => db.query("insert into staff_assignments (org_id, user_id) values ($1, $2)", [a.id, staff.id]));
    const key = `apps-${uid()}`;
    const { id, revision } = await publishedBlueprint(key, "Applied");
    const next = content(key, "Applied");
    next.assets.tags.push({ id: "tag.vip", name: "VIP", color: "#7c3aed", description: null, folder: null });
    const r = await saveDraft(admin, id, { content: next, revision });
    await publishBlueprint(admin, id, { revision: r.revision });

    const versions = await listVersions(admin, id);
    const vid = (n: number) => versions.find((v) => v.version === n)!.id;
    const insertApp = (orgId: string, version: number, minutesAgo: number, status = "applied") => withSystem(async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into crm_blueprint_applications (org_id, blueprint_id, version_id, version, blueprint_name, mode, strategy, status, plan_digest, idempotency_key,
                                                 requested_by, created_at, rolled_back_at)
         values ($1, $2, $3, $4, 'Applied', 'initial', 'add_missing', $5, $6, $7, $8, now() - make_interval(mins => $9), $10) returning id`,
        [orgId, id, vid(version), version, status, "a".repeat(64), `key-${uid()}-${uid()}`, admin.id, minutesAgo, status === "rolled_back" ? new Date() : null],
      );
      return rows[0].id;
    });
    const a1 = await insertApp(a.id, 1, 30);
    const a2 = await insertApp(a.id, 2, 10);
    const b1 = await insertApp(b.id, 1, 20);
    await insertApp(archivedOrg.id, 1, 5);
    await withSystem((db) => db.query(
      `insert into crm_blueprint_application_items (org_id, application_id, asset_id, asset_type, section, name, action, outcome, position)
       values ($1, $2, 'tag.vip', 'tag', 'tags', 'VIP', 'create', 'applied', 0), ($1, $2, 'tag.hot-lead', 'tag', 'tags', 'Hot lead', 'link', 'applied', 1)`,
      [a.id, a2],
    ));

    const staffApps = await listApplications(staff, { blueprintId: id });
    expect(staffApps.map((x) => x.id)).toEqual([a2, a1]);
    expect(staffApps[0]).toMatchObject({ orgName: a.name, version: 2, latestVersion: 2, canRollBack: true, counts: { create: 1, link: 1 }, requestedBy: "Agency Admin", status: "applied" });
    expect(staffApps[1]).toMatchObject({ canRollBack: false, counts: {} });
    const adminApps = await listApplications(admin, { blueprintId: id });
    expect(adminApps.map((x) => x.id)).toEqual(expect.arrayContaining([a2, a1, b1]));
    expect(adminApps.find((x) => x.id === b1)?.canRollBack).toBe(true);
    expect(await listApplications(staff, { orgId: b.id })).toEqual([]);
    expect(await listApplications(staff, { orgId: "nope" })).toEqual([]);

    // The card counts only workspaces the person can reach.
    const card = async (u: AgencyUser) => (await listBlueprints(u, { search: key })).find((x) => x.id === id)!.appliedTo;
    expect(await card(staff)).toBe(1);
    // An archived client is no longer a live workspace.
    expect(await card(admin)).toBe(2);

    // Clients on an older version can review the newer one; nothing is pushed.
    expect((await listUpdateCandidates(admin, id)).map((c) => c.orgId)).toEqual([b.id]);
    await withSystem((db) => db.query("update crm_blueprint_applications set status = 'rolled_back', rolled_back_at = now() where id = $1", [a2]));
    const afterRollback = await listApplications(staff, { blueprintId: id });
    expect(afterRollback.find((x) => x.id === a2)).toMatchObject({ canRollBack: false, status: "rolled_back" });
    expect(afterRollback.find((x) => x.id === a1)?.canRollBack).toBe(true);
    const candidates = await listUpdateCandidates(admin, id);
    expect(candidates.map((c) => c.orgId).sort()).toEqual([a.id, b.id].sort());
    expect(candidates[0]).toMatchObject({ appliedVersion: 1, latestVersion: 2, changedSections: ["tags"] });
    expect((await listUpdateCandidates(staff, id)).map((c) => c.orgId)).toEqual([a.id]);

    const staffClients = await listClientOptions(staff);
    expect(staffClients.map((c) => c.id)).toEqual([a.id]);
    expect(staffClients[0]).toMatchObject({ crmMode: "native", appliedBlueprints: [{ blueprintId: id, name: "Applied", version: 1 }] });
    const adminClients = await listClientOptions(admin);
    expect(adminClients.map((c) => c.id)).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(adminClients.map((c) => c.id)).not.toContain(archivedOrg.id);

    // A Blueprint captured from a client names that client only to people who can reach it.
    const captured = await withSystem((db) => insertBlueprint(db, admin, { content: content(`cap-${uid()}`, "Captured"), source: "native", sourceOrgId: b.id, sourceLabel: "Captured from a client" }));
    expect((await getBlueprint(admin, captured.id)).provenance.sourceOrgName).toBe(b.name);
    expect((await getBlueprint(staff, captured.id)).provenance.sourceOrgName).toBeNull();
    await expect(withSystem((db) => insertBlueprint(db, admin, { content: { ...content("unsafe-insert", "X"), assets: { ...content().assets, tags: [{ id: "tag.hot-lead", name: "<script>", color: "#000000", description: null, folder: null }] } }, source: "native" })))
      .rejects.toMatchObject({ code: "invalid_input" });
    await expect(withSystem((db) => insertBlueprint(db, admin, { content: content("starterless", "S"), source: "starter" }))).rejects.toMatchObject({ code: "invalid_input" });
  });
});
