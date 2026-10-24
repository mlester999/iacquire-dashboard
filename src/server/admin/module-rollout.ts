import "server-only";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { env } from "@/server/env";
import { ESIGN_FEATURE, PROPOSALS_FEATURE, setOrgFeature } from "@/server/proposals/features";
import { INVOICES_FEATURE, setInvoicesEnabled } from "@/server/invoices/feature";
import { REPUTATION_BATCHES_FEATURE, REPUTATION_REVIEWS_FEATURE, REPUTATION_SURVEYS_FEATURE, setBatchesEnabled, setExternalReviewsEnabled, setSurveysEnabled } from "@/server/reputation/entitlement";
import { MODULES, MODULE_KEYS, dependencyProblem, isModuleKey, type EnvSwitchState, type ModuleKey, type ModuleRolloutRow, type ModuleRolloutView, type ModuleSwitchResult } from "@/lib/admin/module-rollout";
import type { SessionUser } from "@/server/auth/service";

// The Super Admin's page for switching the Wave 1 modules on per client workspace. It decides nothing about a module itself: every change is made by the module's own service
// (setOrgFeature, setInvoicesEnabled, setSurveysEnabled, setBatchesEnabled, setExternalReviewsEnabled), which checks the Super Admin again and writes the audit row. Nothing in this
// file writes org_features, and what the page shows is read back from it. Switching a module on connects nothing, sends nothing and turns no provider on.

const LIST_LIMIT = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FEATURE_OF: Record<ModuleKey, string> = {
  proposals: PROPOSALS_FEATURE,
  esign: ESIGN_FEATURE,
  invoices: INVOICES_FEATURE,
  reputation_surveys: REPUTATION_SURVEYS_FEATURE,
  reputation_batches: REPUTATION_BATCHES_FEATURE,
  reputation_reviews: REPUTATION_REVIEWS_FEATURE,
};

function assertSuperAdmin(user: Pick<SessionUser, "platformRole">) {
  if (user.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only a Super Admin can switch modules on or off for a workspace.");
}

/** The environment switches each module waits on, as they stand now. A yes or no only: a value is never read out. */
function envStates(): Record<ModuleKey, EnvSwitchState[]> {
  const e = env() as unknown as Record<string, unknown>;
  const out = {} as Record<ModuleKey, EnvSwitchState[]>;
  for (const m of MODULES) {
    out[m.key] = m.env.map((s) => {
      const value = e[s.name];
      const on = typeof value === "boolean" ? value : null;
      return { name: s.name, on, wantOn: s.wantOn, ok: on === s.wantOn, meaning: s.meaning };
    });
  }
  return out;
}

const emptyState = () => Object.fromEntries(MODULE_KEYS.map((k) => [k, { on: false, since: null, byName: null }])) as ModuleRolloutRow["modules"];

export async function listModuleRollout(user: Pick<SessionUser, "platformRole">): Promise<ModuleRolloutView> {
  assertSuperAdmin(user);
  return withSystem(async (db) => {
    // Client workspaces only: the services refuse an agency workspace, and an archived one is closed.
    const orgs = (await db.query<{ id: string; name: string; status: string }>(
      "select id, name, status from organizations where kind = 'client' and status <> 'archived' order by lower(name), id limit $1", [LIST_LIMIT + 1],
    )).rows;
    const truncated = orgs.length > LIST_LIMIT;
    const shown = orgs.slice(0, LIST_LIMIT);
    const ids = shown.map((o) => o.id);
    const features = ids.length
      ? (await db.query<{ org_id: string; feature: string; enabled: boolean; updated_at: Date; by_name: string | null }>(
          `select f.org_id, f.feature, f.enabled, f.updated_at, u.full_name as by_name
           from org_features f left join users u on u.id = f.updated_by
           where f.org_id = any($1::uuid[]) and f.feature = any($2::text[])`,
          [ids, Object.values(FEATURE_OF)],
        )).rows
      : [];
    const connections = ids.length
      ? (await db.query<{ id: string; signing: number; payments: number; reviews: number }>(
          `select o.id,
             (select count(*)::int from esign_connections c where c.org_id = o.id and c.status = 'connected') as signing,
             (select count(*)::int from customer_payment_connections c where c.org_id = o.id and c.status = 'connected') as payments,
             (select count(*)::int from review_connections c where c.org_id = o.id and c.status = 'connected') as reviews
           from organizations o where o.id = any($1::uuid[])`,
          [ids],
        )).rows
      : [];
    const keyOf = new Map(MODULE_KEYS.map((k) => [FEATURE_OF[k], k]));
    const rows: ModuleRolloutRow[] = shown.map((o) => ({ orgId: o.id, name: o.name, status: o.status, modules: emptyState(), connections: { signing: 0, payments: 0, reviews: 0 } }));
    const byId = new Map(rows.map((r) => [r.orgId, r]));
    for (const f of features) {
      const key = keyOf.get(f.feature);
      const row = byId.get(f.org_id);
      if (key && row && f.enabled === true) row.modules[key] = { on: true, since: new Date(f.updated_at).toISOString(), byName: f.by_name };
    }
    for (const c of connections) {
      const row = byId.get(c.id);
      if (row) row.connections = { signing: c.signing, payments: c.payments, reviews: c.reviews };
    }
    return { rows, truncated, env: envStates() };
  });
}

/** Whether each module is on in one workspace right now, and whether the workspace is one a module can be switched on for. */
async function currentState(orgId: string): Promise<{ kind: string; on: Record<ModuleKey, boolean> } | null> {
  return withSystem(async (db) => {
    const org = (await db.query<{ kind: string }>("select kind from organizations where id = $1", [orgId])).rows[0];
    if (!org) return null;
    const rows = (await db.query<{ feature: string; enabled: boolean }>("select feature, enabled from org_features where org_id = $1 and feature = any($2::text[])", [orgId, Object.values(FEATURE_OF)])).rows;
    const on = Object.fromEntries(MODULE_KEYS.map((k) => [k, rows.some((r) => r.feature === FEATURE_OF[k] && r.enabled === true)])) as Record<ModuleKey, boolean>;
    return { kind: org.kind, on };
  });
}

/**
 * Switches one module on or off for one client workspace. The change must be confirmed, the key must be one of the six, and a module that works on another (signing on
 * proposals) is refused until the other is in the right state. Asking for the state a module is already in writes nothing. The module's own service makes the change, checks
 * the Super Admin again and records who did it. (Two people changing proposals and signing at the same moment could each pass the check; signing still needs both switches
 * to do anything, so the worst case is a signing switch with no proposals switch, which does nothing.)
 */
export async function setModuleSwitch(user: SessionUser, input: { orgId: string; key: string; enabled: boolean; confirmed: boolean }): Promise<ModuleSwitchResult> {
  assertSuperAdmin(user);
  if (!isModuleKey(input.key)) throw new AppError("invalid_input", "That is not a module a workspace can be switched on for.");
  if (input.confirmed !== true) throw new AppError("invalid_input", "Confirm the change first.");
  const key = input.key;
  const enabled = input.enabled === true;
  if (typeof input.orgId !== "string" || !UUID.test(input.orgId)) throw new AppError("not_found", "That workspace was not found.");
  const state = await currentState(input.orgId);
  if (!state) throw new AppError("not_found", "That workspace was not found.");
  if (state.kind !== "client") throw new AppError("invalid_input", "Modules are switched on for client workspaces only.");
  if (state.on[key] === enabled) return { orgId: input.orgId, key, enabled, changed: false };
  const problem = dependencyProblem(key, enabled, state.on);
  if (problem) throw new AppError("invalid_input", problem);
  switch (key) {
    case "proposals":
    case "esign":
      await setOrgFeature(user, { orgId: input.orgId, feature: FEATURE_OF[key], enabled });
      break;
    case "invoices":
      await setInvoicesEnabled(user, input.orgId, enabled);
      break;
    case "reputation_surveys":
      await setSurveysEnabled(user, input.orgId, enabled);
      break;
    case "reputation_batches":
      await setBatchesEnabled(user, input.orgId, enabled);
      break;
    case "reputation_reviews":
      await setExternalReviewsEnabled(user, input.orgId, enabled);
      break;
  }
  return { orgId: input.orgId, key, enabled, changed: true };
}
