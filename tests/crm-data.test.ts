import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { advanceImport, advanceImportFor, cancelImport, countryCode, createImportJob, getImportJob, processImports, rollbackImport, startImport, startValidation, suggestMapping } from "@/server/crm/imports";
import { exportContactsCsv } from "@/server/crm/exports";
import { createContact, getContactDetail } from "@/server/crm/contacts";
import { createTag } from "@/server/crm/tags";
import { createCustomField } from "@/server/crm/fields";
import { listContacts } from "@/server/crm/directory";
import { createSmartList } from "@/server/crm/smart-lists";
import { listMemberAccess, setPermissionOverride } from "@/server/crm/permissions";
import { agencyActor, startSupportSession } from "@/server/crm/actor";
import { buildExport } from "@/server/offboarding/export";
import { csvCell, parseCsv } from "@/lib/crm/csv";
import { agencyPeople, crmOrg, type CrmOrg } from "./support/crm";

let a: CrmOrg;
let b: CrmOrg;
beforeAll(async () => {
  a = await crmOrg({ name: "Import Co" });
  b = await crmOrg({ name: "Other Import Co" });
});

async function drain(jobId: string) {
  for (let i = 0; i < 50; i++) {
    const r = await advanceImport(jobId);
    if (r.done) return r.status;
  }
  throw new Error("import did not finish");
}

describe("CSV", () => {
  it("parses quotes, embedded newlines and commas, CRLF, a BOM, and semicolon files", () => {
    const p = parseCsv('﻿Name,Notes\r\n"Santos, Maria","Line one\nline ""two"""\r\n,\r\nBen,x\r\n');
    expect(p.headers).toEqual(["Name", "Notes"]);
    expect(p.rows).toEqual([["Santos, Maria", 'Line one\nline "two"'], ["Ben", "x"]]);
    expect(parseCsv("a;b\n1;2\n").rows).toEqual([["1", "2"]]);
    expect(() => parseCsv('a\n"unterminated')).toThrow(/quoted/);
    expect(() => parseCsv("a\n1\n2\n3", { maxRows: 2 })).toThrow(/more than 2 rows/);
  });

  it("neutralizes spreadsheet formulas in exported cells", () => {
    expect(csvCell("=HYPERLINK(\"http://x\")")).toBe("\"'=HYPERLINK(\"\"http://x\"\")\"");
    expect(csvCell("+639171234567")).toBe("'+639171234567");
    expect(csvCell("plain")).toBe("plain");
  });

  it("maps country names to codes using the runtime's own region names", () => {
    expect(countryCode("Philippines")).toBe("PH");
    expect(countryCode("united states")).toBe("US");
    expect(countryCode("ph")).toBe("PH");
    expect(countryCode("Atlantis")).toBeNull();
  });
});

describe("contact import", () => {
  it("suggests a mapping, dry-runs without changing anything, imports, and reports every row honestly", async () => {
    const existing = await createContact(a.actor("owner"), { firstName: "Existing", email: "existing@example.test", city: "Cebu" });
    await createCustomField(a.actor("owner"), { entity: "contact", label: "Membership", type: "select", options: ["Gold", "Silver"] });
    const csv = [
      "Full Name,E-mail,Phone,Company,Tags,Membership,Country,Status,ID",
      "Ana Reyes,ana@example.test,+63 917 000 0001,Reyes Bakery,VIP; Walk-in,Gold,Philippines,Qualified,A1",
      "Existing Person,EXISTING@example.test,,,Returning,,PH,,A2",
      "Bad Phone,bad@example.test,0917 000,,,,,,A3",
      "Ana Again,ana@example.test,,,,,,,A4",
      "No Membership,nom@example.test,,,,Platinum,,,A5",
      ",,,,,,,,A6",
      "Ben Cruz,ben@example.test,+63 917 000 0002,Reyes Bakery,,Silver,Atlantis,,A7",
    ].join("\n");
    const up = await createImportJob(a.actor("manager"), { entity: "contact", fileName: "leads.csv", csv });
    expect(up.job.totalRows).toBe(7);
    expect(up.suggested).toMatchObject({ "Full Name": "name", "E-mail": "email", Phone: "phone", Company: "company", Tags: "tags", Membership: "cf:membership", Country: "country", Status: "lead_status", ID: "external_id" });
    const before = (await listContacts(a.actor("owner"))).total;
    await startValidation(a.actor("manager"), up.job.id, { mapping: up.suggested, options: { duplicates: "update" } });
    expect(await drain(up.job.id)).toBe("validated");
    expect((await listContacts(a.actor("owner"))).total).toBe(before);
    const dry = await getImportJob(a.actor("manager"), up.job.id);
    expect(dry.summary).toMatchObject({ create: 1, update: 1, invalid: 4, duplicateInFile: 1 });
    expect(dry.problems.find((p) => p.row === 3)?.errors.join(" ")).toMatch(/country code/);
    expect(dry.problems.find((p) => p.row === 4)?.errors.join(" ")).toMatch(/row 1/);
    expect(dry.problems.find((p) => p.row === 5)?.errors.join(" ")).toMatch(/one of: Gold, Silver/);
    expect(dry.problems.find((p) => p.row === 7)?.errors.join(" ")).toMatch(/Atlantis/);

    await startImport(a.actor("manager"), up.job.id);
    await startImport(a.actor("manager"), up.job.id); // a double click starts it once
    expect(await drain(up.job.id)).toBe("completed");
    const done = await getImportJob(a.actor("manager"), up.job.id);
    expect(done.summary).toMatchObject({ created: 1, updated: 1 });
    const ana = (await listContacts(a.actor("owner"), { search: "ana@example.test" })).rows[0];
    const d = await getContactDetail(a.actor("owner"), ana.id);
    expect(d).toMatchObject({ displayName: "Ana Reyes", phone: "+639170000001", country: "PH", leadStatus: "qualified", createdVia: "import" });
    expect(d.tags.map((t) => t.name).sort()).toEqual(["VIP", "Walk-in"]);
    expect(d.companies[0].name).toBe("Reyes Bakery");
    expect(d.fields.find((f) => f.key === "membership")?.value).toBe("gold");
    const ex = await getContactDetail(a.actor("owner"), existing.id);
    expect(ex.city).toBe("Cebu"); // never blanked
    expect(ex.tags.map((t) => t.name)).toEqual(["Returning"]);
    const notified = await withSystem((db) => db.query("select 1 from notifications where user_id = $1 and kind = 'crm_import_finished'", [a.people.manager.id]));
    expect(notified.rows).toHaveLength(1);

    // Undo: the created contact goes, the updated one gets its tag removed, the existing record stays.
    await rollbackImport(a.actor("manager"), up.job.id);
    expect(await drain(up.job.id)).toBe("rolled_back");
    expect((await listContacts(a.actor("owner"), { search: "ana@example.test" })).total).toBe(0);
    expect((await getContactDetail(a.actor("owner"), existing.id)).tags).toEqual([]);
  });

  it("re-running the same file with IDs from the old system updates instead of duplicating", async () => {
    const csv = "Name,Email,ID\nRe Run,rerun@example.test,X1\n";
    for (const n of [1, 2]) {
      const up = await createImportJob(a.actor("owner"), { entity: "contact", fileName: `run${n}.csv`, csv });
      await startValidation(a.actor("owner"), up.job.id, { mapping: { Name: "name", Email: "email", ID: "external_id" }, options: { duplicates: "update" } });
      await drain(up.job.id);
      await startImport(a.actor("owner"), up.job.id);
      await drain(up.job.id);
    }
    expect((await listContacts(a.actor("owner"), { search: "rerun@example.test" })).total).toBe(1);
  });

  it("keeps a record someone changed after the import when undoing it", async () => {
    const up = await createImportJob(a.actor("owner"), { entity: "contact", fileName: "x.csv", csv: "Name,Email\nKeep Me,keepme@example.test\n" });
    await startValidation(a.actor("owner"), up.job.id, { mapping: { Name: "name", Email: "email" } });
    await drain(up.job.id);
    await startImport(a.actor("owner"), up.job.id);
    await drain(up.job.id);
    const id = (await listContacts(a.actor("owner"), { search: "keepme@example.test" })).rows[0].id;
    const { updateContact } = await import("@/server/crm/contacts");
    await updateContact(a.actor("owner"), id, { city: "Davao" });
    await rollbackImport(a.actor("owner"), up.job.id);
    await drain(up.job.id);
    expect((await getContactDetail(a.actor("owner"), id)).city).toBe("Davao");
    expect((await getImportJob(a.actor("owner"), up.job.id)).summary.keptChanged).toBe(1);
  });

  it("needs import permission, refuses unknown mappings, and never touches another workspace's import", async () => {
    await expect(createImportJob(a.actor("sales"), { entity: "contact", fileName: "x.csv", csv: "Name\nX\n" })).rejects.toThrow(/role/);
    const up = await createImportJob(a.actor("owner"), { entity: "contact", fileName: "x.csv", csv: "Name,Secret\nX,y\n" });
    await expect(startValidation(a.actor("owner"), up.job.id, { mapping: { Name: "name", Secret: "password_hash" } })).rejects.toThrow(/doesn't exist/);
    await expect(startValidation(a.actor("owner"), up.job.id, { mapping: { Name: "email", Secret: "email" } })).rejects.toThrow(/same field/);
    await expect(getImportJob(b.actor("owner"), up.job.id)).rejects.toThrow(/not found/);
    await expect(advanceImportFor(b.actor("owner"), up.job.id)).rejects.toThrow(/not found/);
    await cancelImport(a.actor("owner"), up.job.id);
    expect((await processImports()).advanced).toBeGreaterThanOrEqual(0);
  });

  it("lets only owners and managers create new tags during an import", async () => {
    const c = await crmOrg();
    await c.actor("owner"); // ensure fixture
    await withSystem((db) => db.query("insert into member_permission_overrides (org_id, user_id, permission, effect) values ($1, $2, 'contacts.import', 'grant')", [c.org.id, c.people.sales.id]));
    const { memberActor } = await import("@/server/crm/actor");
    const { ctxFor } = await import("./support/fixtures");
    const ctx = ctxFor(c.people.sales, c.org, "sales_rep");
    const salesWithImport = memberActor({ ...ctx, can: (p) => p === "contacts.import" || ctx.can(p) });
    const up = await createImportJob(salesWithImport, { entity: "contact", fileName: "x.csv", csv: "Name\nX\n" });
    await expect(startValidation(salesWithImport, up.job.id, { mapping: { Name: "name" }, options: { tagAll: ["Brand new tag"] } })).rejects.toThrow(/existing tags/);
  });

  it("imports companies, de-duplicating by domain", async () => {
    const up = await createImportJob(a.actor("owner"), { entity: "company", fileName: "c.csv", csv: "Company,Website,Industry\nHarbor Dental,https://www.harbor.test,Dental\nHarbor Copy,harbor.test,Dental\n" });
    expect(suggestMapping("company", up.job.headers, [])).toMatchObject({ Company: "name", Website: "website", Industry: "industry" });
    await startValidation(a.actor("owner"), up.job.id, { mapping: up.suggested });
    await drain(up.job.id);
    expect((await getImportJob(a.actor("owner"), up.job.id)).summary).toMatchObject({ create: 1, duplicateInFile: 1 });
    await startImport(a.actor("owner"), up.job.id);
    expect(await drain(up.job.id)).toBe("completed");
  });
});

describe("contact export", () => {
  it("exports exactly the matching contacts with custom fields and safe cells, and records the export", async () => {
    const c = await crmOrg();
    const tag = await createTag(c.actor("owner"), { name: "Export me" });
    await createCustomField(c.actor("owner"), { entity: "contact", label: "Plan", type: "select", options: ["Basic", "Pro"] });
    await createContact(c.actor("owner"), { firstName: "=cmd|' /C calc'!A0", email: "formula@example.test", tagIds: [tag.id], customFields: { plan: "Pro" } });
    await createContact(c.actor("owner"), { firstName: "Not", lastName: "Exported", email: "no@example.test" });
    const list = await createSmartList(c.actor("owner"), { name: "Tagged", filter: { op: "and", conditions: [{ field: "tags", op: "has_any", value: [tag.id] }] } });
    await expect((async () => { for await (const _ of exportContactsCsv(c.actor("sales"), {})) void _; })()).rejects.toThrow(/export permission/);
    let csv = "";
    for await (const chunk of exportContactsCsv(c.actor("owner"), { smartListId: list.id })) csv += chunk;
    const parsed = parseCsv(csv);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.headers).toContain("Plan");
    const row = Object.fromEntries(parsed.headers.map((h, i) => [h, parsed.rows[0][i]]));
    expect(row.Name.startsWith("'=")).toBe(true);
    expect(row.Plan).toBe("Pro");
    expect(row.Tags).toBe("Export me");
    const job = await withSystem((db) => db.query<{ status: string; row_count: number }>("select status, row_count from crm_export_jobs where org_id = $1", [c.org.id]));
    expect(job.rows[0]).toEqual({ status: "completed", row_count: 1 });
  });

  it("agency support sessions never include export rights", async () => {
    const people = await agencyPeople();
    const c = await crmOrg();
    await startSupportSession(people.superAdmin, c.org.id, { mode: "write", reason: "Helping with data cleanup" });
    const actor = await agencyActor(people.superAdmin, c.org.id);
    await expect((async () => { for await (const _ of exportContactsCsv(actor, {})) void _; })()).rejects.toThrow(/export permission/);
  });

  it("the owner's full data export includes the new CRM data", async () => {
    const c = await crmOrg();
    await createTag(c.actor("owner"), { name: "In the zip" });
    const out = await buildExport(c.org.id);
    expect(out.counts.crm_tags).toBe(1);
  });
});

describe("per-person permissions", () => {
  it("lets owners and managers grant only what they hold, never to themselves, owners, or (for managers) other managers", async () => {
    const c = await crmOrg();
    await expect(setPermissionOverride(c.actor("sales"), { userId: c.people.support.id, permission: "contacts.export", effect: "grant" })).rejects.toThrow(/owners and managers/);
    await expect(setPermissionOverride(c.actor("manager"), { userId: c.people.manager.id, permission: "contacts.export", effect: "revoke" })).rejects.toThrow(/your own/);
    await expect(setPermissionOverride(c.actor("manager"), { userId: c.people.owner.id, permission: "contacts.export", effect: "revoke" })).rejects.toThrow(/owner always/);
    await expect(setPermissionOverride(c.actor("owner"), { userId: c.people.sales.id, permission: "billing.view", effect: "grant" })).rejects.toThrow(/always follows/);
    await expect(setPermissionOverride(c.actor("manager"), { userId: c.people.sales.id, permission: "campaigns.manage", effect: "grant" })).resolves.toBeUndefined();
    await expect(setPermissionOverride(c.actor("manager"), { userId: c.people.sales.id, permission: "contacts.export", effect: "grant" })).resolves.toBeUndefined();
    const access = await listMemberAccess(c.actor("owner"));
    const sales = access.find((m) => m.userId === c.people.sales.id)!;
    expect(sales.effective["contacts.export"]).toBe(true);
    expect(sales.overrides).toMatchObject({ "contacts.export": "grant" });
    await setPermissionOverride(c.actor("owner"), { userId: c.people.sales.id, permission: "contacts.export", effect: null });
    expect((await listMemberAccess(c.actor("owner"))).find((m) => m.userId === c.people.sales.id)!.effective["contacts.export"]).toBe(false);
    const audit = await withSystem((db) => db.query("select 1 from audit_logs where org_id = $1 and action = 'crm.permission_override_changed'", [c.org.id]));
    expect(audit.rows.length).toBe(3);
  });
});
