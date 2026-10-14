import { afterAll, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/server/env";
import { withSystem, withUser } from "@/server/db";
import { connectHermesProfile, createConfigVersion, runHealthCheck } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import { ensureInstanceStandalone, ensureSetupInstance, getSetupRevision } from "@/server/setup/core";
import { activateSetup, addTaskAttachment, addTaskNote, createCustomTask, markReadyForReview, reorderTasks, requestClientAction, sendBackToSetup, setResponsibleStaff, setServices, setTaskDependencies, setTaskHidden, updateTaskDetails, updateTaskStatus } from "@/server/setup/agency";
import { attestTask, reconcileSetupAutomation, runChecks, verifyTask } from "@/server/setup/automation";
import { submitClientResponse } from "@/server/setup/client";
import { getAgencySetupSnapshot, getClientSetupSnapshot, listClientSetupOverview } from "@/server/setup/snapshots";
import { setupEventStream } from "@/server/setup/hub";
import { computeProgress, estimateCompletion, evaluateReadiness, type RuleTask } from "@/lib/setup";
import { PROVISIONERS } from "@/server/setup/provisioning-contract";
import { CONNECTORS } from "@/server/setup/connectors";
import { CHECK_KEYS } from "@/lib/setup";
import { addMember, agencyUser, agentId, createOrg, createUser, ctxFor } from "./support/fixtures";
import { startMockHermes, type MockHermes } from "./support/mock-hermes";

const KEY = "s".repeat(40);

const TEMPLATE_KEYS = [
  "company_info", "organization_created", "ghl_subaccount", "crm_snapshot", "crm_tags", "lead_forms", "crm_assets", "ai_configuration", "ai_profiles", "ai_employees", "automation_preparation", "business_hours", "workflows",
  "website_built", "website_review", "website_published", "funnel_built", "funnel_review", "funnel_published", "email_domain", "calendar", "booking_test", "knowledge_review", "integration_tests", "final_review",
];

async function fresh(name: string) {
  const org = await createOrg({ name });
  const owner = await createUser();
  const member = await createUser();
  await addMember(org.id, owner.id, "owner");
  await addMember(org.id, member.id, "member");
  await ensureInstanceStandalone(org.id);
  await setServices(await admin(), org.id, ["crm", "ai_workforce", "automations", "website", "funnel", "email", "calendar"]);
  return { org, owner, member, ownerCtx: ctxFor(owner, org, "owner"), memberCtx: ctxFor(member, org, "member") };
}

const admin = async () => agencyUser(await createUser({ platformRole: "agency_super_admin" }), "agency_super_admin");
const staffFor = async (orgId: string | null) => {
  const u = await createUser({ platformRole: "agency_staff" });
  if (orgId) await withSystem((db) => db.query("insert into staff_assignments (org_id, user_id) values ($1, $2)", [orgId, u.id]));
  return agencyUser(u, "agency_staff");
};

async function taskId(orgId: string, key: string) {
  const { rows } = await withSystem((db) => db.query<{ id: string }>("select id from client_setup_tasks where org_id = $1 and template_key = $2", [orgId, key]));
  return rows[0].id;
}

async function task(orgId: string, key: string) {
  const { rows } = await withSystem((db) => db.query<Record<string, unknown>>("select * from client_setup_tasks where org_id = $1 and template_key = $2", [orgId, key]));
  return rows[0];
}

async function finishOnboarding(orgId: string) {
  await withSystem(async (db) => {
    await db.query("update organizations set onboarding_completed_at = now() where id = $1", [orgId]);
    await db.query(
      "insert into onboarding_responses (org_id, current_step, completed_at) values ($1, 5, now()) on conflict (org_id) do update set completed_at = now()",
      [orgId],
    );
  });
  await reconcileSetupAutomation(orgId);
}

const rt = (id: string, over: Partial<RuleTask> = {}): RuleTask => ({
  id, title: id, status: "pending", required: true, hidden: false, serviceExcluded: false, completionMode: "manual", checkKey: null, dependsOn: [], ...over,
});

async function approveWebsiteReview(a: Parameters<typeof updateTaskStatus>[0], orgId: string, ownerCtx: Parameters<typeof submitClientResponse>[0]) {
  const id = await taskId(orgId, "website_review");
  await addTaskAttachment(a, orgId, id, { label: "Website preview", url: "https://example.com/preview", kind: "website_preview", visibility: "client" });
  await updateTaskStatus(a, orgId, id, { status: "waiting_for_client", note: "Please review your custom website." });
  await submitClientResponse(ownerCtx, id, { decision: "approve" });
  await updateTaskStatus(a, orgId, id, { status: "completed" });
}

describe("checklist creation", () => {
  it("builds the default checklist from the template with no pre-completed steps", async () => {
    const { org, ownerCtx } = await fresh("Template Co");
    const snap = await getClientSetupSnapshot(ownerCtx);
    expect(snap).not.toBeNull();
    const { rows } = await withSystem((db) => db.query<{ template_key: string }>("select template_key from client_setup_tasks where org_id = $1 order by sort_order", [org.id]));
    expect(rows.map((r) => r.template_key)).toEqual(TEMPLATE_KEYS);
    expect(snap!.progress).toMatchObject({ completed: 0, percent: 0 });
    expect(snap!.tasks.every((t) => t.status === "pending")).toBe(true);
    expect(snap!.state).toBe("in_setup");
  });

  it("matches the template in the database", async () => {
    const { rows } = await withSystem((db) =>
      db.query<{ key: string }>("select tt.key from client_setup_template_tasks tt join client_setup_templates t on t.id = tt.template_id and t.is_default order by tt.sort_order"),
    );
    expect(rows.map((r) => r.key)).toEqual(TEMPLATE_KEYS);
  });

  it("is idempotent and never creates a checklist for the agency workspace", async () => {
    const { org } = await fresh("Idempotent Co");
    const again = await withSystem((db) => ensureSetupInstance(db, org.id));
    expect(again?.created).toBe(false);
    const { rows } = await withSystem((db) => db.query("select 1 from client_setup_tasks where org_id = $1", [org.id]));
    expect(rows).toHaveLength(TEMPLATE_KEYS.length);
    const agency = await createOrg({ name: "Agency Co", kind: "agency", status: "active" }).catch(() => null);
    if (agency) expect(await withSystem((db) => ensureSetupInstance(db, agency.id))).toBeNull();
  });

  it("completes company information only once onboarding is really submitted", async () => {
    const { org } = await fresh("Evidence Co");
    await reconcileSetupAutomation(org.id);
    expect((await task(org.id, "company_info")).status).toBe("pending");
    await finishOnboarding(org.id);
    const t = await task(org.id, "company_info");
    expect(t).toMatchObject({ status: "completed", completion_source: "connector" });
  });
});

describe("agency updates reach the client (Bright Homes Realty example)", () => {
  it("persists a completion with its note, recalculates progress and records who changed what", async () => {
    const { org, owner, ownerCtx } = await fresh("Bright Homes Realty");
    const a = await admin();
    await finishOnboarding(org.id);
    const before = await getClientSetupSnapshot(ownerCtx);
    const rev0 = (await getSetupRevision(org.id))!;

    const id = await taskId(org.id, "website_built");
    await updateTaskStatus(a, org.id, id, { status: "completed", note: "Your new website has been built and is ready for review." });

    const after = await getClientSetupSnapshot(ownerCtx);
    const site = after!.tasks.find((t) => t.id === (before!.tasks.find((b) => b.title === "Your custom website is built")?.id))!;
    expect(site.status).toBe("completed");
    expect(site.completionNote).toBe("Your new website has been built and is ready for review.");
    expect(site.completedAt).toBeTruthy();
    expect(after!.progress.completed).toBe(before!.progress.completed + 1);
    expect(after!.progress.percent).toBe(Math.round((after!.progress.completed / after!.progress.total) * 100));
    expect(after!.revision).toBeGreaterThan(rev0);
    expect(site.history[0].text).toContain("Completed");

    // Persisted in the database, not held in browser state.
    expect((await task(org.id, "website_built")).status).toBe("completed");
    const { rows: ev } = await withSystem((db) =>
      db.query<{ from_status: string; to_status: string; actor_user_id: string; created_at: Date }>(
        "select from_status, to_status, actor_user_id, created_at from client_setup_task_events where task_id = $1 and event = 'status_changed'",
        [site.id],
      ),
    );
    expect(ev[0]).toMatchObject({ from_status: "pending", to_status: "completed", actor_user_id: a.id });
    const { rows: audit } = await withSystem((db) => db.query("select 1 from audit_logs where org_id = $1 and action = 'setup.task_status_changed' and target_id = $2", [org.id, site.id]));
    expect(audit.length).toBe(1);

    // The client is told in-app.
    const { rows: n } = await withSystem((db) => db.query<{ title: string; kind: string; link: string }>("select title, kind, link from notifications where user_id = $1 and kind = 'setup_milestone' order by created_at desc", [owner.id]));
    expect(n[0]).toMatchObject({ title: "Your website has been built", link: "/setup" });
  });

  it("shows reopened work and lowers progress again", async () => {
    const { org, ownerCtx } = await fresh("Reopen Co");
    const a = await admin();
    await finishOnboarding(org.id);
    const id = await taskId(org.id, "website_built");
    await updateTaskStatus(a, org.id, id, { status: "completed" });
    const done = await getClientSetupSnapshot(ownerCtx);
    await expect(updateTaskStatus(a, org.id, id, { status: "in_progress" })).rejects.toThrow(/reason for reopening/);
    await updateTaskStatus(a, org.id, id, { status: "in_progress", reason: "Client sent new logo", note: "We are updating your website with your new logo." });
    const reopened = await getClientSetupSnapshot(ownerCtx);
    expect(reopened!.progress.completed).toBe(done!.progress.completed - 1);
    const t = reopened!.tasks.find((x) => x.id === id)!;
    expect(t).toMatchObject({ status: "in_progress", completedAt: null, completionNote: null });
    const row = await task(org.id, "website_built");
    expect(row).toMatchObject({ completed_at: null, completed_by: null, completion_source: null });
    const { rows } = await withSystem((db) => db.query<{ event: string }>("select event from client_setup_task_events where task_id = $1 order by id", [id]));
    expect(rows.map((r) => r.event)).toContain("reopened");
  });

  it("enforces dependencies, blocked reasons and the request wording", async () => {
    const { org } = await fresh("Rules Co");
    const a = await admin();
    const site = await taskId(org.id, "website_built");
    await expect(updateTaskStatus(a, org.id, site, { status: "completed" })).rejects.toThrow(/Finish "Company information submitted" first/);
    await expect(updateTaskStatus(a, org.id, site, { status: "blocked" })).rejects.toThrow(/Explain why/);
    await updateTaskStatus(a, org.id, site, { status: "blocked", note: "Waiting on your logo files." });
    expect(await task(org.id, "website_built")).toMatchObject({ status: "blocked", blocked_reason: "Waiting on your logo files." });
    await updateTaskStatus(a, org.id, site, { status: "in_progress" });
    expect((await task(org.id, "website_built")).blocked_reason).toBeNull();
    // A client can't be asked to act on a step whose prerequisites aren't finished.
    await expect(updateTaskStatus(a, org.id, await taskId(org.id, "calendar"), { status: "waiting_for_client" })).rejects.toThrow(/Finish "GHL sub-account created" first/);
    await updateTaskStatus(a, org.id, await taskId(org.id, "company_info"), { status: "in_progress" });
    await finishOnboarding(org.id);
    await updateTaskStatus(a, org.id, site, { status: "waiting_for_client", note: "Please send logo files." });
    const plain = await createCustomTask(a, org.id, { title: "Collect logo files" });
    await expect(updateTaskStatus(a, org.id, plain.result.taskId, { status: "waiting_for_client" })).rejects.toThrow(/Tell the client/);
  });

  it("does not let a status change complete a step that only a system check may complete", async () => {
    const { org } = await fresh("Verified Co");
    const a = await admin();
    const snapshot = await taskId(org.id, "crm_snapshot");
    await expect(updateTaskStatus(a, org.id, snapshot, { status: "completed" })).rejects.toThrow(/system check/);
    await expect(updateTaskStatus(a, org.id, await taskId(org.id, "final_review"), { status: "completed" })).rejects.toThrow(/activation controls/);
    // The database enforces the same rule even if application code were wrong.
    await expect(
      withSystem((db) => db.query("update client_setup_tasks set status = 'completed', completed_at = now(), completion_source = 'agency' where id = $1", [snapshot])),
    ).rejects.toThrow(/check constraint/i);
    await expect(
      withSystem((db) => db.query("update client_setup_tasks set status = 'blocked' where id = $1", [snapshot])),
    ).rejects.toThrow(/check constraint/i);
  });

  it("limits staff to the clients they are assigned to", async () => {
    const { org } = await fresh("Assigned Co");
    const other = await staffFor(null);
    const mine = await staffFor(org.id);
    const id = await taskId(org.id, "website_built");
    await expect(updateTaskStatus(other, org.id, id, { status: "in_progress" })).rejects.toThrow(/not found/i);
    await updateTaskStatus(mine, org.id, id, { status: "in_progress" });
    expect((await task(org.id, "website_built")).status).toBe("in_progress");
    await expect(setServices(mine, org.id, ["crm"])).rejects.toThrow(/super admins/i);
  });
});

describe("what clients can and cannot do", () => {
  it("lets an owner answer an open request, which waits for agency review instead of completing", async () => {
    const { org, ownerCtx } = await fresh("Respond Co");
    const a = await admin();
    await finishOnboarding(org.id);
    const id = await taskId(org.id, "website_review");
    // Not requested yet: nothing to answer.
    await expect(submitClientResponse(ownerCtx, id, { decision: "approve" })).rejects.toThrow(/no longer open/);
    // The agency can't ask for a review before the website exists.
    await expect(updateTaskStatus(a, org.id, id, { status: "waiting_for_client", note: "Please review." })).rejects.toThrow(/Finish "Custom website developed" first/);
    const built = await taskId(org.id, "website_built");
    await updateTaskStatus(a, org.id, built, { status: "completed" });
    await updateTaskStatus(a, org.id, id, { status: "waiting_for_client", note: "Please review your new website." });
    const open = await getClientSetupSnapshot(ownerCtx);
    expect(open!.needsAttention).toBe(1);
    expect(open!.tasks.find((t) => t.id === id)).toMatchObject({ section: "client", action: { available: true } });
    // If the website is reopened meanwhile, the client's request pauses instead of misleading them.
    await updateTaskStatus(a, org.id, built, { status: "in_progress", reason: "Fixing a typo" });
    expect((await getClientSetupSnapshot(ownerCtx))!.tasks.find((t) => t.id === id)!.action).toMatchObject({ available: false, unavailableReason: expect.stringMatching(/earlier step/) });
    await expect(submitClientResponse(ownerCtx, id, { decision: "approve" })).rejects.toThrow(/earlier step/);
    await updateTaskStatus(a, org.id, built, { status: "completed" });
    await expect(submitClientResponse(ownerCtx, id, {})).rejects.toThrow(/Approve the design/);
    await expect(submitClientResponse(ownerCtx, id, { decision: "request_changes" })).rejects.toThrow(/what you would like changed/);
    const res = await submitClientResponse(ownerCtx, id, { decision: "approve", message: "Looks great" });
    expect(res.result.status).toBe("ready_for_review");
    expect(await task(org.id, "website_review")).toMatchObject({ status: "ready_for_review" });
    await expect(submitClientResponse(ownerCtx, id, { decision: "approve" })).rejects.toThrow(/no longer open/);
    const snap = await getClientSetupSnapshot(ownerCtx);
    expect(snap!.tasks.find((t) => t.id === id)).toMatchObject({ status: "ready_for_review", responded: { decision: "approve" } });
    expect(snap!.needsAttention).toBe(0);
  });

  it("treats a request for changes as work for the agency, not as approval", async () => {
    const { org, ownerCtx } = await fresh("Changes Co");
    const a = await admin();
    await finishOnboarding(org.id);
    await updateTaskStatus(a, org.id, await taskId(org.id, "website_built"), { status: "completed" });
    const id = await taskId(org.id, "website_review");
    await updateTaskStatus(a, org.id, id, { status: "waiting_for_client", note: "Please review." });
    await submitClientResponse(ownerCtx, id, { decision: "request_changes", message: "Use our blue" });
    expect(await task(org.id, "website_review")).toMatchObject({ status: "in_progress", client_responded_at: null });
    // The required approval is still missing, so the step can't be completed.
    await expect(updateTaskStatus(a, org.id, id, { status: "completed" })).rejects.toThrow(/approval is required/);
  });

  it("keeps members read-only and blocks every direct write", async () => {
    const { org, ownerCtx, memberCtx, owner } = await fresh("ReadOnly Co");
    const a = await admin();
    await finishOnboarding(org.id);
    const id = await taskId(org.id, "email_domain");
    await updateTaskStatus(a, org.id, id, { status: "waiting_for_client", note: "Add the DNS records we sent." });
    await expect(submitClientResponse(memberCtx, id, { decision: "confirm" })).rejects.toThrow(/owners and admins/);
    expect((await getClientSetupSnapshot(memberCtx))!.canRespond).toBe(false);
    // No application path lets a client write agency-controlled state. The database refuses it too.
    for (const sql of [
      "update client_setup_tasks set status = 'completed'",
      "update client_setup_tasks set title = 'x'",
      "insert into client_setup_tasks (org_id, instance_id, title, section) values ($1, $1, 'x', 'client')",
      "delete from client_setup_tasks",
      "update client_setup_instances set state = 'activated'",
    ]) {
      await expect(withUser(owner.id, (db) => db.query(sql, sql.includes("$1") ? [org.id] : []))).rejects.toThrow(/permission denied/i);
    }
    await submitClientResponse(ownerCtx, id, { decision: "confirm" });
    expect(await task(org.id, "email_domain")).toMatchObject({ status: "ready_for_review" });
  });
});

describe("tenant isolation", () => {
  it("never shows one client another client's setup", async () => {
    const a = await fresh("Alpha Setup Co");
    const b = await fresh("Beta Setup Co");
    const adm = await admin();
    await updateTaskStatus(adm, a.org.id, await taskId(a.org.id, "website_built"), { status: "in_progress", note: "Alpha only note" });

    const snapB = await getClientSetupSnapshot(b.ownerCtx);
    expect(JSON.stringify(snapB)).not.toContain("Alpha only note");
    const aTaskIds = (await getClientSetupSnapshot(a.ownerCtx))!.tasks.map((t) => t.id);
    expect(snapB!.tasks.some((t) => aTaskIds.includes(t.id))).toBe(false);

    // Row-level security hides every row of the other tenant, whatever id the caller supplies.
    const peek = await withUser(b.owner.id, (db) => db.query("select id from client_setup_tasks where org_id = $1", [a.org.id]));
    expect(peek.rows).toHaveLength(0);
    const aSite = await taskId(a.org.id, "website_built");
    const byId = await withUser(b.owner.id, (db) => db.query("select id from client_setup_tasks where id = $1", [aSite]));
    expect(byId.rows).toHaveLength(0);
    await expect(submitClientResponse(b.ownerCtx, await taskId(a.org.id, "website_built"), { decision: "confirm" })).rejects.toThrow(/wasn't found/);
    const events = await withUser(b.owner.id, (db) => db.query("select id from client_setup_task_events where org_id = $1", [a.org.id]));
    expect(events.rows).toHaveLength(0);
  });

  it("refuses cross-tenant prerequisites and cross-tenant staff access", async () => {
    const a = await fresh("Gamma Setup Co");
    const b = await fresh("Delta Setup Co");
    const adm = await admin();
    const mine = await taskId(a.org.id, "website_built");
    const theirs = await taskId(b.org.id, "website_built");
    await expect(setTaskDependencies(adm, a.org.id, mine, [theirs])).rejects.toThrow(/doesn't belong/);
    await expect(updateTaskStatus(adm, a.org.id, theirs, { status: "in_progress" })).rejects.toThrow(/wasn't found/);
    const staff = await staffFor(a.org.id);
    await expect(getAgencySetupSnapshot(staff, b.org.id)).rejects.toThrow(/not found/i);
    expect((await getAgencySetupSnapshot(staff, a.org.id)).org.id).toBe(a.org.id);
    // A client user is never an agency user.
    await expect(getAgencySetupSnapshot({ ...agencyUser(a.owner, "agency_staff"), platformRole: "none" }, a.org.id)).rejects.toThrow(/Agency access/);
  });

  it("hides internal notes, staff names and hidden steps from clients", async () => {
    const { org, ownerCtx, owner } = await fresh("Private Notes Co");
    const a = await admin();
    const id = await taskId(org.id, "website_built");
    await addTaskNote(a, org.id, id, { body: "INTERNAL: client is slow to respond", visibility: "internal" });
    await addTaskNote(a, org.id, id, { body: "We start design on Monday.", visibility: "client" });
    await updateTaskDetails(a, org.id, id, { assignedTo: a.id });
    const snap = await getClientSetupSnapshot(ownerCtx);
    expect(JSON.stringify(snap)).not.toContain("INTERNAL");
    expect(snap!.tasks.find((t) => t.id === id)!.clientNote).toBe("We start design on Monday.");
    await expect(withUser(owner.id, (db) => db.query("select reason from client_setup_task_events"))).rejects.toThrow(/permission denied/i);
    await expect(withUser(owner.id, (db) => db.query("select assigned_to from client_setup_tasks"))).rejects.toThrow(/permission denied/i);
    const events = await withUser(owner.id, (db) => db.query<{ visibility: string }>("select visibility from client_setup_task_events where task_id = $1", [id]));
    expect(events.rows.every((e) => e.visibility === "client")).toBe(true);

    const optional = await createCustomTask(a, org.id, { title: "Secret agency checklist item", required: false });
    await setTaskHidden(a, org.id, optional.result.taskId, true);
    expect((await getClientSetupSnapshot(ownerCtx))!.tasks.some((t) => t.title.includes("Secret"))).toBe(false);
    const rows = await withUser(owner.id, (db) => db.query("select id from client_setup_tasks where id = $1", [optional.result.taskId]));
    expect(rows.rows).toHaveLength(0);
    expect((await getAgencySetupSnapshot(a, org.id)).tasks.some((t) => t.title.includes("Secret"))).toBe(true);
  });
});

describe("progress rules", () => {
  it("counts only applicable required steps and never the activation step", () => {
    const tasks = [
      rt("a", { status: "completed" }),
      rt("b"),
      rt("optional", { required: false }),
      rt("hidden", { required: false, hidden: true }),
      rt("excluded", { serviceExcluded: true }),
      rt("final", { completionMode: "activation" }),
    ];
    expect(computeProgress(tasks)).toMatchObject({ total: 2, completed: 1, percent: 50 });
    expect(computeProgress([rt("x", { serviceExcluded: true })]).percent).toBeNull();
    expect(computeProgress([rt("a", { status: "completed" }), rt("o", { required: false })]).percent).toBe(100);
  });

  it("estimates completion only when every remaining step has a date", () => {
    const withDate = (id: string, d: string | null, over: Partial<RuleTask> = {}) => ({ ...rt(id, over), estimatedCompletionAt: d });
    expect(estimateCompletion([withDate("a", "2026-11-02"), withDate("b", null)])).toBeNull();
    expect(estimateCompletion([withDate("a", "2026-11-02"), withDate("b", "2026-11-09"), withDate("c", null, { status: "completed" })])).toBe("2026-11-09");
    expect(estimateCompletion([withDate("a", null, { status: "completed" })])).toBeNull();
  });

  it("recalculates when services change, without penalizing excluded work", async () => {
    const { org, ownerCtx } = await fresh("Package Co");
    const a = await admin();
    const full = await getClientSetupSnapshot(ownerCtx);
    expect(full!.progress.total).toBe(TEMPLATE_KEYS.length - 1);
    await setServices(a, org.id, ["crm"]);
    const crm = await getClientSetupSnapshot(ownerCtx);
    expect(crm!.progress.total).toBe(8); // company info, organization, 5 CRM steps, final system checks
    expect(crm!.tasks.some((t) => t.title.includes("website"))).toBe(false);
    await finishOnboarding(org.id);
    expect((await getClientSetupSnapshot(ownerCtx))!.progress.percent).toBe(25);
  });

  it("only hides optional steps and keeps ordering and dependencies valid", async () => {
    const { org } = await fresh("Order Co");
    const a = await admin();
    const site = await taskId(org.id, "website_built");
    await expect(setTaskHidden(a, org.id, site, true)).rejects.toThrow(/Mark the step optional first/);
    await updateTaskDetails(a, org.id, site, { required: false });
    await setTaskHidden(a, org.id, site, true);
    await updateTaskDetails(a, org.id, site, { required: true });
    expect((await task(org.id, "website_built")).hidden).toBe(false);

    const snap = await getAgencySetupSnapshot(a, org.id);
    const agency = snap.tasks.filter((t) => t.section === "agency");
    const reversed = [...agency].reverse().map((t) => t.id);
    await reorderTasks(a, org.id, "agency", reversed);
    expect((await getAgencySetupSnapshot(a, org.id)).tasks.filter((t) => t.section === "agency").map((t) => t.id)).toEqual(reversed);
    await expect(reorderTasks(a, org.id, "agency", reversed.slice(1))).rejects.toThrow(/changed while/);

    const first = await taskId(org.id, "ghl_subaccount");
    const second = await taskId(org.id, "crm_snapshot");
    await expect(setTaskDependencies(a, org.id, first, [second])).rejects.toThrow(/loop/);
    await expect(setTaskDependencies(a, org.id, first, [first])).rejects.toThrow(/itself/);
  });

  it("adds custom manual steps that count toward progress", async () => {
    const { org, ownerCtx } = await fresh("Custom Co");
    const a = await admin();
    const before = (await getClientSetupSnapshot(ownerCtx))!.progress.total;
    const created = await createCustomTask(a, org.id, { title: "Brand approval", section: "client", description: "Approve your logo and colors.", estimatedCompletionAt: "2026-12-01" });
    expect((await getClientSetupSnapshot(ownerCtx))!.progress.total).toBe(before + 1);
    await updateTaskStatus(a, org.id, created.result.taskId, { status: "completed", note: "Brand approved." });
    expect((await getClientSetupSnapshot(ownerCtx))!.progress.completed).toBe(1);
    await addTaskAttachment(a, org.id, created.result.taskId, { label: "Brand guide", url: "https://example.com/brand.pdf", kind: "documentation", visibility: "client" });
    expect((await getClientSetupSnapshot(ownerCtx))!.tasks.find((t) => t.title === "Brand approval")!.attachments).toHaveLength(1);
    await expect(addTaskAttachment(a, org.id, created.result.taskId, { label: "Bad", url: "http://example.com/x" })).rejects.toThrow();
    await expect(updateTaskDetails(a, org.id, created.result.taskId, { assignedTo: (await createUser({ platformRole: "agency_staff" })).id })).rejects.toThrow(/has access to this client/);
    await updateTaskDetails(a, org.id, created.result.taskId, { assignedTo: a.id });
    await setResponsibleStaff(a, org.id, a.id);
    expect((await getAgencySetupSnapshot(a, org.id)).responsibleUserId).toBe(a.id);
  });
});

describe("integration health is separate from task progress", () => {
  it("refuses to attest anything a system check can verify and anything not yet unlocked", async () => {
    const { org } = await fresh("Attest Co");
    const a = await admin();
    await expect(attestTask(a, org.id, await taskId(org.id, "ai_employees"), { note: "I looked and it seems fine to me." })).rejects.toThrow(/checked automatically/);
    await expect(attestTask(a, org.id, await taskId(org.id, "crm_snapshot"), { note: "short" })).rejects.toThrow(/at least a sentence/);
    await expect(verifyTask(a, org.id, await taskId(org.id, "crm_snapshot"))).rejects.toThrow(/Record an agency attestation/);
    // Attesting still needs the earlier steps finished first.
    await expect(attestTask(a, org.id, await taskId(org.id, "crm_snapshot"), { note: "Snapshot installed; checked in GoHighLevel." })).rejects.toThrow(/Finish/);
  });

  it("withdraws an attestation when the step is reopened", async () => {
    const { org, ownerCtx } = await fresh("Withdraw Co");
    const a = await admin();
    await setServices(a, org.id, ["website"]);
    await finishOnboarding(org.id);
    await updateTaskStatus(a, org.id, await taskId(org.id, "website_built"), { status: "completed" });
    await approveWebsiteReview(a, org.id, ownerCtx);
    const id = await taskId(org.id, "website_published");
    await updateTaskStatus(a, org.id, id, { status: "waiting_for_client", note: "Please review." });
    await submitClientResponse(ownerCtx, id, { decision: "approve" });
    await attestTask(a, org.id, id, { note: "Domain and HTTPS verified in a browser today." });
    expect((await getAgencySetupSnapshot(a, org.id)).checks.find((c) => c.key === "website_live")!.status).toBe("attested");
    await updateTaskStatus(a, org.id, id, { status: "in_progress", reason: "DNS change reverted" });
    const check = (await getAgencySetupSnapshot(a, org.id)).checks.find((c) => c.key === "website_live")!;
    expect(check).toMatchObject({ status: "unverified", source: null, attestedBy: null });
    expect(await task(org.id, "website_published")).toMatchObject({ status: "in_progress", completion_source: null, verified_at: null });
    // The client must approve again after a reopen.
    expect((await task(org.id, "website_published")).client_responded_at).toBeNull();
  });
});

describe("a full setup, from checklist to activation", () => {
  it("refuses technical activation when a super admin acknowledges an attestation", async () => {
    const { org, owner, ownerCtx } = await fresh("Full Setup Co");
    const a = await admin();
    const staff = await staffFor(org.id);
    await setServices(a, org.id, ["website"]);
    await finishOnboarding(org.id);
    await updateTaskStatus(staff, org.id, await taskId(org.id, "website_built"), { status: "completed", note: "Website built." });
    await approveWebsiteReview(staff, org.id, ownerCtx);
    const pub = await taskId(org.id, "website_published");
    await updateTaskStatus(staff, org.id, pub, { status: "waiting_for_client", note: "Please review your website." });
    await submitClientResponse(ownerCtx, pub, { decision: "approve" });

    await expect(markReadyForReview(staff, org.id)).rejects.toThrow(/Not ready/);
    await attestTask(staff, org.id, pub, { note: "Domain resolves and the site loads over HTTPS; verified in a browser.", evidenceUrl: "https://example.com/proof.png" });
    const checkRow = (await getAgencySetupSnapshot(a, org.id)).checks.find((c) => c.key === "website_live")!;
    expect(checkRow).toMatchObject({ status: "attested", source: "attestation", connectorImplemented: false });
    expect(checkRow.status).not.toBe("verified");

    // Evidence cannot complete publication or make the aggregate provider check pass.
    await runChecks(org.id, { actorUserId: a.id, live: false, force: true });
    const snap = await getClientSetupSnapshot(ownerCtx);
    expect(snap!.progress.percent).toBeLessThan(100);
    expect(snap!.state).toBe("in_setup");
    expect(await task(org.id, "website_published")).toMatchObject({ status: "ready_for_review", completion_source: null, completed_at: null });
    expect((await task(org.id, "integration_tests")).status).not.toBe("completed");

    // 100% of setup tasks is not "ready for production".
    await expect(activateSetup(a, org.id, { acknowledgeAttested: true })).rejects.toThrow(/final review/);
    await expect(markReadyForReview(staff, org.id)).rejects.toThrow(/Not ready/);
    await expect(activateSetup(staff, org.id, {})).rejects.toThrow(/Only super admins/);
    // Even a forged final-review state cannot bypass server verification.
    await withSystem((db) => db.query("update client_setup_instances set state = 'ready_for_review' where org_id = $1", [org.id]));
    await expect(activateSetup(a, org.id, { acknowledgeAttested: true, note: "Reviewed agency evidence." })).rejects.toThrow(/final review|Activation is blocked/);
    expect((await getClientSetupSnapshot(ownerCtx))!.state).not.toBe("activated");
    expect((await task(org.id, "final_review")).status).not.toBe("completed");
    const { rows: billing } = await withSystem((db) => db.query<{ activation_status: string }>("select activation_status from billing_accounts where org_id = $1", [org.id]));
    expect(billing[0].activation_status).toBe("pending");
    const { rows: n } = await withSystem((db) => db.query<{ title: string }>("select title from notifications where user_id = $1 and kind = 'setup_ready'", [owner.id]));
    expect(n).toHaveLength(0);
    const reviews = await withSystem((db) => db.query("select decision from activation_reviews where org_id = $1", [org.id]));
    expect(reviews.rows.length).toBeGreaterThan(0);
    expect(reviews.rows.every((r) => r.decision === "blocked")).toBe(true);
  });

  it("sends a final review back when a finished step is reopened", async () => {
    const { org } = await fresh("Review Cancel Co");
    const a = await admin();
    await setServices(a, org.id, []);
    await finishOnboarding(org.id);
    const design = await createCustomTask(a, org.id, { title: "Website design completed" });
    const built = design.result.taskId;
    await updateTaskStatus(a, org.id, built, { status: "completed" });
    await runChecks(org.id, { actorUserId: a.id, live: false, force: true });
    await markReadyForReview(a, org.id);
    expect((await getAgencySetupSnapshot(a, org.id)).state).toBe("ready_for_review");
    await updateTaskStatus(a, org.id, built, { status: "in_progress", reason: "Typo found" });
    const s = await getAgencySetupSnapshot(a, org.id);
    expect(s.state).toBe("in_setup");
    expect(s.readiness.canMarkReady).toBe(false);
    expect(s.progress.percent).toBeLessThan(100);
    await expect(sendBackToSetup(a, org.id, "no longer needed")).rejects.toThrow(/Only a setup in final review/);
  });

  it("blocks activation when a final check fails, even at 100% of tasks", async () => {
    const mock: MockHermes = await startMockHermes({ "setup-ready-hunter": { key: KEY } });
    try {
      const { org, owner, ownerCtx } = await fresh("Failing Check Co");
      const a = await admin();
      await setServices(a, org.id, ["ai_workforce"]);
      await withSystem((db) => db.query("update agent_instances set enabled = false, status = 'disabled' where org_id = $1 and role_key <> 'lead_hunter'", [org.id]));
      const hunter = await agentId(org.id, "lead_hunter");
      await withSystem((db) => createConfigVersion(db, { orgId: org.id, agentId: hunter, settings: defaultSettings("lead_hunter"), source: "onboarding", userId: owner.id, apply: true }));
      await connectHermesProfile({ agentId: hunter, baseUrl: mock.url, profile: "setup-ready-hunter", apiKey: KEY, agencyUserId: a.id });
      await finishOnboarding(org.id);

      // Human configuration preparation is separate from the profile's live safety check.
      for (const key of ["ai_configuration", "ai_profiles", "knowledge_review"]) {
        const prepared = await taskId(org.id, key);
        await addTaskAttachment(a, org.id, prepared, { label: "Preparation review", url: "https://example.com/evidence", kind: "evidence" });
        await updateTaskStatus(a, org.id, prepared, { status: "completed" });
      }

      // A passing health check alone does not complete the step: the client's approval is required first.
      expect((await runHealthCheck(hunter, { userId: a.id, kind: "agency" })).ok).toBe(true);
      expect((await task(org.id, "ai_employees")).status).toBe("pending");
      const ai = await taskId(org.id, "ai_employees");
      await updateTaskStatus(a, org.id, ai, { status: "waiting_for_client", note: "Please approve your AI employee setup." });
      await submitClientResponse(ownerCtx, ai, { decision: "approve" });
      expect((await task(org.id, "ai_employees")).status).toBe("ready_for_review");

      // The next real health check completes the step by itself, then the aggregate system check passes.
      await runHealthCheck(hunter, { userId: a.id, kind: "agency" });
      expect(await task(org.id, "ai_employees")).toMatchObject({ status: "completed", completion_source: "connector" });
      expect(await task(org.id, "integration_tests")).toMatchObject({ status: "completed" });
      expect((await getClientSetupSnapshot(ownerCtx))!.progress.percent).toBe(100);
      await markReadyForReview(a, org.id);

      // Hermes goes away. Activation re-runs the checks live and refuses.
      await mock.close();
      await expect(activateSetup(a, org.id, {})).rejects.toThrow(/Activation is blocked.*failing/);
      const agency = await getAgencySetupSnapshot(a, org.id);
      expect(agency.progress.percent).toBe(100);
      expect(agency.state).toBe("ready_for_review");
      expect(agency.checks.find((c) => c.key === "hermes_employees")).toMatchObject({ status: "failed", source: "connector" });
      expect(agency.readiness.canActivate).toBe(false);
      expect(agency.readiness.failedChecks).toContain("hermes_employees");
      const client = await getClientSetupSnapshot(ownerCtx);
      expect(client!.progress.percent).toBe(100);
      expect(client!.finalCheckIssue).toBe(true);
      // The client is told something needs attention, without technical detail.
      const { rows } = await withSystem((db) => db.query<{ title: string; body: string }>("select title, body from notifications where user_id = $1 and kind = 'setup_issue'", [owner.id]));
      expect(rows[0].title).toBe("A setup check needs attention");
      expect(rows[0].body).not.toMatch(/hermes|offline|unreachable/i);
    } finally {
      await mock.close().catch(() => undefined);
    }
  });

  it("never auto-completes a blocked step when its check later passes", async () => {
    const { org } = await fresh("Blocked Auto Co");
    const a = await admin();
    await updateTaskStatus(a, org.id, await taskId(org.id, "company_info"), { status: "blocked", note: "Waiting for the onboarding form." });
    await finishOnboarding(org.id);
    expect((await task(org.id, "company_info")).status).toBe("blocked");
    await updateTaskStatus(a, org.id, await taskId(org.id, "company_info"), { status: "in_progress" });
    await reconcileSetupAutomation(org.id);
    expect((await task(org.id, "company_info")).status).toBe("completed");
  });
});

describe("client requests", () => {
  it("lets the agency ask for something specific and notifies the client", async () => {
    const { org, owner, ownerCtx } = await fresh("Request Co");
    const a = await admin();
    await finishOnboarding(org.id);
    const id = await taskId(org.id, "website_built");
    await requestClientAction(a, org.id, id, { type: "provide_info", label: "Send your logo", instructions: "Upload your logo to the shared folder and tell us the link." });
    const snap = await getClientSetupSnapshot(ownerCtx);
    const t = snap!.tasks.find((x) => x.id === id)!;
    expect(t).toMatchObject({ status: "waiting_for_client", section: "client", action: { label: "Send your logo", available: true } });
    const { rows } = await withSystem((db) => db.query<{ title: string }>("select title from notifications where user_id = $1 and kind = 'setup_action_required'", [owner.id]));
    expect(rows[0].title).toBe("Action needed: Send your logo");
    await expect(submitClientResponse(ownerCtx, id, { message: "" })).rejects.toThrow(/Write your answer/);
    await submitClientResponse(ownerCtx, id, { message: "https://example.com/logo.png" });
    expect(await task(org.id, "website_built")).toMatchObject({ status: "ready_for_review" });
    // Agency notices the answer in its own inbox.
    const { rows: agency } = await withSystem((db) => db.query("select 1 from notifications where kind = 'system' and title like $1", [`Request Co: Send your logo%`]));
    expect(agency.length).toBeGreaterThan(0);
  });
});

describe("agency client list", () => {
  it("summarizes setup, actions, blockers and health, scoped to what the staff member may see", async () => {
    const { org } = await fresh("Overview Co");
    const a = await admin();
    const staff = await staffFor(org.id);
    await finishOnboarding(org.id);
    await updateTaskStatus(a, org.id, await taskId(org.id, "email_domain"), { status: "waiting_for_client", note: "Add the DNS records." });
    await updateTaskStatus(a, org.id, await taskId(org.id, "website_built"), { status: "blocked", note: "Waiting on logo." });
    await setResponsibleStaff(a, org.id, staff.id);
    const all = await listClientSetupOverview(a);
    const row = all.find((r) => r.id === org.id)!;
    expect(row).toMatchObject({ name: "Overview Co", responsible: { id: staff.id }, setup: { started: true, state: "in_setup", percent: 8, clientActions: 1, blocked: 1 } });
    expect(row.health.level).toBe("not_connected");
    expect(row.lastActivityAt).toBeTruthy();
    const mine = await listClientSetupOverview(staff);
    expect(mine.map((r) => r.id)).toEqual([org.id]);
    await expect(listClientSetupOverview({ ...staff, platformRole: "none" })).rejects.toThrow(/Agency access/);
  });
});

describe("live synchronization", () => {
  const read = async (reader: ReadableStreamDefaultReader<Uint8Array>, until: RegExp, ms = 3000) => {
    const dec = new TextDecoder();
    let buf = "";
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const r = await Promise.race([reader.read(), new Promise<{ value: undefined; done: true }>((res) => setTimeout(() => res({ value: undefined, done: true }), 200))]);
      if (r.value) buf += dec.decode(r.value);
      if (until.test(buf)) return buf;
    }
    return buf;
  };

  it("pushes a change to an open stream as soon as it is saved, and catches changes from other instances by polling", async () => {
    const { org } = await fresh("Live Co");
    const a = await admin();
    const ctrl = new AbortController();
    const { getSetupRevision: rev } = await import("@/server/setup/core");
    const stream = setupEventStream({ orgId: org.id, getRevision: rev, signal: ctrl.signal, pollMs: 100 });
    const reader = stream.getReader();
    const first = await read(reader, /event: ready/);
    const start = Number(/"revision":(\d+)/.exec(first)![1]);
    await updateTaskStatus(a, org.id, await taskId(org.id, "website_built"), { status: "in_progress" });
    const pushed = await read(reader, /event: revision/);
    expect(Number(/event: revision\s+data: \{"revision":(\d+)\}/.exec(pushed)![1])).toBeGreaterThan(start);

    // A change made by another app instance never publishes in-process; the revision poll still sees it.
    await withSystem((db) => db.query("update client_setup_instances set revision = revision + 5 where org_id = $1", [org.id]));
    const polled = await read(reader, /"revision":\d+\}\s+\n*$/);
    expect(polled).toMatch(new RegExp(`"revision":${(await rev(org.id))}`));
    ctrl.abort();
  });

  it("keeps the revision monotonic across rapid changes", async () => {
    const { org } = await fresh("Rapid Co");
    const a = await admin();
    const id = await taskId(org.id, "website_built");
    const seen: number[] = [(await getSetupRevision(org.id))!];
    for (const s of ["in_progress", "pending", "in_progress"] as const) {
      await updateTaskStatus(a, org.id, id, { status: s });
      seen.push((await getSetupRevision(org.id))!);
    }
    expect(seen).toEqual([...seen].sort((x, y) => x - y));
    expect(new Set(seen).size).toBe(seen.length);
  });
});

describe("readiness rules", () => {
  it("blocks review on blocked, incomplete and dependency-broken steps", () => {
    const tasks = [
      rt("a", { status: "completed" }),
      rt("b", { status: "completed", dependsOn: ["c"] }),
      rt("c"),
      rt("d", { required: false, status: "blocked" }),
    ];
    const r = evaluateReadiness({ state: "in_setup", tasks, checks: {} });
    expect(r.canMarkReady).toBe(false);
    expect(r.taskBlockers.map((b) => b.code).sort()).toEqual(["dependency_unmet", "task_blocked", "task_incomplete"]);
  });

  it("separates finished tasks from production readiness", () => {
    const tasks = [rt("a", { status: "completed", completionMode: "verified", checkKey: "ghl_location" }), rt("f", { completionMode: "activation" })];
    const failing = evaluateReadiness({ state: "ready_for_review", tasks, checks: { ghl_location: "failed" } });
    expect(failing.tasksComplete).toBe(true);
    expect(failing.canActivate).toBe(false);
    expect(failing.failedChecks).toEqual(["ghl_location"]);
    expect(evaluateReadiness({ state: "ready_for_review", tasks, checks: {} }).blockers.map((b) => b.code)).toContain("check_unverified");
    expect(evaluateReadiness({ state: "in_setup", tasks, checks: { ghl_location: "verified" } }).canActivate).toBe(false);
    const ok = evaluateReadiness({ state: "ready_for_review", tasks, checks: { ghl_location: "verified" } });
    expect(ok.canActivate).toBe(true);
    expect(evaluateReadiness({ state: "ready_for_review", tasks, checks: { ghl_location: "attested" } })).toMatchObject({ canActivate: false, attestedChecks: ["ghl_location"] });
  });
});

describe("setup email", () => {
  it("sends nothing while only the capture provider is configured, even to opted-in people", async () => {
    const { org, owner } = await fresh("Email Capture Co");
    await withSystem((db) => db.query("insert into notification_preferences (user_id, org_id, prefs) values ($1, $2, $3)", [owner.id, org.id, JSON.stringify({ setupEmails: true })]));
    await finishOnboarding(org.id);
    const { rows } = await withSystem((db) => db.query("select 1 from email_outbox where template = 'setup_update'"));
    expect(rows).toHaveLength(0);
    // The in-app notification still arrives.
    const n = await withSystem((db) => db.query("select 1 from notifications where user_id = $1 and kind = 'setup_milestone'", [owner.id]));
    expect(n.rows.length).toBeGreaterThan(0);
  });

  it("emails only opted-in owners and admins through a configured provider, and records only what the provider accepted", async () => {
    const { org, owner } = await fresh("Email Opt In Co");
    const admin2 = await createUser();
    await addMember(org.id, admin2.id, "admin");
    await withSystem((db) => db.query("insert into notification_preferences (user_id, org_id, prefs) values ($1, $2, $3)", [owner.id, org.id, JSON.stringify({ setupEmails: true })]));
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      sent.push((JSON.parse(init.body) as { to: string[] }).to[0]);
      return new Response("{}", { status: 200 });
    });
    process.env.EMAIL_PROVIDER = "resend";
    process.env.RESEND_API_KEY = "re_test_key";
    resetEnvCache();
    try {
      await finishOnboarding(org.id);
      await new Promise((r) => setTimeout(r, 150));
      expect(sent).toEqual([owner.email, owner.email]); // company submission and workspace readiness milestones
      const { rows } = await withSystem((db) => db.query<{ to_email: string; status: string }>("select to_email, status from email_outbox where template = 'setup_update'"));
      expect(rows).toEqual([{ to_email: owner.email, status: "sent" }, { to_email: owner.email, status: "sent" }]);
    } finally {
      vi.unstubAllGlobals();
      delete process.env.EMAIL_PROVIDER;
      delete process.env.RESEND_API_KEY;
      resetEnvCache();
    }
  });
});

describe("provisioning and verification contracts", () => {
  it("never reports an unbuilt provisioning step as available", async () => {
    for (const p of Object.values(PROVISIONERS)) {
      expect(p.implemented).toBe(false);
      expect(CHECK_KEYS).toContain(p.verifiedBy);
      await expect(p.start({ orgId: "00000000-0000-4000-8000-000000000001", requestedBy: null, idempotencyKey: "k" })).resolves.toMatchObject({ state: "not_available" });
    }
  });

  it("has a connector for every check, and unimplemented ones always explain themselves and never pass", async () => {
    for (const key of CHECK_KEYS) {
      const c = CONNECTORS[key];
      expect(c.key).toBe(key);
      if (!c.implemented) {
        expect(c.unavailableReason).toBeTruthy();
        await expect(c.evaluate({ orgId: "00000000-0000-4000-8000-000000000001", actorUserId: null, live: true, applicable: [], stored: {} })).resolves.toMatchObject({ status: "unverified" });
      }
    }
  });
});

describe("database invariants", () => {
  it("rejects impossible checks and keeps events append-only", async () => {
    const { org } = await fresh("Invariant Co");
    await expect(withSystem((db) => db.query("insert into client_setup_checks (org_id, check_key, status, source) values ($1, 'calendar', 'verified', 'attestation')", [org.id]))).rejects.toThrow(/check constraint/i);
    await expect(withSystem((db) => db.query("insert into client_setup_checks (org_id, check_key, status, source) values ($1, 'calendar', 'attested', 'connector')", [org.id]))).rejects.toThrow(/check constraint/i);
    await expect(withSystem((db) => db.query("update client_setup_task_events set body = 'x' where org_id = $1", [org.id]))).rejects.toThrow(/append-only/);
    await expect(withSystem((db) => db.query("update client_setup_tasks set hidden = true where org_id = $1 and template_key = 'website_built'", [org.id]))).rejects.toThrow(/check constraint/i);
  });
});

afterAll(() => undefined);
