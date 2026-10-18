import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
// The screen is rendered to HTML below without a browser: navigation and server actions are inert stand-ins there.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {}, replace() {} }), usePathname: () => "/crm/settings/assignment" }));
vi.mock("@/app/actions/crm-assignment", () => {
  const ok = async () => ({ ok: true, data: null });
  return { createAssignmentRuleAction: ok, updateAssignmentRuleAction: ok, setAssignmentRuleActiveAction: ok, moveAssignmentRuleAction: ok, deleteAssignmentRuleAction: ok, assignmentHistoryAction: ok };
});
vi.mock("@/app/actions/crm", () => ({ searchContactsAction: async () => ({ ok: true, data: [] }) }));
import { withSystem } from "@/server/db";
import { scopeFor } from "@/server/crm/page";
import { AssignmentView } from "@/components/crm/views/assignment-view";
import {
  assignWithRule, autoAssignForEvent, createAssignmentRule, deleteAssignmentRule, isWorkingAt, listAssignmentHistory, listAssignmentRules, moveAssignmentRule, pickMember,
  readConditions, setAssignmentRuleActive, updateAssignmentRule, type AssignmentCandidate, type AssignmentEvent, type AssignmentRuleInput,
} from "@/server/crm/assignment";
import { assignContacts, createContact, linkContactCompany } from "@/server/crm/contacts";
import { createCompany } from "@/server/crm/companies";
import { createOpportunity } from "@/server/crm/opportunities";
import type { CrmActor } from "@/server/crm/actor";
import { crmOrg, eventsFor, type CrmOrg } from "./support/crm";

let a: CrmOrg;
let b: CrmOrg;
beforeAll(async () => {
  a = await crmOrg({ name: "Routing Co" });
  b = await crmOrg({ name: "Other Routing Co" });
});

// A Monday at 10:00 UTC, and the same evening.
const MONDAY_10 = new Date("2026-10-19T10:00:00Z");
const MONDAY_20 = new Date("2026-10-19T20:00:00Z");

async function eventFor(org: CrmOrg, type: string, entityId: string): Promise<AssignmentEvent> {
  const { rows } = await withSystem((db) =>
    db.query<{ id: string; type: string; entity_type: string; entity_id: string | null; contact_id: string | null; payload: Record<string, unknown>; depth: number }>(
      "select id::text as id, type, entity_type, entity_id, contact_id, payload, depth from crm_events where org_id = $1 and type = $2 and entity_id = $3 order by id desc limit 1",
      [org.org.id, type, entityId],
    ),
  );
  const r = rows[0];
  if (!r) throw new Error(`no ${type} event for ${entityId}`);
  return { id: Number(r.id), orgId: org.org.id, type: r.type, entityType: r.entity_type, entityId: r.entity_id, contactId: r.contact_id, payload: r.payload, depth: r.depth };
}

/** Runs the assignment subscriber on a record's latest event of this type, as the dispatcher does (in its own transaction). */
async function runEvent(org: CrmOrg, type: string, entityId: string) {
  const event = await eventFor(org, type, entityId);
  return withSystem((db) => autoAssignForEvent(db, event));
}

/** Creates a contact as the owner (no owner set) and runs the dispatcher's assignment subscriber on its contact.created event. */
async function newLead(org: CrmOrg, input: Parameters<typeof createContact>[1] = {}, now?: Date) {
  const c = await createContact(org.actor("owner"), { firstName: "Lead", lastName: `${Math.random().toString(36).slice(2, 8)}`, ...input });
  const event = await eventFor(org, "contact.created", c.id);
  const result = await withSystem((db) => autoAssignForEvent(db, event, { now }));
  return { id: c.id, event, result };
}

const ownerOf = async (contactId: string) => (await withSystem((db) => db.query<{ assigned_user_id: string | null }>("select assigned_user_id from contacts where id = $1", [contactId]))).rows[0].assigned_user_id;

async function freshRuleSet(org: CrmOrg) {
  // Each scenario starts from no rules, so earlier rules don't match first. The history is append-only (no updates), so the test clears it
  // before removing the rules it names.
  await withSystem(async (db) => {
    await db.query("delete from crm_assignment_history where org_id = $1", [org.org.id]);
    await db.query("delete from crm_assignment_rules where org_id = $1", [org.org.id]);
  });
}

const rule = (org: CrmOrg, input: Partial<AssignmentRuleInput> & { members?: AssignmentRuleInput["members"] }) =>
  createAssignmentRule(org.actor("owner"), { name: "Inbound leads", entity: "contact", strategy: "round_robin", ...input } as AssignmentRuleInput);

describe("choosing a person (pure)", () => {
  const c = (userId: string, over: Partial<AssignmentCandidate> = {}): AssignmentCandidate => ({ userId, weight: 1, priority: 50, assignedCount: 0, lastAssignedAt: null, ...over });

  it("round robin takes the least recently assigned, never-assigned first, deterministically", () => {
    expect(pickMember("round_robin", [c("b", { lastAssignedAt: 200 }), c("a", { lastAssignedAt: 100 })])?.userId).toBe("a");
    expect(pickMember("round_robin", [c("b", { lastAssignedAt: 100 }), c("z")])?.userId).toBe("z");
    expect(pickMember("round_robin", [c("b"), c("a")])?.userId).toBe("a");
    expect(pickMember("round_robin", [])).toBeNull();
  });

  it("weighted round robin follows the weights over time and interleaves turns", () => {
    const people = [c("heavy", { weight: 2 }), c("light", { weight: 1 })];
    const order: string[] = [];
    for (let t = 1; t <= 9; t++) {
      const p = pickMember("weighted", people)!;
      order.push(p.userId);
      p.assignedCount += 1;
      p.lastAssignedAt = t;
    }
    expect(order.filter((x) => x === "heavy")).toHaveLength(6);
    expect(order.filter((x) => x === "light")).toHaveLength(3);
    // Smooth: the light member never waits more than two turns.
    expect(order.join(",")).not.toMatch(/heavy,heavy,heavy/);
  });

  it("priority takes the highest priority, and equal priorities take turns", () => {
    expect(pickMember("priority", [c("low", { priority: 10 }), c("high", { priority: 90 })])?.userId).toBe("high");
    expect(pickMember("priority", [c("x", { priority: 70, lastAssignedAt: 50 }), c("y", { priority: 70, lastAssignedAt: 10 }), c("z", { priority: 20 })])?.userId).toBe("y");
  });

  it("works out whether someone is inside their working hours in their own time zone, with days off", () => {
    const host = { timezone: "Asia/Manila", rules: [{ weekday: 1, startMinute: 9 * 60, endMinute: 17 * 60 }], overrides: [] };
    expect(isWorkingAt(host, new Date("2026-10-19T02:00:00Z"))).toBe(true); // 10:00 Monday in Manila
    expect(isWorkingAt(host, new Date("2026-10-19T10:00:00Z"))).toBe(false); // 18:00 Monday in Manila
    expect(isWorkingAt({ ...host, overrides: [{ date: "2026-10-19", startMinute: null, endMinute: null }] }, new Date("2026-10-19T02:00:00Z"))).toBe(false);
    expect(isWorkingAt({ timezone: "UTC", rules: [], overrides: [] }, MONDAY_10)).toBe(false);
  });

  it("reads the stored conditions and the reassignment switch kept beside them", () => {
    expect(readConditions({ op: "and", conditions: [], reassignOwned: true })).toMatchObject({ reassignOwned: true, valid: true, filter: { op: "and", conditions: [] } });
    expect(readConditions({ nonsense: 1 })).toMatchObject({ valid: false, reassignOwned: false });
  });
});

describe("managing rules", () => {
  it("validates rules, keeps them per workspace and lets only people with the assign permission change them", async () => {
    await freshRuleSet(a);
    await expect(rule(a, { name: " ", members: [{ userId: a.people.sales.id }] })).rejects.toThrow(/name/);
    await expect(rule(a, { members: [] })).rejects.toThrow(/at least one team member/);
    await expect(rule(a, { members: [{ userId: b.people.sales.id }] })).rejects.toThrow(/active teammate/);
    await expect(rule(a, { members: [{ userId: a.people.sales.id, weight: 0 }], strategy: "weighted" })).rejects.toThrow(/weight/);
    await expect(rule(a, { members: [{ userId: a.people.sales.id }], conditions: { op: "and", conditions: [{ field: "owner", op: "is_me" }] } })).rejects.toThrow(/Owner is me/);
    await expect(rule(a, { members: [{ userId: a.people.sales.id }], conditions: { op: "and", conditions: [{ field: "no_such_field", op: "equals", value: "x" }] } })).rejects.toThrow(/doesn't exist/);
    await expect(rule(a, { members: [{ userId: a.people.sales.id }], fallback: "fallback_user" })).rejects.toThrow(/Choose who gets/);
    await expect(createAssignmentRule(a.actor("sales"), { name: "Nope", entity: "contact", strategy: "round_robin", members: [{ userId: a.people.sales.id }] })).rejects.toThrow(/assign permission/);
    await expect(listAssignmentRules(a.actor("sales"))).rejects.toThrow(/assign permission/);

    const first = await rule(a, { name: "First", members: [{ userId: a.people.sales.id }, { userId: a.people.setter.id }] });
    const second = await rule(a, { name: "Second", members: [{ userId: a.people.sales.id }] });
    let list = (await listAssignmentRules(a.actor("manager"))).filter((r) => r.entity === "contact");
    expect(list.map((r) => r.name)).toEqual(["First", "Second"]);
    expect(list[0].members.map((m) => m.userId).sort()).toEqual([a.people.sales.id, a.people.setter.id].sort());
    expect(await listAssignmentRules(b.actor("owner"))).toEqual([]);

    expect(await moveAssignmentRule(a.actor("owner"), second.id, "up")).toEqual({ moved: true });
    expect(await moveAssignmentRule(a.actor("owner"), second.id, "up")).toEqual({ moved: false });
    list = (await listAssignmentRules(a.actor("owner"))).filter((r) => r.entity === "contact");
    expect(list.map((r) => r.name)).toEqual(["Second", "First"]);

    await updateAssignmentRule(a.actor("owner"), first.id, { name: "First, renamed", entity: "contact", strategy: "priority", members: [{ userId: a.people.setter.id, priority: 80 }] });
    await expect(updateAssignmentRule(a.actor("owner"), first.id, { name: "Switch", entity: "opportunity", strategy: "round_robin", members: [{ userId: a.people.setter.id }] })).rejects.toThrow(/keeps the kind/);
    await setAssignmentRuleActive(a.actor("owner"), first.id, false);
    list = (await listAssignmentRules(a.actor("owner"))).filter((r) => r.entity === "contact");
    expect(list.find((r) => r.id === first.id)).toMatchObject({ name: "First, renamed", strategy: "priority", active: false, members: [{ userId: a.people.setter.id, priority: 80 }] });

    // Another workspace can't touch these rules.
    await expect(setAssignmentRuleActive(b.actor("owner"), first.id, true)).rejects.toThrow(/no longer exists/);
    await expect(deleteAssignmentRule(b.actor("owner"), first.id)).rejects.toThrow(/no longer exists/);
    await deleteAssignmentRule(a.actor("owner"), first.id);
    expect((await listAssignmentRules(a.actor("owner"))).filter((r) => r.entity === "contact").map((r) => ({ name: r.name, position: r.position }))).toEqual([{ name: "Second", position: 0 }]);
  });
});

describe("automatic assignment of new contacts", () => {
  it("round robin shares new leads out in turn, records why, emits one contact.assigned with a deterministic key and notifies the person", async () => {
    await freshRuleSet(a);
    const r = await rule(a, { members: [{ userId: a.people.sales.id }, { userId: a.people.setter.id }, { userId: a.people.support.id }] });
    const leads = [];
    for (let i = 0; i < 6; i++) leads.push(await newLead(a));
    const owners = await Promise.all(leads.map((l) => ownerOf(l.id)));
    expect(leads.every((l) => l.result?.status === "assigned" && l.result.ruleId === r.id)).toBe(true);
    // Every member got two, and no one got two in a row.
    for (const id of [a.people.sales.id, a.people.setter.id, a.people.support.id]) expect(owners.filter((o) => o === id)).toHaveLength(2);
    for (let i = 1; i < owners.length; i++) expect(owners[i]).not.toBe(owners[i - 1]);

    const lead = leads[0];
    const assigned = (await eventsFor(a.org.id, "contact.assigned")).filter((e) => e.entity_id === lead.id);
    expect(assigned).toHaveLength(1);
    expect(assigned[0]).toMatchObject({ payload: { to: owners[0], ruleId: r.id, via: "assignment_rule" }, depth: 1 });
    const key = await withSystem((db) => db.query<{ dedupe_key: string }>("select dedupe_key from crm_events where org_id = $1 and type = 'contact.assigned' and entity_id = $2", [a.org.id, lead.id]));
    expect(key.rows[0].dedupe_key).toBe(`contact.assigned:${lead.id}:rule:${r.id}:${lead.event.id}`);
    const note = await withSystem((db) => db.query<{ user_id: string; kind: string; link: string }>("select user_id, kind, link from notifications where org_id = $1 and kind = 'crm_assigned' and link = $2", [a.org.id, `/crm/contacts/${lead.id}`]));
    expect(note.rows).toEqual([{ user_id: owners[0], kind: "crm_assigned", link: `/crm/contacts/${lead.id}` }]);

    const history = await listAssignmentHistory(a.actor("manager"), { entity: "contact", entityId: lead.id });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ outcome: "assigned", ruleName: "Inbound leads", userId: owners[0], recordLive: true });
    expect(history[0].reason).toMatch(/Round robin/);
  });

  it("decides each event once: a redelivered event returns the earlier decision and changes nothing", async () => {
    await freshRuleSet(a);
    await rule(a, { members: [{ userId: a.people.sales.id }, { userId: a.people.setter.id }] });
    const lead = await newLead(a);
    const counters = async () => (await withSystem((db) => db.query<{ user_id: string; assigned_count: number }>("select user_id, assigned_count from crm_assignment_members where org_id = $1 order by user_id", [a.org.id]))).rows;
    const before = await counters();
    const again = await withSystem((db) => autoAssignForEvent(db, lead.event));
    expect(again).toMatchObject({ duplicate: true, status: "assigned", userId: lead.result?.userId });
    expect(await counters()).toEqual(before);
    expect((await listAssignmentHistory(a.actor("owner"), { entity: "contact", entityId: lead.id }))).toHaveLength(1);
    expect((await eventsFor(a.org.id, "contact.assigned")).filter((e) => e.entity_id === lead.id)).toHaveLength(1);
  });

  it("gives two leads arriving at the same moment to two different people (the rule row is locked for each decision)", async () => {
    await freshRuleSet(a);
    await rule(a, { members: [{ userId: a.people.sales.id }, { userId: a.people.setter.id }] });
    const one = await createContact(a.actor("owner"), { firstName: "Same", lastName: "Time 1" });
    const two = await createContact(a.actor("owner"), { firstName: "Same", lastName: "Time 2" });
    const [e1, e2] = await Promise.all([eventFor(a, "contact.created", one.id), eventFor(a, "contact.created", two.id)]);
    const [r1, r2] = await Promise.all([withSystem((db) => autoAssignForEvent(db, e1)), withSystem((db) => autoAssignForEvent(db, e2))]);
    expect(r1?.userId).toBeTruthy();
    expect(r2?.userId).toBeTruthy();
    expect(r1?.userId).not.toBe(r2?.userId);
  });

  it("uses the first matching rule in order, with conditions from the Smart List language", async () => {
    await freshRuleSet(a);
    const web = await rule(a, { name: "Website", conditions: { op: "and", conditions: [{ field: "source", op: "equals", value: "website" }] }, members: [{ userId: a.people.sales.id }] });
    const rest = await rule(a, { name: "Everyone else", members: [{ userId: a.people.setter.id }] });
    const fromWeb = await newLead(a, { source: "website" });
    const fromAds = await newLead(a, { source: "facebook ads" });
    expect(fromWeb.result).toMatchObject({ ruleId: web.id, userId: a.people.sales.id });
    expect(fromAds.result).toMatchObject({ ruleId: rest.id, userId: a.people.setter.id });
    // Reordered: the catch-all now runs first and takes everyone.
    await moveAssignmentRule(a.actor("owner"), rest.id, "up");
    expect((await newLead(a, { source: "website" })).result).toMatchObject({ ruleId: rest.id });
  });

  it("skips paused people, and falls back to a named person or leaves the lead unassigned when nobody is available", async () => {
    await freshRuleSet(a);
    const r = await rule(a, { members: [{ userId: a.people.sales.id, paused: true }, { userId: a.people.setter.id }], fallback: "fallback_user", fallbackUserId: a.people.manager.id });
    expect((await newLead(a)).result).toMatchObject({ status: "assigned", userId: a.people.setter.id });
    expect((await newLead(a)).result).toMatchObject({ status: "assigned", userId: a.people.setter.id });
    await updateAssignmentRule(a.actor("owner"), r.id, { name: "Inbound leads", entity: "contact", strategy: "round_robin", members: [{ userId: a.people.sales.id, paused: true }, { userId: a.people.setter.id, paused: true }], fallback: "fallback_user", fallbackUserId: a.people.manager.id });
    const fb = await newLead(a);
    expect(fb.result).toMatchObject({ status: "fallback", userId: a.people.manager.id });
    expect(fb.result?.reason).toMatch(/2 paused/);
    expect(await ownerOf(fb.id)).toBe(a.people.manager.id);
    await updateAssignmentRule(a.actor("owner"), r.id, { name: "Inbound leads", entity: "contact", strategy: "round_robin", members: [{ userId: a.people.sales.id, paused: true }], fallback: "unassigned" });
    const none = await newLead(a);
    expect(none.result).toMatchObject({ status: "unassigned", userId: null });
    expect(await ownerOf(none.id)).toBeNull();
    expect((await listAssignmentHistory(a.actor("owner"), { entity: "contact", entityId: none.id }))[0]).toMatchObject({ outcome: "unassigned" });
  });

  it("with working hours on, only gives leads to people working now who accept new work", async () => {
    await freshRuleSet(a);
    await withSystem(async (db) => {
      await db.query("delete from crm_availability_rules where org_id = $1", [a.org.id]);
      await db.query("insert into crm_host_settings (org_id, user_id, timezone, accepting) values ($1, $2, 'UTC', true), ($1, $3, 'UTC', false) on conflict (org_id, user_id) do update set timezone = excluded.timezone, accepting = excluded.accepting", [a.org.id, a.people.sales.id, a.people.support.id]);
      // Sales and support work Mondays 09:00 to 17:00 UTC; the setter has no hours at all; support isn't accepting new work.
      for (const id of [a.people.sales.id, a.people.support.id]) await db.query("insert into crm_availability_rules (org_id, user_id, weekday, start_minute, end_minute) values ($1, $2, 1, 540, 1020)", [a.org.id, id]);
    });
    await rule(a, { respectWorkingHours: true, members: [{ userId: a.people.sales.id }, { userId: a.people.setter.id }, { userId: a.people.support.id }], fallback: "fallback_user", fallbackUserId: a.people.owner.id });
    const morning = await newLead(a, {}, MONDAY_10);
    expect(morning.result).toMatchObject({ status: "assigned", userId: a.people.sales.id });
    expect((await newLead(a, {}, MONDAY_10)).result).toMatchObject({ status: "assigned", userId: a.people.sales.id });
    const evening = await newLead(a, {}, MONDAY_20);
    expect(evening.result).toMatchObject({ status: "fallback", userId: a.people.owner.id });
    expect(evening.result?.reason).toMatch(/outside working hours/);
    expect(evening.result?.reason).toMatch(/not accepting/);
    const view = (await listAssignmentRules(a.actor("owner"), { now: MONDAY_10 })).find((r) => r.respectWorkingHours)!;
    expect(view.members.find((m) => m.userId === a.people.setter.id)).toMatchObject({ hasWorkingHours: false, workingNow: false });
    expect(view.members.find((m) => m.userId === a.people.sales.id)).toMatchObject({ hasWorkingHours: true, workingNow: true, accepting: true });
    await withSystem((db) => db.query("delete from crm_host_settings where org_id = $1", [a.org.id]));
  });

  it("weighted rules share leads in proportion to weight, and priority rules prefer the highest priority available", async () => {
    await freshRuleSet(a);
    await rule(a, { strategy: "weighted", members: [{ userId: a.people.sales.id, weight: 3 }, { userId: a.people.setter.id, weight: 1 }] });
    const owners: Array<string | null> = [];
    for (let i = 0; i < 8; i++) owners.push((await newLead(a)).result?.userId ?? null);
    expect(owners.filter((o) => o === a.people.sales.id)).toHaveLength(6);
    expect(owners.filter((o) => o === a.people.setter.id)).toHaveLength(2);

    await freshRuleSet(a);
    const p = await rule(a, { strategy: "priority", members: [{ userId: a.people.sales.id, priority: 90 }, { userId: a.people.setter.id, priority: 40 }] });
    expect((await newLead(a)).result?.userId).toBe(a.people.sales.id);
    expect((await newLead(a)).result?.userId).toBe(a.people.sales.id);
    await updateAssignmentRule(a.actor("owner"), p.id, { name: "Inbound leads", entity: "contact", strategy: "priority", members: [{ userId: a.people.sales.id, priority: 90, paused: true }, { userId: a.people.setter.id, priority: 40 }] });
    expect((await newLead(a)).result?.userId).toBe(a.people.setter.id);
  });

  it("never reassigns a contact that already has an owner, and leaves imported contacts to the import", async () => {
    await freshRuleSet(a);
    await rule(a, { members: [{ userId: a.people.sales.id }] });
    const owned = await createContact(a.actor("owner"), { firstName: "Already", lastName: "Owned", ownerId: a.people.setter.id });
    const res = await runEvent(a, "contact.created", owned.id);
    expect(res).toMatchObject({ status: "kept_owner", userId: a.people.setter.id });
    expect(await ownerOf(owned.id)).toBe(a.people.setter.id);
    const imported = await createContact(a.actor("owner"), { firstName: "From", lastName: "Import" });
    const ev = await eventFor(a, "contact.created", imported.id);
    expect(await withSystem((db) => autoAssignForEvent(db, { ...ev, payload: { ...ev.payload, via: "import" } }))).toBeNull();
    expect(await ownerOf(imported.id)).toBeNull();
    // Events this subscriber doesn't handle are ignored.
    expect(await withSystem((db) => autoAssignForEvent(db, { ...ev, type: "contact.updated" }))).toBeNull();
  });

  it("gives a manual assignment a deterministic event key too (the contact's version), so back-and-forth changes are each recorded once", async () => {
    const c = await createContact(a.actor("owner"), { firstName: "Manual", lastName: "Owner" });
    await assignContacts(a.actor("owner"), [c.id], a.people.sales.id);
    await assignContacts(a.actor("owner"), [c.id], a.people.setter.id);
    await assignContacts(a.actor("owner"), [c.id], a.people.sales.id);
    const { rows } = await withSystem((db) => db.query<{ dedupe_key: string; payload: { to: string } }>(
      "select dedupe_key, payload from crm_events where org_id = $1 and type = 'contact.assigned' and entity_id = $2 order by id",
      [a.org.id, c.id],
    ));
    const version = (await withSystem((db) => db.query<{ version: number }>("select version from contacts where id = $1", [c.id]))).rows[0].version;
    expect(rows.map((r) => r.payload.to)).toEqual([a.people.sales.id, a.people.setter.id, a.people.sales.id]);
    expect(rows.map((r) => r.dedupe_key)).toEqual([version - 2, version - 1, version].map((v) => `contact.assigned:${c.id}:v${v}`));
  });

  it("does nothing for a workspace whose contacts GoHighLevel owns", async () => {
    const g = await crmOrg({ name: "GHL Routing Co" });
    await rule(g, { members: [{ userId: g.people.sales.id }] });
    const c = await createContact(g.actor("owner"), { firstName: "Before", lastName: "Switch" });
    const ev = await eventFor(g, "contact.created", c.id);
    await withSystem((db) => db.query("update crm_workspaces set mode = 'ghl' where org_id = $1", [g.org.id]));
    expect(await withSystem((db) => autoAssignForEvent(db, ev))).toBeNull();
    expect(await ownerOf(c.id)).toBeNull();
  });
});

describe("deals, keep-existing-owner and workflow steps", () => {
  it("routes new deals, and keep-existing-owner gives a deal to its contact's owner", async () => {
    await freshRuleSet(a);
    const contact = await createContact(a.actor("owner"), { firstName: "Deal", lastName: "Contact", ownerId: a.people.setter.id });
    const keep = await createAssignmentRule(a.actor("owner"), { name: "Deals follow the contact", entity: "opportunity", strategy: "keep_existing_owner", fallback: "fallback_user", fallbackUserId: a.people.manager.id });
    const deal = await createOpportunity(a.actor("owner"), { name: "Big job", contactId: contact.id });
    const r = await runEvent(a, "opportunity.created", deal.id);
    expect(r).toMatchObject({ status: "assigned", userId: a.people.setter.id, ruleId: keep.id });
    expect((await withSystem((db) => db.query<{ assigned_user_id: string }>("select assigned_user_id from crm_opportunities where id = $1", [deal.id]))).rows[0].assigned_user_id).toBe(a.people.setter.id);
    expect((await eventsFor(a.org.id, "opportunity.updated")).some((e) => e.entity_id === deal.id && (e.payload as { ruleId?: string }).ruleId === keep.id)).toBe(true);
    // A deal without a contact owner goes to the fallback person.
    const loose = await createOpportunity(a.actor("owner"), { name: "No contact" });
    const r2 = await runEvent(a, "opportunity.created", loose.id);
    expect(r2).toMatchObject({ status: "fallback", userId: a.people.manager.id });
    // A rule that has decided something is kept for the history: it can be switched off, not deleted.
    await expect(deleteAssignmentRule(a.actor("owner"), keep.id)).rejects.toThrow(/Switch it off instead/);
    await setAssignmentRuleActive(a.actor("owner"), keep.id, false);
  });

  it("keep-existing-owner gives an unowned contact to its primary company's owner", async () => {
    await freshRuleSet(a);
    const company = await createCompany(a.actor("owner"), { name: `Acme ${Math.random().toString(36).slice(2, 7)}`, ownerId: a.people.sales.id });
    const c = await createContact(a.actor("owner"), { firstName: "Company", lastName: "Person" });
    await linkContactCompany(a.actor("owner"), { contactId: c.id, companyId: company.id, primary: true });
    await createAssignmentRule(a.actor("owner"), { name: "Company owner", entity: "contact", strategy: "keep_existing_owner" });
    const r = await runEvent(a, "contact.created", c.id);
    expect(r).toMatchObject({ status: "assigned", userId: a.people.sales.id });
  });

  it("assigns through a rule from a workflow step: conditions apply, owned records are kept unless the rule reassigns, decided afresh each time", async () => {
    await freshRuleSet(a);
    const r = await rule(a, { name: "Hot leads", members: [{ userId: a.people.sales.id }], conditions: { op: "and", conditions: [{ field: "lead_status", op: "in", value: ["qualified"] }] } });
    const c = await createContact(a.actor("owner"), { firstName: "Workflow", lastName: "Lead", ownerId: a.people.setter.id, leadStatus: "qualified" });
    const ev = await eventFor(a, "contact.created", c.id);
    const step = (ruleId = r.id, entityId = c.id, eventId = ev.id) => withSystem((db) => assignWithRule(db, a.system, { ruleId, entity: "contact", entityId, causedBy: { eventId, depth: 1 } }));
    expect(await step()).toMatchObject({ status: "kept_owner", userId: a.people.setter.id });
    await updateAssignmentRule(a.actor("owner"), r.id, { name: "Hot leads", entity: "contact", strategy: "round_robin", reassignOwned: true, members: [{ userId: a.people.sales.id }], conditions: { op: "and", conditions: [{ field: "lead_status", op: "in", value: ["qualified"] }] } });
    expect((await listAssignmentRules(a.actor("owner"))).find((x) => x.id === r.id)?.reassignOwned).toBe(true);
    // The same triggering event again (another step, or a later visit of this one): a step decides afresh instead of being answered with
    // an earlier decision for that event (review finding 2), so this time the rule reassigns. The step's own transaction is what keeps one
    // step from assigning twice; only the dispatcher's auto-assignment is idempotent per event.
    const moved = await step();
    expect(moved).toMatchObject({ status: "assigned", userId: a.people.sales.id, duplicate: false });
    expect(await ownerOf(c.id)).toBe(a.people.sales.id);
    const trigger = await createContact(a.actor("owner"), { firstName: "Trigger", lastName: "Event" });
    const tid = (await eventFor(a, "contact.created", trigger.id)).id;

    const cold = await createContact(a.actor("owner"), { firstName: "Cold", lastName: "Lead", leadStatus: "new" });
    expect(await step(r.id, cold.id, (await eventFor(a, "contact.created", cold.id)).id)).toMatchObject({ status: "skipped" });
    await setAssignmentRuleActive(a.actor("owner"), r.id, false);
    expect(await step(r.id, cold.id, tid)).toMatchObject({ status: "skipped", reason: expect.stringMatching(/switched off/) });
    await expect(withSystem((db) => assignWithRule(db, a.system, { ruleId: r.id, entity: "opportunity", entityId: cold.id }))).rejects.toThrow(/assigns contacts/);
    // Another workspace's actor can't use this rule.
    expect(await withSystem((db) => assignWithRule(db, b.system, { ruleId: r.id, entity: "contact", entityId: cold.id }))).toMatchObject({ status: "skipped", reason: expect.stringMatching(/no longer exists/) });
    await expect(withSystem((db) => assignWithRule(db, a.actor("sales"), { ruleId: r.id, entity: "contact", entityId: cold.id }))).rejects.toThrow(/assign permission/);
  });

  it("shows decisions to people who can see contacts, and keeps deal decisions from people who can't see deals", async () => {
    await freshRuleSet(a);
    await rule(a, { members: [{ userId: a.people.sales.id }] });
    await createAssignmentRule(a.actor("owner"), { name: "Deals", entity: "opportunity", strategy: "round_robin", members: [{ userId: a.people.setter.id }] });
    await newLead(a);
    const deal = await createOpportunity(a.actor("owner"), { name: "Visible deal" });
    await runEvent(a, "opportunity.created", deal.id);
    const recent = await listAssignmentHistory(a.actor("viewer"), { limit: 200 });
    expect(recent.some((d) => d.entity === "contact")).toBe(true);
    expect(recent.some((d) => d.entity === "opportunity")).toBe(true);
    const viewer = a.actor("viewer");
    const noSales: CrmActor = { ...viewer, can: (p) => p !== "sales.view" && viewer.can(p) };
    const noDeals = await listAssignmentHistory(noSales, { limit: 200 });
    expect(noDeals.length).toBeGreaterThan(0);
    expect(noDeals.every((d) => d.entity === "contact")).toBe(true);
    // Another workspace sees none of it.
    expect(await listAssignmentHistory(b.actor("owner"), { limit: 200 })).toEqual([]);
    await expect(listAssignmentHistory(a.actor("viewer"), { entityId: "not-a-uuid" })).rejects.toThrow(/isn't valid/);
  });
});

describe("the Lead Assignment screen", () => {
  const html = (el: React.ReactElement) => renderToStaticMarkup(el).replace(/<!-- -->/g, "");

  it("renders the rules in order with working controls, the decisions and a record's history", async () => {
    await freshRuleSet(a);
    await rule(a, { name: "Website leads", conditions: { op: "and", conditions: [{ field: "source", op: "equals", value: "website" }] }, members: [{ userId: a.people.sales.id }, { userId: a.people.setter.id, paused: true }] });
    await rule(a, { name: "Catch-all", strategy: "weighted", members: [{ userId: a.people.support.id, weight: 2 }] });
    const lead = await newLead(a, { source: "website", firstName: "Rendered", lastName: "Lead" });
    const owner = a.actor("owner");
    const page = html(await AssignmentView({ actor: owner, scope: await scopeFor(owner, "/crm"), searchParams: {} }));
    expect(page).toContain("Lead assignment");
    expect(page.indexOf("Website leads")).toBeLessThan(page.indexOf("Catch-all"));
    expect(page).toContain('aria-label="Move Website leads down"');
    expect(page).toContain('aria-label="Move Catch-all up"');
    expect(page).toContain('aria-label="Edit Catch-all"');
    expect(page).toContain("Matches: Lead source is “website”");
    expect(page).toContain("· paused");
    expect(page).toContain("Rendered Lead");
    expect(page).toContain("Recent decisions");
    expect(page).toContain(">New rule<");

    const record = html(await AssignmentView({ actor: owner, scope: await scopeFor(owner, "/crm"), searchParams: { record: `contact:${lead.id}` } }));
    expect(record).toContain("Assignment history");
    expect(record).toContain(`href="/crm/contacts/${lead.id}"`);
    expect(record).toContain("Round robin");

    // Someone who can see contacts but not assign them can't open the screen's rules.
    await expect(AssignmentView({ actor: a.actor("sales"), scope: await scopeFor(a.actor("sales"), "/crm") })).rejects.toThrow(/assign permission/);
  });
});
