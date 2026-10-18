import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { assertCan, auditActor, crmWrite, type CrmActor } from "@/server/crm/actor";
import { assertNativeOwner } from "@/server/crm/workspace";
import { isValidTimeZone } from "@/lib/calendars/slots";
import { computeSlots, loadBookingContext } from "@/server/calendars/availability";
import { applyHoursTemplateInTx, type CalendarStatus, type MeetingProvider } from "@/server/calendars/setup";
import { pickUpSetupEvidence } from "@/server/setup/evidence-pickup";

// Draft calendars and how they go live. A calendar created from a Blueprint (or imported) starts as a draft: no booking page, never the
// default, and refused by every booking path (src/server/calendars/availability.ts loadBookingContext). It becomes bookable only when someone
// who manages calendars activates it, and activation re-runs every check below inside its own transaction: hosts are assigned, every host
// has weekly hours and a real time zone, there is something to book, the provider connections its meeting links need are in place, and a
// customer would actually be offered a time in the next 14 days. Nothing here books, sends or connects anything.

/** How far ahead activation looks for a real open time. */
export const VERIFY_WINDOW_DAYS = 14;
/** Types checked for an open time, so a calendar with very many types still verifies quickly. */
const MAX_TYPES_CHECKED = 20;

export type CalendarCheckKey = "hosts" | "hours" | "timezone" | "types" | "connections" | "slot";

export interface CalendarCheck {
  key: CalendarCheckKey;
  ok: boolean;
  /** What is checked, in a few words. */
  label: string;
  /** What was found: when it passes, a short confirmation; when it fails, what's wrong and what to do. */
  detail: string;
  /** The people a failing check is about (missing hours, time zone or connection), for "fix it" links. */
  people?: Array<{ userId: string; name: string }>;
}

export interface CalendarVerification {
  calendarId: string;
  calendarName: string;
  status: CalendarStatus;
  /** True only when every check passes. */
  ok: boolean;
  checkedAt: string;
  checks: CalendarCheck[];
  /** The first open time found: proof that a customer could really book it once it is active. */
  firstOpenTime: { typeId: string; typeName: string; start: string } | null;
}

export interface ActivationResult {
  /** True when this call turned the draft into an active calendar. */
  activated: boolean;
  /** The calendar was already active; nothing changed. */
  alreadyActive: boolean;
  /** Made the workspace's default because no other active calendar was. */
  madeDefault: boolean;
  verification: CalendarVerification;
}

const LABELS: Record<CalendarCheckKey, string> = {
  hosts: "Hosts assigned",
  hours: "Working hours",
  timezone: "Time zones",
  types: "Appointment types",
  connections: "Calendar connections for meeting links",
  slot: `An open time in the next ${VERIFY_WINDOW_DAYS} days`,
};

const names = (people: Array<{ name: string }>) => {
  const n = people.map((p) => p.name);
  return n.length <= 3 ? n.join(", ") : `${n.slice(0, 3).join(", ")} and ${n.length - 3} more`;
};

const PROVIDER_INFO: Record<"google_meet" | "microsoft_teams", { connection: "google" | "microsoft"; link: string; account: string }> = {
  google_meet: { connection: "google", link: "Google Meet", account: "Google Calendar" },
  microsoft_teams: { connection: "microsoft", link: "Microsoft Teams", account: "Microsoft 365 calendar" },
};

/**
 * Appointment types still waiting for the fixed meeting link their Blueprint (or GoHighLevel import) asked for: the asset that created the
 * type had a fixed link (custom_link) without the link itself, and the workspace hasn't set one since. The database can't store a fixed-link
 * type without its link, so such a type is stored without a video link (meeting_provider 'none') until someone adds the link or picks
 * Google Meet or Microsoft Teams. The setup checklist and calendar activation both use this, so they never disagree. Trusted code: the
 * caller authorized the reader for `orgId`.
 */
export async function typesAwaitingMeetingLink(db: Queryable, orgId: string, scope: { calendarId?: string; typeIds?: string[] }): Promise<Array<{ id: string; name: string }>> {
  if (!scope.calendarId && !scope.typeIds?.length) return [];
  const { rows } = await db.query<{ id: string; name: string }>(
    `select t.id, t.name
       from crm_appointment_types t
       join crm_blueprint_links l on l.org_id = t.org_id and l.native_id = t.id and l.asset_type = 'appointmentType'
       join crm_blueprint_applications a on a.id = l.application_id and a.org_id = l.org_id
       join crm_blueprint_versions v on v.id = a.version_id
      where t.org_id = $1 and t.archived_at is null and t.meeting_provider = 'none'
        and ($2::uuid is null or t.calendar_id = $2) and ($3::uuid[] is null or t.id = any($3::uuid[]))
        and exists (
          select 1 from jsonb_array_elements(coalesce(v.package -> 'assets' -> 'calendars', '[]'::jsonb)) c, jsonb_array_elements(coalesce(c -> 'types', '[]'::jsonb)) x
           where x ->> 'id' = l.asset_id and x ->> 'meetingProvider' = 'custom_link' and coalesce(x ->> 'meetingLink', '') = '')
      order by t.position, lower(t.name)`,
    [orgId, scope.calendarId ?? null, scope.typeIds?.length ? scope.typeIds : null],
  );
  return rows;
}

/**
 * Runs every activation check for one calendar of `orgId`, inside the caller's transaction. Trusted code: the caller has authorized the
 * actor for this workspace, and every query names it. Reads only.
 */
export async function verifyCalendarInTx(db: Queryable, orgId: string, calendarId: string, now: Date = new Date()): Promise<CalendarVerification> {
  const cal = await db.query<{ id: string; name: string; status: CalendarStatus }>(
    "select id, name, status from crm_calendars where id = $1 and org_id = $2 and archived_at is null",
    [calendarId, orgId],
  );
  const c = cal.rows[0];
  if (!c) throw new AppError("not_found", "Calendar not found.");

  // The people who would take bookings: active hosts who are still active members of this workspace (as availability counts them).
  const hosts = await db.query<{ user_id: string; name: string; timezone: string | null; accepting: boolean | null; has_hours: boolean }>(
    `select cm.user_id, coalesce(nullif(u.full_name, ''), u.email::text) as name, h.timezone, h.accepting,
            exists (select 1 from crm_availability_rules r where r.org_id = cm.org_id and r.user_id = cm.user_id) as has_hours
     from crm_calendar_members cm
     join organization_memberships m on m.org_id = cm.org_id and m.user_id = cm.user_id and m.status = 'active'
     join users u on u.id = cm.user_id and u.status = 'active'
     left join crm_host_settings h on h.org_id = cm.org_id and h.user_id = cm.user_id
     where cm.calendar_id = $1 and cm.org_id = $2 and cm.active
     order by cm.priority desc, cm.created_at`,
    [calendarId, orgId],
  );
  const people = hosts.rows.map((h) => ({ userId: h.user_id, name: h.name }));
  const types = await db.query<{ id: string; name: string; meeting_provider: MeetingProvider; meeting_link: string | null }>(
    "select id, name, meeting_provider, meeting_link from crm_appointment_types where calendar_id = $1 and org_id = $2 and archived_at is null order by position, lower(name)",
    [calendarId, orgId],
  );
  const checks: CalendarCheck[] = [];
  const add = (key: CalendarCheckKey, ok: boolean, detail: string, who?: Array<{ userId: string; name: string }>) =>
    checks.push({ key, ok, label: LABELS[key], detail, ...(who?.length ? { people: who } : {}) });

  // Hosts.
  if (!hosts.rows.length) add("hosts", false, "Nobody hosts this calendar yet. Blueprints never carry people, so choose who takes these appointments.");
  else add("hosts", true, hosts.rows.length === 1 ? `${hosts.rows[0].name} takes these appointments.` : `${hosts.rows.length} hosts: ${names(people)}.`);

  // Working hours, for every host (any of them may be given a booking).
  const noHours = hosts.rows.filter((h) => !h.has_hours).map((h) => ({ userId: h.user_id, name: h.name }));
  if (!hosts.rows.length) add("hours", false, "Assign hosts first; then each of them needs weekly hours.");
  else if (noHours.length) add("hours", false, `${names(noHours)} ${noHours.length === 1 ? "has" : "have"} no weekly hours, so no time could be offered with them. Set hours in Availability.`, noHours);
  else add("hours", true, "Every host has weekly hours.");

  // Time zones: each host's own, set and real (hours are read in it).
  const badZone = hosts.rows.filter((h) => !h.timezone || !isValidTimeZone(h.timezone)).map((h) => ({ userId: h.user_id, name: h.name }));
  if (!hosts.rows.length) add("timezone", false, "Assign hosts first; then each of them needs a time zone.");
  else if (badZone.length) add("timezone", false, `${names(badZone)} ${badZone.length === 1 ? "has" : "have"} no valid time zone yet. Choose one with their hours in Availability.`, badZone);
  else add("timezone", true, `Every host has a time zone (${[...new Set(hosts.rows.map((h) => h.timezone as string))].slice(0, 3).join(", ")}).`);

  // Something to book.
  if (!types.rows.length) add("types", false, "There is nothing to book yet. Add an appointment type.");
  else add("types", true, `${types.rows.length} appointment ${types.rows.length === 1 ? "type" : "types"}: ${names(types.rows)}.`);

  // Meeting links that only a connected calendar can create need every host connected to that provider.
  const needs = [...new Set(types.rows.map((t) => t.meeting_provider).filter((p): p is "google_meet" | "microsoft_teams" => p === "google_meet" || p === "microsoft_teams"))];
  // A fixed link that is missing: a Blueprint's type stored without its link, plus (defensively) a fixed-link type with an empty link.
  const awaiting = new Set((await typesAwaitingMeetingLink(db, orgId, { calendarId })).map((t) => t.id));
  const missingLink = types.rows.filter((t) => awaiting.has(t.id) || (t.meeting_provider === "custom_link" && !t.meeting_link));
  if (!needs.length && !missingLink.length) add("connections", true, "No appointment type needs a calendar connection.");
  else {
    const ids = hosts.rows.map((h) => h.user_id);
    const conns = ids.length
      ? await db.query<{ user_id: string; provider: "google" | "microsoft" }>(
          `select distinct user_id, provider from crm_calendar_connections
           where org_id = $1 and user_id = any($2::uuid[]) and status = 'connected' and write_events and external_calendar_id is not null and provider in ('google', 'microsoft')`,
          [orgId, ids],
        )
      : { rows: [] };
    const problems: string[] = [];
    const who = new Map<string, { userId: string; name: string }>();
    for (const p of needs) {
      const info = PROVIDER_INFO[p];
      const missing = hosts.rows.filter((h) => !conns.rows.some((r) => r.user_id === h.user_id && r.provider === info.connection));
      if (!hosts.rows.length) problems.push(`${info.link} links need each host's connected ${info.account}; assign hosts first.`);
      else if (missing.length) {
        problems.push(`${info.link} links are created through each host's connected ${info.account}, which ${names(missing)} ${missing.length === 1 ? "hasn't" : "haven't"} connected (with adding events turned on).`);
        for (const m of missing) who.set(m.user_id, { userId: m.user_id, name: m.name });
      }
    }
    if (missingLink.length) problems.push(`${names(missingLink)} ${missingLink.length === 1 ? "needs" : "need"} the meeting link this business uses.`);
    if (problems.length) add("connections", false, problems.join(" "), [...who.values()]);
    else add("connections", true, `Every host has connected what ${needs.map((p) => PROVIDER_INFO[p].link).join(" and ")} links need.`);
  }

  // A real open time, computed exactly as a customer would be offered one (notice period included), ignoring only the draft status.
  let firstOpenTime: CalendarVerification["firstOpenTime"] = null;
  const withoutTimes: string[] = [];
  if (hosts.rows.length && types.rows.length) {
    const to = new Date(now.getTime() + VERIFY_WINDOW_DAYS * 86_400_000);
    for (const t of types.rows.slice(0, MAX_TYPES_CHECKED)) {
      const ctx = await loadBookingContext(db, orgId, t.id, { includeDraft: true });
      // A host whose time zone isn't real can't be offered any time (the time zone check already says so); the others still count.
      ctx.hosts = ctx.hosts.filter((h) => isValidTimeZone(h.timezone));
      const slots = await computeSlots(db, ctx, { from: now, to, now });
      if (!slots.length) withoutTimes.push(t.name);
      else if (!firstOpenTime || slots[0].start < firstOpenTime.start) firstOpenTime = { typeId: t.id, typeName: t.name, start: slots[0].start };
    }
  }
  if (!hosts.rows.length || !types.rows.length) add("slot", false, "Needs hosts and an appointment type before a time can be offered.");
  else if (!firstOpenTime) {
    const paused = hosts.rows.filter((h) => h.accepting === false);
    add("slot", false, `No time would be offered to a customer in the next ${VERIFY_WINDOW_DAYS} days. ${paused.length === hosts.rows.length ? "Every host has paused new bookings." : "Check the hosts' working hours, days off and connected-calendar busy times, and each type's notice and booking window."}`);
  } else {
    const note = withoutTimes.length ? ` No open time yet for ${withoutTimes.slice(0, 3).join(", ")}${withoutTimes.length > 3 ? ` and ${withoutTimes.length - 3} more` : ""}.` : "";
    add("slot", true, `A customer could book it: the first open time is for ${firstOpenTime.typeName}.${note}`);
  }

  return { calendarId: c.id, calendarName: c.name, status: c.status, ok: checks.every((x) => x.ok), checkedAt: now.toISOString(), checks, firstOpenTime };
}

/**
 * Runs the activation checks for one calendar, for someone who manages calendars. Read-only; computed as trusted code after the
 * permission check (every query names the workspace), so every host's connected-calendar busy time counts exactly as it does for booking.
 */
export async function verifyCalendar(actor: CrmActor, calendarId: string, opts: { now?: Date } = {}): Promise<CalendarVerification> {
  assertCan(actor, "calendars.manage");
  return withSystem(async (db) => {
    await assertNativeOwner(db, actor.orgId, "calendars");
    return verifyCalendarInTx(db, actor.orgId, calendarId, opts.now);
  });
}

/** What activation keeps of the checks: small, and only what a later reader needs (never people's details). */
function verificationRecord(v: CalendarVerification, actor: CrmActor) {
  return {
    version: 1,
    checkedAt: v.checkedAt,
    by: actor.userId,
    byKind: auditActor(actor).actorKind,
    checks: v.checks.map((c) => ({ key: c.key, ok: c.ok, detail: c.detail.slice(0, 300) })),
    firstOpenTime: v.firstOpenTime,
  };
}

/**
 * Activates a draft calendar when, and only when, every check passes at that moment (re-run inside the transaction, with the calendar row
 * locked). On success it records when and what was verified, and makes it the default if the workspace has no active default. When a check
 * fails nothing changes and the result says which. The booking page stays off: turning it on is a separate, checked step.
 */
export async function activateCalendar(actor: CrmActor, calendarId: string, opts: { now?: Date } = {}): Promise<ActivationResult> {
  const result = await activateCalendarTx(actor, calendarId, opts);
  // Committed: the Setup Center's calendar check sees the newly active calendar now rather than at the next scheduled pass (never failing
  // the activation). Nothing changed otherwise, so there is nothing new to pick up.
  if (result.activated) await pickUpSetupEvidence(actor.orgId, "a calendar activation");
  return result;
}

function activateCalendarTx(actor: CrmActor, calendarId: string, opts: { now?: Date }): Promise<ActivationResult> {
  assertCan(actor, "calendars.manage");
  const now = opts.now ?? new Date();
  return crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "calendars");
    const lock = await db.query<{ status: CalendarStatus }>("select status from crm_calendars where id = $1 and org_id = $2 and archived_at is null for update", [calendarId, actor.orgId]);
    if (!lock.rows[0]) throw new AppError("not_found", "Calendar not found.");
    const verification = await verifyCalendarInTx(db, actor.orgId, calendarId, now);
    if (lock.rows[0].status === "active") return { activated: false, alreadyActive: true, madeDefault: false, verification };
    if (!verification.ok) return { activated: false, alreadyActive: false, madeDefault: false, verification };
    await db.query(
      "update crm_calendars set status = 'active', verified_at = $3, verification = $4 where id = $1 and org_id = $2",
      [calendarId, actor.orgId, now, JSON.stringify(verificationRecord(verification, actor))],
    );
    const def = await db.query(
      `update crm_calendars set is_default = true where id = $1 and org_id = $2
       and not exists (select 1 from crm_calendars where org_id = $2 and is_default and archived_at is null) returning id`,
      [calendarId, actor.orgId],
    );
    await recordAudit({
      orgId: actor.orgId, ...auditActor(actor), action: "crm.calendar_activated", targetType: "crm_calendar", targetId: calendarId, result: "success",
      metadata: { checks: verification.checks.length, made_default: (def.rowCount ?? 0) > 0 },
    }, db);
    return { activated: true, alreadyActive: false, madeDefault: (def.rowCount ?? 0) > 0, verification: { ...verification, status: "active" } };
  });
}

/**
 * Gives the calendar's suggested weekly hours (from its Blueprint) to its current hosts who have no hours yet. Hosts who already have hours
 * keep them. Changing other people's hours needs calendar management, as it does in Availability.
 */
export async function applyCalendarHoursTemplate(actor: CrmActor, calendarId: string): Promise<{ applied: string[]; kept: string[] }> {
  assertCan(actor, "calendars.manage");
  return crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "calendars");
    const hosts = await db.query<{ user_id: string }>(
      `select cm.user_id from crm_calendar_members cm join organization_memberships m on m.org_id = cm.org_id and m.user_id = cm.user_id and m.status = 'active'
       join users u on u.id = cm.user_id and u.status = 'active'
       where cm.calendar_id = $1 and cm.org_id = $2 and cm.active`,
      [calendarId, actor.orgId],
    );
    const cal = await db.query<{ n: number }>("select jsonb_array_length(hours_template) as n from crm_calendars where id = $1 and org_id = $2 and archived_at is null", [calendarId, actor.orgId]);
    if (!cal.rows[0]) throw new AppError("not_found", "Calendar not found.");
    if (!cal.rows[0].n) throw new AppError("conflict", "This calendar has no suggested hours to use.");
    if (!hosts.rows.length) throw new AppError("conflict", "Assign hosts first, then use the suggested hours for them.");
    const res = await applyHoursTemplateInTx(db, actor.orgId, calendarId, hosts.rows.map((h) => h.user_id));
    if (res.applied.length) {
      await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.calendar_hours_applied", targetType: "crm_calendar", targetId: calendarId, result: "success", metadata: { hosts: res.applied.length } }, db);
    }
    return res;
  });
}
