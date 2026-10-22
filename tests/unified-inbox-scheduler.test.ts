import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/server/env";
import { withSystem } from "@/server/db";
import { memberActor } from "@/server/crm/actor";
import { createTag } from "@/server/crm/tags";
import { createWorkflow, publishWorkflow, setWorkflowStatus } from "@/server/crm/workflows/definitions";
import { announceIdleConversations, AWAITING_NOTICE_CAP, notifyAwaitingReplies, scanInboxAttention } from "@/server/messaging/attention";
import { JOBS, runScheduledJobs } from "@/server/ops/tick";
import type { WorkflowDefinition, WorkflowStep } from "@/lib/crm/workflow/spec";
import { inbound, messagingOrg, type MessagingOrg } from "./support/messaging";

// The scheduled inbox attention scan as production would run it: several workspaces in one pass. One workspace's trouble must not silence the others,
// one large workspace must not crowd the others out of the scan, and every repeat is quiet.

const inboxJob = JOBS.filter((j) => j.name === "inboxAttention");
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
const count = async (sql: string, p: unknown[] = []) => Number((await withSystem((db) => db.query<{ n: string }>(sql, p))).rows[0].n);
const notices = (orgId: string) => count("select count(*)::text as n from notifications where org_id = $1 and kind = 'conversation_awaiting_reply'", [orgId]);

/** A customer who has been waiting `minutes` for a reply, in the given workspace. */
async function waiting(org: MessagingOrg, minutes: number) {
  const c = await inbound(org.org.id);
  await withSystem((db) =>
    db.query("update conversations set unread_count = 1, last_outbound_at = null, last_inbound_at = $2, last_message_at = $2 where id = $1", [c.conversationId, minutesAgo(minutes)]),
  );
  return c;
}

beforeAll(() => resetEnvCache());
// Each test starts with nothing waiting anywhere, so earlier workspaces cannot take a place in the scan.
beforeEach(async () => {
  await withSystem((db) => db.query("update conversations set status = 'closed'"));
});

/** Makes every notification written for one workspace fail, as a broken row in that workspace would. */
async function poison(orgId: string) {
  await withSystem(async (db) => {
    await db.query("create or replace function inbox_test_boom() returns trigger language plpgsql as $$ begin raise exception 'poisoned workspace'; end $$");
    await db.query(`create trigger inbox_test_boom before insert on notifications for each row when (new.org_id = '${orgId}') execute function inbox_test_boom()`);
  });
}
const heal = () => withSystem((db) => db.query("drop trigger if exists inbox_test_boom on notifications"));

describe("one workspace's trouble", () => {
  it("does not silence the others: they are served in the same run, the failure is reported, and the next run catches the failed one up without repeating anyone", async () => {
    const bad = await messagingOrg({ name: "Poisoned Scan Co" });
    const good = await messagingOrg({ name: "Healthy Scan Co" });
    await waiting(bad, 45);
    await waiting(good, 40);
    await poison(bad.org.id);
    try {
      const first = await runScheduledJobs(new Date(), inboxJob);
      expect(first.inboxAttention).toBe("failed");
      expect(await notices(good.org.id)).toBeGreaterThan(0);
      expect(await notices(bad.org.id)).toBe(0);
    } finally {
      await heal();
    }
    const goodBefore = await notices(good.org.id);
    // A failed job is due again after fifteen minutes.
    const second = await runScheduledJobs(new Date(Date.now() + 20 * 60_000), inboxJob);
    expect(typeof second.inboxAttention).toBe("number");
    expect(await notices(bad.org.id)).toBeGreaterThan(0);
    expect(await notices(good.org.id)).toBe(goodBefore);
  });

  it("is reported once, by workspace, without any customer detail", async () => {
    const bad = await messagingOrg({ name: "Reported Scan Co" });
    await waiting(bad, 45);
    await poison(bad.org.id);
    try {
      await expect(scanInboxAttention()).rejects.toThrow(new RegExp(`1 workspace.*${bad.org.id}`));
      await expect(scanInboxAttention()).rejects.not.toThrow(/Maria|\+63|@/);
    } finally {
      await heal();
    }
  });

  it("does not silence the others' 'went quiet' announcements either", async () => {
    const bad = await messagingOrg({ name: "Poisoned Idle Co" });
    const good = await messagingOrg({ name: "Healthy Idle Co" });
    const idleWorkflow = async (org: MessagingOrg) => {
      const actor = memberActor(org.ctx("owner"));
      const tag = await createTag(actor, { name: `Q${Math.random().toString(36).slice(2, 7)}`, color: "#2563eb" });
      const def = { trigger: { type: "conversation.idle", filters: { idleHours: [24] } }, steps: [{ key: "tag", kind: "add_tag", config: { tagIds: [tag.id] }, next: null } as WorkflowStep] } as unknown as WorkflowDefinition;
      const { id } = await createWorkflow(actor, { name: "Went quiet", definition: def });
      await publishWorkflow(actor, id);
      await setWorkflowStatus(actor, id, "active");
    };
    for (const org of [bad, good]) {
      await idleWorkflow(org);
      const c = await inbound(org.org.id);
      await withSystem((db) => db.query("update conversations set last_message_at = now() - interval '25 hours' where id = $1", [c.conversationId]));
    }
    await withSystem(async (db) => {
      await db.query("create or replace function inbox_test_boom() returns trigger language plpgsql as $$ begin raise exception 'poisoned workspace'; end $$");
      await db.query(`create trigger inbox_test_boom before insert on crm_events for each row when (new.org_id = '${bad.org.id}' and new.type = 'conversation.idle') execute function inbox_test_boom()`);
    });
    try {
      await expect(scanInboxAttention()).rejects.toThrow(/1 workspace/);
      const events = (org: MessagingOrg) => count("select count(*)::text as n from crm_events where org_id = $1 and type = 'conversation.idle'", [org.org.id]);
      expect(await events(good)).toBe(1);
      expect(await events(bad)).toBe(0);
    } finally {
      await withSystem((db) => db.query("drop trigger if exists inbox_test_boom on crm_events"));
    }
  });
});

describe("a large workspace", () => {
  it("does not crowd the others out of the scan: every workspace gets its turn before any gets a second", async () => {
    const big = await messagingOrg({ name: "Big Backlog Co" });
    const small = await messagingOrg({ name: "Small Co" });
    for (let i = 0; i < 6; i += 1) await waiting(big, 200 - i);
    await waiting(small, 40);
    // A scan that can read only two rows: the oldest of each workspace, not the two oldest overall.
    await withSystem((db) => notifyAwaitingReplies(db, new Date(), { limit: 2 }));
    expect(await notices(small.org.id)).toBeGreaterThan(0);
    expect(await notices(big.org.id)).toBeGreaterThan(0);
  });

  it("reads at most one workspace's notice cap from it, and says how many are really waiting in the summary", async () => {
    const org = await messagingOrg({ name: "Over The Cap Co" });
    const total = AWAITING_NOTICE_CAP + 5;
    for (let i = 0; i < total; i += 1) await waiting(org, 60 + i);
    await withSystem((db) => notifyAwaitingReplies(db, new Date(), { limit: 1000 }));
    const rows = await withSystem((db) => db.query<{ title: string }>("select title from notifications where user_id = $1 and kind = 'conversation_awaiting_reply'", [org.people.owner.id]));
    expect(rows.rows).toHaveLength(AWAITING_NOTICE_CAP + 1);
    expect(rows.rows.filter((r) => r.title.includes("customers are waiting"))).toEqual([{ title: `${total} customers are waiting for a reply` }]);
  });

  it("can be limited to one workspace, which leaves the others untouched", async () => {
    const a = await messagingOrg({ name: "Only Me Co" });
    const b = await messagingOrg({ name: "Not Me Co" });
    await waiting(a, 45);
    await waiting(b, 45);
    expect(await withSystem((db) => notifyAwaitingReplies(db, new Date(), { orgId: a.org.id }))).toBeGreaterThan(0);
    expect(await notices(a.org.id)).toBeGreaterThan(0);
    expect(await notices(b.org.id)).toBe(0);
    expect(await withSystem((db) => announceIdleConversations(db, new Date(), a.org.id))).toBe(0);
  });
});
