// Journey 7, the edges: a client's change request, asked what journey 7 does not.
//   * denied access: only the client's owner accepts or declines a quote (an admin and a member cannot), agency staff who are not assigned to the client cannot work the change,
//     and a change is never quoted before the team has classified it;
//   * tenant isolation: another client's owner can neither read the request, the change nor the project, nor decide the quote; the support, project and change rows are invisible to
//     them under row-level security;
//   * duplicates and replays: the same request filed twice is one request and one change; a quote decided twice is decided once, with one amendment;
//   * what the client is told: the portal notice for the owner, and none for the people who may not decide it.
// Audit and the notices along the whole path are asserted in journey 7 itself. The email provider is the capture stand-in, as there.
import { beforeEach, describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { agencyPostMessage } from "@/server/support/agency";
import { getRequestDetail, submitRequest } from "@/server/support/service";
import { setRequestChangesEnabled } from "@/server/support/change-feature";
import { classifyChangeOrder, decideChangeOrder, markChangeApplied, sendChangeQuote } from "@/server/projects/change-orders";
import { getProject } from "@/server/projects/client";
import { notificationsFor, resetRateLimits } from "../support/support-world";
import { approvedProject, projectsWorld, type ProjectsWorld } from "../support/projects-world";

const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;

describe("journey 7: who may decide, who can see it, and what a repeat does", () => {
  let w: ProjectsWorld;
  beforeEach(async () => {
    await resetRateLimits();
    w = await projectsWorld();
    await setRequestChangesEnabled(w.agency.superAdmin, w.org.id, true);
  });

  /** A change that has been filed, answered, classified and quoted: the client now has a decision to make. */
  async function quoted(title = "Add a second booking calendar", idempotencyKey?: string) {
    const project = await approvedProject(w, "Website refresh for Harbor", { start: true });
    const filed = await submitRequest(w.ctx.owner, {
      requestType: "change", category: "change_project", projectId: project.id, asChangeOrder: true, subject: title, ...(idempotencyKey ? { idempotencyKey } : {}),
      message: "We now have two front desks and each one needs its own booking calendar and confirmation email.",
    });
    const [change] = await rows<{ id: string }>("select id from project_change_orders where request_id = $1", [project.id]);
    return { project, filed, changeId: change.id };
  }

  it("refuses a quote to the team before it is classified, and to anyone but the owner once it is sent", async () => {
    const { changeId, project } = await quoted();
    const quote = { additionalMinor: 45_000, currency: "USD", weeksMin: 1, weeksMax: 2, termsText: "Adds a second booking calendar. Billed once, after the change is accepted." };
    // Nothing is quoted before the classification.
    await expect(sendChangeQuote(w.agency.staff, changeId, quote)).rejects.toMatchObject({ code: "conflict" });
    // Staff who are not assigned to this client cannot work its change at all.
    await expect(classifyChangeOrder(w.agency.outStaff, changeId, { classification: "out_of_scope", internalNotes: "Not mine to classify." })).rejects.toMatchObject({ code: expect.stringMatching(/forbidden|not_found/) });
    await classifyChangeOrder(w.agency.staff, changeId, { classification: "out_of_scope", internalNotes: "Two calendars plus the extra confirmation email." });
    await sendChangeQuote(w.agency.staff, changeId, quote);

    // The owner alone decides. An admin and a member of the same workspace are refused, and the change stays waiting.
    await expect(decideChangeOrder(w.ctx.admin, changeId, "accepted")).rejects.toMatchObject({ code: "forbidden" });
    await expect(decideChangeOrder(w.ctx.member, changeId, "accepted")).rejects.toMatchObject({ code: "forbidden" });
    expect((await rows<{ status: string }>("select status from project_change_orders where id = $1", [changeId]))[0].status).toBe("quoted");
    expect((await getProject(w.ctx.owner, project.id))!.amendments).toEqual([]);
  });

  it("keeps the request, the change and the project away from another client, and the quote's decision with its owner", async () => {
    const { changeId, project, filed } = await quoted();
    await classifyChangeOrder(w.agency.staff, changeId, { classification: "out_of_scope", internalNotes: "Out of scope." });
    await sendChangeQuote(w.agency.staff, changeId, { additionalMinor: 45_000, currency: "USD", weeksMin: 1, weeksMax: 2, termsText: "Adds a second booking calendar. Billed once, after the change is accepted." });

    // The other client's owner cannot decide it, read it or find it.
    await expect(decideChangeOrder(w.ctx.outsider, changeId, "accepted")).rejects.toMatchObject({ code: expect.stringMatching(/not_found|forbidden/) });
    expect(await getProject(w.ctx.outsider, project.id)).toBeNull();
    expect(await getRequestDetail(w.ctx.outsider, filed.id)).toBeNull();
    const seen = (table: string, column = "org_id") => withUser(w.people.outsider.id, async (db) => (await db.query(`select 1 from ${table} where ${column} = $1`, [w.org.id])).rows.length);
    for (const table of ["support_tickets", "project_change_orders", "client_project_requests"]) {
      expect((await rows(`select 1 from ${table} where org_id = $1`, [w.org.id])).length, `${table} exists`).toBeGreaterThan(0);
      expect(await seen(table), `${table} seen by the other client's owner`).toBe(0);
    }
    expect((await rows<{ status: string }>("select status from project_change_orders where id = $1", [changeId]))[0].status).toBe("quoted");
    // And no notice about this change reached the other client.
    expect(await notificationsFor(w.people.outsider.id, "project_change_order")).toEqual([]);
  });

  it("is one request and one change however many times it is filed, and one amendment however many times the quote is decided", async () => {
    const key = `journey7-${Math.random().toString(36).slice(2, 12)}`;
    const { changeId, project, filed } = await quoted("Add a second booking calendar", key);
    // The same request, filed again by the same form (the same idempotency key, which the form sends once per open form), is the request that exists.
    const again = await submitRequest(w.ctx.owner, {
      requestType: "change", category: "change_project", projectId: project.id, asChangeOrder: true, subject: "Add a second booking calendar", idempotencyKey: key,
      message: "We now have two front desks and each one needs its own booking calendar and confirmation email.",
    });
    expect(again).toMatchObject({ id: filed.id, existing: true });
    expect(await rows("select 1 from project_change_orders where request_id = $1", [project.id])).toHaveLength(1);

    await classifyChangeOrder(w.agency.staff, changeId, { classification: "out_of_scope", internalNotes: "Out of scope." });
    await sendChangeQuote(w.agency.staff, changeId, { additionalMinor: 45_000, currency: "USD", weeksMin: 1, weeksMax: 2, termsText: "Adds a second booking calendar. Billed once, after the change is accepted." });
    expect(await decideChangeOrder(w.ctx.owner, changeId, "accepted")).toMatchObject({ decision: "accepted" });
    await resetRateLimits();
    // Deciding it again is refused (it is no longer waiting), and it changes nothing: one decision, one amendment, one notice that it was recorded.
    await expect(decideChangeOrder(w.ctx.owner, changeId, "accepted")).rejects.toMatchObject({ code: "conflict" });
    await expect(decideChangeOrder(w.ctx.owner, changeId, "declined")).rejects.toMatchObject({ code: "conflict" });
    expect(await rows("select 1 from project_change_order_decisions where change_order_id = $1", [changeId])).toHaveLength(1);
    expect((await getProject(w.ctx.owner, project.id))!.amendments).toHaveLength(1);
    expect((await notificationsFor(w.people.owner.id, "project_change_order")).filter((n) => /Your decision on .* was recorded/.test(n.title))).toHaveLength(1);
    // Marking it applied twice does not announce it twice either.
    await markChangeApplied(w.agency.staff, changeId, "Both calendars are live.");
    await expect(markChangeApplied(w.agency.staff, changeId, "Both calendars are live.")).rejects.toMatchObject({ code: "conflict" });
    expect((await notificationsFor(w.people.owner.id, "project_change_order")).filter((n) => /was made/.test(n.title))).toHaveLength(1);
  });

  it("tells only the people who may act on the quote that it is ready, and an agency reply reaches the owner who filed the request", async () => {
    const { changeId, filed } = await quoted();
    await classifyChangeOrder(w.agency.staff, changeId, { classification: "out_of_scope", internalNotes: "Out of scope." });
    await sendChangeQuote(w.agency.staff, changeId, { additionalMinor: 45_000, currency: "USD", weeksMin: 1, weeksMax: 2, termsText: "Adds a second booking calendar. Billed once, after the change is accepted." });
    expect((await notificationsFor(w.people.owner.id, "project_change_order")).some((n) => /a quote for change .* is ready/.test(n.title))).toBe(true);
    // A quote waiting for a decision is something the owner has to act on, so it is a warning, not a plain heads-up (the helper now selects the severity it always declared).
    expect((await notificationsFor(w.people.owner.id, "project_change_order")).find((n) => /a quote for change .* is ready/.test(n.title))?.severity).toBe("warning");
    // A plain member is not told there is a quote to decide: it is not theirs to decide.
    expect((await notificationsFor(w.people.member.id, "project_change_order")).some((n) => /a quote for change .* is ready/.test(n.title))).toBe(false);
    await agencyPostMessage(w.agency.staff, filed.id, { body: "We have sent you a quote for the second calendar.", internal: false });
    expect((await notificationsFor(w.people.owner.id, "support_reply")).length).toBeGreaterThanOrEqual(1);
    expect(await notificationsFor(w.people.outsider.id, "support_reply")).toEqual([]);
  });
});
