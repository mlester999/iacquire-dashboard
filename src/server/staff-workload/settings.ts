import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { DEFAULT_RULES, changedPaths, describeRules, normalizeRules, overridesOf, STAFF_WORKLOAD_FEATURE, type WorkloadRules } from "@/lib/staff-workload/rules";
import { loadSuperAdminStanding, loadWorkloadActor, requireWorkloadCap, throttle, type StaffUser } from "@/server/staff-workload/access";

// Staff workload is dormant until a Super Admin switches it on for the agency workspace (org_features, feature "staff_workload"; no row means off). Switching it on connects
// nothing and sends nothing: the snapshot job still runs only when the scheduler does. Switching it off hides the screens and refuses every request; it deletes nothing.
//
// The rules (point weights, label thresholds, floors, the horizon, the team default capacity and the project-health limits) are PROPOSALS in code (src/lib/staff-workload/rules.ts).
// The one settings row holds only what a Super Admin changed from them, so a number nobody changed follows the code if the code is corrected.

export async function staffWorkloadEnabled(db?: Queryable): Promise<boolean> {
  const run = (q: Queryable) =>
    q.query<{ enabled: boolean }>(
      `select exists (select 1 from org_features f join organizations o on o.id = f.org_id where o.kind = 'agency' and f.feature = $1 and f.enabled) as enabled`,
      [STAFF_WORKLOAD_FEATURE],
    );
  const { rows } = db ? await run(db) : await withSystem(run);
  return rows[0]?.enabled === true;
}

/** A Super Admin switches staff workload on or off. Audited. */
export async function setStaffWorkloadEnabled(user: StaffUser, enabled: boolean): Promise<void> {
  await withSystem(async (db) => {
    const who = await loadSuperAdminStanding(user, db);
    await db.query(
      `insert into org_features (org_id, feature, enabled, updated_by) values ($1, $2, $3, $4)
       on conflict (org_id, feature) do update set enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = now()`,
      [who.agencyOrgId, STAFF_WORKLOAD_FEATURE, enabled, user.id],
    );
    await recordAudit({ orgId: who.agencyOrgId, actorUserId: user.id, actorKind: "agency", action: enabled ? "staff_workload.enabled" : "staff_workload.disabled", targetType: "organization", targetId: who.agencyOrgId, result: "success" }, db);
  });
}

export interface RulesInForce {
  rules: WorkloadRules;
  /** 0 until a Super Admin first changes anything. */
  revision: number;
  /** Only what differs from the defaults in code. */
  overrides: Record<string, unknown>;
  /** The stored overrides could not be read as valid rules (the code changed since they were saved): the defaults are in force and this says why. Empty when all is well. */
  problems: string[];
  updatedAt: string | null;
}

/** The rules in force. Never throws on stored data: a bad stored value falls back to the defaults and says so, so a job keeps working. */
export async function loadRules(db?: Queryable): Promise<RulesInForce> {
  const run = (q: Queryable) =>
    q.query<{ rules: unknown; revision: number; updated_at: Date }>("select s.rules, s.revision, s.updated_at from staff_workload_settings s join organizations o on o.id = s.org_id where o.kind = 'agency'");
  const { rows } = db ? await run(db) : await withSystem(run);
  const row = rows[0];
  if (!row) return { rules: DEFAULT_RULES, revision: 0, overrides: {}, problems: [], updatedAt: null };
  const checked = normalizeRules(row.rules);
  if (!checked.ok) {
    return { rules: DEFAULT_RULES, revision: row.revision, overrides: {}, problems: checked.errors.map((e) => e.message), updatedAt: new Date(row.updated_at).toISOString() };
  }
  return { rules: checked.rules, revision: row.revision, overrides: overridesOf(checked.rules), problems: [], updatedAt: new Date(row.updated_at).toISOString() };
}

/** The Rules panel: every number in force, grouped, with the ones changed marked, and the revision a form must send back to save. Anyone who may use the module can read it. */
export async function describeRulesForUser(user: StaffUser) {
  await loadWorkloadActor(user);
  const now = await loadRules();
  return { groups: describeRules(now.rules), revision: now.revision, problems: now.problems };
}

export interface SaveRulesResult {
  revision: number;
  changed: string[];
}

/**
 * A Super Admin saves the rules. `input` is the whole set of rules or only the ones to change; it is checked as a whole (an unknown rule, a number out of range or labels out
 * of order refuse everything with a message), and only what differs from the defaults in code is stored. `expectedRevision` is the revision the form was opened on: if someone
 * saved in between, nothing is written and the person is told to reload. An empty object puts every rule back to its default. Audited with the names of the rules changed.
 */
export async function saveRules(user: StaffUser, input: unknown, expectedRevision: number): Promise<SaveRulesResult> {
  const actor = await requireWorkloadCap(user, "settings");
  await throttle("staffWorkloadManageByUser", user.id);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new AppError("invalid_input", "Reload the page and try again.");
  const checked = normalizeRules(input);
  if (!checked.ok) throw new AppError("invalid_input", checked.errors.map((e) => e.message).slice(0, 3).join(" "));
  const overrides = overridesOf(checked.rules);
  return withSystem(async (db) => {
    const current = await loadRules(db);
    const before = (await db.query<{ revision: number }>("select revision from staff_workload_settings where id for update")).rows[0];
    if ((before?.revision ?? 0) !== expectedRevision) throw new AppError("conflict", "The rules were changed by someone else while you were editing. Reload the page to see the current rules.");
    const changed = changedPaths(current.rules, checked.rules);
    if (!before) {
      await db.query("insert into staff_workload_settings (id, org_id, rules, updated_by) values (true, $1, $2::jsonb, $3)", [actor.agencyOrgId, JSON.stringify(overrides), user.id]);
    } else {
      await db.query("update staff_workload_settings set rules = $1::jsonb, revision = revision + 1, updated_by = $2 where id", [JSON.stringify(overrides), user.id]);
    }
    const revision = (before?.revision ?? 0) + 1;
    await recordAudit({
      orgId: actor.agencyOrgId, actorUserId: user.id, actorKind: "agency", action: "staff_workload.rules_changed", targetType: "organization", targetId: actor.agencyOrgId, result: "success",
      metadata: { revision, changed: changed.slice(0, 20), count: changed.length },
    }, db);
    return { revision, changed };
  });
}
