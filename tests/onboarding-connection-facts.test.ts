import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { buildReviewModel, type ConnectionFacts } from "@/lib/onboarding/engine";
import { connectionFacts } from "@/server/onboarding/connection-facts";
import type { Answers, StoredAnswers } from "@/lib/onboarding/types";
import { addMember, createOrg, createUser } from "./support/fixtures";

// The review of the questionnaire reports real connection state. These cover the three optional lines added in milestone M3 (website address verified, website chat seen
// on a website, a social account connected), read from the real tables, and the rule that they never block anything.

const run = <T>(fn: (db: Parameters<Parameters<typeof withSystem>[0]>[0]) => Promise<T>) => withSystem(fn);
const stored = (a: Answers): StoredAnswers => Object.fromEntries(Object.entries(a).map(([id, value]) => [id, { value: value as never, skipped: false, source: "user" as const, needsConfirmation: false, updatedAt: "" }]));
const base: Answers = { "a.business_name": "Roof Co", "a.industry": "home_services", "a.business_model": "local", "a.description": "We repair roofs.", "a.timezone": "America/Chicago", "a.contact_email": "a@b.test", "b.goals": ["more_leads"], "b.appointments": false, "b.website_need": "have", "d.pricing_policy": "never", "f.review": true };
const six = ["operations_manager", "lead_hunter", "appointment_setter", "sales_assistant", "crm_manager", "performance_analyst"] as const;
const facts = (over: Partial<ConnectionFacts> = {}): ConnectionFacts => ({
  crmLinked: true, aiEmployeesVerified: 6, aiEmployeesTotal: 6, automationMapped: true,
  channels: { sms: { enabled: false, registration: "x" }, whatsapp: { enabled: false, registration: "x" }, email: { enabled: false, registration: "x" } },
  calendarConnected: true, websiteDomainVerified: false, invitedStaff: 0, ...over,
});

async function workspace(name: string) {
  const org = await createOrg({ name });
  const owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  return { org, owner };
}
/** One website per workspace (the database allows one main site), with as many addresses as the test needs. */
async function site(orgId: string, host: string, status: string) {
  const have = await run((db) => db.query<{ id: string }>("select id from websites where org_id = $1", [orgId]));
  const websiteId = have.rows[0]?.id ?? (await run((db) => db.query<{ id: string }>("insert into websites (org_id, name, template_key, subdomain, draft_content) values ($1, 'Site', 'local.service', $2, '{}'::jsonb) returning id", [orgId, `site-${orgId.slice(0, 8)}`]))).rows[0].id;
  await run((db) => db.query("insert into website_domains (org_id, website_id, hostname, kind, status, verification_token) values ($1, $2, $3, 'custom', $4, repeat('a', 32))", [orgId, websiteId, host, status]));
}

describe("connection facts read from the real tables", () => {
  it("reports nothing connected for a fresh workspace, and never invents a connection", async () => {
    const { org } = await workspace("Bare Co");
    const f = await run((db) => connectionFacts(db, org.id));
    expect(f.websiteDomainVerified).toBe(false);
    expect(f.chatWidget).toBe("disabled");
    expect(f.socialConnected).toBe(false);
  });

  it("counts a website address only once it is verified or active, and never a removed one", async () => {
    const { org } = await workspace("Domain Co");
    await site(org.id, "pending.example.test", "pending_dns");
    expect((await run((db) => connectionFacts(db, org.id))).websiteDomainVerified).toBe(false);
    await site(org.id, "broken.example.test", "error");
    expect((await run((db) => connectionFacts(db, org.id))).websiteDomainVerified).toBe(false);
    await site(org.id, "ok.example.test", "verified");
    expect((await run((db) => connectionFacts(db, org.id))).websiteDomainVerified).toBe(true);
    await run((db) => db.query("update website_domains set removed_at = now() where org_id = $1 and hostname = 'ok.example.test'", [org.id]));
    expect((await run((db) => connectionFacts(db, org.id))).websiteDomainVerified).toBe(false);
    await site(org.id, "live.example.test", "active");
    expect((await run((db) => connectionFacts(db, org.id))).websiteDomainVerified).toBe(true);
  });

  it("says where the website chat stands from install evidence only: off, no website, waiting for a first visit, seen", async () => {
    const { org } = await workspace("Chat Co");
    const widget = async (set: string) => run((db) => db.query(`insert into web_chat_widgets (org_id, public_key) values ($1::uuid, 'wk_' || substr(md5(random()::text || $1::text), 1, 24)) on conflict (org_id) do update set ${set}`, [org.id]));
    await widget("enabled = false");
    expect((await run((db) => connectionFacts(db, org.id))).chatWidget).toBe("disabled");
    await widget("enabled = true, auto_install_sites = false, allowed_origins = '{}'");
    expect((await run((db) => connectionFacts(db, org.id))).chatWidget).toBe("no_sites");
    await widget("allowed_origins = '{www.example.test}'");
    expect((await run((db) => connectionFacts(db, org.id))).chatWidget).toBe("waiting");
    await widget("last_seen_at = now(), last_seen_origin = 'www.example.test'");
    expect((await run((db) => connectionFacts(db, org.id))).chatWidget).toBe("installed");
  });

  it("counts a connected Meta account of this workspace, not a simulated one, not a disconnected one and not another workspace's", async () => {
    const { org } = await workspace("Social Co");
    const other = await workspace("Other Social Co");
    const account = (orgId: string, adapter: string, status: string, external: string) =>
      run((db) => db.query("insert into social_accounts (org_id, platform, adapter, external_id, name, status) values ($1, 'facebook', $2, $3, 'Page', $4)", [orgId, adapter, external, status]));
    await account(other.org.id, "meta", "connected", "p1");
    expect((await run((db) => connectionFacts(db, org.id))).socialConnected).toBe(false);
    await account(org.id, "simulated", "connected", "p2");
    expect((await run((db) => connectionFacts(db, org.id))).socialConnected).toBe(false);
    await account(org.id, "meta", "needs_reauth", "p3");
    expect((await run((db) => connectionFacts(db, org.id))).socialConnected).toBe(false);
    await account(org.id, "meta", "connected", "p4");
    expect((await run((db) => connectionFacts(db, org.id))).socialConnected).toBe(true);
    expect((await run((db) => connectionFacts(db, other.org.id))).socialConnected).toBe(true);
  });
});

describe("the optional lines of the review", () => {
  const model = (a: Answers, f: ConnectionFacts) => buildReviewModel(stored(a), f, [...six]);

  it("shows the website address only to someone who asked for a website, and says plainly when it is not verified", () => {
    expect(model(base, facts()).optionalConnections.map((l) => l.key)).not.toContain("website_domain");
    const wants = model({ ...base, "b.website_need": "new" }, facts());
    expect(wants.optionalConnections.find((l) => l.key === "website_domain")).toMatchObject({ state: "not_connected", label: expect.stringMatching(/not verified/i) });
    const verified = model({ ...base, "b.website_need": "new" }, facts({ websiteDomainVerified: true }));
    expect(verified.optionalConnections.find((l) => l.key === "website_domain")).toMatchObject({ state: "connected" });
    // A verified address is worth saying even to someone who did not ask for a new site.
    expect(model(base, facts({ websiteDomainVerified: true })).optionalConnections.find((l) => l.key === "website_domain")?.state).toBe("connected");
  });

  it("reports the chat widget in its four honest states, and nothing when the server did not say", () => {
    expect(model(base, facts()).optionalConnections.map((l) => l.key)).not.toContain("chat_widget");
    const state = (chatWidget: ConnectionFacts["chatWidget"]) => model(base, facts({ chatWidget })).optionalConnections.find((l) => l.key === "chat_widget");
    expect(state("installed")).toMatchObject({ state: "connected" });
    expect(state("waiting")).toMatchObject({ state: "waiting", label: expect.stringMatching(/waiting for its first visit/i) });
    expect(state("no_sites")).toMatchObject({ state: "not_connected" });
    expect(state("disabled")).toMatchObject({ state: "not_connected", label: expect.stringMatching(/switched off/i) });
  });

  it("reports a social account, and nothing when the server did not say", () => {
    expect(model(base, facts()).optionalConnections.map((l) => l.key)).not.toContain("social");
    expect(model(base, facts({ socialConnected: true })).optionalConnections.find((l) => l.key === "social")).toMatchObject({ state: "connected" });
    expect(model(base, facts({ socialConnected: false })).optionalConnections.find((l) => l.key === "social")).toMatchObject({ state: "not_connected" });
  });

  it("never blocks approval and never counts as a missing connection", () => {
    const m = model({ ...base, "b.website_need": "new" }, facts({ chatWidget: "disabled", socialConnected: false }));
    expect(m.optionalConnections.length).toBe(3);
    expect(m.missingConnections).toEqual([]);
    expect(m.canSubmit).toBe(true);
    expect(m.blockers).toEqual([]);
  });
});
