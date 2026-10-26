// Journey 7: a client's request becomes an answered, approved and completed change on their project, across the support, projects and notification services.
//
// A client raises a Request a Change about a live custom project, and it is filed as a change on that project in the same write. The agency answers the request,
// classifies the change as work outside what was agreed, quotes it, and the client's owner accepts the quote. The acceptance adds the change to the project's
// agreed scope, and the agency then marks it done. The client hears about each step in the portal, and never needs an email to follow it.
//
// One external boundary is simulated and only here:
//   * the email provider: the support settings deliver an agency reply by email as well as in the portal, and the product sends it through the capture provider
//     (EMAIL_PROVIDER=capture, the test default) in src/server/email.ts. The email is written to email_outbox and marked captured; no message leaves the machine
//     and no provider is contacted. The journey asserts the in-app notice is what carries the news, so the email is a convenience, not a requirement.
// Nothing here reaches a provider of any kind: the project, support and notification services all run on the real internal code against embedded Postgres.
import { beforeEach, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { agencyPostMessage } from "@/server/support/agency";
import { getRequestDetail, submitRequest } from "@/server/support/service";
import { setRequestChangesEnabled } from "@/server/support/change-feature";
import { classifyChangeOrder, decideChangeOrder, markChangeApplied, sendChangeQuote } from "@/server/projects/change-orders";
import { getProject } from "@/server/projects/client";
import { countRows, notificationsFor, resetRateLimits } from "../support/support-world";
import { approvedProject, projectsWorld, type ProjectsWorld } from "../support/projects-world";

const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;

describe("a client request becomes an approved change on their project", () => {
  let w: ProjectsWorld;

  beforeEach(async () => {
    // The per-person rate limits are real and shared by the people in this file, so each test starts with them clear.
    await resetRateLimits();
    w = await projectsWorld();
    // The whole journey is about Request a Change, which is dormant per workspace until a Super Admin switches it on.
    await setRequestChangesEnabled(w.agency.superAdmin, w.org.id, true);
  });

  it("is filed as one request and one change, answered, quoted, accepted into the agreed scope, and reported to the client in the portal", async () => {
    // 1. The project is agreed and in development, which is what lets it take a change at all.
    const project = await approvedProject(w, "Website refresh for Harbor", { start: true });
    // The project's short reference, as the client's own screens show it; the notices below quote it.
    const ref = (await rows<{ ref: string }>("select ref from client_project_requests where id = $1", [project.id]))[0].ref;

    // 2. The client's owner raises the request. Asking for it as a change to what was agreed files both records in one write: the support request and the
    // project's change, pointing at each other.
    const filed = await submitRequest(w.ctx.owner, {
      requestType: "change",
      category: "change_project",
      projectId: project.id,
      asChangeOrder: true,
      subject: "Add a second booking calendar",
      message: "We now have two front desks and each one needs its own booking calendar and confirmation email.",
    });
    expect(filed.existing).toBe(false);
    expect(filed.changeOrderRef).toMatch(/^CHG-\d+$/);
    const [change] = await rows<{ id: string; status: string; request_id: string; ticket_id: string; title: string }>(
      "select id, status, request_id, ticket_id, title from project_change_orders where request_id = $1", [project.id],
    );
    expect(change).toMatchObject({ request_id: project.id, ticket_id: filed.id, status: "submitted", title: "Add a second booking calendar" });
    expect((await getRequestDetail(w.ctx.owner, filed.id))?.linkedChange).toMatchObject({ status: "submitted", projectId: project.id });

    // 3. The agency answers the request. The reply is on the request's thread the client can read; the in-app notice is what tells them, and the email the
    // support settings also ask for is captured rather than sent.
    const reply = await agencyPostMessage(w.agency.staff, filed.id, { body: "Thanks. A second calendar is outside the agreed scope, so we will quote it for you.", internal: false });
    expect(reply.existing).toBe(false);
    const detail = (await getRequestDetail(w.ctx.owner, filed.id))!;
    expect(detail.messages.map((m) => m.body)).toContain("Thanks. A second calendar is outside the agreed scope, so we will quote it for you.");
    const replyNotice = await notificationsFor(w.people.owner.id, "support_reply");
    expect(replyNotice).toHaveLength(1);
    expect(replyNotice[0].title).toBe(`iAcquire replied to ${detail.ticket.ref}`);
    // The email provider is the capture stand-in: the message is stored and marked captured, never accepted by a real provider.
    const email = await rows<{ status: string; email_outbox_id: string | null }>("select status, email_outbox_id from support_notification_log where ticket_id = $1 and channel = 'email'", [filed.id]);
    expect(email).toHaveLength(1);
    expect(email[0].status).toBe("captured");
    const outbox = await rows<{ provider: string; status: string }>("select provider, status from email_outbox where id = $1", [email[0].email_outbox_id]);
    expect(outbox).toEqual([{ provider: "capture", status: "captured" }]);

    // 4. The team decides it is outside what was agreed and quotes it: a price, extra weeks and terms of their own. Nothing is quoted before the classification,
    // and the quote binds the client's answer to those exact terms.
    await classifyChangeOrder(w.agency.staff, change.id, { classification: "out_of_scope", internalNotes: "Two calendars plus the extra confirmation email." });
    await sendChangeQuote(w.agency.staff, change.id, {
      additionalMinor: 45_000, currency: "USD", weeksMin: 1, weeksMax: 2,
      termsText: "Adds a second booking calendar and its confirmation email. Billed once, after the change is accepted.",
    });
    expect((await getRequestDetail(w.ctx.owner, filed.id))?.linkedChange).toMatchObject({ status: "quoted" });
    expect((await notificationsFor(w.people.owner.id, "project_change_order")).map((n) => n.title)).toContain(`${ref}: a quote for change ${filed.changeOrderRef} is ready`);

    // 5. The client's owner accepts. The answer is recorded against the version that was sent, and the change becomes part of the agreed scope in the same
    // transaction: the project moved by an amendment, not by rewriting the original agreement.
    expect(await decideChangeOrder(w.ctx.owner, change.id, "accepted")).toEqual({ decision: "accepted", requestId: project.id });
    const view = (await getProject(w.ctx.owner, project.id))!;
    expect(view.changes.find((c) => c.id === change.id)).toMatchObject({ status: "accepted", classification: "out_of_scope", additionalCents: 45_000, weeksMin: 1, weeksMax: 2 });
    expect(view.amendments).toEqual([expect.objectContaining({ changeOrderId: change.id, changeRef: filed.changeOrderRef, addedCents: 45_000, currency: "USD", weeksMin: 1, weeksMax: 2 })]);
    // The client saw it happen in the portal: the decision was recorded and the scope change is on the project's own activity list.
    const decisionNotice = (await notificationsFor(w.people.owner.id, "project_change_order")).find((n) => n.title === `Your decision on ${filed.changeOrderRef} was recorded`);
    expect(decisionNotice).toMatchObject({ link: `/projects/${project.id}` });
    expect(view.updates.some((u) => u.body.includes("It is now part of what was agreed"))).toBe(true);

    // 6. The work is done. Marking it applied is the agency's own record (the acceptance was the client's), and the client is told once more in the portal.
    await markChangeApplied(w.agency.staff, change.id, "Both calendars are live and the second confirmation email is sending.");
    expect((await getProject(w.ctx.owner, project.id))!.changes.find((c) => c.id === change.id)).toMatchObject({ status: "applied" });
    const applied = (await notificationsFor(w.people.owner.id, "project_change_order")).find((n) => n.title === `${ref}: change ${filed.changeOrderRef} was made`);
    expect(applied).toMatchObject({ link: `/projects/${project.id}` });

    // 7. Every notice the client needed was in the portal. The email is a copy of the first reply, not the way the client follows the journey, and the audit trail
    // names who did each step.
    expect(await countRows("select 1 from notifications where user_id = $1 and kind = 'project_change_order'", [w.people.owner.id])).toBeGreaterThanOrEqual(3);
    expect(await rows("select 1 from audit_logs where action = 'project.change_submitted' and target_id = $1", [change.id])).toHaveLength(1);
    expect(await rows("select 1 from audit_logs where action = 'project.change_decided' and target_id = $1", [change.id])).toHaveLength(1);
    expect(await rows("select 1 from audit_logs where action = 'project.change_applied' and target_id = $1", [change.id])).toHaveLength(1);
  });
});
