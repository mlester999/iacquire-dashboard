import "server-only";
import { createHash } from "node:crypto";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { assertCan, auditActor, crmWrite, type CrmActor } from "@/server/crm/actor";
import { assertNativeOwner } from "@/server/crm/workspace";
import { isValidTimeZone } from "@/lib/calendars/slots";
import { computeSlots, loadBookingContext } from "@/server/calendars/availability";
import { pollMinutesFor } from "@/server/calendars/connections";
import { applyHoursTemplateInTx, assertHosts, parseHoursTemplate, type CalendarStatus, type LocationKind, type MeetingProvider } from "@/server/calendars/setup";
import { pickUpSetupEvidence } from "@/server/setup/evidence-pickup";
import { cleanAnswers } from "@/lib/onboarding/crm-setup";
import { confirmedAnswers } from "@/lib/onboarding/engine";
import { summarizeWeeklyHours } from "@/lib/launch-readiness";
import { loadAnswerRows, toStored } from "@/server/onboarding/answers";

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
  /** Appointment types (of the ones checked) that no customer could be offered a time for. One type with times is enough to go live, so this does not fail the checks; it says what still needs fixing. */
  typesWithoutTimes: string[];
}

/** The calendar account whose busy times the client said must block bookings (their questionnaire answer first, else what they told the CRM setup guide). */
export type BusyCalendarProvider = "google" | "microsoft";

export interface VerifyOptions {
  /**
   * When set, activation cannot pass while no host has this provider connected and being read for busy times. Left out, it is read from the client's own answer (statedBusyProvider:
   * the questionnaire first, else the CRM setup guide), so every caller judges the same way; `null` says "none" explicitly (the Setup Center's calendar check applies the same
   * stated answer itself, with its own freshness window).
   */
  requiredBusyProvider?: BusyCalendarProvider | null;
}

/**
 * What the client said about the outside calendar whose busy times must block bookings: "google" or "microsoft" (it must), "none" (it need not), or null (they have not said).
 * The questionnaire's own answer ("Do you keep your appointments in Google Calendar or Microsoft 365 today?") comes first, and only a confirmed answer counts. Without it, what they told
 * the CRM setup guide is used: they take appointments and use Google Calendar or a Microsoft 365 calendar. Null also when they said they do not take appointments, use the iAcquire
 * calendar only, or use a kind that is only read as a feed or over CalDAV (the Setup Center's calendar check covers those). An answer that no longer validates is dropped, never
 * trusted. Trusted code: every query names the workspace.
 */
export async function statedBusyAnswer(db: Queryable, orgId: string): Promise<BusyCalendarProvider | "none" | null> {
  const answers = confirmedAnswers(toStored(await loadAnswerRows(db, orgId)));
  if (answers["b.appointments"] === false) return null;
  const answered = answers["d.appt_busy_calendar"];
  if (answered === "google" || answered === "microsoft" || answered === "none") return answered;
  const { rows } = await db.query<{ answers: unknown }>("select answers from crm_setup_guides where org_id = $1", [orgId]);
  const stated = cleanAnswers(rows[0]?.answers);
  if (stated.appointments === false) return null;
  return stated.calendarSource === "google" || stated.calendarSource === "microsoft" ? stated.calendarSource : null;
}

/** The same answer as a requirement: the provider whose busy times must be read, or null when none must be (the client said "none", or has not said). */
export async function statedBusyProvider(db: Queryable, orgId: string): Promise<BusyCalendarProvider | null> {
  const answer = await statedBusyAnswer(db, orgId);
  return answer === "none" ? null : answer;
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

const BUSY_ACCOUNT: Record<BusyCalendarProvider, string> = { google: "Google Calendar", microsoft: "Microsoft 365 calendar" };

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

export interface CalendarHost {
  userId: string;
  name: string;
  timezone: string | null;
  accepting: boolean | null;
  hasHours: boolean;
}

/**
 * The people who would take bookings on one calendar: active hosts who are still active members of this workspace and active users, the
 * same three-table rule availability uses. A host who left or was suspended is not here, so no screen counts them. Trusted code: the caller
 * authorized the reader for `orgId`. Highest priority first.
 */
export async function activeHostsOfCalendar(db: Queryable, orgId: string, calendarId: string): Promise<CalendarHost[]> {
  const { rows } = await db.query<{ user_id: string; name: string; timezone: string | null; accepting: boolean | null; has_hours: boolean }>(
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
  return rows.map((r) => ({ userId: r.user_id, name: r.name, timezone: r.timezone, accepting: r.accepting, hasHours: r.has_hours }));
}

/**
 * Runs every activation check for one calendar of `orgId`, inside the caller's transaction. Trusted code: the caller has authorized the
 * actor for this workspace, and every query names it. Reads only.
 */
export async function verifyCalendarInTx(db: Queryable, orgId: string, calendarId: string, now: Date = new Date(), opts: VerifyOptions = {}): Promise<CalendarVerification> {
  const cal = await db.query<{ id: string; name: string; status: CalendarStatus }>(
    "select id, name, status from crm_calendars where id = $1 and org_id = $2 and archived_at is null",
    [calendarId, orgId],
  );
  const c = cal.rows[0];
  if (!c) throw new AppError("not_found", "Calendar not found.");

  // The people who would take bookings: active hosts who are still active members of this workspace (as availability counts them).
  const hostList = await activeHostsOfCalendar(db, orgId, calendarId);
  const hosts = { rows: hostList.map((h) => ({ user_id: h.userId, name: h.name, timezone: h.timezone, accepting: h.accepting, has_hours: h.hasHours })) };
  const people = hosts.rows.map((h) => ({ userId: h.user_id, name: h.name }));
  const types = await db.query<{ id: string; name: string; meeting_provider: MeetingProvider; meeting_link: string | null; location_kind: LocationKind; location_detail: string | null }>(
    "select id, name, meeting_provider, meeting_link, location_kind, location_detail from crm_appointment_types where calendar_id = $1 and org_id = $2 and archived_at is null order by position, lower(name)",
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
  // A video appointment that says nothing about how to join: no meeting tool and no written instructions, so the customer would get "Video call" and nothing else.
  const noJoinInfo = types.rows.filter((t) => !awaiting.has(t.id) && t.location_kind === "video" && t.meeting_provider === "none" && !(t.location_detail ?? "").trim());
  const busyProvider = opts.requiredBusyProvider !== undefined ? opts.requiredBusyProvider : await statedBusyProvider(db, orgId);
  if (!needs.length && !missingLink.length && !noJoinInfo.length && !busyProvider) add("connections", true, "No appointment type needs a calendar connection.");
  else {
    const ids = hosts.rows.map((h) => h.user_id);
    const conns = ids.length && needs.length
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
    if (noJoinInfo.length) {
      problems.push(`${names(noJoinInfo)} ${noJoinInfo.length === 1 ? "is a video appointment" : "are video appointments"} with no meeting tool: choose Google Meet or Microsoft Teams, or write how you send the link, in the appointment type.`);
    }
    // The client said their existing events must block times, so a connected, still-being-read calendar of that kind has to exist (a fresh read is what keeps a host from being double-booked).
    if (busyProvider) {
      const account = BUSY_ACCOUNT[busyProvider];
      if (!hosts.rows.length) problems.push(`Your ${account} must be connected so your existing events block times; assign hosts first.`);
      else {
        const rows = await db.query<{ user_id: string; read_at: Date }>(
          `select user_id, coalesce(last_success_at, created_at) as read_at from crm_calendar_connections
           where org_id = $1 and user_id = any($2::uuid[]) and provider = $3 and status = 'connected' and check_conflicts`,
          [orgId, ids, busyProvider],
        );
        const freshAfter = now.getTime() - 3 * pollMinutesFor(busyProvider) * 60_000;
        const fresh = rows.rows.filter((r) => new Date(r.read_at).getTime() >= freshAfter);
        if (!rows.rows.length) {
          problems.push(`You said events in your ${account} must block times, but no host has connected one yet, so a customer could be offered a time you are already busy. Connect it in Calendar connections.`);
          for (const h of hosts.rows) who.set(h.user_id, { userId: h.user_id, name: h.name });
        } else if (!fresh.length) {
          const stale = rows.rows.map((r) => ({ userId: r.user_id, name: hosts.rows.find((h) => h.user_id === r.user_id)?.name ?? "A host" }));
          problems.push(`The connected ${account} of ${names(stale)} hasn't been read for busy times since ${new Date(Math.max(...rows.rows.map((r) => new Date(r.read_at).getTime()))).toISOString().slice(0, 10)}, so its events may not block times. Reconnect it in Calendar connections.`);
          for (const p of stale) who.set(p.userId, p);
        }
      }
    }
    if (problems.length) add("connections", false, problems.join(" "), [...who.values()]);
    else {
      const ok: string[] = [];
      if (needs.length) ok.push(`Every host has connected what ${needs.map((p) => PROVIDER_INFO[p].link).join(" and ")} links need.`);
      if (busyProvider) ok.push(`A connected ${BUSY_ACCOUNT[busyProvider]} is read for busy times.`);
      add("connections", true, ok.length ? ok.join(" ") : "No appointment type needs a calendar connection.");
    }
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

  return { calendarId: c.id, calendarName: c.name, status: c.status, ok: checks.every((x) => x.ok), checkedAt: now.toISOString(), checks, firstOpenTime, typesWithoutTimes: withoutTimes };
}

/**
 * Runs the activation checks for one calendar, for someone who manages calendars. Read-only; computed as trusted code after the
 * permission check (every query names the workspace), so every host's connected-calendar busy time counts exactly as it does for booking.
 */
export async function verifyCalendar(actor: CrmActor, calendarId: string, opts: { now?: Date } & VerifyOptions = {}): Promise<CalendarVerification> {
  assertCan(actor, "calendars.manage");
  return withSystem(async (db) => {
    await assertNativeOwner(db, actor.orgId, "calendars");
    return verifyCalendarInTx(db, actor.orgId, calendarId, opts.now, opts);
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
export async function activateCalendar(actor: CrmActor, calendarId: string, opts: { now?: Date } & VerifyOptions = {}): Promise<ActivationResult> {
  const result = await activateCalendarTx(actor, calendarId, opts);
  // Committed: the Setup Center's calendar check sees the newly active calendar now rather than at the next scheduled pass (never failing
  // the activation). Nothing changed otherwise, so there is nothing new to pick up.
  if (result.activated) await pickUpSetupEvidence(actor.orgId, "a calendar activation");
  return result;
}

function activateCalendarTx(actor: CrmActor, calendarId: string, opts: { now?: Date } & VerifyOptions): Promise<ActivationResult> {
  assertCan(actor, "calendars.manage");
  const now = opts.now ?? new Date();
  return crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "calendars");
    const lock = await db.query<{ status: CalendarStatus }>("select status from crm_calendars where id = $1 and org_id = $2 and archived_at is null for update", [calendarId, actor.orgId]);
    if (!lock.rows[0]) throw new AppError("not_found", "Calendar not found.");
    const verification = await verifyCalendarInTx(db, actor.orgId, calendarId, now, opts);
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
 * keep them. A host who already has a different time zone is not given hours in the wrong zone: they come back in `needsZoneChoice`, and
 * calling again with `opts.timezone` (the zone the hours are written in) applies them in that zone. Changing other people's hours needs
 * calendar management, as it does in Availability.
 */
export async function applyCalendarHoursTemplate(actor: CrmActor, calendarId: string, opts: { timezone?: string } = {}): Promise<{ applied: string[]; kept: string[]; needsZoneChoice: string[] }> {
  assertCan(actor, "calendars.manage");
  return crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "calendars");
    const hosts = await activeHostsOfCalendar(db, actor.orgId, calendarId);
    const cal = await db.query<{ n: number }>("select jsonb_array_length(hours_template) as n from crm_calendars where id = $1 and org_id = $2 and archived_at is null", [calendarId, actor.orgId]);
    if (!cal.rows[0]) throw new AppError("not_found", "Calendar not found.");
    if (!cal.rows[0].n) throw new AppError("conflict", "This calendar has no suggested hours to use.");
    if (!hosts.length) throw new AppError("conflict", "Assign hosts first, then use the suggested hours for them.");
    const res = await applyHoursTemplateInTx(db, actor.orgId, calendarId, hosts.map((h) => h.userId), opts);
    if (res.applied.length) {
      await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.calendar_hours_applied", targetType: "crm_calendar", targetId: calendarId, result: "success", metadata: { hosts: res.applied.length } }, db);
    }
    return res;
  });
}

/**
 * Makes `hostUserId` the host of a calendar that has no active host, in ONE transaction with the calendar row locked: the "nobody takes bookings yet" decision and the change are
 * never separated, so two people pressing at once (or a host added in between) can never have the second replace the first. A calendar that already has an active host is left
 * exactly as it is (`assigned: false`). Rows of people who are no longer active are replaced. `inTx` runs in the same transaction after the change, for the audit row.
 */
export async function assignHostIfNone(
  actor: CrmActor,
  calendarId: string,
  hostUserId: string,
  inTx?: (db: Queryable) => Promise<void>,
): Promise<{ assigned: boolean }> {
  assertCan(actor, "calendars.manage");
  return crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "calendars");
    const cal = await db.query("select 1 from crm_calendars where id = $1 and org_id = $2 and archived_at is null for update", [calendarId, actor.orgId]);
    if (!cal.rows[0]) throw new AppError("not_found", "Calendar not found.");
    if ((await activeHostsOfCalendar(db, actor.orgId, calendarId)).length > 0) return { assigned: false };
    await assertHosts(db, actor.orgId, [hostUserId]);
    await db.query("delete from crm_calendar_members where calendar_id = $1 and org_id = $2 and user_id <> $3", [calendarId, actor.orgId, hostUserId]);
    await db.query(
      `insert into crm_calendar_members (org_id, calendar_id, user_id, priority) values ($1, $2, $3, 50) on conflict (calendar_id, user_id) do update set priority = excluded.priority, active = true`,
      [actor.orgId, calendarId, hostUserId],
    );
    if (inTx) await inTx(db);
    return { assigned: true };
  });
}

// ---------------------------------------------------------------------------
// The hours a client approves, and what each host has connected
// ---------------------------------------------------------------------------

export interface HoursProposal {
  calendarId: string;
  /** The zone the suggested hours are written in (the draft's own, else the workspace's), never a guess about a host. */
  zone: string;
  rules: ReturnType<typeof parseHoursTemplate>;
  /** The active hosts who have no weekly hours yet: the people these hours would be given to. */
  hosts: Array<{ userId: string; name: string }>;
  /** What the client reads before approving, in words. */
  summary: string;
  /** Covers exactly the hosts, the hours and the zone shown, so an approval of one thing can never apply another. */
  digest: string;
}

/**
 * The weekly hours the calendar suggests (from the client's own answers) and who would receive them: null when the calendar has no suggested hours or when every host already has
 * hours. The digest is recomputed by the server whenever hours are applied, so the client approves exactly what was shown and a host who was added, removed or given hours in the
 * meantime makes the old approval stale. Trusted code: the caller authorized the reader for `orgId`. Reads only.
 */
export async function proposeCalendarHours(db: Queryable, orgId: string, calendarId: string): Promise<HoursProposal | null> {
  const cal = await db.query<{ timezone: string | null; hours_template: unknown; org_timezone: string }>(
    `select c.timezone, c.hours_template, o.timezone as org_timezone from crm_calendars c join organizations o on o.id = c.org_id
      where c.id = $1 and c.org_id = $2 and c.archived_at is null`,
    [calendarId, orgId],
  );
  const row = cal.rows[0];
  if (!row) return null;
  const rules = parseHoursTemplate(row.hours_template);
  if (!rules.length) return null;
  const hosts = (await activeHostsOfCalendar(db, orgId, calendarId)).filter((h) => !h.hasHours).map((h) => ({ userId: h.userId, name: h.name }));
  if (!hosts.length) return null;
  // The same zone applyHoursTemplateInTx writes the hours in when no zone was chosen.
  const zone = row.timezone && isValidTimeZone(row.timezone) ? row.timezone : isValidTimeZone(row.org_timezone) ? row.org_timezone : "UTC";
  const digest = createHash("sha256").update(JSON.stringify({ calendarId, hosts: hosts.map((h) => h.userId).sort(), rules, zone })).digest("hex");
  return { calendarId, zone, rules, hosts, summary: `${summarizeWeeklyHours(rules)} (${zone} time)`, digest };
}

/**
 * Gives the suggested weekly hours to the hosts who have none, and only the hours the client approved: `approvedDigest` must be the digest of what is true right now (the same
 * hosts, hours and zone the client was shown). A missing, wrong or stale digest is refused and changes nothing. This is the one place the launch setup writes working hours: a host
 * added from the questionnaire or by an invitation has none until the client approves them here. The audit row carries the zone and the hours. Needs calendar management.
 */
export async function applyApprovedCalendarHours(actor: CrmActor, calendarId: string, approvedDigest: string | undefined): Promise<{ applied: string[]; kept: string[]; needsZoneChoice: string[] }> {
  assertCan(actor, "calendars.manage");
  return crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "calendars");
    const lock = await db.query<{ n: number }>("select jsonb_array_length(hours_template) as n from crm_calendars where id = $1 and org_id = $2 and archived_at is null for update", [calendarId, actor.orgId]);
    if (!lock.rows[0]) throw new AppError("not_found", "Calendar not found.");
    if (!lock.rows[0].n) throw new AppError("conflict", "This calendar has no suggested hours to use.");
    const proposal = await proposeCalendarHours(db, actor.orgId, calendarId);
    if (!proposal) {
      const hosts = await activeHostsOfCalendar(db, actor.orgId, calendarId);
      if (!hosts.length) throw new AppError("conflict", "Assign hosts first, then use the suggested hours for them.");
      // Everyone already has hours: there is nothing to approve and nothing to change.
      return { applied: [], kept: hosts.map((h) => h.userId), needsZoneChoice: [] };
    }
    if (!approvedDigest || approvedDigest !== proposal.digest) {
      throw new AppError("conflict", "The hosts or hours changed since you looked at them. Review the hours shown and approve them again. Nothing was saved.");
    }
    const res = await applyHoursTemplateInTx(db, actor.orgId, calendarId, proposal.hosts.map((h) => h.userId));
    if (res.applied.length) {
      await recordAudit({
        orgId: actor.orgId, ...auditActor(actor), action: "crm.calendar_hours_applied", targetType: "crm_calendar", targetId: calendarId, result: "success",
        metadata: { hosts: res.applied.length, approved: true, zone: proposal.zone, hours: proposal.summary, digest: proposal.digest },
      }, db);
    }
    return res;
  });
}

/** What one host has connected, as the calendar needs it: strict, per host, and never the account itself. */
export interface HostConnectionState {
  userId: string;
  name: string;
  /** A connected account that can add events (the only kind that can make a Google Meet or Teams link). Another person's account, an ICS feed or CalDAV never counts. */
  meet: { google: boolean; microsoft: boolean };
  /** A connected account of the provider that is being read for busy times, recently enough to trust. */
  busy: { google: boolean; microsoft: boolean };
}

/**
 * For each host: whether they have connected what a meeting link needs and whether their calendar is being read for busy times. The same rules as the activation checks above
 * (verifyCalendarInTx), per person instead of for the whole calendar. Trusted code: every query names the workspace. Reads only.
 */
export async function hostConnectionStates(db: Queryable, orgId: string, hosts: ReadonlyArray<{ userId: string; name: string }>, now: Date = new Date()): Promise<HostConnectionState[]> {
  if (!hosts.length) return [];
  const { rows } = await db.query<{ user_id: string; provider: "google" | "microsoft"; write_ready: boolean; check_conflicts: boolean; read_at: Date }>(
    `select user_id, provider, (write_events and external_calendar_id is not null) as write_ready, check_conflicts, coalesce(last_success_at, created_at) as read_at
       from crm_calendar_connections
      where org_id = $1 and user_id = any($2::uuid[]) and status = 'connected' and provider in ('google', 'microsoft')`,
    [orgId, hosts.map((h) => h.userId)],
  );
  return hosts.map((h) => {
    const mine = rows.filter((r) => r.user_id === h.userId);
    const meet = (p: "google" | "microsoft") => mine.some((r) => r.provider === p && r.write_ready);
    const busy = (p: "google" | "microsoft") => mine.some((r) => r.provider === p && r.check_conflicts && new Date(r.read_at).getTime() >= now.getTime() - 3 * pollMinutesFor(p) * 60_000);
    return { userId: h.userId, name: h.name, meet: { google: meet("google"), microsoft: meet("microsoft") }, busy: { google: busy("google"), microsoft: busy("microsoft") } };
  });
}
