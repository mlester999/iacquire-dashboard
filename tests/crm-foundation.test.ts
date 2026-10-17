import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { agencyActor, endSupportSession, startSupportSession } from "@/server/crm/actor";
import { assertNativeOwner, getWorkspace, loadWorkspace, resolveCapabilities } from "@/server/crm/workspace";
import { addContactIdentity, assignContacts, createContact, DuplicateContactError, eraseContact, findDuplicateCandidates, getContactDetail, linkContactCompany, mergeCrmContacts, setContactConsent, setContactsArchived, updateContact } from "@/server/crm/contacts";
import { createTag, deleteTag, listTags, mergeTags, tagContacts, updateTag } from "@/server/crm/tags";
import { createCustomField, listCustomFields, setRecordFields, updateCustomField } from "@/server/crm/fields";
import { countContacts, listContacts, listCompanies } from "@/server/crm/directory";
import { createSmartList, deleteSmartList, duplicateSmartList, listSmartLists, pinSmartList, setDefaultSmartList, updateSmartList } from "@/server/crm/smart-lists";
import { createCompany, getCompanyDetail, normalizeDomain, updateCompany } from "@/server/crm/companies";
import { addNote, deleteNote, editNote, listNotes } from "@/server/crm/notes";
import { getTimeline } from "@/server/crm/timeline";
import { effectivePermission, PERMISSION_MATRIX } from "@/lib/permissions";
import { updateAgencyUserPermission } from "@/server/admin/team";
import { coerceFieldValue } from "@/lib/crm/fields";
import { agencyPeople, crmOrg, eventsFor, type CrmOrg } from "./support/crm";
import { createUser, addMember } from "./support/fixtures";

let a: CrmOrg;
let b: CrmOrg;
let agency: Awaited<ReturnType<typeof agencyPeople>>;
let n = 0;
const email = (p = "lead") => `${p}-${Date.now()}-${++n}@example.test`;
const phone = () => `+63917${String(1000000 + ++n * 37).slice(-7)}`;

beforeAll(async () => {
  a = await crmOrg({ name: "Marko Bar" });
  b = await crmOrg({ name: "Aster Homes Test" });
  agency = await agencyPeople();
});

describe("workspace and provider ownership", () => {
  it("starts every new client on iAcquire Native CRM", async () => {
    const ws = await getWorkspace(a.actor("owner"));
    expect(ws.mode).toBe("native");
    expect(Object.values(ws.capabilities).every((p) => p === "native")).toBe(true);
    expect(ws.ghlConnected).toBe(false);
  });

  it("resolves each capability's single owner in hybrid mode and refuses native writes to a GoHighLevel-owned capability", async () => {
    expect(resolveCapabilities("hybrid", [{ capability: "contacts", provider: "ghl" }]).contacts).toBe("ghl");
    expect(resolveCapabilities("hybrid", []).pipelines).toBe("native");
    const c = await crmOrg();
    await withSystem((db) => db.query("update crm_workspaces set mode = 'ghl' where org_id = $1", [c.org.id]));
    await expect(createContact(c.actor("owner"), { firstName: "Blocked" })).rejects.toThrow(/managed in GoHighLevel/);
    await withSystem((db) => db.query("update crm_workspaces set mode = 'hybrid' where org_id = $1", [c.org.id]));
    await withSystem((db) => db.query("insert into crm_capability_providers (org_id, capability, provider) values ($1, 'tags', 'ghl')", [c.org.id]));
    await expect(createTag(c.actor("owner"), { name: "Nope" })).rejects.toThrow(/managed in GoHighLevel/);
    await expect(createContact(c.actor("owner"), { firstName: "Allowed" })).resolves.toMatchObject({ created: true });
    await expect(withSystem((db) => assertNativeOwner(db, c.org.id, "contacts"))).resolves.toBeUndefined();
  });

  it("creates the workspace on demand for an older client that has none", async () => {
    const c = await crmOrg();
    await withSystem((db) => db.query("delete from crm_workspaces where org_id = $1", [c.org.id]));
    const ws = await withSystem((db) => loadWorkspace(db, c.org.id));
    expect(ws.mode).toBe("native");
  });
});

describe("contacts", () => {
  it("normalizes identifiers, applies tags and fields, and records one event and one timeline entry", async () => {
    const vip = await createTag(a.actor("owner"), { name: "VIP" });
    await createCustomField(a.actor("owner"), { entity: "contact", label: "Budget", type: "currency" });
    const e = email();
    const r = await createContact(a.actor("sales"), { firstName: "Maria", lastName: "Santos", email: `  ${e.toUpperCase()} `, phone: "+63 917 555 0101", tagIds: [vip.id], customFields: { budget: "12,500.499" }, leadStatus: "qualified" });
    const d = await getContactDetail(a.actor("sales"), r.id);
    expect(d).toMatchObject({ displayName: "Maria Santos", email: e, phone: "+639175550101", leadStatus: "qualified", createdVia: "manual" });
    expect(d.tags.map((t) => t.name)).toEqual(["VIP"]);
    expect(d.fields.find((f) => f.key === "budget")?.value).toBe(12500.5);
    const created = await eventsFor(a.org.id, "contact.created");
    expect(created.filter((x) => x.entity_id === r.id)).toHaveLength(1);
    expect((await eventsFor(a.org.id, "contact.tag_added")).filter((x) => x.contact_id === r.id)).toHaveLength(1);
  });

  it("never creates a second contact for an address that already belongs to someone, and never matches by name", async () => {
    const e = email();
    const first = await createContact(a.actor("owner"), { firstName: "Ana", email: e });
    const dup = createContact(a.actor("owner"), { firstName: "Different Name", email: e.toUpperCase() });
    await expect(dup).rejects.toBeInstanceOf(DuplicateContactError);
    await expect(dup).rejects.toMatchObject({ existingContactId: first.id });
    const namesake = await createContact(a.actor("owner"), { firstName: "Ana", email: email() });
    expect(namesake.id).not.toBe(first.id);
  });

  it("refuses a local phone number without a country code instead of guessing one, unless the workspace sets a calling code", async () => {
    await expect(createContact(a.actor("owner"), { firstName: "Local", phone: "0917 555 0199" })).rejects.toThrow(/country code/);
    const c = await crmOrg();
    await withSystem((db) => db.query("update crm_workspaces set default_calling_code = '63' where org_id = $1", [c.org.id]));
    const r = await createContact(c.actor("owner"), { firstName: "Local", phone: "0917 555 0199" });
    expect((await getContactDetail(c.actor("owner"), r.id)).phone).toBe("+639175550199");
  });

  it("enforces role permissions on the server", async () => {
    await expect(createContact(a.actor("viewer"), { firstName: "No" })).rejects.toThrow(/role/);
    const mine = await createContact(a.actor("setter"), { firstName: "Setter Made" });
    expect(mine.created).toBe(true);
    await expect(createContact(a.actor("sales"), { firstName: "X", ownerId: a.people.support.id })).rejects.toThrow(/assign/);
    await expect(setContactsArchived(a.actor("support"), [mine.id], true)).rejects.toThrow(/archive/);
    await expect(assignContacts(a.actor("sales"), [mine.id], a.people.support.id)).rejects.toThrow(/assign/);
    await expect(assignContacts(a.actor("manager"), [mine.id], a.people.sales.id)).resolves.toEqual({ changed: 1 });
  });

  it("refuses to assign a contact to someone outside the workspace", async () => {
    const c = await createContact(a.actor("owner"), { firstName: "Owned" });
    await expect(assignContacts(a.actor("owner"), [c.id], b.people.sales.id)).rejects.toThrow(/teammate/);
  });

  it("rejects a stale edit instead of silently overwriting someone else's change", async () => {
    const c = await createContact(a.actor("owner"), { firstName: "Version", lastName: "One" });
    const d = await getContactDetail(a.actor("owner"), c.id);
    const first = await updateContact(a.actor("sales"), c.id, { lastName: "Two" }, d.version);
    expect(first.changed).toContain("lastName");
    await expect(updateContact(a.actor("support"), c.id, { city: "Cebu" }, d.version)).rejects.toThrow(/Someone else changed/);
    const after = await getContactDetail(a.actor("owner"), c.id);
    expect(after.displayName).toBe("Version Two");
    expect(after.version).toBe(d.version + 1);
  });

  it("keeps email unique across contacts when an address is added or changed", async () => {
    const e = email();
    const x = await createContact(a.actor("owner"), { firstName: "Has", email: e });
    const y = await createContact(a.actor("owner"), { firstName: "Wants" });
    await expect(addContactIdentity(a.actor("owner"), y.id, { kind: "email", value: e })).rejects.toBeInstanceOf(DuplicateContactError);
    await expect(updateContact(a.actor("owner"), y.id, { email: e })).rejects.toBeInstanceOf(DuplicateContactError);
    await addContactIdentity(a.actor("owner"), y.id, { kind: "phone", value: phone() });
    const d = await getContactDetail(a.actor("owner"), y.id);
    expect(d.identities).toHaveLength(1);
    expect(d.phone).toBe(d.identities[0].value);
    void x;
  });

  it("archives and restores without losing anything, and archived contacts leave the default list", async () => {
    const c = await createContact(a.actor("owner"), { firstName: "Archivable", email: email() });
    await setContactsArchived(a.actor("manager"), [c.id], true);
    const list = await listContacts(a.actor("owner"), { search: "archivable" });
    expect(list.rows.map((r) => r.id)).not.toContain(c.id);
    const archived = await listContacts(a.actor("owner"), { search: "archivable", archived: "only" });
    expect(archived.rows.map((r) => r.id)).toContain(c.id);
    await setContactsArchived(a.actor("manager"), [c.id], false);
    expect((await listContacts(a.actor("owner"), { search: "archivable" })).rows.map((r) => r.id)).toContain(c.id);
  });

  it("records consent only with evidence and only from owners and managers", async () => {
    const c = await createContact(a.actor("owner"), { firstName: "Consent", email: email() });
    await expect(setContactConsent(a.actor("sales"), c.id, { channel: "email", purpose: "marketing", status: "granted", evidence: "Signed form" })).rejects.toThrow(/owners and managers/);
    await expect(setContactConsent(a.actor("owner"), c.id, { channel: "email", purpose: "marketing", status: "granted", evidence: "" })).rejects.toThrow(/where this consent came from/);
    await setContactConsent(a.actor("owner"), c.id, { channel: "email", purpose: "marketing", status: "granted", evidence: "Signed intake form, 12 Oct" });
    const d = await getContactDetail(a.actor("owner"), c.id);
    expect(d.consent.find((x) => x.channel === "email" && x.purpose === "marketing")?.status).toBe("granted");
    expect(d.consent.find((x) => x.channel === "sms" && x.purpose === "marketing")?.status).toBe("unknown");
  });
});

describe("tags", () => {
  it("keeps names unique ignoring case, merges without losing assignments, and deletes cleanly", async () => {
    const hot = await createTag(a.actor("owner"), { name: "Hot lead", color: "#dc2626" });
    await expect(createTag(a.actor("owner"), { name: "HOT LEAD" })).rejects.toThrow(/already exists/);
    await expect(createTag(a.actor("sales"), { name: "Sales made" })).rejects.toThrow(/role/);
    const warm = await createTag(a.actor("owner"), { name: "Warm" });
    const c1 = await createContact(a.actor("owner"), { firstName: "T1" });
    const c2 = await createContact(a.actor("owner"), { firstName: "T2" });
    await expect(tagContacts(a.actor("sales"), { contactIds: [c1.id, c2.id], addTagIds: [warm.id] })).rejects.toThrow(/many contacts/);
    await tagContacts(a.actor("manager"), { contactIds: [c1.id, c2.id], addTagIds: [warm.id] });
    await tagContacts(a.actor("sales"), { contactIds: [c1.id], addTagIds: [hot.id] });
    // Re-applying the same tag does not create a second assignment or a second event.
    const again = await tagContacts(a.actor("sales"), { contactIds: [c1.id], addTagIds: [hot.id] });
    expect(again.added).toBe(0);
    await mergeTags(a.actor("owner"), { targetId: hot.id, sourceIds: [warm.id] });
    const d1 = await getContactDetail(a.actor("owner"), c1.id);
    const d2 = await getContactDetail(a.actor("owner"), c2.id);
    expect(d1.tags.map((t) => t.name)).toEqual(["Hot lead"]);
    expect(d2.tags.map((t) => t.name)).toEqual(["Hot lead"]);
    await updateTag(a.actor("owner"), hot.id, { name: "Hot" });
    expect((await listTags(a.actor("owner"))).find((t) => t.id === hot.id)).toMatchObject({ name: "Hot", contactCount: 2 });
    expect(await deleteTag(a.actor("owner"), hot.id)).toEqual({ removedFrom: 2 });
    expect((await getContactDetail(a.actor("owner"), c1.id)).tags).toEqual([]);
  });

  it("refuses another workspace's tag", async () => {
    const foreign = await createTag(b.actor("owner"), { name: "Foreign" });
    const c = await createContact(a.actor("owner"), { firstName: "Local" });
    await expect(tagContacts(a.actor("owner"), { contactIds: [c.id], addTagIds: [foreign.id] })).rejects.toThrow(/no longer exists/);
  });
});

describe("custom fields", () => {
  it("validates values by type and never guesses", async () => {
    const def = { id: "x", key: "tier", label: "Tier", type: "select" as const, options: [{ value: "gold", label: "Gold" }], required: false };
    expect(coerceFieldValue(def, "GOLD")).toMatchObject({ ok: true, display: "gold" });
    expect(coerceFieldValue(def, "Platinum")).toMatchObject({ ok: false });
    expect(coerceFieldValue({ ...def, type: "date" }, "2026-02-30")).toMatchObject({ ok: false });
    expect(coerceFieldValue({ ...def, type: "datetime" }, "2026-02-03T10:00:00")).toMatchObject({ ok: false });
    expect(coerceFieldValue({ ...def, type: "datetime" }, "2026-02-03T10:00:00+08:00")).toMatchObject({ ok: true, display: "2026-02-03T02:00:00.000Z" });
    expect(coerceFieldValue({ ...def, type: "boolean" }, "maybe")).toMatchObject({ ok: false });
    expect(coerceFieldValue({ ...def, type: "url" }, "example.com/x")).toMatchObject({ ok: true, display: "https://example.com/x" });
    expect(coerceFieldValue({ ...def, type: "phone" }, "0917 123 4567")).toMatchObject({ ok: false });
    expect(coerceFieldValue({ ...def, type: "phone" }, "0917 123 4567", { defaultCallingCode: "63" })).toMatchObject({ ok: true, display: "+639171234567" });
  });

  it("enforces required fields on manual entry, protects used choices, and locks the type once values exist", async () => {
    const c = await crmOrg();
    const svc = await createCustomField(c.actor("owner"), { entity: "contact", label: "Service", type: "multiselect", options: ["Haircut", "Color", "Styling"], required: true });
    await expect(createContact(c.actor("owner"), { firstName: "No Service" })).rejects.toThrow(/Service is required/);
    const r = await createContact(c.actor("owner"), { firstName: "With Service", customFields: { service: "haircut; Color" } });
    expect((await getContactDetail(c.actor("owner"), r.id)).fields[0].value).toEqual(["haircut", "color"]);
    await expect(setRecordFields(c.actor("owner"), "contact", r.id, { service: ["Massage"] })).rejects.toThrow(/not an option/);
    await expect(updateCustomField(c.actor("owner"), svc.id, { options: ["Haircut", "Styling"] })).rejects.toThrow(/still used/);
    await expect(updateCustomField(c.actor("owner"), svc.id, { type: "text" })).rejects.toThrow(/type can't change/);
    await updateCustomField(c.actor("owner"), svc.id, { options: ["Haircut", "Color", "Styling", "Shave"], label: "Services" });
    expect((await listCustomFields(c.actor("owner"), "contact"))[0]).toMatchObject({ label: "Services", valueCount: 1 });
    await expect(createCustomField(c.actor("sales"), { entity: "contact", label: "Sneaky", type: "text" })).rejects.toThrow(/role/);
  });

  it("the database itself refuses a value of the wrong type or for another tenant's record", async () => {
    const f = await createCustomField(a.actor("owner"), { entity: "contact", label: "Visits", type: "number" });
    const foreign = await createContact(b.actor("owner"), { firstName: "Foreign" });
    await expect(withSystem((db) => db.query("insert into crm_field_values (org_id, field_id, entity, entity_id, value_text) values ($1, $2, 'contact', $3, 'abc')", [a.org.id, f.id, foreign.id]))).rejects.toThrow();
    const local = await createContact(a.actor("owner"), { firstName: "Local" });
    await expect(withSystem((db) => db.query("insert into crm_field_values (org_id, field_id, entity, entity_id, value_text) values ($1, $2, 'contact', $3, 'abc')", [a.org.id, f.id, local.id]))).rejects.toThrow(/type_mismatch/);
    await expect(withSystem((db) => db.query("insert into crm_field_values (org_id, field_id, entity, entity_id, value_number) values ($1, $2, 'contact', $3, 3)", [a.org.id, f.id, foreign.id]))).rejects.toThrow(/record_mismatch/);
  });
});

describe("Smart Lists", () => {
  let s: CrmOrg;
  let ids: Record<string, string>;
  let tags: Record<string, string>;
  let tierId: string;
  beforeAll(async () => {
    s = await crmOrg({ timezone: "Asia/Manila" });
    tags = { new: (await createTag(s.actor("owner"), { name: "New lead" })).id, warm: (await createTag(s.actor("owner"), { name: "Warm" })).id, vip: (await createTag(s.actor("owner"), { name: "VIP" })).id };
    tierId = (await createCustomField(s.actor("owner"), { entity: "contact", label: "Tier", type: "select", options: ["Gold", "Silver"] })).id;
    ids = {
      ana: (await createContact(s.actor("owner"), { firstName: "Ana", lastName: "Reyes", email: email("ana"), tagIds: [tags.new], leadStatus: "new", ownerId: s.people.sales.id, customFields: { tier: "Gold" } })).id,
      ben: (await createContact(s.actor("owner"), { firstName: "Ben", lastName: "Cruz", phone: "+639171112222", tagIds: [tags.new, tags.warm], leadStatus: "contacted", leadScore: 80 })).id,
      cara: (await createContact(s.actor("owner"), { firstName: "Cara", lastName: "Lim", email: email("cara"), tagIds: [tags.vip], leadStatus: "customer", leadScore: 40, customFields: { tier: "Silver" } })).id,
      dan: (await createContact(s.actor("owner"), { firstName: "Dan", lastName: "O'Neil; drop table contacts; --", leadStatus: "qualified" })).id,
    };
    await withSystem((db) => db.query("update contacts set created_at = now() - interval '40 days' where id = $1", [ids.cara]));
  });
  const run = async (filter: unknown, who: Parameters<CrmOrg["actor"]>[0] = "owner") => (await listContacts(s.actor(who), { filter, pageSize: 100 })).rows.map((r) => r.id).sort();
  const expectIds = (keys: string[]) => keys.map((k) => ids[k]).sort();

  it("filters by tags (any, all, none), status, owner, score, dates, custom fields and nested OR groups", async () => {
    expect(await run({ op: "and", conditions: [{ field: "tags", op: "has_any", value: [tags.new] }] })).toEqual(expectIds(["ana", "ben"]));
    expect(await run({ op: "and", conditions: [{ field: "tags", op: "has_all", value: [tags.new, tags.warm] }] })).toEqual(expectIds(["ben"]));
    expect(await run({ op: "and", conditions: [{ field: "tags", op: "has_none", value: [tags.new, tags.vip] }] })).toEqual(expectIds(["dan"]));
    expect(await run({ op: "and", conditions: [{ field: "lead_status", op: "in", value: ["customer", "qualified"] }] })).toEqual(expectIds(["cara", "dan"]));
    expect(await run({ op: "and", conditions: [{ field: "owner", op: "is_unassigned" }] })).toEqual(expectIds(["ben", "cara", "dan"]));
    expect(await run({ op: "and", conditions: [{ field: "owner", op: "is_me" }] }, "sales")).toEqual(expectIds(["ana"]));
    expect(await run({ op: "and", conditions: [{ field: "lead_score", op: "gte", value: 50 }] })).toEqual(expectIds(["ben"]));
    expect(await run({ op: "and", conditions: [{ field: "created_at", op: "more_than_days_ago", value: 30 }] })).toEqual(expectIds(["cara"]));
    expect(await run({ op: "and", conditions: [{ field: `cf:${tierId}`, op: "in", value: ["gold"] }] })).toEqual(expectIds(["ana"]));
    expect(await run({ op: "and", conditions: [{ field: `cf:${tierId}`, op: "is_empty" }] })).toEqual(expectIds(["ben", "dan"]));
    expect(await run({ op: "or", conditions: [{ field: "phone", op: "contains", value: "1112" }, { op: "and", conditions: [{ field: "lead_status", op: "in", value: ["customer"] }, { field: "lead_score", op: "lt", value: 50 }] }] })).toEqual(expectIds(["ben", "cara"]));
    expect(await run({ op: "and", conditions: [{ field: "name", op: "contains", value: "drop table" }] })).toEqual(expectIds(["dan"]));
    expect(await run({ op: "and", conditions: [{ field: "name", op: "contains", value: "%" }] })).toEqual([]);
    expect(await run({ op: "and", conditions: [{ field: "consent", op: "is", value: { channel: "email", purpose: "marketing", status: "unknown" } }] })).toHaveLength(4);
  });

  it("treats values strictly as data: injection attempts, unknown fields and malformed filters are refused or matched literally", async () => {
    expect(await run({ op: "and", conditions: [{ field: "email", op: "equals", value: "' or '1'='1" }] })).toEqual([]);
    await expect(run({ op: "and", conditions: [{ field: "password_hash", op: "equals", value: "x" }] })).rejects.toThrow(/field/);
    await expect(run({ op: "and", conditions: [{ field: "lead_status", op: "contains", value: "x" }] })).rejects.toThrow(/can't be used/);
    await expect(run({ op: "and", conditions: [{ field: "lead_status", op: "in", value: ["new'); --"] }] })).rejects.toThrow(/not a valid/);
    await expect(run({ op: "and", conditions: [{ field: "tags", op: "has_any", value: ["not-a-uuid"] }] })).rejects.toThrow(/from the list/);
    const deep = { op: "and", conditions: [{ op: "and", conditions: [{ op: "and", conditions: [{ op: "and", conditions: [{ field: "name", op: "contains", value: "x" }] }] }] }] };
    await expect(run(deep)).rejects.toThrow(/nested/);
  });

  it("stays dynamic: a contact tagged later joins the saved list without the list being edited", async () => {
    const list = await createSmartList(s.actor("sales"), { name: "VIPs", filter: { op: "and", conditions: [{ field: "tags", op: "has_any", value: [tags.vip] }] } });
    expect((await listContacts(s.actor("sales"), { smartListId: list.id })).rows.map((r) => r.id)).toEqual([ids.cara]);
    await tagContacts(s.actor("owner"), { contactIds: [ids.dan], addTagIds: [tags.vip] });
    expect((await listContacts(s.actor("sales"), { smartListId: list.id })).rows.map((r) => r.id).sort()).toEqual(expectIds(["cara", "dan"]));
    expect(await countContacts(s.actor("sales"), { smartListId: list.id })).toBe(2);
  });

  it("keeps private lists private, needs permission to share, and copies are private", async () => {
    const mine = await createSmartList(s.actor("sales"), { name: "My hot list", filter: { op: "and", conditions: [] } });
    expect((await listSmartLists(s.actor("support"))).map((l) => l.id)).not.toContain(mine.id);
    await expect(listContacts(s.actor("support"), { smartListId: mine.id })).rejects.toThrow(/isn't shared/);
    await expect(createSmartList(s.actor("sales"), { name: "Team", visibility: "team", filter: { op: "and", conditions: [] } })).rejects.toThrow(/share/);
    await expect(updateSmartList(s.actor("sales"), mine.id, { visibility: "team" })).rejects.toThrow(/share/);
    const team = await createSmartList(s.actor("manager"), { name: "Everyone new", visibility: "team", filter: { op: "and", conditions: [{ field: "lead_status", op: "in", value: ["new"] }] } });
    expect((await listSmartLists(s.actor("support"))).map((l) => l.id)).toContain(team.id);
    await expect(updateSmartList(s.actor("support"), team.id, { name: "Renamed" })).rejects.toThrow(/share/);
    const copy = await duplicateSmartList(s.actor("support"), team.id);
    const support = await listSmartLists(s.actor("support"));
    expect(support.find((l) => l.id === copy.id)).toMatchObject({ visibility: "private", name: "Everyone new (copy)" });
    await pinSmartList(s.actor("support"), copy.id, true);
    expect((await listSmartLists(s.actor("support")))[0].id).toBe(copy.id);
    await expect(setDefaultSmartList(s.actor("manager"), mine.id)).rejects.toThrow();
    await setDefaultSmartList(s.actor("manager"), team.id);
    expect((await listSmartLists(s.actor("viewer"))).find((l) => l.id === team.id)?.isDefault).toBe(true);
    await deleteSmartList(s.actor("sales"), mine.id);
    expect((await listSmartLists(s.actor("sales"))).map((l) => l.id)).not.toContain(mine.id);
  });

  it("refuses to save a filter that does not compile", async () => {
    await expect(createSmartList(s.actor("owner"), { name: "Broken", filter: { op: "and", conditions: [{ field: "cf:00000000-0000-4000-8000-000000000000", op: "is_empty" }] } })).rejects.toThrow(/no longer exists/);
  });
});

describe("companies", () => {
  it("normalizes domains, refuses a duplicate domain, links people, and filters", async () => {
    expect(normalizeDomain("https://www.Example.com/about")).toBe("example.com");
    expect(normalizeDomain("not a domain")).toBeNull();
    const co = await createCompany(a.actor("sales"), { name: "Lakeside Dental", website: "https://www.lakeside-dental.test", industry: "Dental" });
    await expect(createCompany(a.actor("owner"), { name: "Copy", domain: "lakeside-dental.test" })).rejects.toThrow(/already uses/);
    const p = await createContact(a.actor("sales"), { firstName: "Dr", lastName: "Lake", companyId: co.id, companyTitle: "Dentist" });
    const p2 = await createContact(a.actor("sales"), { firstName: "Front", lastName: "Desk" });
    await linkContactCompany(a.actor("sales"), { contactId: p2.id, companyId: co.id, title: "Reception" });
    const d = await getCompanyDetail(a.actor("viewer"), co.id);
    expect(d.contacts.map((c) => c.title).sort()).toEqual(["Dentist", "Reception"]);
    expect((await getContactDetail(a.actor("sales"), p.id)).companies[0]).toMatchObject({ name: "Lakeside Dental", isPrimary: true });
    const v = await updateCompany(a.actor("sales"), co.id, { city: "Lucena" }, d.version);
    await expect(updateCompany(a.actor("sales"), co.id, { city: "Stale" }, d.version)).rejects.toThrow(/Someone else/);
    expect(v.version).toBe(d.version + 1);
    const list = await listCompanies(a.actor("owner"), { filter: { op: "and", conditions: [{ field: "industry", op: "equals", value: "dental" }] } });
    expect(list.rows.map((r) => r.id)).toContain(co.id);
    expect(list.rows.find((r) => r.id === co.id)?.contactCount).toBe(2);
    const people = await listContacts(a.actor("owner"), { filter: { op: "and", conditions: [{ field: "company", op: "is_any_of", value: [co.id] }] } });
    expect(people.total).toBe(2);
  });

  it("works for businesses that never use companies", async () => {
    const c = await crmOrg();
    const r = await createContact(c.actor("owner"), { firstName: "Walk-in", phone: phone() });
    expect((await getContactDetail(c.actor("owner"), r.id)).companies).toEqual([]);
  });
});

describe("notes and timeline", () => {
  it("lets authors manage their notes, managers tidy any, and shows only recorded events on the timeline", async () => {
    const c = await createContact(a.actor("owner"), { firstName: "Timeline", email: email() });
    const note = await addNote(a.actor("sales"), "contact", c.id, "Prefers mornings.");
    await expect(addNote(a.actor("viewer"), "contact", c.id, "Viewer note")).rejects.toThrow(/role/);
    await expect(editNote(a.actor("support"), note.id, "Hijack")).rejects.toThrow(/own notes/);
    await editNote(a.actor("sales"), note.id, "Prefers mornings, not Mondays.");
    expect((await listNotes(a.actor("viewer"), "contact", c.id))[0].body).toBe("Prefers mornings, not Mondays.");
    await updateContact(a.actor("owner"), c.id, { leadStatus: "contacted" });
    const t = await getTimeline(a.actor("viewer"), { contactId: c.id });
    expect(t.items.map((i) => i.kind)).toEqual(expect.arrayContaining(["note", "contact.status_changed", "contact.created"]));
    expect(t.items.every((i) => !/@example\.test/.test(i.title))).toBe(true);
    await deleteNote(a.actor("manager"), note.id);
    expect(await listNotes(a.actor("viewer"), "contact", c.id)).toEqual([]);
  });
});

describe("merge, duplicates and privacy erasure", () => {
  it("suggests same-name duplicates for review only, and a merge carries tags, fields, companies, notes and history", async () => {
    const c = await crmOrg();
    const tag = await createTag(c.actor("owner"), { name: "Merged tag" });
    const f = await createCustomField(c.actor("owner"), { entity: "contact", label: "Notes code", type: "text" });
    const co = await createCompany(c.actor("owner"), { name: "Same Co" });
    const kept = await createContact(c.actor("owner"), { firstName: "Jose", lastName: "Rizal", email: email() });
    const other = await createContact(c.actor("owner"), { firstName: "Jose", lastName: "Rizal", phone: phone(), tagIds: [tag.id], customFields: { [f.key]: "abc" }, companyId: co.id });
    await addNote(c.actor("owner"), "contact", other.id, "Called from the second number.");
    const groups = await findDuplicateCandidates(c.actor("owner"));
    expect(groups[0].contacts.map((x) => x.id).sort()).toEqual([kept.id, other.id].sort());
    await expect(mergeCrmContacts(c.actor("sales"), { keptId: kept.id, mergedId: other.id, reason: "Same person" })).rejects.toThrow(/merge/);
    await mergeCrmContacts(c.actor("manager"), { keptId: kept.id, mergedId: other.id, reason: "Same person, confirmed by phone" });
    const d = await getContactDetail(c.actor("owner"), kept.id);
    expect(d.tags.map((t) => t.name)).toEqual(["Merged tag"]);
    expect(d.fields.find((x) => x.key === f.key)?.value).toBe("abc");
    expect(d.companies.map((x) => x.name)).toEqual(["Same Co"]);
    expect(d.identities).toHaveLength(2);
    const t = await getTimeline(c.actor("owner"), { contactId: kept.id });
    // The merged record's own creation is still on the kept person's timeline, and so is the note.
    expect(t.items.filter((i) => i.kind === "contact.created")).toHaveLength(2);
    expect(t.items.some((i) => i.source === "note")).toBe(true);
    await expect(getContactDetail(c.actor("owner"), other.id)).rejects.toThrow(/not found/);
  });

  it("erases personal and CRM details on a privacy request but keeps the audit trail", async () => {
    const tag = await createTag(a.actor("owner"), { name: `Erase ${Date.now()}` });
    const f = await createCustomField(a.actor("owner"), { entity: "contact", label: `Secret ${Date.now()}`, type: "text" });
    const c = await createContact(a.actor("owner"), { firstName: "Private", lastName: "Person", email: email(), tagIds: [tag.id], customFields: { [f.key]: "sensitive" }, city: "Makati" });
    await expect(eraseContact(a.actor("sales"), c.id, "Customer asked")).rejects.toThrow();
    await eraseContact(a.actor("owner"), c.id, "Customer asked by email");
    const row = await withSystem((db) => db.query<{ display_name: string; city: string | null; email: string | null }>("select display_name, city, email from contacts where id = $1", [c.id]));
    expect(row.rows[0]).toEqual({ display_name: "Removed contact", city: null, email: null });
    const left = await withSystem((db) => db.query("select 1 from crm_field_values where entity_id = $1 union all select 1 from crm_contact_tags where contact_id = $1", [c.id]));
    expect(left.rows).toHaveLength(0);
    const audit = await withSystem((db) => db.query("select 1 from audit_logs where action = 'contact.redacted' and target_id = $1", [c.id]));
    expect(audit.rows).toHaveLength(1);
  });
});

describe("tenant isolation", () => {
  it("never reaches another client's records by id, list, search, saved list, tag or company", async () => {
    const secret = await createContact(b.actor("owner"), { firstName: "Bravo", lastName: "Secret", email: email("bravo") });
    const bList = await createSmartList(b.actor("manager"), { name: "B team list", visibility: "team", filter: { op: "and", conditions: [] } });
    const bCo = await createCompany(b.actor("owner"), { name: "Bravo Corp" });
    await expect(getContactDetail(a.actor("owner"), secret.id)).rejects.toThrow(/not found/);
    await expect(updateContact(a.actor("owner"), secret.id, { city: "Hacked" })).rejects.toThrow(/not found/);
    await expect(assignContacts(a.actor("owner"), [secret.id], a.people.owner.id)).resolves.toEqual({ changed: 0 });
    await expect(setContactsArchived(a.actor("owner"), [secret.id], true)).resolves.toEqual({ changed: 0 });
    await expect(addNote(a.actor("owner"), "contact", secret.id, "x")).rejects.toThrow(/not found/);
    await expect(getTimeline(a.actor("owner"), { contactId: secret.id })).rejects.toThrow(/not found/);
    await expect(listContacts(a.actor("owner"), { smartListId: bList.id })).rejects.toThrow(/isn't shared/);
    await expect(getCompanyDetail(a.actor("owner"), bCo.id)).rejects.toThrow(/not found/);
    await expect(linkContactCompany(a.actor("owner"), { contactId: (await createContact(a.actor("owner"), { firstName: "Ax" })).id, companyId: bCo.id })).rejects.toThrow(/not found/);
    const search = await listContacts(a.actor("owner"), { search: "bravo" });
    expect(search.rows.map((r) => r.id)).not.toContain(secret.id);
    await expect(mergeCrmContacts(a.actor("owner"), { keptId: (await createContact(a.actor("owner"), { firstName: "K" })).id, mergedId: secret.id, reason: "cross tenant try" })).rejects.toThrow(/not found/);
  });

  it("row-level security hides other tenants' CRM rows even from a query with no organization filter", async () => {
    await createContact(b.actor("owner"), { firstName: "Hidden", email: email() });
    await createTag(b.actor("owner"), { name: `B only ${Date.now()}` });
    const seen = await withUser(a.people.viewer.id, async (db) => ({
      contacts: (await db.query<{ org_id: string }>("select org_id from contacts")).rows,
      tags: (await db.query<{ org_id: string }>("select org_id from crm_tags")).rows,
      fields: (await db.query<{ org_id: string }>("select org_id from crm_field_values")).rows,
      lists: (await db.query<{ org_id: string }>("select org_id from crm_smart_lists")).rows,
      events: (await db.query<{ org_id: string }>("select org_id from crm_events")).rows,
    }));
    for (const rows of Object.values(seen)) expect(rows.every((r) => r.org_id === a.org.id)).toBe(true);
    // A viewer cannot read the event outbox at all (it needs workflows.view).
    expect(seen.events).toHaveLength(0);
  });

  it("RLS also refuses writes from the application role", async () => {
    await expect(withUser(a.people.owner.id, (db) => db.query("insert into crm_tags (org_id, name) values ($1, 'direct')", [a.org.id]))).rejects.toThrow();
    await expect(withUser(a.people.owner.id, (db) => db.query("update contacts set city = 'x' where org_id = $1", [a.org.id]))).rejects.toThrow();
  });
});

describe("agency support access", () => {
  it("requires assignment and an active, reasoned session; read sessions cannot change anything; only super admins can write", async () => {
    await expect(agencyActor(agency.staff, a.org.id)).rejects.toThrow(/not assigned/);
    await expect(startSupportSession(agency.staff, a.org.id, { mode: "read", reason: "Checking imports" })).rejects.toThrow(/not assigned/);
    await withSystem((db) => db.query("insert into staff_assignments (org_id, user_id) values ($1, $2)", [a.org.id, agency.staff.id]));
    await expect(agencyActor(agency.staff, a.org.id)).rejects.toThrow(/support session/);
    await expect(startSupportSession(agency.staff, a.org.id, { mode: "write", reason: "Fixing data" })).rejects.toThrow(/super admins/);
    const beforeSupport = await withUser(agency.staff.id, (db) => db.query("select id from contacts where org_id=$1", [a.org.id]));
    expect(beforeSupport.rows).toHaveLength(0);
    await expect(startSupportSession(agency.staff, a.org.id, { mode: "read", reason: "x" })).rejects.toThrow(/why/);
    await startSupportSession(agency.staff, a.org.id, { mode: "read", reason: "Client asked why a lead is missing" });
    const duringSupport = await withUser(agency.staff.id, (db) => db.query("select id from contacts where org_id=$1", [a.org.id]));
    expect(duringSupport.rows.length).toBeGreaterThan(0);
    const reader = await agencyActor(agency.staff, a.org.id);
    expect(reader.supportMode).toBe("read");
    const page = await listContacts(reader, { pageSize: 5 });
    expect(page.total).toBeGreaterThan(0);
    await expect(createContact(reader, { firstName: "Agency" })).rejects.toThrow(/read-only/);
    await expect(createTag(reader, { name: "Agency tag" })).rejects.toThrow(/read-only/);
    // Agency staff are never given export rights in a support session.
    expect(reader.can("contacts.export")).toBe(false);
    await expect(agencyActor(agency.staff, b.org.id)).rejects.toThrow(/not assigned/);

    await updateAgencyUserPermission(agency.superAdmin, { userId: agency.staff.id, permission: "agency.crm.manage", effect: "allow" });
    await updateAgencyUserPermission(agency.superAdmin, { userId: agency.staff.id, permission: "tags.manage", effect: "allow" });
    await startSupportSession(agency.staff, a.org.id, { mode: "write", reason: "Client approved a focused tag cleanup" });
    const delegatedWriter = await agencyActor(agency.staff, a.org.id);
    expect(delegatedWriter.supportMode).toBe("write");
    expect(delegatedWriter.can("tags.manage")).toBe(true);
    expect(delegatedWriter.can("contacts.export")).toBe(false);
    await expect(createTag(delegatedWriter, { name: "Delegated support tag" })).resolves.toMatchObject({ id: expect.any(String) });
    await endSupportSession(agency.staff, a.org.id);

    await startSupportSession(agency.superAdmin, a.org.id, { mode: "write", reason: "Client asked us to clean up tags" });
    const writer = await agencyActor(agency.superAdmin, a.org.id);
    expect(writer.supportMode).toBe("write");
    const made = await createTag(writer, { name: `Agency cleanup ${Date.now()}` });
    expect(made.id).toBeTruthy();
    expect(writer.can("contacts.export")).toBe(false);
    expect(writer.can("contacts.delete")).toBe(false);
    const notified = await withSystem((db) => db.query("select 1 from notifications where org_id = $1 and kind = 'crm_support_access'", [a.org.id]));
    expect(notified.rows.length).toBeGreaterThan(0);
    const owner = await withUser(a.people.owner.id, (db) => db.query<{ reason: string }>("select reason from crm_support_sessions where org_id = $1", [a.org.id]));
    expect(owner.rows.map((r) => r.reason)).toEqual(expect.arrayContaining(["Client asked why a lead is missing", "Client asked us to clean up tags"]));
    await endSupportSession(agency.superAdmin, a.org.id);
    await expect(agencyActor(agency.superAdmin, a.org.id)).rejects.toThrow(/support session/);
    const audit = await withSystem((db) => db.query<{ action: string }>("select action from audit_logs where org_id = $1 and action like 'crm.support_session%'", [a.org.id]));
    expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(["crm.support_session_started", "crm.support_session_ended"]));
  });

  it("an expired session grants nothing", async () => {
    const c = await crmOrg();
    await startSupportSession(agency.superAdmin, c.org.id, { mode: "read", reason: "Short look" });
    await withSystem((db) => db.query("update crm_support_sessions set started_at = now() - interval '2 hours', expires_at = now() - interval '1 minute' where org_id = $1", [c.org.id]));
    await expect(agencyActor(agency.superAdmin, c.org.id)).rejects.toThrow(/support session/);
  });
});

describe("granular permissions", () => {
  it("per-person overrides apply in code and in the database, never to owners or protected permissions", async () => {
    const c = await crmOrg();
    expect(effectivePermission("sales_rep", "contacts.export", {})).toBe(false);
    expect(effectivePermission("sales_rep", "contacts.export", { "contacts.export": "grant" })).toBe(true);
    expect(effectivePermission("admin", "contacts.export", { "contacts.export": "revoke" })).toBe(false);
    expect(effectivePermission("owner", "contacts.export", { "contacts.export": "revoke" })).toBe(true);
    // A non-delegable permission ignores overrides entirely.
    expect(effectivePermission("sales_rep", "billing.view", { "billing.view": "grant" } as never)).toBe(false);
    await withSystem((db) => db.query("insert into member_permission_overrides (org_id, user_id, permission, effect) values ($1, $2, 'contacts.export', 'grant')", [c.org.id, c.people.sales.id]));
    const can = await withUser(c.people.sales.id, (db) => db.query<{ ok: boolean }>("select app.has_permission($1, 'contacts.export') as ok", [c.org.id]));
    expect(can.rows[0].ok).toBe(true);
    await withSystem((db) => db.query("insert into member_permission_overrides (org_id, user_id, permission, effect) values ($1, $2, 'contacts.view', 'revoke')", [c.org.id, c.people.viewer.id]));
    const viewerSees = await withUser(c.people.viewer.id, (db) => db.query("select 1 from contacts where org_id = $1", [c.org.id]));
    expect(viewerSees.rows).toHaveLength(0);
    await expect(withSystem((db) => db.query("insert into member_permission_overrides (org_id, user_id, permission, effect) values ($1, $2, 'contacts.export', 'revoke')", [c.org.id, c.people.owner.id]))).rejects.toThrow(/owner/);
    await expect(withSystem((db) => db.query("insert into member_permission_overrides (org_id, user_id, permission, effect) values ($1, $2, 'billing.view', 'grant')", [c.org.id, c.people.sales.id]))).rejects.toThrow();
  });

  it("the new Appointment Setter role exists in code and in the database", async () => {
    expect(PERMISSION_MATRIX["appointments.book"]).toContain("appointment_setter");
    const u = await createUser();
    const c = await crmOrg();
    await addMember(c.org.id, u.id, "appointment_setter");
    const can = await withUser(u.id, (db) => db.query<{ book: boolean; merge: boolean }>("select app.has_permission($1, 'appointments.book') as book, app.has_permission($1, 'contacts.merge') as merge", [c.org.id]));
    expect(can.rows[0]).toEqual({ book: true, merge: false });
  });
});
