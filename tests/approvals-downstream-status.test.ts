// What an approval and a follow-up draft job say after a person has decided. "Approved" is not "sent": a queued draft is waiting to send, a blocked or failed one was not sent, and
// only a message that is really sent or delivered reads "Sent". "Completed" is for a booking or appointment change, whose executor writes to the calendar before it reports
// success. The drafts a job prepared show each message's live status, never the "draft" the job recorded when it finished.
import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { approvalOutcome, createApproval, decideApproval, listApprovals, type ApprovalKind, type ApprovalRow } from "@/server/approvals/service";
import { createWorkJob, getWorkJobView } from "@/server/workforce/jobs";
import { listWorkBoardJobs } from "@/server/workforce/work-board";
import { getWorkforceCalendarData } from "@/server/workforce/calendar";
import { parseEvidenceMarker } from "@/lib/evidence-class";
import { addMember, agentId, createOrg, createUser, ctxFor } from "./support/fixtures";

let org: Awaited<ReturnType<typeof createOrg>>;
let owner: { id: string; email: string };
let salesAssistant: string;
let contactId: string;
let conversationId: string;

const q = <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: unknown[] = []) => withSystem((db) => db.query<T>(sql, params)).then((r) => r.rows);

async function draftMessage(status: string, opts: { orgId?: string; detail?: string } = {}) {
  const target = opts.orgId ?? org.id;
  const foreignContact = target === org.id ? null : (await q<{ id: string }>("insert into contacts (org_id, display_name) values ($1, 'Foreign Contact') returning id", [target]))[0].id;
  const conversation = target === org.id ? conversationId : (await q<{ id: string }>("insert into conversations (org_id, contact_id, channel, thread_key, owner_kind) values ($1, $2, 'sms', $3, 'ai') returning id", [target, foreignContact, crypto.randomUUID()]))[0].id;
  const [row] = await q<{ id: string }>(
    `insert into conversation_messages (org_id, conversation_id, direction, author_kind, agent_id, body, status, status_detail)
     values ($1, $2, 'outbound', 'ai', $3, 'Hi, just checking in.', $4, $5) returning id`,
    [target, conversation, target === org.id ? salesAssistant : null, status, opts.detail ?? null],
  );
  return row.id;
}

/** An approval a person already approved, with the execution state its executor reported. */
async function approved(kind: ApprovalKind, execution: "queued" | "succeeded" | "failed" | "blocked", action: Record<string, unknown> = {}, detail = "Done.") {
  const id = (await withSystem((db) => createApproval(db, { orgId: org.id, kind, title: `Downstream ${kind}`, action, reason: "test", expectedEffect: "test", risk: "medium", requestedBy: owner.id }))) as string;
  await q("update approval_requests set status = 'approved', decided_by = $2, decided_at = now(), execution_status = $3, execution_detail = $4 where id = $1", [id, owner.id, execution, detail]);
  return id;
}

async function row(id: string): Promise<ApprovalRow> {
  const found = (await listApprovals(ctxFor(owner, org, "owner"), "all")).find((a) => a.id === id);
  if (!found) throw new Error("approval not listed");
  return found;
}

beforeAll(async () => {
  org = await createOrg({ name: "Downstream Status Co" });
  owner = await createUser({ name: "Downstream Owner" });
  await addMember(org.id, owner.id, "owner");
  salesAssistant = await agentId(org.id, "sales_assistant");
  contactId = (await q<{ id: string }>("insert into contacts (org_id, display_name) values ($1, 'Downstream Contact') returning id", [org.id]))[0].id;
  conversationId = (await q<{ id: string }>("insert into conversations (org_id, contact_id, channel, thread_key, ai_agent_id, owner_kind) values ($1, $2, 'sms', $3, $4, 'ai') returning id", [org.id, contactId, crypto.randomUUID(), salesAssistant]))[0].id;
}, 60_000);

describe("an approved follow-up message", () => {
  it("is waiting to send while its message is queued, and is not called sent or completed", async () => {
    const messageId = await draftMessage("queued");
    const id = await approved("follow_up_message", "succeeded", { messageId }, "Queued for sending.");
    const a = await row(id);
    expect(a.downstream_status).toBe("queued");
    expect(a.outcome).toMatchObject({ label: "Approved, waiting to send", tone: "neutral" });
    expect(a.evidence).toMatchObject({ class: "approved_write", ledger: { kind: "approval", id } });
    expect(a.outcome?.label).not.toMatch(/^(Sent|Completed)$/);
  });

  it("changes when the message goes out, is blocked, or fails", async () => {
    const messageId = await draftMessage("queued");
    const id = await approved("follow_up_message", "succeeded", { messageId }, "Queued for sending.");
    expect((await row(id)).outcome?.label).toBe("Approved, waiting to send");

    await q("update conversation_messages set status = 'sending' where id = $1", [messageId]);
    expect((await row(id)).outcome?.label).toBe("Approved, waiting to send");

    await q("update conversation_messages set status = 'blocked', blocked_reason = 'quiet_hours', status_detail = 'Outside the customer''s quiet hours.' where id = $1", [messageId]);
    const blocked = await row(id);
    expect(blocked.outcome).toMatchObject({ label: "Approved, but not sent", tone: "danger", detail: "Outside the customer's quiet hours." });
    expect(blocked.evidence.class).toBe("proposed_change");

    await q("update conversation_messages set status = 'failed', status_detail = 'The carrier refused it.' where id = $1", [messageId]);
    expect((await row(id)).outcome).toMatchObject({ label: "Approved, but not sent", detail: "The carrier refused it." });

    await q("update conversation_messages set status = 'sent', status_detail = null where id = $1", [messageId]);
    const sent = await row(id);
    expect(sent.outcome).toMatchObject({ label: "Sent", tone: "success" });
    expect(sent.evidence.class).toBe("completed_action");

    await q("update conversation_messages set status = 'delivered' where id = $1", [messageId]);
    expect((await row(id)).outcome?.label).toBe("Sent");
  });

  it("reads 'Approved, but not sent' when the dispatcher blocks it at approval time, through the real decision path", async () => {
    const messageId = await draftMessage("draft");
    const id = (await withSystem((db) => createApproval(db, { orgId: org.id, kind: "follow_up_message", title: "Send AI reply", action: { messageId }, reason: "test", expectedEffect: "test", risk: "medium", requestedBy: owner.id }))) as string;
    expect((await row(id)).outcome).toBeNull();
    await decideApproval(ctxFor(owner, org, "owner"), id, "approve");
    const a = await row(id);
    expect(a.status).toBe("approved");
    expect(a.execution_status).toBe("blocked");
    expect(a.outcome?.label).toBe("Approved, but not sent");
    expect(a.evidence.class).toBe("proposed_change");
    // The message was never queued, so nothing is waiting to go out.
    expect((await q<{ status: string }>("select status from conversation_messages where id = $1", [messageId]))[0].status).not.toMatch(/queued|sending|sent|delivered/);
  });

  it("an outreach approval that cannot send reads the same way", async () => {
    const id = await approved("outreach", "blocked", {}, "Approved, but not sent: customer messaging isn't enabled for this workspace.");
    expect((await row(id)).outcome).toMatchObject({ label: "Approved, but not sent", tone: "warning" });
  });

  it("never reads another workspace's message status", async () => {
    const other = await createOrg({ name: "Other Downstream Co" });
    const foreignMessage = await draftMessage("sent", { orgId: other.id });
    const id = await approved("follow_up_message", "succeeded", { messageId: foreignMessage }, "Queued for sending.");
    const a = await row(id);
    expect(a.downstream_status).toBeNull();
    expect(a.outcome?.label).toBe("Approved, waiting to send");
    expect(a.evidence.class).toBe("approved_write");
  });

  it("an id that is not a message id finds nothing and breaks nothing", async () => {
    const id = await approved("follow_up_message", "succeeded", { messageId: "not-a-uuid" }, "Queued for sending.");
    expect((await row(id)).outcome?.label).toBe("Approved, waiting to send");
  });
});

describe("what other approvals say after a decision", () => {
  it.each<[ApprovalKind, string, string]>([
    ["appointment_booking", "Completed", "completed_action"],
    ["appointment_change", "Completed", "completed_action"],
    ["tool_action", "Approved, resumed", "approved_write"],
    ["workflow_action", "Approved, step released", "approved_write"],
    ["campaign_activation", "Approved, scheduled", "approved_write"],
    ["standing_authorization", "Approved, recorded", "approved_write"],
    ["knowledge_change", "Approved and applied", "approved_write"],
    ["config_change", "Approved and applied", "approved_write"],
    ["crm_update", "Approved and applied", "approved_write"],
    ["workflow_activation", "Approved and applied", "approved_write"],
  ])("%s that succeeded reads %s (%s)", async (kind, label, cls) => {
    const a = await row(await approved(kind, "succeeded"));
    expect(a.outcome?.label).toBe(label);
    expect(a.evidence.class).toBe(cls);
  });

  it("only a booking or an appointment change ever reads Completed", async () => {
    const kinds: ApprovalKind[] = ["lead_import", "outreach", "follow_up_message", "crm_update", "campaign_activation", "knowledge_change", "tool_action", "config_change", "standing_authorization", "workflow_activation", "workflow_action"];
    for (const kind of kinds) {
      const a = await row(await approved(kind, "succeeded"));
      expect(a.outcome?.label, kind).not.toBe("Completed");
      expect(a.evidence.class, kind).not.toBe("completed_action");
    }
  });

  it("a failed or held execution never reads as done", async () => {
    expect((await row(await approved("knowledge_change", "failed"))).outcome).toMatchObject({ label: "Approved, but it couldn't run", tone: "danger" });
    expect((await row(await approved("crm_update", "blocked"))).outcome).toMatchObject({ label: "Approved, but held", tone: "warning" });
    expect((await row(await approved("lead_import", "queued"))).outcome?.label).toBe("Approved, waiting to run");
    for (const execution of ["failed", "blocked"] as const) {
      expect((await row(await approved("appointment_booking", execution))).evidence.class).toBe("proposed_change");
    }
  });

  it("a request nobody has approved has no outcome and is a proposal, whatever its execution state", async () => {
    const id = (await withSystem((db) => createApproval(db, { orgId: org.id, kind: "appointment_booking", title: "Pending booking", action: {}, reason: "test", expectedEffect: "test", risk: "medium", requestedBy: owner.id }))) as string;
    const pending = await row(id);
    expect(pending.outcome).toBeNull();
    expect(pending.evidence.class).toBe("proposed_change");
    await decideApproval(ctxFor(owner, org, "owner"), id, "reject");
    const rejected = await row(id);
    expect(rejected.outcome).toBeNull();
    expect(rejected.evidence.class).toBe("proposed_change");
  });

  it("every listed approval carries a marker the strict parser accepts, naming itself as the ledger row", async () => {
    const all = await listApprovals(ctxFor(owner, org, "owner"), "all");
    expect(all.length).toBeGreaterThan(10);
    for (const a of all) {
      expect(parseEvidenceMarker(a.evidence), a.id).not.toBeNull();
      expect(a.evidence.ledger).toEqual({ kind: "approval", id: a.id });
    }
  });
});

describe("an approved booking whose appointment still waits for the host", () => {
  const base = { kind: "appointment_booking" as const, status: "approved" as const, execution_status: "succeeded" as const, execution_detail: null, downstream_status: null, downstream_detail: null };

  it("reads 'Approved and applied', not 'Completed', until the appointment is confirmed", () => {
    expect(approvalOutcome({ ...base, appointment_status: "new" })?.label).toBe("Approved and applied");
    expect(approvalOutcome({ ...base, appointment_status: "confirmed" })?.label).toBe("Completed");
    expect(approvalOutcome({ ...base })?.label).toBe("Completed");
  });
});

describe("a follow-up draft job", () => {
  async function draftJob(statuses: string[], requestedBy = owner.id) {
    const messages = await Promise.all(statuses.map((s) => draftMessage(s)));
    const job = await withSystem((db) => createWorkJob(db, { orgId: org.id, agentId: salesAssistant, requestedBy, capability: "pipeline_followup_drafts", title: "Follow-up drafts", idempotencyKey: `drafts-${crypto.randomUUID()}`, input: {} }));
    const drafts = messages.map((messageId, i) => ({ opportunityId: crypto.randomUUID(), opportunityName: `Deal ${i + 1}`, conversationId, messageId, reused: false, status: "draft", sent: false }));
    await q("update ai_work_jobs set status = 'completed', stage = 'completed', finished_at = now(), result = $2::jsonb, result_summary = 'Drafts saved.', result_count = $3 where id = $1", [job.id, JSON.stringify({ drafts }), drafts.length]);
    return { jobId: job.id, messages };
  }
  const view = (jobId: string) => getWorkJobView(ctxFor(owner, org, "owner"), jobId);
  const board = async (jobId: string) => (await listWorkBoardJobs(ctxFor(owner, org, "owner"), "all")).find((j) => j.id === jobId)!;
  const statusesOf = (result: Record<string, unknown>) => (result.drafts as Array<{ liveStatus: string }>).map((d) => d.liveStatus);

  it("shows each draft's live status and stays a proposal while any draft is waiting", async () => {
    const { jobId, messages } = await draftJob(["draft", "draft"]);
    const waiting = await view(jobId);
    expect(statusesOf(waiting!.result)).toEqual(["waiting", "waiting"]);
    expect(waiting!.evidence).toMatchObject({ class: "proposed_change", ledger: { kind: "work_job", id: jobId } });
    expect(waiting!.statusLabel).toBe("Ready for review");
    expect((await board(jobId)).statusLabel).toBe("Ready for review");
    expect((await board(jobId)).evidence?.class).toBe("proposed_change");

    // One approved and queued, one still waiting: still a proposal.
    await q("update conversation_messages set status = 'queued' where id = $1", [messages[0]]);
    const mixed = await view(jobId);
    expect(statusesOf(mixed!.result)).toEqual(["approved_queued", "waiting"]);
    expect(mixed!.evidence?.class).toBe("proposed_change");
  });

  it("is an approved write once every draft is decided and some are queued, and confirmed only when the approved ones are sent", async () => {
    const { jobId, messages } = await draftJob(["queued", "blocked"]);
    await q("update conversation_messages set blocked_reason = 'discarded' where id = $1", [messages[1]]);
    const queued = await view(jobId);
    expect(statusesOf(queued!.result)).toEqual(["approved_queued", "discarded"]);
    expect(queued!.evidence?.class).toBe("approved_write");
    expect(queued!.statusLabel).toBe("Approved, not yet sent");
    expect((await board(jobId)).evidence?.class).toBe("approved_write");

    await q("update conversation_messages set status = 'sent' where id = $1", [messages[0]]);
    const sent = await view(jobId);
    expect(statusesOf(sent!.result)).toEqual(["sent", "discarded"]);
    expect(sent!.evidence?.class).toBe("completed_action");
    expect(sent!.statusLabel).toBe("Completed");
    expect((await board(jobId)).evidence?.class).toBe("completed_action");
  });

  it("is never 'Completed' while an approved draft was blocked after approval or a draft cannot be found, on the panel, the board and the calendar", async () => {
    const { jobId, messages } = await draftJob(["sent", "blocked", "blocked"]);
    await q("update conversation_messages set blocked_reason = 'quiet_hours' where id = any($1::uuid[])", [[messages[1], messages[2]]]);
    // One draft was approved and sent; the other two could not go out. The job is not a confirmed action.
    const panel = await view(jobId);
    expect(panel!.evidence?.class).toBe("approved_write");
    expect(panel!.statusLabel).toBe("Some drafts not sent");
    const onBoard = await board(jobId);
    expect(onBoard.evidence?.class).toBe("approved_write");
    expect(onBoard.statusLabel).toBe("Some drafts not sent");
    await q("update ai_work_jobs set created_at = '2027-03-15T08:30:00.000Z' where id = $1", [jobId]);
    const calendar = await getWorkforceCalendarData(ctxFor(owner, org, "owner"), { from: new Date("2027-03-14T00:00:00.000Z"), to: new Date("2027-03-21T00:00:00.000Z") });
    expect(calendar.jobs.find((j) => j.id === jobId)?.statusLabel).toBe("Some drafts not sent");

    // A draft whose message cannot be found counts as not sent too.
    const other = await createOrg({ name: "Missing Draft Co" });
    const foreign = await draftMessage("sent", { orgId: other.id });
    const mixed = await draftJob(["sent"]);
    await q("update ai_work_jobs set result = jsonb_set(result, '{drafts}', (result -> 'drafts') || $2::jsonb) where id = $1", [mixed.jobId, JSON.stringify([{ opportunityName: "Gone", conversationId, messageId: foreign, status: "draft" }])]);
    expect((await view(mixed.jobId))!.evidence?.class).toBe("approved_write");
    expect((await board(mixed.jobId)).evidence?.class).toBe("approved_write");
  });

  it("labels the calendar entry like the board: a finished draft job with unsent drafts is not 'Completed'", async () => {
    const { jobId } = await draftJob(["draft", "draft"]);
    await q("update ai_work_jobs set created_at = '2027-03-16T08:30:00.000Z' where id = $1", [jobId]);
    const calendar = await getWorkforceCalendarData(ctxFor(owner, org, "owner"), { from: new Date("2027-03-14T00:00:00.000Z"), to: new Date("2027-03-21T00:00:00.000Z") });
    expect(calendar.jobs.find((j) => j.id === jobId)?.statusLabel).toBe("Ready for review");
    expect((await board(jobId)).statusLabel).toBe("Ready for review");
  });

  it("counts drafts the viewer cannot open the conversation of, so the board never says 'Completed' for a job with waiting drafts", async () => {
    const rep = await createUser({ name: "Sales Rep" });
    await addMember(org.id, rep.id, "sales_rep");
    // One draft sent, two waiting in a conversation the rep neither owns nor is assigned to.
    const { jobId } = await draftJob(["sent", "draft", "draft"], rep.id);
    const repCtx = ctxFor(rep, org, "sales_rep");
    const visible = await withUser(rep.id, (db) => db.query("select 1 from conversation_messages where org_id = $1 and conversation_id = $2", [org.id, conversationId]));
    expect(visible.rows).toHaveLength(0);
    const seen = (await listWorkBoardJobs(repCtx, "all")).find((j) => j.id === jobId)!;
    expect(seen.evidence?.class).toBe("proposed_change");
    expect(seen.statusLabel).toBe("Ready for review");
    // The job panel reads the same counts.
    expect((await getWorkJobView(repCtx, jobId))!.statusLabel).toBe("Ready for review");
  });

  it("a blocked draft carries the recorded reason and the job stays a proposal when nothing was approved", async () => {
    const { jobId } = await draftJob(["blocked"]);
    const messageId = (((await view(jobId))!.result.drafts as Array<{ messageId: string }>)[0]).messageId;
    await q("update conversation_messages set blocked_reason = 'quiet_hours', status_detail = 'Outside quiet hours.' where id = $1", [messageId]);
    const v = await view(jobId);
    expect(v!.result.drafts).toMatchObject([{ liveStatus: "blocked", liveDetail: "Outside quiet hours." }]);
    expect(v!.evidence?.class).toBe("proposed_change");
  });

  it("never reads a message of another workspace: a foreign id is 'unknown'", async () => {
    const other = await createOrg({ name: "Other Draft Co" });
    const foreign = await draftMessage("sent", { orgId: other.id });
    const job = await withSystem((db) => createWorkJob(db, { orgId: org.id, agentId: salesAssistant, requestedBy: owner.id, capability: "pipeline_followup_drafts", title: "Foreign draft", idempotencyKey: `drafts-${crypto.randomUUID()}`, input: {} }));
    await q("update ai_work_jobs set status = 'completed', stage = 'completed', finished_at = now(), result = $2::jsonb where id = $1", [job.id, JSON.stringify({ drafts: [{ opportunityName: "X", conversationId, messageId: foreign, status: "draft" }] })]);
    const v = await view(job.id);
    expect(statusesOf(v!.result)).toEqual(["unknown"]);
    expect(v!.evidence?.class).toBe("proposed_change");
  });

  it("gives a finished read-only review the retrieval class, and unfinished work no class", async () => {
    const make = async (status: string) => {
      const job = await withSystem((db) => createWorkJob(db, { orgId: org.id, agentId: salesAssistant, requestedBy: owner.id, capability: "pipeline_review", title: `Review ${status}`, idempotencyKey: `review-${crypto.randomUUID()}`, input: {} }));
      if (status !== "queued") await q("update ai_work_jobs set status = $2, finished_at = case when $2 in ('completed','failed') then now() end where id = $1", [job.id, status]);
      return job.id;
    };
    const done = await view(await make("completed"));
    expect(done!.evidence).toMatchObject({ class: "record_retrieval" });
    expect(done!.statusLabel).toBe("Completed");
    for (const status of ["queued", "failed"]) expect((await view(await make(status)))!.evidence, status).toBeNull();
    const waiting = await view(await make("waiting_for_approval"));
    expect(waiting!.evidence?.class).toBe("proposed_change");
  });
});
