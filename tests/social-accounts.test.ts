// Connecting, checking and disconnecting accounts on embedded Postgres. The sign-in itself is replaced (no Meta app exists for this deployment).
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { sha256 } from "@/server/security/crypto";
import { checkAccountHealth, checkAllAccounts, completeMetaConnect, connectChosenPages, disconnectAccount, listAccounts, pendingChoices, startMetaConnect } from "@/server/social/accounts";
import { openCredentials } from "@/server/social/credentials";
import { simulated, simulatedProvider } from "@/server/social/providers/simulated";
import type { MetaIdentity } from "@/server/social/providers/meta-oauth";
import { scheduledPost, rows, socialOrg, connect, tick, LATER } from "./support/social";

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
});
