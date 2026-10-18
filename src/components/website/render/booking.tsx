// The "Book appointment" element. It is plain links: a button to the site's own booking pages, and (as a list or a card) the workspace's
// public appointment types, each linking straight to its times. No script, no frame: a visitor without JavaScript books the same way.
import * as React from "react";
import { durationLabel, resolveBooking, bookingPath, type SiteBookingType } from "@/lib/website/booking";
import { Icon } from "./icons";
import { displayPhone, rootProps, telHref, Txt } from "./parts";
import type { ElementProps, RenderCtx } from "./ctx";

const s = (v: unknown) => (typeof v === "string" ? v : "");

/** Shown only where there is no workspace behind the page (template gallery, thumbnails, draft previews), and always labelled. */
const EXAMPLES: SiteBookingType[] = [
  { slug: "", name: "Example: Consultation", durationMinutes: 30, description: "", location: "Video call" },
  { slug: "", name: "Example: Site visit", durationMinutes: 60, description: "", location: "In person" },
];

function TypeRows({ types, hrefFor, compact }: { types: SiteBookingType[]; hrefFor: (t: SiteBookingType) => string; compact?: boolean }) {
  return (
    <ul className="iq-bk-types" data-compact={compact ? "" : undefined}>
      {types.map((t, i) => {
        const meta = [durationLabel(t.durationMinutes), t.location].filter(Boolean).join(" · ");
        return (
          <li key={t.slug || i}>
            <a className="iq-bk-type" href={hrefFor(t)}>
              <span className="iq-bk-type-main">
                <span className="iq-bk-type-name">{t.name}</span>
                <span className="iq-bk-type-meta"><Icon name="clock" className="iq-bk-type-ic" /><span>{meta}</span></span>
                {!compact && t.description && <span className="iq-bk-type-desc">{t.description}</span>}
              </span>
              <span className="iq-bk-type-go" aria-hidden><Icon name="arrow-right" /></span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

function BookButton({ el, ctx, p, href }: { el: ElementProps["el"]; ctx: RenderCtx; p: Record<string, unknown>; href: string }) {
  const label = s(p.label);
  return (
    <a className="iq-btn iq-bk-btn" href={href} data-v={s(p.variant) || "primary"} data-s={s(p.size) || "m"}>
      <Icon name="calendar" className="iq-btn-ic" />
      <Txt ctx={ctx} id={el.id} path="label" value={ctx.edit ? label : label.trim() || "Book an appointment"} className="iq-btn-l" plain placeholder="Book an appointment" />
    </a>
  );
}

/** A live page whose booking can't be used any more (a calendar was made private after publishing): say so, and offer the other ways in. */
function Unavailable({ el, ctx, index }: { el: ElementProps["el"]; ctx: RenderCtx; index?: number }) {
  const b = ctx.content.business;
  return (
    <p {...rootProps(el, ctx, "iq-bk-off", index)}>
      Online booking isn&apos;t available right now.
      {b.phone && <> Call <a href={telHref(b.phone)}>{displayPhone(b.phone)}</a>{b.email ? " or email " : "."}</>}
      {b.email && <>{!b.phone && " Email "}<a href={`mailto:${b.email}`}>{b.email}</a>.</>}
    </p>
  );
}

export function BookingEl({ el, ctx, p, index }: ElementProps & { index?: number }) {
  const display = s(p.display) || "button";
  const helper = s(p.helper);
  const live = ctx.mode === "published";
  const resolved = resolveBooking(ctx.booking, s(p.calendar), s(p.type));
  const root = { ...rootProps(el, ctx, "iq-bk", index), "data-display": display };
  const note = helper ? <p className="iq-note iq-bk-note">{helper}</p> : null;

  if (!resolved) {
    if (live) return <Unavailable el={el} ctx={ctx} index={index} />;
    // The editor knows the workspace: explain exactly why visitors couldn't book from here (publishing is blocked until it's fixed).
    if (ctx.booking) {
      const calendar = s(p.calendar);
      const why = !ctx.booking.available
        ? ctx.booking.reason || "Online booking isn't available in this workspace."
        : calendar && !ctx.booking.calendars.some((c) => c.slug === calendar)
          ? "The chosen calendar isn't public, or no longer exists."
          : ctx.booking.calendars.length === 0
            ? "There is no public calendar with a public appointment type yet."
            : "The chosen appointment type isn't public, or no longer exists.";
      return (
        <div {...root}>
          <p className="iq-bk-flag" data-tone="warn"><Icon name="calendar" className="iq-bk-flag-ic" />Booking isn&apos;t ready for visitors: {why}</p>
          {display !== "types" && <BookButton el={el} ctx={ctx} p={p} href="#" />}
        </div>
      );
    }
  }

  const types = resolved?.types ?? EXAMPLES;
  const example = !resolved;
  const href = live && resolved ? resolved.href : "#";
  const typeHref = (t: SiteBookingType) => (live && resolved && t.slug ? bookingPath(resolved.calendar.slug, t.slug) : "#");
  const flag = example && display !== "button" ? <p className="iq-bk-flag">Examples only: your public appointment types appear here on your website.</p> : null;

  if (display === "types") {
    return (
      <div {...root}>
        {flag}
        <TypeRows types={types} hrefFor={typeHref} />
        {note}
      </div>
    );
  }
  if (display === "card") {
    const single = types.length === 1 ? types[0] : null;
    const title = example ? "Book an appointment" : single ? single.name : resolved!.calendar.name;
    const sub = example ? "" : single ? single.description || resolved!.calendar.intro : resolved!.calendar.intro;
    return (
      <div {...root}>
        {flag}
        <div className="iq-bk-head">
          <span className="iq-bk-ic" aria-hidden><Icon name="calendar-check" /></span>
          <span className="iq-bk-head-t">
            <span className="iq-bk-title">{title}</span>
            {single && !example && <span className="iq-bk-type-meta"><Icon name="clock" className="iq-bk-type-ic" /><span>{[durationLabel(single.durationMinutes), single.location].filter(Boolean).join(" · ")}</span></span>}
            {sub && <span className="iq-bk-sub">{sub}</span>}
          </span>
        </div>
        {!single && <TypeRows types={types} hrefFor={typeHref} compact />}
        <BookButton el={el} ctx={ctx} p={p} href={href} />
        {note}
      </div>
    );
  }
  return (
    <div {...root}>
      <BookButton el={el} ctx={ctx} p={p} href={href} />
      {note}
    </div>
  );
}
