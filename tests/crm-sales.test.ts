import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { addStage, archivePipeline, createPipeline, deleteStage, DEFAULT_STAGES, ensureDefaultPipeline, listPipelines, reorderStages, updateStage } from "@/server/crm/pipelines";
import { archiveOpportunities, closeOpportunity, createOpportunity, getBoard, getOpportunityDetail, getPipelineMetrics, listOpportunities, moveOpportunity, reopenOpportunity, updateOpportunity } from "@/server/crm/opportunities";
import { addTaskComment, createTask, listTaskComments, listTasks, sendTaskReminders, setTaskStatus } from "@/server/crm/tasks";
import { createContact, mergeCrmContacts } from "@/server/crm/contacts";
import { listContacts } from "@/server/crm/directory";
import { getTimeline } from "@/server/crm/timeline";
import { agencyPeople, crmOrg, eventsFor, type CrmOrg } from "./support/crm";

let a: CrmOrg;
let b: CrmOrg;
beforeAll(async () => {
  a = await crmOrg({ name: "Sales Co" });
  b = await crmOrg({ name: "Other Sales Co" });
});

const stageNamed = async (org: CrmOrg, name: string) => {
  const p = (await listPipelines(org.actor("owner"), { ensureDefault: true }))[0];
  return { pipeline: p, stage: p.stages.find((s) => s.name === name)! };
};

describe("pipelines", () => {
  it("creates the default pipeline once, with the agreed stages and no invented probabilities, even if asked twice at once", async () => {
    const c = await crmOrg();
    await Promise.all([withSystem((db) => ensureDefaultPipeline(db, c.system)), listPipelines(c.actor("viewer"), { ensureDefault: true })]);
    const pipes = await listPipelines(c.actor("viewer"));
    expect(pipes).toHaveLength(1);
    expect(pipes[0].stages.map((s) => s.name)).toEqual(DEFAULT_STAGES.map((s) => s.name));
    expect(pipes[0].stages.every((s) => s.probability === null)).toBe(true);
    expect(pipes[0].isDefault).toBe(true);
  });

  it("validates stages, protects stages in use, and moves deals out of a removed stage with history", async () => {
    const c = await crmOrg();
    await expect(createPipeline(c.actor("sales"), { name: "Nope" })).rejects.toThrow(/role/);
    await expect(createPipeline(c.actor("owner"), { name: "Bad", stages: [{ name: "Won", kind: "won" }] })).rejects.toThrow(/open stage/);
    await expect(createPipeline(c.actor("owner"), { name: "Bad", stages: [{ name: "A" }, { name: "a" }] })).rejects.toThrow(/Two stages/);
    const p = await createPipeline(c.actor("owner"), { name: "Renovations", stages: [{ name: "Inquiry" }, { name: "Site visit", probability: 40 }, { name: "Signed", kind: "won" }] });
    const pipe = (await listPipelines(c.actor("owner"))).find((x) => x.id === p.id)!;
    const [inquiry, visit] = pipe.stages;
    const deal = await createOpportunity(c.actor("sales"), { name: "Kitchen", pipelineId: p.id, value: 5000 });
    await expect(updateStage(c.actor("owner"), inquiry.id, { kind: "won" })).rejects.toThrow(/at most one Won/);
    await expect(updateStage(c.actor("owner"), inquiry.id, { kind: "lost" })).rejects.toThrow(/can't change/);
    await expect(deleteStage(c.actor("owner"), inquiry.id, null)).rejects.toThrow(/Choose an open stage/);
    const r = await deleteStage(c.actor("owner"), inquiry.id, visit.id);
    expect(r.moved).toBe(1);
    expect((await getOpportunityDetail(c.actor("owner"), deal.id)).stageName).toBe("Site visit");
    await expect(deleteStage(c.actor("owner"), visit.id, null)).rejects.toThrow(/at least one open stage/);
    const added = await addStage(c.actor("owner"), p.id, { name: "Quote sent", probability: 60 });
    const order = (await listPipelines(c.actor("owner"))).find((x) => x.id === p.id)!.stages;
    await reorderStages(c.actor("owner"), p.id, [order.find((s) => s.id === added.id)!.id, ...order.filter((s) => s.id !== added.id).map((s) => s.id)]);
    expect((await listPipelines(c.actor("owner"))).find((x) => x.id === p.id)!.stages[0].name).toBe("Quote sent");
    await expect(archivePipeline(c.actor("owner"), p.id)).rejects.toThrow(/open deals/);
  });
});

describe("deals", () => {
  it("creates a deal in the default pipeline, once per idempotency key, with history, an event and a timeline entry", async () => {
    const contact = await createContact(a.actor("owner"), { firstName: "Deal", lastName: "Person" });
    const first = await createOpportunity(a.actor("setter"), { name: "Website redesign", contactId: contact.id, value: 1200.555 }, { idempotencyKey: "form-submission-123" });
    const again = await createOpportunity(a.actor("setter"), { name: "Website redesign", contactId: contact.id, value: 1200 }, { idempotencyKey: "form-submission-123" });
    expect(again.id).toBe(first.id);
    const d = await getOpportunityDetail(a.actor("viewer"), first.id);
    expect(d).toMatchObject({ stageName: "New Lead", status: "open", value: 1200.56, currency: "USD", contact: { id: contact.id, name: "Deal Person" } });
    expect(d.history).toHaveLength(1);
    expect((await eventsFor(a.org.id, "opportunity.created")).filter((e) => e.entity_id === first.id)).toHaveLength(1);
    const t = await getTimeline(a.actor("owner"), { contactId: contact.id });
    expect(t.items.some((i) => i.kind === "deal.open" && i.title.includes("Website redesign"))).toBe(true);
    await expect(createOpportunity(a.actor("viewer"), { name: "No" })).rejects.toThrow(/role/);
    await expect(createOpportunity(a.actor("support"), { name: "No" })).rejects.toThrow(/role/);
  });

  it("moves transactionally: same-stage drops and retries do nothing, real moves emit exactly one event, and stale moves are refused", async () => {
    const { stage: contacted } = await stageNamed(a, "Contacted");
    const deal = await createOpportunity(a.actor("sales"), { name: "Move me" });
    const d0 = await getOpportunityDetail(a.actor("sales"), deal.id);
    const m1 = await moveOpportunity(a.actor("sales"), deal.id, { stageId: contacted.id, expectedVersion: d0.version });
    expect(m1.changed).toBe(true);
    // The browser retried the same drop: nothing happens, no second automation trigger.
    const m2 = await moveOpportunity(a.actor("sales"), deal.id, { stageId: contacted.id });
    expect(m2.changed).toBe(false);
    const events = (await eventsFor(a.org.id, "opportunity.stage_changed")).filter((e) => e.entity_id === deal.id);
    expect(events).toHaveLength(1);
    const { stage: qualified } = await stageNamed(a, "Qualified");
    await expect(moveOpportunity(a.actor("sales"), deal.id, { stageId: qualified.id, expectedVersion: d0.version })).rejects.toThrow(/Someone else moved/);
    // Two people dragging the same card at once: exactly one wins.
    const v = (await getOpportunityDetail(a.actor("sales"), deal.id)).version;
    const results = await Promise.allSettled([
      moveOpportunity(a.actor("sales"), deal.id, { stageId: qualified.id, expectedVersion: v }),
      moveOpportunity(a.actor("manager"), deal.id, { stageId: (await stageNamed(a, "Negotiation")).stage.id, expectedVersion: v }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await getOpportunityDetail(a.actor("sales"), deal.id)).history).toHaveLength(3);
  });

  it("closes as won or lost with the right rules, and only managers reopen", async () => {
    const deal = await createOpportunity(a.actor("sales"), { name: "Close me", value: 800 });
    const { stage: won } = await stageNamed(a, "Won");
    const { stage: lost } = await stageNamed(a, "Lost");
    await expect(moveOpportunity(a.actor("sales"), deal.id, { stageId: lost.id })).rejects.toThrow(/why this deal was lost/);
    await moveOpportunity(a.actor("sales"), deal.id, { stageId: won.id });
    let d = await getOpportunityDetail(a.actor("sales"), deal.id);
    expect(d.status).toBe("won");
    expect(d.closedAt).not.toBeNull();
    expect((await eventsFor(a.org.id, "opportunity.won")).filter((e) => e.entity_id === deal.id)).toHaveLength(1);
    await expect(reopenOpportunity(a.actor("sales"), deal.id)).rejects.toThrow(/reopen permission/);
    await expect(moveOpportunity(a.actor("sales"), deal.id, { stageId: (await stageNamed(a, "Contacted")).stage.id })).rejects.toThrow(/reopen permission/);
    await reopenOpportunity(a.actor("manager"), deal.id);
    d = await getOpportunityDetail(a.actor("sales"), deal.id);
    expect(d.status).toBe("open");
    expect(d.closedAt).toBeNull();
    await closeOpportunity(a.actor("sales"), deal.id, "lost", { lostReason: "Chose a cheaper provider" });
    d = await getOpportunityDetail(a.actor("sales"), deal.id);
    expect(d).toMatchObject({ status: "lost", stageName: "Lost", lostReason: "Chose a cheaper provider" });
  });

  it("refuses another workspace's deal, stage or contact", async () => {
    const mine = await createOpportunity(a.actor("owner"), { name: "Mine" });
    const theirs = await createOpportunity(b.actor("owner"), { name: "Theirs" });
    const { stage: bStage } = await stageNamed(b, "Contacted");
    await expect(moveOpportunity(a.actor("owner"), theirs.id, { stageId: (await stageNamed(a, "Contacted")).stage.id })).rejects.toThrow(/not found/);
    await expect(moveOpportunity(a.actor("owner"), mine.id, { stageId: bStage.id })).rejects.toThrow(/not found/);
    await expect(getOpportunityDetail(a.actor("owner"), theirs.id)).rejects.toThrow(/not found/);
    const bContact = await createContact(b.actor("owner"), { firstName: "Theirs" });
    await expect(createOpportunity(a.actor("owner"), { name: "Steal", contactId: bContact.id })).rejects.toThrow(/not found/);
    await expect(updateOpportunity(a.actor("owner"), mine.id, { contactId: bContact.id })).rejects.toThrow(/not found/);
    const rls = await withUser(a.people.viewer.id, (db) => db.query<{ org_id: string }>("select org_id from crm_opportunities"));
    expect(rls.rows.every((r) => r.org_id === a.org.id)).toBe(true);
  });

  it("builds the board with per-stage counts and totals per currency, hiding long-closed deals", async () => {
    const c = await crmOrg();
    const { pipeline, stage: newLead } = await stageNamed(c, "New Lead");
    await createOpportunity(c.actor("owner"), { name: "USD deal", value: 100 });
    await createOpportunity(c.actor("owner"), { name: "PHP deal", value: 5000, currency: "PHP" });
    const old = await createOpportunity(c.actor("owner"), { name: "Old win", value: 999 });
    await closeOpportunity(c.actor("owner"), old.id, "won");
    await withSystem((db) => db.query("update crm_opportunities set closed_at = now() - interval '60 days' where id = $1", [old.id]));
    const board = await getBoard(c.actor("viewer"), pipeline.id);
    const col = board.find((x) => x.stage.id === newLead.id)!;
    expect(col.count).toBe(2);
    expect(col.totals.sort((x, y) => x.currency.localeCompare(y.currency))).toEqual([{ currency: "PHP", value: 5000 }, { currency: "USD", value: 100 }]);
    expect(board.find((x) => x.stage.kind === "won")!.count).toBe(0);
    expect((await getBoard(c.actor("viewer"), pipeline.id, { closedDays: 90 })).find((x) => x.stage.kind === "won")!.count).toBe(1);
    const table = await listOpportunities(c.actor("viewer"), { pipelineId: pipeline.id, status: "all", sort: { by: "value", dir: "desc" } });
    expect(table.rows.map((r) => r.value)).toEqual([5000, 999, 100]);
  });

  it("reports metrics only from recorded deals: no forecast without probabilities, win rate from closed deals", async () => {
    const c = await crmOrg();
    const { pipeline } = await stageNamed(c, "New Lead");
    const d1 = await createOpportunity(c.actor("owner"), { name: "A", value: 1000 });
    await createOpportunity(c.actor("owner"), { name: "B", value: 3000 });
    let m = await getPipelineMetrics(c.actor("viewer"), pipeline.id);
    expect(m.weightedForecast).toEqual([]);
    expect(m.dealsWithoutProbability).toBe(2);
    expect(m.winRate).toBeNull();
    await updateStage(c.actor("owner"), pipeline.stages[0].id, { probability: 10 });
    m = await getPipelineMetrics(c.actor("viewer"), pipeline.id);
    expect(m.weightedForecast).toEqual([{ currency: "USD", value: 400 }]);
    await closeOpportunity(c.actor("owner"), d1.id, "won");
    m = await getPipelineMetrics(c.actor("viewer"), pipeline.id);
    expect(m).toMatchObject({ wonCount: 1, lostCount: 0, winRate: 100, wonValue: [{ currency: "USD", value: 1000 }], createdCount: 2 });
    expect(m.byStage[0].avgDaysInStage).toBe(0);
  });

  it("contact Smart List filters see native deals", async () => {
    const c = await crmOrg();
    const p = await createContact(c.actor("owner"), { firstName: "Has", lastName: "Deal" });
    await createContact(c.actor("owner"), { firstName: "No", lastName: "Deal" });
    await createOpportunity(c.actor("owner"), { name: "Deal", contactId: p.id });
    const { stage } = await stageNamed(c, "New Lead");
    const open = await listContacts(c.actor("owner"), { filter: { op: "and", conditions: [{ field: "opportunity", op: "has_open" }] } });
    expect(open.rows.map((r) => r.id)).toEqual([p.id]);
    const inStage = await listContacts(c.actor("owner"), { filter: { op: "and", conditions: [{ field: "opportunity", op: "in_stage", value: [stage.id] }] } });
    expect(inStage.total).toBe(1);
    const none = await listContacts(c.actor("owner"), { filter: { op: "and", conditions: [{ field: "opportunity", op: "has_none" }] } });
    expect(none.total).toBe(1);
  });

  it("a contact merge carries deals and tasks to the kept contact", async () => {
    const c = await crmOrg();
    const kept = await createContact(c.actor("owner"), { firstName: "Kept" });
    const gone = await createContact(c.actor("owner"), { firstName: "Gone" });
    const deal = await createOpportunity(c.actor("owner"), { name: "Follows", contactId: gone.id });
    await createTask(c.actor("owner"), { title: "Call", contactId: gone.id });
    await mergeCrmContacts(c.actor("owner"), { keptId: kept.id, mergedId: gone.id, reason: "Same customer" });
    expect((await getOpportunityDetail(c.actor("owner"), deal.id)).contact?.id).toBe(kept.id);
    expect((await listTasks(c.actor("owner"), { view: "team", contactId: kept.id }))).toHaveLength(1);
  });

  it("archives deals only with permission", async () => {
    const deal = await createOpportunity(a.actor("owner"), { name: "Archive" });
    await expect(archiveOpportunities(a.actor("sales"), [deal.id])).rejects.toThrow(/role/);
    await archiveOpportunities(a.actor("manager"), [deal.id]);
    await expect(getOpportunityDetail(a.actor("owner"), deal.id)).rejects.toThrow(/not found/);
  });
});

describe("tasks", () => {
  it("assigns with a notification, completes, comments, and reminds exactly once", async () => {
    const contact = await createContact(a.actor("owner"), { firstName: "Task", lastName: "Contact" });
    await expect(createTask(a.actor("viewer"), { title: "No" })).rejects.toThrow(/role/);
    const t = await createTask(a.actor("manager"), { title: "Call back about pricing", priority: "high", assigneeId: a.people.sales.id, contactId: contact.id, dueAt: new Date(Date.now() - 3600_000).toISOString(), remindAt: new Date(Date.now() - 60_000).toISOString() });
    const notes = await withSystem((db) => db.query("select kind from notifications where user_id = $1 and dedupe_key like 'crm-task%'", [a.people.sales.id]));
    expect(notes.rows.length).toBe(1);
    const mine = await listTasks(a.actor("sales"), { view: "mine" });
    expect(mine.find((x) => x.id === t.id)).toMatchObject({ overdue: true, priority: "high", contact: { name: "Task Contact" } });
    expect((await listTasks(a.actor("manager"), { view: "overdue" })).map((x) => x.id)).toContain(t.id);
    expect((await sendTaskReminders()).sent).toBeGreaterThanOrEqual(1);
    expect((await sendTaskReminders()).sent).toBe(0);
    await addTaskComment(a.actor("sales"), t.id, "Left a voicemail.");
    expect((await listTaskComments(a.actor("manager"), t.id))[0].body).toBe("Left a voicemail.");
    await setTaskStatus(a.actor("sales"), t.id, "in_progress");
    expect((await setTaskStatus(a.actor("sales"), t.id, "done")).changed).toBe(true);
    expect((await listTasks(a.actor("sales"), { view: "completed" })).map((x) => x.id)).toContain(t.id);
    const timeline = await getTimeline(a.actor("owner"), { contactId: contact.id });
    expect(timeline.items.some((i) => i.kind === "task.completed")).toBe(true);
  });

  it("hides customer-linked tasks from agency staff outside a support session", async () => {
    const people = await agencyPeople();
    await withSystem((db) => db.query("insert into staff_assignments (org_id, user_id) values ($1, $2)", [a.org.id, people.staff.id]));
    const contact = await createContact(a.actor("owner"), { firstName: "Private" });
    await createTask(a.actor("owner"), { title: "About a customer", contactId: contact.id });
    await createTask(a.actor("owner"), { title: "General admin" });
    const seen = await withUser(people.staff.id, (db) => db.query<{ title: string; contact_id: string | null }>("select title, contact_id from tasks where org_id = $1", [a.org.id]));
    expect(seen.rows.every((r) => r.contact_id === null)).toBe(true);
    expect(seen.rows.map((r) => r.title)).toContain("General admin");
  });
});
