// Connecting a review site to a workspace: who may, the honest state it shows, that credentials are sealed and never returned, that a Facebook connection borrows the Social
// media Page instead of copying its token, that disconnecting deletes what could sign in, and that one workspace never sees or touches another's. Synthetic workspaces on embedded
// Postgres; the review site is the in-process simulated one.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { agencyActor, startSupportSession } from "@/server/crm/actor";
import { connectSimulatedAccount, disconnectAccount } from "@/server/social/accounts";
import {
  checkConnection, connectFacebookPage, connectSimulatedSite, connectionCredentials, disconnectConnection, disconnectWorkspaceReviewConnections, getSites, listConnections, loadConnection, recordProviderFailure,
  replyPostable,
} from "@/server/reputation/connections";
import { setExternalReviewsEnabled } from "@/server/reputation/entitlement";
import { simulatedReviews } from "@/server/reputation/providers/simulated";
import { ProviderError } from "@/server/reputation/providers/types";
import { agencyPeople } from "./support/crm";
import { createOrg } from "./support/fixtures";
import { all, count, one, reviewsShop, setReviews, type ReputationShop } from "./support/reputation";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

async function expectError(p: Promise<unknown>, code: string, message?: RegExp) {
  const err = await p.then(() => null, (e: unknown) => e as { code?: string; message?: string });
  expect(err, "expected a refusal").not.toBeNull();
  expect(err?.code).toBe(code);
  if (message) expect(err?.message).toMatch(message);
}

let s: ReputationShop;
let other: ReputationShop;
beforeAll(async () => {
  s = await reviewsShop("Connections Shop");
  other = await reviewsShop("Other Connections Shop");
});
beforeEach(() => simulatedReviews.reset());

const row = (id: string) => one<{ status: string; credentials: string | null; social_account_id: string | null; adapter: string; can_reply: boolean; status_detail: string | null; disconnected_at: Date | null }>(
  "select status, credentials, social_account_id, adapter, can_reply, status_detail, disconnected_at from review_connections where id = $1", [id],
);

describe("switching public reviews on", () => {
  it("is off until a Super Admin switches it on for the workspace: nothing can be connected before", async () => {
    const dormant = await reviewsShop("Dormant Reviews Shop", { reviews: false });
    await expectError(connectSimulatedSite(dormant.owner, { provider: "google" }), "not_enabled", /aren't switched on/);
    // The honest states are still shown, so the person knows why.
    const sites = await getSites(dormant.owner);
    expect(sites.map((x) => x.provider)).toEqual(["google", "facebook"]);
    expect(sites.every((x) => x.connection === null)).toBe(true);
    await setReviews(dormant.m.org.id, true);
    expect((await connectSimulatedSite(dormant.owner, { provider: "google" })).status).toBe("connected");
  });

  it("is switched by a Super Admin alone, audited, and only for a client's own workspace", async () => {
    const t = await reviewsShop("Switch Shop", { reviews: false });
    await expectError(setExternalReviewsEnabled({ id: t.m.people.owner.id, platformRole: "none" }, t.m.org.id, true), "forbidden", /Super Admin/);
    await setExternalReviewsEnabled(t.m.superAdmin, t.m.org.id, true);
    expect(await count("select count(*)::text as n from org_features where org_id = $1 and feature = 'reputation_reviews' and enabled", [t.m.org.id])).toBe(1);
    expect(await count("select count(*)::text as n from audit_logs where org_id = $1 and action = 'reputation.reviews_enabled'", [t.m.org.id])).toBe(1);
    await setExternalReviewsEnabled(t.m.superAdmin, t.m.org.id, false);
    expect(await count("select count(*)::text as n from audit_logs where org_id = $1 and action = 'reputation.reviews_disabled'", [t.m.org.id])).toBe(1);
    const agency = await createOrg({ name: "Switch Agency", kind: "agency" });
    await expectError(setExternalReviewsEnabled(t.m.superAdmin, agency.id, true), "invalid_input", /client's own workspace/);
    await expectError(setExternalReviewsEnabled(t.m.superAdmin, "00000000-0000-4000-8000-000000000000", true), "not_found");
  });
});

describe("who may connect a review site", () => {
  it("lets the client's owner and managers, and no one else", async () => {
    for (const who of [s.owner, s.manager]) {
      const c = await connectSimulatedSite(who, { provider: "google" });
      expect(c).toMatchObject({ provider: "google", adapter: "simulated", simulated: true, status: "connected" });
    }
    for (const who of [s.sales, s.support, s.viewer]) await expectError(connectSimulatedSite(who, { provider: "google" }), "forbidden", /Only owners and managers/);
  });

  it("is for a client's own workspace: even an owner's rights cannot connect a review site in the agency's own workspace", async () => {
    // No member of the agency workspace can be a CRM member actor, so this is the check behind that rule: the same rights, pointed at the agency's workspace.
    await agencyPeople();
    const agencyId = (await one<{ id: string }>("select id from organizations where kind = 'agency'")).id;
    await withSystem((db) => db.query("insert into org_features (org_id, feature, enabled) values ($1, 'reputation_reviews', true) on conflict (org_id, feature) do update set enabled = true", [agencyId]));
    await expectError(connectSimulatedSite({ ...s.owner, orgId: agencyId }, { provider: "google" }), "forbidden", /client's own workspace/);
    expect(await count("select count(*)::text as n from review_connections where org_id = $1", [agencyId])).toBe(0);
  });

  it("lets iAcquire support look at the connections, and never connect, check, read or disconnect one", async () => {
    const c = await connectSimulatedSite(s.owner, { provider: "google" });
    const { superAdmin } = await agencyPeople();
    for (const mode of ["read", "write"] as const) {
      await startSupportSession(superAdmin, s.m.org.id, { mode, reason: `Looking at review sites (${mode})` });
      const agency = await agencyActor(superAdmin, s.m.org.id);
      expect((await listConnections(agency)).some((x) => x.id === c.id)).toBe(true);
      expect((await getSites(agency)).length).toBe(2);
      await expectError(connectSimulatedSite(agency, { provider: "google" }), "forbidden");
      await expectError(checkConnection(agency, c.id), "forbidden");
      await expectError(disconnectConnection(agency, c.id), "forbidden");
    }
    expect((await row(c.id)).status).toBe("connected");
  });

  it("never lets one workspace see, check or disconnect another's connection", async () => {
    const mine = await connectSimulatedSite(s.owner, { provider: "google" });
    const theirs = await connectSimulatedSite(other.owner, { provider: "google" });
    expect((await listConnections(s.owner)).map((c) => c.id)).toContain(mine.id);
    expect((await listConnections(s.owner)).map((c) => c.id)).not.toContain(theirs.id);
    expect((await listConnections(other.owner)).map((c) => c.id)).not.toContain(mine.id);
    await expectError(checkConnection(other.owner, mine.id), "not_found");
    await expectError(disconnectConnection(other.owner, mine.id), "not_found");
    expect((await row(mine.id)).status).toBe("connected");
    expect(await withSystem((db) => loadConnection(db, other.m.org.id, mine.id))).toBeNull();
  });
});

describe("what a connection keeps secret", () => {
  it("seals the sign-in: never in a view, never in plain text in the table, and the application role cannot read it", async () => {
    const c = await connectSimulatedSite(s.owner, { provider: "google" });
    expect(JSON.stringify(c)).not.toMatch(/sim_valid|refresh|credentials|token/i);
    const stored = await row(c.id);
    expect(stored.credentials).toBeTruthy();
    expect(stored.credentials).not.toContain("sim_valid");
    // Server code can open it; a person's database role cannot even select the column.
    const opened = await withSystem(async (db) => connectionCredentials(db, (await loadConnection(db, s.m.org.id, c.id)) as never));
    expect(opened).toEqual({ ok: true, creds: { refreshToken: "sim_valid" } });
    const probe = await all<{ has: boolean }>("select has_column_privilege('iaq_app_user', 'review_connections', 'credentials', 'SELECT') as has");
    expect(probe[0].has).toBe(false);
  });

  it("deletes the sign-in when a connection is disconnected, says so, and keeps the reviews already read", async () => {
    const c = await connectSimulatedSite(s.owner, { provider: "google" });
    await disconnectConnection(s.owner, c.id);
    expect(await row(c.id)).toMatchObject({ status: "disconnected", credentials: null, can_reply: false });
    expect((await row(c.id)).disconnected_at).not.toBeNull();
    expect(await count("select count(*)::text as n from audit_logs where org_id = $1 and action = 'reputation.connection_removed' and target_id = $2", [s.m.org.id, c.id])).toBe(1);
    expect((await listConnections(s.owner)).some((x) => x.id === c.id)).toBe(false);
    expect((await listConnections(s.owner, { includePast: true })).find((x) => x.id === c.id)?.status).toBe("disconnected");
    await expectError(disconnectConnection(s.owner, c.id), "not_found");
    await expectError(checkConnection(s.owner, c.id), "not_found");
  });

  it("is cleared for every connection of a workspace that is closing, one failing not stopping the others", async () => {
    const t = await reviewsShop("Closing Reviews Shop");
    const a = await connectSimulatedSite(t.owner, { provider: "google" });
    const b = await connectSimulatedSite(t.owner, { provider: "google" });
    const out = await disconnectWorkspaceReviewConnections(t.m.org.id, t.m.people.owner.id);
    expect(out).toEqual({ disconnected: 2, failed: [] });
    for (const c of [a, b]) expect(await row(c.id)).toMatchObject({ status: "disconnected", credentials: null });
    expect(await disconnectWorkspaceReviewConnections(t.m.org.id, t.m.people.owner.id)).toEqual({ disconnected: 0, failed: [] });
    // Nothing of another workspace was touched.
    const keep = await connectSimulatedSite(other.owner, { provider: "google" });
    await disconnectWorkspaceReviewConnections(t.m.org.id, t.m.people.owner.id);
    expect((await row(keep.id)).status).toBe("connected");
  });
});

describe("a Facebook connection reuses the Page connected for Social media", () => {
  it("reads through that Page without copying its token, and only the workspace that owns the Page can use it", async () => {
    const social = await connectSimulatedAccount(s.m.ctx("owner"), { platform: "facebook", name: "Harbor Home Page" });
    const sites = await getSites(s.owner);
    const fb = sites.find((x) => x.provider === "facebook");
    expect(fb?.pages.map((p) => [p.socialAccountId, p.hasPermission, p.connected])).toContainEqual([social.id, true, false]);
    const c = await connectFacebookPage(s.owner, social.id);
    expect(c).toMatchObject({ provider: "facebook", adapter: "simulated", socialAccountId: social.id, status: "connected" });
    const stored = await row(c.id);
    expect(stored.credentials).toBeNull();
    expect(stored.social_account_id).toBe(social.id);
    // The Page now shows as connected, and a second connection through it is refused by the one-live-connection rule.
    expect((await getSites(s.owner)).find((x) => x.provider === "facebook")?.pages.find((p) => p.socialAccountId === social.id)?.connected).toBe(true);
    await expectError(connectFacebookPage(s.owner, social.id), "conflict");
    // Another workspace can't use this Page, and learns nothing about it.
    await expectError(connectFacebookPage(other.owner, social.id), "not_found", /isn't connected in Social media/);
  });

  it("stops being readable when the Page is disconnected in Social media, and says to reconnect there", async () => {
    const t = await reviewsShop("Page Gone Shop");
    const social = await connectSimulatedAccount(t.m.ctx("owner"), { platform: "facebook", name: "Gone Page" });
    const c = await connectFacebookPage(t.owner, social.id);
    const ok = await withSystem(async (db) => connectionCredentials(db, (await loadConnection(db, t.m.org.id, c.id)) as never));
    expect(ok.ok).toBe(true);
    await disconnectAccount(t.m.ctx("owner"), social.id);
    const gone = await withSystem(async (db) => connectionCredentials(db, (await loadConnection(db, t.m.org.id, c.id)) as never));
    expect(gone).toEqual({ ok: false, reason: expect.stringMatching(/no longer connected in Social media/) });
    expect(await checkConnection(t.owner, c.id)).toBe("needs_reauth");
    expect(await row(c.id)).toMatchObject({ status: "needs_reauth" });
  });

  it("refuses a Page that isn't a connected Facebook Page of the workspace", async () => {
    const insta = await connectSimulatedAccount(s.m.ctx("owner"), { platform: "instagram", name: "harbor_gram" });
    await expectError(connectFacebookPage(s.owner, insta.id), "not_found");
    await expectError(connectFacebookPage(s.owner, "00000000-0000-4000-8000-000000000000"), "not_found");
  });

  it("refuses a Page that was disconnected in Social media, and connects nothing", async () => {
    const t = await reviewsShop("Page Off Shop");
    const social = await connectSimulatedAccount(t.m.ctx("owner"), { platform: "facebook", name: "Closed Page" });
    await disconnectAccount(t.m.ctx("owner"), social.id);
    await expectError(connectFacebookPage(t.owner, social.id), "not_found", /isn't connected in Social media/);
    expect(await count("select count(*)::text as n from review_connections where org_id = $1", [t.m.org.id])).toBe(0);
  });
});

describe("what a failure does to a connection", () => {
  const failures = async (c: { id: string; name: string }, err: unknown, now = new Date()) =>
    withSystem((db) => recordProviderFailure(db, { id: c.id, org_id: s.m.org.id, name: c.name, status: "connected" }, err, now));

  it("marks a refused sign-in as needing to be reconnected, and tells the owner and managers once a day", async () => {
    const c = await connectSimulatedSite(s.owner, { provider: "google" });
    const day1 = new Date("2026-10-24T08:00:00Z");
    await failures(c, new ProviderError("auth", "Google no longer accepts the saved sign-in.", { needsReauth: true }), day1);
    expect(await row(c.id)).toMatchObject({ status: "needs_reauth", can_reply: false });
    expect((await row(c.id)).status_detail).toMatch(/no longer accepts/);
    const notes = () => count("select count(*)::text as n from notifications where org_id = $1 and kind = 'review_connection_attention' and dedupe_key like $2", [s.m.org.id, `review-conn:${c.id}:%`]);
    const first = await notes();
    expect(first).toBeGreaterThanOrEqual(2); // the owner and the manager
    // The same day again: nobody is told twice.
    await failures(c, new ProviderError("auth", "Google no longer accepts the saved sign-in.", { needsReauth: true }), new Date("2026-10-24T20:00:00Z"));
    expect(await notes()).toBe(first);
  });

  it("changes nothing about the status for a site that could not be reached or is only limiting how often it is asked", async () => {
    const c = await connectSimulatedSite(s.owner, { provider: "google" });
    for (const err of [new ProviderError("transient", "Google could not be reached."), new ProviderError("rate_limited", "Google is limiting this.", { retryAfterSec: 900 }), new Error("socket hang up")]) {
      await failures(c, err);
      expect((await row(c.id)).status, String(err)).toBe("connected");
    }
    expect((await row(c.id)).status_detail).toMatch(/could not be reached/);
  });

  it("marks a definite refusal as an error, shown as a problem reading it", async () => {
    const c = await connectSimulatedSite(s.owner, { provider: "google" });
    await failures(c, new ProviderError("invalid_content", "Google could not find that location."));
    expect(await row(c.id)).toMatchObject({ status: "error" });
    const site = (await getSites(s.owner)).find((x) => x.provider === "google");
    expect(site?.state.state).toBe("error");
  });

  it("checks a connection against the site: a revoked sign-in is found, a working one is confirmed, and a site that can't be reached changes nothing", async () => {
    const t = await reviewsShop("Check Shop");
    const c = await connectSimulatedSite(t.owner, { provider: "google" });
    expect(await checkConnection(t.owner, c.id)).toBe("connected");
    simulatedReviews.revoke("sim_valid");
    expect(await checkConnection(t.owner, c.id)).toBe("needs_reauth");
    expect((await row(c.id)).status).toBe("needs_reauth");
    simulatedReviews.reset();
    const d = await connectSimulatedSite(t.owner, { provider: "google" });
    simulatedReviews.failNext("health", new ProviderError("transient", "Google could not be reached."));
    await expectError(checkConnection(t.owner, d.id), "upstream_error", /Nothing about it has changed/);
    expect((await row(d.id)).status).toBe("connected");
  });
});

describe("whether a reply can be posted from here", () => {
  it("needs a working connection, the site's reply switch and access that allows it; a test connection says it is a test", async () => {
    const t = await reviewsShop("Postable Shop");
    const c = await connectSimulatedSite(t.owner, { provider: "google" });
    expect(replyPostable({ adapter: "simulated", provider: "google", status: "connected", can_reply: true })).toEqual({ ok: true });
    expect(replyPostable({ adapter: "simulated", provider: "google", status: "connected", can_reply: false })).toMatchObject({ ok: false, reason: expect.stringMatching(/doesn't let iAcquire post replies/) });
    expect(replyPostable({ adapter: "simulated", provider: "google", status: "needs_reauth", can_reply: true })).toMatchObject({ ok: false, reason: expect.stringMatching(/needs attention/) });
    simulatedReviews.setReplySupport(false);
    expect(replyPostable({ adapter: "simulated", provider: "google", status: "connected", can_reply: true })).toMatchObject({ ok: false, reason: expect.stringMatching(/set not to take replies/) });
    simulatedReviews.setReplySupport(true);
    // The real sites' reply switches are off in this deployment: replying there is not offered, and the reason says so in plain words.
    for (const [adapter, provider] of [["google", "google"], ["meta", "facebook"]] as const) {
      const r = replyPostable({ adapter, provider, status: "connected", can_reply: true });
      expect(r.ok).toBe(false);
      expect(r.ok ? "" : r.reason).toMatch(/isn't switched on for iAcquire yet/);
    }
    expect(c.status).toBe("connected");
  });
});
