// Request a Change and a project's change list through a client's departure: the data export carries what the client may read (and none of the team's notes), and the final
// deletion removes all of it, the recorded decisions included, and nothing of another workspace. Embedded Postgres; nothing is sent.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { buildExport } from "@/server/offboarding/export";
import { readZip } from "@/server/offboarding/zip";
import { closeBilling, executeDeletion, getOffboarding, requestOffboardingAsAgency, shutdownClient } from "@/server/offboarding/service";
import { createProjectRequest, decideQuote } from "@/server/projects/client";
import { saveQuoteDraft, sendQuote, updateProjectStatus } from "@/server/projects/agency";
import { classifyChangeOrder, decideChangeOrder, postChangeMessage, sendChangeQuote, submitChangeOrder } from "@/server/projects/change-orders";
import { addPrerequisite } from "@/server/projects/prerequisites";
import { classifyChangeRequest } from "@/server/support/change";
import { setRequestChangesEnabled } from "@/server/support/change-feature";
import { submitRequest } from "@/server/support/service";
import type { OrgContext } from "@/server/tenancy/context";
import type { SessionUser } from "@/server/auth/service";
import { resetRateLimits } from "./support/support-world";
import { fullQuote, projectInput, projectsWorld, type ProjectsWorld } from "./support/projects-world";

let w: ProjectsWorld;
beforeAll(async () => {
  w = await projectsWorld();
  await setRequestChangesEnabled(w.agency.superAdmin, w.org.id, true);
  await setRequestChangesEnabled(w.agency.superAdmin, w.otherOrg.id, true);
});
beforeEach(resetRateLimits);

const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T>(sql, params))).rows;
const count = async (table: string, orgId: string) => Number((await rows<{ n: string }>(`select count(*)::text as n from ${table} where org_id = $1`, [orgId]))[0].n);

/** An agreed project with an accepted out-of-scope change, a change nobody has looked at, something to confirm, and a Request a Change request filed as a change too. */
async function seeded(owner: OrgContext, staff: SessionUser, marker: string) {
  const projectId = (await createProjectRequest(owner, projectInput(`${marker} project`))).id;
  await updateProjectStatus(staff, projectId, { status: "under_review" });
  const quoteId = (await saveQuoteDraft(staff, projectId, fullQuote())).id;
  await sendQuote(staff, projectId, quoteId);
  await decideQuote(owner, quoteId, "accepted");
  await updateProjectStatus(staff, projectId, { status: "in_development" });
  const accepted = await submitChangeOrder(owner, projectId, { title: `${marker} accepted change`, description: "Each front desk needs its own calendar for bookings." });
  await classifyChangeOrder(staff, accepted.id, { classification: "out_of_scope", internalNotes: `${marker}-INTERNAL-NOTE` });
  await sendChangeQuote(staff, accepted.id, { additionalMinor: 50000, currency: "USD", weeksMin: 1, weeksMax: 2, termsText: "Adds a second calendar and its confirmation message.", validUntil: null, prerequisiteLabel: `${marker} deposit for this change` });
  await decideChangeOrder(owner, accepted.id, "accepted", `${marker} owner note`);
  await postChangeMessage(owner, accepted.id, `${marker} one more thing about the calendar`);
  const waiting = await submitChangeOrder(owner, projectId, { title: `${marker} waiting change`, description: "A second change nobody has looked at yet." });
  await addPrerequisite(staff, projectId, { kind: "access", label: `${marker} access to the calendar`, blocks: "handover" });
  const request = await submitRequest(owner, { requestType: "change", subject: `${marker} change request`, message: "Please add a second calendar for the other desk.", category: "change_project", projectId, asChangeOrder: true });
  await classifyChangeRequest(staff, request.id, { classification: "needs_quote", note: `${marker}-CLASSIFICATION-NOTE` });
  return { projectId, accepted, waiting, request, marker };
}

async function close(orgId: string) {
  const req = await requestOffboardingAsAgency(w.agency.superAdmin, orgId, "Contract ended");
  return shutdownClient(w.agency.superAdmin, req.id);
}

describe("what a departing client downloads", () => {
  it("has the change requests, the answers, the added scope and what was asked first, and none of the team's notes", async () => {
    const mine = await seeded(w.ctx.owner, w.agency.staff, "EXPORTED");
    const files = readZip((await buildExport(w.org.id)).bytes);
    const read = (name: string) => files.find((f) => f.name === name)?.data.toString("utf8") ?? "";
    const manifest = JSON.parse(read("manifest.json")) as { tables: Record<string, number> };
    expect(manifest.tables).toMatchObject({ project_change_orders: 3, project_change_order_decisions: 1, project_scope_amendments: 1 });
    expect(manifest.tables.project_prerequisites).toBeGreaterThanOrEqual(2);
    const orders = JSON.parse(read("projects/change-requests.json")) as Array<Record<string, unknown>>;
    expect(orders.map((o) => o.title)).toEqual(expect.arrayContaining([`${mine.marker} accepted change`, `${mine.marker} waiting change`]));
    expect(JSON.parse(read("projects/change-request-answers.json"))).toHaveLength(1);
    expect(JSON.parse(read("projects/added-scope.json"))).toHaveLength(1);
    // Neither the notes the team wrote about a change or a request, nor the ids of the people who quoted it or made it, are in any file of the download.
    const everything = files.map((f) => f.data.toString("utf8")).join("\n");
    expect(everything).not.toContain(`${mine.marker}-INTERNAL-NOTE`);
    expect(everything).not.toContain(`${mine.marker}-CLASSIFICATION-NOTE`);
    for (const o of orders) expect(Object.keys(o)).not.toEqual(expect.arrayContaining(["internal_notes"]));
    for (const o of orders) expect(Object.keys(o)).not.toEqual(expect.arrayContaining(["quoted_by"]));
    // The team's classification of a request, its mentions and its triage are the team's own records: not exported, and said to be skipped rather than left out silently.
    expect(Object.keys(manifest.tables)).not.toContain("support_ticket_change");
  });
});

describe("shutting a client down and deleting its data", () => {
  afterAll(() => {
    delete process.env.OFFBOARDING_PURGE_ENABLED;
    resetEnvCache();
  });

  it("keeps the change list through the retention period, then the final deletion removes it all, the recorded answers included, and nothing of another workspace", async () => {
    await seeded(w.ctx.owner, w.agency.staff, "ERASED");
    await seeded(w.ctx.outsider, w.agency.outStaff, "STAYS");
    const tables = ["project_change_orders", "project_change_order_decisions", "project_scope_amendments", "project_prerequisites", "support_ticket_change", "project_review_tasks", "project_messages", "project_updates"];
    const before: Record<string, number> = {};
    for (const t of tables) {
      before[t] = await count(t, w.org.id);
      expect(before[t], `${t} (before)`).toBeGreaterThan(0);
    }
    expect((await rows<{ n: string }>("select count(*)::text as n from project_review_tasks where kind = 'review_change' and org_id = $1", [w.org.id]))[0].n).not.toBe("0");

    // Shutting the workspace down closes access; it removes nothing, so the client can still download everything during the retention period.
    const view = await close(w.org.id);
    expect(view.status).toBe("retention");
    for (const t of tables) expect(await count(t, w.org.id), `${t} (after the shutdown)`).toBe(before[t]);

    const req = (await getOffboarding(w.org.id))!;
    process.env.OFFBOARDING_PURGE_ENABLED = "true";
    resetEnvCache();
    await withSystem((db) => db.query("update offboarding_requests set delete_after = now() - interval '1 day' where id = $1", [req.id]));
    await closeBilling(w.agency.superAdmin, req.id, "Settled in full for this test.");
    await executeDeletion(w.agency.superAdmin, req.id, { confirmName: w.org.name, waiveExportReason: "Test run without a download." });

    for (const t of tables) {
      expect(await count(t, w.org.id), t).toBe(0);
      expect(await count(t, w.otherOrg.id), `${t} (the other workspace)`).toBeGreaterThan(0);
    }
    expect(Number((await rows<{ n: string }>("select count(*)::text as n from project_review_tasks where kind = 'review_change' and org_id = $1", [w.org.id]))[0].n)).toBe(0);
    // What the client wrote went with the workspace's own rows, notices included; the audit trail that is kept never held it.
    expect(await count("notifications", w.org.id)).toBe(0);
    expect(Number((await rows<{ n: string }>("select count(*)::text as n from audit_logs where org_id = $1 and metadata::text ilike '%ERASED%'", [w.org.id]))[0].n)).toBe(0);
  });
});
