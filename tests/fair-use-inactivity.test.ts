import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { assertStorageAllowed, clearPolicy, fleetFairUse, getClientFairUse, listPolicies, measureOrg, runFairUseChecks, savePolicy } from "@/server/fairuse/service";
import { dismissReview, INACTIVITY_DAYS, latestActivity, listReviews, MAX_NOTICES, NOTICE_GAP_DAYS, runInactivityReview } from "@/server/inactivity/service";
import { JOBS } from "@/server/ops/tick";
import { evaluateFairUse, formatMetricValue, METRIC_INFO } from "@/lib/fair-use";
import { addMember, agencyUser, createOrg, createUser, ctxFor } from "./support/fixtures";
import { inbound, messagingOrg, type MessagingOrg } from "./support/messaging";

const days = (n: number, from = new Date()) => new Date(from.getTime() + n * 86_400_000);

let m: MessagingOrg;
let other: Awaited<ReturnType<typeof createOrg>>;
let superAdmin: ReturnType<typeof agencyUser>;
let staff: ReturnType<typeof agencyUser>;
let unassigned: ReturnType<typeof agencyUser>;

const notes = async (userId: string, kind: string) => (await withSystem((db) => db.query<{ title: string; body: string | null; severity: string }>("select title, body, severity from notifications where user_id = $1 and kind = $2 order by created_at", [userId, kind]))).rows;
const addFile = (orgId: string, bytes: number, status = "ready") =>
  withSystem((db) => db.query("insert into private_files (org_id, bucket, storage_key, filename, mime_type, size_bytes, status) values ($1, 'company-documents', $2, 'doc.pdf', 'application/pdf', $3, $4)", [orgId, `${orgId}/${crypto.randomUUID()}.pdf`, bytes, status]));

beforeAll(async () => {
  resetEnvCache();
  m = await messagingOrg({ name: "Fair Use Co" });
  other = await createOrg({ name: "Other Fair Use Co" });
  superAdmin = m.superAdmin;
  const s = await createUser({ platformRole: "agency_staff" });
  staff = agencyUser(s, "agency_staff");
  unassigned = agencyUser(await createUser({ platformRole: "agency_staff" }), "agency_staff");
  await withSystem((db) => db.query("insert into staff_assignments (org_id, user_id) values ($1, $2)", [m.org.id, s.id]));
});

describe("judging a measurement", () => {
  it("is honest when nothing is limited, and warns before the limit", () => {
    expect(evaluateFairUse(5_000, null, null)).toBe("unset");
    expect(evaluateFairUse(5_000, 8_000, 10_000)).toBe("ok");
    expect(evaluateFairUse(8_000, 8_000, 10_000)).toBe("warning");
    expect(evaluateFairUse(10_000, 8_000, 10_000)).toBe("over");
    expect(evaluateFairUse(7_999, null, 10_000)).toBe("ok"); // without a separate warning level, 80% of the limit
    expect(evaluateFairUse(8_000, null, 10_000)).toBe("warning");
    expect(evaluateFairUse(50, 40, null)).toBe("warning"); // a warning level with no hard limit
  });

  it("describes sizes and counts the way people read them", () => {
    expect(formatMetricValue("storage_bytes", 0)).toBe("0 B");
    expect(formatMetricValue("storage_bytes", 1536)).toBe("1.5 KB");
    expect(formatMetricValue("storage_bytes", 250 * 1024 * 1024)).toBe("250 MB");
    expect(formatMetricValue("stored_messages", 12345)).toBe("12,345");
    expect(METRIC_INFO.storage_bytes.canBlock).toBe(true);
    expect(Object.entries(METRIC_INFO).filter(([, i]) => i.canBlock).map(([k]) => k)).toEqual(["storage_bytes"]); // only new storage can ever be refused
  });
});

describe("measuring and reporting usage", () => {
  it("measures what is actually stored, for one workspace only", async () => {
    await addFile(m.org.id, 4096);
    await addFile(m.org.id, 1000, "deleted"); // removed files don't count
    await addFile(other.id, 999_999);
    await inbound(m.org.id, { body: "Hello there" });
    const measured = await withSystem((db) => measureOrg(db, m.org.id));
    expect(measured.storage_bytes).toBe(4096);
    expect(measured.stored_messages).toBeGreaterThanOrEqual(1);
    expect((await withSystem((db) => measureOrg(db, other.id))).storage_bytes).toBe(999_999);
  });

  it("tells a client plainly that no limit is set, rather than inventing one", async () => {
    const rows = await getClientFairUse(m.ctx("owner"));
    expect(rows.map((r) => r.metric).sort()).toEqual(["ai_runs_30d", "research_calls_30d", "site_bandwidth_bytes_30d", "site_requests_30d", "storage_bytes", "stored_messages"]);
    expect(rows.every((r) => r.state === "unset" && r.limit === null && r.limitText === null)).toBe(true);
    expect(rows.find((r) => r.metric === "storage_bytes")).toMatchObject({ valueText: "4.0 KB", label: "File storage" });
    expect(await getClientFairUse(m.ctx("viewer"))).toEqual([]); // usage is for owners and managers
  });

  it("ships no limits at all, and nothing is blocked until the agency chooses a number", async () => {
    expect(await listPolicies(superAdmin)).toEqual([]);
    await expect(assertStorageAllowed(m.org.id, 50 * 1024 * 1024)).resolves.toBeUndefined();
  });
});

describe("thresholds", () => {
  it("are set by super admins only, with sensible values, and only storage can refuse new uploads", async () => {
    await expect(savePolicy(staff, { orgId: null, metric: "storage_bytes", warn: 1, limit: 2, enforcement: "report_only" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(savePolicy(superAdmin, { orgId: null, metric: "storage_bytes", warn: 20, limit: 10, enforcement: "report_only" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(savePolicy(superAdmin, { orgId: null, metric: "site_requests_30d", warn: 1, limit: 2, enforcement: "block_new" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(savePolicy(superAdmin, { orgId: null, metric: "storage_bytes", warn: null, limit: null, enforcement: "block_new" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(savePolicy(superAdmin, { orgId: crypto.randomUUID(), metric: "storage_bytes", warn: 1, limit: 2, enforcement: "report_only" })).rejects.toMatchObject({ code: "not_found" });
    await savePolicy(superAdmin, { orgId: null, metric: "storage_bytes", warn: 3000, limit: 6000, enforcement: "report_only", note: "Starting point from measured costs" });
    expect(await listPolicies(superAdmin)).toMatchObject([{ orgId: null, metric: "storage_bytes", warn: 3000, limit: 6000, enforcement: "report_only" }]);
  });

  it("show a client where it stands, and a workspace's own setting overrides the default", async () => {
    let row = (await getClientFairUse(m.ctx("owner"))).find((r) => r.metric === "storage_bytes")!;
    expect(row).toMatchObject({ state: "warning", limitText: "5.9 KB" }); // 4096 bytes is past the 3000 warning
    await savePolicy(superAdmin, { orgId: m.org.id, metric: "storage_bytes", warn: 100_000, limit: 200_000, enforcement: "report_only" });
    row = (await getClientFairUse(m.ctx("owner"))).find((r) => r.metric === "storage_bytes")!;
    expect(row.state).toBe("ok");
    const policies = await listPolicies(superAdmin);
    await clearPolicy(superAdmin, policies.find((p) => p.orgId === m.org.id)!.id);
    expect((await getClientFairUse(m.ctx("owner"))).find((r) => r.metric === "storage_bytes")!.state).toBe("warning"); // back to the default
    await expect(clearPolicy(staff, policies[0].id)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("refuse only NEW storage when the agency chose to, and never touch what exists", async () => {
    await savePolicy(superAdmin, { orgId: m.org.id, metric: "storage_bytes", warn: null, limit: 6000, enforcement: "block_new" });
    await expect(assertStorageAllowed(m.org.id, 1000)).resolves.toBeUndefined(); // 4096 + 1000 fits
    await expect(assertStorageAllowed(m.org.id, 3000)).rejects.toMatchObject({ code: "usage_limit", message: expect.stringMatching(/storage is full.*Nothing you already have is affected/) });
    await expect(assertStorageAllowed(other.id, 3000)).resolves.toBeUndefined(); // another workspace is unaffected
    await savePolicy(superAdmin, { orgId: m.org.id, metric: "storage_bytes", warn: null, limit: 6000, enforcement: "report_only" });
    await expect(assertStorageAllowed(m.org.id, 3000)).resolves.toBeUndefined(); // report-only never blocks
    await clearPolicy(superAdmin, (await listPolicies(superAdmin)).find((p) => p.orgId === m.org.id)!.id);
  });
});

describe("the scheduled check", () => {
  it("announces a change once, in plain words, to the owner and the agency, and records where each workspace stands", async () => {
    const r = await runFairUseChecks();
    expect(r.checked).toBeGreaterThan(0);
    const owner = await notes(m.people.owner.id, "fair_use_notice");
    expect(owner.map((n) => n.title)).toEqual([expect.stringMatching(/close to your file storage allowance/)]);
    expect(owner[0]).toMatchObject({ severity: "info", title: "You are close to your file storage allowance" === owner[0].title ? owner[0].title : expect.stringMatching(/close to your file storage allowance/) });
    expect(owner[0].body).toMatch(/Nothing has been switched off/);
    expect((await notes(m.superAdmin.id, "fair_use_notice")).filter((n) => n.title.startsWith("Fair Use Co:"))).toHaveLength(1); // the agency hears once per client (the other workspace also crossed its threshold)
    expect((await notes(m.people.viewer.id, "fair_use_notice")).length).toBe(0);
    await runFairUseChecks();
    expect(await notes(m.people.owner.id, "fair_use_notice")).toHaveLength(1); // not repeated
    expect((await withSystem((db) => db.query("select state, value::int as value from fair_use_status where org_id = $1 and metric = 'storage_bytes'", [m.org.id]))).rows[0]).toMatchObject({ state: "warning", value: 4096 });
  });

  it("announces a worsening again, and a return to normal resets it", async () => {
    await addFile(m.org.id, 3000); // 7096 bytes: past the 6000 limit
    await runFairUseChecks();
    const after = await notes(m.people.owner.id, "fair_use_notice");
    expect(after.at(-1)).toMatchObject({ severity: "warning", title: expect.stringMatching(/gone past your file storage allowance/) });
    expect(after).toHaveLength(2);
    await withSystem((db) => db.query("update private_files set status = 'deleted' where org_id = $1 and size_bytes = 3000", [m.org.id]));
    await runFairUseChecks();
    expect((await withSystem((db) => db.query("select state from fair_use_status where org_id = $1 and metric = 'storage_bytes'", [m.org.id]))).rows[0].state).toBe("warning");
    expect(await notes(m.people.owner.id, "fair_use_notice")).toHaveLength(2); // coming back down says nothing new
  });

  it("is visible to the agency per client, scoped to who they look after, and to no other workspace", async () => {
    const mine = await fleetFairUse(staff);
    expect(mine.map((f) => f.orgId)).toEqual([m.org.id]);
    expect(mine[0].metrics.find((x) => x.metric === "storage_bytes")).toMatchObject({ valueText: "4.0 KB", state: "warning" });
    expect(await fleetFairUse(unassigned)).toEqual([]);
    const manager = agencyUser(await createUser({ platformRole: "agency_manager" }), "agency_manager");
    expect((await fleetFairUse(manager)).map((row) => row.orgId)).toContain(m.org.id);
    expect((await fleetFairUse(superAdmin)).length).toBeGreaterThanOrEqual(1);
    const seen = await withUser(m.people.owner.id, (db) => db.query<{ org_id: string }>("select distinct org_id from fair_use_status"));
    expect(seen.rows.map((r) => r.org_id)).toEqual([m.org.id]);
    expect((await withUser(m.people.viewer.id, (db) => db.query("select 1 from fair_use_status"))).rows).toHaveLength(0);
    await expect(withUser(m.people.owner.id, (db) => db.query("update fair_use_status set state = 'ok'"))).rejects.toBeTruthy();
    await expect(withUser(m.people.owner.id, (db) => db.query("delete from fair_use_policies"))).rejects.toBeTruthy();
  });
});

// ---------------------------------------------------------------------------

describe("noticing an account that has gone quiet", () => {
  const quietOrg = async (name: string, ageDays = 400) => {
    const o = await createOrg({ name });
    const owner = await createUser();
    await addMember(o.id, owner.id, "owner");
    await withSystem((db) => db.query("update organizations set created_at = $2 where id = $1", [o.id, days(-ageDays).toISOString()]));
    return { org: o, owner };
  };
  const reviews = async (orgId: string) => (await withSystem((db) => db.query<{ status: string; notices_sent: number; inactive_days: number }>("select status, notices_sent, inactive_days from account_activity_reviews where org_id = $1 order by opened_at", [orgId]))).rows;
  const liveSite = async (orgId: string, health = "healthy") =>
    withSystem(async (db) => {
      const w = await db.query<{ id: string }>("insert into websites (org_id, name, template_key, subdomain, draft_content) values ($1, 'Site', 'summit.peak', $2, '{}'::jsonb) returning id", [orgId, `quiet-${crypto.randomBytes(3).toString("hex")}`]);
      const hash = crypto.randomBytes(32).toString("hex");
      const v = await db.query<{ id: string }>("insert into website_versions (org_id, website_id, version, template_key, content, content_hash, source) values ($1, $2, 1, 'summit.peak', '{}'::jsonb, $3, 'publish') returning id", [orgId, w.rows[0].id, hash]);
      const p = await db.query<{ id: string }>("insert into website_publications (org_id, website_id, number, version_id, template_key, content, content_hash, status, health) values ($1, $2, 1, $3, 'summit.peak', '{}'::jsonb, $4, 'live', $5) returning id", [orgId, w.rows[0].id, v.rows[0].id, hash, health]);
      await db.query("update websites set published_publication_id = $2 where id = $1", [w.rows[0].id, p.rows[0].id]);
    });

  it("leaves a younger workspace, and one with recent activity, alone", async () => {
    const young = await quietOrg("Young Quiet Co", 60);
    const busy = await quietOrg("Busy Co");
    await withSystem((db) => db.query("update users set last_login_at = now() - interval '5 days' where id = $1", [busy.owner.id]));
    const before = await withSystem((db) => db.query<{ n: string }>("select count(*)::text as n from account_activity_reviews"));
    await runInactivityReview();
    expect(await reviews(young.org.id)).toEqual([]);
    expect(await reviews(busy.org.id)).toEqual([]);
    expect(Number(before.rows[0].n)).toBeGreaterThanOrEqual(0);
    expect((await withSystem((db) => latestActivity(db, busy.org.id)))).toMatchObject({ source: "sign_in" });
  });

  it("opens a review after 180 days of nothing, tells the owner in plain words, and deletes nothing", async () => {
    const { org, owner } = await quietOrg("Quiet Co");
    const r = await runInactivityReview();
    expect(r.opened).toBeGreaterThanOrEqual(1);
    expect(await reviews(org.id)).toMatchObject([{ status: "open", notices_sent: 1 }]);
    const note = (await notes(owner.id, "account_inactivity_notice"))[0];
    expect(note.title).toBe("Your workspace has been quiet for a while");
    expect(note.body).toMatch(/Nothing has been deleted, and nothing will be deleted without your say-so/);
    expect(note.body).toMatch(/live website, if you have one, counts as activity/);
    expect((await withSystem((db) => db.query("select 1 from notifications where org_id = $1 and audience = 'agency' and kind = 'account_inactivity_notice' and title like $2", [org.id, "Quiet Co%"]))).rows.length).toBeGreaterThanOrEqual(1);
    // Nothing was touched.
    expect((await withSystem((db) => db.query("select status from organizations where id = $1", [org.id]))).rows[0]).toMatchObject({ status: "active" });
    expect((await withSystem((db) => db.query("select status from organization_memberships where org_id = $1", [org.id]))).rows[0]).toMatchObject({ status: "active" });
    expect(INACTIVITY_DAYS).toBe(180);
  });

  it("does not repeat itself on the same day, and sends at most three notices a month apart", async () => {
    const { org, owner } = await quietOrg("Reminded Co");
    const t0 = new Date();
    await runInactivityReview(t0);
    await runInactivityReview(t0);
    await runInactivityReview(days(NOTICE_GAP_DAYS - 1, t0));
    expect((await reviews(org.id))[0].notices_sent).toBe(1);
    await runInactivityReview(days(NOTICE_GAP_DAYS + 1, t0));
    expect((await reviews(org.id))[0].notices_sent).toBe(2);
    await runInactivityReview(days(NOTICE_GAP_DAYS * 2 + 2, t0));
    expect((await reviews(org.id))[0].notices_sent).toBe(3);
    await runInactivityReview(days(NOTICE_GAP_DAYS * 6, t0));
    expect((await reviews(org.id))[0].notices_sent).toBe(MAX_NOTICES);
    const sent = await notes(owner.id, "account_inactivity_notice");
    expect(sent).toHaveLength(3);
    expect(sent[2].severity).toBe("warning");
    expect(sent[1].body).toMatch(/This is a reminder/);
  });

  it("counts a working website, a customer writing in, a sign-in or a payment as activity", async () => {
    const site = await quietOrg("Site Co");
    await liveSite(site.org.id);
    const broken = await quietOrg("Broken Site Co");
    await liveSite(broken.org.id, "unhealthy");
    const customers = await quietOrg("Customers Co");
    await withSystem(async (db) => {
      const c = await db.query<{ id: string }>("insert into contacts (org_id, display_name) values ($1, 'Customer') returning id", [customers.org.id]);
      await db.query("insert into conversations (org_id, contact_id, channel, last_inbound_at) values ($1, $2, 'sms', now() - interval '10 days')", [customers.org.id, c.rows[0].id]);
    });
    await runInactivityReview();
    expect(await reviews(site.org.id)).toEqual([]);
    expect(await reviews(customers.org.id)).toEqual([]);
    expect(await reviews(broken.org.id)).toMatchObject([{ status: "open" }]); // a site that isn't being served isn't activity
    expect((await withSystem((db) => latestActivity(db, site.org.id)))).toMatchObject({ source: "live_website" });
  });

  it("closes a review as reactivated when activity resumes", async () => {
    const { org, owner } = await quietOrg("Returning Co");
    await runInactivityReview();
    expect(await reviews(org.id)).toMatchObject([{ status: "open" }]);
    await withSystem((db) => db.query("update users set last_login_at = now() where id = $1", [owner.id]));
    const r = await runInactivityReview();
    expect(r.reactivated).toBeGreaterThanOrEqual(1);
    expect(await reviews(org.id)).toMatchObject([{ status: "reactivated" }]);
  });

  it("lets a super admin keep the account, which restarts the clock, and scopes the list to the people who look after it", async () => {
    const { org } = await quietOrg("Kept Co");
    await withSystem((db) => db.query("insert into staff_assignments (org_id, user_id) values ($1, $2)", [org.id, staff.id]));
    await runInactivityReview();
    const open = (await listReviews(staff)).find((r) => r.orgId === org.id)!;
    expect(open).toMatchObject({ status: "open", noticesSent: 1 });
    expect((await listReviews(unassigned)).some((r) => r.orgId === org.id)).toBe(false);
    await expect(dismissReview(staff, open.id, "Keeping them")).rejects.toMatchObject({ code: "forbidden" });
    await expect(dismissReview(superAdmin, open.id, "x")).rejects.toMatchObject({ code: "invalid_input" });
    await dismissReview(superAdmin, open.id, "Spoke to the owner; they're busy but staying.");
    await expect(dismissReview(superAdmin, open.id, "again please")).rejects.toMatchObject({ code: "not_found" });
    await runInactivityReview();
    expect((await reviews(org.id)).map((r) => r.status)).toEqual(["dismissed"]); // the decision restarted the clock: no new review
    expect((await withSystem((db) => latestActivity(db, org.id)))).toMatchObject({ source: "review_decision" });
  });

  it("skips workspaces that are already leaving", async () => {
    const { org } = await quietOrg("Leaving Co");
    await withSystem((db) => db.query("insert into offboarding_requests (org_id, requested_by_kind) values ($1, 'client')", [org.id]));
    await runInactivityReview();
    expect(await reviews(org.id)).toEqual([]);
  });

  it("runs from the scheduler, at slower rhythms", () => {
    const names = JOBS.map((j) => j.name);
    for (const job of ["fairUseChecks", "inactivityReview", "offboardingReminders"]) expect(names).toContain(job);
  });
});

void ctxFor;
