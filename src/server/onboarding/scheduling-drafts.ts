import "server-only";
import type { Queryable } from "@/server/db";
import { recordAudit } from "@/server/audit";
import { crmOwners } from "@/server/setup/native-evidence";
import { slugify } from "@/server/calendars/setup";
import { planSchedulingDrafts, type SchedulingDraftOutcome, type SchedulingDraftPlan } from "@/lib/onboarding/scheduling-drafts";
import type { Answers } from "@/lib/onboarding/types";

// Booking rules from the onboarding answers become a DRAFT calendar and its appointment types, so the owner does not type them again in CRM scheduling. Nothing goes live:
// the calendar is a draft (the database refuses a public or default draft, 0054), has no host, and every booking path refuses it until someone assigns hosts and activates it
// after the checks of src/server/calendars/activation.ts. It is created only when the workspace has no calendar of its own. Appointment types that were drafted earlier
// are never changed or removed (a person may have tuned them): a type newly listed in the questionnaire is added, and the draft's suggested hours are refreshed while it is
// still a draft.

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
      `insert into crm_appointment_types (org_id, calendar_id, name, slug, duration_minutes, min_notice_minutes, location_kind, public, position)
       values ($1, $2, $3, $4, $5, $6, $7, true, $8)`,
      [orgId, calendarId, t.name, slug, t.durationMinutes, t.minNoticeMinutes, t.locationKind, position],
    );
  }
  return which.length;
}

async function draft(db: Queryable, ctx: { orgId: string; userId: string }, plan: SchedulingDraftPlan): Promise<SchedulingDraftOutcome> {
  // Two submissions at once must not both see "no calendar" and each make one.
  await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`onboarding-scheduling:${ctx.orgId}`]);
  const live = (await db.query<CalendarRow>("select id, status, origin from crm_calendars where org_id = $1 and archived_at is null order by created_at, id", [ctx.orgId])).rows;
  const own = live.filter((c) => c.origin === "onboarding" && c.status === "draft");
  if (live.length > own.length) {
    return skipped("You already have a calendar, so nothing was added from your booking answers. Change appointment types in Calendars & Types.", plan);
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
  try {
    const outcome = await draft(db, ctx, plan);
    await db.query("release savepoint onboarding_scheduling");
    return outcome;
  } catch (err) {
    await db.query("rollback to savepoint onboarding_scheduling");
    await db.query("release savepoint onboarding_scheduling");
    if (process.env.NODE_ENV !== "test") console.error("[iacquire] drafting a booking calendar from onboarding answers failed", (err as { code?: string }).code ?? (err as Error).name);
    return skipped("Your booking calendar could not be drafted this time. Nothing was changed; add your appointment types in Calendars & Types.", plan);
  }
}
