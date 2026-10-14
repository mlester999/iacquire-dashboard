import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { addMember, createOrg, createUser } from "./support/fixtures";

// Every table that carries tenant data. A failing entry here means cross-tenant reads are possible.
const TENANT_TABLES = [
  "company_profiles", "onboarding_responses", "company_knowledge", "knowledge_documents", "agent_instances",
  "agent_config_versions", "agent_provisioning_jobs", "chat_conversations", "chat_messages", "agent_runs",
  "tool_executions", "integration_status", "approval_requests", "approval_events", "tasks", "lead_targeting_profiles",
  "lead_research_requests", "leads", "crm_pipelines", "crm_opportunities", "appointment_refs", "record_notes",
  "retention_accounts", "customer_feedback", "service_history", "notifications", "support_tickets", "support_messages",
  "usage_events", "usage_limits", "billing_accounts", "audit_logs",
];

let orgA: Awaited<ReturnType<typeof createOrg>>;
let orgB: Awaited<ReturnType<typeof createOrg>>;
let ownerA: { id: string; email: string };
let ownerB: { id: string; email: string };
let memberA: { id: string; email: string };
let staff: { id: string; email: string };
let superAdmin: { id: string; email: string };

async function seedTenantData(orgId: string, userId: string) {
  await withSystem(async (db) => {
    const agent = (await db.query<{ id: string }>("select id from agent_instances where org_id = $1 limit 1", [orgId])).rows[0].id;
    await db.query("insert into onboarding_responses (org_id) values ($1) on conflict do nothing", [orgId]);
    await db.query("insert into company_knowledge (org_id, section, content) values ($1, 'faq', 'secret faq')", [orgId]);
    await db.query(
      "insert into knowledge_documents (org_id, filename, mime_type, size_bytes, sha256, storage_key) values ($1, 'a.txt', 'text/plain', 5, $2, $3)",
      [orgId, "a".repeat(64), `${orgId}/doc`],
    );
    const v = await db.query<{ id: string }>(
      `insert into agent_config_versions (org_id, agent_instance_id, version, settings, summary, compiled_instructions, policy_version, source, status)
       values ($1, $2, 1, '{}', 's', 'i', 'p', 'onboarding', 'applied') returning id`,
      [orgId, agent],
    );
    await db.query("insert into agent_provisioning_jobs (org_id, agent_instance_id, kind) values ($1, $2, 'provision')", [orgId, agent]);
    const c = await db.query<{ id: string }>(
      "insert into chat_conversations (org_id, agent_instance_id, user_id, title, hermes_session_id) values ($1, $2, $3, 'Secret', gen_random_uuid()::text) returning id",
      [orgId, agent, userId],
    );
    await db.query("insert into chat_messages (conversation_id, org_id, role, content) values ($1, $2, 'user', 'confidential')", [c.rows[0].id, orgId]);
    const run = await db.query<{ id: string }>(
      "insert into agent_runs (org_id, agent_instance_id, conversation_id, user_id, idempotency_key, config_version_id) values ($1, $2, $3, $4, gen_random_uuid()::text, $5) returning id",
      [orgId, agent, c.rows[0].id, userId, v.rows[0].id],
    );
    await db.query("insert into tool_executions (run_id, org_id, tool_name, label) values ($1, $2, 'crm', 'Looking up CRM')", [run.rows[0].id, orgId]);
    await db.query("insert into integration_status (org_id, provider, status) values ($1, 'ghl', 'not_configured')", [orgId]);
    const ap = await db.query<{ id: string }>(
      "insert into approval_requests (org_id, kind, title) values ($1, 'crm_update', 'Update deal') returning id",
      [orgId],
    );
    await db.query("insert into approval_events (approval_id, org_id, event) values ($1, $2, 'created')", [ap.rows[0].id, orgId]);
    await db.query("insert into tasks (org_id, title) values ($1, 'Call back')", [orgId]);
    await db.query("insert into lead_targeting_profiles (org_id) values ($1)", [orgId]);
    const rr = await db.query<{ id: string }>("insert into lead_research_requests (org_id, prompt) values ($1, 'find dentists') returning id", [orgId]);
    await db.query("insert into leads (org_id, research_request_id, business_name) values ($1, $2, 'Secret Lead')", [orgId, rr.rows[0].id]);
    await db.query("insert into crm_pipelines (org_id, ghl_pipeline_id, name) values ($1, 'pipe1234567890', 'Sales')", [orgId]);
    await db.query("insert into crm_opportunities (org_id, ghl_opportunity_id, name, status) values ($1, 'opp1234567890', 'Big deal', 'open')", [orgId]);
    await db.query(
      "insert into appointment_refs (org_id, ghl_appointment_id, ghl_calendar_id, status, start_at, end_at) values ($1, 'appt12345678', 'cal1234567890', 'confirmed', now(), now() + interval '30 min')",
      [orgId],
    );
    await db.query("insert into record_notes (org_id, record_type, record_id, body) values ($1, 'opportunity', 'opp1', 'note')", [orgId]);
    const acct = await db.query<{ id: string }>("insert into retention_accounts (org_id, customer_name) values ($1, 'Client X') returning id", [orgId]);
    await db.query("insert into customer_feedback (org_id, account_id, rating) values ($1, $2, 5)", [orgId, acct.rows[0].id]);
    await db.query("insert into service_history (org_id, account_id, event) values ($1, $2, 'Visit')", [orgId, acct.rows[0].id]);
    await db.query("insert into notifications (org_id, user_id, kind, title) values ($1, $2, 'system', 'Hi')", [orgId, userId]);
    const t = await db.query<{ id: string }>("insert into support_tickets (org_id, created_by, subject) values ($1, $2, 'Help me') returning id", [orgId, userId]);
    await db.query("insert into support_messages (ticket_id, org_id, author_kind, body) values ($1, $2, 'client', 'details')", [t.rows[0].id, orgId]);
    await db.query("insert into support_messages (ticket_id, org_id, author_kind, body, internal) values ($1, $2, 'agency', 'internal note', true)", [t.rows[0].id, orgId]);
    await db.query("insert into usage_events (org_id, kind) values ($1, 'agent_message')", [orgId]);
    await db.query("insert into audit_logs (org_id, actor_kind, action, result) values ($1, 'system', 'test.event', 'success')", [orgId]);
  });
}

beforeAll(async () => {
  orgA = await createOrg({ name: "Alpha Roofing" });
  orgB = await createOrg({ name: "Bravo Dental" });
  ownerA = await createUser();
  ownerB = await createUser();
  memberA = await createUser();
  staff = await createUser({ platformRole: "agency_staff" });
  superAdmin = await createUser({ platformRole: "agency_super_admin" });
  await addMember(orgA.id, ownerA.id, "owner");
  await addMember(orgA.id, memberA.id, "member");
  await addMember(orgB.id, ownerB.id, "owner");
  await seedTenantData(orgA.id, ownerA.id);
  await seedTenantData(orgB.id, ownerB.id);
  await withSystem((db) => db.query("insert into staff_assignments (org_id, user_id) values ($1, $2)", [orgA.id, staff.id]));
});

describe("row-level security", () => {
  it.each(TENANT_TABLES)("owner of tenant A cannot read tenant B rows in %s", async (table) => {
    const rows = await withUser(ownerA.id, (db) => db.query<{ n: number }>(`select count(*)::int as n from ${table} where org_id = $1`, [orgB.id]));
    expect(rows.rows[0].n).toBe(0);
  });

  it("owner of tenant A sees their own tenant data", async () => {
    const res = await withUser(ownerA.id, (db) => db.query<{ n: number }>("select count(*)::int as n from leads where org_id = $1", [orgA.id]));
    expect(res.rows[0].n).toBe(1);
  });

  it("forged org_id in an insert is rejected", async () => {
    await expect(
      withUser(ownerA.id, (db) => db.query("insert into tasks (org_id, title, created_by) values ($1, 'evil', $2)", [orgB.id, ownerA.id])),
    ).rejects.toThrow(/row-level security/);
  });

  it("a user cannot insert a chat message into another tenant's conversation", async () => {
    const conv = await withSystem((db) => db.query<{ id: string }>("select id from chat_conversations where org_id = $1", [orgB.id]));
    await expect(
      withUser(ownerA.id, (db) =>
        db.query("insert into chat_messages (conversation_id, org_id, role, content) values ($1, $2, 'user', 'x')", [conv.rows[0].id, orgA.id]),
      ),
    ).rejects.toThrow();
  });

  it("composite keys stop cross-tenant references even via trusted writes", async () => {
    const acctB = await withSystem((db) => db.query<{ id: string }>("select id from retention_accounts where org_id = $1", [orgB.id]));
    await expect(
      withSystem((db) => db.query("insert into service_history (org_id, account_id, event) values ($1, $2, 'x')", [orgA.id, acctB.rows[0].id])),
    ).rejects.toThrow(/foreign key/);
  });

  it("conversations are private to their creator, even within the tenant", async () => {
    const res = await withUser(memberA.id, (db) => db.query<{ n: number }>("select count(*)::int as n from chat_messages"));
    expect(res.rows[0].n).toBe(0);
  });

  it("members cannot read the tenant audit log", async () => {
    const res = await withUser(memberA.id, (db) => db.query<{ n: number }>("select count(*)::int as n from audit_logs where org_id = $1", [orgA.id]));
    expect(res.rows[0].n).toBe(0);
  });

  it("client users never see internal agency support notes", async () => {
    const res = await withUser(ownerA.id, (db) => db.query<{ body: string }>("select body from support_messages where org_id = $1", [orgA.id]));
    expect(res.rows.map((r) => r.body)).toEqual(["details"]);
  });

  it("assigned agency staff can access only their assigned tenant", async () => {
    const a = await withUser(staff.id, (db) => db.query<{ n: number }>("select count(*)::int as n from support_tickets where org_id = $1", [orgA.id]));
    const b = await withUser(staff.id, (db) => db.query<{ n: number }>("select count(*)::int as n from support_tickets where org_id = $1", [orgB.id]));
    expect(a.rows[0].n).toBe(1);
    expect(b.rows[0].n).toBe(0);
  });

  it("agency staff can read internal notes but not client conversations", async () => {
    const notes = await withUser(staff.id, (db) => db.query<{ n: number }>("select count(*)::int as n from support_messages where org_id = $1 and internal", [orgA.id]));
    const chats = await withUser(staff.id, (db) => db.query<{ n: number }>("select count(*)::int as n from chat_messages where org_id = $1", [orgA.id]));
    expect(notes.rows[0].n).toBe(1);
    expect(chats.rows[0].n).toBe(0);
  });

  it("super admins can see all tenants", async () => {
    const res = await withUser(superAdmin.id, (db) => db.query<{ n: number }>("select count(*)::int as n from organizations where id = any($1::uuid[])", [[orgA.id, orgB.id]]));
    expect(res.rows[0].n).toBe(2);
  });

  it("the application role cannot read credentials, sessions or tokens", async () => {
    for (const table of ["auth_credentials", "auth_sessions", "auth_tokens", "integration_credentials", "email_outbox", "invitations"]) {
      await expect(withUser(ownerA.id, (db) => db.query(`select * from ${table} limit 1`))).rejects.toThrow(/permission denied/);
    }
  });

  it("users cannot escalate their own platform role", async () => {
    await expect(
      withUser(ownerA.id, (db) => db.query("update users set platform_role = 'agency_super_admin' where id = $1", [ownerA.id])),
    ).rejects.toThrow(/permission denied/);
  });

  it("suspending a tenant removes client access", async () => {
    await withSystem((db) => db.query("update organizations set status = 'suspended' where id = $1", [orgB.id]));
    const res = await withUser(ownerB.id, (db) => db.query<{ n: number }>("select count(*)::int as n from leads where org_id = $1", [orgB.id]));
    expect(res.rows[0].n).toBe(0);
    await withSystem((db) => db.query("update organizations set status = 'active' where id = $1", [orgB.id]));
  });

  it("audit logs are append-only", async () => {
    await expect(withSystem((db) => db.query("update audit_logs set result = 'failure'"))).rejects.toThrow(/append-only/);
  });
});

describe("protected integrations", () => {
  it("the Aster Homes location can never be mapped", async () => {
    await expect(
      withSystem((db) => db.query("insert into ghl_location_mappings (org_id, location_id) values ($1, 'u69CVh0ZlAofUmRoj1zF')", [orgA.id])),
    ).rejects.toThrow(/check/);
  });

  it("the agency's internal GHL location cannot be assigned to a client", async () => {
    await expect(
      withSystem((db) => db.query("insert into ghl_location_mappings (org_id, location_id) values ($1, 'SQvVnld5MBHdMQ1qnSfw')", [orgA.id])),
    ).rejects.toThrow(/agency_location_not_assignable/);
  });

  it("client employees can't be routed to internal iacquire-* Hermes profiles", async () => {
    await expect(
      withSystem((db) =>
        db.query("update agent_instances set hermes_profile = 'iacquire-lead-hunter', hermes_base_url = 'https://h.example.com' where org_id = $1 and role_key = 'lead_hunter'", [orgA.id]),
      ),
    ).rejects.toThrow(/reserved_hermes_profile/);
  });

  it("one Hermes profile cannot back two tenants", async () => {
    await withSystem((db) =>
      db.query("update agent_instances set hermes_profile = 'c-alpha-lead-hunter', hermes_base_url = 'https://h.example.com' where org_id = $1 and role_key = 'lead_hunter'", [orgA.id]),
    );
    await expect(
      withSystem((db) =>
        db.query("update agent_instances set hermes_profile = 'c-alpha-lead-hunter', hermes_base_url = 'https://h.example.com' where org_id = $1 and role_key = 'lead_hunter'", [orgB.id]),
      ),
    ).rejects.toThrow(/duplicate key/);
  });
});
