import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { submitRequest } from "@/server/support/service";
import { createOpsRun } from "@/server/aqi/ops/executor";
import { cancelOpsAction, confirmOpsAction, getOpsAction, proposeOpsAction } from "@/server/aqi/ops/actions";
import { findActionTool } from "@/server/aqi/ops/registry";
import { resolveOpsScope } from "@/server/aqi/ops/scope";
import type { PlannedAction } from "@/server/aqi/ops/planner";
import type { OpsActionPreviewCard, OpsCard } from "@/lib/aqi/ops/types";
import { agencyUser, createOrg, createUser } from "./support/fixtures";
import { supportWorld, type SupportWorld } from "./support/support-world";

let w: SupportWorld;
let secondAdmin: ReturnType<typeof agencyUser>;

beforeAll(async () => {
  w = await supportWorld();
  await createOrg({ name: "iAcquire Agency", kind: "agency" });
  secondAdmin = agencyUser(await createUser({ platformRole: "agency_super_admin", name: "Second Admin" }), "agency_super_admin");
});

const signal = () => new AbortController().signal;

// The confirmation rate limit is real; each test starts with a fresh window so a long suite does not trip it.
beforeEach(async () => {
  await withSystem((db) => db.query("delete from rate_limit_buckets where bucket_key like 'aqi:ops:%'"));
});

async function propose(action: PlannedAction, scopeRequest: Parameters<typeof resolveOpsScope>[1], user = w.agency.superAdmin): Promise<{ card: OpsCard; run: Awaited<ReturnType<typeof createOpsRun>> }> {
  const scope = await resolveOpsScope(user, scopeRequest);
  const run = await createOpsRun({ user, scope, signal: signal(), plannedToolIds: [action.toolId] });
  const conversation = await withSystem(async (db) => {
    const c = await db.query<{ id: string }>("insert into aqi_conversations (user_id, title, surface, saved_at) values ($1, 'Action test', 'operations', now()) returning id", [user.id]);
    const m = await db.query<{ id: string }>("insert into aqi_messages (conversation_id, user_id, role, content, status) values ($1, $2, 'assistant', '', 'streaming') returning id", [c.rows[0].id, user.id]);
    return { conversationId: c.rows[0].id, messageId: m.rows[0].id };
  });
  const card = await proposeOpsAction({ run, scope, ...conversation, action });
  await run.flushAudit();
  return { card, run };
}

const preview = (card: OpsCard): OpsActionPreviewCard => {
  expect(card.kind).toBe("action_preview");
  return card as OpsActionPreviewCard;
};

async function newIncident(title: string, orgId: string | null = w.org.id) {
  const key = `test:${crypto.randomUUID()}`;
  return (await withSystem((db) => db.query<{ id: string }>(
    "insert into incidents (org_id, source, subject, dedupe_key, severity, title) values ($1, 'queue', 'q', $2, 'warning', $3) returning id", [orgId, key, title],
  ))).rows[0].id;
}

const auditCount = async (action: string, targetId: string) =>
  (await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from audit_logs where action = $1 and target_id = $2", [action, targetId]))).rows[0].n;

describe("AQi Operations action lifecycle", () => {
  it("proposes without changing anything, then executes once and verifies by reading the system back", async () => {
    const incidentId = await newIncident("Queue backlog for Support Co");
    const { card } = await propose({ toolId: "incident.acknowledge", args: { incidentId } }, { type: "incident", id: incidentId });
    const p = preview(card);
    expect(p).toMatchObject({ status: "proposed", risk: "low", approval: "confirm", toolId: "incident.acknowledge" });
    expect(p.effects.join(" ")).toMatch(/Does not fix the underlying condition/);
    // Proposal alone changed nothing.
    expect((await withSystem((db) => db.query<{ status: string }>("select status from incidents where id = $1", [incidentId]))).rows[0].status).toBe("open");

    // Another Super Admin cannot confirm it; neither can an agency manager.
    await expect(confirmOpsAction(secondAdmin, p.actionId, {})).rejects.toThrow(/not found/i);
    await expect(confirmOpsAction(w.agency.manager, p.actionId, {})).rejects.toThrow(/Super Admins only/);

    const done = await confirmOpsAction(w.agency.superAdmin, p.actionId, {});
    expect(done.status).toBe("succeeded");
    const result = done.cards.find((c) => c.kind === "action_result");
    expect(result).toMatchObject({ status: "succeeded" });
    expect((await withSystem((db) => db.query<{ status: string; acknowledged_by: string }>("select status, acknowledged_by from incidents where id = $1", [incidentId]))).rows[0]).toEqual({ status: "acknowledged", acknowledged_by: w.agency.superAdmin.id });

    // A repeat confirmation reports the stored outcome and does not run the action again.
    const again = await confirmOpsAction(w.agency.superAdmin, p.actionId, {});
    expect(again.status).toBe("succeeded");
    expect(await auditCount("incident.acknowledged", incidentId)).toBe(1);
    expect(await auditCount("aqi.ops_action_confirmed", p.actionId)).toBe(1);
    expect(await auditCount("aqi.ops_action_verified", p.actionId)).toBe(1);
    // Cancelling a finished action cannot rewrite history.
    expect((await cancelOpsAction(w.agency.superAdmin, p.actionId)).status).toBe("succeeded");
  });

  it("refuses an expired or cancelled proposal and leaves the system untouched", async () => {
    const incidentId = await newIncident("Stale proposal");
    const { card } = await propose({ toolId: "incident.acknowledge", args: { incidentId } }, { type: "incident", id: incidentId });
    const p = preview(card);
    await withSystem((db) => db.query("update aqi_ops_actions set expires_at = now() - interval '1 minute' where id = $1", [p.actionId]));
    await expect(confirmOpsAction(w.agency.superAdmin, p.actionId, {})).rejects.toThrow(/expired/i);
    expect((await getOpsAction(w.agency.superAdmin, p.actionId)).status).toBe("expired");
    expect((await withSystem((db) => db.query<{ status: string }>("select status from incidents where id = $1", [incidentId]))).rows[0].status).toBe("open");

    const other = await newIncident("Cancelled proposal");
    const { card: second } = await propose({ toolId: "incident.acknowledge", args: { incidentId: other } }, { type: "incident", id: other });
    const cancelled = await cancelOpsAction(w.agency.superAdmin, preview(second).actionId);
    expect(cancelled.status).toBe("cancelled");
    expect((await confirmOpsAction(w.agency.superAdmin, preview(second).actionId, {})).status).toBe("cancelled");
    expect((await withSystem((db) => db.query<{ status: string }>("select status from incidents where id = $1", [other]))).rows[0].status).toBe("open");
  });

  it("re-validates the target at confirmation time instead of trusting the preview", async () => {
    const incidentId = await newIncident("Changed under us");
    const { card } = await propose({ toolId: "incident.acknowledge", args: { incidentId } }, { type: "incident", id: incidentId });
    await withSystem((db) => db.query("update incidents set status = 'acknowledged', acknowledged_by = $2, acknowledged_at = now() where id = $1", [incidentId, secondAdmin.id]));
    await expect(confirmOpsAction(w.agency.superAdmin, preview(card).actionId, {})).rejects.toThrow(/already acknowledged/);
    expect((await getOpsAction(w.agency.superAdmin, preview(card).actionId)).status).toBe("proposed");
  });

  it("requires a typed phrase and a reason for pausing a client, and verifies the pause", async () => {
    const { card } = await propose({ toolId: "automation.agency_pause", args: { orgId: w.org.id, paused: true, reason: "Suspected runaway sends" } }, { type: "tenant", id: w.org.id });
    const p = preview(card);
    expect(p).toMatchObject({ risk: "high", approval: "typed_confirmation", confirmPhrase: "Support Co" });
    expect(p.effects.join(" ")).toMatch(/receive an in-app notice/);
    await expect(confirmOpsAction(w.agency.superAdmin, p.actionId, {})).rejects.toThrow(/reason/i);
    await expect(confirmOpsAction(w.agency.superAdmin, p.actionId, { reason: "Runaway sends seen in the queue" })).rejects.toThrow(/Type “Support Co”/);
    await expect(confirmOpsAction(w.agency.superAdmin, p.actionId, { phrase: "other co", reason: "Runaway sends seen in the queue" })).rejects.toThrow(/Type “Support Co”/);
    expect((await withSystem((db) => db.query("select 1 from automation_pauses where org_id = $1 and scope = 'agency' and active", [w.org.id]))).rows.length).toBe(0);

    const done = await confirmOpsAction(w.agency.superAdmin, p.actionId, { phrase: "  support   co ", reason: "Runaway sends seen in the queue" });
    expect(done.status).toBe("succeeded");
    expect((await withSystem((db) => db.query("select 1 from automation_pauses where org_id = $1 and scope = 'agency' and active", [w.org.id]))).rows.length).toBe(1);
    const row = (await withSystem((db) => db.query<{ reason: string; verified: boolean; confirmed_by: string }>("select reason, verified, confirmed_by from aqi_ops_actions where id = $1", [p.actionId]))).rows[0];
    expect(row).toMatchObject({ verified: true, confirmed_by: w.agency.superAdmin.id, reason: "Runaway sends seen in the queue" });

    // Pausing again is refused at proposal time; resuming is a new, separately confirmed proposal.
    const repeat = await propose({ toolId: "automation.agency_pause", args: { orgId: w.org.id, paused: true, reason: "again" } }, { type: "tenant", id: w.org.id });
    expect(repeat.card).toMatchObject({ kind: "notice", body: expect.stringMatching(/already paused/) });
    const resume = preview((await propose({ toolId: "automation.agency_pause", args: { orgId: w.org.id, paused: false, reason: "Resuming after review" } }, { type: "tenant", id: w.org.id })).card);
    expect((await confirmOpsAction(w.agency.superAdmin, resume.actionId, { phrase: "Support Co", reason: "Cause fixed and checked" })).status).toBe("succeeded");
    expect((await withSystem((db) => db.query("select 1 from automation_pauses where org_id = $1 and scope = 'agency' and active", [w.org.id]))).rows.length).toBe(0);
  });

  it("will not target a client other than the selected one, and refuses a platform-wide pause", async () => {
    const mismatch = await propose({ toolId: "automation.agency_pause", args: { orgId: w.otherOrg.id, paused: true, reason: "Wrong client" } }, { type: "tenant", id: w.org.id });
    expect(mismatch.card).toMatchObject({ kind: "notice", tone: "danger" });
    const platform = await propose({ toolId: "automation.agency_pause", args: { orgId: w.org.id, paused: true, reason: "No scope selected" } }, { type: "platform" });
    expect(platform.card).toMatchObject({ kind: "notice" });
    expect((await withSystem((db) => db.query("select 1 from aqi_ops_actions where org_id = $1 and status = 'proposed'", [w.otherOrg.id]))).rows.length).toBe(0);
  });

  it("escalates and re-prioritises a ticket through the Support service, with verification", async () => {
    const ticket = await submitRequest(w.ctx.owner, { requestType: "issue", subject: "Customers cannot book appointments", message: "Booking page shows an error for every visitor.", category: "feature_not_working" });
    const ticketScope = { type: "ticket" as const, id: ticket.id };
    const esc = preview((await propose({ toolId: "support.escalate", args: { ticketId: ticket.id, reason: "Booking is down for a client" } }, ticketScope)).card);
    expect(esc.approval).toBe("confirm_with_reason");
    expect((await confirmOpsAction(w.agency.superAdmin, esc.actionId, { reason: "Booking down, customer blocked" })).status).toBe("succeeded");
    expect((await withSystem((db) => db.query("select 1 from support_ticket_ops where ticket_id = $1 and escalated_at is not null", [ticket.id]))).rows.length).toBe(1);
    // Already escalated: nothing further to propose.
    expect((await propose({ toolId: "support.escalate", args: { ticketId: ticket.id, reason: "Again please" } }, ticketScope)).card.kind).toBe("notice");

    const prio = preview((await propose({ toolId: "support.set_priority", args: { ticketId: ticket.id, priority: "urgent", reason: "" } }, ticketScope)).card);
    expect((await confirmOpsAction(w.agency.superAdmin, prio.actionId, {})).status).toBe("succeeded");
    expect((await withSystem((db) => db.query<{ priority: string }>("select priority from support_tickets where id = $1", [ticket.id]))).rows[0].priority).toBe("urgent");
  });

  it("records an internal issue in Support & Requests under the agency workspace, exactly once", async () => {
    const { card } = await propose({ toolId: "issue.create", args: { kind: "platform_bug", subject: "Scheduler heartbeat never recorded", details: "worker_job_runs has no tick row in production." } }, { type: "platform" });
    const p = preview(card);
    expect(p.effects.join(" ")).toMatch(/No client is contacted/);
    const done = await confirmOpsAction(w.agency.superAdmin, p.actionId, {});
    expect(done.status).toBe("succeeded");
    await confirmOpsAction(w.agency.superAdmin, p.actionId, {});
    const rows = await withSystem((db) => db.query<{ subject: string; kind: string; request_type: string }>(
      "select t.subject, o.kind, t.request_type from support_tickets t join organizations o on o.id = t.org_id where t.subject like '[Platform bug]%'",
    ));
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ kind: "agency", request_type: "issue", subject: "[Platform bug] Scheduler heartbeat never recorded" });
    const result = done.cards.find((c) => c.kind === "action_result");
    expect(result && "link" in result && result.link?.href).toMatch(/^\/admin\/support\//);
  });
});

describe("AQi Operations honest failure", () => {
  const tool = findActionTool("incident.acknowledge")!;
  const originalExecute = tool.execute;
  const originalVerify = tool.verify;
  afterEach(() => { tool.execute = originalExecute; tool.verify = originalVerify; });

  it("never reports success when the end state is not confirmed", async () => {
    const incidentId = await newIncident("Verification mismatch");
    const p = preview((await propose({ toolId: "incident.acknowledge", args: { incidentId } }, { type: "incident", id: incidentId })).card);
    tool.verify = async () => ({ verified: false, observed: ["Incident status is still open."] });
    const done = await confirmOpsAction(w.agency.superAdmin, p.actionId, {});
    expect(done.status).toBe("verification_failed");
    const result = done.cards.find((c) => c.kind === "action_result");
    expect(result).toMatchObject({ status: "verification_failed", observed: ["Incident status is still open."] });
    expect(result && "headline" in result && result.headline).toMatch(/not confirmed/);
    expect(await auditCount("aqi.ops_action_verified", p.actionId)).toBe(0);
    expect(await auditCount("aqi.ops_action_failed", p.actionId)).toBe(1);
  });

  it("returns a recoverable failure when the domain function throws", async () => {
    const incidentId = await newIncident("Execution failure");
    const p = preview((await propose({ toolId: "incident.acknowledge", args: { incidentId } }, { type: "incident", id: incidentId })).card);
    tool.execute = async () => { throw new AppError("upstream_error", "The incident service rejected the change."); };
    const done = await confirmOpsAction(w.agency.superAdmin, p.actionId, {});
    expect(done.status).toBe("failed");
    expect(done.cards.find((c) => c.kind === "action_result")).toMatchObject({ status: "failed", observed: ["The incident service rejected the change."] });
    // A failed action is terminal and is not silently retried by a repeat confirmation.
    tool.execute = originalExecute;
    expect((await confirmOpsAction(w.agency.superAdmin, p.actionId, {})).status).toBe("failed");
    expect((await withSystem((db) => db.query<{ status: string }>("select status from incidents where id = $1", [incidentId]))).rows[0].status).toBe("open");
  });

  it("settles an interrupted action by reading the real state, without running it again", async () => {
    const incidentId = await newIncident("Interrupted");
    const p = preview((await propose({ toolId: "incident.acknowledge", args: { incidentId } }, { type: "incident", id: incidentId })).card);
    // The process died after the change but before the result was stored.
    await withSystem(async (db) => {
      await db.query("update incidents set status = 'acknowledged', acknowledged_by = $2, acknowledged_at = now() where id = $1", [incidentId, w.agency.superAdmin.id]);
      await db.query("update aqi_ops_actions set status = 'executing', confirmed_by = $2, confirmed_at = now(), executed_at = now() - interval '10 minutes' where id = $1", [p.actionId, w.agency.superAdmin.id]);
    });
    let executed = 0;
    tool.execute = async () => { executed += 1; return {}; };
    const settled = await getOpsAction(w.agency.superAdmin, p.actionId);
    expect(settled.status).toBe("succeeded");
    expect(executed).toBe(0);
  });
});
