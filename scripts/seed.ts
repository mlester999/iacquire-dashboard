/**
 * Seeds the agency organization. With --demo it also creates a clearly-labelled demo workspace
 * (is_demo = true, banner shown in the UI) with fictional sample records for visual QA, plus a
 * second empty tenant for isolation checks. Demo passwords are random and written to
 * .data/dev-credentials.local.json (gitignored). Never run --demo against production.
 *
 *   npm run db:seed                      agency org only
 *   npm run db:seed -- --demo            + demo tenants and users
 *   npm run db:seed -- --demo --mock-hermes http://127.0.0.1:8787
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { closeDb, withSystem, type Queryable } from "../src/server/db/index";
import { hashPassword, encryptSecret, secretFingerprint } from "../src/server/security/crypto";
import { ensureAgentInstances, createConfigVersion } from "../src/server/workforce/service";
import { defaultSettings } from "../src/server/workforce/compiler";
import { AGENT_ROLE_KEYS } from "../src/lib/agents";
import { env } from "../src/server/env";

const args = process.argv.slice(2);
const DEMO = args.includes("--demo");
// Fictional Native CRM records in the demo workspace (contacts, companies, deals, tasks), for visual QA of the CRM screens.
const CRM_DEMO = DEMO && args.includes("--crm");
const mockIdx = args.indexOf("--mock-hermes");
const MOCK_URL = mockIdx >= 0 ? args[mockIdx + 1] : null;
const CRED_FILE = path.resolve(".data/dev-credentials.local.json");

async function upsertOrg(db: Queryable, o: { name: string; slug: string; kind: "agency" | "client"; isDemo?: boolean; industry?: string; website?: string; timezone?: string }) {
  const existing = await db.query<{ id: string }>("select id from organizations where slug = $1", [o.slug]);
  if (existing.rows[0]) return existing.rows[0].id;
  const { rows } = await db.query<{ id: string }>(
    `insert into organizations (name, slug, kind, status, is_demo, industry, website, timezone, onboarding_completed_at)
     values ($1, $2, $3, 'active', $4, $5, $6, $7, case when $3 = 'agency' then now() end) returning id`,
    [o.name, o.slug, o.kind, o.isDemo ?? false, o.industry ?? null, o.website ?? null, o.timezone ?? "America/New_York"],
  );
  const id = rows[0].id;
  await db.query("insert into company_profiles (org_id) values ($1) on conflict do nothing", [id]);
  await db.query("insert into usage_limits (org_id) values ($1) on conflict do nothing", [id]);
  await db.query("insert into billing_accounts (org_id) values ($1) on conflict do nothing", [id]);
  await db.query("insert into onboarding_responses (org_id) values ($1) on conflict do nothing", [id]);
  await ensureAgentInstances(id, db);
  for (const provider of ["hermes", "ghl", "ghl_calendar"]) {
    await db.query(
      `insert into integration_status (org_id, provider, status) values ($1, $2, 'not_configured')
       on conflict (coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid), provider) do nothing`,
      [id, provider],
    );
  }
  return id;
}

async function upsertUser(db: Queryable, email: string, name: string, platformRole: string, creds: Record<string, string>) {
  const existing = await db.query<{ id: string }>("select id from users where email = $1", [email]);
  if (existing.rows[0]) return existing.rows[0].id;
  const password = `${crypto.randomBytes(9).toString("base64url")}-Aa1`;
  const { rows } = await db.query<{ id: string }>(
    "insert into users (email, full_name, email_verified_at, platform_role) values ($1, $2, now(), $3) returning id",
    [email, name, platformRole],
  );
  await db.query("insert into auth_credentials (user_id, password_hash) values ($1, $2)", [rows[0].id, await hashPassword(password)]);
  creds[email] = password;
  return rows[0].id;
}

async function member(db: Queryable, orgId: string, userId: string, role: string) {
  await db.query(
    "insert into organization_memberships (org_id, user_id, role) values ($1, $2, $3) on conflict (org_id, user_id) do nothing",
    [orgId, userId, role],
  );
}

async function seedDemoContent(db: Queryable, orgId: string, ownerId: string) {
  const { rows: already } = await db.query("select 1 from leads where org_id = $1 limit 1", [orgId]);
  if (already.length) return;
  await db.query(
    `update company_profiles set description = $2, services = $3, ideal_customers = $4, operating_area = $5,
       goals = $6, ai_preferences = $7 where org_id = $1`,
    [
      orgId,
      "Sample business for the demo workspace: a family-owned home services company offering roof repairs and inspections.",
      "Roof inspections, storm damage repair, gutter replacement",
      "Homeowners in the greater Austin area with homes older than 10 years",
      "Austin, Texas and surrounding counties",
      ["Find more leads", "Book more appointments", "Automate sales follow-ups"],
      JSON.stringify({ tone: "friendly", replyLength: "concise", language: "English", companyRules: "", neverPromise: "Exact repair prices before an inspection", escalateWhen: "a customer reports active leaks or safety issues" }),
    ],
  );
  await db.query("update onboarding_responses set completed_at = now(), current_step = 5 where org_id = $1", [orgId]);
  for (const [section, content] of [
    ["business_description", "Sample Roofing Co. (demo data) is a family-owned roofing company serving Austin homeowners since 2009."],
    ["business_hours", "Monday–Friday 8am–6pm, Saturday 9am–1pm Central."],
    ["faq", "Q: Do you offer free inspections?\nA: Yes, inspections are free within our service area."],
  ]) {
    await db.query(
      "insert into company_knowledge (org_id, section, content, updated_by, applied_at) values ($1, $2, $3, $4, now()) on conflict do nothing",
      [orgId, section, content, ownerId],
    );
  }
  const agents = (await db.query<{ id: string; role_key: string }>("select id, role_key from agent_instances where org_id = $1", [orgId])).rows;
  for (const a of agents) {
    await createConfigVersion(db, { orgId, agentId: a.id, settings: defaultSettings(a.role_key as never), source: "onboarding", userId: ownerId, apply: true });
  }

  const req = await db.query<{ id: string }>(
    "insert into lead_research_requests (org_id, requested_by, prompt, status, result_count, completed_at, created_at) values ($1, $2, 'Sample: homeowners associations near Austin that may need inspection programs', 'completed', 5, now() - interval '2 days', now() - interval '2 days') returning id",
    [orgId, ownerId],
  );
  const sample = [
    ["Sample: Lakeview HOA", "lakeview-hoa.example", "Property management", "Austin, TX", 82, "pending"],
    ["Sample: Cedar Park Property Group", "cedarpark-pg.example", "Property management", "Cedar Park, TX", 74, "pending"],
    ["Sample: Hill Country Rentals", "hillcountry-rentals.example", "Real estate", "Round Rock, TX", 66, "approved"],
    ["Sample: Riverside Townhomes", "riverside-th.example", "Residential", "Austin, TX", 58, "pending"],
    ["Sample: Oak Hollow Realty", "oakhollow.example", "Real estate", "Georgetown, TX", 41, "rejected"],
  ] as const;
  for (const [name, domain, industry, location, score, status] of sample) {
    const breakdown = { service_fit: Math.min(30, Math.round(score * 0.3)), problem_evidence: Math.min(25, Math.round(score * 0.25)), buying_intent: Math.min(20, Math.round(score * 0.2)), market_fit: Math.min(15, Math.round(score * 0.15)), source_quality: Math.min(10, Math.round(score * 0.1)) };
    await db.query(
      `insert into leads (org_id, research_request_id, business_name, website, domain, industry, location, evidence, score, score_breakdown,
         qualification_summary, buying_signals, duplicate_status, review_status, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'no_match', $13, now() - interval '2 days')`,
      [
        orgId, req.rows[0].id, name, `https://${domain}`, domain, industry, location,
        JSON.stringify([{ url: `https://${domain}/about`, observed_at: new Date().toISOString(), summary: "Demo evidence entry (sample data)." }]),
        Object.values(breakdown).reduce((a, b) => a + b, 0), JSON.stringify(breakdown),
        "Demo record: illustrates how the Lead Hunter explains a qualification.", ["Sample signal"], status,
      ],
    );
  }
  await db.query(
    "insert into crm_pipelines (org_id, ghl_pipeline_id, name, stages) values ($1, 'demoPipeline0001', 'Sample sales pipeline', $2) on conflict do nothing",
    [orgId, JSON.stringify([
      { id: "demoStage00001", name: "New Inquiry", position: 0 },
      { id: "demoStage00002", name: "Qualified", position: 1 },
      { id: "demoStage00003", name: "Inspection Scheduled", position: 2 },
      { id: "demoStage00004", name: "Proposal Sent", position: 3 },
      { id: "demoStage00005", name: "Won", position: 4 },
    ])],
  );
  const opps = [
    ["Sample: Garcia roof inspection", "demoStage00001", "New Inquiry", "open", 0],
    ["Sample: Patel storm repair", "demoStage00002", "Qualified", "open", 4200],
    ["Sample: Nguyen gutter replacement", "demoStage00003", "Inspection Scheduled", "open", 1800],
    ["Sample: Brooks full re-roof", "demoStage00004", "Proposal Sent", "open", 14500],
    ["Sample: Lee repair", "demoStage00005", "Won", "won", 3200],
    ["Sample: Ortiz inspection", "demoStage00002", "Qualified", "lost", 0],
  ] as const;
  let i = 0;
  for (const [name, stage, stageName, status, value] of opps) {
    await db.query(
      `insert into crm_opportunities (org_id, ghl_opportunity_id, ghl_pipeline_id, stage_id, stage_name, name, status, monetary_value, contact_label, source, remote_updated_at)
       values ($1, $2, 'demoPipeline0001', $3, $4, $5, $6, $7, $8, 'Demo data', now() - make_interval(days => $9)) on conflict do nothing`,
      [orgId, `demoOpp${String(++i).padStart(9, "0")}`, stage, stageName, name, status, value || null, name.replace("Sample: ", "").split(" ")[0] + " household", i],
    );
  }
  for (let d = 0; d < 4; d++) {
    const start = new Date(Date.now() + (d + 1) * 86400000);
    start.setUTCHours(15 + d, 0, 0, 0);
    await db.query(
      `insert into appointment_refs (org_id, ghl_appointment_id, ghl_calendar_id, title, status, start_at, end_at, timezone, meeting_type)
       values ($1, $2, 'demoCalendar0001', $3, $4, $5, $6, 'America/Chicago', 'Roof inspection') on conflict do nothing`,
      [orgId, `demoAppt${String(d).padStart(8, "0")}`, `Sample: Inspection #${d + 1}`, d === 3 ? "new" : "confirmed", start.toISOString(), new Date(start.getTime() + 3600000).toISOString()],
    );
  }
  for (const [title, kind, risk] of [
    ["Import 1 researched lead into the CRM", "lead_import", "medium"],
    ["Send follow-up to Sample: Patel storm repair", "follow_up_message", "high"],
    ["Update FAQ with financing answer", "knowledge_change", "low"],
  ] as const) {
    const { rows } = await db.query<{ id: string }>(
      `insert into approval_requests (org_id, requested_by, kind, title, action, target_label, reason, expected_effect, risk, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + interval '5 days') returning id`,
      [
        orgId, ownerId, kind, title,
        JSON.stringify(kind === "knowledge_change" ? { section: "faq", content: "Q: Do you offer financing?\nA: Yes, through a partner lender (demo)." } : { demo: true }),
        "Demo record", "Sample approval to illustrate the Approval Center.", kind === "follow_up_message" ? "Would send one email to the contact. Messaging is not enabled, so it would stay blocked." : "Applies the change described.", risk,
      ],
    );
    await db.query("insert into approval_events (approval_id, org_id, actor_kind, event) values ($1, $2, 'system', 'created')", [rows[0].id, orgId]);
  }
  const acct = await db.query<{ id: string }>(
    "insert into retention_accounts (org_id, customer_name, status, health, onboarding_progress, renewal_date, last_contact_at, open_issues, repeat_opportunity, created_by) values ($1, 'Sample: Lee household', 'active', 'healthy', 100, (now() + interval '300 days')::date, now() - interval '12 days', 0, 'Gutter guards before winter', $2) returning id",
    [orgId, ownerId],
  );
  await db.query("insert into retention_accounts (org_id, customer_name, status, health, onboarding_progress, open_issues, created_by) values ($1, 'Sample: Rivera household', 'onboarding', 'watch', 40, 1, $2)", [orgId, ownerId]);
  await db.query("insert into customer_feedback (org_id, account_id, rating, comment, created_by) values ($1, $2, 5, 'Sample feedback: quick and tidy work.', $3)", [orgId, acct.rows[0].id, ownerId]);
  await db.query("insert into service_history (org_id, account_id, event, created_by) values ($1, $2, 'Sample: roof repair completed', $3)", [orgId, acct.rows[0].id, ownerId]);
  for (const [title, cat, days] of [["Call back Sample: Patel about the estimate", "follow_up", 0], ["Review new researched leads", "sales", 1], ["Confirm Thursday inspections", "follow_up", 2]] as const) {
    await db.query("insert into tasks (org_id, title, category, due_at, created_by) values ($1, $2, $3, now() + make_interval(days => $4), $5)", [orgId, title, cat, days, ownerId]);
  }
  for (let d = 0; d < 14; d++) {
    const n = Math.max(0, Math.round(6 + 5 * Math.sin(d / 2)));
    for (let k = 0; k < n; k++) {
      await db.query("insert into usage_events (org_id, user_id, kind, created_at) values ($1, $2, 'agent_message', now() - make_interval(days => $3))", [orgId, ownerId, d]);
    }
  }
  await db.query("insert into notifications (org_id, user_id, kind, severity, title, body, link) values ($1, $2, 'lead_awaiting_approval', 'info', '3 researched leads ready for review', 'Demo notification.', '/leads')", [orgId, ownerId]);
}

async function connectMockHermes(db: Queryable, orgId: string, slug: string, adminId: string, creds: Record<string, unknown>) {
  const keys: Record<string, string> = (creds.mockHermesKeys as Record<string, string>) ?? {};
  for (const role of AGENT_ROLE_KEYS) {
    const profile = `c-${slug}-${role.replace(/_/g, "-")}`;
    keys[profile] ??= crypto.randomBytes(24).toString("hex");
    const { rows } = await db.query<{ id: string }>(
      `insert into integration_credentials (org_id, provider, label, ciphertext, fingerprint, created_by)
       values ($1, 'hermes', $2, $3, $4, $5) returning id`,
      [orgId, `Local test double ${profile}`, encryptSecret(keys[profile]), secretFingerprint(keys[profile]), adminId],
    );
    await db.query(
      "update agent_instances set hermes_base_url = $3, hermes_profile = $4, credential_id = $5, status = 'provisioning' where org_id = $1 and role_key = $2",
      [orgId, role, MOCK_URL, profile, rows[0].id],
    );
  }
  creds.mockHermesKeys = keys;
}

async function main() {
  const configuration = env();
  if (configuration.NODE_ENV === "production" || configuration.AUTH_PROVIDER !== "local" || configuration.DATABASE_DRIVER === "postgres") {
    throw new Error("Synthetic seeding is allowed only with explicit local auth and an embedded disposable development database.");
  }
  if (process.env.NODE_ENV === "production" && DEMO) throw new Error("Refusing to seed demo data in production.");
  const creds: Record<string, unknown> = fs.existsSync(CRED_FILE) ? JSON.parse(fs.readFileSync(CRED_FILE, "utf8")) : {};
  const passwords = (creds.passwords as Record<string, string>) ?? {};
  await withSystem(async (db) => {
    const agencyId = await upsertOrg(db, { name: "iAcquire", slug: "iacquire", kind: "agency", timezone: "Asia/Manila" });
    console.log(`Agency organization ready (${agencyId}).`);
    if (!DEMO) return;
    const admin = await upsertUser(db, "admin@iacquire.test", "Avery Admin", "agency_super_admin", passwords);
    const staff = await upsertUser(db, "staff@iacquire.test", "Sam Staff", "agency_staff", passwords);
    await member(db, agencyId, admin, "owner");
    const demoId = await upsertOrg(db, { name: "Demo Workspace", slug: "demo-workspace", kind: "client", isDemo: true, industry: "Home services", website: "https://example.com", timezone: "America/Chicago" });
    await db.query("update organizations set onboarding_completed_at = coalesce(onboarding_completed_at, now()) where id = $1", [demoId]);
    const owner = await upsertUser(db, "owner@demo.test", "Jordan Owner", "none", passwords);
    const memberUser = await upsertUser(db, "member@demo.test", "Riley Member", "none", passwords);
    await member(db, demoId, owner, "owner");
    await member(db, demoId, memberUser, "member");
    await db.query("insert into staff_assignments (org_id, user_id, assigned_by) values ($1, $2, $3) on conflict do nothing", [demoId, staff, admin]);
    await seedDemoContent(db, demoId, owner);
    const other = await upsertOrg(db, { name: "Northwind Dental (empty demo)", slug: "northwind-dental", kind: "client", isDemo: true, industry: "Dental" });
    const otherOwner = await upsertUser(db, "owner@northwind.test", "Morgan Northwind", "none", passwords);
    await member(db, other, otherOwner, "owner");
    if (MOCK_URL) await connectMockHermes(db, demoId, "demo-workspace", admin, creds);
    console.log("Demo workspace ready. Accounts: admin@iacquire.test, staff@iacquire.test, owner@demo.test, member@demo.test, owner@northwind.test");
  });
  creds.passwords = passwords;
  fs.mkdirSync(path.dirname(CRED_FILE), { recursive: true });
  fs.writeFileSync(CRED_FILE, JSON.stringify(creds, null, 2));
  if (DEMO) console.log(`Local passwords saved to ${path.relative(process.cwd(), CRED_FILE)} (gitignored).`);
  if (CRM_DEMO) {
    const { seedCrmDemo } = await import("./seed-crm-demo");
    const ids = await withSystem(async (db) => {
      const org = (await db.query<{ id: string }>("select id from organizations where slug = 'demo-workspace' and is_demo")).rows[0];
      const people = (await db.query<{ id: string; email: string }>("select id, email::text as email from users where email in ('owner@demo.test', 'member@demo.test')")).rows;
      return { org: org?.id, owner: people.find((p) => p.email === "owner@demo.test")?.id, member: people.find((p) => p.email === "member@demo.test")?.id };
    });
    if (ids.org && ids.owner && ids.member) await seedCrmDemo(ids.org, ids.owner, ids.member);
  }
  await closeDb();
}

main().catch(async (err) => {
  console.error("Seed failed:", err instanceof Error ? err.message : err);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
