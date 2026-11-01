import "server-only";
import { z } from "zod";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import type { OrgContext } from "@/server/tenancy/context";
import { assertCan, memberActor } from "@/server/crm/actor";
import { AGENT_BY_KEY, type AgentRoleKey } from "@/lib/agents";
import { PROVISIONING_PAYMENT_NOTE } from "@/lib/billing-clearance";
import type { LaunchIntent, LaunchIntentParams } from "@/lib/launch-readiness";
import { LAUNCH_VERIFICATION_CAPABILITY, launchVerificationInput, launchVerificationKey } from "@/lib/launch-verification";
import { capabilityDefinition } from "@/lib/workforce-capabilities";
import { activateCalendar, applyApprovedCalendarHours, assignHostIfNone } from "@/server/calendars/activation";
import { isSetupPaymentCleared } from "@/server/billing/clearance";
import { dispatchCapabilityJob } from "@/server/workforce/capability-dispatch";
import { findLaunchCalendar, loadLaunchFacts } from "@/server/setup/launch-readiness";
import { recordLaunchSnapshotAfter } from "@/server/setup/launch-ledger";

// The buttons of the guided launch setup. Each one is a thing the client could already do in the CRM; here it is one click from the checklist that names it, runs the real
// service (which re-checks the person's permission and every rule itself), and says plainly what happened. None of them turns a public booking page on, sends a message, books
// anyone or contacts a provider. A host is only ever a person the client chose (the one who pressed the button, or an active member picked from the list), and hours are only ever the
// ones the client's own answers suggested AND the client approved exactly as shown (a digest the server recomputes). The three calendar steps open only after the questionnaire is
// submitted and the setup payment is confirmed.

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

/**
 * The calendar steps are the client's own, and they open in order: the questionnaire is submitted, then the setup payment is confirmed. Before either, the step is refused and
 * nothing is changed. A sample workspace has no setup fee, so it is never held on one.
 */
async function assertCalendarStepsOpen(orgId: string) {
  const org = await withSystem(async (db) => {
    const row = (await db.query<{ submitted: boolean; is_demo: boolean }>("select onboarding_completed_at is not null as submitted, is_demo from organizations where id = $1", [orgId])).rows[0];
    return row ? { ...row, cleared: row.is_demo ? null : await isSetupPaymentCleared(db, orgId) } : null;
  });
  if (!org?.submitted) throw new AppError("conflict", "Submit your company information first.");
  if (org.cleared === false) throw new AppError("conflict", "The setup payment is not confirmed, so the calendar steps are not open yet.");
}

/** A person who may be made a host: an active member of this workspace with an active account. Another workspace's user, and someone who left, are "not found". */
async function hostCandidate(orgId: string, userId: string): Promise<{ id: string; name: string }> {
  if (!z.string().uuid().safeParse(userId).success) throw new AppError("invalid_input", "Choose a person from the list.");
  const row = (await withSystem((db) => db.query<{ name: string; status: string }>(
    `select coalesce(nullif(u.full_name, ''), u.email::text) as name, u.status
       from organization_memberships m join users u on u.id = m.user_id where m.org_id = $1 and m.user_id = $2 and m.status = 'active'`,
    [orgId, userId],
  ))).rows[0];
  if (!row) throw new AppError("not_found", "That person is not a member of this workspace.");
  if (row.status !== "active") throw new AppError("invalid_input", "That person's account is not active, so they cannot take appointments.");
  return { id: userId, name: row.name };
}

export async function runLaunchIntent(ctx: OrgContext, intent: LaunchIntent, params: LaunchIntentParams = {}): Promise<LaunchIntentResult> {
  const result = await runIntent(ctx, intent, params);
  // A step that ran may have moved the launch state: the ledger remembers it (and tells the owners of a moment that is theirs). A refused step threw above and records nothing.
  await recordLaunchSnapshotAfter(ctx.org.orgId, { kind: "user", userId: ctx.user.id }, `the ${intent} step`);
  return result;
}

async function runIntent(ctx: OrgContext, intent: LaunchIntent, params: LaunchIntentParams): Promise<LaunchIntentResult> {
  if (ctx.org.kind !== "client") throw new AppError("forbidden", "Launch setup applies to a client workspace.");
  if (intent !== "run_checks") {
    // Each calendar step re-checks the permission it needs again; this refuses first, before anything is read.
    assertCan(memberActor(ctx), "calendars.manage");
    await assertCalendarStepsOpen(ctx.org.orgId);
  }
  switch (intent) {
    case "assign_host": {
      const cal = await calendarOrThrow(ctx.org.orgId);
      // The host is the person chosen from the workspace's own members, or the person who pressed the button: never anyone the client did not pick.
      const host = await hostCandidate(ctx.org.orgId, params.userId ?? ctx.user.id);
      // One transaction with the calendar locked: the "no active host yet" check and the change are never apart, so a second press (or a host added in the meantime) is told the
      // calendar already has a host instead of replacing the first. The same host reading every other screen uses applies: a host who left or was suspended is not a host, and their
      // stale row is replaced. The audit row is written in that same transaction.
      const { assigned } = await assignHostIfNone(memberActor(ctx), cal.id, host.id, (db) => recordAudit({
        orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "setup.launch_host_chosen", targetType: "crm_calendar", targetId: cal.id, result: "success",
        metadata: { hostUserId: host.id, self: host.id === ctx.user.id, hours: "not_set" },
      }, db));
      if (!assigned) return { ok: true, message: "This calendar already has a host. Nothing was changed." };
      return host.id === ctx.user.id
        ? { ok: true, message: "You are now the host of this calendar. Next, approve the suggested weekly hours or set your own." }
        : { ok: true, message: `${host.name} is now the host of this calendar. They have no weekly hours yet, so approve the suggested hours or set theirs next.` };
    }
    case "apply_hours": {
      const cal = await calendarOrThrow(ctx.org.orgId);
      // Hours are written only for an approval of exactly what was shown: the server recomputes the digest of the hosts, hours and zone, and refuses anything else.
      const res = await applyApprovedCalendarHours(memberActor(ctx), cal.id, params.hoursDigest);
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
    // The Appointment Setter proves itself on a calendar that takes bookings, so its check waits for the client's calendar to be active.
    if (e.role === "appointment_setter" && facts.crm.mode === "native" && facts.appointments.calendar?.status !== "active") {
      skipped.push({ role: e.role, reason: `${name} waits until your booking calendar is active.` });
      continue;
    }
    const v = verification.get(e.role);
    if (v?.state === "running") {
      skipped.push({ role: e.role, reason: `${name}'s check is already running.` });
      continue;
    }
    // A check held for a person's approval is not started a second time either, and it is not running: it waits for that review (the panel says the same).
    if (v?.state === "awaiting_review") {
      skipped.push({ role: e.role, reason: `${name}'s check is waiting for iAcquire's review.` });
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
