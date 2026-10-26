// Social media through a client's departure: shutdown disconnects the accounts and deletes their tokens, the data export carries what the client owns
// (without anything that signs in as them), and the final deletion removes it all. Embedded Postgres; the platform is the in-process simulated one.
import crypto from "node:crypto";
import fs from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { buildExport } from "@/server/offboarding/export";
import { readZip } from "@/server/offboarding/zip";
import { closeBilling, executeDeletion, getOffboarding, requestOffboardingAsAgency, shutdownClient } from "@/server/offboarding/service";
import { uploadMedia } from "@/server/social/media";
import { createPost } from "@/server/social/posts";
import { simulated } from "@/server/social/providers/simulated";
import { addAsset, approvedPost, connect, LATER, rows, scheduledPost, socialOrg, tick, type SocialOrg } from "./support/social";

async function close(s: SocialOrg) {
  const req = await requestOffboardingAsAgency(s.m.superAdmin, s.m.org.id, "Contract ended");
  return shutdownClient(s.m.superAdmin, req.id);
}

const accountState = (id: string) => rows<{ status: string; credentials: string | null; token_expires_at: Date | null; provider_user_id: string | null; status_detail: string | null }>(
  "select status, credentials, token_expires_at, provider_user_id, status_detail from social_accounts where id = $1", [id],
).then((r) => r[0]);

describe("shutting down a client with social media accounts", () => {
  it("disconnects every account as its owner would: tokens deleted, what was waiting stopped, nothing published afterwards, and the step is on the record", async () => {
    const s = await socialOrg({ name: "Closing Social Co" });
    const fb = await connect(s, "facebook", "Closing FB");
    const ig = await connect(s, "instagram", "Closing IG");
    await withSystem((db) => db.query("update social_accounts set provider_user_id = 'fb-closing', token_expires_at = now() + interval '30 days' where org_id = $1", [s.m.org.id]));
    const waiting = await scheduledPost(s, fb.id);
    const approved = await approvedPost(s, fb.id, { caption: "Approved but never scheduled." });
    const asset = await addAsset(s);
    const imagePost = await scheduledPost(s, ig.id, { kind: "image", mediaAssetIds: [asset], caption: "A picture." });

    const view = await close(s);
    expect(view.status).toBe("retention");
    expect(view.steps.map((x) => x.key)).toEqual(["automation", "messaging", "integrations", "social", "access", "website"]);
    const step = view.steps.find((x) => x.key === "social")!;
    expect(step.ok).toBe(true);
    expect(step.text).toMatch(/^Disconnected 2 social media accounts and deleted their sign-in tokens; 2 posts waiting to publish were stopped\./);

    for (const id of [fb.id, ig.id]) {
      expect(await accountState(id), id).toEqual({ status: "disconnected", credentials: null, token_expires_at: null, provider_user_id: null, status_detail: "The workspace was closed." });
    }
    for (const p of [waiting, imagePost]) {
      expect((await rows<{ status: string; failure_code: string }>("select status, failure_code from social_posts where id = $1", [p.id]))[0], p.id).toEqual({ status: "failed", failure_code: "account_unavailable" });
      expect((await rows<{ status: string }>("select status from social_publish_jobs where post_id = $1", [p.id]))[0].status).toBe("cancelled");
      expect((await rows("select id from social_post_events where post_id = $1 and kind = 'publishing_stopped'", [p.id])).length).toBe(1);
    }
    expect((await rows<{ status: string }>("select status from social_posts where id = $1", [approved.id]))[0].status).toBe("approved"); // drafts and approvals stay, as history
    const audit = await rows<{ metadata: { why: string; stopped: number } }>("select metadata from audit_logs where org_id = $1 and action = 'social.account_disconnected' order by created_at", [s.m.org.id]);
    expect(audit).toHaveLength(2);
    expect(audit.every((a) => a.metadata.why === "workspace_closed")).toBe(true);

    // Nothing leaves for the closed workspace, even at the time it was scheduled for.
    expect((await tick(s, LATER, { mediaUrl: async () => "https://files.example.test/x" })).claimed).toBe(0);
    expect(simulated.published(fb.externalId)).toHaveLength(0);
    expect(simulated.published(ig.externalId)).toHaveLength(0);
  });

  it("says plainly when there was nothing to disconnect", async () => {
    const s = await socialOrg({ name: "No Social Co" });
    const view = await close(s);
    expect(view.steps.find((x) => x.key === "social")).toMatchObject({ ok: true, text: "No social media accounts were connected." });
  });

  it("reports an account it could not disconnect by name, carries on with the rest and still closes the workspace", async () => {
    const s = await socialOrg({ name: "Partly Stuck Co" });
    const good = await connect(s, "facebook", "Good Page");
    const stuck = await connect(s, "instagram", "Stuck Page");
    await withSystem(async (db) => {
      await db.query("create or replace function zz_block_social_disconnect() returns trigger language plpgsql as $$ begin raise exception 'blocked for the test'; end $$");
      await db.query("create trigger zz_block_social_disconnect before update on social_accounts for each row when (new.name = 'Stuck Page' and new.status = 'disconnected') execute function zz_block_social_disconnect()");
    });
    try {
      const view = await close(s);
      expect(view.status).toBe("retention");
      const step = view.steps.find((x) => x.key === "social")!;
      expect(step.ok).toBe(false);
      expect(step.text).toMatch(/^Could not disconnect social media accounts: Stuck Page\. Disconnect them by hand/);
    } finally {
      await withSystem(async (db) => {
        await db.query("drop trigger zz_block_social_disconnect on social_accounts");
        await db.query("drop function zz_block_social_disconnect()");
      });
    }
    expect((await accountState(good.id)).status).toBe("disconnected");
    expect(await accountState(stuck.id)).toMatchObject({ status: "connected" }); // untouched, and reported
    const [audit] = await rows<{ result: string; metadata: { failedSocialDisconnects: string[] } }>("select result, metadata from audit_logs where org_id = $1 and action = 'offboarding.shutdown'", [s.m.org.id]);
    expect(audit).toMatchObject({ result: "failure", metadata: { failedSocialDisconnects: ["Stuck Page"] } });
  });
});

describe("taking social media data with you", () => {
  const jpeg = () => {
    const b = Buffer.concat([Buffer.alloc(40), crypto.randomBytes(300)]);
    b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xc0;
    b.writeUInt16BE(17, 4);
    b[6] = 8;
    b.writeUInt16BE(1080, 7);
    b.writeUInt16BE(1080, 9);
    return b;
  };

  async function seeded(name: string, marker: string) {
    const s = await socialOrg({ name });
    await withSystem((db) => db.query(
      "insert into maintenance_subscriptions (org_id, status, monthly_price_cents, monthly_request_allowance, terms_version, accepted_by, activated_at, billing_start_on) values ($1, 'active', 29900, 4, 'test', $2, now() - interval '30 days', current_date - 30)",
      [s.m.org.id, s.m.people.owner.id],
    ));
    const acc = await connect(s, "facebook", `${marker}-PAGE`);
    await withSystem((db) => db.query("update social_accounts set provider_user_id = $2, scopes = array['pages_manage_posts'], token_expires_at = now() + interval '40 days', rate_state = '{\"quotaUsage\":2}'::jsonb where id = $1", [acc.id, `${marker}-PLATFORM-USER-ID`]));
    const bytes = jpeg();
    const file = await uploadMedia(s.sales, { filename: `${marker}.jpg`, contentType: "image/jpeg", bytes });
    const post = await createPost(s.sales, { accountId: acc.id, kind: "image", caption: `${marker}-CAPTION`, mediaAssetIds: [file.id] });
    await withSystem(async (db) => {
      await db.query("update social_posts set status = 'published', provider_post_id = $2, published_at = now() where id = $1", [post.id, `${marker}-provider-post`]);
      await db.query("insert into social_post_metrics (org_id, post_id, metrics, source) values ($1, $2, '{\"likes\":4}'::jsonb, 'simulated')", [s.m.org.id, post.id]);
      await db.query("insert into social_campaigns (org_id, name, utm_campaign) values ($1, $2, 'spring')", [s.m.org.id, `${marker}-CAMPAIGN`]);
      await db.query("insert into social_settings (org_id, brand_voice_note) values ($1, $2)", [s.m.org.id, `${marker}-VOICE`]);
      await db.query("insert into social_ai_runs (org_id, kind, status, output) values ($1, 'ideas', 'succeeded', $2::jsonb)", [s.m.org.id, JSON.stringify({ ideas: [`${marker}-IDEA`] })]);
      await db.query("insert into social_oauth_states (org_id, user_id, platform, state_hash, expires_at, pending) values ($1, $2, 'facebook', $3, now() + interval '10 minutes', $4)", [s.m.org.id, s.m.people.owner.id, crypto.randomBytes(32).toString("hex"), `${marker}-SEALED-PENDING`]);
    });
    await scheduledPost(s, acc.id, { caption: `${marker}-QUEUED` });
    const sealed = (await rows<{ credentials: string }>("select credentials from social_accounts where id = $1", [acc.id]))[0].credentials;
    return { s, acc, bytes, file, sealed };
  }

  it("carries the accounts (without what signs in as them), posts, history, numbers, campaigns, library, suggestions, settings and the stored files", async () => {
    const mine = await seeded("Exporting Social Co", "MINE");
    await seeded("Other Social Co", "OTHER");
    const out = await buildExport(mine.s.m.org.id);
    const files = readZip(out.bytes);
    const names = files.map((f) => f.name);
    for (const must of ["social/accounts.json", "social/posts.json", "social/post-history.json", "social/post-metrics.json", "social/campaigns.json", "social/media-library.json", "social/ai-suggestions.json", "social/settings.json"]) expect(names, must).toContain(must);
    const text = (n: string) => files.find((f) => f.name === n)!.data.toString("utf8");

    const accounts = JSON.parse(text("social/accounts.json")) as Array<Record<string, unknown>>;
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ name: "MINE-PAGE", platform: "facebook", status: "connected" });
    // Only the named columns leave: nothing that signs in as the account, identifies the person who connected it, or describes the platform's limits.
    for (const forbidden of ["credentials", "provider_user_id", "scopes", "rate_state", "token_expires_at", "data_access_expires_at", "last_checked_at", "connected_by"]) expect(Object.keys(accounts[0]), forbidden).not.toContain(forbidden);
    const archive = files.filter((f) => /\.(json|md)$/.test(f.name)).map((f) => f.data.toString("utf8")).join("\n");
    expect(archive).not.toContain(mine.sealed);
    for (const secret of ["MINE-PLATFORM-USER-ID", "MINE-SEALED-PENDING", "pages_manage_posts"]) expect(archive, secret).not.toContain(secret);

    expect(text("social/posts.json")).toContain("MINE-CAPTION");
    expect(text("social/posts.json")).toContain("MINE-QUEUED");
    expect(JSON.parse(text("social/post-history.json")).length).toBeGreaterThan(0);
    expect(text("social/post-metrics.json")).toContain('"likes": 4');
    expect(text("social/campaigns.json")).toContain("MINE-CAMPAIGN");
    expect(text("social/media-library.json")).toContain("MINE.jpg");
    expect(text("social/ai-suggestions.json")).toContain("MINE-IDEA");
    expect(text("social/settings.json")).toContain("MINE-VOICE");
    // Working state is not the client's data: publishing jobs and sign-in states are not in the archive.
    expect(names.some((n) => /publish-jobs|oauth|sign-in-states/.test(n))).toBe(false);

    // The pictures and videos come as files, byte for byte, and nothing of another workspace is read.
    const stored = files.filter((f) => f.name.startsWith("files/social-media/"));
    expect(stored).toHaveLength(1);
    expect(stored[0].data.equals(mine.bytes)).toBe(true);
    expect(out.filesIncluded).toBe(1);
    expect(archive).not.toMatch(/OTHER-/);
    expect(files.find((f) => f.name === "README.md")!.data.toString("utf8")).toMatch(/\*\*social\/\*\*: your Facebook and Instagram accounts \(never their sign-in tokens\)/);
    const manifest = JSON.parse(text("manifest.json")) as { tables: Record<string, number> };
    expect(manifest.tables).toMatchObject({ social_accounts: 1, social_posts: 2, social_post_metrics: 1, social_campaigns: 1, social_media_assets: 1, social_ai_runs: 1, social_settings: 1 });
  });

  it("leaves nothing behind: every social table is either in the export or listed here as working state", async () => {
    const mine = await seeded("Coverage Social Co", "COVER");
    const manifest = JSON.parse(readZip((await buildExport(mine.s.m.org.id)).bytes).find((f) => f.name === "manifest.json")!.data.toString("utf8")) as { tables: Record<string, number> };
    const tables = (await rows<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped
       where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'social\\_%' order by c.relname`,
    )).map((r) => r.relname);
    expect(tables.length).toBeGreaterThanOrEqual(10);
    const workingState = new Set(["social_oauth_states", "social_publish_jobs"]); // sign-in state and durable publishing jobs: internal, never exported
    for (const t of tables) expect(t in manifest.tables || workingState.has(t), `${t} is neither exported nor listed as working state`).toBe(true);
  });

  describe("and the final deletion", () => {
    afterAll(() => {
      delete process.env.OFFBOARDING_PURGE_ENABLED;
      resetEnvCache();
    });

    it("removes it all, rows and stored files, and nothing of another workspace", async () => {
      const gone = await seeded("Deleted Social Co", "GONE");
      const stays = await seeded("Staying Social Co", "STAYS");
      const target = (storageKey: string) => `${process.env.UPLOAD_DIR ?? ".data/test-uploads"}/social-media/${storageKey}`;
      const key = (await rows<{ storage_key: string }>("select storage_key from private_files where org_id = $1 and bucket = 'social-media'", [gone.s.m.org.id]))[0].storage_key;
      const keptKey = (await rows<{ storage_key: string }>("select storage_key from private_files where org_id = $1 and bucket = 'social-media'", [stays.s.m.org.id]))[0].storage_key;
      expect(fs.existsSync(target(key))).toBe(true);

      await close(gone.s);
      const req = (await getOffboarding(gone.s.m.org.id))!;
      process.env.OFFBOARDING_PURGE_ENABLED = "true";
      resetEnvCache();
      await withSystem((db) => db.query("update offboarding_requests set delete_after = now() - interval '1 day' where id = $1", [req.id]));
      await closeBilling(gone.s.m.superAdmin, req.id, "Settled in full for this test.");
      await executeDeletion(gone.s.m.superAdmin, req.id, { confirmName: gone.s.m.org.name, waiveExportReason: "Test run without a download." });

      const count = async (table: string, orgId: string) => Number((await rows<{ n: string }>(`select count(*)::text as n from ${table} where org_id = $1`, [orgId]))[0].n);
      for (const t of ["social_accounts", "social_posts", "social_post_events", "social_post_metrics", "social_publish_jobs", "social_campaigns", "social_media_assets", "social_ai_runs", "social_settings", "social_oauth_states"]) {
        expect(await count(t, gone.s.m.org.id), t).toBe(0);
        expect(await count(t, stays.s.m.org.id), `${t} (the other workspace)`).toBeGreaterThan(0);
      }
      expect(fs.existsSync(target(key))).toBe(false);
      expect(fs.existsSync(target(keptKey))).toBe(true);
    });
  });
});
