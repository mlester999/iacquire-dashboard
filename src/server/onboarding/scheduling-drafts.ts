import "server-only";
import type { Queryable } from "@/server/db";
import { recordAudit } from "@/server/audit";
import { crmOwners } from "@/server/setup/native-evidence";
import { slugify } from "@/server/calendars/setup";
import { loadAnswerRows, toStored } from "@/server/onboarding/answers";
import { answerDrift, planSchedulingDrafts, type DraftMeetingProvider, type LiveAppointmentType, type SchedulingDraftOutcome, type SchedulingDraftPlan, type SchedulingHostOutcome } from "@/lib/onboarding/scheduling-drafts";
import { confirmedAnswers } from "@/lib/onboarding/engine";
import { wantsAppointments } from "@/lib/onboarding/definitions";
import type { Answers } from "@/lib/onboarding/types";

// Booking rules from the onboarding answers become a DRAFT calendar and its appointment types, so the owner does not type them again in CRM scheduling. Nothing goes live:
// the calendar is a draft (the database refuses a public or default draft, 0054), and every booking path refuses it until someone assigns hosts and activates it
// after the checks of src/server/calendars/activation.ts. It is created only when the workspace has no calendar of its own. Appointment types that were drafted earlier
// are never changed or removed (a person may have tuned them): a type newly listed in the questionnaire is added, and the draft's suggested hours are refreshed while it is
// still a draft. A calendar that is already live is never edited from here: the answers that no longer match it are reported as drift, in words.
//
// The host is the client's explicit choice, never a guess. "I take these appointments" adds the person who submitted as the calendar's one host, but only when they are the one who gave that answer; a team member the owner
// marked as taking appointments becomes a host when they accept their invitation. Neither carries working hours: hours are written only by the launch step the client
// approves (apply_hours), so a host named here still has to be given hours before the calendar can be activated.

type CalendarRow = { id: string; status: "draft" | "active"; origin: string };

const skipped = (reason: string, plan?: SchedulingDraftPlan): SchedulingDraftOutcome => ({ state: "skipped", reason, typesAdded: 0, skipped: plan?.skipped ?? [] });

async function freeSlug(taken: (slug: string) => Promise<boolean>, base: string): Promise<string> {
  let slug = base;
  for (let i = 2; await taken(slug); i += 1) slug = `${base.slice(0, 44)}-${i}`;
  return slug;
}

async function insertTypes(db: Queryable, orgId: string, calendarId: string, which: SchedulingDraftPlan["types"]): Promise<number> {
  let position = Number((await db.query<{ n: number }>("select coalesce(max(position), 0) as n from crm_appointment_types where calendar_id = $1", [calendarId])).rows[0].n);
  for (const t of which) {
    position += 1;
    const slug = await freeSlug(async (s) => (await db.query("select 1 from crm_appointment_types where calendar_id = $1 and slug = $2 and archived_at is null", [calendarId, s])).rows.length > 0, slugify(t.name));
    await db.query(
      `insert into crm_appointment_types (org_id, calendar_id, name, slug, duration_minutes, min_notice_minutes, location_kind, public, position,
         buffer_after_minutes, requires_confirmation, allow_customer_changes, change_cutoff_minutes, meeting_provider, meeting_link, slot_interval_minutes)
       values ($1, $2, $3, $4, $5, $6, $7, true, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [orgId, calendarId, t.name, slug, t.durationMinutes, t.minNoticeMinutes, t.locationKind, position, t.bufferAfterMinutes, t.requiresConfirmation, t.allowCustomerChanges, t.changeCutoffMinutes, t.meetingProvider, t.meetingLink, t.slotIntervalMinutes],
    );
  }
  return which.length;
}

/** The live appointment types of the calendar the onboarding drafted, for comparing with what the answers say now. */
async function liveTypes(db: Queryable, orgId: string, calendarId: string): Promise<LiveAppointmentType[]> {
  const { rows } = await db.query<{
    name: string; duration_minutes: number; min_notice_minutes: number; buffer_after_minutes: number; requires_confirmation: boolean; allow_customer_changes: boolean;
    change_cutoff_minutes: number; meeting_provider: DraftMeetingProvider; meeting_link: string | null;
  }>(
    `select name, duration_minutes, min_notice_minutes, buffer_after_minutes, requires_confirmation, allow_customer_changes, change_cutoff_minutes, meeting_provider, meeting_link
     from crm_appointment_types where calendar_id = $1 and org_id = $2 and archived_at is null order by position`,
    [calendarId, orgId],
  );
  return rows.map((r) => ({
    name: r.name, durationMinutes: r.duration_minutes, minNoticeMinutes: r.min_notice_minutes, bufferAfterMinutes: r.buffer_after_minutes, requiresConfirmation: r.requires_confirmation,
    allowCustomerChanges: r.allow_customer_changes, changeCutoffMinutes: r.change_cutoff_minutes, meetingProvider: r.meeting_provider, meetingLink: r.meeting_link,
  }));
}

async function draft(db: Queryable, ctx: { orgId: string; userId: string }, plan: SchedulingDraftPlan, answers: Answers): Promise<SchedulingDraftOutcome> {
  // Two submissions at once must not both see "no calendar" and each make one.
  await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`onboarding-scheduling:${ctx.orgId}`]);
  const live = (await db.query<CalendarRow>("select id, status, origin from crm_calendars where org_id = $1 and archived_at is null order by created_at, id", [ctx.orgId])).rows;
  const own = live.filter((c) => c.origin === "onboarding" && c.status === "draft");
  if (live.length > own.length) {
    const outcome = skipped("You already have a calendar, so nothing was added from your booking answers. Change appointment types in Calendars & Types.", plan);
    // The calendar the onboarding drafted and a person then activated is the client's own now: say how the answers differ from it, and change nothing.
    const activated = live.find((c) => c.origin === "onboarding" && c.status !== "draft");
    return activated ? { ...outcome, drift: answerDrift(answers, await liveTypes(db, ctx.orgId, activated.id)) } : outcome;
  }

  if (own.length) {
    const calendarId = own[0].id;
    const have = new Set((await db.query<{ name: string }>("select name from crm_appointment_types where calendar_id = $1 and org_id = $2 and archived_at is null", [calendarId, ctx.orgId])).rows.map((r) => r.name.trim().toLowerCase()));
    const missing = plan.types.filter((t) => !have.has(t.name.toLowerCase()));
    const added = await insertTypes(db, ctx.orgId, calendarId, missing);
    // The suggested hours and zone belong to the draft; a person has no screen to edit them, only to apply them to a host, so the latest answers replace them.
    const hours = plan.hoursTemplate.length ? JSON.stringify(plan.hoursTemplate) : null;
    const refreshed = await db.query(
      `update crm_calendars set hours_template = coalesce($3::jsonb, hours_template), timezone = coalesce($4, timezone)
       where id = $1 and org_id = $2 and status = 'draft'
         and (($3::jsonb is not null and hours_template is distinct from $3::jsonb) or ($4::text is not null and timezone is distinct from $4::text))`,
      [calendarId, ctx.orgId, hours, plan.timezone],
    );
    if (added || refreshed.rowCount) {
      await recordAudit({ orgId: ctx.orgId, actorUserId: ctx.userId, actorKind: "user", action: "onboarding.scheduling_drafted", targetType: "crm_calendar", targetId: calendarId, result: "success", metadata: { types: added, hoursRefreshed: Boolean(refreshed.rowCount), created: false } }, db);
    }
    return { state: added ? "updated" : "unchanged", calendarId, typesAdded: added, skipped: plan.skipped };
  }

  const slug = await freeSlug(async (s) => (await db.query("select 1 from crm_calendars where org_id = $1 and slug = $2 and archived_at is null", [ctx.orgId, s])).rows.length > 0, slugify(plan.calendarName));
  const { rows } = await db.query<{ id: string }>(
    `insert into crm_calendars (org_id, name, slug, description, public, is_default, created_by, status, timezone, hours_template, origin)
     values ($1, $2, $3, $4, false, false, $5, 'draft', $6, $7, 'onboarding') returning id`,
    [ctx.orgId, plan.calendarName, slug, plan.description, ctx.userId, plan.timezone, JSON.stringify(plan.hoursTemplate)],
  );
  const calendarId = rows[0].id;
  const added = await insertTypes(db, ctx.orgId, calendarId, plan.types);
  await recordAudit({ orgId: ctx.orgId, actorUserId: ctx.userId, actorKind: "user", action: "onboarding.scheduling_drafted", targetType: "crm_calendar", targetId: calendarId, result: "success", metadata: { types: added, hoursRefreshed: false, created: true } }, db);
  return { state: "created", calendarId, typesAdded: added, skipped: plan.skipped };
}

/** An active member of this workspace with an active account: the same test a host must pass (assertHosts in src/server/calendars/setup.ts). */
async function isActiveMember(db: Queryable, orgId: string, userId: string): Promise<boolean> {
  const { rows } = await db.query("select 1 from organization_memberships m join users u on u.id = m.user_id where m.org_id = $1 and m.user_id = $2 and m.status = 'active' and u.status = 'active'", [orgId, userId]);
  return rows.length > 0;
}

/**
 * The host-assigned audit row, written only when a person was really added. Never carries hours: none are written here.
 * `via` says which door the host came through, so the activity feed can tell a questionnaire answer from an accepted invitation.
 */
const auditHost = (db: Queryable, orgId: string, actorUserId: string, calendarId: string, hostUserId: string, via: "answer" | "invitation", extra: Record<string, unknown> = {}) =>
  recordAudit({ orgId, actorUserId, actorKind: "user", action: "onboarding.host_assigned", targetType: "crm_calendar", targetId: calendarId, result: "success", metadata: { userId: hostUserId, via, hours: "not_set", ...extra } }, db);

/** A person this flow already made a host of the calendar: if they are not on it now, someone took them off, and that choice stands. */
async function wasHostBefore(db: Queryable, orgId: string, calendarId: string, userId: string): Promise<boolean> {
  const { rows } = await db.query(
    "select 1 from audit_logs where org_id = $1 and action = 'onboarding.host_assigned' and target_type = 'crm_calendar' and target_id = $2 and metadata->>'userId' = $3 limit 1",
    [orgId, calendarId, userId],
  );
  return rows.length > 0;
}

/**
 * "I take these appointments": the person who gave that answer becomes the draft calendar's one host, without hours. That is the submitter only when the submitter is also
 * the one who answered: a manager who presses the final approval on an owner's questionnaire must not become the host in the owner's place. Runs inside the caller's savepoint.
 */
async function assignSubmitterAsHost(db: Queryable, ctx: { orgId: string; userId: string }, calendarId: string): Promise<SchedulingHostOutcome> {
  const choice = "owner" as const;
  const cal = (await db.query<CalendarRow>("select id, status, origin from crm_calendars where id = $1 and org_id = $2 and archived_at is null", [calendarId, ctx.orgId])).rows[0];
  if (!cal || cal.status !== "draft" || cal.origin !== "onboarding") return { choice, state: "skipped", reason: "Your booking calendar is not a draft any more, so nobody was added as its host. Change hosts in Calendars & Types." };
  if (!(await isActiveMember(db, ctx.orgId, ctx.userId))) return { choice, state: "skipped", reason: "The person who submitted is not an active member of this workspace, so nobody was added as the host. Choose a host in your launch checklist." };
  // No saved answer row means the answers were handed in directly; a saved one names who gave it.
  const answered = (await db.query<{ answered_by: string | null }>("select answered_by from onboarding_answers where org_id = $1 and question_id = 'd.appt_host'", [ctx.orgId])).rows[0];
  if (answered && answered.answered_by !== ctx.userId) return { choice, state: "skipped", reason: "Someone else chose \"I take these appointments\", so the person who submitted was not made the host. Choose a host in your launch checklist." };
  const members = (await db.query<{ user_id: string }>("select user_id from crm_calendar_members where calendar_id = $1 and org_id = $2", [calendarId, ctx.orgId])).rows;
  if (members.some((m) => m.user_id === ctx.userId)) return { choice, state: "unchanged" };
  if (members.length) return { choice, state: "skipped", reason: "This calendar already has a host, so nobody was added." };
  // A host taken off the calendar by a person stays off: one answer must not undo that choice on every later submission.
  if (await wasHostBefore(db, ctx.orgId, calendarId, ctx.userId)) return { choice, state: "unchanged", reason: "A host was already assigned from your answers earlier, so it was not added again." };
  const inserted = await db.query("insert into crm_calendar_members (org_id, calendar_id, user_id) values ($1, $2, $3) on conflict (calendar_id, user_id) do nothing", [ctx.orgId, calendarId, ctx.userId]);
  if (!inserted.rowCount) return { choice, state: "unchanged" };
  await auditHost(db, ctx.orgId, ctx.userId, calendarId, ctx.userId, "answer", { choice });
  return { choice, state: "assigned" };
}

/**
 * Records the host the client chose on the draft calendar, in a savepoint of its own so a problem here never takes the submission down. "owner" adds the submitter
 * (an active member) as the one host with NO weekly hours; "team" assigns nobody now (the invitation hook below adds each team member the owner marked as a host when they
 * accept). It never activates the calendar, never makes the page public and never calls the hours template: the client's suggested hours stay on the draft until the
 * launch step they approve applies them. Null when the client did not choose.
 */
export async function proposeHostFromAnswers(db: Queryable, ctx: { orgId: string; userId: string }, answers: Answers, scheduling: SchedulingDraftOutcome): Promise<SchedulingHostOutcome | null> {
  const choice = planSchedulingDrafts(answers).hostChoice;
  if (!choice) return null;
  if (!scheduling.calendarId || scheduling.state === "skipped") return { choice, state: "skipped", reason: "There is no draft booking calendar to add a host to." };
  if (choice === "team") return { choice, state: "waiting" };
  await db.query("savepoint onboarding_host");
  try {
    const outcome = await assignSubmitterAsHost(db, ctx, scheduling.calendarId);
    await db.query("release savepoint onboarding_host");
    return outcome;
  } catch (err) {
    await db.query("rollback to savepoint onboarding_host");
    await db.query("release savepoint onboarding_host");
    if (process.env.NODE_ENV !== "test") console.error("[iacquire] assigning the chosen host to the draft booking calendar failed", (err as { code?: string }).code ?? (err as Error).name);
    return { choice, state: "skipped", reason: "The host you chose could not be added this time. Nothing was changed; choose a host in your launch checklist." };
  }
}

/**
 * Drafts the booking calendar the answers describe, inside the caller's transaction, in a savepoint of its own: a problem with the draft is reported as "skipped" and never
 * takes the submission down with it. Trusted code: the caller has authorized the person for this workspace.
 */
export async function proposeSchedulingDrafts(db: Queryable, ctx: { orgId: string; userId: string }, answers: Answers): Promise<SchedulingDraftOutcome> {
  const plan = planSchedulingDrafts(answers);
  if (plan.reason) return skipped(plan.reason, plan);
  const owners = await crmOwners(db, ctx.orgId);
  if (owners.capabilities.calendars !== "native") return skipped("Your calendars are managed in GoHighLevel, so no booking calendar was drafted.", plan);
  if (owners.switching) return skipped("Your CRM provider is being switched, so no booking calendar was drafted yet.", plan);
  await db.query("savepoint onboarding_scheduling");
  let outcome: SchedulingDraftOutcome;
  try {
    outcome = await draft(db, ctx, plan, answers);
    await db.query("release savepoint onboarding_scheduling");
  } catch (err) {
    await db.query("rollback to savepoint onboarding_scheduling");
    await db.query("release savepoint onboarding_scheduling");
    if (process.env.NODE_ENV !== "test") console.error("[iacquire] drafting a booking calendar from onboarding answers failed", (err as { code?: string }).code ?? (err as Error).name);
    return skipped("Your booking calendar could not be drafted this time. Nothing was changed; add your appointment types in Calendars & Types.", plan);
  }
  const host = await proposeHostFromAnswers(db, ctx, answers, outcome);
  // The client's suggested hours are shown with the outcome so they can be approved; nothing here applies them.
  return { ...outcome, ...(host ? { host } : {}), ...(outcome.calendarId && plan.hoursTemplate.length ? { proposedHours: plan.hoursTemplate } : {}) };
}

/**
 * Invitation acceptance: the new member becomes a host of the calendar the onboarding drafted, only when the owner designated them. That means their email is a row of the
 * client's team answer marked as taking appointments, and the calendar is still a draft with a suggested-hours template. They get NO hours (the launch judge names who still
 * needs them), and every host and every hour already there is left exactly as it is. A second host turns a one-person calendar into a round-robin one, because a one-person
 * calendar only ever offers its first host. Runs in a savepoint and never throws: accepting an invitation must not depend on a calendar. Trusted code: names the workspace in
 * every query. Returns whether a host was added.
 */
export async function assignInvitedHostFromAnswers(db: Queryable, ctx: { orgId: string; userId: string }): Promise<boolean> {
  // Outside a transaction there is no savepoint to take, and then nothing is attempted: accepting an invitation comes first.
  try {
    await db.query("savepoint onboarding_invited_host");
  } catch {
    return false;
  }
  try {
    const added = await addInvitedHost(db, ctx);
    await db.query("release savepoint onboarding_invited_host");
    return added;
  } catch (err) {
    await db.query("rollback to savepoint onboarding_invited_host");
    await db.query("release savepoint onboarding_invited_host");
    if (process.env.NODE_ENV !== "test") console.error("[iacquire] adding an invited team member as a calendar host failed", (err as { code?: string }).code ?? (err as Error).name);
    return false;
  }
}

async function addInvitedHost(db: Queryable, ctx: { orgId: string; userId: string }): Promise<boolean> {
  const cal = (await db.query<{ id: string; assignment: string }>(
    `select id, assignment from crm_calendars
     where org_id = $1 and origin = 'onboarding' and status = 'draft' and archived_at is null and jsonb_array_length(hours_template) > 0
     order by created_at, id limit 1`,
    [ctx.orgId],
  )).rows[0];
  if (!cal) return false;
  const who = (await db.query<{ email: string }>(
    "select u.email::text as email from organization_memberships m join users u on u.id = m.user_id where m.org_id = $1 and m.user_id = $2 and m.status = 'active' and u.status = 'active'",
    [ctx.orgId, ctx.userId],
  )).rows[0];
  if (!who) return false;
  const answers = confirmedAnswers(toStored(await loadAnswerRows(db, ctx.orgId)));
  // A team row's "hosts" value stays saved after booking is switched off (the field is only hidden), so it counts only while appointments are still wanted.
  if (!wantsAppointments(answers)) return false;
  const team = Array.isArray(answers["d.team"]) ? (answers["d.team"] as Array<Record<string, unknown>>) : [];
  const email = who.email.trim().toLowerCase();
  if (!team.some((row) => row?.hosts === "yes" && typeof row.email === "string" && row.email.trim().toLowerCase() === email)) return false;
  // Someone the owner or a manager took off the draft stays off, whether or not they are re-invited.
  if (await wasHostBefore(db, ctx.orgId, cal.id, ctx.userId)) return false;
  const inserted = await db.query("insert into crm_calendar_members (org_id, calendar_id, user_id) values ($1, $2, $3) on conflict (calendar_id, user_id) do nothing", [ctx.orgId, cal.id, ctx.userId]);
  if (!inserted.rowCount) return false;
  const active = await db.query<{ n: string }>("select count(*)::text as n from crm_calendar_members where calendar_id = $1 and org_id = $2 and active", [cal.id, ctx.orgId]);
  const roundRobin = cal.assignment === "single" && Number(active.rows[0]?.n ?? 0) > 1;
  if (roundRobin) await db.query("update crm_calendars set assignment = 'round_robin' where id = $1 and org_id = $2 and status = 'draft'", [cal.id, ctx.orgId]);
  await auditHost(db, ctx.orgId, ctx.userId, cal.id, ctx.userId, "invitation", { roundRobin });
  return true;
}
