import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";

type TenantState = { orgId: string; orgName: string; orgSlug: string; userId: string; email: string; conversationId: string; message: string };

async function main() {
  const [mode, dataDir, stateJson] = process.argv.slice(2);
  if (process.env.NODE_ENV !== "test" || process.env.DATABASE_DRIVER !== "pglite" || process.env.DATABASE_URL) {
    throw new Error("The persistence probe requires NODE_ENV=test, DATABASE_DRIVER=pglite and no DATABASE_URL.");
  }
  const resolvedDir = path.resolve(dataDir ?? "");
  if (!dataDir || !resolvedDir.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) || !path.basename(resolvedDir).startsWith("iaq-gp-persist-")) {
    throw new Error("The persistence probe accepts only its disposable temporary PGlite directory.");
  }

  // This probe needs only the local database. Any accidental HTTP request fails before leaving the process.
  globalThis.fetch = (async () => { throw new Error("Network is disabled for the Growth Partner persistence probe."); }) as typeof fetch;

  const [{ closeDb, withSystem, withUser }, fixtures, workforce, growthPartner] = await Promise.all([
    import("@/server/db"),
    import("../tests/support/fixtures"),
    import("@/server/workforce/service"),
    import("@/server/ai-growth-partner/service"),
  ]);

  const createTenant = async (label: string): Promise<TenantState> => {
    const org = await fixtures.createOrg({ name: label });
    const user = await fixtures.createUser({ name: `${label} owner` });
    await fixtures.addMember(org.id, user.id, "owner");
    const ctx = fixtures.ctxFor(user, org, "owner");
    const runtimeId = await withSystem(async (db) => {
      await db.query(
        `insert into agent_roles (key, name, short_name, tagline, description, capabilities, default_tools, accent, sort_order)
         values ('growth_partner', 'AI Growth Partner', 'Growth Partner', 'One partner', 'Unified test identity', '[]'::jsonb, '[]'::jsonb, '#6d63d8', 7)
         on conflict (key) do nothing`,
      );
      return workforce.ensureGrowthPartnerRuntime(org.id, db);
    });
    const partner = await growthPartner.ensureGrowthPartnerIdentity(ctx);
    const message = `${label} persistent conversation marker ${randomUUID()}`;
    const conversation = await withSystem((db) => db.query<{ id: string }>(
      `insert into chat_conversations (org_id, agent_instance_id, user_id, growth_partner_id, title, hermes_session_id)
       values ($1, $2, null, $3, 'AI Growth Partner', $4) returning id`,
      [org.id, runtimeId, partner.id, `iaq:${org.id}:growth_partner:${randomUUID()}`],
    ));
    const conversationId = conversation.rows[0]!.id;
    await withUser(user.id, (db) => db.query(
      `insert into chat_messages (conversation_id, org_id, role, content, author_user_id)
       values ($1, $2, 'user', $3, $4)`,
      [conversationId, org.id, message, user.id],
    ));
    return { orgId: org.id, orgName: org.name, orgSlug: org.slug, userId: user.id, email: user.email, conversationId, message };
  };

  try {
    if (mode === "seed") {
      const primary = await createTenant("Persist GP Primary");
      const control = await createTenant("Persist GP Control");
      await closeDb();
      process.stdout.write(`PERSISTENCE_SEEDED:${JSON.stringify({ primary, control })}\n`);
      return;
    }
    if (mode !== "verify" || !stateJson) throw new Error("Expected mode 'seed' or 'verify' with tenant state.");
    const state = JSON.parse(stateJson) as { primary: TenantState; control: TenantState };
    const readTenant = async (tenant: TenantState) => {
      const ctx = fixtures.ctxFor({ id: tenant.userId, email: tenant.email }, { id: tenant.orgId, name: tenant.orgName, slug: tenant.orgSlug }, "owner");
      return { ctx, page: await growthPartner.getGrowthPartnerConversationPage(ctx) };
    };
    const primary = await readTenant(state.primary);
    const control = await readTenant(state.control);
    if (primary.page?.conversation.id !== state.primary.conversationId || primary.page.messages[0]?.content !== state.primary.message) {
      throw new Error("The primary tenant's canonical conversation or marker did not survive the database restart.");
    }
    if (control.page?.conversation.id !== state.control.conversationId || control.page.messages[0]?.content !== state.control.message) {
      throw new Error("The control tenant's canonical conversation or marker did not survive the database restart.");
    }
    const foreignConversation = await withUser(state.control.userId, (db) => db.query<{ id: string }>(
      "select id from chat_conversations where id = $1",
      [state.primary.conversationId],
    ));
    const foreignSearch = await growthPartner.searchGrowthPartnerConversation(control.ctx, state.primary.message);
    if (foreignConversation.rows.length !== 0 || foreignSearch.length !== 0) {
      throw new Error("The control tenant could read the primary tenant's conversation after restart.");
    }
    await closeDb();
    process.stdout.write("PERSISTENCE_RESTART_PASS tenants=2 own_conversations=2 own_markers=2 foreign_reads=0\n");
  } finally {
    await closeDb();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
