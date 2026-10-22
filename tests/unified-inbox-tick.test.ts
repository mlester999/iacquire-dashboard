// The inbox under the production scheduler as the host's cron would run it: the real POST /api/internal/tick with the bearer secret and SCHEDULER_ENABLED=true,
// the REAL list of all scheduled jobs, on an isolated embedded database with synthetic workspaces, a captured (never sent) email provider and every provider
// write switch off. It answers: does the inbox's job work next to every other job, only for workspaces that have the new inbox, without emailing anybody by
// default, and is a repeated tick harmless? (The Automation Studio rehearsal in automation-studio-scheduler-rehearsal.test.ts covers the Studio jobs.)
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const CRON = "inbox-tick-rehearsal-secret-0123456789abcdef";
process.env.CRON_SECRET = CRON;
process.env.SCHEDULER_ENABLED = "true";

import { resetEnvCache } from "@/server/env";
import { POST as tick } from "@/app/api/internal/tick/route";
import { JOBS } from "@/server/ops/tick";
import { withSystem } from "@/server/db";
import { memberActor } from "@/server/crm/actor";
import { createTag } from "@/server/crm/tags";
import { createWorkflow, publishWorkflow, setWorkflowStatus } from "@/server/crm/workflows/definitions";
import { queueOutbound } from "@/server/messaging/send";
import type { WorkflowDefinition, WorkflowStep } from "@/lib/crm/workflow/spec";
import { inbound, messagingOrg, type MessagingOrg } from "./support/messaging";

beforeAll(() => resetEnvCache());
afterAll(() => vi.restoreAllMocks());

const count = async (sql: string, p: unknown[] = []) => Number((await withSystem((db) => db.query<{ n: string }>(sql, p))).rows[0].n);
const notices = (orgId: string) => count("select count(*)::text as n from notifications where org_id = $1 and kind = 'conversation_awaiting_reply'", [orgId]);

/** One tick as the host's cron makes it: the real route and secret, with the previous tick's lease long since over. */
async function runTick() {
  await withSystem((db) => db.query("update worker_job_runs set last_finished_at = now() - interval '5 minutes' where job_name = 'scheduler_tick' and last_finished_at is not null"));
  const res = await tick(new Request("http://localhost/api/internal/tick", { method: "POST", headers: { authorization: `Bearer ${CRON}` } }));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; skipped?: string; ran?: Record<string, number | string> };
  expect(body.skipped).toBeUndefined();
  return body.ran!;
}

async function waiting(org: MessagingOrg, minutes: number) {
  const c = await inbound(org.org.id);
  await withSystem((db) =>
    db.query("update conversations set unread_count = 1, last_outbound_at = null, last_inbound_at = now() - ($2 || ' minutes')::interval, last_message_at = now() - ($2 || ' minutes')::interval where id = $1", [c.conversationId, String(minutes)]),
  );
  return c;
}

describe("the inbox job inside the whole scheduler", () => {
  it("is registered once, every five minutes, among all the other jobs", () => {
    expect(JOBS.filter((j) => j.name === "inboxAttention")).toHaveLength(1);
    expect(JOBS.find((j) => j.name === "inboxAttention")?.everyMinutes).toBe(5);
    expect(JOBS.length).toBeGreaterThanOrEqual(45);
    expect(new Set(JOBS.map((j) => j.name)).size).toBe(JOBS.length);
  });

  it("notices only for the workspace that has the new inbox, no email for them, nothing repeated, and no other job disturbed", { timeout: 300_000 }, async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const on = await messagingOrg({ name: "Tick On Co" });
    const off = await messagingOrg({ name: "Tick Off Co", inboxRollout: false });
    await waiting(on, 45);
    await waiting(off, 45);
    // A queued AI reply in the workspace without the new inbox: the dispatcher job must treat it exactly as before (held, because live writes are off).
    const c = await inbound(off.org.id);
    const queued = await withSystem((db) => queueOutbound(db, { orgId: off.org.id, conversationId: c.conversationId, scope: "reply", actor: { kind: "ai", agentId: off.salesAgentId }, body: "Held while writes are off." }));
    expect(queued.status).toBe("queued");

    const first = await runTick();
    expect(Object.values(first)).not.toContain("failed");
    expect(typeof first.inboxAttention).toBe("number");
    expect(await notices(on.org.id)).toBeGreaterThan(0);
    expect(await notices(off.org.id)).toBe(0);

    // The warning is in the app only by default: nothing was emailed or queued for email about it, and nothing about a customer's words left the building.
    expect(await count("select count(*)::text as n from email_outbox where subject = 'A customer is waiting for a reply'")).toBe(0);
    const emailed = await count("select count(*)::text as n from notification_deliveries d join notifications n on n.id = d.notification_id where n.kind = 'conversation_awaiting_reply' and d.channel = 'email' and d.status <> 'skipped'");
    expect(emailed).toBe(0);

    // The other workspace's queued reply: not sent, held for the provider switch, with no network call.
    expect((await withSystem((db) => db.query<{ status: string; blocked_reason: string | null }>("select status, blocked_reason from conversation_messages where id = $1", [queued.messageId]))).rows[0]).toMatchObject({ status: "blocked", blocked_reason: "provider_not_enabled" });
    expect(fetchSpy.mock.calls.filter(([u]) => String(u).startsWith("http"))).toEqual([]);

    // The same tick again, and once more: nothing is announced twice.
    const before = await notices(on.org.id);
    expect(Object.values(await runTick())).not.toContain("failed");
    expect(Object.values(await runTick())).not.toContain("failed");
    expect(await notices(on.org.id)).toBe(before);
    fetchSpy.mockRestore();
  });

  it("announces 'went quiet' to the workflow that listens, in the same run the workflow engine picks it up", { timeout: 300_000 }, async () => {
    const org = await messagingOrg({ name: "Tick Idle Co" });
    const actor = memberActor(org.ctx("owner"));
    const tag = await createTag(actor, { name: `Quiet${Math.random().toString(36).slice(2, 7)}`, color: "#2563eb" });
    const def = { trigger: { type: "conversation.idle", filters: { idleHours: [24] } }, steps: [{ key: "tag", kind: "add_tag", config: { tagIds: [tag.id] }, next: null } as WorkflowStep] } as unknown as WorkflowDefinition;
    const { id } = await createWorkflow(actor, { name: "Went quiet", definition: def });
    await publishWorkflow(actor, id);
    await setWorkflowStatus(actor, id, "active");
    const c = await inbound(org.org.id);
    // A person has the conversation: in a real tick the AI-reply sweep (which runs before the inbox job) would answer an AI-owned one and so end its silence.
    await withSystem((db) => db.query("update conversations set owner_kind = 'human', owner_user_id = $2, last_message_at = now() - interval '25 hours' where id = $1", [c.conversationId, org.people.support.id]));
    // The inbox job runs once every five minutes; the previous test in this file ran it moments ago, so move its last run back as five minutes of real time would.
    await withSystem((db) => db.query("update worker_job_runs set last_started_at = now() - interval '10 minutes' where job_name = 'inboxAttention'"));
    expect(Object.values(await runTick())).not.toContain("failed");
    // The event is recorded by the inbox job and handed to the workflow engine by later jobs of the same run; the next run finishes anything left.
    await runTick();
    expect(await count("select count(*)::text as n from crm_contact_tags where tag_id = $1 and contact_id = $2", [tag.id, c.contactId])).toBe(1);
    expect(await count("select count(*)::text as n from crm_events where org_id = $1 and type = 'conversation.idle'", [org.org.id])).toBe(1);
  });
});
