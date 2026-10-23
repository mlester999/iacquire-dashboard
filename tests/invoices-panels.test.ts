// What feeds the Invoices tab on a customer's page and on a deal's page, and the deal picker on the new-invoice form. An invoice holds a customer's details and the client's
// finances, so: only the client's own team that may see invoices, only where the module is on, never an agency person in a support session, never another workspace's rows.
import { describe, expect, it } from "vitest";
import { AGENCY_READ_PERMISSIONS, AGENCY_WRITE_PERMISSIONS, type CrmActor } from "@/server/crm/actor";
import { closeOpportunity, createOpportunity } from "@/server/crm/opportunities";
import { invoicesForActor, invoicesForRecord, searchDealsForInvoice } from "@/server/invoices/search";
import { setInvoicesEnabled } from "@/server/invoices/feature";
import { contactIn, dealFor, draftBy, invoiceOrg, issuedInvoice } from "./support/invoices";

describe("the invoices of one customer or one deal", () => {
  it("lists a customer's invoices for the people who may see invoices, newest information first, and a deal's by the deal", async () => {
    const io = await invoiceOrg();
    const maria = await contactIn(io, { firstName: "Maria" });
    const other = await contactIn(io, { firstName: "Other" });
    const deal = await dealFor(io, maria);
    const a = await issuedInvoice(io, { contactId: maria, opportunityId: deal });
    const b = await draftBy(io, "owner", { contactId: maria });
    await issuedInvoice(io, { contactId: other });
    for (const who of ["owner", "manager", "sales"] as const) {
      const rows = await invoicesForActor(io.c.actor(who), { contactId: maria });
      expect(rows?.map((r) => r.id).sort(), who).toEqual([a.invoice.id, b.invoice.id].sort());
    }
    expect((await invoicesForActor(io.c.actor("owner"), { opportunityId: deal }))?.map((r) => r.id)).toEqual([a.invoice.id]);
    expect(await invoicesForActor(io.c.actor("owner"), { contactId: other })).toHaveLength(1);
  });

  it("offers no panel at all to a person who may not see invoices, to an automation or an agency person in a support session, or in a workspace without the module", async () => {
    const io = await invoiceOrg();
    const maria = await contactIn(io, { firstName: "Maria" });
    await issuedInvoice(io, { contactId: maria });
    for (const who of ["setter", "support", "viewer"] as const) expect(await invoicesForActor(io.c.actor(who), { contactId: maria }), who).toBeNull();
    expect(await invoicesForActor(io.c.system, { contactId: maria })).toBeNull();
    const support: CrmActor = { ...io.c.actor("owner"), kind: "agency", supportSessionId: "11111111-1111-4111-8111-111111111111", supportMode: "read" };
    expect(await invoicesForActor(support, { contactId: maria })).toBeNull();
    // Agency staff are not given invoices by default, in a read session or a write session.
    expect(AGENCY_READ_PERMISSIONS.has("invoices.view")).toBe(false);
    expect(AGENCY_WRITE_PERMISSIONS.has("invoices.view")).toBe(false);
    await setInvoicesEnabled(io.superAdmin, io.orgId, false);
    expect(await invoicesForActor(io.c.actor("owner"), { contactId: maria })).toBeNull();
    await setInvoicesEnabled(io.superAdmin, io.orgId, true);
    expect(await invoicesForActor(io.c.actor("owner"), { contactId: maria })).toHaveLength(1);
  });

  it("is an agency workspace's nothing: invoices belong to the client's own workspace", async () => {
    const io = await invoiceOrg();
    const ctx = io.ctx("owner");
    expect(await invoicesForRecord({ can: (p) => ctx.can(p), user: { id: ctx.user.id }, org: { orgId: io.orgId, kind: "agency", timezone: "UTC" } }, {})).toBeNull();
  });

  it("never shows another workspace's invoices, even for an id it should not know", async () => {
    const a = await invoiceOrg();
    const b = await invoiceOrg();
    const theirs = await contactIn(b, { firstName: "Theirs" });
    await issuedInvoice(b, { contactId: theirs });
    expect(await invoicesForActor(a.c.actor("owner"), { contactId: theirs })).toEqual([]);
    const dealOfB = await dealFor(b, theirs);
    expect(await invoicesForActor(a.c.actor("owner"), { opportunityId: dealOfB })).toEqual([]);
  });
});

describe("the deal picker on the new-invoice form", () => {
  it("offers open deals of the workspace by name, with the customer they belong to, and never a closed deal or another workspace's", async () => {
    const io = await invoiceOrg();
    const maria = await contactIn(io, { firstName: "Maria", lastName: "Santos" });
    const roof = await dealFor(io, maria, { name: "Roof repair" });
    const lost = await createOpportunity(io.c.actor("owner"), { name: "Roof lost", contactId: maria, value: 100 });
    await closeOpportunity(io.c.actor("owner"), lost.id, "lost", { lostReason: "Went with someone else" });
    await dealFor(io, maria, { name: "Gutter job" });
    const stranger = await invoiceOrg();
    await dealFor(stranger, await contactIn(stranger), { name: "Roof elsewhere" });

    const found = await searchDealsForInvoice(io.ctx("owner"), "roof");
    expect(found.map((d) => d.name)).toEqual(["Roof repair"]);
    expect(found[0]).toMatchObject({ id: roof, contactId: maria, contactName: "Maria Santos" });
    expect((await searchDealsForInvoice(io.ctx("owner"), "")).map((d) => d.name).sort()).toEqual(["Gutter job", "Roof repair"]);
    expect(await searchDealsForInvoice(io.ctx("owner"), "nothing like this")).toEqual([]);
  });

  it("treats the characters of a pattern as plain text, caps what it returns, and is for those who may write invoices in a workspace that has them", async () => {
    const io = await invoiceOrg();
    const maria = await contactIn(io, { firstName: "Maria" });
    await dealFor(io, maria, { name: "100% roof" });
    await dealFor(io, maria, { name: "Plain deal" });
    expect((await searchDealsForInvoice(io.ctx("owner"), "%")).map((d) => d.name)).toEqual(["100% roof"]);
    expect(await searchDealsForInvoice(io.ctx("owner"), "_")).toEqual([]);
    for (let i = 0; i < 30; i += 1) await dealFor(io, maria, { name: `Many ${i}` });
    expect((await searchDealsForInvoice(io.ctx("owner"), "many", 100)).length).toBe(25);
    for (const who of ["viewer", "support", "member"] as const) await expect(searchDealsForInvoice(io.ctx(who), "roof"), who).rejects.toThrow(/can't write invoices/);
    const off = await invoiceOrg({ enabled: false });
    await expect(searchDealsForInvoice(off.ctx("owner"), "x")).rejects.toThrow(/not switched on/);
  });
});
