import "server-only";
import { z } from "zod";
import { withSystem, type Queryable } from "@/server/db";
import { AppError, toPublicError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { env } from "@/server/env";
import { hashIp, sha256 } from "@/server/security/crypto";
import { consumeRateLimit, RATE_LIMITS, type RateLimitRule } from "@/server/security/rate-limit";
import { checkFormToken, issueFormToken } from "@/server/sites/form-token";
import { computeSlots, loadBookingContext } from "@/server/calendars/availability";
import {
  bookingPageActor, bookNativeAppointment, cancelNativeAppointment, findByManageToken, issueManageLink, rescheduleNativeAppointment, type CustomerChangeBlock, type ManagedAppointment,
} from "@/server/calendars/booking";
import type { BookingQuestion, LocationKind } from "@/server/calendars/setup";
import { addDays, isValidTimeZone, zonedToInstant } from "@/lib/calendars/slots";
import { absoluteUrl, bookingConfirmedUrl, bookingIcsUrl, bookingUrl, manageUrl } from "@/lib/calendars/urls";
import { normalizeEmail, normalizePhone } from "@/lib/messaging";

// Public booking pages (/book/<org>/<calendar>[/<type>]) and the customer's manage link (/book/manage/<token>). Everything here runs for
// people who are not signed in, so it returns only what a booking page is meant to show, answers every miss with the same not-found, and
// keeps the HTTP-facing decisions (origin, honeypot, signed time token, rate limits, idempotency) in one place the route handlers call.

// ---------------------------------------------------------------------------
// What a booking page may show
// ---------------------------------------------------------------------------

export interface PublicQuestion {
  key: string;
  label: string;
  type: BookingQuestion["type"];
  required: boolean;
  options: string[];
}

export interface PublicTypeSummary {
  slug: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  locationKind: LocationKind;
  /** How it happens, in words a customer reads before booking. The exact place or link is shown once they have booked. */
  locationLabel: string | null;
  /** Places per session; above 1 it is a group session. */
  capacity: number;
  requiresConfirmation: boolean;
  color: string | null;
}

export interface PublicTypeDetail extends PublicTypeSummary {
  questions: PublicQuestion[];
  requireEmail: boolean;
  requirePhone: boolean;
  minNoticeMinutes: number;
  maxDaysAhead: number;
  allowCustomerChanges: boolean;
  changeCutoffMinutes: number;
}

export interface PublicBookingPage {
  business: { name: string; slug: string; brandColor: string | null; timezone: string };
  calendar: { slug: string; name: string; intro: string | null; description: string | null; color: string | null };
  types: PublicTypeSummary[];
  /** The chosen type, when the page was asked for one. */
  type: PublicTypeDetail | null;
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const TOKEN = /^[A-Za-z0-9_-]{20,64}$/;

/** How a type happens, as the booking page says it before anyone has booked. */
export function publicLocationLabel(kind: LocationKind): string | null {
  switch (kind) {
    case "phone": return "Phone call";
    case "video": return "Video call";
    case "in_person": return "In person";
    case "custom": return "Details shared after booking";
    default: return null;
  }
}

interface TypeRow {
  id: string; slug: string; name: string; description: string | null; duration_minutes: number; location_kind: LocationKind; capacity: number; requires_confirmation: boolean;
  questions: BookingQuestion[] | null; color: string | null; min_notice_minutes: number; max_days_ahead: number; require_email: boolean; require_phone: boolean;
  allow_customer_changes: boolean; change_cutoff_minutes: number;
}

interface Target {
  orgId: string;
  orgName: string;
  orgSlug: string;
  orgTimezone: string;
  brandColor: string | null;
  callingCode: string | null;
  calendar: { id: string; slug: string; name: string; intro: string | null; description: string | null; color: string | null };
  types: TypeRow[];
  type: TypeRow | null;
}

/**
 * The organization, calendar and (optionally) type behind a public URL, or null. Null covers every reason alike: no such workspace,
 * an agency or suspended or archived one, appointments owned by GoHighLevel, a private, archived or draft calendar (a draft never has a
 * public page: the database refuses that, and this checks it again), or a private or archived type.
 */
async function loadTarget(db: Queryable, orgSlug: string, calendarSlug: string, typeSlug: string | null): Promise<Target | null> {
  const o = orgSlug.toLowerCase();
  const c = calendarSlug.toLowerCase();
  const t = typeSlug?.toLowerCase() ?? null;
  if (!SLUG.test(o) || !SLUG.test(c) || (t !== null && !SLUG.test(t))) return null;
  const cal = await db.query<{
    org_id: string; org_name: string; org_slug: string; timezone: string; brand_color: string | null; calling_code: string | null;
    calendar_id: string; calendar_slug: string; calendar_name: string; booking_intro: string | null; description: string | null; color: string | null;
  }>(
    `select o.id as org_id, o.name as org_name, o.slug as org_slug, o.timezone, p.brand_color, w.default_calling_code as calling_code,
            c.id as calendar_id, c.slug as calendar_slug, c.name as calendar_name, c.booking_intro, c.description, c.color
     from organizations o
     join crm_workspaces w on w.org_id = o.id
     left join crm_capability_providers cp on cp.org_id = o.id and cp.capability = 'appointments'
     left join company_profiles p on p.org_id = o.id
     join crm_calendars c on c.org_id = o.id and c.slug = $2 and c.archived_at is null and c.public and c.status = 'active'
     where o.slug = $1 and o.kind = 'client' and o.status not in ('suspended', 'archived')
       and (case when w.mode = 'hybrid' then coalesce(cp.provider, 'native') else w.mode end) = 'native'`,
    [o, c],
  );
  const row = cal.rows[0];
  if (!row) return null;
  const types = await db.query<TypeRow>(
    `select t.id, t.slug, t.name, t.description, t.duration_minutes, t.location_kind, t.capacity, t.requires_confirmation, t.questions, t.color, t.min_notice_minutes, t.max_days_ahead,
            t.require_email, t.require_phone, t.allow_customer_changes, t.change_cutoff_minutes
     from crm_appointment_types t where t.org_id = $1 and t.calendar_id = $2 and t.archived_at is null and t.public order by t.position, lower(t.name)`,
    [row.org_id, row.calendar_id],
  );
  if (!types.rows.length) return null;
  const type = t === null ? null : types.rows.find((x) => x.slug === t) ?? null;
  if (t !== null && !type) return null;
  return {
    orgId: row.org_id, orgName: row.org_name, orgSlug: row.org_slug, orgTimezone: row.timezone || "UTC", brandColor: row.brand_color, callingCode: row.calling_code,
    calendar: { id: row.calendar_id, slug: row.calendar_slug, name: row.calendar_name, intro: row.booking_intro, description: row.description, color: row.color },
    types: types.rows,
    type,
  };
}

const summary = (t: TypeRow): PublicTypeSummary => ({
  slug: t.slug, name: t.name, description: t.description, durationMinutes: t.duration_minutes, locationKind: t.location_kind, locationLabel: publicLocationLabel(t.location_kind),
  capacity: t.capacity, requiresConfirmation: t.requires_confirmation, color: t.color,
});

const detail = (t: TypeRow): PublicTypeDetail => ({
  ...summary(t),
  questions: (t.questions ?? []).map((q) => ({ key: q.key, label: q.label, type: q.type, required: q.required === true, options: q.type === "select" ? q.options ?? [] : [] })),
  requireEmail: t.require_email, requirePhone: t.require_phone, minNoticeMinutes: t.min_notice_minutes, maxDaysAhead: t.max_days_ahead,
  allowCustomerChanges: t.allow_customer_changes, changeCutoffMinutes: t.change_cutoff_minutes,
});

/**
 * A booking page's public content: the business's name and colour, the calendar's name and intro, and its public types with what the
 * booking form needs. Never ids, hosts, host emails, meeting links or internal location details.
 */
export async function resolvePublicBookingPage(orgSlug: string, calendarSlug: string, typeSlug?: string | null): Promise<PublicBookingPage | null> {
  const target = await withSystem((db) => loadTarget(db, orgSlug, calendarSlug, typeSlug ?? null));
  if (!target) return null;
  return {
    business: { name: target.orgName, slug: target.orgSlug, brandColor: target.brandColor, timezone: target.orgTimezone },
    calendar: { slug: target.calendar.slug, name: target.calendar.name, intro: target.calendar.intro, description: target.calendar.description, color: target.calendar.color },
    types: target.types.map(summary),
    type: target.type ? detail(target.type) : null,
  };
}

// ---------------------------------------------------------------------------
// Request plumbing shared by the route handlers
// ---------------------------------------------------------------------------

export interface PublicRequestMeta {
  origin: string | null;
  /** The host the browser addressed (X-Forwarded-Host behind the proxy, else Host). */
  host: string | null;
  secFetchSite: string | null;
  ip: string | null;
  now?: Date;
}

export interface PublicResult {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

export function requestMetaFrom(req: Request): PublicRequestMeta {
  const h = req.headers;
  let urlHost: string | null = null;
  try {
    urlHost = new URL(req.url).host;
  } catch {
    urlHost = null;
  }
  return {
    origin: h.get("origin"),
    host: h.get("x-forwarded-host") ?? h.get("host") ?? urlHost,
    secFetchSite: h.get("sec-fetch-site"),
    // Behind the trusted reverse proxy the first X-Forwarded-For entry is the visitor.
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null,
  };
}

/** A form post must come from a page on this same host. Browsers always send Origin on POST; Sec-Fetch-Site is the fallback. */
function sameOrigin(m: PublicRequestMeta): boolean {
  if (m.origin) {
    try {
      return Boolean(m.host) && new URL(m.origin).host.toLowerCase() === (m.host as string).toLowerCase();
    } catch {
      return false;
    }
  }
  return m.secFetchSite === "same-origin";
}

const NO_STORE = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };
const fail = (status: number, code: string, error: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): PublicResult => ({
  status, body: { ok: false, code, error, ...extra }, headers: { ...NO_STORE, ...headers },
});
const ok = (body: Record<string, unknown>, status = 200): PublicResult => ({ status, body: { ok: true, ...body }, headers: { ...NO_STORE } });

const NOT_AVAILABLE = "This booking page isn't available. Check the link with the business that shared it.";
const LINK_NOT_VALID = "This link isn't valid any more. Use the most recent link you were sent, or contact the business.";
const GENERIC = "We couldn't complete this booking. Please try again, or contact the business directly.";
const TAKEN = "That time was just taken. Please choose another time.";

async function limited(rule: RateLimitRule, key: string, message: string): Promise<PublicResult | null> {
  const r = await consumeRateLimit(rule, key);
  return r.allowed ? null : fail(429, "rate_limited", message, {}, { "Retry-After": String(r.retryAfterSeconds) });
}

const ipKey = (m: PublicRequestMeta) => hashIp(m.ip) ?? "unknown";
const bookingBinding = (o: string, c: string, t: string) => `booking:${o.toLowerCase()}/${c.toLowerCase()}/${t.toLowerCase()}`;
const manageBinding = (token: string) => `booking-manage:${sha256(token).slice(0, 32)}`;

/** The signed time token a booking form carries, bound to the page it was served on. */
export function bookingFormToken(orgSlug: string, calendarSlug: string, typeSlug: string, now = Date.now()): string {
  return issueFormToken(bookingBinding(orgSlug, calendarSlug, typeSlug), now);
}

/** The signed time token the manage page's forms carry, bound to that link. */
export function manageFormToken(token: string, now = Date.now()): string {
  return issueFormToken(manageBinding(token), now);
}

function tokenFailure(reason: string): PublicResult {
  return reason === "too_fast"
    ? fail(429, "too_fast", "That was quick. Please wait a couple of seconds and try again.", {}, { "Retry-After": "3" })
    : fail(400, "expired", "This page has expired. Reload it and try again.");
}

/** Whether to serve a booking or manage page to this visitor, or ask them to slow down. */
export async function allowPageView(ip: string | null): Promise<boolean> {
  const r = await consumeRateLimit(RATE_LIMITS.bookingPageByIp, hashIp(ip) ?? "unknown");
  return r.allowed;
}

/** Manage links issued after booking stay usable for a week after the appointment, so the customer can still see what happened. */
function linkTtlMinutes(startAt: string, now: Date): number {
  return Math.min(400 * 24 * 60, Math.max(60, Math.ceil((new Date(startAt).getTime() - now.getTime()) / 60_000) + 7 * 24 * 60));
}

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const MAX_RANGE_DAYS = 14;

const slotsQuery = z.object({
  org: z.string().max(64).optional(),
  calendar: z.string().max(64).optional(),
  type: z.string().max(64).optional(),
  token: z.string().regex(TOKEN).optional(),
  from: DATE,
  to: DATE,
  tz: z.string().min(1).max(64),
});

const dayNumber = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) / 86_400_000;

/**
 * Open start times for one type between two dates (inclusive, at most 14 days, read in the invitee's time zone). With a manage token
 * instead of slugs it answers for that booking's type and leaves the booking's own time free, so a customer can move it.
 */
export async function handleSlots(meta: PublicRequestMeta, params: URLSearchParams | Record<string, string | undefined>): Promise<PublicResult> {
  if (meta.secFetchSite === "cross-site") return fail(403, "forbidden", "Times can only be loaded from the booking page.");
  const now = meta.now ?? new Date();
  const rl = await limited(RATE_LIMITS.bookingSlotsByIp, ipKey(meta), "Too many requests. Please wait a minute and try again.");
  if (rl) return rl;
  const raw = params instanceof URLSearchParams ? Object.fromEntries(params) : params;
  const q = slotsQuery.safeParse(raw);
  if (!q.success) return fail(400, "invalid", "Choose dates to see open times.");
  const { from, to, tz } = q.data;
  if (!isValidTimeZone(tz)) return fail(400, "invalid", "Choose a valid time zone.", { field: "timeZone" });
  const days = dayNumber(to) - dayNumber(from) + 1;
  if (!Number.isFinite(days) || days < 1 || days > MAX_RANGE_DAYS) return fail(400, "invalid", `Ask for 1 to ${MAX_RANGE_DAYS} days at a time.`);

  let orgId: string;
  let typeId: string;
  let exclude: string | null = null;
  if (q.data.token) {
    const found = await findByManageToken(q.data.token, { now });
    if (!found) return fail(404, "not_found", LINK_NOT_VALID);
    if (!found.canChange) return fail(409, "not_allowed", changeBlockMessage(found.cannotChangeReason, found.orgName));
    orgId = found.orgId;
    typeId = found.typeId;
    exclude = found.id;
  } else {
    if (!q.data.org || !q.data.calendar || !q.data.type) return fail(400, "invalid", "Choose what to book.");
    const target = await withSystem((db) => loadTarget(db, q.data.org as string, q.data.calendar as string, q.data.type as string));
    if (!target?.type) return fail(404, "not_found", NOT_AVAILABLE);
    orgId = target.orgId;
    typeId = target.type.id;
  }
  const fromAt = new Date(zonedToInstant(from, 0, tz));
  const toAt = new Date(zonedToInstant(addDays(to, 1), 0, tz));
  try {
    const slots = await withSystem(async (db) => {
      const ctx = await loadBookingContext(db, orgId, typeId);
      return computeSlots(db, ctx, { from: fromAt, to: toAt, now, excludeAppointmentId: exclude });
    });
    return ok({ timeZone: tz, from, to, slots: slots.map((s) => ({ start: s.start, end: s.end, remaining: s.remaining })) });
  } catch (err) {
    if (err instanceof AppError && err.code === "not_found") return fail(404, "not_found", NOT_AVAILABLE);
    return fail(500, "error", toPublicError(err).message);
  }
}

// ---------------------------------------------------------------------------
// Booking
// ---------------------------------------------------------------------------

const bookBody = z.object({
  org: z.string().max(64),
  calendar: z.string().max(64),
  type: z.string().max(64),
  startAt: z.string().max(40),
  timeZone: z.string().max(64),
  name: z.string().max(200),
  email: z.string().max(320).optional(),
  phone: z.string().max(40).optional(),
  answers: z.record(z.string().max(40), z.string().max(2000)).optional(),
  notes: z.string().max(2000).optional(),
  idempotencyKey: z.uuid(),
  formToken: z.string().max(200),
  website: z.string().max(500).optional(),
});
export type PublicBookBody = z.input<typeof bookBody>;

/** The most upcoming bookings one email address or phone number may hold for one type in the next 30 days. */
export const MAX_UPCOMING_PER_PERSON = 3;

const clean = (s: string | undefined, max: number) => (s ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").replace(/[ \t]+/g, " ").trim().slice(0, max);
const oneLine = (s: string | undefined, max: number) => clean((s ?? "").replace(/\s+/g, " "), max);
const filled = (raw: unknown, key: string) => typeof raw === "object" && raw !== null && typeof (raw as Record<string, unknown>)[key] === "string" && ((raw as Record<string, string>)[key]).trim() !== "";

async function upcomingFor(db: Queryable, orgId: string, typeId: string, emails: string[], phones: string[], now: Date): Promise<number> {
  if (!emails.length && !phones.length) return 0;
  const { rows } = await db.query<{ n: number }>(
    `select count(distinct a.id)::int as n from appointment_refs a
     join contact_identities i on i.contact_id = a.contact_id and i.org_id = a.org_id
     where a.org_id = $1 and a.provider = 'native' and a.appointment_type_id = $2 and a.status in ('new', 'confirmed')
       and a.start_at > $3 and a.start_at < $3::timestamptz + interval '30 days'
       and ((i.kind = 'email' and i.value = any($4::text[])) or (i.kind = 'phone' and i.value = any($5::text[])))`,
    [orgId, typeId, now, emails, phones],
  );
  return rows[0]?.n ?? 0;
}

/**
 * A booking submitted from a public booking page. In order: same-origin, honeypot, the signed time token, per-visitor and per-workspace
 * rate limits, the page itself, the type's required contact details and questions, the per-person cap, then the booking service (which
 * rechecks the time under a lock and lets the database refuse a double booking). A repeated submit with the same idempotency key returns
 * the same appointment. Errors never say whether an email address is already known.
 */
export async function handleBook(meta: PublicRequestMeta, raw: unknown): Promise<PublicResult> {
  const now = meta.now ?? new Date();
  if (!sameOrigin(meta)) return fail(403, "forbidden", "Bookings can only be made from the booking page itself.");
  // A person never sees this field. Whatever filled it gets the same answer as any refused booking, and nothing is stored.
  if (filled(raw, "website")) return fail(400, "refused", GENERIC);
  const parsed = bookBody.safeParse(raw);
  if (!parsed.success) return fail(400, "invalid", "Some details are missing. Check the form and try again.");
  const b = parsed.data;
  const token = checkFormToken(bookingBinding(b.org, b.calendar, b.type), b.formToken, now.getTime());
  if (!token.ok) return tokenFailure(token.reason);
  const rlIp = await limited(RATE_LIMITS.bookingSubmitByIp, ipKey(meta), "We've received a lot of bookings from here. Please try again later.");
  if (rlIp) return rlIp;

  const target = await withSystem((db) => loadTarget(db, b.org, b.calendar, b.type));
  if (!target?.type) return fail(404, "not_found", NOT_AVAILABLE);
  const type = target.type;
  const rlOrg = await limited(RATE_LIMITS.bookingSubmitByOrg, target.orgId, "This booking page is very busy right now. Please try again in a little while.");
  if (rlOrg) return rlOrg;

  // The details the type asks for.
  const name = oneLine(b.name, 120);
  const email = oneLine(b.email, 320);
  const phone = oneLine(b.phone, 40);
  if (name.length < 1) return fail(400, "invalid", "Please enter your name.", { field: "name" });
  const normEmail = email ? normalizeEmail(email) : null;
  if (email && !normEmail) return fail(400, "invalid", "Enter a valid email address.", { field: "email" });
  const normPhone = phone ? normalizePhone(phone, target.callingCode ?? undefined) : null;
  if (phone && !normPhone) return fail(400, "invalid", "Include your country code, for example +63 917 123 4567.", { field: "phone" });
  if (type.require_email && !normEmail) return fail(400, "invalid", "Please enter your email address.", { field: "email" });
  if (type.require_phone && !normPhone) return fail(400, "invalid", "Please enter your phone number.", { field: "phone" });
  if (!normEmail && !normPhone) return fail(400, "invalid", "Enter an email address or a phone number so the business can reach you.", { field: "email" });
  if (!isValidTimeZone(b.timeZone)) return fail(400, "invalid", "Choose a valid time zone.", { field: "timeZone" });
  const startMs = Date.parse(b.startAt);
  if (Number.isNaN(startMs)) return fail(400, "invalid", "Choose a time.", { field: "startAt" });
  const answers: Record<string, string> = {};
  for (const q of type.questions ?? []) {
    const v = clean(b.answers?.[q.key], q.type === "textarea" ? 2000 : 300);
    if (!v && q.required) return fail(400, "invalid", `Please answer: ${q.label}`, { field: `answers.${q.key}` });
    if (v && q.type === "select" && !(q.options ?? []).includes(v)) return fail(400, "invalid", `Choose one of the options for: ${q.label}`, { field: `answers.${q.key}` });
    if (v) answers[q.key] = v;
  }
  const key = `page:${b.idempotencyKey}`;

  // A repeated submit skips the cap: it gets back the booking it already made.
  const capped = await withSystem(async (db) => {
    const prior = await db.query("select 1 from appointment_refs where org_id = $1 and idempotency_key = $2", [target.orgId, key]);
    if (prior.rows[0]) return false;
    return (await upcomingFor(db, target.orgId, type.id, normEmail ? [normEmail] : [], normPhone ? [normPhone] : [], now)) >= MAX_UPCOMING_PER_PERSON;
  });
  if (capped) return fail(409, "limit", "We couldn't book another time with these details. If you already have bookings here, use the link you were given to change one, or contact the business.");

  const [firstName, ...rest] = name.split(" ");
  try {
    const actor = await bookingPageActor(target.orgId);
    const res = await bookNativeAppointment(actor, {
      typeId: type.id, startAt: new Date(startMs), via: "booking_page", idempotencyKey: key, inviteeTimezone: b.timeZone, now,
      contact: { firstName, lastName: rest.join(" ") || null, email: normEmail, phone: normPhone, timezone: b.timeZone, source: "Booking page" },
      answers, notes: clean(b.notes, 2000) || null,
    });
    let manage = res.manageToken;
    if (!manage) {
      // The same submit arrived again (a retry or a double click). Its first answer may never have reached the browser, so this one
      // carries a link of its own, but only for the appointment that key made on this very page.
      manage = await withSystem(async (db) => {
        const same = await db.query("select 1 from appointment_refs where id = $1 and org_id = $2 and appointment_type_id = $3", [res.appointmentId, target.orgId, type.id]);
        return same.rows[0] ? issueManageLink(db, target.orgId, res.appointmentId, "confirmation", linkTtlMinutes(res.startAt, now), now) : null;
      });
      if (!manage) return fail(409, "conflict", GENERIC);
    }
    return ok({
      created: res.created, status: res.status, startAt: res.startAt, endAt: res.endAt,
      confirmationUrl: bookingConfirmedUrl(target.orgSlug, target.calendar.slug, type.slug, manage),
      manageUrl: manageUrl(manage),
    }, res.created ? 201 : 200);
  } catch (err) {
    return bookingError(err);
  }
}

function isTaken(err: AppError) {
  return err.code === "conflict" && /just taken|no longer available|isn't free|Not everyone is free/.test(err.message);
}

function bookingError(err: unknown): PublicResult {
  if (err instanceof AppError) {
    if (isTaken(err)) return fail(409, "slot_taken", TAKEN);
    // Validation messages from the booking service name a question or a field, never a stored record.
    if (err.code === "invalid_input") return fail(400, "invalid", err.message);
    if (err.code === "not_found") return fail(404, "not_found", NOT_AVAILABLE);
    if (err.code === "rate_limited") return fail(429, "rate_limited", "Too many requests. Please try again later.");
  }
  const e = toPublicError(err);
  return e.status >= 500 ? fail(500, "error", e.message) : fail(e.status === 409 ? 409 : 400, "error", GENERIC);
}

// ---------------------------------------------------------------------------
// The customer's manage link
// ---------------------------------------------------------------------------

/** What to tell a customer who can't change their booking online. */
export function changeBlockMessage(reason: CustomerChangeBlock | null, business: string): string {
  const who = business || "the business";
  switch (reason) {
    case "not_upcoming": return "This booking is no longer upcoming, so it can't be changed.";
    case "started": return "This appointment has already started.";
    case "not_allowed": return `This booking can't be changed online. Contact ${who} to change it.`;
    case "past_cutoff": return `It's too close to the appointment to change it online. Contact ${who} to change it.`;
    default: return "This booking can't be changed right now.";
  }
}

const manageBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reschedule"), token: z.string().regex(TOKEN), startAt: z.string().max(40), version: z.number().int().min(1).optional(), formToken: z.string().max(200), website: z.string().max(500).optional() }),
  z.object({ action: z.literal("cancel"), token: z.string().regex(TOKEN), reason: z.string().max(300).optional(), formToken: z.string().max(200), website: z.string().max(500).optional() }),
]);
export type PublicManageBody = z.input<typeof manageBody>;

/**
 * A reschedule or cancel from a customer's manage link. The workspace and the appointment come from the link alone (never from the
 * request), the type's self-service rules and cutoff apply, and repeating the same request changes nothing.
 */
export async function handleManage(meta: PublicRequestMeta, raw: unknown): Promise<PublicResult> {
  const now = meta.now ?? new Date();
  if (!sameOrigin(meta)) return fail(403, "forbidden", "Changes can only be made from your booking page.");
  if (filled(raw, "website")) return fail(400, "refused", "We couldn't make that change. Please try again, or contact the business.");
  const parsed = manageBody.safeParse(raw);
  if (!parsed.success) return fail(400, "invalid", "Something is missing. Reload the page and try again.");
  const b = parsed.data;
  const ft = checkFormToken(manageBinding(b.token), b.formToken, now.getTime());
  if (!ft.ok) return tokenFailure(ft.reason);
  const rlIp = await limited(RATE_LIMITS.bookingManageByIp, ipKey(meta), "Too many changes from here. Please try again later.");
  if (rlIp) return rlIp;
  const rlToken = await limited(RATE_LIMITS.bookingManageByToken, sha256(b.token), "This booking has been changed several times recently. Please try again later, or contact the business.");
  if (rlToken) return rlToken;

  const found = await findByManageToken(b.token, { now });
  if (!found) return fail(404, "not_found", LINK_NOT_VALID);
  if (b.action === "cancel" && found.status === "cancelled") return ok({ changed: false, status: "cancelled" });
  if (!found.canChange) return fail(409, "not_allowed", changeBlockMessage(found.cannotChangeReason, found.orgName));

  try {
    const actor = await bookingPageActor(found.orgId);
    if (b.action === "reschedule") {
      const startMs = Date.parse(b.startAt);
      if (Number.isNaN(startMs)) return fail(400, "invalid", "Choose a new time.");
      if (startMs === new Date(found.startAt).getTime()) return ok({ changed: false, startAt: found.startAt, endAt: found.endAt });
      if (b.version !== undefined && b.version !== found.version) return fail(409, "stale", "This booking changed since you opened this page. Reload to see the latest, then try again.");
      const moved = await rescheduleNativeAppointment(actor, found.id, { startAt: new Date(startMs), by: "customer", now, expectedVersion: found.version });
      await recordAudit({ orgId: found.orgId, actorKind: "system", action: "appointment.customer_rescheduled", targetType: "appointment", targetId: found.id, result: "success", ipHash: hashIp(meta.ip), metadata: { via: "manage_link", link: found.linkIssuedFor } });
      return ok({ changed: true, startAt: moved.startAt, endAt: moved.endAt });
    }
    const res = await cancelNativeAppointment(actor, found.id, { reason: clean(b.reason, 300) || null, by: "customer", now });
    if (res.changed) await recordAudit({ orgId: found.orgId, actorKind: "system", action: "appointment.customer_cancelled", targetType: "appointment", targetId: found.id, result: "success", ipHash: hashIp(meta.ip), metadata: { via: "manage_link", link: found.linkIssuedFor, late: res.late } });
    return ok({ changed: res.changed, status: "cancelled" });
  } catch (err) {
    return manageError(err, found.orgName);
  }
}

function manageError(err: unknown, business: string): PublicResult {
  if (err instanceof AppError) {
    if (isTaken(err)) return fail(409, "slot_taken", TAKEN);
    if (err.code === "forbidden") return fail(409, "not_allowed", changeBlockMessage("not_allowed", business));
    if (err.code === "conflict" && /too close/.test(err.message)) return fail(409, "not_allowed", changeBlockMessage("past_cutoff", business));
    if (err.code === "conflict" && /someone else changed/i.test(err.message)) return fail(409, "stale", "This booking changed since you opened this page. Reload to see the latest, then try again.");
    if (err.code === "conflict" && /already started|Only an upcoming/.test(err.message)) return fail(409, "not_allowed", err.message);
    if (err.code === "not_found") return fail(404, "not_found", LINK_NOT_VALID);
  }
  const e = toPublicError(err);
  return e.status >= 500 ? fail(500, "error", e.message) : fail(409, "error", "We couldn't make that change. Please try again, or contact the business.");
}

// ---------------------------------------------------------------------------
// Pages behind a manage secret
// ---------------------------------------------------------------------------

export interface ManagePageView {
  appointment: {
    typeName: string;
    status: string;
    startAt: string;
    endAt: string;
    timeZone: string;
    durationMinutes: number;
    location: string | null;
    meetingLink: string | null;
    version: number;
  };
  business: { name: string; brandColor: string | null; contactEmail: string | null; contactPhone: string | null };
  canChange: boolean;
  cannotChangeReason: CustomerChangeBlock | null;
  changeDeadline: string | null;
  allowCustomerChanges: boolean;
  changeCutoffMinutes: number;
  maxDaysAhead: number;
  /** The confirmation message the business wrote for this type, if any. */
  confirmationMessage: string | null;
  slugs: { org: string; calendar: string; type: string };
  /** The booking page, while it is still public. */
  bookAgainUrl: string | null;
  icsUrl: string;
}

/**
 * What the confirmation and manage pages show for a manage secret: the booking as the customer made it (type, time, place, status),
 * the business's own contact details so they know whom to ask, and what they may change. Null for any link that isn't valid.
 */
export async function loadManagePage(token: string, opts: { now?: Date } = {}): Promise<ManagePageView | null> {
  const found = await findByManageToken(token, opts);
  if (!found) return null;
  const extra = await withSystem(async (db) => {
    const r = await db.query<{ brand_color: string | null; contact_email: string | null; contact_phone: string | null; confirmation_message: string | null; max_days_ahead: number }>(
      `select p.brand_color, p.contact_email, p.contact_phone, t.confirmation_message, t.max_days_ahead from crm_appointment_types t
       left join company_profiles p on p.org_id = t.org_id where t.id = $1 and t.org_id = $2`,
      [found.typeId, found.orgId],
    );
    const page = await loadTarget(db, found.orgSlug, found.calendarSlug, found.typeSlug);
    return { row: r.rows[0], stillPublic: Boolean(page?.type) };
  });
  return {
    appointment: {
      typeName: found.typeName, status: found.status, startAt: found.startAt, endAt: found.endAt, timeZone: found.timezone, durationMinutes: found.durationMinutes,
      location: found.location, meetingLink: found.meetingLink && /^https:\/\//.test(found.meetingLink) ? found.meetingLink : null, version: found.version,
    },
    business: { name: found.orgName, brandColor: extra.row?.brand_color ?? null, contactEmail: extra.row?.contact_email ?? null, contactPhone: extra.row?.contact_phone ?? null },
    canChange: found.canChange,
    cannotChangeReason: found.cannotChangeReason,
    changeDeadline: found.changeDeadline,
    allowCustomerChanges: found.allowCustomerChanges,
    changeCutoffMinutes: found.changeCutoffMinutes,
    maxDaysAhead: extra.row?.max_days_ahead ?? 60,
    confirmationMessage: extra.row?.confirmation_message ?? null,
    slugs: { org: found.orgSlug, calendar: found.calendarSlug, type: found.typeSlug },
    bookAgainUrl: extra.stillPublic ? bookingUrl(found.orgSlug, found.calendarSlug, found.typeSlug) : null,
    icsUrl: bookingIcsUrl(token),
  };
}

// ---------------------------------------------------------------------------
// Add to calendar (.ics)
// ---------------------------------------------------------------------------

export interface IcsEvent {
  /** Stable for one appointment across reschedules, so calendar apps update the event instead of adding another. */
  uid: string;
  start: string;
  end: string;
  summary: string;
  location: string | null;
  description: string;
  url: string | null;
  status: "CONFIRMED" | "TENTATIVE" | "CANCELLED";
  sequence: number;
  stamp: Date;
}

const icsText = (s: string) => s.replace(/\r\n?/g, "\n").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
const icsTime = (iso: string | Date) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** RFC 5545 folding: lines of at most 75 octets, continued with a leading space, never splitting a character. */
function fold(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let size = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    const limit = out.length ? 74 : 75;
    if (size + n > limit) {
      out.push(cur);
      cur = "";
      size = 0;
    }
    cur += ch;
    size += n;
  }
  out.push(cur);
  return out.map((l, i) => (i ? ` ${l}` : l)).join("\r\n");
}

export function buildIcs(e: IcsEvent): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//iAcquire//Booking//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${e.uid}`,
    `DTSTAMP:${icsTime(e.stamp)}`,
    `DTSTART:${icsTime(e.start)}`,
    `DTEND:${icsTime(e.end)}`,
    `SEQUENCE:${Math.max(0, Math.floor(e.sequence))}`,
    `SUMMARY:${icsText(e.summary)}`,
    ...(e.location ? [`LOCATION:${icsText(e.location)}`] : []),
    ...(e.description ? [`DESCRIPTION:${icsText(e.description)}`] : []),
    ...(e.url ? [`URL:${e.url}`] : []),
    `STATUS:${e.status}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(fold).join("\r\n")}\r\n`;
}

/**
 * The customer's appointment as a calendar file, authorized by its manage secret. It holds the business's name, the type, the times
 * (UTC), the place or meeting link, and the manage link: nothing about hosts and nothing the customer didn't already see.
 */
export async function handleIcs(meta: PublicRequestMeta, token: string | null): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  const now = meta.now ?? new Date();
  const text = (status: number, body: string, headers: Record<string, string> = {}) => ({ status, body, headers: { "Content-Type": "text/plain; charset=utf-8", ...NO_STORE, ...headers } });
  const r = await consumeRateLimit(RATE_LIMITS.bookingIcsByIp, ipKey(meta));
  if (!r.allowed) return text(429, "Too many requests. Please try again in a few minutes.", { "Retry-After": String(r.retryAfterSeconds) });
  if (!token || !TOKEN.test(token)) return text(404, LINK_NOT_VALID);
  const found: ManagedAppointment | null = await findByManageToken(token, { now });
  if (!found) return text(404, LINK_NOT_VALID);
  const link = absoluteUrl(manageUrl(token), env().APP_URL);
  const meeting = found.meetingLink && /^https:\/\/[^\s]+$/.test(found.meetingLink) ? found.meetingLink : null;
  const description = [
    `${found.typeName} with ${found.orgName}.`,
    meeting ? `Join: ${meeting}` : null,
    found.canChange ? `Reschedule or cancel: ${link}` : `View your booking: ${link}`,
  ].filter(Boolean).join("\n");
  let host = "iacquire";
  try {
    host = new URL(env().APP_URL).hostname || host;
  } catch {
    /* keep the default */
  }
  const body = buildIcs({
    uid: `${sha256(`ics:${found.id}`).slice(0, 32)}@${host}`,
    start: found.startAt, end: found.endAt, summary: `${found.typeName} with ${found.orgName}`, location: found.location ?? (meeting ? "Video call" : null),
    description, url: meeting, status: found.status === "cancelled" ? "CANCELLED" : found.status === "new" ? "TENTATIVE" : "CONFIRMED", sequence: Math.max(0, found.version - 1), stamp: now,
  });
  return { status: 200, body, headers: { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": 'attachment; filename="appointment.ics"', ...NO_STORE } };
}
