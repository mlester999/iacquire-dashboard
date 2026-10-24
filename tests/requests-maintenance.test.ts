import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { createMaintenanceRequest, getMaintenanceOverview, updateMaintenanceRequest } from "@/server/maintenance/service";
import { listAgencyRequests } from "@/server/support/agency";
import { addMember, agencyUser, createOrg, createUser, ctxFor } from "./support/fixtures";
import { resetRateLimits } from "./support/support-world";

let org: Awaited<ReturnType<typeof createOrg>>;
let owner: { id: string; email: string };
let staff: ReturnType<typeof agencyUser>;
let subscriptionId: string;
const ctx = () => ctxFor(owner, org, "owner");

beforeAll(async () => {
  org = await createOrg({ name: "Allowance Co" });
  owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  const s = await createUser({ platformRole: "agency_staff" });
  staff = agencyUser(s, "agency_staff");
  await withSystem(async (db) => {
    await db.query("insert into staff_assignments (org_id, user_id) values ($1, $2)", [org.id, s.id]);
    await db.query("insert into client_setup_instances (org_id, state, activated_at) values ($1, 'activated', now())", [org.id]);
    // An active plan with a small allowance of its own (the allowance always comes from the plan's row, never from a constant in the code).
    subscriptionId = (await db.query<{ id: string }>(
      `insert into maintenance_subscriptions (org_id, status, monthly_price_cents, monthly_request_allowance, terms_version, accepted_by, activated_by, activated_at, billing_start_on, paid_through_on)
       values ($1, 'active', 29900, 2, 'test', $2, $2, now(), current_date, current_date + 30) returning id`, [org.id, owner.id],
    )).rows[0].id;
  });
});
beforeEach(resetRateLimits);

const managed = (n: number) => ({ kind: "managed_change" as const, title: `Adjustment ${n} for the rules`, description: `Please adjust a rule for item ${n} in the workflow.` });
const rowsOf = async () => (await withSystem((db) => db.query<{ id: string; ticket_id: string | null; status: string; counts_against_allowance: boolean }>(
  "select id, ticket_id, status, counts_against_allowance from maintenance_requests where org_id = $1 order by created_at", [org.id],
))).rows;
const ticketOf = async (id: string) => (await withSystem((db) => db.query<{ status: string; request_type: string; category: string; subject: string }>("select status, request_type, category, subject from support_tickets where id = $1", [id]))).rows[0];

describe("the monthly allowance holds when requests arrive together", () => {
  it("lets exactly the plan's allowance through, and leaves no ticket without a maintenance record or the other way round", async () => {
    const results = await Promise.allSettled([1, 2, 3, 4, 5].map((n) => createMaintenanceRequest(ctx(), managed(n))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    for (const r of results.filter((x) => x.status === "rejected")) expect(String((r as PromiseRejectedResult).reason)).toMatch(/used all 2/);
    const rows = await rowsOf();
    expect(rows.filter((r) => r.counts_against_allowance)).toHaveLength(2);
    expect(rows.every((r) => r.ticket_id)).toBe(true);
    const tickets = await withSystem((db) => db.query("select 1 from support_tickets where org_id = $1 and category = 'maintenance'", [org.id]));
    expect(tickets.rows).toHaveLength(2);
    expect((await getMaintenanceOverview(ctx())).allowance).toMatchObject({ total: 2, used: 2, remaining: 0 });
  });

  it("gives the slot back when the ticket cannot be made, instead of keeping a request nobody can see", async () => {
    await withSystem((db) => db.query("update maintenance_requests set status = 'declined' where org_id = $1 and kind = 'managed_change'", [org.id]));
    // The person has used up their support-request allowance for the hour, so opening the ticket fails after the slot was taken.
    for (let i = 0; i < RATE_LIMITS.supportTicketByUser.limit; i += 1) await consumeRateLimit(RATE_LIMITS.supportTicketByUser, owner.id);
    const before = (await rowsOf()).length;
    await expect(createMaintenanceRequest(ctx(), managed(9))).rejects.toThrow(/several requests recently/);
    expect((await rowsOf()).length).toBe(before);
    expect((await getMaintenanceOverview(ctx())).allowance).toMatchObject({ used: 0, remaining: 2 });
  });
});

describe("a defect in the original setup is an issue report", () => {
  it("opens an issue ticket that the Issue reports view and its analytics find, and never uses the allowance", async () => {
    await withSystem((db) => db.query("delete from maintenance_requests where org_id = $1", [org.id]));
    const defect = await createMaintenanceRequest(ctx(), { kind: "core_defect", title: "Calendar sync broke", description: "The appointment setter stopped booking on Tuesday." });
    const ticket = await ticketOf(defect.ticketId);
    expect(ticket).toMatchObject({ request_type: "issue", category: "feature_not_working" });
    expect(ticket.subject).toMatch(/^Defect report: /);
    const queue = await listAgencyRequests(staff, { view: "all", requestType: "issue", pageSize: 100 });
    expect(queue.items.map((i) => i.id)).toContain(defect.ticketId);
    expect((await getMaintenanceOverview(ctx())).allowance).toMatchObject({ used: 0 });
    // A managed change is still an ordinary request about maintenance.
    const change = await createMaintenanceRequest(ctx(), managed(1));
    expect(await ticketOf(change.ticketId)).toMatchObject({ request_type: "support", category: "maintenance" });
  });
});

describe("the maintenance record and its ticket keep one status", () => {
  // Earlier requests stop counting against the month's allowance (declined ones do not), so each test has a free slot.
  const newManaged = async (n: number) => {
    await withSystem((db) => db.query("update maintenance_requests set status = 'declined' where org_id = $1 and kind = 'managed_change'", [org.id]));
    return createMaintenanceRequest(ctx(), managed(n));
  };

  it("resolves the ticket when the request is completed and closes it when it is declined", async () => {
    const done = await newManaged(20);
    await updateMaintenanceRequest(staff, done.id, { status: "completed", resolutionNote: "Updated the rule." });
    expect((await ticketOf(done.ticketId)).status).toBe("resolved");
    const declined = await newManaged(21);
    await updateMaintenanceRequest(staff, declined.id, { status: "declined", resolutionNote: "This needs a quote instead." });
    expect((await ticketOf(declined.ticketId)).status).toBe("closed");
    // The timeline of each ticket records the change, and the audit log names the team member.
    const events = await withSystem((db) => db.query<{ kind: string }>("select kind from support_ticket_events where ticket_id = any($1::uuid[]) and kind in ('resolved', 'closed')", [[done.ticketId, declined.ticketId]]));
    expect(events.rows.map((e) => e.kind).sort()).toEqual(["closed", "resolved"]);
  });

  it("follows the request through in progress and back out of completed", async () => {
    const r = await newManaged(22);
    await updateMaintenanceRequest(staff, r.id, { status: "in_progress" });
    expect((await ticketOf(r.ticketId)).status).toBe("in_progress");
    await updateMaintenanceRequest(staff, r.id, { status: "waiting_for_client" });
    expect((await ticketOf(r.ticketId)).status).toBe("waiting_for_client");
    await updateMaintenanceRequest(staff, r.id, { status: "completed" });
    expect((await ticketOf(r.ticketId)).status).toBe("resolved");
    await updateMaintenanceRequest(staff, r.id, { status: "in_progress" });
    expect((await ticketOf(r.ticketId)).status).toBe("in_progress");
  });

  it("does not fail the maintenance update when the ticket cannot take the change, and does nothing for a note-only update", async () => {
    const r = await newManaged(23);
    await withSystem((db) => db.query("update support_tickets set status = 'closed' where id = $1", [r.ticketId]));
    await updateMaintenanceRequest(staff, r.id, { status: "completed" });
    expect((await ticketOf(r.ticketId)).status).toBe("closed");
    const events = async () => (await withSystem((db) => db.query("select 1 from support_ticket_events where ticket_id = $1", [r.ticketId]))).rows.length;
    const before = await events();
    await updateMaintenanceRequest(staff, r.id, { internalNotes: "Checked with the client." });
    expect(await events()).toBe(before);
  });

  it("does not tell the client twice: the maintenance notice is the one that goes out", async () => {
    const r = await newManaged(24);
    await updateMaintenanceRequest(staff, r.id, { status: "completed" });
    const forTicket = (await withSystem((db) => db.query<{ kind: string }>("select kind from notifications where user_id = $1 and link like $2", [owner.id, `%${r.ticketId}`]))).rows;
    expect(forTicket.map((n) => n.kind)).not.toContain("support_status");
    const maintenance = (await withSystem((db) => db.query<{ kind: string }>("select kind from notifications where user_id = $1 and title like $2", [owner.id, `${r.ref} is now completed%`]))).rows;
    expect(maintenance).toHaveLength(1);
  });
});
