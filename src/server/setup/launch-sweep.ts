import "server-only";
import { withSystem } from "@/server/db";
import { AGENT_BY_KEY, type AgentRoleKey } from "@/lib/agents";
import { LAUNCH_VERIFICATION_CAPABILITY, checkCoversInputs, launchVerificationInput, launchVerificationKey, verificationInputs } from "@/lib/launch-verification";
import { capabilityDefinition } from "@/lib/workforce-capabilities";
import { dispatchSystemCapabilityJob } from "@/server/workforce/capability-dispatch";
import { employeeInputsDigest, loadLaunchFactsForOrg } from "@/server/setup/launch-readiness";
import { recordLaunchSnapshotAfter } from "@/server/setup/launch-ledger";
import { env } from "@/server/env";

// The automatic half of the final checks. When an employee becomes ready for authorized work, or its configuration changes and it is ready again, nobody should have to press a button for
// it to prove itself: this starts the one read-only check for each such employee. It starts a check only where none exists yet for the employee's current configuration version, so it
// is quiet and cheap when there is nothing to do, it never retries a check that already ran and failed (the client fixes what it names and runs it again), and it can never start
// anything but the reviewed read-only capabilities. Two sweeps at once start one job per employee (the job key decides).
//
// A check is current for an employee when its newest check job ran for the configuration version the employee runs now AND, for a role whose check reads the client's own setup
// (appointment types and host hours, targeting, pipeline stages: src/lib/launch-verification.ts), for the setup as it is now. A change to what a check reads re-queues only the roles
// that read it; a knowledge edit queues nobody. A check recorded without a digest (an older job) stays current for its version.

export interface LaunchSweepResult {
  queued: AgentRoleKey[];
}

/**
 * Employees of a submitted client workspace with an applied configuration whose newest final check does not cover it: none yet, one for an older version, or one that read other
 * setup than the client has now. One cheap query for the employees, and a few small reads of the setup only for a role whose check reads it and has a digest to compare.
 */
async function dueRoles(orgId: string): Promise<AgentRoleKey[]> {
  const { rows } = await withSystem((db) => db.query<{ role_key: AgentRoleKey; version: string; found: boolean | null; config_version: string | null; inputs_digest: string | null }>(
    `select a.role_key, v.version::text as version, lj.found, lj.config_version, lj.inputs_digest
       from agent_instances a
       join organizations o on o.id = a.org_id
       join agent_config_versions v on v.id = a.active_config_version_id and v.org_id = a.org_id
       left join lateral (
         select true as found, j.input ->> 'configVersion' as config_version, j.input ->> 'inputsDigest' as inputs_digest
           from ai_work_jobs j
          where j.org_id = a.org_id and j.agent_instance_id = a.id and j.input ->> 'launchVerification' = 'true'
          order by j.created_at desc limit 1) lj on true
      where a.org_id = $1 and o.kind = 'client' and not o.is_demo and o.status = 'active' and o.onboarding_completed_at is not null
        and a.enabled and a.last_health_ok is true`,
    [orgId],
  ));
  const due: AgentRoleKey[] = [];
  for (const r of rows) {
    if (!r.found || r.config_version !== r.version) {
      due.push(r.role_key);
      continue;
    }
    // Same configuration: only a check that carries a digest of the setup it read can be out of date, and only for a role that reads some.
    if (r.inputs_digest && verificationInputs(r.role_key).length) {
      const current = await withSystem((db) => employeeInputsDigest(db, orgId, r.role_key));
      if (!checkCoversInputs(r.inputs_digest, current)) due.push(r.role_key);
    }
  }
  return due;
}

/**
 * How many checks already finished for this employee, configuration version and setup digest. It is the `round` of the job key: a check that failed can be run again as a new job,
 * and a double click on one that is still running reuses it. Without a digest it counts the checks of that version recorded without one, as it always did.
 */
export async function finishedCheckRound(orgId: string, role: AgentRoleKey, configVersion: number | null, inputsDigest: string | null): Promise<number> {
  return withSystem(async (db) => {
    const agent = (await db.query<{ id: string }>("select id from agent_instances where org_id = $1 and role_key = $2", [orgId, role])).rows[0];
    if (!agent) return 0;
    return Number((await db.query<{ n: string }>(
      `select count(*) as n from ai_work_jobs
        where org_id = $1 and agent_instance_id = $2 and input ->> 'launchVerification' = 'true'
          and coalesce(input ->> 'configVersion', '') = $3 and coalesce(input ->> 'inputsDigest', '') = $4
          and status in ('completed', 'failed', 'blocked', 'cancelled')`,
      [orgId, agent.id, configVersion === null ? "" : String(configVersion), inputsDigest ?? ""],
    )).rows[0]?.n ?? 0);
  });
}

/** The accountable person for work started by setup itself: the workspace's owner who can be reached (active, with a verified email), the same person provisioning is requested for. */
async function accountableOwner(orgId: string): Promise<string | null> {
  const { rows } = await withSystem((db) => db.query<{ user_id: string }>(
    `select m.user_id from organization_memberships m join users u on u.id = m.user_id
      where m.org_id = $1 and m.role = 'owner' and m.status = 'active' and u.status = 'active' and u.email_verified_at is not null
      order by m.created_at, m.user_id limit 1`,
    [orgId],
  ));
  return rows[0]?.user_id ?? null;
}

/**
 * Whether the automatic checks may start for this workspace: only when LAUNCH_AUTOMATION_SINCE is set and the workspace's onboarding finished on or after it. A client that was already
 * using the product before the checks existed is never started on by itself; it can still press the panel's own button.
 */
export async function inAutomationScope(orgId: string): Promise<boolean> {
  const since = env().LAUNCH_AUTOMATION_SINCE;
  if (!since) return false;
  const row = (await withSystem((db) => db.query<{ ok: boolean | null }>("select onboarding_completed_at >= $2::timestamptz as ok from organizations where id = $1", [orgId, new Date(since).toISOString()]))).rows[0];
  return row?.ok === true;
}

export async function sweepLaunchVerification(orgId: string): Promise<LaunchSweepResult> {
  if (!(await inAutomationScope(orgId))) return { queued: [] };
  const due = await dueRoles(orgId);
  if (!due.length) return { queued: [] };
  const facts = await loadLaunchFactsForOrg(orgId);
  if (!facts || !facts.submitted || facts.paymentCleared === false) return { queued: [] };
  // Without an owner who can be held accountable nothing starts by itself; the panel's own button still works for any member who may start AI work.
  const owner = await accountableOwner(orgId);
  if (!owner) return { queued: [] };
  const queued: AgentRoleKey[] = [];
  for (const e of facts.employees) {
    if (!due.includes(e.role) || !e.entitled || !e.readiness.workReady) continue;
    if (e.role === "appointment_setter" && facts.appointments.wanted === false) continue;
    const capability = LAUNCH_VERIFICATION_CAPABILITY[e.role];
    const inputsDigest = e.inputsDigest ?? null;
    try {
      const job = await dispatchSystemCapabilityJob({
        orgId,
        onBehalfOf: owner,
        agentRole: e.role,
        capability,
        title: `Launch check: ${capabilityDefinition(capability)?.label ?? AGENT_BY_KEY[e.role].shortName}`,
        input: launchVerificationInput(e.configVersion, inputsDigest),
        idempotencyKey: launchVerificationKey({ orgId, role: e.role, configVersion: e.configVersion, inputsDigest, round: await finishedCheckRound(orgId, e.role, e.configVersion, inputsDigest) }),
      });
      if (job.created) queued.push(e.role);
    } catch {
      // An employee that cannot take work right now (paused, mid-change) is picked up by the next sweep; the panel still shows its check as not run.
    }
  }
  return { queued };
}

/**
 * The sweep as an event hook: called after something committed that can make an employee ready (a passing health check, a calendar or CRM becoming active). It never fails the
 * action that called it. The sweep is loaded on demand so the services that call this do not import the setup module at load. When it has run, the launch ledger remembers the
 * state the event left (a caller that records the state itself afterwards passes `record: false`).
 */
export async function sweepLaunchVerificationAfter(orgId: string, after: string, opts: { record?: boolean } = {}): Promise<void> {
  try {
    await sweepLaunchVerification(orgId);
  } catch (err) {
    console.warn(`[iacquire] launch check sweep after ${after} failed; the next event will retry.`, { error: err instanceof Error ? err.name : "unknown" });
  }
  if (opts.record !== false) await recordLaunchSnapshotAfter(orgId, { kind: "system" }, after);
}
