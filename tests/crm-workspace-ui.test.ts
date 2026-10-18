// Services behind the CRM workspace screens: the overview, the agency portfolio, the client's support access log and export history.
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { agencyActor, auditSupportView, listSupportSessionsForClient, startSupportSession } from "@/server/crm/actor";
import { agencyCrmPortfolio } from "@/server/crm/agency";
import { getCrmOverview } from "@/server/crm/overview";
import { createContact } from "@/server/crm/contacts";
import { createOpportunity } from "@/server/crm/opportunities";
import { listPipelines } from "@/server/crm/pipelines";
import { createTag } from "@/server/crm/tags";
import { exportContactsCsv, listExportJobs } from "@/server/crm/exports";
import { countTaskViews, createTask, listTasks } from "@/server/crm/tasks";
import { listOpportunities } from "@/server/crm/opportunities";
import { followUrlSearch, initialSearch, searchToSend } from "@/components/crm/url-search";
import { agencyPeople, crmOrg, type CrmOrg } from "./support/crm";

let a: CrmOrg;
let b: CrmOrg;
let agency: Awaited<ReturnType<typeof agencyPeople>>;

beforeAll(async () => {
  a = await crmOrg({ name: "Portfolio A" });
  b = await crmOrg({ name: "Portfolio B" });
  agency = await agencyPeople();
  const owner = a.actor("owner");
  const c = await createContact(owner, { firstName: "Dana", lastName: "Cruz", email: `dana.${Date.now()}@example.test` });
  await listPipelines(owner, { ensureDefault: true });
  await createOpportunity(owner, { name: "Roof", contactId: c.id, value: 1200, currency: "USD" });
  await createTask(owner, { title: "Overdue call", dueAt: new Date(Date.now() - 3600_000).toISOString(), assigneeId: a.people.owner.id, contactId: c.id });
  await createTask(owner, { title: "Soon", dueAt: new Date(Date.now() + 86_400_000).toISOString(), assigneeId: a.people.sales.id });
});

describe("CRM overview", () => {
  it("counts only real rows and leaves out what the person can't see", async () => {
    const o = await getCrmOverview(a.actor("owner"));
    expect(o.counts.contacts).toBe(1);
    expect(o.deals).toMatchObject({ open: 1, openValue: [{ currency: "USD", value: 1200 }], wonThisMonth: 0, wonValueThisMonth: [] });
    expect(o.tasks).toMatchObject({ overdue: 1, upcoming: 1, team: 2, mine: 1 });
    expect(o.myTasks.map((t) => t.title)).toEqual(["Overdue call"]);
    expect(o.activity.length).toBeGreaterThan(0);
    expect(o.pipeline?.stages.reduce((n, s) => n + s.count, 0)).toBe(1);
    // Someone whose sales access was withdrawn gets no deal numbers at all rather than zeros.
    const base = a.actor("support");
    const support = await getCrmOverview({ ...base, can: (p) => p !== "sales.view" && base.can(p) });
    expect(support.deals).toBeNull();
    expect(support.pipeline).toBeNull();
    expect(support.activity.some((x) => x.opportunityId)).toBe(false);
  });

  it("task view counts match the lists", async () => {
    const owner = a.actor("owner");
    const counts = await countTaskViews(owner);
    expect((await listTasks(owner, { view: "overdue" })).length).toBe(counts.overdue);
    expect((await listTasks(owner, { view: "team" })).length).toBe(counts.team);
  });

  it("deal search matches the contact's name and the stage filter narrows the table", async () => {
    const owner = a.actor("owner");
    expect((await listOpportunities(owner, { search: "dana" })).total).toBe(1);
    const [pipe] = await listPipelines(owner);
    expect((await listOpportunities(owner, { pipelineId: pipe.id, stageId: pipe.stages[1].id })).total).toBe(0);
    expect((await listOpportunities(owner, { pipelineId: pipe.id, stageId: pipe.stages[0].id })).total).toBe(1);
  });
});

describe("agency CRM portfolio", () => {
  it("shows counts only, every client for super admins and assigned clients for staff", async () => {
    const all = await agencyCrmPortfolio(agency.superAdmin);
    const rowA = all.find((r) => r.orgId === a.org.id)!;
    expect(rowA).toMatchObject({ contacts: 1, openDeals: 1, overdueTasks: 1, mode: "native", mySession: null });
    // Nothing identifying a person is in the row.
    expect(JSON.stringify(rowA)).not.toMatch(/Dana|example\.test|Roof/);
    expect(all.some((r) => r.orgId === b.org.id)).toBe(true);

    expect((await agencyCrmPortfolio(agency.staff)).some((r) => r.orgId === a.org.id)).toBe(false);
    await withSystem((db) => db.query("insert into staff_assignments (org_id, user_id) values ($1, $2) on conflict do nothing", [a.org.id, agency.staff.id]));
    const staffRows = await agencyCrmPortfolio(agency.staff);
    expect(staffRows.map((r) => r.orgId)).toContain(a.org.id);
    expect(staffRows.map((r) => r.orgId)).not.toContain(b.org.id);
  });

  it("the client sees each support session with what was viewed and changed", async () => {
    await startSupportSession(agency.superAdmin, a.org.id, { mode: "write", reason: "Tidying tags for the client" });
    const writer = await agencyActor(agency.superAdmin, a.org.id);
    await auditSupportView(writer, "contacts");
    await auditSupportView(writer, "contact", "x");
    expect((await agencyCrmPortfolio(agency.superAdmin)).find((r) => r.orgId === a.org.id)?.mySession?.mode).toBe("write");
    await createTag(writer, { name: `Support ${Date.now()}` });
    const log = await listSupportSessionsForClient(a.actor("owner"));
    expect(log[0]).toMatchObject({ person: "Agency Admin", mode: "write", reason: "Tidying tags for the client", active: true, views: 2 });
    // Sales reps don't see the access log; it's for owners and managers.
    await expect(listSupportSessionsForClient(a.actor("sales"))).rejects.toThrow();
    // Support sessions never include the access log or exports.
    expect(writer.can("activity.view")).toBe(false);
  });
});

describe("export history", () => {
  it("records each export with who ran it", async () => {
    const owner = a.actor("owner");
    let out = "";
    for await (const chunk of exportContactsCsv(owner, {})) out += chunk;
    expect(out).toContain("Dana");
    const jobs = await listExportJobs(owner);
    expect(jobs[0]).toMatchObject({ entity: "contact", status: "completed", rowCount: 1, requestedBy: "Owner Person" });
    await expect(listExportJobs(a.actor("sales"))).rejects.toThrow(/allow/);
  });
});

describe("search boxes that drive the address", () => {
  // Each page load brings a new state object from the server; these stand in for four loads.
  const [v1, v2, v3, v4] = [{}, {}, {}, {}];

  it("never send spaces, so a box holding only spaces (or a trailing one) settles instead of refetching every pause", () => {
    let s = initialSearch("", v1);
    expect(searchToSend({ ...s, text: " " })).toBeNull();
    s = { ...s, text: "ann " };
    expect(searchToSend(s)).toBe("ann");
    s = { ...s, sent: "ann" };
    expect(searchToSend(s)).toBeNull(); // already on its way
    // The page loads with the search this box sent: the trailing space typed since stays, and nothing more is sent.
    s = followUrlSearch(s, "ann", v2);
    expect(s).toMatchObject({ text: "ann ", seen: "ann", sent: null });
    expect(searchToSend(s)).toBeNull();
    // A re-render of the same load changes nothing.
    expect(followUrlSearch(s, "ann", v2)).toBe(s);
  });

  it("keep typing that is ahead of the page, and adopt a search changed elsewhere (a navigation link, Back)", () => {
    let s = followUrlSearch({ ...initialSearch("", v1), text: "anne", sent: "ann" }, "ann", v2);
    expect(s.text).toBe("anne");
    expect(searchToSend(s)).toBe("anne");
    // The screen's own link in the navigation (no search): the box empties rather than pushing the old search back.
    s = followUrlSearch({ ...s, text: "ann" }, "", v3);
    expect(s).toMatchObject({ text: "", seen: "" });
    expect(searchToSend(s)).toBeNull();
    // Back to a page that had a search.
    s = followUrlSearch(s, "ann", v4);
    expect(s.text).toBe("ann");
    expect(searchToSend(s)).toBeNull();
  });

  it("send again a search whose page load another navigation overtook, but not one a Clear button just replaced", () => {
    // A filter clicked mid-pause: its page load still has no search, so the typed text stays and goes out again.
    const overtaken = followUrlSearch({ ...initialSearch("", v1), text: "ann", sent: "ann" }, "", v2);
    expect(overtaken.text).toBe("ann");
    expect(searchToSend(overtaken)).toBe("ann");
    // Clear empties the box and changes the address itself (reset sets text and sent): the pause sends nothing behind it.
    const cleared = { ...initialSearch("ann", v1), text: "", sent: "" };
    expect(searchToSend(cleared)).toBeNull();
    expect(followUrlSearch(cleared, "", v2)).toMatchObject({ text: "", seen: "", sent: null });
  });

  it("is what every list screen's search box uses, with router.replace", () => {
    for (const f of ["contacts-workspace", "companies-workspace", "opportunities-table", "pipeline-board", "tasks-workspace", "scheduling/appointments-list"]) {
      const src = readFileSync(path.join(process.cwd(), "src/components/crm", `${f}.tsx`), "utf8");
      expect(src, f).toMatch(/useUrlSearch\(state\.q, state, \(q\) => [^\n]*router\.replace\(/);
      expect(src, f).not.toMatch(/if \(q === state\.q\) return/);
    }
  });
});
