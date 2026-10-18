// The Website Studio's "Book appointment" element and a site's own booking pages. Synthetic workspaces and sites only; nothing here
// contacts a calendar provider, a domain or GoHighLevel, and no message is sent.
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { env, resetEnvCache } from "@/server/env";
import { SiteRenderer } from "@/components/website/render/site-renderer";
import { BookingPage } from "@/components/website/render/booking-pages";
import { EditorServicesContext, type EditorServices } from "@/components/website/editor/context";
import { FieldEditor } from "@/components/website/editor/fields";
import { ELEMENT_DEFS, elementDefaults } from "@/lib/website/catalog";
import { isRef, parseContent, type Section, type SiteContent } from "@/lib/website/doc";
import { bookingPath, contentUsesBooking, resolveBooking, type SiteBookingData } from "@/lib/website/booking";
import { newElement } from "@/lib/website/editor/library";
import { insertElement } from "@/lib/website/ops";
import { checkReadiness } from "@/lib/website/lint";
import { ALL_TEMPLATE_KEYS, buildSite, sampleSite } from "@/lib/website/templates/index";
import { routeRequest } from "@/lib/site-routing";
import { createAppointmentType, createCalendar, setHostAvailability } from "@/server/calendars/setup";
import { issueFormToken } from "@/server/sites/form-token";
import { clearSiteCache, resolveSite, type LiveSite } from "@/server/sites/runtime";
import { renderSiteShell } from "@/server/sites/render";
import { clearSiteBookingCache, handleSiteBooking, siteBookedPage, siteBookingData, siteBookingPage, type SiteBookingRequest } from "@/server/sites/booking";
import { bookingOptionsFor, bookingReadiness } from "@/server/websites/booking-setup";
import { saveOnboardingStep } from "@/server/onboarding/service";
import { createWebsite, getDraft, PublishBlockedError, preflight, publishWebsite, saveDraft } from "@/server/websites/service";
import { ctxFor } from "./support/fixtures";
import { crmOrg, eventsFor, type CrmOrg } from "./support/crm";

const WEEKDAYS_9_TO_5 = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60 }));
// Monday 19 October 2026, 08:00 in Manila (00:00 UTC). Every page and booking below is worked out at this instant.
const NOW = new Date("2026-10-19T00:00:00Z");
const DOMAIN = "sites.booking.example";

const render = (content: SiteContent, opts: { mode?: "published" | "preview" | "edit"; booking?: SiteBookingData | null; page?: string } = {}) =>
  renderToStaticMarkup(React.createElement(SiteRenderer, {
    content, pageSlug: opts.page ?? "home", resolveAsset: () => null, mode: opts.mode ?? "published", formAction: opts.mode === "published" || !opts.mode ? "/__iaq/form" : null,
    formToken: "t", hrefFor: (s: string) => (s === "home" ? "/" : `/${s}`), booking: opts.booking,
  }));

/** A site's first section and column, where a test puts its booking element. */
function withBooking(content: SiteContent, props: Record<string, unknown>): { content: SiteContent; id: string } {
  const first = content.pages.find((p) => p.slug === "home")!.items.find((i): i is Section => !isRef(i))!;
  const el = newElement(content, "booking");
  Object.assign(el.props, props);
  return { content: insertElement(content, first.columns[0].id, 0, el), id: el.id };
}

const DATA: SiteBookingData = {
  available: true,
  calendars: [
    { slug: "consults", name: "Consultations", intro: "Pick a time that suits you.", isDefault: true, types: [
      { slug: "site-visit", name: "Site visit", durationMinutes: 60, description: "We come to you.", location: "In person: 12 Rizal Ave" },
      { slug: "quick-call", name: "Quick call", durationMinutes: 15, description: "", location: "Phone call" },
    ] },
    { slug: "repairs", name: "Repairs", intro: "", isDefault: false, types: [{ slug: "inspection", name: "Inspection", durationMinutes: 90, description: "", location: "" }] },
  ],
};

describe("the booking element in the document", () => {
  it("is additive: every template still parses, round-trips and renders exactly as before, with no booking markup", () => {
    for (const key of ALL_TEMPLATE_KEYS()) {
      for (const site of [sampleSite(key), buildSite(key, { businessName: "Test Co", industry: "other", services: [{ title: "Repairs" }] })]) {
        const parsed = parseContent(JSON.parse(JSON.stringify(site)));
        expect(parsed.ok, key).toBe(true);
        if (!parsed.ok) continue;
        expect(parsed.content, key).toEqual(site);
        expect(contentUsesBooking(parsed.content)).toBe(false);
        const html = render(parsed.content, { mode: "preview" });
        expect(html.length, key).toBeGreaterThan(500);
        expect(html).not.toContain("iq-bk");
      }
    }
  });

  it("parses a document with the element, keeps calendar and type as slugs, and refuses anything else", () => {
    const base = buildSite(ALL_TEMPLATE_KEYS()[0], { businessName: "Slug Co", industry: "other", services: [{ title: "Repairs" }] });
    const { content, id } = withBooking(base, {});
    const parsed = parseContent(content);
    expect(parsed.ok).toBe(true);
    const el = parsed.ok ? parsed.content.pages[0].items.flatMap((i) => (isRef(i) ? [] : i.columns.flatMap((c) => c.elements))).find((e) => e.id === id) : null;
    expect(el?.type).toBe("booking");
    expect(el?.props).toMatchObject({ calendar: "", type: "", display: "button", label: "Book an appointment", variant: "primary", size: "m", helper: "" });
    expect(ELEMENT_DEFS.booking).toMatchObject({ group: "Business", addable: true });
    expect(elementDefaults("booking")).toMatchObject({ calendar: "", type: "" });
    for (const bad of ["Bad Slug", "/_book/consults", "https://evil.example", "a_b", "x".repeat(61)]) {
      const r = parseContent(withBooking(base, { calendar: bad }).content);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/calendar from the list|characters/);
    }
    expect(parseContent(withBooking(base, { type: "Not A Slug" }).content).ok).toBe(false);
    expect(parseContent(withBooking(base, { calendar: "consults", type: "site-visit", display: "card" }).content).ok).toBe(true);
    expect(parseContent(withBooking(base, { display: "iframe" }).content).ok).toBe(false);
  });

  it("works out where an element books: the default public calendar, a named one, or nothing when it can't", () => {
    expect(resolveBooking(DATA, "", "")).toMatchObject({ calendar: { slug: "consults" }, href: "/_book/consults" });
    expect(resolveBooking(DATA, "", "quick-call")).toMatchObject({ types: [{ slug: "quick-call" }], href: "/_book/consults/quick-call" });
    // One type in the calendar: straight to its times.
    expect(resolveBooking(DATA, "repairs", "")?.href).toBe("/_book/repairs/inspection");
    expect(resolveBooking(DATA, "nope", "")).toBeNull();
    expect(resolveBooking(DATA, "consults", "nope")).toBeNull();
    expect(resolveBooking({ available: false, calendars: DATA.calendars }, "", "")).toBeNull();
    expect(bookingPath()).toBe("/_book");
  });

  it("draws real links to the site's booking pages, lists only the public types it was given, and needs no script", () => {
    const base = buildSite(ALL_TEMPLATE_KEYS()[3], { businessName: "Link Co", industry: "other", services: [{ title: "Repairs" }], phone: "+15125550100", email: "hi@link.example" });
    const button = render(withBooking(base, { label: "Book a visit" }).content, { booking: DATA });
    expect(button).toContain('href="/_book/consults"');
    expect(button).toContain("Book a visit");
    const list = render(withBooking(base, { display: "types" }).content, { booking: DATA });
    expect(list).toContain('href="/_book/consults/site-visit"');
    expect(list).toContain('href="/_book/consults/quick-call"');
    expect(list).toContain("Site visit");
    expect(list).toContain("1 hour · In person: 12 Rizal Ave");
    expect(list).toContain("15 minutes · Phone call");
    expect(list).not.toContain("Inspection"); // another calendar's type
    const card = render(withBooking(base, { display: "card", calendar: "repairs", label: "" }).content, { booking: DATA });
    expect(card).toContain("Inspection");
    expect(card).toContain('href="/_book/repairs/inspection"');
    expect(card).toContain("Book an appointment"); // an empty label falls back to honest default words
    for (const html of [button, list, card]) expect(html).not.toMatch(/<iframe|<script(?! type="application\/ld\+json")/);
    // A live page whose calendar went private after publishing says so and offers the other ways in, instead of a dead button.
    const off = render(withBooking(base, { calendar: "gone" }).content, { booking: DATA });
    expect(off).toContain("Online booking isn&#x27;t available right now.");
    expect(off).toContain('href="tel:+15125550100"');
    expect(off).not.toContain("/_book");
  });

  it("labels examples where there is no workspace, and explains in the editor why a choice can't take bookings", () => {
    const base = buildSite(ALL_TEMPLATE_KEYS()[5], { businessName: "Preview Co", industry: "other", services: [{ title: "Repairs" }] });
    const preview = render(withBooking(base, { display: "types" }).content, { mode: "preview" });
    expect(preview).toContain("Examples only");
    expect(preview).toContain("Example: Consultation");
    expect(preview).not.toContain("/_book");
    const edit = render(withBooking(base, { display: "types", calendar: "secret" }).content, { mode: "edit", booking: DATA });
    expect(edit).toContain("Booking isn&#x27;t ready for visitors");
    const ghl = render(withBooking(base, {}).content, { mode: "edit", booking: { available: false, calendars: [], reason: "Appointments are managed in GoHighLevel." } });
    expect(ghl).toContain("Appointments are managed in GoHighLevel.");
    // A booking element counts towards nothing the content checks block on: its words are checked like any other.
    const r = checkReadiness(withBooking(base, { label: "[Your label]" }).content);
    expect(r.blockers.some((b) => b.code === "placeholder")).toBe(true);
    // With no phone, no email and enquiries off, a booking element is still a way for visitors to reach the business.
    const quiet = { ...base, business: { ...base.business, phone: "", email: "" }, form: { ...base.form, enabled: false } };
    expect(checkReadiness(quiet).blockers.some((b) => b.code === "no_contact")).toBe(true);
    expect(checkReadiness(withBooking(quiet, {}).content).blockers.some((b) => b.code === "no_contact")).toBe(false);
  });

  it("routes only well-formed booking addresses to the booking pages, and posts only to the booking endpoint", () => {
    const route = (pathname: string) => routeRequest({ role: "sites", hostHeader: "a.example.com", pathname, portalHosts: ["app.iacquire.com"] });
    expect(route("/_book")).toEqual({ kind: "site", host: "a.example.com", target: "/site-runtime/a.example.com/book/p", isForm: false });
    expect(route("/_book/consults")).toMatchObject({ target: "/site-runtime/a.example.com/book/p/consults", isForm: false });
    expect(route("/_book/consults/site-visit/")).toMatchObject({ target: "/site-runtime/a.example.com/book/p/consults/site-visit" });
    expect(route("/__iaq/book")).toMatchObject({ target: "/site-runtime/a.example.com/book/submit", isForm: true });
    const token = "A".repeat(32);
    expect(route(`/_booked/t/${token}`)).toMatchObject({ target: `/site-runtime/a.example.com/book/done/t/${token}`, isForm: false });
    const id = "0f0e0d0c-0b0a-4908-8706-050403020100";
    expect(route(`/_booked/a/${id}/${"ab".repeat(20)}`)).toMatchObject({ target: `/site-runtime/a.example.com/book/done/a/${id}/${"ab".repeat(20)}` });
    // Anything else is just a page that doesn't exist; it never reaches the booking code.
    for (const bad of ["/_book/Consults", "/_book/a/b/c", "/_book/../admin", "/_book/a%2Fb", "/_booked/t/short", "/_booked/x/y"]) {
      expect(route(bad), bad).toMatchObject({ kind: "site", target: expect.stringContaining("/site-runtime/a.example.com/p/") });
    }
  });
});

// ---------------------------------------------------------------------------

interface Fixture { c: CrmOrg; host: string; site: LiveSite; calendarSlug: string; typeSlug: string; privateCalendarSlug: string; privateTypeSlug: string; askSlug: string }

/** A client workspace with a public calendar (one public type, one private type, one type with questions) and a private calendar. */
async function workspace(name: string): Promise<Omit<Fixture, "host" | "site">> {
  const c = await crmOrg({ name, timezone: "Asia/Manila" });
  const owner = c.actor("owner");
  await setHostAvailability(owner, c.people.owner.id, { timezone: "Asia/Manila", rules: WEEKDAYS_9_TO_5 });
  const cal = await createCalendar(owner, { name: "Consultations", public: true, members: [{ userId: c.people.owner.id }] });
  await createAppointmentType(owner, cal.id, { name: "Site visit", durationMinutes: 60, minNoticeMinutes: 60, maxDaysAhead: 30, locationKind: "in_person", locationDetail: "12 Rizal Ave", confirmationMessage: "Park at the back." });
  await createAppointmentType(owner, cal.id, { name: "Internal review", durationMinutes: 30, public: false });
  await createAppointmentType(owner, cal.id, {
    name: "Phone consult", durationMinutes: 30, minNoticeMinutes: 60, requirePhone: true, requireEmail: false,
    questions: [{ key: "topic", label: "What is it about?", type: "select", required: true, options: ["Roof", "Walls"] }],
  });
  await createCalendar(owner, { name: "Team only", public: false, members: [{ userId: c.people.owner.id }] });
  const slugs = (await withSystem((db) => db.query<{ cal: string; type: string; public: boolean; cal_public: boolean }>(
    "select c.slug as cal, t.slug as type, t.public, c.public as cal_public from crm_appointment_types t join crm_calendars c on c.id = t.calendar_id where t.org_id = $1", [c.org.id],
  ))).rows;
  const privateCal = (await withSystem((db) => db.query<{ slug: string }>("select slug from crm_calendars where org_id = $1 and not public", [c.org.id]))).rows[0].slug;
  return {
    c, calendarSlug: slugs[0].cal, typeSlug: slugs.find((s) => s.type === "site-visit")!.type, privateTypeSlug: slugs.find((s) => !s.public)!.type,
    askSlug: slugs.find((s) => s.type === "phone-consult")!.type, privateCalendarSlug: privateCal,
  };
}

/** Builds the workspace's website from onboarding answers, optionally with a booking element, publishes it and returns the live site. */
async function publish(w: Omit<Fixture, "host" | "site">, booking: Record<string, unknown> | null): Promise<{ host: string; site: LiveSite }> {
  const ctx = ctxFor(w.c.people.owner, w.c.org, "owner");
  await saveOnboardingStep(ctx, {
    answers: {
      "a.business_name": { value: w.c.org.name }, "a.industry": { value: "other" }, "a.description": { value: "We help people with their homes." },
      "a.contact_email": { value: "hello@booking.example" }, "b.services": { value: "Repairs, Inspections" },
    },
  });
  await createWebsite(ctx, { templateKey: "corp.summit" });
  const d = (await getDraft(ctx))!;
  const content = booking ? withBooking(d.content, booking).content : d.content;
  await saveDraft(ctx, { content, expectedRevision: d.revision });
  const live = async () => (await withSystem((db) => db.query<{ id: string }>("select published_publication_id as id from websites where org_id = $1", [w.c.org.id]))).rows[0].id;
  await publishWebsite(ctx, { acknowledgeClaims: true }, { probe: async () => ({ status: 200, body: `<i data-site-publication="${await live()}"></i>` }) });
  const sub = (await withSystem((db) => db.query<{ subdomain: string }>("select subdomain from websites where org_id = $1", [w.c.org.id]))).rows[0].subdomain;
  const host = `${sub}.${DOMAIN}`;
  clearSiteCache();
  const site = await resolveSite(host);
  if (!site) throw new Error("the site didn't go live");
  return { host, site };
}

let a: Fixture;
let b: Fixture;
let ip = 10;
const nextIp = () => `198.51.100.${(ip += 1)}`;

beforeAll(async () => {
  process.env.SITES_PROBE_ORIGIN = "http://127.0.0.1:9";
  process.env.SITES_BASE_DOMAIN = DOMAIN;
  resetEnvCache();
  const wa = await workspace("Booking Alpha");
  a = { ...wa, ...(await publish(wa, { display: "types" })) };
  const wb = await workspace("Booking Beta");
  b = { ...wb, ...(await publish(wb, null)) };
});
afterAll(() => {
  delete process.env.SITES_PROBE_ORIGIN;
  delete process.env.SITES_BASE_DOMAIN;
  resetEnvCache();
});

const page = (f: Fixture, path: string[], query: Record<string, string> = {}) => siteBookingPage(f.site, f.host, { path, query, forwardedFor: nextIp(), now: NOW });
const viewOf = async (f: Fixture, path: string[], query: Record<string, string> = {}) => {
  const r = await page(f, path, query);
  if (r.kind !== "page") throw new Error(`no page for ${path.join("/")}`);
  return r.view;
};
async function formFor(f: Fixture, start: string, type = f.typeSlug, tz?: string) {
  const v = await viewOf(f, [f.calendarSlug, type], { s: start, ...(tz ? { tz } : {}) });
  if (v.kind !== "form") throw new Error(`expected the details form, got ${v.kind}`);
  return v;
}
const post = (f: Fixture, fields: Record<string, string>, over: Partial<SiteBookingRequest> = {}): Promise<Awaited<ReturnType<typeof handleSiteBooking>>> =>
  handleSiteBooking({ host: f.host, origin: `https://${f.host}`, secFetchSite: "same-origin", forwardedFor: nextIp(), fields: { name: "Alex Kim", email: "", phone: "", notes: "", company_website: "", ...fields }, now: NOW.getTime() + 5_000, ...over });
const bookings = async (orgId: string) =>
  (await withSystem((db) => db.query<{ id: string; status: string; booked_via: string; contact_id: string; start_at: Date; invitee_timezone: string; answers: Record<string, string> }>(
    "select id, status, booked_via, contact_id, start_at, invitee_timezone, answers from appointment_refs where org_id = $1 and provider = 'native' order by created_at", [orgId],
  ))).rows;

describe("the site's booking pages", () => {
  it("list the workspace's public types and open times on the site's own host, in the visitor's chosen time zone", async () => {
    const start = await viewOf(a, []);
    // One public calendar: its types straight away, never the private calendar or the private type.
    expect(start.kind).toBe("types");
    if (start.kind !== "types") return;
    expect(start.types.map((t) => t.name)).toEqual(["Site visit", "Phone consult"]);
    expect(start.types[0]).toMatchObject({ meta: "1 hour · In person: 12 Rizal Ave", href: `/_book/${a.calendarSlug}/site-visit` });

    const times = await viewOf(a, [a.calendarSlug, a.typeSlug]);
    expect(times.kind).toBe("times");
    if (times.kind !== "times") return;
    expect(times.zone.value).toBe("Asia/Manila");
    expect(times.days).toHaveLength(14);
    expect(times.days[0]).toMatchObject({ date: "2026-10-19", weekday: "Mon", count: 8, selected: true });
    expect(times.days.find((d) => d.date === "2026-10-24")).toMatchObject({ count: 0, href: null }); // Saturday
    // 08:00 now with an hour's notice: 09:00 is the first time.
    expect(times.day?.slots[0]).toMatchObject({ label: "9:00 AM" });
    expect(times.day?.slots[0].href).toContain(`s=${encodeURIComponent("2026-10-19T01:00:00.000Z")}`);
    expect(times.range.prev).toBeNull();
    expect(times.range.next).toContain("w=2026-11-02");

    const ny = await viewOf(a, [a.calendarSlug, a.typeSlug], { tz: "America/New_York" });
    if (ny.kind !== "times") throw new Error("expected times");
    // 09:00 in Manila is 21:00 the evening before in New York.
    expect(ny.days[0]).toMatchObject({ date: "2026-10-18", selected: true });
    expect(ny.day?.slots[0].label).toBe("9:00 PM");
    expect(ny.zone.options.some((o) => o.value === "Asia/Manila" && o.label.includes("our time zone"))).toBe(true);
    // A made-up zone falls back to the business's.
    const odd = await viewOf(a, [a.calendarSlug, a.typeSlug], { tz: "Mars/Olympus" });
    expect(odd.kind === "times" && odd.zone.value).toBe("Asia/Manila");
  });

  it("render inside the site's own header and footer, with one h1, a same-host form, a trap field and a signed token", async () => {
    const form = await formFor(a, "2026-10-20T02:00:00.000Z");
    expect(form.when).toBe("Tuesday, October 20, 2026, 10:00 AM – 11:00 AM");
    expect(form.hidden).toMatchObject({ c: a.calendarSlug, y: a.typeSlug, s: "2026-10-20T02:00:00.000Z", tz: "Asia/Manila" });
    expect(form.hidden.k).toMatch(/^[0-9a-f-]{36}$/);
    const html = renderToStaticMarkup(await renderSiteShell(a.site, a.host, "Your details", React.createElement(BookingPage, { view: form })));
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain('action="/__iaq/book"');
    expect(html).toContain('name="company_website"');
    expect(html).toContain(`name="t" value="${form.hidden.t}"`);
    expect(html).toContain("Book this time");
    expect(html).toContain('class="iq-sec iq-header'); // the site's own header
    expect(html).not.toContain("<iframe");
    const times = await viewOf(a, [a.calendarSlug, a.typeSlug]);
    const timesHtml = renderToStaticMarkup(React.createElement(BookingPage, { view: times }));
    expect(timesHtml).toContain('method="get"');
    expect(timesHtml).toContain('aria-current="date"');
    // A slot that isn't offered (outside hours) can't be opened as a form; the visitor is shown the times with a note.
    const gone = await viewOf(a, [a.calendarSlug, a.typeSlug], { s: "2026-10-19T12:00:00.000Z" });
    expect(gone.kind === "times" && gone.notice?.text).toMatch(/no longer available/);
  });

  it("take a booking into the site's own workspace only, creating the contact, and show the time, place and manage link", async () => {
    // 10:00: the 09:00 slot sits exactly on the notice boundary, so a few seconds after the page loaded it is (rightly) no longer offered.
    const form = await formFor(a, "2026-10-19T02:00:00.000Z");
    const beforeB = (await bookings(b.c.org.id)).length;
    const res = await post(a, { ...form.hidden, email: "alex@example.test", phone: "+63 917 123 4567", notes: "Gate code 1234" });
    expect(res.kind).toBe("redirect");
    const to = res.kind === "redirect" ? res.to : "";
    expect(to).toMatch(/^\/_booked\/t\/[A-Za-z0-9_-]{20,64}$/);
    const rows = await bookings(a.c.org.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "confirmed", booked_via: "website", invitee_timezone: "Asia/Manila" });
    expect(new Date(rows[0].start_at).toISOString()).toBe("2026-10-19T02:00:00.000Z");
    expect((await bookings(b.c.org.id)).length).toBe(beforeB);
    const contact = (await withSystem((db) => db.query<{ org_id: string; display_name: string; first_name: string; email: string; phone: string; created_via: string; source: string }>(
      "select org_id, display_name, first_name, email::text as email, phone, created_via, source from contacts where id = $1", [rows[0].contact_id],
    ))).rows[0];
    expect(contact).toMatchObject({ org_id: a.c.org.id, display_name: "Alex Kim", first_name: "Alex", email: "alex@example.test", phone: "+639171234567", created_via: "booking", source: "Website booking" });
    expect((await eventsFor(a.c.org.id, "appointment.booked")).map((e) => e.payload.via)).toEqual(["website"]);

    const done = await siteBookedPage(a.site, a.host, to.split("/").slice(2));
    expect(done.kind).toBe("page");
    if (done.kind !== "page" || done.view.kind !== "done") return;
    expect(done.view).toMatchObject({ title: "You're booked", typeName: "Site visit", duration: "1 hour", message: "Park at the back." });
    expect(done.view.when).toContain("Monday, October 19, 2026, 10:00 AM – 11:00 AM");
    expect(done.view.location).toContain("12 Rizal Ave");
    expect(done.view.manage?.href).toBe(new URL(`/book/manage/${to.split("/").pop()}`, env().APP_URL).toString());
    const html = renderToStaticMarkup(React.createElement(BookingPage, { view: done.view }));
    expect(html).toContain("Reschedule or cancel");
    expect(done.view.manage?.calendarFile).toBe(new URL(`/api/public/booking/ics?token=${to.split("/").pop()}`, env().APP_URL).toString());
    // The same link on another site's host shows nothing.
    expect((await siteBookedPage(b.site, b.host, to.split("/").slice(2))).kind).toBe("not_found");
  });

  it("treat a repeated submit of the same form as the same booking, and tell a second visitor the time was just taken", async () => {
    const form = await formFor(a, "2026-10-19T03:00:00.000Z");
    const fields = { ...form.hidden, email: "sam@example.test" };
    const first = await post(a, fields);
    expect(first.kind === "redirect" && first.to).toMatch(/^\/_booked\/t\//);
    const again = await post(a, fields);
    expect(again.kind).toBe("redirect");
    const to = again.kind === "redirect" ? again.to : "";
    expect(to).toMatch(/^\/_booked\/a\/[0-9a-f-]{36}\/[0-9a-f]{40}$/);
    expect((await bookings(a.c.org.id)).filter((r) => new Date(r.start_at).toISOString() === "2026-10-19T03:00:00.000Z")).toHaveLength(1);
    const ref = to.split("/").slice(2);
    const done = await siteBookedPage(a.site, a.host, ref);
    expect(done.kind === "page" && done.view.kind === "done" && done.view.lead).toMatch(/already had this booking/);
    expect(done.kind === "page" && done.view.kind === "done" && done.view.manage).toBeNull();
    expect((await siteBookedPage(a.site, a.host, [ref[0], ref[1], "0".repeat(40)])).kind).toBe("not_found");
    expect((await siteBookedPage(b.site, b.host, ref)).kind).toBe("not_found"); // signed for this host only

    // Someone else had the same form open: their submit is refused kindly and sent back to that day's times.
    const other = { ...fields, k: crypto.randomUUID(), email: "jo@example.test" };
    const taken = await post(a, other);
    expect(taken).toEqual({ kind: "redirect", to: `/_book/${a.calendarSlug}/${a.typeSlug}?tz=Asia%2FManila&d=2026-10-19&m=gone` });
    const view = await viewOf(a, [a.calendarSlug, a.typeSlug], { d: "2026-10-19", m: "gone" });
    expect(view.kind === "times" && view.notice?.text).toMatch(/no longer available/);
    expect((await viewOf(a, [a.calendarSlug, a.typeSlug], { m: "taken" })).kind === "times").toBe(true);

    // A double click and two visitors at once: the database decides, and only one appointment exists for the time.
    const twice = await formFor(a, "2026-10-19T05:00:00.000Z");
    const same = { ...twice.hidden, email: "double@example.test" };
    const [x, y] = await Promise.all([post(a, same), post(a, same)]);
    expect([x, y].every((r) => r.kind === "redirect" && r.to.startsWith("/_booked/"))).toBe(true);
    const race = await formFor(a, "2026-10-19T06:00:00.000Z");
    const results = await Promise.all(["r1@example.test", "r2@example.test"].map((email) => post(a, { ...race.hidden, k: crypto.randomUUID(), email })));
    expect(results.filter((r) => r.kind === "redirect" && r.to.startsWith("/_booked/t/"))).toHaveLength(1);
    expect(results.filter((r) => r.kind === "redirect" && /m=(gone|taken)/.test(r.to))).toHaveLength(1);
    const at = (iso: string) => async () => (await bookings(a.c.org.id)).filter((r) => new Date(r.start_at).toISOString() === iso).length;
    expect(await at("2026-10-19T05:00:00.000Z")()).toBe(1);
    expect(await at("2026-10-19T06:00:00.000Z")()).toBe(1);
    expect(view.kind === "times" && view.day?.slots.some((s) => s.label === "11:00 AM")).toBe(false);
  });

  it("send a visitor back with a fixed message when details are missing, never with what they typed in the address", async () => {
    const form = await formFor(a, "2026-10-21T01:00:00.000Z");
    const back = async (fields: Record<string, string>) => {
      const r = await post(a, { ...form.hidden, ...fields });
      expect(r.kind).toBe("redirect");
      return r.kind === "redirect" ? r.to : "";
    };
    expect(await back({ name: "A", email: "x@example.test" })).toContain("m=name");
    expect(await back({ email: "not-an-email" })).toContain("m=email");
    expect(await back({ email: "" })).toContain("m=email"); // this type asks for an email
    expect(await back({ email: "ok@example.test", phone: "12" })).toContain("m=phone");
    const url = await back({ name: "Private Person", email: "private@example.test", phone: "abc" });
    expect(url).not.toMatch(/Private|private|abc/);
    const view = await viewOf(a, [a.calendarSlug, a.typeSlug], { s: "2026-10-21T01:00:00.000Z", m: "phone" });
    expect(view.kind === "form" && view.notice?.text).toMatch(/valid phone number/);
    // A type that needs a phone and an answer to its question.
    const ask = await formFor(a, "2026-10-21T02:00:00.000Z", a.askSlug);
    expect(ask).toMatchObject({ requireEmail: false, requirePhone: true, questions: [{ key: "topic", type: "select", required: true, options: ["Roof", "Walls"] }] });
    const noPhone = await post(a, { ...ask.hidden, email: "q@example.test", q_topic: "Roof" });
    expect(noPhone.kind === "redirect" && noPhone.to).toContain("m=phone");
    const noAnswer = await post(a, { ...ask.hidden, phone: "+63 917 555 0000" });
    expect(noAnswer.kind === "redirect" && noAnswer.to).toContain("m=answers");
    const wrong = await post(a, { ...ask.hidden, phone: "+63 917 555 0000", q_topic: "Hacking" });
    expect(wrong.kind === "redirect" && wrong.to).toContain("m=answers");
    const ok = await post(a, { ...ask.hidden, phone: "+63 917 555 0000", q_topic: "Walls" });
    expect(ok.kind === "redirect" && ok.to).toMatch(/^\/_booked\/t\//);
    expect((await bookings(a.c.org.id)).some((r) => r.answers?.topic === "Walls")).toBe(true);
  });

  it("refuse the trap field, forged, instant or stale tokens, other sites' pages and too many attempts", async () => {
    const form = await formFor(a, "2026-10-22T01:00:00.000Z");
    const count = async () => (await bookings(a.c.org.id)).length;
    const before = await count();
    expect(await post(a, { ...form.hidden, email: "bot@example.test", company_website: "http://spam.example" })).toEqual({ kind: "redirect", to: `/_book/${a.calendarSlug}/${a.typeSlug}` });
    for (const [origin, fetchSite] of [["https://evil.example", "cross-site"], [null, "cross-site"], [null, null]] as const) {
      expect(await post(a, { ...form.hidden, email: "x@example.test" }, { origin, secFetchSite: fetchSite })).toMatchObject({ kind: "error", status: 403 });
    }
    expect(await post(a, { ...form.hidden, email: "x@example.test", t: "" })).toMatchObject({ kind: "error", status: 400 });
    expect(await post(a, { ...form.hidden, email: "x@example.test", t: `${NOW.getTime()}.forged` })).toMatchObject({ kind: "error", status: 400 });
    expect(await post(a, { ...form.hidden, email: "x@example.test", t: issueFormToken(b.host, NOW.getTime()) })).toMatchObject({ kind: "error", status: 400 }); // another site's token
    expect(await post(a, { ...form.hidden, email: "x@example.test", t: issueFormToken(a.host, NOW.getTime() + 4_000) })).toMatchObject({ kind: "redirect", to: expect.stringContaining("m=fast") });
    expect(await post(a, { ...form.hidden, email: "x@example.test", t: issueFormToken(a.host, NOW.getTime() - 7 * 3600_000) })).toMatchObject({ kind: "redirect", to: expect.stringContaining("m=expired") });
    expect(await post(a, { ...form.hidden, email: "x@example.test", k: "not-a-key" })).toMatchObject({ kind: "error", status: 400 });
    // A form posted to another site's host is refused: the calendar is looked up in that site's own workspace.
    expect(await post(b, { ...form.hidden, t: issueFormToken(b.host, NOW.getTime()), email: "x@example.test" })).toMatchObject({ kind: "error", status: 404 });
    expect(await count()).toBe(before);
    let blocked = 0;
    for (let i = 0; i < 9; i += 1) {
      const r = await post(a, { ...form.hidden, name: "A", email: `rl${i}@example.test` }, { forwardedFor: "203.0.113.50" });
      if (r.kind === "error" && r.status === 429) blocked += 1;
    }
    expect(blocked).toBe(3); // six attempts per visitor every ten minutes
  });

  it("refuse private calendars and types, and a site without a booking element has no booking pages at all", async () => {
    // A private calendar or type answers exactly like one that doesn't exist, so a visitor can't learn their names.
    expect((await page(a, [a.privateCalendarSlug])).kind).toBe("not_found");
    expect((await page(a, [a.privateCalendarSlug, "anything"])).kind).toBe("not_found");
    expect((await page(a, [a.calendarSlug, a.privateTypeSlug])).kind).toBe("not_found");
    expect((await page(a, [a.calendarSlug, a.privateTypeSlug], { s: "2026-10-20T02:00:00.000Z" })).kind).toBe("not_found");
    expect((await page(a, [a.calendarSlug, "no-such-type"])).kind).toBe("not_found");
    expect((await page(a, ["no-such-calendar"])).kind).toBe("not_found");
    expect((await page(a, ["Bad", "x"])).kind).toBe("not_found");
    const form = await formFor(a, "2026-10-23T01:00:00.000Z");
    expect(await post(a, { ...form.hidden, c: a.privateCalendarSlug, email: "p@example.test" })).toMatchObject({ kind: "error", status: 404 });
    expect(await post(a, { ...form.hidden, y: a.privateTypeSlug, email: "p@example.test" })).toMatchObject({ kind: "error", status: 404 });
    expect((await page(b, [])).kind).toBe("not_found");
    expect((await page(b, [b.calendarSlug, b.typeSlug])).kind).toBe("not_found");
    const bForm = { ...form.hidden, c: b.calendarSlug, y: b.typeSlug, t: issueFormToken(b.host, NOW.getTime()), email: "p@example.test" };
    expect(await post(b, bForm)).toMatchObject({ kind: "error", status: 404 });
  });

  it("only take the site resolveSite returned: a copy, or one claiming another workspace, is refused before anything is read", async () => {
    const input = { path: [] as string[], query: {}, forwardedFor: nextIp(), now: NOW };
    expect((await siteBookingPage(a.site, a.host, input)).kind).toBe("page");
    await expect(siteBookingPage({ ...a.site } as LiveSite, a.host, input)).rejects.toThrow(/verified host/);
    await expect(siteBookingPage({ ...a.site, orgId: b.c.org.id } as LiveSite, a.host, input)).rejects.toThrow(/verified host/);
    await expect(siteBookedPage({ ...a.site, orgId: b.c.org.id } as LiveSite, a.host, ["t", "x".repeat(32)])).rejects.toThrow(/verified host/);
    // The resolved site itself can't be pointed at another workspace.
    expect(() => {
      (a.site as unknown as { orgId: string }).orgId = b.c.org.id;
    }).toThrow();
    expect(a.site.orgId).toBe(a.c.org.id);
  });

  it("say booking is unavailable when the workspace's appointments are managed in GoHighLevel", async () => {
    await withSystem((db) => db.query("update crm_workspaces set mode = 'ghl' where org_id = $1", [a.c.org.id]));
    try {
      clearSiteBookingCache();
      expect(await viewOf(a, [])).toMatchObject({ kind: "unavailable" });
      const form = { t: issueFormToken(a.host, NOW.getTime()), k: crypto.randomUUID(), c: a.calendarSlug, y: a.typeSlug, s: "2026-10-26T01:00:00.000Z", tz: "Asia/Manila", email: "g@example.test" };
      expect(await post(a, form)).toEqual({ kind: "redirect", to: "/_book" });
      expect((await siteBookingData(a.site)).available).toBe(false);
      const ready = await bookingReadiness(a.c.org.id, a.site.content);
      expect(ready.blockers.map((x) => x.code)).toEqual(["booking_unavailable"]);
      expect(ready.blockers[0].message).toMatch(/GoHighLevel/);
    } finally {
      await withSystem((db) => db.query("update crm_workspaces set mode = 'native' where org_id = $1", [a.c.org.id]));
      clearSiteBookingCache();
    }
  });

  it("draw the published page's booking element with the workspace's live public types", async () => {
    clearSiteBookingCache();
    const data = await siteBookingData(a.site);
    expect(data.calendars.map((c) => c.name)).toEqual(["Consultations"]);
    expect(data.calendars[0].types.map((t) => t.name)).toEqual(["Site visit", "Phone consult"]);
    const html = render(a.site.content, { booking: data });
    expect(html).toContain(`href="/_book/${a.calendarSlug}/site-visit"`);
    expect(html).not.toContain("Internal review");
    expect(html).not.toContain("Team only");
    const options = await bookingOptionsFor(a.c.org.id, { agency: false });
    expect(options.unavailable).toBeNull();
    expect(options.manageHref).toBe("/crm/calendars");
    expect(options.calendars.find((c) => c.name === "Team only")).toMatchObject({ public: false });
    expect(options.calendars.find((c) => c.name === "Consultations")?.types.find((t) => t.name === "Internal review")).toMatchObject({ public: false });
    expect((await bookingOptionsFor(a.c.org.id, { agency: true })).manageHref).toBe(`/admin/clients/${a.c.org.id}/crm/calendars`);
  });

  it("give the editor's pickers every calendar and type, flagging the private ones and saying who can be booked", async () => {
    const options = await bookingOptionsFor(a.c.org.id, { agency: false });
    const [calendarField, typeField] = ELEMENT_DEFS.booking.fields;
    const draw = (booking: EditorServices["booking"], field: typeof calendarField, value: string, siblings: Record<string, unknown> = {}) =>
      renderToStaticMarkup(React.createElement(EditorServicesContext.Provider, {
        value: { design: a.site.content.design, business: { phone: "", email: "" }, pages: [], assets: [], assetUrl: () => "", device: "desktop", openMedia: () => {}, canUpload: false, booking, refreshBooking: () => {} },
      }, React.createElement(FieldEditor, { spec: field, value, onChange: () => {}, scope: "t", siblings })));
    const ready = { state: "ready" as const, options };
    const cal = draw(ready, calendarField, "");
    expect(cal).toContain("Default calendar (Consultations)");
    expect(cal).toContain("Team only (private)");
    expect(cal).toContain('href="/crm/calendars"');
    expect(draw(ready, calendarField, a.privateCalendarSlug)).toContain("is private, so visitors can&#x27;t book it");
    expect(draw(ready, calendarField, "deleted-one")).toContain("deleted-one (no longer exists)");
    const types = draw(ready, typeField, "", { calendar: "" });
    expect(types).toContain("Every public type");
    expect(types).toContain("Internal review · 30 minutes (private)");
    expect(types).toContain("Visitors can book: Site visit (1 hour), Phone consult (30 minutes).");
    expect(draw(ready, typeField, a.privateTypeSlug, { calendar: a.calendarSlug })).toContain("is private, so visitors can&#x27;t book it.");
    // Template design has no workspace: the element always uses each client's default calendar.
    expect(draw(undefined, calendarField, "")).toContain("Uses each client&#x27;s default public calendar");
    expect(draw({ state: "loading" }, calendarField, "")).toContain("Loading your calendars");
  });
});

describe("publishing a site with a booking element", () => {
  it("is blocked, with a clear reason, until the element books into a live public native calendar and type", async () => {
    const w = await crmOrg({ name: "Booking Gamma", timezone: "Asia/Manila" });
    const owner = w.actor("owner");
    const content = withBooking(buildSite("corp.summit", { businessName: "Booking Gamma", industry: "other", services: [{ title: "Repairs" }], email: "hi@gamma.example" }), {}).content;
    const codes = async (c: SiteContent) => (await bookingReadiness(w.org.id, c)).blockers.map((x) => x.code);
    expect(await codes(content)).toEqual(["booking_no_calendar"]);
    const cal = await createCalendar(owner, { name: "Visits", public: true, members: [{ userId: w.people.owner.id }] });
    expect(await codes(content)).toEqual(["booking_no_calendar"]); // no types yet
    await createAppointmentType(owner, cal.id, { name: "Visit", durationMinutes: 60 });
    // Public, but nobody has working hours, so no time could ever be offered.
    expect(await codes(content)).toEqual(["booking_no_hosts"]);
    await setHostAvailability(owner, w.people.owner.id, { timezone: "Asia/Manila", rules: WEEKDAYS_9_TO_5 });
    expect(await codes(content)).toEqual([]);
    await createCalendar(owner, { name: "Private", public: false, members: [{ userId: w.people.owner.id }] });
    await createAppointmentType(owner, cal.id, { name: "Hidden", durationMinutes: 30, public: false });
    const named = (props: Record<string, unknown>) => withBooking(content, props).content;
    expect(await codes(named({ calendar: "private" }))).toEqual(["booking_calendar_private"]);
    expect(await codes(named({ calendar: "gone" }))).toContain("booking_calendar_missing");
    expect(await codes(named({ calendar: "visits", type: "hidden" }))).toContain("booking_type_private");
    expect(await codes(named({ calendar: "visits", type: "nope" }))).toContain("booking_type_missing");
    const msg = (await bookingReadiness(w.org.id, named({ calendar: "private" }))).blockers.find((x) => x.code === "booking_calendar_private");
    expect(msg).toMatchObject({ message: expect.stringMatching(/"Private" is a private calendar/), where: expect.stringContaining("Book appointment") });
    expect(msg?.nodeId).toBeTruthy();

    // End to end: the owner's publish is refused while the element can't book, and the preflight says why.
    const ctx = ctxFor(w.people.owner, w.org, "owner");
    await saveOnboardingStep(ctx, { answers: { "a.business_name": { value: "Booking Gamma" }, "a.industry": { value: "other" }, "a.description": { value: "Home visits." }, "a.contact_email": { value: "hi@gamma.example" }, "b.services": { value: "Repairs" } } });
    await createWebsite(ctx, { templateKey: "corp.summit" });
    const d = (await getDraft(ctx))!;
    await saveDraft(ctx, { content: withBooking(d.content, { calendar: "private" }).content, expectedRevision: d.revision });
    const pf = await preflight(ctx);
    expect(pf.canPublishNow).toBe(false);
    expect(pf.blockers.map((x) => x.code)).toContain("booking_calendar_private");
    await expect(publishWebsite(ctx, { acknowledgeClaims: true }, { probe: async () => ({ status: 200, body: "" }) })).rejects.toBeInstanceOf(PublishBlockedError);
    const published = (await withSystem((db) => db.query<{ id: string | null }>("select published_publication_id as id from websites where org_id = $1", [w.org.id]))).rows[0].id;
    expect(published).toBeNull();
  });
});

describe("the site's booking pages for screen readers and the browser's own checks", () => {
  it("say a day has no times in text a screen reader reads, and give the phone field a pattern browsers can compile", async () => {
    const times = await viewOf(a, [a.calendarSlug, a.typeSlug]);
    expect(times.kind === "times" && times.days.find((d) => d.date === "2026-10-24")).toMatchObject({ count: 0, href: null }); // Saturday
    const html = renderToStaticMarkup(React.createElement(BookingPage, { view: times }));
    // A plain span can't be named, so "no times" is hidden text inside it rather than an aria-label that would be ignored.
    expect(html).toMatch(/<span class="iq-bk-day"><span class="iq-bk-day-w">Sat<\/span>(?:(?!<\/li>).)*<span class="iq-sr">, no times available<\/span><\/span>/);
    expect(html).not.toMatch(/<span class="iq-bk-day"[^>]*aria-(label|disabled)/);
    // Bookable days are still named links.
    expect(html).toMatch(/<a class="iq-bk-day" href="[^"]+" aria-label="[^"]+, 8 times available"/);

    const form = await formFor(a, "2026-10-20T02:00:00.000Z");
    const formHtml = renderToStaticMarkup(React.createElement(BookingPage, { view: form }));
    const pattern = /<input id="bk-phone"[^>]* pattern="([^"]+)"/.exec(formHtml)?.[1];
    expect(pattern).toBeTruthy();
    // Browsers compile the attribute as ^(?:…)$ with the v flag; under v, ( and ) in a class must be escaped or the check is dropped.
    for (const flag of ["u", "v"]) {
      const re = new RegExp(`^(?:${pattern})$`, flag);
      expect(["+63 917 123 4567", "(512) 555-0100", "+1 512.555.0100"].every((x) => re.test(x)), flag).toBe(true);
      expect(["abc", "12345", "+63 917 abc 4567"].some((x) => re.test(x)), flag).toBe(false);
    }
  });
});
