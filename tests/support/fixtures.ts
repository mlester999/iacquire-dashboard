import crypto from "node:crypto";
import { withSystem } from "@/server/db";
import { ensureAgentInstances } from "@/server/workforce/service";
import { permissionsFor, roleHasPermission, type OrgRole } from "@/lib/permissions";
import type { OrgContext, Membership } from "@/server/tenancy/context";
import type { SessionUser } from "@/server/auth/service";
import type { PlatformRole } from "@/lib/permissions";

export const uid = () => crypto.randomUUID().slice(0, 8);

export async function createUser(opts: { email?: string; platformRole?: PlatformRole; name?: string } = {}) {
  const email = opts.email ?? `user-${uid()}@example.test`;
  const { rows } = await withSystem((db) =>
    db.query<{ id: string }>(
      "insert into users (email, full_name, email_verified_at, platform_role) values ($1, $2, now(), $3) returning id",
      [email, opts.name ?? "Test User", opts.platformRole ?? "none"],
    ),
  );
  return { id: rows[0].id, email };
}

/**
 * The test matrix knob INBOX_TEST_ROLLOUT=on: every workspace createOrg makes has the new inbox switched on, so the rest of the suite can be run in that state.
 * It exists for the in-memory test database only (NODE_ENV=test and DATABASE_DRIVER=pglite-memory, which vitest.config.ts sets for every run). Anywhere else
 * (a file-based embedded QA database, a local or hosted Postgres, development or production mode) it throws instead of writing a rollout row that would outlive the run
 * or reach a real workspace. A value other than on, off or empty throws too, so a typo such as "true" cannot quietly make a run that is not the matrix run.
 */
export function inboxMatrixKnob(vars: Record<string, string | undefined> = process.env): boolean {
  const value = vars.INBOX_TEST_ROLLOUT;
  if (value === undefined || value === "" || value === "off") return false;
  if (value !== "on") throw new Error(`INBOX_TEST_ROLLOUT must be "on" or "off" (or unset), not "${value}".`);
  if (vars.NODE_ENV !== "test" || vars.DATABASE_DRIVER !== "pglite-memory") {
    throw new Error("INBOX_TEST_ROLLOUT=on is only for the in-memory test database (NODE_ENV=test, DATABASE_DRIVER=pglite-memory, as vitest.config.ts sets). Refusing to write rollout rows anywhere else.");
  }
  return true;
}

export async function createOrg(opts: { name?: string; kind?: "agency" | "client"; status?: string } = {}) {
  const name = opts.name ?? `Org ${uid()}`;
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${uid()}`;
  return withSystem(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      "insert into organizations (name, slug, kind, status) values ($1, $2, $3, $4) returning id",
      [name, slug, opts.kind ?? "client", opts.status ?? "active"],
    );
    const orgId = rows[0].id;
    await db.query("insert into company_profiles (org_id, description) values ($1, 'We help local homeowners.')", [orgId]);
    await db.query("insert into usage_limits (org_id) values ($1)", [orgId]);
    await db.query("insert into billing_accounts (org_id) values ($1)", [orgId]);
    await ensureAgentInstances(orgId, db);
    // A test matrix knob, never set in a normal run: INBOX_TEST_ROLLOUT=on switches the new inbox on for every workspace a test creates, so the rest of the
    // suite can be run with it on (the inbox's own tests assume the default, off, and are left out of that run). See docs/unified-inbox/release-verification.md.
    // inboxMatrixKnob() above refuses it on anything but the in-memory test database.
    if (inboxMatrixKnob()) await db.query("insert into inbox_rollout (org_id, enabled, note, enabled_at) values ($1, true, 'Test matrix', now())", [orgId]);
    return { id: orgId, name, slug };
  });
}

export async function addMember(orgId: string, userId: string, role: OrgRole) {
  await withSystem((db) =>
    db.query("insert into organization_memberships (org_id, user_id, role) values ($1, $2, $3)", [orgId, userId, role]),
  );
}

export function ctxFor(user: { id: string; email: string }, org: { id: string; name: string; slug: string }, role: OrgRole): OrgContext {
  const sessionUser: SessionUser = {
    sessionId: crypto.randomUUID(),
    id: user.id,
    email: user.email,
    fullName: "Test User",
    platformRole: "none",
    timezone: "UTC",
    preferences: {},
    emailVerified: true,
  };
  const membership: Membership = {
    orgId: org.id,
    name: org.name,
    slug: org.slug,
    kind: "client",
    status: "active",
    role,
    isDemo: false,
    onboardingCompletedAt: null,
    timezone: "UTC",
  };
  return {
    user: sessionUser,
    org: membership,
    role,
    permissions: permissionsFor(role),
    can: (p) => roleHasPermission(role, p),
    memberships: [membership],
  };
}

export function agencyUser(user: { id: string; email: string }, platformRole: "agency_staff" | "agency_manager" | "agency_super_admin"): SessionUser {
  return {
    sessionId: crypto.randomUUID(),
    id: user.id,
    email: user.email,
    fullName: "Agency User",
    platformRole,
    timezone: "UTC",
    preferences: {},
    emailVerified: true,
  };
}

export async function agentId(orgId: string, role: string) {
  const { rows } = await withSystem((db) =>
    db.query<{ id: string }>("select id from agent_instances where org_id = $1 and role_key = $2", [orgId, role]),
  );
  return rows[0].id;
}
