import "server-only";
import crypto from "node:crypto";
import { AppError } from "@/server/errors";
import { env } from "@/server/env";
import { normalizeEmail, normalizePhone } from "@/lib/messaging";
import { addDays, isValidTimeZone, zonedDate, zonedToInstant } from "@/lib/calendars/slots";
import { bookingIcsUrl, manageUrl } from "@/lib/calendars/urls";
import {
  BOOK_ACTION, BOOK_BASE, BOOKED_BASE, bookingPath, contentUsesBooking, durationLabel, isSlugRef,
  type BookingDoneView, type BookingFormView, type BookingNotice, type BookingPageView, type BookingTimesView, type SiteBookingCalendar,
  type SiteBookingData, type SiteBookingType,
} from "@/lib/website/booking";
import type { SiteContent } from "@/lib/website/doc";
import type { BookingContext } from "@/server/calendars/availability";
import { clip, publicTarget, siteData } from "@/server/sites/booking-data";
import { bookOnSite, siteAppointmentById, siteAppointmentByToken, siteWorkspaceBooking, withSitePublicType, type SiteAppointment, type SiteSlots } from "@/server/sites/booking-trusted";
import { checkFormToken, hashClient, issueFormToken } from "@/server/sites/form-token";
import { resolveSite, siteRateLimit, type LiveSite } from "@/server/sites/runtime";

// A client's iAcquire website books through the native scheduling system on its own host: the "Book appointment" element links to
// /_book/..., these pages list days and times, and the form posts to /__iaq/book. The workspace is always the one the verified host is
// published for (resolveSite), never anything the browser says. Only live, public calendars and types are ever shown or booked, and
// anything outside that public set answers exactly like a page that doesn't exist. The booking itself goes through bookNativeAppointment
// (via "website"), which re-checks the time inside its transaction.
//
// This module has no database access of its own: every trusted read and the one write go through src/server/sites/booking-trusted.ts,
// which only accepts the LiveSite resolveSite returned (see docs/website-studio.md, "Trust boundary and security").

const CACHE_MS = 10_000;
const dataCache = new Map<string, { at: number; value: SiteBookingData }>();
export function clearSiteBookingCache() {
  dataCache.clear();
}

/** The public calendars a live page's booking elements draw. Cached for a few seconds, like the site itself. */
export async function siteBookingData(site: LiveSite): Promise<SiteBookingData> {
  const hit = dataCache.get(site.orgId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = siteData(await siteWorkspaceBooking(site));
  if (dataCache.size > 2000) dataCache.clear();
  dataCache.set(site.orgId, { at: Date.now(), value });
  return value;
}

// ---------------------------------------------------------------------------
// Booking pages
// ---------------------------------------------------------------------------

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?Z$/;
const UUID_V = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WINDOW_DAYS = 14;

const isDate = (v: string | undefined): v is string => !!v && DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const validZone = (v: string | undefined): v is string => !!v && v.length <= 64 && /^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(v) && isValidTimeZone(v);

/** A short list of time zones people pick from, plus the business's own and whatever is already chosen. */
const ZONES = [
  "Pacific/Honolulu", "America/Anchorage", "America/Los_Angeles", "America/Phoenix", "America/Denver", "America/Chicago", "America/New_York", "America/Halifax",
  "America/Mexico_City", "America/Bogota", "America/Sao_Paulo", "America/Argentina/Buenos_Aires", "Atlantic/Reykjavik", "Europe/London", "Europe/Dublin",
  "Europe/Lisbon", "Europe/Madrid", "Europe/Paris", "Europe/Berlin", "Europe/Rome", "Europe/Amsterdam", "Europe/Stockholm", "Europe/Warsaw", "Europe/Athens",
  "Europe/Istanbul", "Africa/Lagos", "Africa/Johannesburg", "Africa/Nairobi", "Asia/Dubai", "Asia/Karachi", "Asia/Kolkata", "Asia/Dhaka", "Asia/Bangkok",
  "Asia/Jakarta", "Asia/Singapore", "Asia/Kuala_Lumpur", "Asia/Manila", "Asia/Hong_Kong", "Asia/Shanghai", "Asia/Taipei", "Asia/Seoul", "Asia/Tokyo",
  "Australia/Perth", "Australia/Adelaide", "Australia/Brisbane", "Australia/Sydney", "Pacific/Auckland", "UTC",
];

function offsetLabel(tz: string, at: number): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(new Date(at)).find((p) => p.type === "timeZoneName");
    return part?.value ?? tz;
  } catch {
    return tz;
  }
}
const zoneName = (tz: string) => tz.replace(/_/g, " ").split("/").slice(-1)[0];
export const zoneLabel = (tz: string, at: number) => `${zoneName(tz)} (${offsetLabel(tz, at)})`;

function zoneOptions(selected: string, business: string, at: number) {
  const list = [...new Set([selected, business, ...ZONES])].filter(validZone);
  const offset = (tz: string) => {
    const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(offsetLabel(tz, at));
    return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
  };
  return list.sort((a, b) => offset(a) - offset(b) || a.localeCompare(b)).map((tz) => ({ value: tz, label: `${zoneLabel(tz, at)}${tz === business ? " · our time zone" : ""}` }));
}

const fmt = (tz: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: tz, ...o });
/** "Tuesday, October 20, 2026, 9:00 AM – 10:00 AM" in the visitor's time zone. */
function whenLabel(startMs: number, endMs: number, tz: string): string {
  const day = fmt(tz, { weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(new Date(startMs));
  const time = fmt(tz, { hour: "numeric", minute: "2-digit" });
  return `${day}, ${time.format(new Date(startMs))} – ${time.format(new Date(endMs))}`;
}
const dateMs = (date: string) => Date.parse(`${date}T12:00:00Z`);

function query(path: string, q: Record<string, string | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v) sp.set(k, v);
  const s = sp.toString();
  return s ? `${path}?${s}` : path;
}

const TIMES_NOTICES: Record<string, BookingNotice> = {
  taken: { tone: "warn", text: "Sorry, that time was just booked by someone else. Please choose another time." },
  gone: { tone: "warn", text: "That time is no longer available. Please choose another time." },
  expired: { tone: "info", text: "This page was open for a while, so please choose your time again." },
};
const FORM_NOTICES: Record<string, BookingNotice> = {
  name: { tone: "warn", text: "Please enter your name." },
  email: { tone: "warn", text: "Please enter a valid email address." },
  phone: { tone: "warn", text: "Please enter a valid phone number, including the country code." },
  contact: { tone: "warn", text: "Please enter an email address or a phone number so we can reach you about your booking." },
  answers: { tone: "warn", text: "Please answer the required questions." },
  fast: { tone: "info", text: "That was quick. Please check your details and send them again." },
  invalid: { tone: "warn", text: "We couldn't book that. Please check your details and try again." },
};

export interface BookingPageInput {
  path: string[];
  query: Record<string, string | undefined>;
  forwardedFor: string | null;
  now?: Date;
}
export type SiteBookingPage = { kind: "not_found" } | { kind: "page"; title: string; view: BookingPageView };

const firstIp = (forwardedFor: string | null) => clip((forwardedFor ?? "").split(",")[0], 64) || "unknown";
const contactOf = (content: SiteContent) => ({ phone: content.business.phone, email: content.business.email });

/** The booking page for a path under /_book on a live site. Only a site that offers booking (has a booking element) has these pages. */
export async function siteBookingPage(site: LiveSite, host: string, input: BookingPageInput): Promise<SiteBookingPage> {
  const path = input.path;
  if (path.length > 2 || !path.every(isSlugRef)) return { kind: "not_found" };
  if (!contentUsesBooking(site.content)) return { kind: "not_found" };
  const now = input.now ?? new Date();
  const contact = contactOf(site.content);
  // Working out free times is the expensive part, so the time and details pages are limited per visitor.
  if (path.length === 2 && !(await siteRateLimit(`bookview:ip:${hashClient(firstIp(input.forwardedFor))}`, 300, 600))) {
    return { kind: "page", title: "Please try again shortly", view: { kind: "busy" } };
  }
  const ws = await siteWorkspaceBooking(site);
  const unavailable = (message: string, backHref: string | null = null): SiteBookingPage => ({
    kind: "page", title: "Online booking isn't available", view: { kind: "unavailable", title: "Online booking isn't available", message, contact, backHref },
  });
  if (!ws.native) return unavailable("We aren't taking bookings on this website at the moment.");
  const data = siteData(ws);
  const typesView = (cal: SiteBookingCalendar, backHref: string | null): SiteBookingPage => ({
    kind: "page", title: `Book: ${cal.name}`,
    view: { kind: "types", calendar: { name: cal.name, intro: cal.intro }, backHref, types: cal.types.map((t) => ({ name: t.name, meta: metaOf(t), description: t.description, href: bookingPath(cal.slug, t.slug) })) },
  });
  if (path.length === 0) {
    if (!data.calendars.length) return unavailable("There's nothing to book online at the moment.");
    if (data.calendars.length === 1) return typesView(data.calendars[0], null);
    return {
      kind: "page", title: "Book an appointment",
      view: { kind: "calendars", calendars: data.calendars.map((c) => ({ name: c.name, intro: c.intro, href: bookingPath(c.slug), types: c.types.map((t) => ({ name: t.name, meta: metaOf(t), href: bookingPath(c.slug, t.slug) })) })) },
    };
  }
  // Anything outside the public set (unknown, archived or private alike) is the same "not found", so a visitor can't learn which private
  // calendars or appointment types exist.
  const cal = data.calendars.find((c) => c.slug === path[0]);
  if (!cal) return { kind: "not_found" };
  if (path.length === 1) return typesView(cal, data.calendars.length > 1 ? BOOK_BASE : null);
  const type = cal.types.find((t) => t.slug === path[1]);
  const target = publicTarget(ws, cal.slug, path[1]);
  if (!type || !target) return { kind: "not_found" };
  const row = target.type;

  const q = input.query;
  const tz = validZone(q.tz) ? q.tz : ws.timezone;
  const pagePath = bookingPath(cal.slug, type.slug);
  const tzParam = tz === ws.timezone ? undefined : tz;
  const calendarHref = cal.types.length > 1 || data.calendars.length > 1 ? bookingPath(cal.slug) : null;
  const summary = { name: type.name, meta: metaOf(type), description: type.description };

  const shown = await withSitePublicType(site, row.id, async (ctx, slots) => {
    if (q.s && ISO.test(q.s)) {
      const start = Date.parse(q.s);
      const exact = await slots({ from: new Date(start - 60_000), to: new Date(start + 60_000), now });
      if (exact.some((s) => Date.parse(s.start) === start)) {
        const view: BookingFormView = {
          kind: "form", calendar: { name: cal.name, href: calendarHref }, type: summary,
          when: whenLabel(start, start + ctx.type.durationMinutes * 60_000, tz), zoneLabel: `Time zone: ${zoneLabel(tz, start)}`,
          changeHref: query(pagePath, { tz: tzParam, w: isDate(q.w) ? q.w : undefined, d: zonedDate(start, tz) }),
          action: BOOK_ACTION,
          hidden: { t: issueFormToken(host, now.getTime()), k: crypto.randomUUID(), c: cal.slug, y: type.slug, s: new Date(start).toISOString(), tz },
          requireEmail: row.require_email, requirePhone: row.require_phone,
          questions: ctx.type.questions.filter((x) => /^[a-z0-9_]{1,40}$/.test(x.key)).slice(0, 10).map((x) => ({ key: x.key, label: clip(x.label, 120), type: x.type === "textarea" || x.type === "select" ? x.type : "text", required: x.required === true, options: x.type === "select" ? (x.options ?? []).filter((o) => typeof o === "string" && o.length > 0 && o.length <= 100) : [] })),
          needsConfirmation: ctx.type.requiresConfirmation,
          notice: q.m ? FORM_NOTICES[q.m] ?? null : null,
        };
        return { kind: "page", title: `Your details: ${type.name}`, view } satisfies SiteBookingPage;
      }
      const times = await timesView(slots, ctx, { tz, businessTz: ws.timezone, path: pagePath, q: { ...q, d: zonedDate(start, tz), w: undefined }, now, calendarHref, calendarName: cal.name, summary, notice: TIMES_NOTICES.gone });
      return { kind: "page", title: `Choose a time: ${type.name}`, view: times } satisfies SiteBookingPage;
    }
    const times = await timesView(slots, ctx, { tz, businessTz: ws.timezone, path: pagePath, q, now, calendarHref, calendarName: cal.name, summary, notice: q.m ? TIMES_NOTICES[q.m] ?? null : null });
    return { kind: "page", title: `Choose a time: ${type.name}`, view: times } satisfies SiteBookingPage;
  });
  // The type stopped being public between the two reads: the same answer as any other page outside the public set.
  return shown ?? { kind: "not_found" };
}

const metaOf = (t: SiteBookingType) => [durationLabel(t.durationMinutes), t.location].filter(Boolean).join(" · ");

async function timesView(
  slotsIn: SiteSlots, ctx: BookingContext,
  o: { tz: string; businessTz: string; path: string; q: Record<string, string | undefined>; now: Date; calendarHref: string | null; calendarName: string; summary: BookingTimesView["type"]; notice: BookingNotice | null },
): Promise<BookingTimesView> {
  const { tz, q, now } = o;
  const nowMs = now.getTime();
  const today = zonedDate(nowMs, tz);
  const lastDay = zonedDate(nowMs + ctx.type.maxDaysAhead * 86_400_000, tz);
  let w = isDate(q.w) ? q.w : today;
  if (isDate(q.d) && (q.d < w || q.d >= addDays(w, WINDOW_DAYS))) w = q.d;
  if (w < today) w = today;
  if (w > lastDay) w = lastDay;
  const end = addDays(w, WINDOW_DAYS);
  const slots = await slotsIn({ from: new Date(zonedToInstant(w, 0, tz)), to: new Date(zonedToInstant(end, 0, tz)), now });
  const byDay = new Map<string, typeof slots>();
  for (const s of slots) {
    const d = zonedDate(Date.parse(s.start), tz);
    byDay.set(d, [...(byDay.get(d) ?? []), s]);
  }
  const tzParam = tz === o.businessTz ? undefined : tz;
  const wParam = w === today ? undefined : w;
  const selected: string | null = isDate(q.d) && byDay.has(q.d) ? q.d : [...byDay.keys()].sort()[0] ?? null;
  let notice = o.notice;
  if (!notice && isDate(q.d) && !byDay.has(q.d) && selected) notice = { tone: "info", text: `There are no times left on ${fmt("UTC", { weekday: "long", month: "long", day: "numeric" }).format(new Date(dateMs(q.d)))}. Here are the next ones.` };
  const days: BookingTimesView["days"] = [];
  for (let d = w; d < end; d = addDays(d, 1)) {
    const count = byDay.get(d)?.length ?? 0;
    const at = new Date(dateMs(d));
    days.push({
      date: d, weekday: fmt("UTC", { weekday: "short" }).format(at), day: fmt("UTC", { day: "numeric" }).format(at), month: fmt("UTC", { month: "short" }).format(at),
      label: fmt("UTC", { weekday: "long", month: "long", day: "numeric" }).format(at), count,
      href: count ? query(o.path, { tz: tzParam, w: wParam, d }) : null, selected: d === selected,
    });
  }
  const span = `${fmt("UTC", { month: "short", day: "numeric" }).format(new Date(dateMs(w)))} – ${fmt("UTC", { month: "short", day: "numeric" }).format(new Date(dateMs(addDays(end, -1))))}`;
  const prevStart = w > today ? (addDays(w, -WINDOW_DAYS) < today ? today : addDays(w, -WINDOW_DAYS)) : null;
  const hasNext = end <= lastDay;
  let empty: BookingTimesView["empty"] = null;
  if (!slots.length) {
    let next: { href: string; label: string } | null = null;
    if (hasNext) {
      const ahead = await slotsIn({ from: new Date(zonedToInstant(end, 0, tz)), to: new Date(zonedToInstant(addDays(end, 60), 0, tz)), now });
      if (ahead[0]) {
        const d = zonedDate(Date.parse(ahead[0].start), tz);
        next = { href: query(o.path, { tz: tzParam, w: d, d }), label: `Next available: ${fmt("UTC", { weekday: "short", month: "short", day: "numeric" }).format(new Date(dateMs(d)))}` };
      }
    }
    empty = { message: `There are no open times between ${span}.${next ? "" : " Please check back later, or contact us."}`, next };
  }
  const daySlots = selected ? byDay.get(selected) ?? [] : [];
  const time = fmt(tz, { hour: "numeric", minute: "2-digit" });
  return {
    kind: "times", calendar: { name: o.calendarName, href: o.calendarHref }, type: o.summary, path: o.path,
    carry: { ...(wParam ? { w: wParam } : {}), ...(selected ? { d: selected } : {}) },
    zone: { value: tz, label: zoneLabel(tz, nowMs), options: zoneOptions(tz, o.businessTz, nowMs) },
    range: { label: span, prev: prevStart ? query(o.path, { tz: tzParam, w: prevStart === today ? undefined : prevStart }) : null, next: hasNext ? query(o.path, { tz: tzParam, w: end }) : null },
    days,
    day: selected ? {
      label: fmt("UTC", { weekday: "long", month: "long", day: "numeric" }).format(new Date(dateMs(selected))),
      slots: daySlots.map((s) => ({ label: time.format(new Date(s.start)), href: query(o.path, { tz: tzParam, w: wParam, d: selected!, s: s.start }), note: s.remaining !== null ? `${s.remaining} ${s.remaining === 1 ? "place" : "places"} left` : "" })),
    } : null,
    empty,
    notice,
  };
}

// ---------------------------------------------------------------------------
// After booking
// ---------------------------------------------------------------------------

/** Signs an appointment id for this host, so the page after a repeated submit can show the booking without its manage link. */
const bookedMac = (host: string, appointmentId: string) => hashClient(`booked:${host}:${appointmentId.toLowerCase()}`);
const macOk = (host: string, id: string, mac: string) => {
  const a = Buffer.from(bookedMac(host, id));
  const b = Buffer.from(mac);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

/** The customer's manage pages live on the main app domain (APP_URL), whichever address the site was booked on. */
const onApp = (path: string) => new URL(path, env().APP_URL).toString();

/** The page after booking: /_booked/t/<manage token> or /_booked/a/<id>/<signature>, only for an appointment in this site's workspace. */
export async function siteBookedPage(site: LiveSite, host: string, ref: string[]): Promise<SiteBookingPage> {
  const contact = contactOf(site.content);
  let a: SiteAppointment | null = null;
  let token: string | null = null;
  if (ref[0] === "t" && ref.length === 2) {
    a = await siteAppointmentByToken(site, ref[1]);
    if (a) token = ref[1];
  } else if (ref[0] === "a" && ref.length === 3 && UUID_V.test(ref[1]) && /^[0-9a-f]{40}$/.test(ref[2]) && macOk(host, ref[1], ref[2])) {
    a = await siteAppointmentById(site, ref[1]);
  }
  if (!a) return { kind: "not_found" };
  const tz = isValidTimeZone(a.timezone) ? a.timezone : "UTC";
  const start = Date.parse(a.startAt);
  const end = Date.parse(a.endAt);
  const business = site.content.business.name;
  const repeat = token === null;
  const [title, lead] = a.status === "new"
    ? ["Booking requested", `Your time is held. ${business} still needs to confirm it.`]
    : a.status === "confirmed"
      ? ["You're booked", "Your appointment is confirmed."]
      : a.status === "cancelled"
        ? ["This booking was cancelled", "This appointment has been cancelled."]
        : ["Your booking", ""];
  const allow = a.allowCustomerChanges;
  const view: BookingDoneView = {
    kind: "done", title,
    lead: repeat ? `We already had this booking, so nothing was booked twice. ${lead}`.trim() : lead,
    typeName: a.typeName, when: `${whenLabel(start, end, tz)} · ${zoneLabel(tz, start)}`, duration: durationLabel(Math.round((end - start) / 60_000)),
    location: a.location ?? "", meetingLink: a.meetingLink, message: clip(a.confirmationMessage, 500),
    manage: token && ["new", "confirmed"].includes(a.status)
      ? {
          href: onApp(manageUrl(token)), label: allow ? "Reschedule or cancel" : "View your booking", calendarFile: onApp(bookingIcsUrl(token)),
          note: allow ? "Save this link: it lets you reschedule or cancel without signing in. Anyone with the link can change this booking." : "Save this link to see your booking. To change it, contact us.",
        }
      : null,
    contact, againHref: BOOK_BASE,
  };
  return { kind: "page", title, view };
}

// ---------------------------------------------------------------------------
// The booking form's endpoint
// ---------------------------------------------------------------------------

export interface SiteBookingRequest {
  host: string;
  origin: string | null;
  secFetchSite: string | null;
  forwardedFor: string | null;
  fields: Record<string, string>;
  now?: number;
}
export type SiteBookingResult = { kind: "redirect"; to: string } | { kind: "error"; status: number; message: string };

const fail = (status: number, message: string): SiteBookingResult => ({ kind: "error", status, message });

function sameSite(host: string, origin: string | null, secFetchSite: string | null): boolean {
  if (origin) {
    try {
      return new URL(origin).hostname.toLowerCase() === host;
    } catch {
      return false;
    }
  }
  return secFetchSite === "same-origin";
}

/** Where a validation problem sends the visitor: back to the same time, with a fixed message (never anything they typed). */
const formAgain = (c: string, y: string, s: string, tz: string | undefined, code: string) => ({ kind: "redirect" as const, to: query(bookingPath(c, y), { tz, s, m: code }) });
const timesAgain = (c: string, y: string, s: string, tz: string | undefined, code: string) => ({ kind: "redirect" as const, to: query(bookingPath(c, y), { tz, d: tz && ISO.test(s) ? zonedDate(Date.parse(s), tz) : undefined, m: code }) });

/**
 * The booking form's decisions, apart from the HTTP wiring so they can be tested. Same-site check, honeypot, the signed time token and rate
 * limits come first; then the calendar and type are looked up in the site's own workspace (public and live only) and the booking is made
 * with the booking page's actor. A repeat of the same form (same `k`) returns the booking the first one made.
 */
export async function handleSiteBooking(req: SiteBookingRequest): Promise<SiteBookingResult> {
  const site = await resolveSite(req.host);
  if (!site) return fail(404, "This site isn't available.");
  if (!sameSite(req.host, req.origin, req.secFetchSite)) return fail(403, "Bookings can only be made from the website itself.");
  const f = req.fields;
  const c = clip(f.c, 60);
  const y = clip(f.y, 60);
  const s = clip(f.s, 40);
  if (!isSlugRef(c) || !isSlugRef(y) || !ISO.test(s)) return fail(400, "That booking form wasn't complete. Go back and choose your time again.");
  // A real visitor never sees this field. Whatever fills it is sent back to the start, and nothing is booked.
  if (clip(f.company_website, 200)) return { kind: "redirect", to: bookingPath(c, y) };
  const tzRaw = clip(f.tz, 64);
  const tzGiven = validZone(tzRaw) ? tzRaw : undefined;
  const token = checkFormToken(req.host, f.t, req.now);
  if (!token.ok) {
    if (token.reason === "too_fast") return formAgain(c, y, s, tzGiven, "fast");
    if (token.reason === "expired") return timesAgain(c, y, s, tzGiven, "expired");
    return fail(400, "This booking form has expired. Go back, reload the page and try again.");
  }
  const client = hashClient(firstIp(req.forwardedFor));
  if (!(await siteRateLimit(`book:ip:${client}`, 6, 600)) || !(await siteRateLimit(`book:host:${req.host}`, 120, 3600))) {
    return fail(429, "We've received a lot of booking requests from here. Please wait a few minutes and try again.");
  }
  if (!contentUsesBooking(site.content)) return fail(404, "This site isn't taking bookings.");
  const k = clip(f.k, 40);
  if (!UUID_V.test(k)) return fail(400, "That booking form wasn't complete. Go back and choose your time again.");

  const ws = await siteWorkspaceBooking(site);
  if (!ws.native) return { kind: "redirect", to: BOOK_BASE };
  const target = publicTarget(ws, c, y);
  if (!target) return fail(404, "That booking page isn't available any more.");
  const type = target.type;
  const tz = tzGiven ?? ws.timezone;

  const name = clip(f.name, 120);
  const email = clip(f.email, 320).toLowerCase();
  const phoneRaw = clip(f.phone, 30);
  if (name.length < 2) return formAgain(c, y, s, tz, "name");
  if (email && !normalizeEmail(email)) return formAgain(c, y, s, tz, "email");
  if (type.require_email && !email) return formAgain(c, y, s, tz, "email");
  const phone = phoneRaw ? normalizePhone(phoneRaw, ws.callingCode ?? undefined) : null;
  if (phoneRaw && !phone) return formAgain(c, y, s, tz, "phone");
  if (type.require_phone && !phone) return formAgain(c, y, s, tz, "phone");
  if (!email && !phone) return formAgain(c, y, s, tz, "contact");
  const answers: Record<string, string> = {};
  for (const [key, value] of Object.entries(f)) {
    if (key.startsWith("q_") && /^q_[a-z0-9_]{1,40}$/.test(key)) answers[key.slice(2)] = String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, 2000);
  }
  const [first, ...rest] = name.split(/\s+/);

  try {
    const res = await bookOnSite(site, {
      typeId: type.id, startAt: new Date(Date.parse(s)),
      contact: { firstName: first, lastName: rest.join(" ") || null, displayName: name, email: email || null, phone, timezone: tz, source: "Website booking" },
      answers, inviteeTimezone: tz, notes: clip(f.notes, 2000) || null, idempotencyKey: `site:${k.toLowerCase()}`,
      now: req.now !== undefined ? new Date(req.now) : undefined,
    });
    if (res.manageToken) return { kind: "redirect", to: `${BOOKED_BASE}/t/${res.manageToken}` };
    return { kind: "redirect", to: `${BOOKED_BASE}/a/${res.appointmentId}/${bookedMac(req.host, res.appointmentId)}` };
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    const msg = err.message;
    // "Just taken" is a race the database settled; "no longer available" also covers a time that has moved inside the notice period.
    if (err.code === "conflict") return /GoHighLevel/.test(msg) ? { kind: "redirect", to: BOOK_BASE } : timesAgain(c, y, s, tz, /just taken/i.test(msg) ? "taken" : "gone");
    if (err.code === "invalid_input") {
      const code = /email address or a phone/i.test(msg) ? "contact" : /email/i.test(msg) ? "email" : /phone|country code/i.test(msg) ? "phone" : /answer|option/i.test(msg) ? "answers" : /name/i.test(msg) ? "name" : "invalid";
      return formAgain(c, y, s, tz, code);
    }
    if (err.code === "not_found") return fail(404, "That booking page isn't available any more.");
    return fail(400, "We couldn't book that. Please go back and try again.");
  }
}

const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** A plain page for the few problems that can't go back to the booking pages (a forged form, too many attempts). */
export const bookingErrorPage = (message: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Booking not made</title></head>` +
  `<body style="font-family:ui-sans-serif,system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f8f9fb;color:#101828;padding:1.5rem"><main style="max-width:28rem;text-align:center">` +
  `<h1 style="font-size:1.4rem;margin:0 0 .75rem">We couldn't book that</h1><p style="margin:0 0 1.25rem;color:#475467">${esc(message)}</p><a href="${BOOK_BASE}" style="color:#1d3fd0;font-weight:600">Back to booking</a></main></body></html>`;
