// The site's own booking pages, drawn inside the site's header and footer with its theme. Everything arrives worked out by the server
// (times in the visitor's chosen time zone, links, which fields are required), so these are plain links and forms: they work without
// JavaScript, and the browser's own validation catches a missing name or email before anything is sent.
import * as React from "react";
import type { BookingDoneView, BookingFormView, BookingNotice, BookingPageView, BookingTimesView, BookingTypeSummary } from "@/lib/website/booking";
import { Icon } from "./icons";
import { displayPhone, telHref } from "./parts";

/** The site's own home page. Plain links throughout: a customer's site ships no client-side router. */
const HOME = "/";
/**
 * The phone field's check in the browser. Browsers compile `pattern` with the `v` flag, where "(" and ")" inside a character class must
 * be escaped, and an invalid pattern is dropped without a word; the server checks the number again either way.
 */
export const PHONE_PATTERN = String.raw`[0-9+\(\)\-.\s]{7,30}`;

type Step = "service" | "time" | "details";
const STEPS: Array<{ id: Step; label: string }> = [
  { id: "service", label: "Service" },
  { id: "time", label: "Time" },
  { id: "details", label: "Your details" },
];

function Steps({ at, serviceHref, timeHref }: { at: Step; serviceHref?: string | null; timeHref?: string | null }) {
  const current = STEPS.findIndex((s) => s.id === at);
  return (
    <nav aria-label="Booking steps" className="iq-bk-steps">
      <ol>
        {STEPS.map((s, i) => {
          const href = s.id === "service" ? serviceHref : s.id === "time" ? timeHref : null;
          const done = i < current;
          const inner = <><span className="iq-bk-step-n" aria-hidden>{done ? <Icon name="check" /> : i + 1}</span><span>{s.label}</span></>;
          return (
            <li key={s.id} data-state={i === current ? "current" : done ? "done" : "next"} {...(i === current ? { "aria-current": "step" as const } : {})}>
              {done && href ? <a href={href}>{inner}</a> : inner}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function Notice({ notice }: { notice: BookingNotice | null }) {
  if (!notice) return null;
  return <p className="iq-bk-notice" data-tone={notice.tone} role={notice.tone === "warn" ? "alert" : "status"}>{notice.text}</p>;
}

function Contact({ contact, lead }: { contact: { phone: string; email: string }; lead: string }) {
  if (!contact.phone && !contact.email) return null;
  return (
    <p className="iq-bk-contact">
      {lead}{" "}
      {contact.phone && <a href={telHref(contact.phone)}><Icon name="phone" className="iq-bk-inline-ic" />{displayPhone(contact.phone)}</a>}
      {contact.phone && contact.email && " · "}
      {contact.email && <a href={`mailto:${contact.email}`}><Icon name="mail" className="iq-bk-inline-ic" />{contact.email}</a>}
    </p>
  );
}

function Shell({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <section className="iq-sec iq-bk-page" aria-label={label}>
      <div className="iq-wrap">{children}</div>
    </section>
  );
}

function TypeHead({ type, calendar }: { type: BookingTypeSummary; calendar: { name: string } }) {
  return (
    <header className="iq-bk-pagehead">
      <p className="iq-eyebrow iq-bk-eyebrow">{calendar.name}</p>
      <h1 className="iq-h iq-bk-h1">{type.name}</h1>
      <p className="iq-bk-type-meta"><Icon name="clock" className="iq-bk-type-ic" /><span>{type.meta}</span></p>
      {type.description && <p className="iq-bk-lede">{type.description}</p>}
    </header>
  );
}

function Times({ v }: { v: BookingTimesView }) {
  return (
    <Shell label="Choose a time">
      <Steps at="time" serviceHref={v.calendar.href} />
      <TypeHead type={v.type} calendar={v.calendar} />
      <Notice notice={v.notice} />
      <div className="iq-bk-panel">
        <form className="iq-bk-zone" method="get" action={v.path}>
          {Object.entries(v.carry).map(([k, val]) => <input key={k} type="hidden" name={k} value={val} />)}
          <label htmlFor="bk-zone">Times are shown in</label>
          <span className="iq-bk-zone-row">
            <select id="bk-zone" name="tz" defaultValue={v.zone.value}>
              {v.zone.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <button type="submit" className="iq-btn" data-v="secondary" data-s="s"><span className="iq-btn-l">Update</span></button>
          </span>
        </form>
        <div className="iq-bk-range">
          <h2 className="iq-bk-h2" id="bk-days">{v.range.label}</h2>
          <span className="iq-bk-range-nav">
            {v.range.prev ? <a href={v.range.prev} className="iq-bk-pager"><span aria-hidden>←</span> Earlier dates</a> : <span className="iq-bk-pager" aria-disabled="true"><span aria-hidden>←</span> Earlier dates</span>}
            {v.range.next ? <a href={v.range.next} className="iq-bk-pager">Later dates <span aria-hidden>→</span></a> : <span className="iq-bk-pager" aria-disabled="true">Later dates <span aria-hidden>→</span></span>}
          </span>
        </div>
        <ul className="iq-bk-days" aria-labelledby="bk-days">
          {v.days.map((d) => {
            const inner = <><span className="iq-bk-day-w">{d.weekday}</span><span className="iq-bk-day-n">{d.day}</span><span className="iq-bk-day-m">{d.month}</span></>;
            return (
              <li key={d.date}>
                {d.href ? (
                  <a className="iq-bk-day" href={d.href} aria-label={`${d.label}, ${d.count} ${d.count === 1 ? "time" : "times"} available`} {...(d.selected ? { "aria-current": "date" as const } : {})}>{inner}</a>
                ) : (
                  // A plain span can't carry a name (aria-label is ignored on it), so the state is spoken from hidden text instead.
                  <span className="iq-bk-day">{inner}<span className="iq-sr">, no times available</span></span>
                )}
              </li>
            );
          })}
        </ul>
        {v.empty && (
          <div className="iq-bk-empty">
            <p>{v.empty.message}</p>
            {v.empty.next && <a className="iq-btn" data-v="secondary" data-s="s" href={v.empty.next.href}><span className="iq-btn-l">{v.empty.next.label}</span></a>}
          </div>
        )}
        {v.day && (
          <div className="iq-bk-daytimes">
            <h2 className="iq-bk-h2" id="bk-times">{v.day.label}</h2>
            <ul className="iq-bk-slots" aria-labelledby="bk-times">
              {v.day.slots.map((s) => (
                <li key={s.href}>
                  <a className="iq-bk-slot" href={s.href}>
                    <span>{s.label}</span>
                    {s.note && <span className="iq-bk-slot-note">{s.note}</span>}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Shell>
  );
}

function FormStep({ v }: { v: BookingFormView }) {
  const fid = (k: string) => `bk-${k}`;
  return (
    <Shell label="Your details">
      <Steps at="details" serviceHref={v.calendar.href} timeHref={v.changeHref} />
      <TypeHead type={v.type} calendar={v.calendar} />
      <Notice notice={v.notice} />
      <div className="iq-bk-when">
        <span className="iq-bk-ic" aria-hidden><Icon name="calendar-check" /></span>
        <span>
          <span className="iq-bk-when-t">{v.when}</span>
          <span className="iq-bk-when-z">{v.zoneLabel}</span>
        </span>
        <a href={v.changeHref} className="iq-bk-change">Change time</a>
      </div>
      <form className="iq-el iq-form iq-bk-form" data-layout="card" method="post" action={v.action} aria-label="Your details">
        <fieldset>
          {Object.entries(v.hidden).map(([k, val]) => <input key={k} type="hidden" name={k} value={val} />)}
          <div aria-hidden className="iq-trap"><label>Leave this field empty<input type="text" name="company_website" tabIndex={-1} autoComplete="off" /></label></div>
          <div className="iq-fields">
            <div className="iq-fld iq-fld-wide"><label htmlFor={fid("name")}>Your name</label><input id={fid("name")} name="name" required minLength={2} maxLength={120} autoComplete="name" /></div>
            <div className="iq-fld">
              <label htmlFor={fid("email")}>Email{!v.requireEmail && <span className="iq-opt"> (optional)</span>}</label>
              <input id={fid("email")} name="email" type="email" required={v.requireEmail} maxLength={320} autoComplete="email" />
            </div>
            <div className="iq-fld">
              <label htmlFor={fid("phone")}>Phone{!v.requirePhone && <span className="iq-opt"> (optional)</span>}</label>
              <input id={fid("phone")} name="phone" type="tel" inputMode="tel" required={v.requirePhone} maxLength={30} pattern={PHONE_PATTERN} autoComplete="tel" aria-describedby={fid("phone-hint")} />
              <span className="iq-bk-hint" id={fid("phone-hint")}>Include the country code, like +1 512 555 0100.</span>
            </div>
            {v.questions.map((q) => (
              <div key={q.key} className={`iq-fld${q.type === "textarea" ? " iq-fld-wide" : ""}`}>
                <label htmlFor={fid(`q-${q.key}`)}>{q.label}{!q.required && <span className="iq-opt"> (optional)</span>}</label>
                {q.type === "select" ? (
                  <select id={fid(`q-${q.key}`)} name={`q_${q.key}`} required={q.required} defaultValue="">
                    <option value="">Choose one</option>
                    {q.options.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : q.type === "textarea" ? (
                  <textarea id={fid(`q-${q.key}`)} name={`q_${q.key}`} rows={4} required={q.required} maxLength={2000} />
                ) : (
                  <input id={fid(`q-${q.key}`)} name={`q_${q.key}`} required={q.required} maxLength={300} />
                )}
              </div>
            ))}
            <div className="iq-fld iq-fld-wide"><label htmlFor={fid("notes")}>Anything we should know?<span className="iq-opt"> (optional)</span></label><textarea id={fid("notes")} name="notes" rows={3} maxLength={2000} /></div>
          </div>
          <button type="submit" className="iq-btn" data-v="primary" data-s="l" data-full=""><span className="iq-btn-l">{v.needsConfirmation ? "Request this time" : "Book this time"}</span></button>
          <p className="iq-note">
            {v.needsConfirmation ? "This time is held for you once you send it, and the business confirms it. " : ""}
            Your details are used to arrange and manage this appointment.
          </p>
        </fieldset>
      </form>
    </Shell>
  );
}

function Done({ v }: { v: BookingDoneView }) {
  const safeLink = v.meetingLink && /^https:\/\/[^\s"<>]+$/i.test(v.meetingLink) ? v.meetingLink : null;
  return (
    <Shell label="Booking confirmation">
      <header className="iq-bk-pagehead iq-bk-donehead">
        <span className="iq-bk-done-ic" aria-hidden><Icon name="calendar-check" /></span>
        <h1 className="iq-h iq-bk-h1">{v.title}</h1>
        <p className="iq-bk-lede">{v.lead}</p>
      </header>
      <dl className="iq-bk-panel iq-bk-summary">
        <div><dt>What</dt><dd>{v.typeName}{v.duration && <span className="iq-bk-muted"> · {v.duration}</span>}</dd></div>
        <div><dt>When</dt><dd>{v.when}</dd></div>
        {v.location && <div><dt>Where</dt><dd>{v.location}</dd></div>}
        {safeLink && <div><dt>Join</dt><dd><a href={safeLink} rel="noopener noreferrer">{safeLink}</a></dd></div>}
      </dl>
      {v.message && <p className="iq-bk-message">{v.message}</p>}
      {v.manage && (
        <div className="iq-bk-panel iq-bk-manage">
          <p className="iq-bk-manage-t">{v.manage.note}</p>
          <span className="iq-bk-manage-a">
            <a className="iq-btn" data-v="secondary" data-s="m" href={v.manage.href} rel="noreferrer"><span className="iq-btn-l">{v.manage.label}</span></a>
            <a className="iq-bk-ics" href={v.manage.calendarFile} rel="noreferrer"><Icon name="calendar" className="iq-bk-inline-ic" />Add to your calendar</a>
          </span>
        </div>
      )}
      <Contact contact={v.contact} lead={v.manage ? "Questions? Contact us:" : "To change it, contact us:"} />
      <p className="iq-bk-links"><a href={HOME}>Back to the website</a><a href={v.againHref}>Book another appointment</a></p>
    </Shell>
  );
}

/** One page of the booking flow. */
export function BookingPage({ view }: { view: BookingPageView }) {
  switch (view.kind) {
    case "busy":
      return (
        <Shell label="Booking">
          <h1 className="iq-h iq-bk-h1">Please try again in a few minutes</h1>
          <p className="iq-bk-lede">We&apos;ve had a lot of booking requests from your connection. Wait a few minutes, then reload this page.</p>
        </Shell>
      );
    case "unavailable":
      return (
        <Shell label="Booking">
          <h1 className="iq-h iq-bk-h1">{view.title}</h1>
          <p className="iq-bk-lede">{view.message}</p>
          <Contact contact={view.contact} lead="You can still reach us:" />
          <p className="iq-bk-links">{view.backHref && <a href={view.backHref}>See other ways to book</a>}<a href={HOME}>Back to the website</a></p>
        </Shell>
      );
    case "calendars":
      return (
        <Shell label="Choose a service">
          <Steps at="service" />
          <header className="iq-bk-pagehead"><h1 className="iq-h iq-bk-h1">Book an appointment</h1><p className="iq-bk-lede">Choose what you&apos;d like to book.</p></header>
          {view.calendars.map((c) => (
            <section key={c.href} className="iq-bk-panel iq-bk-calendar" aria-label={c.name}>
              <h2 className="iq-bk-h2">{c.name}</h2>
              {c.intro && <p className="iq-bk-sub">{c.intro}</p>}
              <ul className="iq-bk-types" data-compact="">
                {c.types.map((t) => (
                  <li key={t.href}><a className="iq-bk-type" href={t.href}><span className="iq-bk-type-main"><span className="iq-bk-type-name">{t.name}</span><span className="iq-bk-type-meta"><Icon name="clock" className="iq-bk-type-ic" /><span>{t.meta}</span></span></span><span className="iq-bk-type-go" aria-hidden><Icon name="arrow-right" /></span></a></li>
                ))}
              </ul>
            </section>
          ))}
        </Shell>
      );
    case "types":
      return (
        <Shell label="Choose a service">
          <Steps at="service" />
          <header className="iq-bk-pagehead">
            <h1 className="iq-h iq-bk-h1">{view.calendar.name}</h1>
            {view.calendar.intro && <p className="iq-bk-lede">{view.calendar.intro}</p>}
          </header>
          <ul className="iq-bk-types">
            {view.types.map((t) => (
              <li key={t.href}>
                <a className="iq-bk-type" href={t.href}>
                  <span className="iq-bk-type-main">
                    <span className="iq-bk-type-name">{t.name}</span>
                    <span className="iq-bk-type-meta"><Icon name="clock" className="iq-bk-type-ic" /><span>{t.meta}</span></span>
                    {t.description && <span className="iq-bk-type-desc">{t.description}</span>}
                  </span>
                  <span className="iq-bk-type-go" aria-hidden><Icon name="arrow-right" /></span>
                </a>
              </li>
            ))}
          </ul>
          {view.backHref && <p className="iq-bk-links"><a href={view.backHref}>See other calendars</a></p>}
        </Shell>
      );
    case "times":
      return <Times v={view} />;
    case "form":
      return <FormStep v={view} />;
    case "done":
      return <Done v={view} />;
  }
}
