// The Website Studio's "Book appointment" element and a site's own booking pages share these shapes and rules. Pure (no I/O), so the
// editor, the renderer and the server all decide the same way which calendar an element books into and where its links go.
//
// A booking element stores slugs, never ids or URLs: an empty calendar means "the workspace's default public calendar" and an empty type
// means "every public type in it", so a template or a saved section can carry the element to any workspace. Links are computed when the
// page is drawn, because the document's link rules (safeHref) deliberately refuse the "_" these addresses use.
import { eachElement, type ElementNode, type SiteContent } from "./doc";

/** Where a site's booking pages live. A page address can never contain "_", so these can't collide with a page. */
export const BOOK_BASE = "/_book";
/** Where a visitor lands after booking. */
export const BOOKED_BASE = "/_booked";
/** Where the booking form posts. Same host, like the enquiry form. */
export const BOOK_ACTION = "/__iaq/book";

/** A calendar or appointment type slug, as `slugify` makes them. */
export const SLUG_REF = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const isSlugRef = (v: string) => v.length <= 60 && SLUG_REF.test(v);

export interface SiteBookingType {
  slug: string;
  name: string;
  durationMinutes: number;
  /** Plain, shortened description. May be empty. */
  description: string;
  /** "Phone call", "Video call", "In person: …" or the owner's own words. Empty when the type names no location. */
  location: string;
}

export interface SiteBookingCalendar {
  slug: string;
  name: string;
  intro: string;
  isDefault: boolean;
  types: SiteBookingType[];
}

/**
 * What visitors may book: the workspace's live, public calendars that have at least one live, public appointment type. Nothing private
 * is ever in here, so it is safe to draw on a public page.
 */
export interface SiteBookingData {
  /** False when appointments (or contacts) are managed in another system, so a website can't book into iAcquire. */
  available: boolean;
  calendars: SiteBookingCalendar[];
  /** Why booking isn't possible, for the editor only. Never drawn on a live page. */
  reason?: string | null;
}

/** The editor's view of the workspace's calendars: every live calendar and type, public or not, so the pickers can explain each choice. */
export interface BookingOptions {
  /** Why the element can't take bookings in this workspace, in plain words, or null. */
  unavailable: string | null;
  calendars: Array<{
    slug: string;
    name: string;
    isDefault: boolean;
    public: boolean;
    types: Array<{ slug: string; name: string; durationMinutes: number; public: boolean }>;
  }>;
  /** The same data a live page receives, so the canvas draws exactly what visitors will see. */
  site: SiteBookingData;
  /** Where this workspace's calendars are managed. */
  manageHref: string;
}

export function bookingPath(calendarSlug?: string, typeSlug?: string): string {
  if (!calendarSlug) return BOOK_BASE;
  return `${BOOK_BASE}/${calendarSlug}${typeSlug ? `/${typeSlug}` : ""}`;
}

/** The calendar an element with no calendar of its own books into: the default calendar when it is public, otherwise the first public one. */
export function defaultCalendar(data: SiteBookingData | null | undefined): SiteBookingCalendar | null {
  if (!data?.available) return null;
  return data.calendars.find((c) => c.isDefault) ?? data.calendars[0] ?? null;
}

export interface ResolvedBooking {
  calendar: SiteBookingCalendar;
  /** The types the element offers: the one it names, or all of the calendar's public types. */
  types: SiteBookingType[];
  /** The element's own booking link: straight to the type when it names one, otherwise the calendar's list of types. */
  href: string;
}

/** What a booking element offers, or null when it can't take bookings (calendar or type missing, private, or booking off). */
export function resolveBooking(data: SiteBookingData | null | undefined, calendar: string, type: string): ResolvedBooking | null {
  if (!data?.available) return null;
  const cal = calendar ? (data.calendars.find((c) => c.slug === calendar) ?? null) : defaultCalendar(data);
  if (!cal) return null;
  const types = type ? cal.types.filter((t) => t.slug === type) : cal.types;
  if (!types.length) return null;
  // A calendar with a single type goes straight to its times: there is nothing to choose between.
  const only = type || (types.length === 1 ? types[0].slug : "");
  return { calendar: cal, types, href: bookingPath(cal.slug, only || undefined) };
}

/** "30 minutes", "1 hour", "1 hour 30 minutes". */
export function durationLabel(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return `${h} hour${h === 1 ? "" : "s"}${rest ? ` ${rest} minute${rest === 1 ? "" : "s"}` : ""}`;
}

/** Every booking element in a site, with where it is, in the order a reader meets them. */
export function bookingElements(content: SiteContent): Array<{ el: ElementNode; where: string }> {
  const out: Array<{ el: ElementNode; where: string }> = [];
  eachElement(content, (el, where) => {
    if (el.type === "booking") out.push({ el, where });
  });
  return out;
}

export const contentUsesBooking = (content: SiteContent) => bookingElements(content).length > 0;

const str = (v: unknown) => (typeof v === "string" ? v : "");
/** The calendar and type slugs an element stores (empty for "default" and "all"). */
export const bookingRefs = (el: ElementNode) => ({ calendar: str(el.props.calendar), type: str(el.props.type) });

// ---------------------------------------------------------------------------
// The site's booking pages. The server works out everything (times already in the visitor's chosen time zone, links already built) and
// the renderer only draws it, so the pages need no script and can't disagree with what the server will accept.
// ---------------------------------------------------------------------------

export interface BookingNotice {
  tone: "info" | "warn";
  text: string;
}

export interface BookingTypeSummary {
  name: string;
  /** "30 minutes · Video call" */
  meta: string;
  description: string;
}

export interface BookingTimesView {
  kind: "times";
  calendar: { name: string; href: string | null };
  type: BookingTypeSummary;
  /** The page's own address and the values a time-zone change keeps. */
  path: string;
  carry: Record<string, string>;
  zone: { value: string; label: string; options: Array<{ value: string; label: string }> };
  range: { label: string; prev: string | null; next: string | null };
  days: Array<{ date: string; weekday: string; day: string; month: string; label: string; count: number; href: string | null; selected: boolean }>;
  day: { label: string; slots: Array<{ label: string; href: string; note: string }> } | null;
  empty: { message: string; next: { href: string; label: string } | null } | null;
  notice: BookingNotice | null;
}

export interface BookingFormView {
  kind: "form";
  calendar: { name: string; href: string | null };
  type: BookingTypeSummary;
  when: string;
  zoneLabel: string;
  changeHref: string;
  action: string;
  hidden: Record<string, string>;
  requireEmail: boolean;
  requirePhone: boolean;
  questions: Array<{ key: string; label: string; type: "text" | "textarea" | "select"; required: boolean; options: string[] }>;
  /** The business confirms each booking itself, so the visitor is told it's a request. */
  needsConfirmation: boolean;
  notice: BookingNotice | null;
}

export interface BookingDoneView {
  kind: "done";
  title: string;
  lead: string;
  typeName: string;
  when: string;
  duration: string;
  location: string;
  meetingLink: string | null;
  message: string;
  /** The customer's manage link and an add-to-calendar file, both on the main app domain and authorized by the manage secret. */
  manage: { href: string; label: string; note: string; calendarFile: string } | null;
  contact: { phone: string; email: string };
  againHref: string;
}

export type BookingPageView =
  | { kind: "unavailable"; title: string; message: string; contact: { phone: string; email: string }; backHref: string | null }
  | { kind: "busy" }
  | { kind: "calendars"; calendars: Array<{ name: string; intro: string; href: string; types: Array<{ name: string; meta: string; href: string }> }> }
  | { kind: "types"; calendar: { name: string; intro: string }; types: Array<BookingTypeSummary & { href: string }>; backHref: string | null }
  | BookingTimesView
  | BookingFormView
  | BookingDoneView;
