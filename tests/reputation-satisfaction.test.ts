// The Satisfaction view's numbers, from a workspace's own private feedback: CSAT and NPS only for enough answers (in total, in each week and in each segment), customers' own answers
// apart from anonymous survey answers, hand-recorded feedback counted but never scored, response rates, and the team's follow-up. Synthetic workspaces on embedded Postgres; the
// answers are written directly, so the sample sizes are exact.
import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { getSatisfaction } from "@/server/reputation/analytics";
import { MIN_RESPONSES } from "@/lib/reputation/scores";
import { MIN_ACKNOWLEDGED_SAMPLE } from "@/lib/reputation/satisfaction";
import { all, one, reputationShop, shopCustomer, type ReputationShop } from "./support/reputation";

const NOW = new Date("2026-10-23T12:00:00Z"); // a Friday: its week starts Monday 19 October
const at = (iso: string) => new Date(iso);

interface Put {
  contactId: string | null;
  source: "review_request" | "survey" | "manual" | "import";
  scale: "csat5" | "nps10";
  values: number[];
  at: string;
  requestId?: string | null;
  low?: boolean;
  status?: "new" | "escalated" | "acknowledged" | "resolved";
  ackAfterHours?: number;
}

/** Writes answers directly (one row per value), so a test controls exactly how many there are, of what kind, and when. */
async function put(orgId: string, p: Put) {
  for (const v of p.values) {
    await withSystem((db) => db.query(
      `insert into customer_feedback (org_id, contact_id, review_request_id, source, scale, rating, nps_score, received_at, low_score, follow_up_status, acknowledged_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, $10, case when $11::numeric is null then null else $8::timestamptz + make_interval(secs => $11::numeric * 3600) end)`,
      [orgId, p.contactId, p.requestId ?? null, p.source, p.scale, p.scale === "csat5" ? v : null, p.scale === "nps10" ? v : null, p.at, p.low ?? false, p.status ?? "new", p.ackAfterHours ?? null],
    ));
  }
}
const repeat = (value: number, n: number) => Array.from({ length: n }, () => value);

let s: ReputationShop;
let contactId: string;
beforeAll(async () => {
  s = await reputationShop("Satisfaction Shop");
  await withSystem((db) => db.query("update organizations set timezone = 'UTC' where id = $1", [s.m.org.id]));
  contactId = await shopCustomer(s);
});

describe("scores are shown only for enough answers", () => {
  it("shows the count and no score below the minimum, and the score from the minimum on, for each scale", async () => {
    const t = await reputationShop("Gate Shop");
    const c = await shopCustomer(t);
    await put(t.m.org.id, { contactId: c, source: "review_request", scale: "csat5", values: repeat(5, MIN_RESPONSES.csat5 - 1), at: "2026-10-20T10:00:00Z" });
    await put(t.m.org.id, { contactId: c, source: "survey", scale: "nps10", values: repeat(10, MIN_RESPONSES.nps10 - 1), at: "2026-10-20T10:00:00Z" });
    const few = await getSatisfaction(t.owner, { now: NOW });
    expect(few.named.csat).toMatchObject({ answers: MIN_RESPONSES.csat5 - 1, enough: false, percent: null, average: null });
    expect(few.named.nps).toMatchObject({ answers: MIN_RESPONSES.nps10 - 1, enough: false, score: null });
    await put(t.m.org.id, { contactId: c, source: "review_request", scale: "csat5", values: [5], at: "2026-10-20T10:00:00Z" });
    await put(t.m.org.id, { contactId: c, source: "survey", scale: "nps10", values: [10], at: "2026-10-20T10:00:00Z" });
    const enough = await getSatisfaction(t.owner, { now: NOW });
    expect(enough.named.csat).toMatchObject({ answers: MIN_RESPONSES.csat5, enough: true, percent: 100, average: 5 });
    expect(enough.named.nps).toMatchObject({ answers: MIN_RESPONSES.nps10, enough: true, score: 100, promoters: MIN_RESPONSES.nps10 });
  });
});

describe("what is counted, and where", () => {
  beforeAll(async () => {
    const org = s.m.org.id;
    // Customers' own answers, by week (weeks start on Monday): one week with enough, one with too few, one of recommend scores.
    await put(org, { contactId, source: "review_request", scale: "csat5", values: [5, 5, 5, 5, 4, 4, 3, 2, 1, 5], at: "2026-10-20T10:00:00Z" }); // week of 19 Oct: 7 of 10 satisfied
    await put(org, { contactId, source: "survey", scale: "csat5", values: [5, 5, 1], at: "2026-10-14T10:00:00Z" }); // week of 12 Oct: 3 answers
    await put(org, { contactId, source: "review_request", scale: "nps10", values: [...repeat(10, 15), ...repeat(8, 5), ...repeat(3, 10)], at: "2026-10-07T10:00:00Z" }); // week of 5 Oct: 15 promoters, 5 passives, 10 detractors
    // Outside the period (more than 30 days ago): never counted.
    await put(org, { contactId, source: "review_request", scale: "csat5", values: repeat(1, 20), at: "2026-08-01T10:00:00Z" });
    // A survey that knew nobody: reported apart.
    await put(org, { contactId: null, source: "survey", scale: "csat5", values: [...repeat(5, 6), ...repeat(4, 2), ...repeat(2, 4)], at: "2026-10-15T10:00:00Z" });
    // Recorded by hand or imported: counted, never scored.
    await put(org, { contactId, source: "manual", scale: "csat5", values: [5, 5], at: "2026-10-16T10:00:00Z" });
    await put(org, { contactId, source: "import", scale: "csat5", values: [1], at: "2026-10-16T10:00:00Z" });
    await put(org, { contactId, source: "manual", scale: "csat5", values: [5], at: "2026-08-02T10:00:00Z" });
  });

  it("scores the customer's own answers in the period, on each scale", async () => {
    const r = await getSatisfaction(s.owner, { now: NOW });
    expect(r.days).toBe(30);
    // 13 answers on 1 to 5: 9 rated 4 or 5, average 50 / 13.
    expect(r.named.csat).toMatchObject({ answers: 13, satisfied: 9, enough: true, percent: 69, average: 3.8 });
    // 30 recommend scores: 15 promoters, 5 passives, 10 detractors.
    expect(r.named.nps).toMatchObject({ answers: 30, promoters: 15, passives: 5, detractors: 10, enough: true, score: 17 });
  });

  it("reports an anonymous survey's answers on their own, and never mixes them into the numbers above", async () => {
    const r = await getSatisfaction(s.owner, { now: NOW });
    expect(r.anonymous.csat).toMatchObject({ answers: 12, satisfied: 8, enough: true, percent: 67 });
    expect(r.anonymous.nps.answers).toBe(0);
    expect(r.named.csat.answers).toBe(13); // the same as without them
  });

  it("counts feedback recorded by hand or imported in the period, and scores none of it", async () => {
    const r = await getSatisfaction(s.owner, { now: NOW });
    expect(r.handRecorded).toBe(3);
    const wide = await getSatisfaction(s.owner, { now: NOW, days: 365 });
    expect(wide.handRecorded).toBe(4);
    expect(wide.named.csat.answers).toBe(13 + 20); // the old low answers join a 12 months view; the hand-recorded ones still do not
  });

  it("reads other periods, and falls back to 30 days for a period that does not exist", async () => {
    const week = await getSatisfaction(s.owner, { now: NOW, days: 7 });
    expect(week.since).toBe(at("2026-10-16T12:00:00Z").toISOString());
    expect(week.named.csat.answers).toBe(10);
    expect(week.named.nps.answers).toBe(0);
    expect((await getSatisfaction(s.owner, { now: NOW, days: 11 })).days).toBe(30);
  });

  it("gives the weeks oldest first, each with its own gate", async () => {
    const r = await getSatisfaction(s.owner, { now: NOW });
    expect(r.trend.map((t) => t.week)).toEqual(["2026-10-05", "2026-10-12", "2026-10-19"]);
    expect(r.trend.map((t) => t.answers)).toEqual([30, 3, 10]);
    expect(r.trend[0].block.nps).toMatchObject({ enough: true, score: 17 });
    expect(r.trend[1].block.csat).toMatchObject({ answers: 3, enough: false, percent: null });
    expect(r.trend[2].block.csat).toMatchObject({ answers: 10, enough: true, percent: 70, average: 3.9 });
  });

  it("starts weeks on the workspace's own Monday, not UTC's", async () => {
    const t = await reputationShop("Zone Shop");
    await withSystem((db) => db.query("update organizations set timezone = 'Pacific/Auckland' where id = $1", [t.m.org.id]));
    const c = await shopCustomer(t);
    // Sunday 18 October 23:00 UTC is already Monday 19 October (13:00) in Auckland.
    await put(t.m.org.id, { contactId: c, source: "review_request", scale: "csat5", values: [5], at: "2026-10-18T23:00:00Z" });
    await put(t.m.org.id, { contactId: c, source: "review_request", scale: "csat5", values: [5], at: "2026-10-18T10:00:00Z" });
    const r = await getSatisfaction(t.owner, { now: NOW });
    expect(r.trend.map((x) => [x.week, x.answers])).toEqual([["2026-10-12", 1], ["2026-10-19", 1]]);
  });
});

describe("how the team is following up", () => {
  it("counts low feedback still waiting, the part past the workspace's time, and a typical time to acknowledge only from enough examples", async () => {
    const t = await reputationShop("Follow Shop");
    const c = await shopCustomer(t);
    const org = t.m.org.id;
    await put(org, { contactId: c, source: "review_request", scale: "csat5", values: [1], at: "2026-10-23T06:00:00Z", low: true, status: "escalated" }); // 6 hours old: waiting, not yet overdue
    await put(org, { contactId: c, source: "review_request", scale: "csat5", values: [2], at: "2026-10-21T06:00:00Z", low: true, status: "escalated" }); // past 24 hours
    await put(org, { contactId: c, source: "survey", scale: "nps10", values: [3], at: "2026-10-20T06:00:00Z", low: true, status: "new" }); // past 24 hours
    await put(org, { contactId: c, source: "review_request", scale: "csat5", values: [1], at: "2026-10-19T06:00:00Z", low: true, status: "resolved", ackAfterHours: 2 });
    for (const hours of [4, 6, 8]) await put(org, { contactId: c, source: "review_request", scale: "csat5", values: [2], at: "2026-10-18T06:00:00Z", low: true, status: "acknowledged", ackAfterHours: hours });
    const few = await getSatisfaction(t.owner, { now: NOW });
    expect(few.followUp).toMatchObject({ open: 3, overdue: 2, acknowledgeWithinHours: 24, acknowledged: 4, medianHoursToAcknowledge: null });
    expect(MIN_ACKNOWLEDGED_SAMPLE).toBe(5);
    await put(org, { contactId: c, source: "review_request", scale: "csat5", values: [2], at: "2026-10-17T06:00:00Z", low: true, status: "acknowledged", ackAfterHours: 10 });
    const enough = await getSatisfaction(t.owner, { now: NOW });
    expect(enough.followUp).toMatchObject({ open: 3, overdue: 2, acknowledged: 5, medianHoursToAcknowledge: 6 });
  });
});

describe("response rates", () => {
  it("counts how many of the requests that went out got an answer, for review requests and surveys apart, and ignores cancelled and unsent ones", async () => {
    const t = await reputationShop("Rate Shop");
    const c = await shopCustomer(t);
    const org = t.m.org.id;
    const request = async (kind: "review" | "survey", status: string) => {
      const id = crypto.randomUUID();
      await withSystem((db) => db.query(
        `insert into crm_review_requests (id, org_id, contact_id, channel, token_hash, status, requested_via, kind, scale, expires_at)
         values ($1, $2, $3, 'sms', md5($6::text) || md5($6::text || 'x'), $4, 'manual', $5, 'csat5', now() + interval '60 days')`,
        [id, org, c, status, kind, id],
      ));
      return id;
    };
    const answered = async (requestId: string) => {
      await put(org, { contactId: c, source: "review_request", scale: "csat5", values: [4], at: "2026-10-22T10:00:00Z", requestId });
      await withSystem((db) => db.query("update crm_review_requests set status = 'feedback_received' where id = $1", [requestId]));
    };
    // 4 review requests sent, 2 answered; one cancelled and one still waiting to be sent are not counted.
    for (let i = 0; i < 2; i += 1) await answered(await request("review", "sent"));
    await request("review", "sent");
    await request("review", "opened");
    await request("review", "cancelled");
    await request("review", "queued");
    // 12 surveys sent, 3 answered.
    for (let i = 0; i < 3; i += 1) await answered(await request("survey", "sent"));
    for (let i = 0; i < 9; i += 1) await request("survey", "sent");
    const r = await getSatisfaction(t.owner, { now: NOW });
    expect(r.response.review).toEqual({ sent: 4, answered: 2, percent: null });
    expect(r.response.survey).toEqual({ sent: 12, answered: 3, percent: 25 });
  });
});

describe("segments", () => {
  it("groups answers by the appointment type and calendar the request was about, each with its own gate and the busiest first", async () => {
    const t = await reputationShop("Segment Shop");
    const c = await shopCustomer(t);
    const org = t.m.org.id;
    const owner = t.m.people.owner.id;
    const cal = async (name: string, slug: string) => (await one<{ id: string }>("insert into crm_calendars (org_id, name, slug, is_default, public, created_by) values ($1, $2, $3, false, true, $4) returning id", [org, name, slug, owner])).id;
    const type = async (calendarId: string, name: string, slug: string) =>
      (await one<{ id: string }>(
        `insert into crm_appointment_types (org_id, calendar_id, name, slug, duration_minutes, slot_interval_minutes, min_notice_minutes, max_days_ahead, location_kind, public)
         values ($1, $2, $3, $4, 30, 30, 0, 60, 'none', true) returning id`,
        [org, calendarId, name, slug],
      )).id;
    const front = await cal("Front desk", "front-desk");
    const clinic = await cal("Clinic", "clinic");
    const cleaning = await type(front, "Cleaning", "cleaning");
    const checkup = await type(front, "Check-up", "check-up");
    const surgery = await type(clinic, "Surgery", "surgery");
    let n = 0;
    const answer = async (calendarId: string, typeId: string, rating: number) => {
      n += 1;
      const appt = await one<{ id: string }>(
        `insert into appointment_refs (org_id, ghl_appointment_id, ghl_calendar_id, title, status, start_at, end_at, contact_id, calendar_ref, appointment_type_id)
         values ($1, $2, 'cal_seg_0001', 'Visit', 'showed', '2026-10-15T09:00:00Z', '2026-10-15T09:30:00Z', $3, $4, $5) returning id`,
        [org, `seg_${n}_${crypto.randomUUID().slice(0, 8)}`, c, calendarId, typeId],
      );
      const requestId = crypto.randomUUID();
      await withSystem((db) => db.query(
        `insert into crm_review_requests (id, org_id, contact_id, channel, token_hash, status, appointment_id, requested_via, expires_at)
         values ($1, $2, $3, 'sms', md5($5::text) || md5($5::text || 'x'), 'feedback_received', $4, 'manual', now() + interval '60 days')`,
        [requestId, org, c, appt.id, requestId],
      ));
      await put(org, { contactId: c, source: "review_request", scale: "csat5", values: [rating], at: "2026-10-16T10:00:00Z", requestId });
    };
    for (let i = 0; i < 10; i += 1) await answer(front, cleaning, 5); // enough: 100%
    for (const rating of [4, 4, 2]) await answer(front, checkup, rating); // too few
    for (let i = 0; i < 10; i += 1) await answer(clinic, surgery, i < 5 ? 5 : 1); // enough: 50%
    // An answer with no appointment behind it belongs to no segment.
    await put(org, { contactId: c, source: "review_request", scale: "csat5", values: repeat(1, 4), at: "2026-10-16T10:00:00Z" });
    const r = await getSatisfaction(t.owner, { now: NOW });
    expect(r.byAppointmentType.map((x) => [x.name, x.answers, x.block.csat.percent])).toEqual([["Cleaning", 10, 100], ["Surgery", 10, 50], ["Check-up", 3, null]]);
    expect(r.byCalendar.map((x) => [x.name, x.answers, x.block.csat.percent])).toEqual([["Front desk", 13, 92], ["Clinic", 10, 50]]);
    expect(r.named.csat.answers).toBe(27);
  });
});

describe("who can read it, and whose numbers they are", () => {
  it("is the workspace's own numbers for anyone who can open contacts, and never another workspace's", async () => {
    const a = await reputationShop("Numbers A");
    const b = await reputationShop("Numbers B");
    const ca = await shopCustomer(a);
    const cb = await shopCustomer(b);
    await put(a.m.org.id, { contactId: ca, source: "review_request", scale: "csat5", values: repeat(5, 12), at: "2026-10-20T10:00:00Z" });
    await put(b.m.org.id, { contactId: cb, source: "review_request", scale: "csat5", values: repeat(1, 11), at: "2026-10-20T10:00:00Z" });
    for (const who of [a.owner, a.manager, a.sales, a.support, a.viewer]) expect((await getSatisfaction(who, { now: NOW })).named.csat, "reads A").toMatchObject({ answers: 12, percent: 100 });
    expect((await getSatisfaction(b.viewer, { now: NOW })).named.csat).toMatchObject({ answers: 11, percent: 0 });
    // Nothing of the other workspace appears in a list of the first's weeks or segments.
    expect((await getSatisfaction(a.owner, { now: NOW })).trend.map((t) => t.answers)).toEqual([12]);
    expect(await all("select 1 from customer_feedback where org_id = $1 and contact_id = $2", [a.m.org.id, cb])).toEqual([]);
  });
});
