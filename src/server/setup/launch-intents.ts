import "server-only";
import { z } from "zod";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import type { OrgContext } from "@/server/tenancy/context";
import { assertCan, memberActor } from "@/server/crm/actor";
import { AGENT_BY_KEY, AI_GROWTH_PARTNER_ROLE_KEY, isAgentRoleKey, workforceRoleShortName, type AgentRoleKey, type WorkforceRoleKey } from "@/lib/agents";
import { PROVISIONING_PAYMENT_NOTE } from "@/lib/billing-clearance";
import { grantableRoles } from "@/lib/permissions";
import { confirmedAnswers, planScope, toLegacyData } from "@/lib/onboarding/engine";
import type { LaunchIntent, LaunchIntentParams } from "@/lib/launch-readiness";
import { LAUNCH_VERIFICATION_CAPABILITY, checkCoversInputs, launchVerificationInput, launchVerificationKey } from "@/lib/launch-verification";
import { capabilityDefinition } from "@/lib/workforce-capabilities";
import { activateCalendar, applyApprovedCalendarHours, assignHostIfNone } from "@/server/calendars/activation";
import { isSetupPaymentCleared } from "@/server/billing/clearance";
import { createInvitation, deliverInvitation, recordInvitationDelivery } from "@/server/auth/service";
import type { OutgoingEmail } from "@/server/email";
import { loadAnswerRows, toStored } from "@/server/onboarding/answers";
import { approvedAnswersOf, readPendingAnswerChanges } from "@/server/onboarding/pending-changes";
import { employeeSyncState, syncEmployeesFromAnswers, type GeneratedEmployee } from "@/server/onboarding/employee-sync";
import { lockOnboardingRow } from "@/server/onboarding/profile-sync";
import { requestProvisioning } from "@/server/workforce/provisioning";
import { applyPipelineStagesFromAnswers, confirmRegionDefaults } from "@/server/onboarding/workspace-drafts";
import { provisionClientCrm } from "@/server/onboarding/crm-provisioning";
import { dispatchCapabilityJob } from "@/server/workforce/capability-dispatch";
import { findLaunchCalendar, listedTeamOf, loadLaunchFacts, teamInviteState } from "@/server/setup/launch-readiness";
import { finishedCheckRound } from "@/server/setup/launch-sweep";
import { recordLaunchSnapshotAfter } from "@/server/setup/launch-ledger";

// The buttons of the guided launch setup. Each one is a thing the client could already do in the CRM; here it is one click from the checklist that names it, runs the real
// service (which re-checks the person's permission and every rule itself), and says plainly what happened. None of them turns a public booking page on, sends a message, books
// anyone or contacts a provider. A host is only ever a person the client chose (the one who pressed the button, or an active member picked from the list), and hours are only ever the
// ones the client's own answers suggested AND the client approved exactly as shown (a digest the server recomputes). The three calendar steps open only after the questionnaire is
// submitted and the setup payment is confirmed.
//
// One more step brings the AI team up to what the client already approved ("sync_employees"): it writes new attributed versions of the employees that fell behind through the same
// per-employee build a questionnaire submission uses, so a change that needs review still waits for it, nothing the client wrote in an employee's settings is overwritten, and nothing
// customer-facing is switched on.
//
// Four more steps are the client's own decisions about their workspace, and each one is a button a person presses, never something that runs by itself: inviting the team they listed
// (an email to each new person, only to an address they typed, never to someone who is already a member or already invited), confirming the currency and phone country that go with
// their time zone, adding their own sales steps as a pipeline, and asking the automatic CRM setup to run again. Each one asks for the permission its service needs before anything is
// read, refuses a sample workspace, and writes nothing when it is refused. None of them turns a customer-facing switch on.

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
 * The setup steps are the client's own, and they open in order: the questionnaire is submitted, then (for the steps that change the workspace's CRM or calendar) the setup payment is
 * confirmed. Before either, the step is refused and nothing is changed. A sample workspace has no setup fee, so it is never held on one.
 */
async function assertStepsOpen(orgId: string, what: string, needsPayment = true) {
  const org = await withSystem(async (db) => {
    const row = (await db.query<{ submitted: boolean; is_demo: boolean }>("select onboarding_completed_at is not null as submitted, is_demo from organizations where id = $1", [orgId])).rows[0];
    return row ? { ...row, cleared: row.is_demo ? null : await isSetupPaymentCleared(db, orgId) } : null;
  });
  if (!org?.submitted) throw new AppError("conflict", "Submit your company information first.");
  if (needsPayment && org.cleared === false) throw new AppError("conflict", `The setup payment is not confirmed, so the ${what} steps are not open yet.`);
}

const assertCalendarStepsOpen = (orgId: string) => assertStepsOpen(orgId, "calendar");

/** The four steps that act on the client's own workspace for their own reasons are not for a sample workspace: nothing here may reach a real inbox or a real record from one. */
function assertRealWorkspace(ctx: OrgContext) {
  if (ctx.org.isDemo) throw new AppError("forbidden", "A sample workspace cannot do this.");
}

/** What the client saved after their last approval is not what the workspace runs on, so a step that reads their answers waits until they approve it. */
async function assertNothingWaitingApproval(orgId: string) {
  const change = await withSystem((db) => readPendingAnswerChanges(db, orgId));
  if (change.pending) throw new AppError("conflict", "You changed your company setup and have not approved it yet. Approve your changes first, then try this again.");
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
  if (intent === "assign_host" || intent === "apply_hours" || intent === "activate_calendar") {
    // Each calendar step re-checks the permission it needs again; this refuses first, before anything is read.
    assertCan(memberActor(ctx), "calendars.manage");
    await assertCalendarStepsOpen(ctx.org.orgId);
  }
  switch (intent) {
    case "sync_employees":
      return syncEmployees(ctx);
    case "send_team_invitations":
      return sendTeamInvitations(ctx);
    case "confirm_region_defaults":
      return confirmRegion(ctx);
    case "apply_pipeline_stages":
      return applyPipelineStages(ctx);
    case "retry_crm_setup":
      return retryCrmSetup(ctx);
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
 * Brings the employees that are behind the client's approved answers up to date: for each one, a new version built from the approved answers by the shared per-employee build
 * (employee-sync.ts), attributed to the person who pressed the button. Under the questionnaire's own lock, with the sync state read again inside it, so two presses make one version
 * per employee and a submission cannot interleave. A version that needs a person's review is created and held, and the message says so: it is never reported as applied. It refuses
 * while the client has edits nobody approved (those answers are not what the workspace runs on), for a sample workspace and before the questionnaire and the setup payment.
 */
async function syncEmployees(ctx: OrgContext): Promise<LaunchIntentResult> {
  const orgId = ctx.org.orgId;
  if (!ctx.can("workspace.manage_profile")) throw new AppError("forbidden", "Only an owner or admin can update the AI setup from your approved company information.");
  assertRealWorkspace(ctx);
  await assertStepsOpen(orgId, "setup");
  await assertNothingWaitingApproval(orgId);
  const who = { orgId, userId: ctx.user.id, actorKind: ctx.user.platformRole !== "none" ? "agency" as const : "user" as const };
  const result = await withSystem(async (db) => {
    await lockOnboardingRow(db, orgId);
    const rows = await loadAnswerRows(db, orgId);
    // Read again under the lock: an approval that was withdrawn, or an employee another press already updated, is respected.
    if ((await readPendingAnswerChanges(db, orgId, rows)).pending) throw new AppError("conflict", "You changed your company setup and have not approved it yet. Approve your changes first, then try this again.");
    const enabledRoleKeys = (await db.query<{ role_key: string }>(
      "select a.role_key from agent_instances a join agent_roles r on r.key = a.role_key where a.org_id = $1 and a.enabled order by r.sort_order", [orgId],
    )).rows.map((r) => r.role_key);
    const roles = enabledRoleKeys.filter(isAgentRoleKey);
    const partnerEnabled = enabledRoleKeys.includes(AI_GROWTH_PARTNER_ROLE_KEY);
    const partnerOnly = enabledRoleKeys.length === 1 && partnerEnabled;
    const behind = (await employeeSyncState(db, orgId)).filter((r) => r.state === "behind").map((r) => r.role);
    if (!behind.length && !partnerEnabled) return { behind, generated: [] as GeneratedEmployee[], partnerOnly };
    const data = toLegacyData(confirmedAnswers(toStored(rows), planScope(roles)), roles);
    const hadNoConfig = new Set((await db.query<{ role_key: string }>(
      "select role_key from agent_instances where org_id = $1 and enabled and active_config_version_id is null", [orgId],
    )).rows.map((r) => r.role_key));
    const generated = await syncEmployeesFromAnswers(db, who, { data, selected: behind, basis: { firstSubmission: false, generated: null } });
    // An employee that just got its first configuration is queued for its profile like the submission queues one (idempotent, and still waits for the setup payment).
    if (generated.some((g) => hadNoConfig.has(g.role) && g.configStatus === "applied") && !ctx.org.isDemo && ctx.user.emailVerified) await requestProvisioning(db, orgId, ctx.user.id);
    const group = (status: (s: string) => boolean) => generated.filter((g) => status(g.configStatus)).map((g) => g.role);
    await recordAudit({
      orgId, actorUserId: ctx.user.id, actorKind: "user", action: "setup.launch_employees_synced", targetType: "organization", targetId: orgId, result: "success",
      metadata: { updated: group((s) => s === "applied"), held: group((s) => s === "pending_agency_review"), unchanged: group((s) => s === "unchanged") },
    }, db);
    return { behind, generated, partnerOnly };
  });
  if (!result.generated.length) return { ok: true, message: result.partnerOnly
    ? "Your AI Growth Partner already matches your approved setup. Nothing was changed."
    : "Your active AI setup already matches your approved company information. Nothing was changed." };
  const names = (roles: WorkforceRoleKey[]) => roles.map(workforceRoleShortName).join(", ");
  const updated = result.generated.filter((g) => g.configStatus === "applied").map((g) => g.role);
  const held = result.generated.filter((g) => g.configStatus === "pending_agency_review").map((g) => g.role);
  const parts = [
    updated.length ? result.partnerOnly
      ? "Updated your AI Growth Partner to match your approved setup. Settings you changed directly were kept."
      : `Updated ${names(updated)} to your approved setup. Anything you wrote in their settings yourself was kept.` : null,
    held.length ? result.partnerOnly
      ? "A change to your AI Growth Partner needs iAcquire's review. The proposed configuration is saved and will not run until it is approved."
      : `${names(held)} ${held.length === 1 ? "has" : "have"} a change that needs iAcquire's review, so ${held.length === 1 ? "it was" : "they were"} saved and ${held.length === 1 ? "waits" : "wait"} for it. Nothing runs on it until it is approved.` : null,
    !updated.length && !held.length ? "Nothing needed changing after all." : null,
  ].filter((p): p is string => p !== null);
  return { ok: updated.length > 0 || (!held.length), message: parts.join(" ") };
}

const peopleWord = (n: number) => (n === 1 ? "1 person" : `${n} people`);

/**
 * Invites the people the client listed as talking to customers, because the person pressed the button. The list is the team answer as last approved (the same one the panel counted
 * from), one invitation per new email. Someone who is already a member, and someone whose invitation is still open, is skipped: pressing it again sends nothing. All the new invitations
 * are made in one transaction under a lock of its own, so two presses at once cannot invite the same address twice; the emails go out after it commits, and each one's real outcome is
 * recorded and told (an email that could not be sent is said to be unsent, and can be resent from Team settings).
 */
async function sendTeamInvitations(ctx: OrgContext): Promise<LaunchIntentResult> {
  const orgId = ctx.org.orgId;
  // The same permission as Team settings: first, before anything is read.
  if (!ctx.can("team.manage")) throw new AppError("forbidden", "Only owners and admins can invite teammates.");
  assertRealWorkspace(ctx);
  await assertStepsOpen(orgId, "team", false);
  const answers = await withSystem(async (db) => {
    const rows = await loadAnswerRows(db, orgId);
    const change = await readPendingAnswerChanges(db, orgId, rows);
    return change.pending ? approvedAnswersOf(rows, change) : confirmedAnswers(toStored(rows));
  });
  const listed = listedTeamOf(answers);
  if (!listed.length) return { ok: false, message: "You have not listed anyone in your team answer, so there is nobody to invite. Add people in your company setup, and approve it." };
  const allowedRoles = grantableRoles(ctx.role);

  const made = await withSystem(async (db) => {
    await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`launch-team:${orgId}`]);
    // Read again inside the lock: a member who joined, or an invitation sent from Team settings, since the page was read is respected.
    const state = await teamInviteState(db, orgId, listed.map((p) => p.email));
    const created: Array<{ name: string; invitationId: string; message: OutgoingEmail }> = [];
    const skipped = { members: 0, invited: 0, notAllowed: 0 };
    for (const person of listed) {
      if (state.members.has(person.email)) { skipped.members += 1; continue; }
      if (state.pending.has(person.email)) { skipped.invited += 1; continue; }
      if (!allowedRoles.includes(person.role)) { skipped.notAllowed += 1; continue; }
      const invite = await createInvitation({ orgId, email: person.email, role: person.role, invitedBy: ctx.user.id }, db);
      await recordAudit({
        orgId, actorUserId: ctx.user.id, actorKind: "user", action: "team.invited", targetType: "invitation", targetId: invite.id, result: "success", metadata: { role: person.role, via: "launch_setup" },
      }, db);
      created.push({ name: person.name, invitationId: invite.id, message: invite.message });
    }
    return { created, skipped };
  });

  const outcome = { sent: 0, waiting: 0, failed: 0 };
  for (const invite of made.created) {
    const delivery = await deliverInvitation(invite.message);
    await recordInvitationDelivery(invite.invitationId, delivery);
    if (delivery.status === "sent") outcome.sent += 1;
    else if (delivery.status === "failed") outcome.failed += 1;
    else outcome.waiting += 1;
  }
  const notes = [
    made.skipped.members ? `${peopleWord(made.skipped.members)} already on your team` : null,
    made.skipped.invited ? `${peopleWord(made.skipped.invited)} already ${made.skipped.invited === 1 ? "has" : "have"} an invitation waiting` : null,
    made.skipped.notAllowed ? `${peopleWord(made.skipped.notAllowed)} could not be invited with a role your access cannot grant` : null,
  ].filter((n): n is string => n !== null);
  const skippedNote = notes.length ? ` Not invited: ${notes.join("; ")}.` : "";
  if (!made.created.length) return { ok: made.skipped.notAllowed === 0, message: `Nobody new to invite, so nothing was sent.${skippedNote}` };
  const delivery = [
    outcome.sent ? `${outcome.sent} emailed` : null,
    outcome.waiting ? `${outcome.waiting} waiting in the email queue` : null,
    outcome.failed ? `${outcome.failed} could not be emailed (resend ${outcome.failed === 1 ? "it" : "them"} from Team settings)` : null,
  ].filter((n): n is string => n !== null).join(", ");
  return { ok: outcome.failed === 0, message: `Created ${made.created.length === 1 ? "1 invitation" : `${made.created.length} invitations`}: ${delivery}.${skippedNote}` };
}

/** Confirms the currency and phone country that go with the workspace's time zone, because the person chose to. The CRM's own settings service validates, writes and audits it. */
async function confirmRegion(ctx: OrgContext): Promise<LaunchIntentResult> {
  if (!ctx.can("workspace.manage_profile") && !ctx.can("crm.provider.manage")) throw new AppError("forbidden", "Only an owner or admin can change the workspace's currency and phone country.");
  assertRealWorkspace(ctx);
  await assertStepsOpen(ctx.org.orgId, "setup");
  await assertNothingWaitingApproval(ctx.org.orgId);
  const res = await confirmRegionDefaults(ctx);
  if (res.state === "applied") return { ok: true, message: `Your workspace now uses ${res.defaults.currency} and +${res.defaults.callingCode}. Change them any time in your CRM settings.` };
  if (res.state === "unchanged") return { ok: true, message: "Your workspace already uses these values. Nothing was changed." };
  if (res.reason === "no_suggestion") return { ok: false, message: "Your time zone does not point to one country, so there is nothing to suggest. Set the currency and phone country in your CRM settings." };
  if (res.reason === "edited") return { ok: false, message: "The currency or phone country was already set by someone, so it was left alone." };
  return { ok: false, message: "There are already deals, proposals or invoices in your current currency, so it was not changed." };
}

/** Adds the client's own sales steps as a new pipeline, because the person chose to. It only ever adds: no existing pipeline or stage is edited or deleted. */
async function applyPipelineStages(ctx: OrgContext): Promise<LaunchIntentResult> {
  assertCan(memberActor(ctx), "pipelines.manage");
  assertRealWorkspace(ctx);
  await assertStepsOpen(ctx.org.orgId, "setup");
  await assertNothingWaitingApproval(ctx.org.orgId);
  const res = await applyPipelineStagesFromAnswers(ctx);
  if (res.state === "created") {
    return { ok: true, message: `Your sales steps are now a pipeline with ${res.stages} stages${res.madeDefault ? ", and it is your default pipeline" : ". Your existing pipeline is still your default"}. Nothing that was already there was changed.` };
  }
  if (res.state === "unchanged") return { ok: true, message: "Your sales steps are already in your CRM as a pipeline. Nothing was changed." };
  if (res.reason === "no_plan") return { ok: false, message: "Your sales process answer is not a clear list of steps, so no pipeline was made. List three to eight steps, one per line, in your company setup." };
  if (res.reason === "not_native") return { ok: false, message: "Your pipelines are kept in another system, so iAcquire does not add one here." };
  return { ok: false, message: "Your CRM already has the most pipelines it can hold, so none was added." };
}

/**
 * Asks the automatic industry CRM setup to run again. It is the same idempotent setup that runs after the payment: it acts under the agency person who created the workspace (never the
 * client's own identity), writes nothing if anything is unclear, and does nothing when a live application already exists. The person pressing it may only ask; what it did is read back
 * from what it returns.
 */
async function retryCrmSetup(ctx: OrgContext): Promise<LaunchIntentResult> {
  if (!ctx.can("workspace.manage_profile")) throw new AppError("forbidden", "Only an owner or admin can ask for the CRM setup to run again.");
  assertRealWorkspace(ctx);
  await assertStepsOpen(ctx.org.orgId, "setup");
  // The setup picks the industry starter and prefills values from the client's answers, and once it lands it is one-shot: it must not read an edit the client has not approved.
  await assertNothingWaitingApproval(ctx.org.orgId);
  const res = await provisionClientCrm(ctx.org.orgId, { trigger: "launch_retry" });
  switch (res.state) {
    case "applied":
      // Some sections can fail while the application still lands: say so, instead of claiming everything is in the CRM (the panel shows the same as partial).
      if (res.status === "partially_applied") return { ok: false, message: "Part of your industry setup was applied, and iAcquire reviews the rest. Nothing was sent to anyone." };
      return res.replayed
        ? { ok: true, message: "Your industry CRM was already set up. Nothing was changed." }
        : { ok: true, message: "Your industry CRM is set up: its pipeline, tags and fields are in your CRM now. Nothing was sent to anyone." };
    case "already_set_up":
      return { ok: false, message: "A setup for your industry was already applied here, or was undone by a person, so nothing was changed. iAcquire reviews it from here." };
    case "waiting_for_a_person":
      return { ok: false, message: "A person at iAcquire has to apply your industry setup. They have been told, and nothing was added to your CRM." };
    case "failed":
      return { ok: false, message: "The setup did not finish, and nothing was added. iAcquire has been told." };
    case "disabled":
      return { ok: false, message: "The automatic setup is switched off for now, so iAcquire sets up your CRM by hand." };
    default:
      return { ok: false, message: "The setup is not ready to run for your workspace yet, so nothing was changed." };
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
    // A passing check is left alone only while it still covers the employee's configuration AND the setup it reads (a changed calendar, targeting or pipeline asks for a new one).
    if (v?.state === "passed" && v.configVersion === e.configVersion && checkCoversInputs(v.inputsDigest, e.inputsDigest)) continue;
    const inputsDigest = e.inputsDigest ?? null;
    const round = await finishedCheckRound(ctx.org.orgId, e.role, e.configVersion, inputsDigest);
    const capability = LAUNCH_VERIFICATION_CAPABILITY[e.role];
    try {
      await dispatchCapabilityJob(ctx, {
        agentRole: e.role,
        capability,
        title: `Launch check: ${capabilityDefinition(capability)?.label ?? capability}`,
        input: launchVerificationInput(e.configVersion, inputsDigest),
        idempotencyKey: launchVerificationKey({ orgId: ctx.org.orgId, role: e.role, configVersion: e.configVersion, inputsDigest, round }),
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
