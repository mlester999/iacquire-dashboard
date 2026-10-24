// Erasing a prospect on request, the retention clock, and the expiry job: what goes, what stays, and exactly when. Embedded Postgres only; every clock is passed in.
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { blockProspect, convertProspect, declineProspect, eraseProspect, extendDemo, addNote } from "@/server/demo/admin";
import { getRoom, recordCta, registerProspect, confirmVerification } from "@/server/demo/public";
import { reserveDemoMessage } from "@/server/demo/chat";
import { runDemoExpiry, runDemoRetention } from "@/server/demo/jobs";
import { count, demoEnv, emailFor, formInput, ipFor, linkTokenFor, messageId, messagePace, openDemo, prospectRow, rows, say, startDemo, team, type Team } from "./support/demo";

let people: Team;
const T0 = new Date("2027-04-01T09:00:00Z");
const hours = (n: number) => new Date(T0.getTime() + n * 3_600_000);
const days = (n: number) => new Date(T0.getTime() + n * 86_400_000);
const REASON = "They asked us to erase everything";

beforeAll(async () => {
  demoEnv();
  messagePace("relaxed");
  people = await team();
  await openDemo(people.superAdmin, { windowHours: 24, messageLimit: 10, retentionDays: 30, aiEnabled: true, dailyStartCap: 10_000, dailyMessageCap: 10_000 });
});

/** Every public table, as text, searched for each of the given strings. Returns the tables that hold any of them. */
async function tablesHolding(needles: string[]): Promise<string[]> {
  const tables = (await rows<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1")).map((t) => t.table_name);
  const found: string[] = [];
  for (const t of tables) {
    const hit = await rows<{ hit: boolean }>(`select exists (select 1 from unnest($1::text[]) p where exists (select 1 from "${t}" x where to_jsonb(x)::text ilike p)) as hit`, [needles.map((n) => `%${n}%`)]);
    if (hit[0].hit) found.push(t);
  }
  return found;
}

describe("erasing a prospect on request", () => {
  it("removes the details, the conversation, the links, the emails and the words team members typed, and keeps the dates, counts and statuses", async () => {
    const email = emailFor("erase");
    const local = email.split("@")[0];
    // The same person also asked on /get-started before: that request is theirs too.
    await withSystem((db) => db.query("insert into access_requests (company_name, contact_name, email, website, message) values ('Erase Roofing Co', 'Erin Eraser', $1, 'https://erase-roofing.test', 'Please call me about the vans')", [email]));
    const s = await startDemo({ email, name: "Erin Eraser", business: "Erase Roofing Co" }, T0);
    await say(s, "Does it work with ZEBRA-QUOTE-SOFTWARE?", { at: hours(1) });
    await addNote(people.superAdmin, s.prospectId, "Spoke to Erin; direct line is 555-0187-ERASEME", hours(2));
    await extendDemo(people.superAdmin, s.prospectId, { hours: 2, extraMessages: 1, reason: "Erin wants her partner ERASEME-PARTNER to see it" }, hours(3));
    await recordCta("consultation", s.ctx({ now: hours(4) }));
    const linkedTo = (await prospectRow(s.prospectId)).access_request_id;
    expect(linkedTo).toBeTruthy();
    const before = await prospectRow(s.prospectId);

    const counts = await eraseProspect(people.superAdmin, s.prospectId, REASON, hours(5));
    expect(counts).toMatchObject({ messages: 2, sessions: 1, accessRequests: 1 });
    expect(counts.eventsRedacted).toBeGreaterThanOrEqual(2);
    const after = await prospectRow(s.prospectId);
    expect(after).toMatchObject({ name: null, work_email: null, email_normalized: null, business_name: null, ip_hash: null, utm: {}, marketing_opt_in: false, access_request_id: null });
    expect(after.erased_at).toEqual(hours(5));
    // The record that a demo happened and what became of it.
    for (const key of ["status", "verified_at", "window_ends_at", "messages_used", "message_limit", "extra_messages", "extended_hours", "consultation_requested_at", "created_at", "owner_user_id"]) {
      expect(after[key], key).toEqual(before[key]);
    }
    expect(await count("demo_messages", "prospect_id = $1", [s.prospectId])).toBe(0);
    expect(await count("demo_sessions", "prospect_id = $1", [s.prospectId])).toBe(0);
    expect(await count("demo_verifications", "prospect_id = $1", [s.prospectId])).toBe(0);
    expect(await count("email_outbox", "to_email = $1", [email])).toBe(0);
    // The request on /get-started: redacted, not deleted.
    expect((await rows("select company_name, contact_name, email::text as email, website, message, status from access_requests where id = $1", [linkedTo]))[0]).toMatchObject({
      company_name: "Erased", contact_name: "Erased", website: null, message: null, status: "new", email: expect.stringMatching(/^erased-[0-9a-f]{8}@erased\.invalid$/),
    });
    // The timeline keeps every line, its time and its author, and loses only the words.
    const events = await rows<{ kind: string; actor_kind: string; detail: Record<string, unknown> }>("select kind, actor_kind, detail from demo_events where prospect_id = $1 order by id", [s.prospectId]);
    expect(events.map((e) => e.kind)).toEqual(expect.arrayContaining(["registered", "verified", "accessed", "note", "extended", "cta_consultation", "erased"]));
    for (const e of events) expect(Object.keys(e.detail).filter((k) => ["note", "reason", "text"].includes(k)), e.kind).toEqual([]);
    expect(events.find((e) => e.kind === "extended")?.detail).toMatchObject({ hours: 2, extraMessages: 1 });
    expect(events.find((e) => e.kind === "erased")).toMatchObject({ actor_kind: "user", detail: { why: "request", messages: 2, accessRequests: 1 } });
    // The audit trail names the action, the numbers and the actor, and nothing of the person.
    const audit = await rows<{ actor_user_id: string; metadata: Record<string, unknown> }>("select actor_user_id, metadata from audit_logs where action = 'demo.erased' and target_id = $1", [s.prospectId]);
    expect(audit).toHaveLength(1);
    expect(audit[0].actor_user_id).toBe(people.superAdmin.id);
    // And nowhere in the database: not the address, the name, the business, the phone number, the partner's name or a word of what they asked.
    const holding = await tablesHolding([local, "Erin Eraser", "Erase Roofing", "555-0187", "ERASEME-PARTNER", "ZEBRA-QUOTE-SOFTWARE"]);
    expect(holding).toEqual([]);
    // Their session no longer opens anything.
    expect(await getRoom(s.ctx({ now: hours(6) }))).toMatchObject({ ok: false, reason: "no_session" });
    expect(await reserveDemoMessage({ text: "still there?", clientMessageId: messageId() }, s.ctx({ now: hours(6) }))).toMatchObject({ ok: false, reason: "no_session" });
  });

  it("lets the same address start again afterwards as a new, unconfirmed prospect with a fresh window, and leaves the erased row alone", async () => {
    const email = emailFor("again");
    const s = await startDemo({ email }, T0);
    await say(s, "Hello", { at: hours(1) });
    await eraseProspect(people.superAdmin, s.prospectId, REASON, hours(2));
    const input = formInput({ email });
    expect(await registerProspect(input, { ip: ipFor(), now: hours(3) })).toMatchObject({ ok: true });
    const fresh = (await rows<{ id: string; status: string; messages_used: number }>("select id, status, messages_used from demo_prospects where work_email = $1", [email]))[0];
    expect(fresh.id).not.toBe(s.prospectId);
    expect(fresh).toMatchObject({ status: "unverified", messages_used: 0 });
    const token = (await linkTokenFor(email)) as string;
    expect(await confirmVerification(token, { ip: ipFor(), now: hours(4) })).toMatchObject({ ok: true, firstTime: true });
    expect((await prospectRow(fresh.id)).window_ends_at).toEqual(hours(28));
    expect(await prospectRow(s.prospectId)).toMatchObject({ erased_at: hours(2), email_normalized: null });
  });

  it("is done once, needs a reason, and keeps the address of a client who was converted out of the funnel erased too", async () => {
    const s = await startDemo({}, T0);
    await expect(eraseProspect(people.superAdmin, s.prospectId, "no", hours(1))).rejects.toThrow(/Say why/);
    await eraseProspect(people.superAdmin, s.prospectId, REASON, hours(1));
    await expect(eraseProspect(people.superAdmin, s.prospectId, REASON, hours(2))).rejects.toThrow(/already erased/);
    const converted = await startDemo({}, T0);
    const { orgId } = await convertProspect(people.superAdmin, converted.prospectId, {}, hours(1));
    await eraseProspect(people.superAdmin, converted.prospectId, REASON, hours(2));
    expect(await prospectRow(converted.prospectId)).toMatchObject({ status: "converted", converted_org_id: orgId, work_email: null, name: null });
    // The workspace they became is not touched by their erasure from the funnel.
    expect(await count("organizations", "id = $1", [orgId])).toBe(1);
  });

  it("goes through a database rule too: the timeline refuses to be edited or deleted except as an erasure does it", async () => {
    const s = await startDemo({}, T0);
    await expect(rows("update demo_events set kind = 'note' where prospect_id = $1 and kind = 'registered'", [s.prospectId])).rejects.toThrow(/append-only/);
    await expect(rows("update demo_events set detail = '{\"x\":1}'::jsonb where prospect_id = $1", [s.prospectId])).rejects.toThrow(/append-only/);
    await expect(rows("delete from demo_events where prospect_id = $1", [s.prospectId])).rejects.toThrow(/append-only/);
    await expect(rows("update demo_events set at = now() - interval '1 year' where prospect_id = $1", [s.prospectId])).rejects.toThrow(/append-only/);
  });
});

describe("the retention job", () => {
  it("removes someone who never confirmed their address at seven days exactly, with the email that was sent to them", async () => {
    const input = formInput();
    await registerProspect(input, { ip: ipFor(), now: T0 });
    const email = String(input.email);
    const id = (await rows<{ id: string }>("select id from demo_prospects where work_email = $1", [email]))[0].id;
    await withSystem((db) => db.query("update demo_prospects set created_at = $2::timestamptz where id = $1", [id, T0.toISOString()]));
    const justBefore = new Date(days(7).getTime() - 1);
    const early = await runDemoRetention({ now: justBefore });
    expect(early.deleted).toBe(0);
    expect(await count("demo_prospects", "id = $1", [id])).toBe(1);
    const on = await runDemoRetention({ now: days(7) });
    expect(on.deleted).toBeGreaterThanOrEqual(1);
    expect(await count("demo_prospects", "id = $1", [id])).toBe(0);
    expect(await count("demo_verifications", "prospect_id = $1", [id])).toBe(0);
    expect(await count("demo_events", "prospect_id = $1", [id])).toBe(0);
    expect(await count("email_outbox", "to_email = $1", [email])).toBe(0);
    expect(await count("audit_logs", "action = 'demo.unconfirmed_deleted' and target_id = $1", [id])).toBe(1);
  });

  it("erases a confirmed prospect when the retention period has passed since the latest of the window's end and the last visit, to the millisecond", async () => {
    // 30 days is the period in these tests.
    const quiet = await startDemo({}, T0);
    await say(quiet, "A question", { at: hours(1) });
    const end = hours(24);
    const due = new Date(end.getTime() + 30 * 86_400_000);
    await withSystem((db) => db.query("update demo_prospects set last_seen_at = $2::timestamptz where id = $1", [quiet.prospectId, hours(2).toISOString()]));
    await runDemoRetention({ now: new Date(due.getTime() - 1) });
    expect((await prospectRow(quiet.prospectId)).erased_at).toBeNull();
    expect((await runDemoRetention({ now: due })).erased).toBeGreaterThanOrEqual(1);
    const gone = await prospectRow(quiet.prospectId);
    expect(gone).toMatchObject({ name: null, work_email: null });
    expect(gone.erased_at).toEqual(due);
    expect(await count("demo_messages", "prospect_id = $1", [quiet.prospectId])).toBe(0);
    expect(await count("audit_logs", "action = 'demo.erased' and target_id = $1 and actor_user_id is null", [quiet.prospectId])).toBe(1);
    expect((await rows<{ detail: { why: string } }>("select detail from demo_events where prospect_id = $1 and kind = 'erased'", [quiet.prospectId]))[0].detail.why).toBe("retention");
  });

  it("counts from the last visit when that is later than the window's end", async () => {
    const visitor = await startDemo({}, T0);
    expect(await getRoom(visitor.ctx({ now: days(3) }))).toMatchObject({ ok: true });
    expect((await prospectRow(visitor.prospectId)).last_seen_at).toEqual(days(3));
    await runDemoRetention({ now: new Date(days(33).getTime() - 1) });
    expect((await prospectRow(visitor.prospectId)).erased_at).toBeNull();
    await runDemoRetention({ now: days(33) });
    expect((await prospectRow(visitor.prospectId)).erased_at).toEqual(days(33));
  });

  it("leaves a client, a blocked prospect and an erased one alone however old, and erases a declined one", async () => {
    const client = await startDemo({}, T0);
    await convertProspect(people.superAdmin, client.prospectId, {}, hours(1));
    const blocked = await startDemo({}, T0);
    await blockProspect(people.superAdmin, blocked.prospectId, REASON, hours(1));
    const declined = await startDemo({}, T0);
    await declineProspect(people.superAdmin, declined.prospectId, "Not a fit: a student project", hours(1));
    const erasedAlready = await startDemo({}, T0);
    await eraseProspect(people.superAdmin, erasedAlready.prospectId, REASON, hours(1));
    const events = await count("demo_events", "prospect_id = $1", [erasedAlready.prospectId]);
    await runDemoRetention({ now: days(400) });
    expect((await prospectRow(client.prospectId)).erased_at).toBeNull();
    expect((await prospectRow(blocked.prospectId)).erased_at).toBeNull();
    expect((await prospectRow(declined.prospectId)).erased_at).not.toBeNull();
    expect((await prospectRow(erasedAlready.prospectId)).erased_at).toEqual(hours(1));
    expect(await count("demo_events", "prospect_id = $1", [erasedAlready.prospectId])).toBe(events);
  });

  it("reads the period from the settings each time it runs", async () => {
    const s = await startDemo({}, T0);
    await openDemo(people.superAdmin, { retentionDays: 7 });
    try {
      const sevenDaysAfterEnd = new Date(hours(24).getTime() + 7 * 86_400_000);
      await runDemoRetention({ now: new Date(sevenDaysAfterEnd.getTime() - 1) });
      expect((await prospectRow(s.prospectId)).erased_at).toBeNull();
      expect((await runDemoRetention({ now: sevenDaysAfterEnd })).erased).toBeGreaterThanOrEqual(1);
      expect((await prospectRow(s.prospectId)).erased_at).toEqual(sevenDaysAfterEnd);
    } finally {
      await openDemo(people.superAdmin, { retentionDays: 30 });
    }
  });

  it("works through a pile in batches, within its budget, and a zero budget does nothing", async () => {
    await withSystem((db) =>
      db.query(
        `insert into demo_prospects (name, work_email, email_normalized, business_name, industry, created_at)
         select 'Bulk ' || g, 'bulk' || g || '@bulk.test', 'bulk' || g || '@bulk.test', 'Bulk Co', 'other', $1::timestamptz from generate_series(1, 205) g`,
        [T0.toISOString()],
      ),
    );
    expect(await count("demo_prospects", "email_normalized like 'bulk%@bulk.test'")).toBe(205);
    expect(await runDemoRetention({ now: days(8), budgetMs: 0 })).toMatchObject({ deleted: 0, erased: 0 });
    expect(await count("demo_prospects", "email_normalized like 'bulk%@bulk.test'")).toBe(205);
    const done = await runDemoRetention({ now: days(8) });
    expect(done.deleted).toBeGreaterThanOrEqual(205);
    expect(await count("demo_prospects", "email_normalized like 'bulk%@bulk.test'")).toBe(0);
  });

  it("drops the platform's daily counters after a year and a bit, and keeps the recent ones", async () => {
    await withSystem((db) => db.query("insert into demo_usage_days (day, starts, messages) values ('2020-01-01', 5, 5), ('2027-03-30', 1, 1) on conflict (day) do nothing"));
    await runDemoRetention({ now: days(2) });
    expect(await count("demo_usage_days", "day = '2020-01-01'")).toBe(0);
    expect(await count("demo_usage_days", "day = '2027-03-30'")).toBe(1);
  });
});

describe("the expiry job", () => {
  it("records the end of windows that ended, dated at the moment they ended, leaves open windows and the latest ask alone, and does nothing the second time", async () => {
    const ended = await startDemo({}, T0);
    const asked = await startDemo({}, T0);
    await recordCta("consultation", asked.ctx({ now: hours(1) }));
    const open = await startDemo({}, hours(20));
    expect(await prospectRow(ended.prospectId)).toMatchObject({ status: "active" });
    const first = await runDemoExpiry({ now: hours(26) });
    expect(first.expired).toBeGreaterThanOrEqual(1);
    expect(await prospectRow(ended.prospectId)).toMatchObject({ status: "expired" });
    expect(await prospectRow(asked.prospectId)).toMatchObject({ status: "consultation_requested" });
    expect(await prospectRow(open.prospectId)).toMatchObject({ status: "active" });
    const line = (await rows<{ at: Date; actor_kind: string }>("select at, actor_kind from demo_events where prospect_id = $1 and kind = 'expired'", [ended.prospectId]))[0];
    expect(line.actor_kind).toBe("system");
    expect(line.at).toEqual(hours(24));
    expect((await runDemoExpiry({ now: hours(26) })).expired).toBe(0);
    expect(await count("demo_events", "prospect_id = $1 and kind = 'expired'", [ended.prospectId])).toBe(1);
  });

  it("takes a pile of ended windows in batches of two hundred and carries on at the next run", async () => {
    await withSystem((db) =>
      db.query(
        `insert into demo_prospects (name, work_email, email_normalized, business_name, industry, status, verified_at, window_ends_at, consent_at)
         select 'Pile ' || g, 'pile' || g || '@pile.test', 'pile' || g || '@pile.test', 'Pile Co', 'other', 'active', $1::timestamptz, $1::timestamptz + interval '1 day', $1::timestamptz
         from generate_series(1, 205) g`,
        [T0.toISOString()],
      ),
    );
    const now = days(5);
    // More than two hundred are due, so a pass with no time to spare still takes exactly one batch, and the rest wait.
    expect((await runDemoExpiry({ now, budgetMs: 0 })).expired).toBe(200);
    expect(await count("demo_prospects", "status = 'active' and window_ends_at <= $1::timestamptz and erased_at is null", [now.toISOString()])).toBeGreaterThan(0);
    await runDemoExpiry({ now });
    expect(await count("demo_prospects", "email_normalized like 'pile%@pile.test' and status = 'active'")).toBe(0);
  });

  it("clears spent links and ended sessions a day after they ended, and the outbox copy of a link email an hour after it was sent", async () => {
    const s = await startDemo({}, T0);
    await withSystem(async (db) => {
      await db.query("insert into demo_sessions (prospect_id, token_hash, expires_at) values ($1, repeat('1', 64), $2::timestamptz), ($1, repeat('2', 64), $3::timestamptz)", [s.prospectId, hours(1).toISOString(), days(30).toISOString()]);
      await db.query("insert into demo_verifications (prospect_id, purpose, token_hash, expires_at) values ($1, 'return', repeat('3', 64), $2::timestamptz), ($1, 'return', repeat('4', 64), $3::timestamptz)", [s.prospectId, hours(1).toISOString(), days(30).toISOString()]);
      await db.query("insert into email_outbox (to_email, template, subject, body_text, status, created_at) values ('old-link@x.test', 'demo_link', 's', 'link', 'captured', $1::timestamptz), ('new-link@x.test', 'demo_link', 's', 'link', 'captured', $2::timestamptz), ('code@x.test', 'proposal_code', 's', 'code', 'captured', $1::timestamptz)",
        [hours(0).toISOString(), new Date(days(2).getTime() - 30 * 60_000).toISOString()]);
    });
    const r = await runDemoExpiry({ now: days(2) });
    expect(r.sessions).toBeGreaterThanOrEqual(1);
    expect(r.links).toBeGreaterThanOrEqual(1);
    expect(await count("demo_sessions", "token_hash = repeat('1', 64)")).toBe(0);
    expect(await count("demo_sessions", "token_hash = repeat('2', 64)")).toBe(1);
    expect(await count("demo_verifications", "token_hash = repeat('3', 64)")).toBe(0);
    expect(await count("demo_verifications", "token_hash = repeat('4', 64)")).toBe(1);
    expect(await count("email_outbox", "to_email = 'old-link@x.test'")).toBe(0);
    expect(await count("email_outbox", "to_email = 'new-link@x.test'")).toBe(1);
    expect(await count("email_outbox", "to_email = 'code@x.test'")).toBe(1);
  });

  it("gives back a message nobody answered, and works whether or not the demo is switched on", async () => {
    const s = await startDemo({}, T0);
    const r = await reserveDemoMessage({ text: "Stuck one", clientMessageId: messageId() }, s.ctx({ now: hours(1) }));
    expect(r).toMatchObject({ ok: true, kind: "reserved" });
    demoEnv({ DEMO_ENABLED: undefined });
    try {
      const out = await runDemoExpiry({ now: new Date(hours(1).getTime() + 6 * 60_000) });
      expect(out.released).toBeGreaterThanOrEqual(1);
      expect(await prospectRow(s.prospectId)).toMatchObject({ messages_used: 0 });
    } finally {
      demoEnv();
    }
  });
});
