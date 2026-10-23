// Connecting, checking and disconnecting accounts on embedded Postgres. The sign-in itself is replaced (no Meta app exists for this deployment).
import { afterEach, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { sha256 } from "@/server/security/crypto";
import { checkAccountHealth, checkAllAccounts, checkMyAccount, completeMetaConnect, connectChosenPages, connectSimulatedAccount, disconnectAccount, listAccounts, pendingChoices, purgeSignInStates, revokeByProviderUser, startMetaConnect } from "@/server/social/accounts";
import { openCredentials } from "@/server/social/credentials";
import { JOBS } from "@/server/ops/tick";
import { createPost, retryPost, submitForApproval } from "@/server/social/posts";
import { deletionStatus, handleDataDeletion } from "@/server/social/webhooks";
import { simulated, simulatedProvider } from "@/server/social/providers/simulated";
import { signRequestForTests, type MetaIdentity } from "@/server/social/providers/meta-oauth";
import { ProviderError } from "@/server/social/providers/types";
import { createOrg } from "./support/fixtures";
import { approvedPost, scheduledPost, rows, socialOrg, connect, textPost, tick, LATER, NOW } from "./support/social";

const identity = (over: Partial<MetaIdentity> = {}): MetaIdentity => ({
  userId: "FBUSER1", userName: "Olivia Owner",
  pages: [
    { id: "P1", name: "Harbor Home Services", token: "ptoken-one", tasks: ["CREATE_CONTENT"], instagram: { id: "IG1", username: "harborhome", name: "Harbor Home" } },
    { id: "P2", name: "Read-only Page", token: "ptoken-two", tasks: ["ANALYZE"], instagram: null },
    { id: "P3", name: "Broken Page", token: "ptoken-three", tasks: ["MANAGE"], instagram: null },
  ],
  ...over,
});

async function startState(s: Awaited<ReturnType<typeof socialOrg>>, over: { user?: string; expiresMinutes?: number; used?: boolean; state?: string } = {}) {
  const state = over.state ?? `state-${Math.random().toString(36).slice(2)}`;
  await withSystem((db) => db.query(
    "insert into social_oauth_states (org_id, user_id, platform, state_hash, expires_at, used_at) values ($1, $2, 'facebook', $3, now() + make_interval(mins => $4), $5)",
    [s.m.org.id, over.user ?? s.m.people.owner.id, sha256(state), over.expiresMinutes ?? 10, over.used ? new Date() : null],
  ));
  return state;
}

describe("starting a connection", () => {
  it("says plainly that nothing can be connected until the Meta app exists", async () => {
    const s = await socialOrg();
    await expect(startMetaConnect(s.owner, "facebook")).rejects.toThrow(/not set up for this deployment yet/);
  });

  it("is for the client's owner and manager only", async () => {
    const s = await socialOrg();
    await expect(startMetaConnect(s.sales, "facebook")).rejects.toThrow(/owner or a manager/);
    await expect(startMetaConnect(s.viewer, "instagram")).rejects.toThrow(/owner or a manager/);
  });
});

describe("coming back from the platform", () => {
  it("accepts a state once, for the person who started it, within ten minutes", async () => {
    const s = await socialOrg();
    const resolve = async () => identity();
    const stranger = await startState(s, { user: s.m.people.manager.id });
    await expect(completeMetaConnect({ id: s.m.people.owner.id }, { state: stranger, code: "c" }, { resolve })).rejects.toThrow(/expired or was not started by you/);
    const old = await startState(s, { expiresMinutes: -1 });
    await expect(completeMetaConnect({ id: s.m.people.owner.id }, { state: old, code: "c" }, { resolve })).rejects.toThrow(/expired/);
    const used = await startState(s, { used: true });
    await expect(completeMetaConnect({ id: s.m.people.owner.id }, { state: used, code: "c" }, { resolve })).rejects.toThrow(/expired/);
    await expect(completeMetaConnect({ id: s.m.people.owner.id }, { state: null, code: "c" }, { resolve })).rejects.toThrow(/did not start from iAcquire/);
    await expect(completeMetaConnect({ id: s.m.people.owner.id }, { state: "never-issued", code: "c" }, { resolve })).rejects.toThrow(/expired/);
  });

  it("treats a cancelled sign-in as cancelled, and uses the state up", async () => {
    const s = await socialOrg();
    const state = await startState(s);
    const out = await completeMetaConnect({ id: s.m.people.owner.id }, { state, error: "access_denied" });
    expect(out).toMatchObject({ outcome: "denied", stateId: null });
    await expect(completeMetaConnect({ id: s.m.people.owner.id }, { state, code: "late" }, { resolve: async () => identity() })).rejects.toThrow(/expired/);
  });

  it("refuses someone who lost the right to connect since they started", async () => {
    const s = await socialOrg();
    const state = await startState(s, { user: s.m.people.sales.id });
    await expect(completeMetaConnect({ id: s.m.people.sales.id }, { state, code: "c" }, { resolve: async () => identity() })).rejects.toThrow(/owner or a manager/);
  });

  it("stores the Pages and their tokens sealed, and shows the person only names", async () => {
    const s = await socialOrg();
    const state = await startState(s);
    const out = await completeMetaConnect({ id: s.m.people.owner.id }, { state, code: "c" }, { resolve: async () => identity() });
    expect(out.outcome).toBe("choose");
    const [row] = await rows<{ pending: string }>("select pending from social_oauth_states where id = $1", [out.stateId]);
    for (const secret of ["ptoken-one", "ptoken-two", "ptoken-three", "FBUSER1"]) expect(row.pending).not.toContain(secret);
    const view = await pendingChoices(s.owner, out.stateId as string);
    expect(JSON.stringify(view)).not.toContain("ptoken");
    expect(view.choices.map((c) => [c.name, c.canPost, c.instagram?.username ?? null])).toEqual([["Harbor Home Services", true, "harborhome"], ["Read-only Page", false, null], ["Broken Page", true, null]]);
    await expect(pendingChoices(s.manager, out.stateId as string)).rejects.toThrow(/expired/); // another person's pending choice is not theirs
  });

  it("explains a failed sign-in without Meta's raw response", async () => {
    const s = await socialOrg();
    const state = await startState(s);
    const resolve = async () => { throw new (await import("@/server/social/providers/types")).ProviderError("auth", "Meta did not accept the sign-in. Start again."); };
    await expect(completeMetaConnect({ id: s.m.people.owner.id }, { state, code: "bad" }, { resolve })).rejects.toThrow(/Start again/);
  });
});

describe("choosing what to connect", () => {
  async function chosen() {
    const s = await socialOrg();
    const state = await startState(s);
    const out = await completeMetaConnect({ id: s.m.people.owner.id }, { state, code: "c" }, { resolve: async () => identity() });
    simulated.revoke("ptoken-three");
    return { s, stateId: out.stateId as string };
  }

  it("connects only Pages that can be posted to, tests each first, and says why the rest were skipped", async () => {
    const { s, stateId } = await chosen();
    const r = await connectChosenPages(s.owner, stateId, [{ pageId: "P1", includeInstagram: true }, { pageId: "P2" }, { pageId: "P3" }, { pageId: "NOPE" }], { provider: simulatedProvider });
    expect(r.connected.map((a) => [a.platform, a.name, a.status])).toEqual(expect.arrayContaining([["facebook", "Harbor Home Services", "connected"], ["instagram", "Harbor Home", "connected"]]));
    expect(r.connected).toHaveLength(2);
    expect(r.skipped.map((x) => x.name).sort()).toEqual(["Broken Page", "NOPE", "Read-only Page"]);
    expect(r.skipped.find((x) => x.name === "Read-only Page")?.reason).toMatch(/does not let you publish/);
    expect(r.skipped.find((x) => x.name === "Broken Page")?.reason).toMatch(/no longer accepts/);
    // The token is stored sealed and opens only to the same token; the list never carries it.
    const [acc] = await rows<{ credentials: string }>("select credentials from social_accounts where external_id = 'P1'");
    expect(acc.credentials).not.toContain("ptoken-one");
    expect(openCredentials(acc.credentials)).toEqual({ accessToken: "ptoken-one" });
    expect(JSON.stringify(await listAccounts(s.owner))).not.toContain("ptoken");
    // The sign-in is used up.
    await expect(connectChosenPages(s.owner, stateId, [{ pageId: "P1" }], { provider: simulatedProvider })).rejects.toThrow(/expired/);
  });

  it("updates an account that is reconnected instead of making a second one", async () => {
    const s = await socialOrg();
    for (let i = 0; i < 2; i++) {
      const state = await startState(s);
      const out = await completeMetaConnect({ id: s.m.people.owner.id }, { state, code: "c" }, { resolve: async () => identity() });
      await connectChosenPages(s.owner, out.stateId as string, [{ pageId: "P1" }], { provider: simulatedProvider });
    }
    expect((await rows("select id from social_accounts where org_id = $1 and external_id = 'P1' and status <> 'disconnected'", [s.m.org.id]))).toHaveLength(1);
  });

  it("will not connect anything for someone who cannot connect", async () => {
    const { s, stateId } = await chosen();
    await expect(connectChosenPages(s.sales, stateId, [{ pageId: "P1" }], { provider: simulatedProvider })).rejects.toThrow(/owner or a manager/);
    await expect(connectChosenPages(s.owner, stateId, [], { provider: simulatedProvider })).rejects.toThrow(/at least one Page/);
  });
});

describe("keeping an eye on a connection", () => {
  it("notices a sign-in the platform no longer accepts, stops what was waiting, and tells the owner and managers", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const post = await scheduledPost(s, acc.id);
    simulated.revoke("sim_valid");
    expect(await checkAccountHealth(acc.id)).toBe("needs_reauth");
    const [a] = await rows<{ status: string; status_detail: string }>("select status, status_detail from social_accounts where id = $1", [acc.id]);
    expect(a.status).toBe("needs_reauth");
    const [p] = await rows<{ status: string; failure_code: string }>("select status, failure_code from social_posts where id = $1", [post.id]);
    expect(p).toMatchObject({ status: "failed", failure_code: "account_unavailable" });
    expect((await tick(s, LATER)).claimed).toBe(0);
    const n = await rows<{ user_id: string }>("select user_id from notifications where org_id = $1 and kind = 'social_account_attention'", [s.m.org.id]);
    expect(new Set(n.map((x) => x.user_id))).toEqual(new Set([s.m.people.owner.id, s.m.people.manager.id]));
    // Checking again does not announce it again the same day.
    await checkAccountHealth(acc.id);
    expect((await rows("select id from notifications where org_id = $1 and kind = 'social_account_attention'", [s.m.org.id])).length).toBe(n.length);
  });

  it("records a healthy check and sweeps every account", async () => {
    const s = await socialOrg();
    await connect(s, "facebook", "One");
    await connect(s, "instagram", "Two");
    expect(await checkAllAccounts()).toBeGreaterThanOrEqual(2);
    const accounts = await listAccounts(s.owner);
    expect(accounts.every((a) => a.status === "connected" && a.lastCheckedAt)).toBe(true);
  });

  it("reads a lost sign-in as one that must be reconnected, not as an outage", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    await withSystem((db) => db.query("update social_accounts set credentials = 'v1.not.a.real.payload' where id = $1", [acc.id]));
    expect(await checkAccountHealth(acc.id)).toBe("needs_reauth");
  });
});

describe("disconnecting", () => {
  it("deletes the token, stops what was waiting, is audited, and keeps the history", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const post = await scheduledPost(s, acc.id);
    const r = await disconnectAccount(s.owner, acc.id);
    expect(r.stopped).toBe(1);
    const [a] = await rows<{ status: string; credentials: string | null }>("select status, credentials from social_accounts where id = $1", [acc.id]);
    expect(a).toMatchObject({ status: "disconnected", credentials: null });
    expect((await rows("select status from social_posts where id = $1", [post.id]))[0]).toMatchObject({ status: "failed" });
    expect((await rows("select action from audit_logs where org_id = $1 and action = 'social.account_disconnected'", [s.m.org.id]))).toHaveLength(1);
    expect(await listAccounts(s.owner)).toEqual([]);
    expect(await listAccounts(s.owner, { includeDisconnected: true })).toHaveLength(1);
    await expect(disconnectAccount(s.owner, acc.id)).rejects.toThrow(/not found/);
    expect((await tick(s, LATER)).claimed).toBe(0);
  });

  it("forgets the platform's id for the person who connected the account", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    await withSystem((db) => db.query("update social_accounts set provider_user_id = 'fb-forget' where id = $1", [acc.id]));
    await disconnectAccount(s.owner, acc.id);
    expect((await rows<{ provider_user_id: string | null }>("select provider_user_id from social_accounts where id = $1", [acc.id]))[0].provider_user_id).toBeNull();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const lastChecked = async (id: string) => new Date((await rows<{ last_checked_at: Date }>("select last_checked_at from social_accounts where id = $1", [id]))[0].last_checked_at);
const accountRow = async (id: string) => (await rows<{ status: string; status_detail: string | null; credentials: string | null; last_success_at: Date; rate_state: Record<string, unknown> }>("select status, status_detail, credentials, last_success_at, rate_state from social_accounts where id = $1", [id]))[0];
const attention = (orgId: string) => rows<{ user_id: string; title: string; body: string; dedupe_key: string }>("select user_id, title, body, dedupe_key from notifications where org_id = $1 and kind = 'social_account_attention' order by created_at", [orgId]);

describe("a mangled link", () => {
  it("reads a connection id that is not an id as an expired connection, not as a database error", async () => {
    const s = await socialOrg();
    for (const bad of ["abc", "", "' or 1=1 --", "12345678-1234-1234-1234-12345678901"]) {
      await expect(pendingChoices(s.owner, bad), bad).rejects.toMatchObject({ code: "not_found", message: expect.stringMatching(/expired/) });
    }
    await expect(connectChosenPages(s.owner, "not-a-uuid", [{ pageId: "P1" }], { provider: simulatedProvider })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("sign-ins nobody finished", () => {
  async function pendingFor(s: Awaited<ReturnType<typeof socialOrg>>, userId = "FBUSER1") {
    const state = await startState(s);
    const out = await completeMetaConnect({ id: s.m.people.owner.id }, { state, code: "c" }, { resolve: async () => identity({ userId }) });
    return out.stateId as string;
  }
  const stateRow = async (id: string) => (await rows<{ pending: string | null; used_at: Date | null }>("select pending, used_at from social_oauth_states where id = $1", [id]))[0];

  it("empties the sealed Pages the moment the sign-in expires, leaves a live one alone, and deletes the state a day later", async () => {
    const s = await socialOrg();
    const stale = await pendingFor(s);
    const live = await pendingFor(s);
    await withSystem((db) => db.query("update social_oauth_states set expires_at = now() - interval '1 minute' where id = $1", [stale]));
    const first = await purgeSignInStates();
    expect(first.cleared).toBeGreaterThanOrEqual(1);
    expect((await stateRow(stale)).pending).toBeNull();
    expect((await stateRow(live)).pending).not.toBeNull();
    // The state itself stays for a day (a late click on the old link still says "expired"), then goes.
    expect(await stateRow(stale)).toBeDefined();
    const later = await purgeSignInStates(new Date(Date.now() + 2 * 86_400_000));
    expect(later.deleted).toBeGreaterThanOrEqual(2);
    expect(await stateRow(stale)).toBeUndefined();
    expect(await stateRow(live)).toBeUndefined();
  });

  it("runs from the scheduler as the socialCleanup job", async () => {
    const s = await socialOrg();
    const id = await pendingFor(s);
    await withSystem((db) => db.query("update social_oauth_states set expires_at = now() - interval '1 minute' where id = $1", [id]));
    const job = JOBS.find((j) => j.name === "socialCleanup");
    expect(job?.everyMinutes).toBe(15);
    expect(await job!.run()).toBeGreaterThanOrEqual(1);
    expect((await stateRow(id)).pending).toBeNull();
  });

  it("clears the sealed Pages when connecting fails part-way instead of keeping their tokens", async () => {
    const s = await socialOrg();
    const stateId = await pendingFor(s);
    // A platform answer the database cannot store: the connection fails after the sign-in's Pages were opened.
    const broken = { ...simulatedProvider, health: async () => ({ ...(await simulatedProvider.health({ accessToken: "sim_valid" }, { platform: "facebook", externalId: "P1" })), expiresAt: "not a date" as unknown as Date }) };
    await expect(connectChosenPages(s.owner, stateId, [{ pageId: "P1" }], { provider: broken })).rejects.toBeTruthy();
    const row = await stateRow(stateId);
    expect(row.pending).toBeNull();
    expect(row.used_at).not.toBeNull();
    expect(await listAccounts(s.owner)).toEqual([]);
  });

  it("is cleared by a deauthorization for that platform user only, even when they never connected anything", async () => {
    const s = await socialOrg();
    const gone = await pendingFor(s, "FB-GONE");
    const stays = await pendingFor(s, "FB-STAYS");
    expect(await revokeByProviderUser("FB-GONE", "deauthorized")).toBe(0);
    expect((await stateRow(gone)).pending).toBeNull();
    expect((await stateRow(gone)).used_at).not.toBeNull();
    expect((await stateRow(stays)).pending).not.toBeNull();
    // The person can no longer finish choosing from it.
    await expect(pendingChoices(s.owner, gone)).rejects.toThrow(/expired/);
    expect(await revokeByProviderUser("FB-STAYS", "data_deletion")).toBe(0);
    expect((await stateRow(stays)).pending).toBeNull();
  });

  it("is cleared by a data deletion request, the platform user id leaves every account row, and the status page says what was deleted", async () => {
    const s = await socialOrg();
    const live = await connect(s, "facebook", "Live");
    const off = await connect(s, "facebook", "Off");
    const lost = await connect(s, "instagram", "Lost");
    const other = await connect(s, "facebook", "Someone else's");
    await disconnectAccount(s.owner, off.id);
    await withSystem(async (db) => {
      await db.query("update social_accounts set provider_user_id = 'FB-ERASE' where id = any($1::uuid[])", [[live.id, off.id, lost.id]]);
      await db.query("update social_accounts set status = 'revoked', credentials = null where id = $1", [lost.id]);
      await db.query("update social_accounts set provider_user_id = 'FB-OTHER' where id = $1", [other.id]);
    });
    const pending = await pendingFor(s, "FB-ERASE");
    const secret = "test-app-secret-0123456789";
    const out = await handleDataDeletion(`signed_request=${signRequestForTests({ user_id: "FB-ERASE" }, secret)}`, { secret });
    expect(out.status).toBe(200);
    expect((await accountRow(live.id)).status).toBe("revoked");
    expect((await accountRow(live.id)).credentials).toBeNull();
    expect(await rows("select id from social_accounts where provider_user_id = 'FB-ERASE'")).toHaveLength(0);
    expect((await stateRow(pending)).pending).toBeNull();
    // Another person's account is untouched.
    expect((await accountRow(other.id)).status).toBe("connected");
    expect((await rows<{ provider_user_id: string }>("select provider_user_id from social_accounts where id = $1", [other.id]))[0].provider_user_id).toBe("FB-OTHER");
    const status = await deletionStatus(out.body.confirmation_code as string);
    expect(status.body.detail).toMatch(/unfinished sign-ins and platform user id/);
  });

  it("announces a second deauthorization of an account that was connected again", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    await withSystem((db) => db.query("update social_accounts set provider_user_id = 'FB-TWICE' where id = $1", [acc.id]));
    await revokeByProviderUser("FB-TWICE", "deauthorized");
    await withSystem((db) => db.query("update social_accounts set status = 'connected', provider_user_id = 'FB-TWICE', credentials = $2 where id = $1", [acc.id, `v1.${"x".repeat(10)}`]));
    await revokeByProviderUser("FB-TWICE", "deauthorized");
    expect((await attention(s.m.org.id)).filter((n) => n.dedupe_key.startsWith(`social-revoked:${acc.id}`) && n.user_id === s.m.people.owner.id)).toHaveLength(2);
  });
});

describe("a Page that is connected again", () => {
  it("takes the posts that were waiting on it along, and leaves published posts, posts that may be live and other Pages and workspaces alone", async () => {
    const s = await socialOrg();
    const first = await connectSimulatedAccount(s.owner, { platform: "facebook", name: "Harbor", externalId: "page-keep" });
    const elsewhere = await connectSimulatedAccount(s.owner, { platform: "facebook", name: "Another Page", externalId: "page-other" });
    const draft = await createPost(s.sales, textPost(first.id, { caption: "A draft." }));
    const pending = await submitForApproval(s.sales, (await createPost(s.sales, textPost(first.id, { caption: "Waiting." }))).id);
    const approved = await approvedPost(s, first.id, { caption: "Approved." });
    const scheduled = await scheduledPost(s, first.id, { caption: "Scheduled." });
    const published = await approvedPost(s, first.id, { caption: "Already out." });
    const maybeLive = await approvedPost(s, first.id, { caption: "Maybe out." });
    const otherPage = await createPost(s.sales, textPost(elsewhere.id, { caption: "On the other Page." }));
    await withSystem(async (db) => {
      await db.query("update social_posts set status = 'published', provider_post_id = 'fb_1', published_at = now() where id = $1", [published.id]);
      await db.query("update social_posts set status = 'failed', failure_code = 'unknown_outcome', failure_message = 'Not known.' where id = $1", [maybeLive.id]);
    });
    // The same Page id in another workspace, also disconnected, with a draft.
    const b = await socialOrg();
    const theirs = await connectSimulatedAccount(b.owner, { platform: "facebook", name: "Harbor", externalId: "page-keep" });
    const theirDraft = await createPost(b.sales, textPost(theirs.id));
    await disconnectAccount(b.owner, theirs.id);
    await disconnectAccount(s.owner, first.id);
    await disconnectAccount(s.owner, elsewhere.id);
    expect((await rows<{ status: string; failure_code: string }>("select status, failure_code from social_posts where id = $1", [scheduled.id]))[0]).toEqual({ status: "failed", failure_code: "account_unavailable" });

    const second = await connectSimulatedAccount(s.owner, { platform: "facebook", name: "Harbor", externalId: "page-keep" });
    expect(second.id).not.toBe(first.id);
    const where = async (id: string) => (await rows<{ account_id: string; status: string }>("select account_id, status from social_posts where id = $1", [id]))[0];
    for (const [post, status] of [[draft, "draft"], [pending, "pending_approval"], [approved, "approved"], [scheduled, "failed"]] as const) {
      expect(await where(post.id), post.id).toEqual({ account_id: second.id, status });
      const events = await rows<{ detail: { from: string; to: string }; actor_id: string }>("select detail, actor_id from social_post_events where post_id = $1 and kind = 'account_reconnected'", [post.id]);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ detail: { from: first.id, to: second.id }, actor_id: s.m.people.owner.id });
    }
    // History and uncertainty stay where they happened; nothing crosses to another Page or workspace.
    for (const post of [published, maybeLive]) {
      expect((await where(post.id)).account_id).toBe(first.id);
      expect(await rows("select id from social_post_events where post_id = $1 and kind = 'account_reconnected'", [post.id])).toHaveLength(0);
    }
    expect((await where(otherPage.id)).account_id).toBe(elsewhere.id);
    expect((await where(theirDraft.id)).account_id).toBe(theirs.id);

    // What the owner was told to do now works: schedule the failed post again, and send the draft for approval.
    expect((await retryPost(s.manager, scheduled.id, { now: NOW })).status).toBe("scheduled");
    expect((await submitForApproval(s.sales, draft.id)).status).toBe("pending_approval");
  });

  it("also follows the Page when it is connected again through the Meta sign-in", async () => {
    const s = await socialOrg();
    const connectP1 = async () => {
      const state = await startState(s);
      const out = await completeMetaConnect({ id: s.m.people.owner.id }, { state, code: "c" }, { resolve: async () => identity() });
      return (await connectChosenPages(s.owner, out.stateId as string, [{ pageId: "P1" }], { provider: simulatedProvider })).connected[0];
    };
    const first = await connectP1();
    const draft = await createPost(s.sales, textPost(first.id));
    await disconnectAccount(s.owner, first.id);
    const second = await connectP1();
    expect(second.id).not.toBe(first.id);
    expect((await rows<{ account_id: string }>("select account_id from social_posts where id = $1", [draft.id]))[0].account_id).toBe(second.id);
  });
});

describe("an account the platform cannot be asked about", () => {
  const down = (kind: "transient" | "rate_limited" | "unknown_outcome") => simulated.failNext("health", new ProviderError(kind, "The platform had a temporary problem. It will try again."));
  const T0 = new Date("2026-10-23T10:00:00Z");
  const T1 = new Date("2026-10-23T16:00:00Z");

  it("stays connected, says why it was not re-checked, keeps its last success, tells no one, and still publishes what is due", async () => {
    for (const kind of ["transient", "rate_limited", "unknown_outcome"] as const) {
      const s = await socialOrg();
      const acc = await connect(s);
      const post = await scheduledPost(s, acc.id);
      expect(await checkAccountHealth(acc.id, { now: T0 })).toBe("connected");
      down(kind);
      expect(await checkAccountHealth(acc.id, { now: T1 }), kind).toBe("connected");
      const row = await accountRow(acc.id);
      expect(row).toMatchObject({ status: "connected", status_detail: "The platform had a temporary problem. It will try again." });
      expect(new Date(row.last_success_at).getTime()).toBe(T0.getTime()); // not a success
      expect((await lastChecked(acc.id)).getTime()).toBe(T1.getTime());
      expect(await attention(s.m.org.id)).toEqual([]);
      expect(await tick(s, LATER)).toMatchObject({ claimed: 1, succeeded: 1 });
      expect((await rows<{ status: string }>("select status from social_posts where id = $1", [post.id]))[0].status).toBe("published");
      // The next real answer clears the note.
      expect(await checkAccountHealth(acc.id, { now: new Date("2026-10-23T22:00:00Z") })).toBe("connected");
      expect((await accountRow(acc.id)).status_detail).toBeNull();
    }
  });

  it("does not change an account that needs reconnecting, or the reason it gave, and leaves one in 'error' as it was", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    simulated.revoke("sim_valid");
    expect(await checkAccountHealth(acc.id)).toBe("needs_reauth");
    const reason = (await accountRow(acc.id)).status_detail;
    expect(reason).toMatch(/no longer accepts/);
    down("transient");
    expect(await checkAccountHealth(acc.id)).toBe("needs_reauth");
    expect((await accountRow(acc.id)).status_detail).toBe(reason);
    const e = await connect(s, "facebook", "Errored");
    await withSystem((db) => db.query("update social_accounts set status = 'error', status_detail = 'Earlier problem.' where id = $1", [e.id]));
    down("rate_limited");
    expect(await checkAccountHealth(e.id)).toBe("error");
  });

  it("does change the status when the platform answers with a refusal it means, and a lost sign-in still needs reconnecting", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    simulated.failNext("health", new ProviderError("invalid_content", "The platform refused this request."));
    expect(await checkAccountHealth(acc.id)).toBe("error");
    expect(await accountRow(acc.id)).toMatchObject({ status: "error", status_detail: "The platform refused this request." });
    expect(await checkAccountHealth(acc.id)).toBe("connected"); // a good answer brings it back
    simulated.failNext("health", new ProviderError("auth", "The platform no longer accepts this account's sign-in.", { needsReauth: true }));
    expect(await checkAccountHealth(acc.id)).toBe("needs_reauth");
    expect((await attention(s.m.org.id)).length).toBeGreaterThan(0);
  });

  it("is reported to the person who tests it as unreachable, not as confirmed", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    down("transient");
    await expect(checkMyAccount(s.owner, acc.id)).rejects.toMatchObject({ code: "upstream_error", message: expect.stringMatching(/could not be reached just now/) });
    expect((await accountRow(acc.id)).status).toBe("connected");
    expect(await checkMyAccount(s.owner, acc.id)).toBe("connected");
  });
});

describe("a check that is overtaken", () => {
  /** Runs `during` after the platform has been asked and before its answer is written, the way a click on Disconnect would. */
  function duringHealth(during: () => Promise<unknown>) {
    const original = simulatedProvider.health;
    return vi.spyOn(simulatedProvider, "health").mockImplementationOnce(async (...args: Parameters<typeof original>) => {
      const answer = await original.apply(simulatedProvider, args);
      await during();
      return answer;
    });
  }

  it("does not bring a disconnected account back to life", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    duringHealth(() => disconnectAccount(s.owner, acc.id));
    expect(await checkAccountHealth(acc.id)).toBe("disconnected");
    expect(await accountRow(acc.id)).toMatchObject({ status: "disconnected", status_detail: "Disconnected by a person.", credentials: null });
    expect((await listAccounts(s.owner)).map((a) => a.id)).not.toContain(acc.id);
  });

  it("announces nothing and stops nothing for an account that was disconnected meanwhile, even if the platform said it needed reconnecting", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    simulated.revoke("sim_valid");
    duringHealth(() => disconnectAccount(s.owner, acc.id));
    expect(await checkAccountHealth(acc.id)).toBe("disconnected");
    expect(await accountRow(acc.id)).toMatchObject({ status: "disconnected" });
    expect(await attention(s.m.org.id)).toEqual([]);
  });

  it("is reported to the person who tested it as an account that is gone", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    duringHealth(() => disconnectAccount(s.owner, acc.id));
    await expect(checkMyAccount(s.owner, acc.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("is dropped when a revoke lands first, and the revoked account is not announced as needing a reconnect", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    await withSystem((db) => db.query("update social_accounts set provider_user_id = 'FB-RACE' where id = $1", [acc.id]));
    duringHealth(() => revokeByProviderUser("FB-RACE", "deauthorized"));
    expect(await checkAccountHealth(acc.id)).toBe("revoked");
    expect((await accountRow(acc.id)).status).toBe("revoked");
    // The revoke told the owner and the manager; the overtaken check added nothing (no "needs to be reconnected").
    expect(new Set((await attention(s.m.org.id)).map((n) => n.title))).toEqual(new Set([`${acc.name} was disconnected`]));
  });
});

describe("what a health check leaves alone", () => {
  it("keeps the publish block when it reads Instagram's posting limit", async () => {
    const s = await socialOrg();
    const acc = await connect(s, "instagram", "Harbor IG");
    const until = new Date(NOW.getTime() + 24 * 3_600_000).toISOString();
    await withSystem((db) => db.query("update social_accounts set rate_state = jsonb_build_object('blockedUntil', $2::text, 'quotaUsage', 1, 'quotaTotal', 10) where id = $1", [acc.id, until]));
    simulated.setQuota({ usage: 3, total: 25 });
    await checkAccountHealth(acc.id, { now: NOW });
    expect((await accountRow(acc.id)).rate_state).toMatchObject({ blockedUntil: until, quotaUsage: 3, quotaTotal: 25, checkedAt: NOW.toISOString() });
    // When the limit cannot be read, the block and the last known numbers stay as they were.
    simulated.setQuota(null);
    await checkAccountHealth(acc.id, { now: NOW });
    expect((await accountRow(acc.id)).rate_state).toMatchObject({ blockedUntil: until, quotaUsage: 3, quotaTotal: 25 });
  });
});

describe("the health sweep", () => {
  const T = new Date("2026-11-01T00:00:00Z");

  it("skips workspaces that are suspended, paused by the agency or have outbound paused, and checks the rest", async () => {
    const run = await socialOrg();
    const suspended = await socialOrg();
    const agencyPaused = await socialOrg();
    const outboundPaused = await socialOrg();
    const ids = { run: (await connect(run)).id, suspended: (await connect(suspended)).id, agencyPaused: (await connect(agencyPaused)).id, outboundPaused: (await connect(outboundPaused)).id };
    await withSystem(async (db) => {
      await db.query("update organizations set status = 'suspended' where id = $1", [suspended.m.org.id]);
      await db.query("insert into automation_pauses (org_id, scope, active, set_by, set_at) values ($1, 'agency', true, $3, now()), ($2, 'outbound', true, $3, now())", [agencyPaused.m.org.id, outboundPaused.m.org.id, run.m.people.owner.id]);
    });
    expect(await checkAllAccounts({ now: T })).toBeGreaterThanOrEqual(1);
    expect((await lastChecked(ids.run)).getTime()).toBe(T.getTime());
    for (const held of [ids.suspended, ids.agencyPaused, ids.outboundPaused]) expect((await lastChecked(held)).getTime(), held).not.toBe(T.getTime());
    // Reactivated, the next sweep picks them up.
    await withSystem(async (db) => {
      await db.query("update organizations set status = 'active' where id = $1", [suspended.m.org.id]);
      await db.query("update automation_pauses set active = false where org_id = any($1::uuid[])", [[agencyPaused.m.org.id, outboundPaused.m.org.id]]);
    });
    const T2 = new Date("2026-11-02T00:00:00Z");
    await checkAllAccounts({ now: T2 });
    for (const back of [ids.suspended, ids.agencyPaused, ids.outboundPaused]) expect((await lastChecked(back)).getTime(), back).toBe(T2.getTime());
  });

  it("stops starting new checks when its time is spent, so a slow platform cannot hold up the scheduler", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const before = await lastChecked(acc.id);
    expect(await checkAllAccounts({ now: T, budgetMs: 0 })).toBe(0);
    expect((await lastChecked(acc.id)).getTime()).toBe(before.getTime());
    expect(await checkAllAccounts({ now: T })).toBeGreaterThanOrEqual(1);
    expect((await lastChecked(acc.id)).getTime()).toBe(T.getTime());
  });
});

describe("warning before a sign-in runs out", () => {
  const set = (id: string, token: string | null, data: string | null = null) => withSystem((db) => db.query("update social_accounts set token_expires_at = $2, data_access_expires_at = $3 where id = $1", [id, token, data]));
  const expiry = async (orgId: string) => (await attention(orgId)).filter((n) => n.dedupe_key.startsWith("social-expiry:"));

  it("tells the owner and managers once per account and date, from a week out", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const people = new Set([s.m.people.owner.id, s.m.people.manager.id]);
    await set(acc.id, "2026-12-01T00:00:00Z"); // far away
    await checkAccountHealth(acc.id, { now: NOW });
    expect(await expiry(s.m.org.id)).toEqual([]);

    await set(acc.id, "2026-10-26T00:00:00Z"); // three days out
    await checkAccountHealth(acc.id, { now: NOW });
    let notes = await expiry(s.m.org.id);
    expect(new Set(notes.map((n) => n.user_id))).toEqual(people);
    expect(notes).toHaveLength(2);
    expect(notes[0].title).toBe(`${acc.name} needs to be reconnected before 2026-10-26`);
    expect(notes[0].body).toMatch(/On 2026-10-26 its sign-in runs out\. Reconnect the account before then/);

    await checkAccountHealth(acc.id, { now: new Date(NOW.getTime() + 3_600_000) }); // checked again: the same date is not announced again
    expect(await expiry(s.m.org.id)).toHaveLength(2);

    await set(acc.id, "2026-10-29T18:00:00Z"); // a new date inside the week is a new warning
    await checkAccountHealth(acc.id, { now: NOW });
    expect(await expiry(s.m.org.id)).toHaveLength(4);

    await set(acc.id, "2026-10-30T12:00:00Z"); // exactly a week out counts; a day past it does not
    await checkAccountHealth(acc.id, { now: NOW });
    expect(await expiry(s.m.org.id)).toHaveLength(6);
    await set(acc.id, "2026-10-30T12:00:01Z");
    await checkAccountHealth(acc.id, { now: NOW });
    expect(await expiry(s.m.org.id)).toHaveLength(6);

    await set(acc.id, "2026-10-22T00:00:00Z"); // already past: a different problem, not a warning
    await checkAccountHealth(acc.id, { now: NOW });
    expect(await expiry(s.m.org.id)).toHaveLength(6);
    notes = await expiry(s.m.org.id);
    notes.forEach((n) => expect(people.has(n.user_id)).toBe(true));
  });

  it("names both when the sign-in and the platform's access to the account's data end on the same day", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    await set(acc.id, "2026-10-24T00:00:00Z", "2026-10-24T09:00:00Z");
    await checkAccountHealth(acc.id, { now: NOW });
    const notes = await expiry(s.m.org.id);
    expect(notes).toHaveLength(2); // one each for the owner and the manager
    expect(notes[0].body).toMatch(/its sign-in runs out and the platform's access to its data runs out/);
    await set(acc.id, null, "2026-10-27T00:00:00Z");
    await checkAccountHealth(acc.id, { now: NOW });
    expect((await expiry(s.m.org.id)).at(-1)!.body).toMatch(/On 2026-10-27 the platform's access to its data runs out/);
  });

  it("is part of the sweep", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    await set(acc.id, "2026-10-25T00:00:00Z");
    await checkAllAccounts({ now: NOW });
    expect((await expiry(s.m.org.id)).length).toBe(2);
  });
});

describe("social media belongs to the client's workspace", () => {
  const words = /Social media is managed inside each client's workspace/;

  it("refuses every account action in an agency workspace, in the same words", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const asAgency = { ...s.owner, org: { ...s.owner.org, kind: "agency" as const } };
    await expect(startMetaConnect(asAgency, "facebook")).rejects.toThrow(words);
    await expect(listAccounts(asAgency)).rejects.toThrow(words);
    await expect(connectSimulatedAccount(asAgency, { platform: "facebook", name: "Nope" })).rejects.toThrow(words);
    await expect(disconnectAccount(asAgency, acc.id)).rejects.toThrow(words);
    await expect(checkMyAccount(asAgency, acc.id)).rejects.toThrow(words);
    await expect(pendingChoices(asAgency, "12345678-1234-1234-1234-123456789012")).rejects.toThrow(words);
    await expect(connectChosenPages(asAgency, "12345678-1234-1234-1234-123456789012", [{ pageId: "P1" }], { provider: simulatedProvider })).rejects.toThrow(words);
    expect(await listAccounts(s.owner)).toHaveLength(1); // the client's own workspace is unaffected
  });

  it("refuses a sign-in that comes back for a workspace that is not a client's, and uses the state up", async () => {
    const s = await socialOrg();
    const agency = await createOrg({ kind: "agency" });
    const state = "state-agency-1";
    await withSystem((db) => db.query("insert into social_oauth_states (org_id, user_id, platform, state_hash, expires_at) values ($1, $2, 'facebook', $3, now() + interval '10 minutes')", [agency.id, s.m.people.owner.id, sha256(state)]));
    await expect(completeMetaConnect({ id: s.m.people.owner.id }, { state, code: "c" }, { resolve: async () => identity() })).rejects.toThrow(words);
    expect((await rows<{ used_at: Date | null; pending: string | null }>("select used_at, pending from social_oauth_states where state_hash = $1", [sha256(state)]))[0]).toMatchObject({ pending: null, used_at: expect.any(Date) });
  });
});
