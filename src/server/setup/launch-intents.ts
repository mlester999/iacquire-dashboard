import "server-only";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import type { OrgContext } from "@/server/tenancy/context";
import { memberActor } from "@/server/crm/actor";
import { AGENT_BY_KEY, type AgentRoleKey } from "@/lib/agents";
import { PROVISIONING_PAYMENT_NOTE } from "@/lib/billing-clearance";
import type { LaunchIntent } from "@/lib/launch-readiness";
import { LAUNCH_VERIFICATION_CAPABILITY, launchVerificationInput, launchVerificationKey } from "@/lib/launch-verification";
import { capabilityDefinition } from "@/lib/workforce-capabilities";
import { activateCalendar, applyCalendarHoursTemplate } from "@/server/calendars/activation";
import { updateCalendar } from "@/server/calendars/setup";
import { dispatchCapabilityJob } from "@/server/workforce/capability-dispatch";
import { findLaunchCalendar, loadLaunchFacts } from "@/server/setup/launch-readiness";

// The buttons of the guided launch setup. Each one is a thing the client could already do in the CRM; here it is one click from the checklist that names it, runs the real
// service (which re-checks the person's permission and every rule itself), and says plainly what happened. None of them turns a public booking page on, sends a message, books
// anyone or contacts a provider. A host is only ever the person who pressed the button, and hours are only ever the ones the client's own answers suggested.

export interface LaunchIntentResult {
  /** The step did what it names. False: it could not yet, and `message` says why in the client's words. */
  ok: boolean;
  message: string;
  started?: AgentRoleKey[];
  skipped?: Array<{ role: AgentRoleKey; reason: string }>;
}

async function calendarOrThrow(orgId: string) {
  const cal = await withSystem((db) => findLaunchCalendar(db, orgId));
  if (!cal) throw new AppError("not_found", "There is no booking calendar yet. Open Calendars & Types to create one.");
  return cal;
}

export async function runLaunchIntent(ctx: OrgContext, intent: LaunchIntent): Promise<LaunchIntentResult> {
  if (ctx.org.kind !== "client") throw new AppError("forbidden", "Launch setup applies to a client workspace.");
  switch (intent) {
    case "assign_host": {
      const cal = await calendarOrThrow(ctx.org.orgId);
      const hosts = await withSystem(async (db) => Number((await db.query<{ n: string }>("select count(*) as n from crm_calendar_members where calendar_id = $1 and org_id = $2 and active", [cal.id, ctx.org.orgId])).rows[0]?.n ?? 0));
      if (hosts > 0) return { ok: true, message: "This calendar already has a host. Nothing was changed." };
      await updateCalendar(memberActor(ctx), cal.id, { members: [{ userId: ctx.user.id }] });
      return { ok: true, message: "You are now the host of this calendar. Next, approve the suggested weekly hours or set your own." };
    }
    case "apply_hours": {
      const cal = await calendarOrThrow(ctx.org.orgId);
      const res = await applyCalendarHoursTemplate(memberActor(ctx), cal.id);
      // A host who already works in another time zone is given nothing (the suggested hours would be read in the wrong zone), and this button cannot choose a zone for them. Say
      // so, instead of saying every host already has hours.
      const n = res.needsZoneChoice.length;
      const zoneNote = n
        ? `${n === 1 ? "One host already works" : `${n} hosts already work`} in a different time zone than the suggested hours, so their hours were not changed. Open Availability and set their weekly hours in their own time zone.`
        : "";
      if (res.applied.length) {
        return { ok: true, message: `Weekly hours saved for ${res.applied.length === 1 ? "your host" : `${res.applied.length} hosts`}. Change them any time in Availability.${zoneNote ? ` ${zoneNote}` : ""}` };
      }
      return n ? { ok: false, message: zoneNote } : { ok: true, message: "Every host already has weekly hours, so nothing was changed." };
    }
    case "activate_calendar": {
      const cal = await calendarOrThrow(ctx.org.orgId);
      const res = await activateCalendar(memberActor(ctx), cal.id);
      if (res.activated) return { ok: true, message: "The calendar is active. Its public booking page is still off until you turn it on yourself." };
      if (res.alreadyActive) return { ok: true, message: "The calendar was already active." };
      const failing = res.verification.checks.find((c) => !c.ok);
      return { ok: false, message: failing ? failing.detail : "The calendar did not pass its checks yet." };
    }
    case "run_checks":
      return startLaunchVerification(ctx);
  }
}

/**
 * Starts the read-only final check of each employee that is ready for authorized work and has no current passing check. One job per employee and configuration version: pressing
 * the button again while a check runs reuses it, a check that finished for this version can be run again as a new job, and a passing check for the current version is left alone.
 * An employee that is not ready yet is reported as skipped, never started.
 */
export async function startLaunchVerification(ctx: OrgContext): Promise<LaunchIntentResult> {
  const facts = await loadLaunchFacts(ctx);
  if (!facts) throw new AppError("forbidden", "Final checks apply to a client workspace.");
  if (!facts.submitted) throw new AppError("conflict", "Submit your company information first.");
  if (facts.paymentCleared === false) throw new AppError("conflict", PROVISIONING_PAYMENT_NOTE);
  const verification = new Map(facts.verification.map((v) => [v.role, v]));
  const started: AgentRoleKey[] = [];
  const skipped: Array<{ role: AgentRoleKey; reason: string }> = [];
  for (const e of facts.employees) {
    if (!e.entitled || (e.role === "appointment_setter" && facts.appointments.wanted === false)) continue;
    const name = AGENT_BY_KEY[e.role].shortName;
    if (!e.readiness.workReady) {
      skipped.push({ role: e.role, reason: `${name} is not ready for authorized work yet.` });
      continue;
    }
    const v = verification.get(e.role);
    if (v?.state === "running") {
      skipped.push({ role: e.role, reason: `${name}'s check is already running.` });
      continue;
    }
    if (v?.state === "passed" && v.configVersion === e.configVersion) continue;
    const round = await withSystem(async (db) => {
      const agent = (await db.query<{ id: string }>("select id from agent_instances where org_id = $1 and role_key = $2", [ctx.org.orgId, e.role])).rows[0];
      if (!agent) return 0;
      return Number((await db.query<{ n: string }>(
        `select count(*) as n from ai_work_jobs
          where org_id = $1 and agent_instance_id = $2 and input ->> 'launchVerification' = 'true'
            and coalesce(input ->> 'configVersion', '') = $3 and status in ('completed', 'failed', 'blocked', 'cancelled')`,
        [ctx.org.orgId, agent.id, e.configVersion === null ? "" : String(e.configVersion)],
      )).rows[0]?.n ?? 0);
    });
    const capability = LAUNCH_VERIFICATION_CAPABILITY[e.role];
    try {
      await dispatchCapabilityJob(ctx, {
        agentRole: e.role,
        capability,
        title: `Launch check: ${capabilityDefinition(capability)?.label ?? capability}`,
        input: launchVerificationInput(e.configVersion),
        idempotencyKey: launchVerificationKey({ orgId: ctx.org.orgId, role: e.role, configVersion: e.configVersion, round }),
      });
      started.push(e.role);
    } catch (err) {
      skipped.push({ role: e.role, reason: err instanceof AppError ? err.message : `${name}'s check could not be started.` });
    }
  }
  if (started.length) {
    await recordAudit({
      orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "setup.launch_checks_started", targetType: "organization", targetId: ctx.org.orgId, result: "success",
      metadata: { roles: started },
    });
  }
  const note = skipped.length ? ` ${skipped.map((s) => s.reason).join(" ")}` : "";
  if (!started.length) {
    return { ok: skipped.length === 0, message: skipped.length ? `No check was started.${note}` : "Every employee already has a passing check for its current configuration.", started, skipped };
  }
  return { ok: true, message: `Started ${started.length} read-only ${started.length === 1 ? "check" : "checks"} on your real records. They change nothing and send nothing.${note}`, started, skipped };
}
