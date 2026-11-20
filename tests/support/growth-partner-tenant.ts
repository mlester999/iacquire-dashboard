import crypto from "node:crypto";
import { expect } from "vitest";
import { withSystem } from "@/server/db";
import { AGENT_ROLE_KEYS, AI_GROWTH_PARTNER_ROLE_KEY } from "@/lib/agents";
import { emptyBusinessBrain } from "@/lib/ai-growth-partner";
import type { OrgRole } from "@/lib/permissions";
import type { OrgContext } from "@/server/tenancy/context";
import { activateGrowthPartnerBusinessBrainVersion, ensureGrowthPartnerIdentity, saveGrowthPartnerBusinessBrainDraft } from "@/server/ai-growth-partner/service";
import { createConfigVersion, ensureGrowthPartnerRuntime } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import { addMember, createOrg, createUser, ctxFor, inboxMatrixKnob, uid } from "./fixtures";

/**
 * THE shared fixture for every Growth-Partner-only test.
 *
 * It builds a workspace the way a real new client is created (see createClientTenant in src/server/admin/tenants.ts): the
 * organization, company profile, usage limits, billing account and onboarding row, then ensureGrowthPartnerRuntime, which creates
 * the ONE growth_partner agent_instances row and the bound ai_growth_partners row. It never calls ensureAgentInstances, so the
 * workspace has no legacy six-role rows. createOrg (tests/support/fixtures.ts) seeds those six rows and must not be used here.
 *
 * Everything is local and synthetic: no Hermes server, no provider, no network.
 */
export interface GrowthPartnerOnlyTenant {
  org: { id: string; name: string; slug: string };
  owner: { id: string; email: string };
  ownerCtx: OrgContext;
  /** ai_growth_partners.id, the logical Growth Partner identity. */
  partnerId: string;
  /** agent_instances.id of the one growth_partner runtime row the partner is bound to. */
  runtimeAgentId: string;
  /** The canonical permanent chat_conversations row, or null when the tenant was built with conversation: 'none'. */
  conversationId: string | null;
  /** Adds a workspace member with the given role and returns the person and their request context. */
  member(role: OrgRole, opts?: { name?: string }): Promise<{ user: { id: string; email: string }; ctx: OrgContext }>;
  /** How many legacy six-role agent_instances rows this workspace has (always 0 for this fixture). */
  legacyAgentRowCount(): Promise<number>;
}

export interface GrowthPartnerOnlyTenantOptions {
  name?: string;
  /** 'online' (default): an applied configuration version and status online. 'setup_required': the state a brand-new client starts in. */
  runtime?: "setup_required" | "online";
  /** The runtime row's operating mode. Default 'approval_required', the column default. */
  mode?: "approval_required" | "autonomous" | "paused";
  /** 'active' (default): an empty Business Brain saved and activated as version 1. 'none': no Brain version yet. */
  brain?: "none" | "active";
  /** 'direct' (default): the canonical permanent conversation row exists (no Hermes server involved). 'none': no conversation yet. */
  conversation?: "none" | "direct";
  /** IANA timezone stored on the organization and carried on the contexts. Default 'UTC'. */
  timezone?: string;
}

async function legacyRowCount(orgId: string): Promise<number> {
  const { rows } = await withSystem((db) => db.query<{ n: number }>(
    "select count(*)::int as n from agent_instances where org_id = $1 and role_key = any($2::text[])",
    [orgId, [...AGENT_ROLE_KEYS]],
  ));
  return Number(rows[0]?.n ?? 0);
}

export async function createGrowthPartnerOnlyTenant(opts: GrowthPartnerOnlyTenantOptions = {}): Promise<GrowthPartnerOnlyTenant> {
  const runtime = opts.runtime ?? "online";
  const mode = opts.mode ?? "approval_required";
  const brain = opts.brain ?? "active";
  const conversation = opts.conversation ?? "direct";
  const timezone = opts.timezone ?? "UTC";
  const name = opts.name ?? `Partner Org ${uid()}`;
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${uid()}`;

  const created = await withSystem(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      "insert into organizations (name, slug, kind, status, timezone) values ($1, $2, 'client', 'active', $3) returning id",
      [name, slug, timezone],
    );
    const orgId = rows[0].id;
    await db.query("insert into company_profiles (org_id, description) values ($1, 'We help local homeowners.')", [orgId]);
    await db.query("insert into usage_limits (org_id) values ($1)", [orgId]);
    await db.query("insert into billing_accounts (org_id) values ($1)", [orgId]);
    await db.query("insert into onboarding_responses (org_id) values ($1)", [orgId]);
    const runtimeAgentId = await ensureGrowthPartnerRuntime(orgId, db);
    // Use the same isolated test matrix setting as createOrg for every workspace a test creates.
    if (inboxMatrixKnob()) await db.query("insert into inbox_rollout (org_id, enabled, note, enabled_at) values ($1, true, 'Test matrix', now())", [orgId]);
    const partner = (await db.query<{ id: string }>("select id from ai_growth_partners where org_id = $1", [orgId])).rows[0];
    if (!partner) throw new Error("The Growth Partner fixture has no bound partner row.");
    return { orgId, runtimeAgentId, partnerId: partner.id };
  });

  const org = { id: created.orgId, name, slug };
  const owner = await createUser({ name: "Partner Workspace Owner" });
  await addMember(org.id, owner.id, "owner");
  const ownerCtx = withTimezone(ctxFor(owner, org, "owner"), timezone);

  if (runtime === "online") {
    await withSystem(async (db) => {
      await createConfigVersion(db, {
        orgId: org.id,
        agentId: created.runtimeAgentId,
        settings: defaultSettings(AI_GROWTH_PARTNER_ROLE_KEY),
        source: "onboarding",
        userId: owner.id,
        apply: true,
      });
    });
  }
  await withSystem(async (db) => {
    if (runtime === "online") {
      await db.query("update agent_instances set status = 'online', mode = $2 where id = $1 and org_id = $3", [created.runtimeAgentId, mode, org.id]);
    } else {
      await db.query("update agent_instances set mode = $2 where id = $1 and org_id = $3", [created.runtimeAgentId, mode, org.id]);
    }
  });
  if (runtime === "online") {
    const applied = await withSystem((db) => db.query<{ active_config_version_id: string | null }>(
      "select active_config_version_id from agent_instances where id = $1 and org_id = $2",
      [created.runtimeAgentId, org.id],
    ));
    if (!applied.rows[0]?.active_config_version_id) throw new Error("The Growth Partner fixture could not apply its configuration version.");
  }

  if (brain === "active") {
    await ensureGrowthPartnerIdentity(ownerCtx);
    const draft = await saveGrowthPartnerBusinessBrainDraft(ownerCtx, { businessBrain: emptyBusinessBrain() });
    await activateGrowthPartnerBusinessBrainVersion(ownerCtx, { expectedCurrentVersion: null, version: draft.version });
  }

  let conversationId: string | null = null;
  if (conversation === "direct") {
    // The canonical permanent conversation, the same columns runHealthCheck writes (src/server/workforce/service.ts), without a Hermes server.
    conversationId = await withSystem(async (db) => {
      await db.query(
        `insert into chat_conversations (org_id, agent_instance_id, user_id, title, hermes_session_id, growth_partner_id)
         values ($1, $2, null, 'AI Growth Partner', $3, $4)
         on conflict do nothing`,
        [org.id, created.runtimeAgentId, `iaq-gp-${crypto.randomUUID()}`, created.partnerId],
      );
      const row = (await db.query<{ id: string }>(
        "select id from chat_conversations where org_id = $1 and growth_partner_id = $2 and deleted_at is null",
        [org.id, created.partnerId],
      )).rows[0];
      if (!row) throw new Error("The Growth Partner fixture could not create its conversation.");
      return row.id;
    });
  }

  // runHealthCheck marks the partner configured once it has an active Brain version and its conversation. Mirror that exact condition.
  if (brain === "active" && conversationId) {
    await withSystem((db) => db.query("update ai_growth_partners set status = 'configured' where id = $1 and org_id = $2 and current_version is not null", [created.partnerId, org.id]));
  }

  return {
    org,
    owner,
    ownerCtx,
    partnerId: created.partnerId,
    runtimeAgentId: created.runtimeAgentId,
    conversationId,
    async member(role, memberOpts = {}) {
      const user = await createUser({ name: memberOpts.name });
      await addMember(org.id, user.id, role);
      return { user, ctx: withTimezone(ctxFor(user, org, role), timezone) };
    },
    legacyAgentRowCount: () => legacyRowCount(org.id),
  };
}

function withTimezone(ctx: OrgContext, timezone: string): OrgContext {
  if (ctx.org.timezone === timezone) return ctx;
  const org = { ...ctx.org, timezone };
  return { ...ctx, org, memberships: [org] };
}

/** Asserts the workspace has none of the six legacy role rows and at most the one growth_partner row. */
export async function expectNoLegacyEmployeeRows(orgId: string): Promise<void> {
  expect(await legacyRowCount(orgId)).toBe(0);
  const { rows } = await withSystem((db) => db.query<{ n: number }>(
    "select count(*)::int as n from agent_instances where org_id = $1 and role_key = $2",
    [orgId, AI_GROWTH_PARTNER_ROLE_KEY],
  ));
  expect(Number(rows[0]?.n ?? 0)).toBeLessThanOrEqual(1);
}

/** The retained shape: createOrg seeds the six legacy role rows. Use it to run a test against both shapes. */
export async function createLegacySixRoleTenant(opts: { name?: string } = {}): Promise<{
  org: { id: string; name: string; slug: string };
  owner: { id: string; email: string };
  ownerCtx: OrgContext;
}> {
  const org = await createOrg({ name: opts.name ?? `Legacy Org ${uid()}` });
  const owner = await createUser({ name: "Legacy Workspace Owner" });
  await addMember(org.id, owner.id, "owner");
  return { org, owner, ownerCtx: ctxFor(owner, org, "owner") };
}
