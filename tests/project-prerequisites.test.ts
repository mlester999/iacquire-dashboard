import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { updateAgencyUserPermission } from "@/server/admin/team";
import { loadSupportSettings, updateSupportSettings } from "@/server/support/settings";
import { addPrerequisite, removePrerequisite, satisfyPrerequisite, waivePrerequisite } from "@/server/projects/prerequisites";
import { getAgencyProject, recordHandover, saveMilestone, saveQuoteDraft, sendQuote, setMilestoneStatus, updateProjectStatus } from "@/server/projects/agency";
import { createProjectRequest, decideQuote, getProject } from "@/server/projects/client";
import { classifyChangeOrder, decideChangeOrder, markChangeApplied, sendChangeQuote, submitChangeOrder } from "@/server/projects/change-orders";
import { setRequestChangesEnabled } from "@/server/support/change-feature";
import { notificationsFor, resetRateLimits } from "./support/support-world";
import { fullQuote, projectInput, projectsWorld, type ProjectsWorld } from "./support/projects-world";

// What a person confirms before a custom project's work starts or before it is handed over. A record of a human check: nothing is detected and nobody is charged. The
// switch for asking for the agreement and the payment when a quote is accepted is the Super Admin's and is off until the founder decides.

let w: ProjectsWorld;
beforeAll(async () => {
  w = await projectsWorld();
  await setRequestChangesEnabled(w.agency.superAdmin, w.org.id, true);
});
afterAll(async () => {
  await setSwitch(false);
});
beforeEach(resetRateLimits);

const rows = async (sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<Record<string, unknown>>(sql, params))).rows;
const setSwitch = async (on: boolean) => {
  const s = await loadSupportSettings();
  if (s.projectPrerequisitesEnabled !== on) await updateSupportSettings(w.agency.superAdmin, { projectPrerequisitesEnabled: on }, s.revision);
};
const items = (projectId: string) => rows("select * from project_prerequisites where request_id = $1 order by created_at, kind, id", [projectId]);
const deny = (userId: string, permission: string) => updateAgencyUserPermission(w.agency.superAdmin, { userId, permission: permission as never, effect: "deny" });
const clearOverrides = (userId: string) => withSystem((db) => db.query("delete from agency_user_permission_overrides where user_id = $1", [userId]));

/** A project whose quote the owner accepted, with the quote's payment terms as given. */
async function acceptedProject(title: string, paymentTerms = "50% to begin, 50% on delivery.") {
  const id = (await createProjectRequest(w.ctx.owner, projectInput(title))).id;
  await updateProjectStatus(w.agency.staff, id, { status: "under_review" });
  const quoteId = (await saveQuoteDraft(w.agency.staff, id, { ...fullQuote(), paymentTerms })).id;
  await sendQuote(w.agency.staff, id, quoteId);
  await decideQuote(w.ctx.owner, quoteId, "accepted");
  return id;
}

describe("asking for the agreement and the payment when a quote is accepted", () => {
  it("asks for nothing while the Super Admin's switch is off, and work can start as it always could", async () => {
    await setSwitch(false);
    const id = await acceptedProject("Switch off project");
    expect(await items(id)).toEqual([]);
    await expect(updateProjectStatus(w.agency.staff, id, { status: "in_development" })).resolves.toBeUndefined();
    expect((await getProject(w.ctx.owner, id))!.prerequisites).toEqual([]);
  });

  it("asks for the agreement and, when the quote has payment terms, the payment, once, with the switch on", async () => {
    await setSwitch(true);
    const id = await acceptedProject("Switch on project");
    const list = await items(id);
    expect(list.map((p) => [p.kind, p.label, p.blocks, p.required, p.status])).toEqual([
      ["agreement", "Written agreement confirmed", "start", true, "pending"],
      ["deposit", "Payment confirmed as the quote's payment terms describe", "start", true, "pending"],
    ]);
    // Seeding again after a replay adds nothing: the database keeps one of each.
    await expect(withSystem((db) => db.query("insert into project_prerequisites (request_id, org_id, kind, label) values ($1, $2, 'agreement', 'Written agreement confirmed')", [id, w.org.id]))).rejects.toThrow(/project_prerequisites_once_idx/);
    // The client reads the list, without evidence or names.
    const client = (await getProject(w.ctx.owner, id))!.prerequisites;
    expect(client.map((p) => p.status)).toEqual(["pending", "pending"]);
    expect(Object.keys(client[0]).sort()).not.toEqual(expect.arrayContaining(["evidenceNote"]));
    expect(client[0]).not.toHaveProperty("evidenceNote");
    expect(client[0]).not.toHaveProperty("recordedByName");
  });

  it("does not ask for a payment when the quote has no payment terms to point at", async () => {
    await setSwitch(true);
    // A quote must have payment terms to be sent, so this is the seeding rule itself: nothing to point at, nothing asked.
    const { defaultPrerequisites } = await import("@/lib/project-prerequisites");
    expect(defaultPrerequisites("").map((p) => p.kind)).toEqual(["agreement"]);
  });

  it("is changed only by the Super Admin, with the usual revision check, and a review target must be set before it is shown to clients", async () => {
    const s = await loadSupportSettings();
    await expect(updateSupportSettings(w.agency.staff, { projectPrerequisitesEnabled: true }, s.revision)).rejects.toMatchObject({ code: "forbidden" });
    await expect(updateSupportSettings(w.agency.superAdmin, { showProjectTargetsToClients: true }, s.revision)).rejects.toThrow(/Set a review target/);
    await expect(updateSupportSettings(w.agency.superAdmin, { projectReviewTargetHours: 0 }, s.revision)).rejects.toMatchObject({ code: "invalid_input" });
    const saved = await updateSupportSettings(w.agency.superAdmin, { projectReviewTargetHours: 24, showProjectTargetsToClients: true }, s.revision);
    expect(saved).toMatchObject({ projectReviewTargetHours: 24, showProjectTargetsToClients: true });
    await expect(updateSupportSettings(w.agency.superAdmin, { projectReviewTargetHours: null }, saved.revision)).rejects.toThrow(/Set a review target/);
    const cleared = await updateSupportSettings(w.agency.superAdmin, { showProjectTargetsToClients: false, projectReviewTargetHours: null }, saved.revision);
    expect(cleared).toMatchObject({ projectReviewTargetHours: null, showProjectTargetsToClients: false });
    await expect(updateSupportSettings(w.agency.superAdmin, { projectPrerequisitesEnabled: false }, saved.revision)).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("work does not start until what was asked for is confirmed or waived", () => {
  it("holds the start while an item is waiting, and lets it through once each is confirmed or waived with a reason", async () => {
    await setSwitch(true);
    const id = await acceptedProject("Start gate project");
    await expect(updateProjectStatus(w.agency.staff, id, { status: "in_development" })).rejects.toThrow(/Work can't start yet: 2 things are still waiting/);
    const [agreement, payment] = await items(id);
    await satisfyPrerequisite(w.agency.staff, agreement.id as string, "Signed agreement received by email on the 3rd; filed in the project folder.");
    await expect(updateProjectStatus(w.agency.staff, id, { status: "in_development" })).rejects.toThrow(/one thing is still waiting.*Payment confirmed/);
    await waivePrerequisite(w.agency.staff, payment.id as string, "The client pays at handover instead, agreed by phone.");
    await updateProjectStatus(w.agency.staff, id, { status: "in_development" });
    expect((await rows("select status from client_project_requests where id = $1", [id]))[0].status).toBe("in_development");
    expect((await rows("select started_at from client_projects where request_id = $1", [id]))[0].started_at).not.toBeNull();
  });

  it("records who and when, keeps the evidence for the team, and tells the client without the evidence", async () => {
    await setSwitch(true);
    const id = await acceptedProject("Evidence project");
    const [agreement] = await items(id);
    const evidence = "EVIDENCE-MARKER-5512 agreement scanned and filed";
    await satisfyPrerequisite(w.agency.staff, agreement.id as string, evidence);
    const stored = (await rows("select * from project_prerequisites where id = $1", [agreement.id]))[0];
    expect(stored).toMatchObject({ status: "satisfied", satisfied_by: w.raw.staff.id, evidence_note: evidence });
    expect(stored.satisfied_at).not.toBeNull();
    const team = (await getAgencyProject(w.agency.staff, id))!.prerequisites.find((p) => p.id === agreement.id)!;
    expect(team).toMatchObject({ status: "satisfied", evidenceNote: evidence, recordedByName: "Stan Staffer" });
    const client = (await getProject(w.ctx.owner, id))!;
    expect(JSON.stringify(client.prerequisites)).not.toContain("EVIDENCE-MARKER");
    expect(client.prerequisites.find((p) => p.id === agreement.id)).toMatchObject({ status: "satisfied" });
    // The client's session cannot read the evidence column even by asking for it.
    await expect(withUser(w.people.owner.id, (db) => db.query("select evidence_note from project_prerequisites"))).rejects.toThrow(/permission denied/);
    // Nothing in a notice or an audit row repeats it.
    expect((await notificationsFor(w.people.owner.id, "project_prerequisite")).filter((n) => n.dedupe_key === `project:${id}:prerequisite:${agreement.id}:satisfied`)).toHaveLength(1);
    expect((await rows("select count(*)::int as n from notifications where title like '%EVIDENCE-MARKER%' or body like '%EVIDENCE-MARKER%'"))[0].n).toBe(0);
    expect((await rows("select count(*)::int as n from audit_logs where target_id = $1 and metadata::text like '%EVIDENCE-MARKER%'", [agreement.id]))[0].n).toBe(0);
    expect((await rows("select count(*)::int as n from project_updates where request_id = $1 and body like '%EVIDENCE-MARKER%'", [id]))[0].n).toBe(0);
  });

  it("needs a few words of evidence, refuses a card number or a key in it, and a satisfied item cannot be confirmed again or removed", async () => {
    await setSwitch(true);
    const id = await acceptedProject("Evidence rules project");
    const [agreement, payment] = await items(id);
    await expect(satisfyPrerequisite(w.agency.staff, agreement.id as string, "ok")).rejects.toMatchObject({ code: "invalid_input" });
    await expect(satisfyPrerequisite(w.agency.staff, agreement.id as string, "Customer paid with 4242 4242 4242 4242 today")).rejects.toThrow(/card number/);
    await expect(satisfyPrerequisite(w.agency.staff, agreement.id as string, `Key ${["sk", "live", "4eC39HqLyjWDarjtT1zdp7dc"].join("_")} was shared`)).rejects.toMatchObject({ code: "invalid_input" });
    expect((await rows("select status from project_prerequisites where id = $1", [agreement.id]))[0].status).toBe("pending");
    await satisfyPrerequisite(w.agency.staff, agreement.id as string, "Signed agreement received by email on the 3rd.");
    await expect(satisfyPrerequisite(w.agency.staff, agreement.id as string, "Confirming a second time here.")).rejects.toThrow(/already confirmed/);
    await expect(waivePrerequisite(w.agency.staff, agreement.id as string, "Trying to waive what was confirmed")).rejects.toThrow(/already confirmed/);
    await expect(removePrerequisite(w.agency.staff, agreement.id as string)).rejects.toThrow(/kept as the record/);
    await expect(withSystem((db) => db.query("delete from project_prerequisites where id = $1", [agreement.id]))).rejects.toThrow(/kept as the record/);
    // The database repeats the rule about words: a confirmation without evidence, a waiver without a reason.
    await expect(withSystem((db) => db.query("update project_prerequisites set status = 'satisfied', satisfied_at = now() where id = $1", [payment.id]))).rejects.toThrow(/satisfied_check/);
    await expect(withSystem((db) => db.query("update project_prerequisites set status = 'waived', waived_at = now() where id = $1", [payment.id]))).rejects.toThrow(/waived_check/);
  });

  it("is waived only with the quote permission, and with a reason that is kept and audited", async () => {
    await setSwitch(true);
    const id = await acceptedProject("Waiver project");
    const [agreement] = await items(id);
    await deny(w.raw.staff2.id, "quotes.manage");
    try {
      await expect(waivePrerequisite(w.agency.staff2, agreement.id as string, "The client signed on paper at the office.")).rejects.toMatchObject({ code: "forbidden" });
      // The same person can still confirm one: that is the project permission.
      await expect(satisfyPrerequisite(w.agency.staff2, agreement.id as string, "Seen the signed paper copy at the office on the 3rd.")).resolves.toBeUndefined();
    } finally {
      await clearOverrides(w.raw.staff2.id);
    }
    const payment = (await items(id))[1];
    await expect(waivePrerequisite(w.agency.staff, payment.id as string, "no")).rejects.toMatchObject({ code: "invalid_input" });
    await waivePrerequisite(w.agency.staff, payment.id as string, "The client pays at handover; agreed in writing by email.");
    expect(await rows("select status, waived_reason, waived_by from project_prerequisites where id = $1", [payment.id])).toEqual([{ status: "waived", waived_reason: "The client pays at handover; agreed in writing by email.", waived_by: w.raw.staff.id }]);
    const audit = await rows("select action, metadata from audit_logs where target_id = $1", [payment.id]);
    expect(audit.map((a) => a.action)).toEqual(["project.prerequisite_waived"]);
    expect(JSON.stringify(audit[0].metadata)).not.toContain("handover; agreed");
    expect((await getProject(w.ctx.owner, id))!.prerequisites.find((p) => p.id === payment.id)).toMatchObject({ status: "waived", waivedAt: expect.any(String) });
  });

  it("answers 'not found' outside the client's scope and 'forbidden' without the project permission, and a client cannot reach any of it", async () => {
    await setSwitch(true);
    const id = await acceptedProject("Scope project");
    const [agreement] = await items(id);
    await expect(satisfyPrerequisite(w.agency.outStaff, agreement.id as string, "Trying from outside the scope.")).rejects.toMatchObject({ code: "not_found" });
    await expect(waivePrerequisite(w.agency.outStaff, agreement.id as string, "Trying from outside the scope.")).rejects.toMatchObject({ code: "not_found" });
    await expect(removePrerequisite(w.agency.outStaff, agreement.id as string)).rejects.toMatchObject({ code: "not_found" });
    await expect(addPrerequisite(w.agency.outStaff, id, { kind: "access", label: "Calendar access" })).rejects.toMatchObject({ code: "not_found" });
    await expect(satisfyPrerequisite({ ...w.agency.staff, platformRole: "none" }, agreement.id as string, "A client pretending to be staff.")).rejects.toMatchObject({ code: "forbidden" });
    await expect(satisfyPrerequisite(w.agency.staff, "not-an-id", "No such item exists at all.")).rejects.toMatchObject({ code: "not_found" });
    await deny(w.raw.watcher.id, "projects.manage");
    try {
      await expect(satisfyPrerequisite(w.agency.watcher, agreement.id as string, "Without the project permission.")).rejects.toMatchObject({ code: "forbidden" });
    } finally {
      await clearOverrides(w.raw.watcher.id);
    }
    // A client's session can neither write nor read another workspace's items.
    await expect(withUser(w.people.owner.id, (db) => db.query("update project_prerequisites set status = 'satisfied' where id = $1", [agreement.id]))).rejects.toThrow(/permission denied/);
    expect(await withUser(w.people.outsider.id, async (db) => (await db.query("select id from project_prerequisites")).rows)).toEqual([]);
    expect((await items(id))[0].status).toBe("pending");
  });
});

describe("asking for something by hand", () => {
  it("lets the team ask for access, content or anything else, which the client then sees and is told about", async () => {
    await setSwitch(false);
    const id = await acceptedProject("By hand project");
    const added = await addPrerequisite(w.agency.staff, id, { kind: "access", label: "Access to the booking calendar", blocks: "start" });
    expect((await items(id)).map((p) => p.label)).toEqual(["Access to the booking calendar"]);
    expect((await notificationsFor(w.people.owner.id, "project_prerequisite")).filter((n) => n.dedupe_key === `project:${id}:prerequisite:${added.id}:added`)).toHaveLength(1);
    expect((await getProject(w.ctx.owner, id))!.prerequisites[0]).toMatchObject({ label: "Access to the booking calendar", kind: "access", blocks: "start", status: "pending" });
    await expect(updateProjectStatus(w.agency.staff, id, { status: "in_development" })).rejects.toThrow(/Access to the booking calendar/);
    await removePrerequisite(w.agency.staff, added.id);
    expect(await items(id)).toEqual([]);
    await expect(updateProjectStatus(w.agency.staff, id, { status: "in_development" })).resolves.toBeUndefined();
  });

  it("checks what is asked: a label of a few words, a known kind, and only the agreement and the payment once", async () => {
    await setSwitch(false);
    const id = await acceptedProject("By hand rules project");
    await expect(addPrerequisite(w.agency.staff, id, { kind: "access", label: "ab" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(addPrerequisite(w.agency.staff, id, { kind: "change" as never, label: "A change item" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(addPrerequisite(w.agency.staff, id, { kind: "nonsense" as never, label: "A made up kind" })).rejects.toMatchObject({ code: "invalid_input" });
    await addPrerequisite(w.agency.staff, id, { kind: "agreement", label: "Signed agreement" });
    await expect(addPrerequisite(w.agency.staff, id, { kind: "agreement", label: "Signed agreement again" })).rejects.toThrow(/already on this project's list/);
    await updateProjectStatus(w.agency.staff, id, { status: "cancelled", reason: "The client changed plans" });
    await expect(addPrerequisite(w.agency.staff, id, { kind: "access", label: "Too late to ask" })).rejects.toThrow(/closed/);
  });

  it("holds the handover for an item that blocks it, and lets it through once the item is settled", async () => {
    await setSwitch(false);
    const id = await acceptedProject("Handover gate project");
    await updateProjectStatus(w.agency.staff, id, { status: "in_development" });
    await saveMilestone(w.agency.staff, id, { title: "Built", requiresClientApproval: false });
    const m = (await getAgencyProject(w.agency.staff, id))!.milestones[0];
    await setMilestoneStatus(w.agency.staff, id, m.id, "completed");
    await updateProjectStatus(w.agency.staff, id, { status: "testing" });
    await updateProjectStatus(w.agency.staff, id, { status: "ready_for_review" });
    const item = await addPrerequisite(w.agency.staff, id, { kind: "content", label: "Final logo files received", blocks: "handover" });
    await expect(recordHandover(w.agency.staff, id, "Delivered everything and wrote the usage guide.")).rejects.toThrow(/can't be handed over yet.*Final logo files received/);
    await satisfyPrerequisite(w.agency.staff, item.id, "Logo files received by email and filed in the project folder.");
    await recordHandover(w.agency.staff, id, "Delivered everything and wrote the usage guide.");
    expect((await rows("select status from client_project_requests where id = $1", [id]))[0].status).toBe("completed");
  });
});

describe("what a change asks to be confirmed first", () => {
  it("is kept hidden from the client until the change is accepted, binds the handover from then on, and goes if the change is declined", async () => {
    await setSwitch(false);
    const projectId = await acceptedProject("Change item project");
    await updateProjectStatus(w.agency.staff, projectId, { status: "in_development" });
    const ask = async (title: string) => (await submitChangeOrder(w.ctx.owner, projectId, { title, description: "We would like this extra thing done as well." })).id;
    const quote = async (id: string) => {
      await classifyChangeOrder(w.agency.staff, id, { classification: "out_of_scope" });
      await sendChangeQuote(w.agency.staff, id, { additionalMinor: 50000, currency: "USD", termsText: "Adds the extra thing described above.", weeksMin: 1, weeksMax: 1, prerequisiteLabel: "Deposit for this change received" });
    };
    const one = await ask("Accepted change");
    await quote(one);
    const hidden = (await getProject(w.ctx.owner, projectId))!.prerequisites;
    expect(hidden).toEqual([]);
    expect((await getAgencyProject(w.agency.staff, projectId))!.prerequisites).toEqual([expect.objectContaining({ kind: "change", blocks: "handover", status: "pending", changeStatus: "quoted" })]);
    await decideChangeOrder(w.ctx.owner, one, "accepted");
    expect((await getProject(w.ctx.owner, projectId))!.prerequisites).toEqual([expect.objectContaining({ kind: "change", label: "Deposit for this change received", status: "pending", changeStatus: "accepted" })]);
    // Making the change does not settle the item: a person confirms it.
    await markChangeApplied(w.agency.staff, one);
    const item = (await items(projectId))[0];
    expect(item).toMatchObject({ status: "pending", change_order_id: one });
    await satisfyPrerequisite(w.agency.staff, item.id as string, "Deposit seen in the bank statement on the 5th.");
    const two = await ask("Declined change");
    await quote(two);
    expect(await items(projectId)).toHaveLength(2);
    await decideChangeOrder(w.ctx.owner, two, "declined");
    expect(await items(projectId)).toHaveLength(1);
  });
});
