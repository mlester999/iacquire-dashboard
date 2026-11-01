import "server-only";
import { withSystem } from "@/server/db";
import { AGENT_BY_KEY, type AgentRoleKey } from "@/lib/agents";
import { LAUNCH_VERIFICATION_CAPABILITY, launchVerificationInput, launchVerificationKey } from "@/lib/launch-verification";
import { capabilityDefinition } from "@/lib/workforce-capabilities";
import { dispatchSystemCapabilityJob } from "@/server/workforce/capability-dispatch";
import { loadLaunchFactsForOrg } from "@/server/setup/launch-readiness";

// The automatic half of the final checks. When an employee becomes ready for authorized work, or its configuration changes and it is ready again, nobody should have to press a button for
// it to prove itself: this starts the one read-only check for each such employee. It starts a check only where none exists yet for the employee's current configuration version, so it
// is quiet and cheap when there is nothing to do, it never retries a check that already ran and failed (the client fixes what it names and runs it again), and it can never start
// anything but the reviewed read-only capabilities. Two sweeps at once start one job per employee (the job key decides).

export interface LaunchSweepResult {
  queued: AgentRoleKey[];
}

/** Employees of a submitted client workspace with an applied configuration but no final check for that exact version. One cheap query; most sweeps end here. */
async function dueRoles(orgId: string): Promise<AgentRoleKey[]> {
  const { rows } = await withSystem((db) => db.query<{ role_key: AgentRoleKey }>(
    `select a.role_key
       from agent_instances a
       join organizations o on o.id = a.org_id
       join agent_config_versions v on v.id = a.active_config_version_id and v.org_id = a.org_id
      where a.org_id = $1 and o.kind = 'client' and not o.is_demo and o.status = 'active' and o.onboarding_completed_at is not null
        and a.enabled and a.last_health_ok is true
        and not exists (
          select 1 from ai_work_jobs j
           where j.org_id = a.org_id and j.agent_instance_id = a.id and j.input ->> 'launchVerification' = 'true' and j.input ->> 'configVersion' = v.version::text)`,
    [orgId],
  ));
  return rows.map((r) => r.role_key);
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

export async function sweepLaunchVerification(orgId: string): Promise<LaunchSweepResult> {
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
    try {
      const job = await dispatchSystemCapabilityJob({
        orgId,
        onBehalfOf: owner,
        agentRole: e.role,
        capability,
        title: `Launch check: ${capabilityDefinition(capability)?.label ?? AGENT_BY_KEY[e.role].shortName}`,
        input: launchVerificationInput(e.configVersion),
        idempotencyKey: launchVerificationKey({ orgId, role: e.role, configVersion: e.configVersion, round: 0 }),
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
 * action that called it. The sweep is loaded on demand so the services that call this do not import the setup module at load.
 */
export async function sweepLaunchVerificationAfter(orgId: string, after: string): Promise<void> {
  try {
    await sweepLaunchVerification(orgId);
  } catch (err) {
    console.warn(`[iacquire] launch check sweep after ${after} failed; the next event will retry.`, { error: err instanceof Error ? err.name : "unknown" });
  }
}
