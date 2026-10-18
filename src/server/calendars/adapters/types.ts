import "server-only";

// The contract every external calendar provider implements, so connection, busy-sync and write-back code never branches on the
// provider's wire format. Adapters only talk HTTP; they never touch the database, never see more than the one connection's credentials,
// and never put tokens, passwords or response bodies into an error message.

export type CalendarProvider = "google" | "microsoft" | "caldav" | "ics";
export const CALENDAR_PROVIDERS: readonly CalendarProvider[] = ["google", "microsoft", "caldav", "ics"];

/** One of the person's calendars, as the provider listed it. Stored in crm_calendar_connections.available_calendars (no event data). */
export interface RemoteCalendar {
  id: string;
  name: string;
  primary: boolean;
  canWrite: boolean;
  timezone: string | null;
  /** Online-meeting kinds the provider can attach on this calendar ("hangoutsMeet", "teamsForBusiness"). */
  meetings?: string[];
}

/** One busy period read from a calendar: times only. `eventId` + `instanceStart` identify it for crm_external_busy.external_ref. */
export interface BusyInterval {
  calendarId: string;
  eventId: string;
  /** The instance's original start (ISO), stable across edits of one instance. */
  instanceStart: string;
  start: number;
  end: number;
}

/** Per-calendar incremental sync state kept in crm_calendar_connections.sync_cursors. */
export interface CalendarCursor {
  /** Google nextSyncToken. */
  syncToken?: string;
  /** HTTP ETag of an ICS feed. */
  etag?: string;
  /** CalDAV collection tag (CalendarServer getctag or DAV:sync-token). */
  ctag?: string;
  /** When this calendar was last read in full (ISO). */
  fullAt?: string;
}

export interface BusyQuery {
  calendarIds: string[];
  from: Date;
  to: Date;
  cursors: Record<string, CalendarCursor>;
  /** True when a full read of every calendar is needed regardless of cursors (window moved, set changed). */
  forceFull: boolean;
  /** Events this workspace wrote itself: never counted as busy, or a booking would block its own reschedule. */
  isOwnEvent: (eventId: string, marker?: { appointmentId?: string | null; workspaceId?: string | null }) => boolean;
  /** The calendar owner's IANA zone, for floating and all-day times. */
  timeZone: string;
}

export interface BusyResult {
  /** Null when nothing changed since the cursors: the stored busy rows are still right. */
  busy: BusyInterval[] | null;
  cursors: Record<string, CalendarCursor>;
  counts: { calendars: number; events: number; busy: number; ownSkipped: number; free: number; unsupported: number };
}

/** What the workspace writes for one appointment. Never includes the customer's answers, contact details or manage link. */
export interface OutboundEvent {
  appointmentId: string;
  workspaceId: string;
  /** 64 hex characters, stable per connection and appointment: makes a retried create find the event it already made. */
  idempotencyKey: string;
  title: string;
  start: Date;
  end: Date;
  timeZone: string;
  location: string | null;
  description: string;
  tentative: boolean;
  /** Ask the provider to create an online meeting (only on the host's own connection and only when the provider supports it). */
  conference: "google_meet" | "microsoft_teams" | null;
  /** CalDAV: incremented on each update. */
  sequence: number;
}

export interface ExistingEvent {
  eventId: string;
  calendarId: string;
  etag: string | null;
}

export interface WriteResult {
  eventId: string;
  calendarId: string;
  etag: string | null;
  /** A join link the provider actually returned (https only). Never invented. */
  meetingLink: string | null;
  /** The provider accepted a meeting request but hasn't produced the link yet. */
  meetingPending: boolean;
}

/** Authorization for one connection's requests, refreshed by the caller when the provider says it expired. */
export interface AuthSession {
  headers(): Promise<Record<string, string>>;
  /** Called once after a 401. True when new credentials were obtained and the request may be retried. */
  refresh(): Promise<boolean>;
}

export interface CalendarAdapter {
  provider: CalendarProvider;
  listCalendars(auth: AuthSession): Promise<RemoteCalendar[]>;
  readBusy(auth: AuthSession, q: BusyQuery): Promise<BusyResult>;
  /** Absent for read-only providers (ICS). */
  upsertEvent?(auth: AuthSession, calendarId: string, existing: ExistingEvent | null, ev: OutboundEvent): Promise<WriteResult>;
  deleteEvent?(auth: AuthSession, existing: ExistingEvent): Promise<void>;
  /** Re-reads an event's join link when a meeting was still being created. */
  meetingLink?(auth: AuthSession, existing: ExistingEvent): Promise<{ link: string | null; pending: boolean }>;
}

export type ProviderErrorKind = "auth" | "forbidden" | "rate_limited" | "unavailable" | "not_found" | "gone" | "conflict" | "precondition" | "invalid";

/**
 * A provider failure with a message that is safe to store and show: the HTTP status and, at most, the provider's short error code. The
 * request URL, headers and body are never included.
 */
export class CalendarProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status: number | null;
  readonly retryAfterSeconds: number | null;
  readonly code: string | null;

  constructor(kind: ProviderErrorKind, message: string, opts: { status?: number | null; retryAfterSeconds?: number | null; code?: string | null } = {}) {
    super(message);
    this.kind = kind;
    this.status = opts.status ?? null;
    this.retryAfterSeconds = opts.retryAfterSeconds ?? null;
    this.code = opts.code ?? null;
  }
}

export const isProviderError = (e: unknown): e is CalendarProviderError => e instanceof CalendarProviderError;

/** Maps an HTTP status to an error kind. */
export function kindForStatus(status: number): ProviderErrorKind {
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 410) return "gone";
  if (status === 412) return "precondition";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "unavailable";
  return "invalid";
}

/** Only an https URL of reasonable length is ever stored as a meeting link. */
export function safeMeetingLink(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 500) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
}
