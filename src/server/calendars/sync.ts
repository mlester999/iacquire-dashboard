import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import { notifyUser } from "@/server/notifications";
import { sha256 } from "@/server/security/crypto";
import { assertCan, type CrmActor } from "@/server/crm/actor";
import { ghlOwnsSql, switchingSql } from "@/server/crm/provider-guard";
import { assertConnectionOwner, markNeedsReauth, openConnection, pollMinutesFor, PROVIDER_LABELS, type ConnectionHandle, type SyncState } from "@/server/calendars/connections";
import { isProviderError, type BusyResult, type ExistingEvent, type OutboundEvent } from "@/server/calendars/adapters/types";

// Background work for connected calendars, run by the scheduler (src/server/ops/tick.ts):
//
//  * Busy sync: for each connection that is due (claimed with FOR UPDATE SKIP LOCKED, so overlapping runs never share one), read the
//    chosen calendars' busy times over a rolling window and replace this connection's crm_external_busy rows with them. Only times are
//    kept. Events this workspace wrote itself are left out, or a booking would block its own reschedule. Auth failures ask the person to
//    reconnect (once); rate limits and outages back off.
//  * Write-back: native appointments a person hosts are added to their calendar when they chose that, updated when they change, and
//    removed when cancelled. A hash of what was written makes an unchanged appointment a no-op, and a stable id per appointment makes a
//    retried create find the event it already made.
//
// CALENDAR_SYNC_DISABLED stops both without disconnecting anyone.

const DAY = 86_400_000;
const FULL_REFRESH_MS = 6 * 3600_000;
/** Marks a written event whose appointment was cancelled (or moved to another host) and whose remote copy was removed. */
export const DELETED_HASH = sha256("iacquire:calendar-event-deleted");

export const syncPaused = () => env().CALENDAR_SYNC_DISABLED;

/** The window busy times are kept for: yesterday through the furthest any of the person's appointment types can be booked (62–366 days). */
async function busyWindow(db: Queryable, h: Pick<ConnectionHandle, "orgId" | "userId">, now: Date): Promise<{ from: Date; to: Date }> {
  const { rows } = await db.query<{ days: number | null }>(
    `select max(t.max_days_ahead) as days from crm_appointment_types t join crm_calendar_members m on m.calendar_id = t.calendar_id and m.org_id = t.org_id
     where t.org_id = $1 and m.user_id = $2 and m.active and t.archived_at is null`,
    [h.orgId, h.userId],
  );
  const days = Math.min(366, Math.max(62, Number(rows[0]?.days ?? 0)));
  return { from: new Date(now.getTime() - DAY), to: new Date(now.getTime() + (days + 1) * DAY) };
}

export const externalRef = (connectionId: string, eventId: string, instanceStart: string) => sha256(`${connectionId}:${eventId}:${instanceStart}`);

/**
 * Every identity an event this workspace wrote for the person can show up under, across all of their connections in the workspace: the
 * provider's event id (Google event id, Graph id, CalDAV address) and the UIDs our writes carry, which is what a feed or CalDAV read of
 * the same calendar sees: CalDAV `iaq-<key>@iacquire`, and Google's iCalendar export `<event id>@google.com`. The key is the same
 * per-connection idempotency key `outboundFor` uses, so it can be worked out for every written appointment.
 */
async function ownEventIds(h: Pick<ConnectionHandle, "orgId" | "userId">): Promise<Set<string>> {
  const { rows } = await withSystem((db) =>
    db.query<{ external_event_id: string; connection_id: string; appointment_id: string }>(
      `select e.external_event_id, e.connection_id, e.appointment_id from crm_external_events e
       join crm_calendar_connections c on c.id = e.connection_id and c.org_id = e.org_id
       where e.org_id = $1 and c.user_id = $2`,
      [h.orgId, h.userId],
    ),
  );
  const own = new Set<string>();
  for (const r of rows) {
    own.add(r.external_event_id);
    const key = sha256(`${r.connection_id}:${r.appointment_id}`).slice(0, 40);
    own.add(`iaq-${key}@iacquire`);
    own.add(`iaq${key}`);
    own.add(`iaq${key}@google.com`);
  }
  return own;
}

const errorText = (err: unknown) => (isProviderError(err) ? err.message : err instanceof AppError ? err.message : "Calendar sync failed unexpectedly.").slice(0, 300);

async function recordRun(db: Queryable, h: Pick<ConnectionHandle, "id" | "orgId">, kind: "busy" | "write", status: "ok" | "partial" | "failed", started: Date, counts: Record<string, number | boolean>, error: string | null) {
  await db.query(
    "insert into crm_calendar_sync_runs (org_id, connection_id, kind, status, started_at, finished_at, counts, error) values ($1, $2, $3, $4, $5, now(), $6::jsonb, $7)",
    [h.orgId, h.id, kind, status, started, JSON.stringify(counts), error],
  );
  // History stays short: the most recent 60 runs per connection.
  await db.query(
    `delete from crm_calendar_sync_runs where connection_id = $1 and id not in (select id from crm_calendar_sync_runs where connection_id = $1 order by started_at desc, id desc limit 60)`,
    [h.id],
  );
}

async function saveState(db: Queryable, id: string, patch: Partial<SyncState>) {
  await db.query("update crm_calendar_connections set sync_cursors = coalesce(sync_cursors, '{}'::jsonb) || $2::jsonb where id = $1", [id, JSON.stringify(patch)]);
}

// ---------------------------------------------------------------------------
// Busy sync
// ---------------------------------------------------------------------------

export interface BusySyncOutcome {
  status: "ok" | "unchanged" | "failed" | "needs_reauth" | "skipped";
  busy?: number;
  error?: string;
}

/** Applies a busy read: upserts every interval by its stable reference and deletes this connection's rows that are no longer there. */
async function applyBusy(db: Queryable, h: ConnectionHandle, res: BusyResult, calendars: string[], now: Date, started: Date) {
  // A disconnect that happened while we were reading wins: its busy times were deleted and must stay deleted.
  const live = await db.query<{ status: string }>("select status from crm_calendar_connections where id = $1 for update", [h.id]);
  if (!["connected", "error"].includes(live.rows[0]?.status ?? "")) return;
  if (res.busy) {
    const byRef = new Map<string, { s: string; e: string }>();
    for (const b of res.busy) byRef.set(externalRef(h.id, b.eventId, b.instanceStart), { s: new Date(b.start).toISOString(), e: new Date(b.end).toISOString() });
    const refs = [...byRef.keys()];
    const starts = refs.map((r) => byRef.get(r)!.s);
    const ends = refs.map((r) => byRef.get(r)!.e);
    for (let i = 0; i < refs.length; i += 1000) {
      await db.query(
        `insert into crm_external_busy (org_id, connection_id, user_id, external_ref, starts_at, ends_at, synced_at)
         select $1, $2, $3, t.ref, t.s, t.e, now() from unnest($4::text[], $5::timestamptz[], $6::timestamptz[]) as t(ref, s, e)
         on conflict (connection_id, external_ref) do update set starts_at = excluded.starts_at, ends_at = excluded.ends_at, synced_at = now()`,
        [h.orgId, h.id, h.userId, refs.slice(i, i + 1000), starts.slice(i, i + 1000), ends.slice(i, i + 1000)],
      );
    }
    await db.query("delete from crm_external_busy where connection_id = $1 and not (external_ref = any($2::text[]))", [h.id, refs]);
  }
  const state: Partial<SyncState> = { calendars: res.cursors, ...(res.busy ? { fullSet: calendars.join("\n"), fullAt: now.toISOString() } : {}) };
  await saveState(db, h.id, state);
  await db.query(
    `update crm_calendar_connections set status = 'connected', last_synced_at = $2, last_success_at = $2, last_error = null, consecutive_failures = 0,
       next_sync_at = $2::timestamptz + make_interval(mins => $3::int) where id = $1 and status in ('connected', 'error')`,
    [h.id, now, pollMinutesFor(h.provider)],
  );
  await recordRun(db, h, "busy", "ok", started, { ...res.counts, unchanged: !res.busy }, null);
}

/** A failed read: auth problems ask the person to reconnect; everything else retries later with a growing delay. */
async function recordBusyFailure(db: Queryable, h: ConnectionHandle, err: unknown, now: Date, started: Date): Promise<BusySyncOutcome> {
  const message = errorText(err);
  if (isProviderError(err) && err.kind === "auth") {
    await markNeedsReauth(db, h, message);
    await recordRun(db, h, "busy", "failed", started, {}, message);
    return { status: "needs_reauth", error: message };
  }
  const failures = h.consecutiveFailures + 1;
  const poll = pollMinutesFor(h.provider);
  const retryAfter = isProviderError(err) && err.retryAfterSeconds ? Math.ceil(err.retryAfterSeconds / 60) : 0;
  const delay = Math.min(360, Math.max(retryAfter, poll * 2 ** Math.min(failures - 1, 6)));
  const since = h.lastSuccessAt ?? h.createdAt;
  // A day of failures: stop treating it as working (and say so once). It keeps retrying hourly or slower.
  const broken = failures >= 6 && now.getTime() - new Date(since).getTime() > DAY;
  await db.query(
    `update crm_calendar_connections set consecutive_failures = $2, last_error = $3, last_synced_at = $4, status = case when $5 then 'error' else status end,
       next_sync_at = $4::timestamptz + make_interval(mins => $6::int) where id = $1 and status in ('connected', 'error')`,
    [h.id, failures, message, now, broken, delay],
  );
  if (broken && h.status !== "error") {
    await notifyUser(db, h.userId, h.orgId, {
      kind: "crm_calendar_sync", severity: "warning", title: `Your ${PROVIDER_LABELS[h.provider]} isn't syncing`,
      body: `${h.accountLabel}: ${message} Busy times from it aren't being checked until it syncs again.`, link: "/crm/calendar-connections",
      dedupeKey: `crm-cal-error:${h.id}:${new Date(since).getTime()}`,
    });
  }
  await recordRun(db, h, "busy", "failed", started, { failures }, message);
  return { status: "failed", error: message };
}

/** Reads one connection's busy times now. Idempotent: running it twice leaves the same rows. */
export async function syncConnectionBusy(id: string, opts: { now?: Date; force?: boolean } = {}): Promise<BusySyncOutcome> {
  const now = opts.now ?? new Date();
  const started = new Date();
  const h = await openConnection(id);
  if (!h || (h.status !== "connected" && h.status !== "error")) return { status: "skipped" };
  if (!h.checkConflicts) {
    await withSystem(async (db) => {
      await db.query("delete from crm_external_busy where connection_id = $1", [h.id]);
      await db.query("update crm_calendar_connections set last_synced_at = $2, next_sync_at = $2::timestamptz + make_interval(mins => $3::int) where id = $1", [h.id, now, pollMinutesFor(h.provider)]);
    });
    return { status: "ok", busy: 0 };
  }
  const available = new Set(h.calendars.map((c) => c.id));
  let calendars = h.conflictCalendarIds.filter((c) => available.has(c));
  if (!calendars.length) calendars = h.calendars.filter((c) => c.primary).map((c) => c.id).slice(0, 1);
  const window = await withSystem((db) => busyWindow(db, h, now));
  const fullAt = h.state.fullAt ? Date.parse(h.state.fullAt) : 0;
  const forceFull = !!opts.force || !fullAt || now.getTime() - fullAt > FULL_REFRESH_MS || h.state.fullSet !== calendars.join("\n");
  const own = await ownEventIds(h);
  try {
    const res = await h.adapter.readBusy(h.auth, {
      calendarIds: calendars, from: window.from, to: window.to, cursors: h.state.calendars ?? {}, forceFull, timeZone: h.timeZone,
      isOwnEvent: (eventId, marker) => own.has(eventId) || (!!marker?.appointmentId && marker.workspaceId === h.orgId),
    });
    await withSystem((db) => applyBusy(db, h, res, calendars, now, started));
    return { status: res.busy ? "ok" : "unchanged", busy: res.busy?.length };
  } catch (err) {
    return withSystem((db) => recordBusyFailure(db, h, err, now, started));
  }
}

/** The scheduler's busy-sync pass: claims due connections (a ten-minute lease), reads each, and reports how many were synced. */
export async function syncDueConnections(opts: { now?: Date; limit?: number; budgetMs?: number } = {}): Promise<{ synced: number; failed: number; paused: boolean }> {
  if (syncPaused()) return { synced: 0, failed: 0, paused: true };
  const now = opts.now ?? new Date();
  const { rows } = await withSystem((db) =>
    db.query<{ id: string }>(
      `update crm_calendar_connections set next_sync_at = $1::timestamptz + interval '10 minutes'
       where id in (select id from crm_calendar_connections where status in ('connected', 'error') and credentials is not null
                    and coalesce(next_sync_at, '-infinity'::timestamptz) <= $1 order by next_sync_at nulls first limit $2 for update skip locked)
       returning id`,
      [now, Math.min(100, opts.limit ?? 25)],
    ),
  );
  let synced = 0;
  let failed = 0;
  // A slow provider mustn't hold up the rest of the scheduler: past the time budget, unclaim what's left for the next run.
  const deadline = Date.now() + (opts.budgetMs ?? 60_000);
  for (const [i, r] of rows.entries()) {
    if (Date.now() > deadline) {
      const rest = rows.slice(i).map((x) => x.id);
      await withSystem((db) => db.query("update crm_calendar_connections set next_sync_at = $2 where id = any($1::uuid[])", [rest, now]));
      break;
    }
    const out = await syncConnectionBusy(r.id, { now }).catch(() => ({ status: "failed" as const }));
    if (out.status === "ok" || out.status === "unchanged") synced++;
    else if (out.status !== "skipped") failed++;
  }
  return { synced, failed, paused: false };
}

/** "Sync now" from the connections screen: the person's own connection, at most once a minute, also refreshing its calendar list. */
export async function syncConnectionNow(actor: CrmActor, id: string): Promise<BusySyncOutcome> {
  assertCan(actor, "appointments.view");
  await assertConnectionOwner(actor, id);
  if (syncPaused()) throw new AppError("integration_unavailable", "Calendar sync is paused by iAcquire right now. Your connection is kept; it will sync again when it resumes.");
  const recent = await withSystem((db) => db.query("select 1 from crm_calendar_sync_runs where connection_id = $1 and kind = 'busy' and started_at > now() - interval '1 minute'", [id]));
  if (recent.rows.length) throw new AppError("rate_limited", "This calendar synced less than a minute ago. Try again shortly.");
  const h = await openConnection(id);
  if (!h) throw new AppError("conflict", "This connection needs to be reconnected before it can sync.");
  try {
    const calendars = await h.adapter.listCalendars(h.auth);
    if (calendars.length) await withSystem((db) => db.query("update crm_calendar_connections set available_calendars = $2::jsonb where id = $1", [id, JSON.stringify(calendars.slice(0, 200))]));
  } catch (err) {
    if (isProviderError(err) && err.kind === "auth") {
      await withSystem((db) => markNeedsReauth(db, h, err.message));
      return { status: "needs_reauth", error: err.message };
    }
    // The calendar list is a convenience; the busy read below reports real failures.
  }
  return syncConnectionBusy(id, { force: true });
}

// ---------------------------------------------------------------------------
// Write-back
// ---------------------------------------------------------------------------

interface PendingRow {
  id: string;
  status: string;
  start_at: Date;
  end_at: Date;
  location: string | null;
  meeting_link: string | null;
  assigned_user_id: string | null;
  version: number;
  type_name: string | null;
  meeting_provider: string | null;
  first_name: string | null;
  display_name: string | null;
  hosting: boolean;
  e_event_id: string | null;
  e_calendar_id: string | null;
  e_etag: string | null;
  e_hash: string | null;
  e_meeting_link: string | null;
  e_last_error: string | null;
  e_updated_at: Date | null;
}

const LIVE = "('new', 'confirmed')";
const HOSTING = "exists (select 1 from crm_appointment_hosts h where h.appointment_id = a.id and h.user_id = c.user_id)";

/**
 * Appointments with something to do on this connection: live ones the person hosts that aren't written yet (or changed since, are on
 * another calendar, are waiting for a meeting link, or are due a periodic check), and written ones that were cancelled or moved to
 * someone else.
 *
 * "Changed since" compares the appointment's version with the version the last write was built from (`written_version`), never clock
 * times: a reschedule that commits while a write is in flight bumps the version past what that write read, so the next pass sends it,
 * however its timestamps compare with the write's.
 */
const pending = (now: string) => `a.org_id = c.org_id and a.provider = 'native' and (
  (a.status in ${LIVE} and a.end_at > ${now}::timestamptz - interval '1 day' and ${HOSTING} and (
     e.appointment_id is null or e.content_hash = '${DELETED_HASH}' or e.content_hash is null
     or e.written_version is distinct from a.version
     or e.remote_calendar_id is distinct from c.external_calendar_id
     or (e.last_error = 'meeting_pending' and e.updated_at < ${now}::timestamptz - interval '1 minute')
     or (e.synced_at < ${now}::timestamptz - interval '6 hours' and a.start_at > ${now}::timestamptz)))
  or (e.appointment_id is not null and e.content_hash is distinct from '${DELETED_HASH}' and (
     a.status not in ('new', 'confirmed', 'showed', 'noshow') or not ${HOSTING})))`;

const appUrl = () => env().APP_URL.replace(/\/+$/, "");

/** Exactly what is written for one appointment, and its hash. No answers, contact details, notes or manage link. */
export function outboundFor(h: Pick<ConnectionHandle, "id" | "orgId" | "timeZone">, a: PendingRow, conference: OutboundEvent["conference"], calendarId: string): { ev: OutboundEvent; hash: string } {
  const firstName = (a.first_name?.trim() || a.display_name?.trim().split(/\s+/)[0] || "").slice(0, 60);
  const typeName = (a.type_name || "Appointment").slice(0, 120);
  const title = (firstName ? `${typeName} with ${firstName}` : typeName).slice(0, 200);
  // Another host's join link is shown in the description; the host whose calendar created it already has it on the event.
  const link = a.meeting_link && a.meeting_link !== a.e_meeting_link ? a.meeting_link : null;
  const description = [
    "Booked with iAcquire.",
    `Appointment type: ${typeName}`,
    ...(a.location ? [`Where: ${a.location}`] : []),
    ...(link ? [`Join: ${link}`] : []),
    `Details: ${appUrl()}/crm/calendar?appointment=${a.id}`,
  ].join("\n");
  const ev: OutboundEvent = {
    appointmentId: a.id, workspaceId: h.orgId, idempotencyKey: sha256(`${h.id}:${a.id}`), title,
    start: new Date(a.start_at), end: new Date(a.end_at), timeZone: h.timeZone, location: a.location, description,
    tentative: a.status === "new", conference, sequence: Math.max(0, a.version - 1),
  };
  const hash = sha256(JSON.stringify({ title, start: ev.start.toISOString(), end: ev.end.toISOString(), location: ev.location, description, tentative: ev.tentative, calendarId }));
  return { ev, hash };
}

function conferenceFor(h: ConnectionHandle, a: PendingRow): OutboundEvent["conference"] {
  // Only the assigned host's own calendar creates the meeting, so a collective booking gets one link, not one per host.
  if (a.assigned_user_id !== h.userId) return null;
  if (a.meeting_link && a.meeting_link !== a.e_meeting_link) return null;
  if (a.meeting_provider === "google_meet" && h.provider === "google" && h.calendars.find((c) => c.id === h.writeCalendarId)?.meetings?.includes("hangoutsMeet") !== false) return "google_meet";
  if (a.meeting_provider === "microsoft_teams" && h.provider === "microsoft" && h.calendars.find((c) => c.id === h.writeCalendarId)?.meetings?.includes("teamsForBusiness")) return "microsoft_teams";
  return null;
}

async function saveWritten(db: Queryable, h: ConnectionHandle, a: PendingRow, r: { eventId: string; calendarId: string; etag: string | null; meetingLink: string | null; meetingPending: boolean }, hash: string, conference: OutboundEvent["conference"]) {
  const link = r.meetingLink ?? (a.e_event_id === r.eventId ? a.e_meeting_link : null);
  await db.query(
    `insert into crm_external_events (org_id, appointment_id, connection_id, external_event_id, meeting_link, remote_calendar_id, etag, content_hash, last_error, written_version, synced_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), now())
     on conflict (appointment_id, connection_id) do update set external_event_id = excluded.external_event_id, meeting_link = excluded.meeting_link,
       remote_calendar_id = excluded.remote_calendar_id, etag = excluded.etag, content_hash = excluded.content_hash, last_error = excluded.last_error,
       written_version = excluded.written_version, synced_at = now(), updated_at = now()`,
    [h.orgId, a.id, h.id, r.eventId.slice(0, 500), link, r.calendarId.slice(0, 300), r.etag?.slice(0, 300) ?? null, hash, r.meetingPending ? "meeting_pending" : null, a.version],
  );
  // The join link goes on the appointment only when the provider really returned one, and never over a link someone set.
  if (conference && r.meetingLink) await db.query("update appointment_refs set meeting_link = $3 where id = $1 and org_id = $2 and meeting_link is null", [a.id, h.orgId, r.meetingLink]);
}

async function markDeleted(db: Queryable, h: ConnectionHandle, appointmentId: string) {
  await db.query(
    "update crm_external_events set content_hash = $3, etag = null, last_error = null, synced_at = now(), updated_at = now() where appointment_id = $1 and connection_id = $2",
    [appointmentId, h.id, DELETED_HASH],
  );
}

export interface WriteBackCounts {
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
  failed: number;
  meetingLinks: number;
}

/**
 * Whether iAcquire must not write this workspace's appointments to outside calendars right now: it is switching CRM providers, or
 * GoHighLevel owns its calendars (the same rule the lease query applies, checked again because a cutover can commit after the lease).
 */
async function writesHeld(orgId: string): Promise<boolean> {
  const { rows } = await withSystem((db) => db.query<{ held: boolean }>(`select (${switchingSql("$1::uuid")} or ${ghlOwnsSql("$1::uuid", "calendars")}) as held`, [orgId]));
  return rows[0]?.held === true;
}

/** Writes one connection's pending appointments. Returns what happened; throws only for an auth failure (the caller marks it). */
async function writeConnection(h: ConnectionHandle, now: Date, limit: number): Promise<{ counts: WriteBackCounts; lastError: string | null }> {
  const counts: WriteBackCounts = { created: 0, updated: 0, deleted: 0, unchanged: 0, failed: 0, meetingLinks: 0 };
  let lastError: string | null = null;
  const adapter = h.adapter;
  if (!adapter.upsertEvent || !adapter.deleteEvent || !h.writeCalendarId) return { counts, lastError };
  const writeCal = h.writeCalendarId;
  const { rows } = await withSystem((db) =>
    db.query<PendingRow>(
      `select a.id, a.status, a.start_at, a.end_at, a.location, a.meeting_link, a.assigned_user_id, a.version,
              t.name as type_name, t.meeting_provider, ct.first_name, ct.display_name, ${HOSTING} as hosting,
              e.external_event_id as e_event_id, e.remote_calendar_id as e_calendar_id, e.etag as e_etag, e.content_hash as e_hash,
              e.meeting_link as e_meeting_link, e.last_error as e_last_error, e.updated_at as e_updated_at
       from crm_calendar_connections c
       join appointment_refs a on a.org_id = c.org_id
       left join crm_external_events e on e.appointment_id = a.id and e.connection_id = c.id
       left join crm_appointment_types t on t.id = a.appointment_type_id and t.org_id = a.org_id
       left join contacts ct on ct.id = a.contact_id and ct.org_id = a.org_id
       where c.id = $1 and ${pending("$2")}
       order by a.start_at limit $3`,
      [h.id, now, limit],
    ),
  );
  for (const a of rows) {
    // A provider switch that started after the lease (or GoHighLevel taking the calendars): stop here; the rest stays pending. A write
    // already sent can't be called back, so at most the one in flight finishes after the cutover.
    if (await writesHeld(h.orgId)) break;
    const existing: ExistingEvent | null = a.e_event_id && a.e_hash !== DELETED_HASH ? { eventId: a.e_event_id, calendarId: a.e_calendar_id ?? writeCal, etag: a.e_etag } : null;
    try {
      const live = (a.status === "new" || a.status === "confirmed") && a.hosting;
      if (!live) {
        if (existing) await adapter.deleteEvent(h.auth, existing);
        await withSystem((db) => markDeleted(db, h, a.id));
        counts.deleted++;
        continue;
      }
      // Moved to another calendar: take it off the old one first.
      let target = existing;
      if (existing && existing.calendarId !== writeCal) {
        await adapter.deleteEvent(h.auth, existing).catch((err) => {
          if (isProviderError(err) && err.kind === "auth") throw err;
        });
        target = null;
      }
      const conference = conferenceFor(h, a);
      const { ev, hash } = outboundFor(h, a, conference, writeCal);
      if (target && a.e_hash === hash) {
        if (a.e_last_error === "meeting_pending" && adapter.meetingLink) {
          const m = await adapter.meetingLink(h.auth, target);
          const stale = a.e_updated_at && now.getTime() - new Date(a.e_updated_at).getTime() > 3600_000;
          await withSystem(async (db) => {
            await db.query(
              `update crm_external_events set meeting_link = coalesce($3, meeting_link), last_error = $4, written_version = $6, synced_at = now(),
                 updated_at = case when $3::text is null and not $5 then updated_at else now() end where appointment_id = $1 and connection_id = $2`,
              [a.id, h.id, m.link, m.link ? null : m.pending && !stale ? "meeting_pending" : "meeting_link_not_returned", !m.pending, a.version],
            );
            if (m.link && conference) await db.query("update appointment_refs set meeting_link = $3 where id = $1 and org_id = $2 and meeting_link is null", [a.id, h.orgId, m.link]);
          });
          if (m.link) counts.meetingLinks++;
          continue;
        }
        // Same content as last written: nothing to send. The version it was checked at is recorded, so only a later change brings it back.
        await withSystem((db) => db.query("update crm_external_events set written_version = $3, synced_at = now(), updated_at = now() where appointment_id = $1 and connection_id = $2", [a.id, h.id, a.version]));
        counts.unchanged++;
        continue;
      }
      const result = await adapter.upsertEvent(h.auth, writeCal, target, ev);
      await withSystem((db) => saveWritten(db, h, a, result, hash, conference));
      if (target) counts.updated++;
      else counts.created++;
      if (result.meetingLink && conference) counts.meetingLinks++;
    } catch (err) {
      if (isProviderError(err) && err.kind === "auth") throw err;
      counts.failed++;
      lastError = errorText(err);
      if (a.e_event_id) {
        await withSystem((db) => db.query("update crm_external_events set last_error = $3 where appointment_id = $1 and connection_id = $2", [a.id, h.id, lastError])).catch(() => undefined);
      }
      // Throttled or down: stop here and let the backoff pace the rest.
      if (isProviderError(err) && (err.kind === "rate_limited" || err.kind === "unavailable")) break;
    }
  }
  return { counts, lastError };
}

/** The scheduler's write-back pass over connections that write events and have pending appointments. */
export async function writeBackDue(opts: { now?: Date; connections?: number; perConnection?: number; budgetMs?: number } = {}): Promise<{ written: number; deleted: number; failed: number; paused: boolean }> {
  if (syncPaused()) return { written: 0, deleted: 0, failed: 0, paused: true };
  const now = opts.now ?? new Date();
  const { rows } = await withSystem((db) =>
    db.query<{ id: string; org_id: string }>(
      `update crm_calendar_connections set sync_cursors = coalesce(sync_cursors, '{}'::jsonb) || jsonb_build_object('writeLeaseUntil', ($1::timestamptz + interval '5 minutes')::text)
       where id in (
         select c.id from crm_calendar_connections c
         where c.status = 'connected' and c.write_events and c.external_calendar_id is not null and c.provider <> 'ics' and c.credentials is not null
           -- A workspace switching CRM providers writes nothing to outside calendars until the switch finishes, and one whose calendars
           -- GoHighLevel owns writes nothing from iAcquire at all (the pending writes stay pending, so nothing is lost).
           and not ${switchingSql("c.org_id")} and not ${ghlOwnsSql("c.org_id", "calendars")}
           and coalesce((c.sync_cursors->>'writeLeaseUntil')::timestamptz, '-infinity'::timestamptz) < $1
           and coalesce((c.sync_cursors->>'writeRetryAt')::timestamptz, '-infinity'::timestamptz) <= $1
           and exists (select 1 from appointment_refs a left join crm_external_events e on e.appointment_id = a.id and e.connection_id = c.id where ${pending("$1")})
         order by coalesce((c.sync_cursors->>'writeLeaseUntil')::timestamptz, '-infinity'::timestamptz) limit $2 for update skip locked)
       returning id, org_id`,
      [now, Math.min(50, opts.connections ?? 10)],
    ),
  );
  let written = 0;
  let deleted = 0;
  let failed = 0;
  const deadline = Date.now() + (opts.budgetMs ?? 60_000);
  for (const [i, { id, org_id }] of rows.entries()) {
    if (Date.now() > deadline) {
      for (const rest of rows.slice(i)) await withSystem((db) => saveState(db, rest.id, { writeLeaseUntil: null }));
      break;
    }
    // Leased just before its workspace started a provider switch: give the lease back, with no failure counted (the writes stay pending).
    if (await writesHeld(org_id)) {
      await withSystem((db) => saveState(db, id, { writeLeaseUntil: null }));
      continue;
    }
    const started = new Date();
    const h = await openConnection(id);
    if (!h) continue;
    try {
      const { counts, lastError } = await writeConnection(h, now, Math.min(100, opts.perConnection ?? 25));
      written += counts.created + counts.updated;
      deleted += counts.deleted;
      failed += counts.failed;
      const failures = counts.failed ? (h.state.writeFailures ?? 0) + 1 : 0;
      await withSystem(async (db) => {
        await saveState(db, h.id, {
          writeLeaseUntil: null, writeFailures: failures,
          writeRetryAt: failures ? new Date(now.getTime() + Math.min(60, 5 * 2 ** Math.min(failures - 1, 4)) * 60_000).toISOString() : null,
        });
        if (counts.created + counts.updated + counts.deleted + counts.failed + counts.meetingLinks > 0) {
          await recordRun(db, h, "write", counts.failed ? (counts.created + counts.updated + counts.deleted ? "partial" : "failed") : "ok", started, { ...counts }, lastError);
        }
      });
    } catch (err) {
      failed++;
      await withSystem(async (db) => {
        await saveState(db, h.id, { writeLeaseUntil: null });
        if (isProviderError(err) && err.kind === "auth") await markNeedsReauth(db, h, err.message);
        await recordRun(db, h, "write", "failed", started, {}, errorText(err));
      });
    }
  }
  return { written, deleted, failed, paused: false };
}
