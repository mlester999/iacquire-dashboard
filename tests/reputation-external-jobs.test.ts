// The scheduler jobs for public reviews and renewals: reviewSync (read the review sites and check replies whose result is unknown), renewalReminders (an internal task and notice
// for the team before a customer account renews) and reputationRetention (the daily clean-up). Run through the real tick endpoint for the gating, and directly for the rules. None
// writes to a customer; none posts a reply. Synthetic workspaces on embedded Postgres; every outbound switch is off and a network call fails the test.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const CRON = "reputation-external-jobs-secret-0123456789abcdef";
process.env.CRON_SECRET = CRON;
process.env.SCHEDULER_ENABLED = "true";
for (const key of ["GHL_WRITES_ENABLED", "RESEND_WRITES_ENABLED", "TWILIO_WRITES_ENABLED", "META_WHATSAPP_WRITES_ENABLED", "META_SOCIAL_WRITES_ENABLED", "N8N_ACTIONS_ENABLED", "SCHEDULER_JOBS_ONLY"]) delete process.env[key];

import { resetEnvCache } from "@/server/env";
import { POST as tick } from "@/app/api/internal/tick/route";
import { JOBS } from "@/server/ops/tick";
import { JOB_LABELS } from "@/lib/ops";
import { withSystem } from "@/server/db";
import { saveReputationSettings } from "@/server/reputation/settings";
import { runRenewalReminders } from "@/server/reputation/renewals";
import { FINISHED_REPLY_EVENT_DAYS, MIRROR_DAYS_AFTER_DISCONNECT, REMOVED_REVIEW_DAYS, purgeReputationRecords } from "@/server/reputation/housekeeping";
import { simulatedReviews } from "@/server/reputation/providers/simulated";
import { syncConnection } from "@/server/reputation/sync";
import { renewalKey } from "@/lib/reputation/renewals";
import { all, connectSim, count, mirrored, one, reviewsShop, setReviews, simReview, type ReputationShop } from "./support/reputation";

const DAY = 86_400_000;
const NOW = new Date("2026-10-24T08:00:00Z");
const daysFrom = (n: number, from = NOW) => new Date(from.getTime() + n * DAY).toISOString().slice(0, 10);

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
  resetEnvCache();
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    throw new Error(`network access is not allowed in this test: ${String(input)}`);
  });
});
afterEach(() => {
  delete process.env.SCHEDULER_JOBS_ONLY;
  resetEnvCache();
});
afterAll(() => fetchSpy.mockRestore());

const account = (orgId: string, name: string, renewal: string | null, status = "active") =>
  one<{ id: string }>("insert into retention_accounts (org_id, customer_name, status, renewal_date) values ($1, $2, $3, $4) returning id", [orgId, name, status, renewal]);
const renewalTasks = (orgId: string) => all<{ title: string; description: string | null; category: string; related_type: string | null; related_id: string; due_at: Date; priority: string; source: string; assigned_user_id: string | null; contact_id: string | null; status: string }>(
  "select title, description, category, related_type, related_id, due_at, priority, source, assigned_user_id, contact_id, status from tasks where org_id = $1 and related_type = 'retention_account' order by related_id", [orgId]);
const renewalNotices = (orgId: string) => count("select count(*)::text as n from notifications where org_id = $1 and kind = 'retention_attention' and dedupe_key like 'renewal:%'", [orgId]);
const messagesIn = (orgId: string) => count("select count(*)::text as n from conversation_messages where org_id = $1", [orgId]);

describe("renewalReminders", () => {
  it("makes an internal task and a notice for the team at 30, 14 and 7 days, only the tightest window an account has reached, and nothing for the rest", async () => {
    const s = await reviewsShop("Renewal Shop");
    await saveReputationSettings(s.owner, { renewalRemindersEnabled: true }, 0);
    const accounts: Record<string, { id: string; days: number }> = {};
    for (const days of [45, 31, 30, 20, 15, 14, 10, 8, 7, 3, 0, -3]) accounts[`d${days}`] = { id: (await account(s.m.org.id, `Customer ${days}`, daysFrom(days))).id, days };
    const noDate = await account(s.m.org.id, "No date", null);
    const churned = await account(s.m.org.id, "Churned", daysFrom(5), "churned");
    const before = await messagesIn(s.m.org.id);

    const run = await runRenewalReminders({ now: NOW });
    expect(run.tasks).toBe(9); // 30, 20, 15, 14, 10, 8, 7, 3, 0 days; not 45, 31 or the one that renewed three days ago
    const tasks = await renewalTasks(s.m.org.id);
    expect(tasks).toHaveLength(9);
    const byAccount = new Map(tasks.map((t) => [t.related_id.split(":")[0], t]));
    const want: Array<[number, number]> = [[30, 30], [20, 30], [15, 30], [14, 14], [10, 14], [8, 14], [7, 7], [3, 7], [0, 7]];
    for (const [days, window] of want) {
      const t = byAccount.get(accounts[`d${days}`].id);
      expect(t, `${days} days`).toBeDefined();
      expect(t?.related_id).toBe(renewalKey(accounts[`d${days}`].id, daysFrom(days), window as 30 | 14 | 7));
      expect(t).toMatchObject({ category: "retention", related_type: "retention_account", source: "system", status: "open", assigned_user_id: null, contact_id: null, priority: window <= 7 ? "high" : "normal" });
      expect(t?.description).toMatch(/nothing is sent to the customer/);
    }
    for (const gone of [accounts.d45, accounts["d31"], accounts["d-3"], noDate, churned]) expect(byAccount.has(gone.id)).toBe(false);
    expect(byAccount.get(accounts.d14.id)?.title).toBe("Customer 14 renews in 14 days");
    expect(byAccount.get(accounts.d0.id)?.title).toBe("Customer 0 renews today");
    expect(new Date(byAccount.get(accounts.d14.id)?.due_at as Date).toISOString().slice(0, 10)).toBe(daysFrom(14));
    // The owner and managers are told, once per reminder. A customer is never written to.
    const approvers = await count("select count(*)::text as n from organization_memberships where org_id = $1 and status = 'active' and role in ('owner', 'admin')", [s.m.org.id]);
    expect(await renewalNotices(s.m.org.id)).toBe(9 * approvers);
    expect(await messagesIn(s.m.org.id)).toBe(before);
    expect(await count("select count(*)::text as n from crm_review_requests where org_id = $1", [s.m.org.id])).toBe(0);
  });

  it("makes each reminder once: running again, or at the same moment, adds nothing, and a later window adds only its own", async () => {
    const s = await reviewsShop("Renewal Once Shop");
    await saveReputationSettings(s.owner, { renewalRemindersEnabled: true }, 0);
    const a = await account(s.m.org.id, "Slow Renewal", daysFrom(20));
    // (The job reads every workspace, so what it made here is counted here.)
    const made = async (days: number) => {
      const before = (await renewalTasks(s.m.org.id)).length;
      await runRenewalReminders({ now: new Date(NOW.getTime() + days * DAY) });
      return (await renewalTasks(s.m.org.id)).length - before;
    };
    expect(await made(0)).toBe(1);
    expect(await made(0)).toBe(0);
    expect(await made(3)).toBe(0); // 17 days away: still the 30-day window
    const notices = await renewalNotices(s.m.org.id);
    // Six days on it is 14 days away: the next window, with its own task and notice.
    expect(await made(6)).toBe(1);
    expect((await renewalTasks(s.m.org.id)).map((t) => t.related_id.split(":")[2])).toEqual(["14", "30"]);
    expect(await renewalNotices(s.m.org.id)).toBe(notices * 2);
    expect(await made(13)).toBe(1);
    expect((await renewalTasks(s.m.org.id)).map((t) => t.related_id.split(":")[2])).toEqual(["14", "30", "7"]);
    // Two passes at once make one task between them.
    const t = await reviewsShop("Renewal Race Shop");
    await saveReputationSettings(t.owner, { renewalRemindersEnabled: true }, 0);
    await account(t.m.org.id, "Race", daysFrom(5));
    const both = await Promise.all([runRenewalReminders({ now: NOW }), runRenewalReminders({ now: NOW })]);
    expect(both.reduce((n, r) => n + r.tasks, 0)).toBe(1);
    expect(await renewalTasks(t.m.org.id)).toHaveLength(1);
    // A new renewal date is a new reminder for the same account.
    await withSystem((db) => db.query("update retention_accounts set renewal_date = $2 where id = $1", [a.id, daysFrom(25)]));
    expect(await made(0)).toBe(1);
  });

  it("is off until the workspace switches it on, and leaves a suspended workspace and every other workspace alone", async () => {
    const off = await reviewsShop("Renewal Off Shop");
    const on = await reviewsShop("Renewal On Shop");
    const parked = await reviewsShop("Renewal Parked Shop");
    await saveReputationSettings(on.owner, { renewalRemindersEnabled: true }, 0);
    await saveReputationSettings(parked.owner, { renewalRemindersEnabled: true }, 0);
    for (const x of [off, on, parked]) await account(x.m.org.id, "Renews soon", daysFrom(6));
    await withSystem((db) => db.query("update organizations set status = 'suspended' where id = $1", [parked.m.org.id]));
    await runRenewalReminders({ now: NOW });
    expect(await renewalTasks(off.m.org.id)).toEqual([]);
    expect(await renewalTasks(parked.m.org.id)).toEqual([]);
    expect(await renewalTasks(on.m.org.id)).toHaveLength(1);
    // Switching it off again stops new reminders; the task already made stays.
    await saveReputationSettings(on.owner, { renewalRemindersEnabled: false }, 1);
    await account(on.m.org.id, "Another", daysFrom(6));
    await runRenewalReminders({ now: NOW });
    expect(await renewalTasks(on.m.org.id)).toHaveLength(1);
    expect(await renewalNotices(off.m.org.id)).toBe(0);
  });

  it("counts the days in the workspace's own calendar, so a workspace ahead of UTC is reminded on its own day", async () => {
    const utc = await reviewsShop("Renewal UTC Shop");
    const auckland = await reviewsShop("Renewal Auckland Shop");
    await withSystem((db) => db.query("update organizations set timezone = 'Pacific/Auckland' where id = $1", [auckland.m.org.id]));
    await saveReputationSettings(utc.owner, { renewalRemindersEnabled: true }, 0);
    await saveReputationSettings(auckland.owner, { renewalRemindersEnabled: true }, 0);
    // 20:00 UTC on the 24th is already the 25th in Auckland. A renewal on 8 November is 15 days away by one calendar and 14 by the other.
    const evening = new Date("2026-10-24T20:00:00Z");
    await account(utc.m.org.id, "Same date", "2026-11-08");
    await account(auckland.m.org.id, "Same date", "2026-11-08");
    await runRenewalReminders({ now: evening });
    expect((await renewalTasks(utc.m.org.id))[0].related_id.endsWith(":30")).toBe(true);
    expect((await renewalTasks(auckland.m.org.id))[0].related_id.endsWith(":14")).toBe(true);
    expect((await renewalTasks(auckland.m.org.id))[0].title).toBe("Same date renews in 14 days");
  });

  it("keeps each workspace's accounts to itself", async () => {
    const a = await reviewsShop("Renewal Iso A");
    const b = await reviewsShop("Renewal Iso B");
    await saveReputationSettings(a.owner, { renewalRemindersEnabled: true }, 0);
    await saveReputationSettings(b.owner, { renewalRemindersEnabled: true }, 0);
    const mine = await account(a.m.org.id, "Mine", daysFrom(5));
    await account(b.m.org.id, "Theirs", daysFrom(5));
    await runRenewalReminders({ now: NOW });
    expect((await renewalTasks(a.m.org.id)).every((t) => t.related_id.startsWith(mine.id))).toBe(true);
    expect(await count("select count(*)::text as n from tasks where org_id = $1 and related_id like $2", [b.m.org.id, `${mine.id}%`])).toBe(0);
    expect(await count("select count(*)::text as n from notifications where org_id = $1 and title like '%Theirs%'", [a.m.org.id])).toBe(0);
  });
});

describe("reputationRetention", () => {
  const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);
  async function mirror(s: ReputationShop, label: string, reviews: string[]) {
    const c = await connectSim(s, "google", reviews.map((id) => simReview(`${label}-${id}`)));
    await syncConnection(c.id, { now: daysAgo(200) });
    return c;
  }

  it("clears the sealed choices of a sign-in that is over, and deletes the row a day after it expired, leaving a live one alone", async () => {
    const s = await reviewsShop("Purge States Shop");
    const owner = s.m.people.owner.id;
    const state = (name: string, expires: Date, pending: string | null, used: Date | null = null) => withSystem((db) => db.query(
      "insert into review_oauth_states (org_id, user_id, provider, state_hash, expires_at, pending, used_at, code_verifier) values ($1, $2, 'google', md5($3::text) || md5($3::text || 'x'), $4, $5, $6, 'sealed-verifier')", [s.m.org.id, owner, name, expires, pending, used],
    ));
    await state("live", new Date(NOW.getTime() + 6 * 60_000), "sealed-choices");
    await state("expired", new Date(NOW.getTime() - 60 * 60_000), "sealed-choices");
    await state("old", new Date(NOW.getTime() - 3 * DAY), "sealed-choices");
    await state("spent", new Date(NOW.getTime() + 5 * 60_000), "sealed-choices", new Date(NOW.getTime() - 60_000));
    const out = await purgeReputationRecords({ now: NOW });
    expect(out.signIns).toBeGreaterThanOrEqual(4);
    const left = await all<{ pending: string | null; code_verifier: string | null; used_at: Date | null }>("select pending, code_verifier, used_at from review_oauth_states where org_id = $1 order by expires_at", [s.m.org.id]);
    expect(left).toHaveLength(3); // "old" is gone
    expect(left.map((r) => r.pending)).toEqual([null, null, "sealed-choices"].map((x) => x)); // expired, spent cleared; live kept
    expect(left.slice(0, 2).every((r) => r.code_verifier === null)).toBe(true);
    expect(left[2].code_verifier).toBe("sealed-verifier");
  });

  it("removes the reviews read through a connection a long time after it was disconnected, with their replies and history, and keeps the connection's own row and a recent one's reviews", async () => {
    const s = await reviewsShop("Purge Disconnected Shop");
    const old = await mirror(s, "old", ["a", "b", "c"]);
    const recent = await mirror(s, "recent", ["a", "b"]);
    const live = await mirror(s, "live", ["a"]);
    const review = await mirrored(old.id, "old-a");
    const { id: replyId } = await one<{ id: string }>("insert into review_replies (org_id, review_id, body, author_id) values ($1, $2, 'Thank you.', $3) returning id", [s.m.org.id, review.id, s.m.people.owner.id]);
    await withSystem((db) => db.query("insert into review_reply_events (org_id, reply_id, kind) values ($1, $2, 'created')", [s.m.org.id, replyId]));
    for (const [c, ago] of [[old, MIRROR_DAYS_AFTER_DISCONNECT + 10], [recent, 20]] as const) {
      await withSystem((db) => db.query("update review_connections set status = 'disconnected', credentials = null, disconnected_at = $2 where id = $1", [c.id, daysAgo(ago)]));
    }
    const out = await purgeReputationRecords({ now: NOW });
    expect(out.disconnectedReviews).toBe(3);
    expect(await count("select count(*)::text as n from external_reviews where connection_id = $1", [old.id])).toBe(0);
    expect(await count("select count(*)::text as n from review_replies where id = $1", [replyId])).toBe(0);
    expect(await count("select count(*)::text as n from review_reply_events where reply_id = $1", [replyId])).toBe(0);
    expect(await count("select count(*)::text as n from external_reviews where connection_id = $1", [recent.id])).toBe(2);
    expect(await count("select count(*)::text as n from external_reviews where connection_id = $1", [live.id])).toBe(1);
    expect(await count("select count(*)::text as n from review_connections where id = $1", [old.id])).toBe(1); // the history of having been connected stays
  });

  it("removes reviews the site stopped returning once they have been gone a while, unless a reply to one is still in progress", async () => {
    const s = await reviewsShop("Purge Removed Shop");
    const c = await mirror(s, "rm", ["gone-long", "gone-recent", "gone-open", "stays"]);
    const set = (id: string, when: Date) => withSystem((db) => db.query("update external_reviews set removed_at = $2 where connection_id = $1 and provider_review_id = $3", [c.id, when, id]));
    await set("rm-gone-long", daysAgo(REMOVED_REVIEW_DAYS + 5));
    await set("rm-gone-recent", daysAgo(10));
    await set("rm-gone-open", daysAgo(REMOVED_REVIEW_DAYS + 5));
    const open = await mirrored(c.id, "rm-gone-open");
    await withSystem((db) => db.query("insert into review_replies (org_id, review_id, body, author_id) values ($1, $2, 'A reply still being written.', $3)", [s.m.org.id, open.id, s.m.people.owner.id]));
    const out = await purgeReputationRecords({ now: NOW });
    expect(out.removedReviews).toBe(1);
    const left = (await all<{ provider_review_id: string }>("select provider_review_id from external_reviews where connection_id = $1 order by provider_review_id", [c.id])).map((r) => r.provider_review_id);
    expect(left).toEqual(["rm-gone-open", "rm-gone-recent", "rm-stays"]);
  });

  it("removes the history of finished replies once it is old, and keeps the history of replies still open and of recent ones", async () => {
    const s = await reviewsShop("Purge Events Shop");
    const c = await mirror(s, "ev", ["a", "b", "c"]);
    const mk = async (id: string, status: string) => {
      const review = await mirrored(c.id, `ev-${id}`);
      const extra = status === "posted" ? ", posted_at, posted_via, approved_version, approved_hash, approved_by" : "";
      const vals = status === "posted" ? ", now(), 'person', 1, repeat('a', 64), $4" : "";
      return (await one<{ id: string }>(`insert into review_replies (org_id, review_id, body, status, author_id${extra}) values ($1, $2, 'Thank you.', $3, $4${vals}) returning id`, [s.m.org.id, review.id, status, s.m.people.owner.id])).id;
    };
    const finished = await mk("a", "cancelled");
    const open = await mk("b", "draft");
    const posted = await mk("c", "posted");
    const event = (replyId: string, ago: number) => withSystem((db) => db.query("insert into review_reply_events (org_id, reply_id, kind, at) values ($1, $2, 'created', $3)", [s.m.org.id, replyId, daysAgo(ago)]));
    await event(finished, FINISHED_REPLY_EVENT_DAYS + 30);
    await event(open, FINISHED_REPLY_EVENT_DAYS + 30);
    await event(posted, 30);
    const out = await purgeReputationRecords({ now: NOW });
    expect(out.replyEvents).toBe(1);
    expect(await count("select count(*)::text as n from review_reply_events where reply_id = $1", [finished])).toBe(0);
    expect(await count("select count(*)::text as n from review_reply_events where reply_id = $1", [open])).toBe(1);
    expect(await count("select count(*)::text as n from review_reply_events where reply_id = $1", [posted])).toBe(1);
  });

  it("does nothing to a workspace's live connection, its reviews, or another workspace's records", async () => {
    const a = await reviewsShop("Purge Keep A");
    const b = await reviewsShop("Purge Keep B");
    const ca = await mirror(a, "ka", ["a", "b"]);
    const cb = await mirror(b, "kb", ["a"]);
    const out = await purgeReputationRecords({ now: NOW });
    expect(out.disconnectedReviews + out.removedReviews).toBe(0);
    expect(await count("select count(*)::text as n from external_reviews where connection_id = any($1::uuid[])", [[ca.id, cb.id]])).toBe(3);
    expect(await purgeReputationRecords({ now: NOW })).toEqual({ signIns: 0, disconnectedReviews: 0, removedReviews: 0, replyEvents: 0 });
  });
});

describe("through the tick endpoint", () => {
  const releaseLease = () => withSystem((db) => db.query("update worker_job_runs set last_finished_at = now() - interval '5 minutes' where job_name = 'scheduler_tick' and last_finished_at is not null"));
  async function runTick() {
    await releaseLease();
    const res = await tick(new Request("http://localhost/api/internal/tick", { method: "POST", headers: { authorization: `Bearer ${CRON}` } }));
    expect(res.status).toBe(200);
    return ((await res.json()) as { ran: Record<string, number | string> }).ran;
  }
  const setOnly = (value: string) => {
    process.env.SCHEDULER_JOBS_ONLY = value;
    resetEnvCache();
  };
  const heartbeats = async () => (await all<{ job_name: string }>("select job_name from worker_job_runs order by job_name")).map((r) => r.job_name);

  it("registers the three jobs with their rhythm and a plain label, after the review request batches and before the dispatcher", () => {
    expect(JOBS.find((j) => j.name === "reviewSync")).toMatchObject({ everyMinutes: 60 });
    expect(JOBS.find((j) => j.name === "renewalReminders")).toMatchObject({ everyMinutes: 1440 });
    expect(JOBS.find((j) => j.name === "reputationRetention")).toMatchObject({ everyMinutes: 1440 });
    const names = JOBS.map((j) => j.name);
    for (const n of ["reviewSync", "renewalReminders", "reputationRetention"]) {
      expect(n).toMatch(/^[A-Za-z][A-Za-z0-9]*$/);
      expect(names.filter((x) => x === n)).toHaveLength(1);
      expect(names.indexOf(n)).toBeGreaterThan(names.indexOf("reviewRequestBatches"));
      expect(names.indexOf(n)).toBeLessThan(names.indexOf("messagesDispatched"));
      expect(JOB_LABELS[n]).toBeTruthy();
    }
  });

  it("runs them only when they are named, and each does exactly its own work: reading, the team's reminder, the clean-up", async () => {
    simulatedReviews.reset();
    const s = await reviewsShop("Tick Reviews Shop");
    await saveReputationSettings(s.owner, { renewalRemindersEnabled: true }, 0);
    const c = await connectSim(s, "google", [simReview("t1"), simReview("t2", { rating: 1, daysAgo: 0 })]);
    await account(s.m.org.id, "Tick Customer", daysFrom(4, new Date()));
    await withSystem((db) => db.query("insert into review_oauth_states (org_id, user_id, provider, state_hash, expires_at, pending) values ($1, $2, 'google', md5('tick') || md5('tick2'), now() - interval '2 days', 'sealed')", [s.m.org.id, s.m.people.owner.id]));
    const before = await messagesIn(s.m.org.id);

    setOnly("aiWorkRecovery, crmWorkflowRecovery");
    const idle = await runTick();
    expect(Object.keys(idle)).toEqual(JOBS.map((j) => j.name).filter((n) => ["aiWorkRecovery", "crmWorkflowRecovery"].includes(n)));
    expect(await count("select count(*)::text as n from external_reviews where connection_id = $1", [c.id])).toBe(0);
    expect(await renewalTasks(s.m.org.id)).toEqual([]);
    expect(await count("select count(*)::text as n from review_oauth_states where org_id = $1", [s.m.org.id])).toBe(1);
    const beats = await heartbeats();
    for (const n of ["reviewSync", "renewalReminders", "reputationRetention"]) expect(beats).not.toContain(n);

    setOnly("reviewSync");
    const read = await runTick();
    expect(Object.keys(read)).toEqual(["reviewSync"]);
    expect(read.reviewSync).toBeGreaterThanOrEqual(0);
    expect(Object.values(read)).not.toContain("failed");
    expect(await count("select count(*)::text as n from external_reviews where connection_id = $1", [c.id])).toBe(2);
    expect(await renewalTasks(s.m.org.id)).toEqual([]);

    setOnly("renewalReminders,reputationRetention");
    const rest = await runTick();
    expect(Object.keys(rest)).toEqual(["renewalReminders", "reputationRetention"]);
    expect(Object.values(rest)).not.toContain("failed");
    expect(rest.renewalReminders).toBeGreaterThanOrEqual(1);
    expect(rest.reputationRetention).toBeGreaterThanOrEqual(1);
    expect(await renewalTasks(s.m.org.id)).toHaveLength(1);
    expect(await count("select count(*)::text as n from review_oauth_states where org_id = $1", [s.m.org.id])).toBe(0);
    // Nothing else started, no customer was written to, and no network call was made.
    expect(await heartbeats()).toEqual(expect.not.arrayContaining(["messagesDispatched", "retentionPrograms"]));
    expect(await messagesIn(s.m.org.id)).toBe(before);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not read for a workspace that has public reviews off, even when the job is named", async () => {
    simulatedReviews.reset();
    const s = await reviewsShop("Tick Off Shop");
    const c = await connectSim(s, "google", [simReview("o1")]);
    await setReviews(s.m.org.id, false);
    await withSystem((db) => db.query("update worker_job_runs set last_started_at = now() - interval '3 hours' where job_name = 'reviewSync'"));
    setOnly("reviewSync");
    await runTick();
    expect(await count("select count(*)::text as n from external_reviews where connection_id = $1", [c.id])).toBe(0);
  });
});
