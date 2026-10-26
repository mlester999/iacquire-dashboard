// Asking for the demo, confirming the address, the session that follows, and the calls to action: the part of the demo funnel a stranger can reach. Embedded Postgres only; the
// email provider is the capturing outbox, so the link in each email is read back from it. Nothing here creates a user, a workspace, a membership, an invitation or a sign-in.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { confirmVerification, getRoom, peekVerification, recordCta, registerProspect, requestReturnLink, endSession } from "@/server/demo/public";
import { REFUSAL_COPY } from "@/lib/demo/rules";
import { LINK_SENT_COPY } from "@/lib/demo/copy";
import { blockProspect } from "@/server/demo/admin";
import { count, demoEnv, emailFor, formInput, hashOf, ipFor, linkTokenFor, openDemo, prospectRow, rows, say, startDemo, team, type Team } from "./support/demo";

let people: Team;
const T0 = new Date("2026-10-24T09:00:00Z");
const hours = (n: number) => new Date(T0.getTime() + n * 3_600_000);

beforeAll(async () => {
  demoEnv();
  people = await team();
  await openDemo(people.superAdmin, { windowHours: 24, messageLimit: 10, dailyStartCap: 1000, dailyMessageCap: 1000, aiEnabled: true });
});
afterEach(() => demoEnv());

const AUTH_TABLES = ["users", "organizations", "organization_memberships", "invitations", "auth_credentials", "auth_sessions", "auth_tokens"];
const counts = async () => Object.fromEntries(await Promise.all(AUTH_TABLES.map(async (t) => [t, await count(t)])));

describe("the three switches", () => {
  it("answers 'temporarily unavailable' for every public call while DEMO_PUBLIC_DISABLED is on, before anything is read or counted", async () => {
    const before = await count("rate_limit_buckets", "bucket_key like 'demo:%'");
    const prospects = await count("demo_prospects");
    demoEnv({ DEMO_PUBLIC_DISABLED: "true" });
    const ip = ipFor();
    const input = formInput();
    for (const result of [
      await registerProspect(input, { ip }),
      await requestReturnLink(input.email, { ip }),
      await peekVerification("A".repeat(43), { ip }),
      await confirmVerification("A".repeat(43), { ip }),
      await getRoom({ ip, sessionToken: "A".repeat(43) }),
      await recordCta("consultation", { ip, sessionToken: "A".repeat(43) }),
    ]) {
      expect(result).toMatchObject({ ok: false, reason: "unavailable" });
    }
    expect(await count("demo_prospects")).toBe(prospects);
    expect(await count("rate_limit_buckets", "bucket_key like 'demo:%'")).toBe(before);
    expect(await linkTokenFor(String(input.email))).toBeNull();
  });

  it("is closed while DEMO_ENABLED is off, even though the Super Admin's switch is on", async () => {
    demoEnv({ DEMO_ENABLED: undefined });
    const input = formInput();
    expect(await registerProspect(input, { ip: ipFor() })).toMatchObject({ ok: false, reason: "not_available" });
    expect(await count("demo_prospects", "work_email = $1", [String(input.email)])).toBe(0);
  });

  it("is closed while the Super Admin's own switch is off, and nothing is stored or sent", async () => {
    await openDemo(people.superAdmin, { enabled: false });
    try {
      const input = formInput();
      expect(await registerProspect(input, { ip: ipFor() })).toMatchObject({ ok: false, reason: "not_available" });
      expect(await count("demo_prospects", "work_email = $1", [String(input.email)])).toBe(0);
      expect(await linkTokenFor(String(input.email))).toBeNull();
    } finally {
      await openDemo(people.superAdmin, { enabled: true });
    }
  });

  it("starts out closed: with no settings row at all the demo is off", async () => {
    const settings = await import("@/lib/demo/settings");
    expect(settings.DEMO_DEFAULTS.enabled).toBe(false);
    expect(settings.DEMO_DEFAULTS.aiEnabled).toBe(false);
  });
});

describe("asking for a demo", () => {
  it("stores one unconfirmed prospect, emails one link and gives no session", async () => {
    const input = formInput({ name: "Robin <b>Banks</b>", business: "Banks & Sons" });
    const email = String(input.email);
    const result = await registerProspect(input, { ip: ipFor(), now: T0 });
    expect(result).toMatchObject({ ok: true });
    const stored = (await rows<Record<string, unknown>>("select * from demo_prospects where work_email = $1", [email]))[0];
    expect(stored).toMatchObject({ status: "unverified", verified_at: null, window_ends_at: null, messages_used: 0, name: "Robin <b>Banks</b>", industry: "home_services", marketing_opt_in: false });
    expect(stored.consent_version).toBeTruthy();
    const token = await linkTokenFor(email);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Only the hash of the link is stored, and nothing opens a session yet.
    const link = (await rows<{ token_hash: string; purpose: string; expires_at: Date; consumed_at: Date | null }>("select * from demo_verifications where prospect_id = $1", [stored.id]))[0];
    expect(link.token_hash).toBe(hashOf(token as string));
    expect(link).toMatchObject({ purpose: "verify", consumed_at: null });
    expect(new Date(link.expires_at).getTime() - T0.getTime()).toBe(48 * 3_600_000);
    expect(await count("demo_sessions", "prospect_id = $1", [stored.id])).toBe(0);
    // The email says what the link does and carries nothing the stranger typed.
    const mail = (await rows<{ body_text: string; subject: string }>("select body_text, subject from email_outbox where to_email = $1 and template = 'demo_link'", [email]))[0];
    expect(mail.body_text).not.toMatch(/Robin|Banks|<b>/);
    expect(mail.body_text).toContain("works once");
    expect(await count("demo_events", "prospect_id = $1 and kind = 'registered'", [stored.id])).toBe(1);
    expect(result).toMatchObject({ maskedEmail: expect.stringMatching(/^.\*\*\*@prospect\.test$/) });
  });

  it("names each field that is wrong and stores nothing", async () => {
    const before = await count("demo_prospects");
    const cases: Array<[Parameters<typeof formInput>[0], string]> = [
      [{ name: "   " }, "name"],
      [{ email: "not an address" }, "email"],
      [{ email: "a@b" }, "email"],
      [{ business: "" }, "business"],
      [{ industry: "pirate_radio" }, "industry"],
      [{ consent: false }, "consent"],
      [{ consent: "yes" }, "consent"],
      [{ name: "x".repeat(121) }, "name"],
      [{ business: "y".repeat(161) }, "business"],
    ];
    for (const [over, field] of cases) {
      const r = await registerProspect(formInput(over), { ip: ipFor() });
      expect(r, JSON.stringify(over)).toMatchObject({ ok: false, reason: "invalid" });
      expect(Object.keys((r as { fields: object }).fields), JSON.stringify(over)).toContain(field);
    }
    expect(await count("demo_prospects")).toBe(before);
  });

  it("strips control characters, zero-width characters and direction overrides from what is stored", async () => {
    const RLO = String.fromCharCode(0x202e);
    const ZWSP = String.fromCharCode(0x200b);
    const BEL = String.fromCharCode(7);
    const input = formInput({ name: `Eve${RLO}live${ZWSP}Jones${BEL}`, business: `Bad${RLO}Co` });
    expect(await registerProspect(input, { ip: ipFor() })).toMatchObject({ ok: true });
    const stored = (await rows<{ name: string; business_name: string }>("select name, business_name from demo_prospects where work_email = $1", [String(input.email)]))[0];
    expect(stored.name).toBe("EveliveJones");
    expect(stored.business_name).toBe("BadCo");
  });

  it("tells a bot that filled the hidden field it worked, and stores and sends nothing", async () => {
    const input = formInput({ trap: "http://spam.example" });
    const r = await registerProspect(input, { ip: ipFor() });
    expect(r).toMatchObject({ ok: true });
    expect(await count("demo_prospects", "work_email = $1", [String(input.email)])).toBe(0);
    expect(await count("email_outbox", "to_email = $1", [String(input.email)])).toBe(0);
  });

  it("refuses an address on a blocked domain, or a subdomain of one, and stores nothing", async () => {
    await openDemo(people.superAdmin, { blockedEmailDomains: ["free-mail.test"] });
    try {
      for (const domain of ["free-mail.test", "mx.free-mail.test"]) {
        const input = formInput({ email: `someone-${Math.random().toString(36).slice(2)}@${domain}` });
        expect(await registerProspect(input, { ip: ipFor() })).toMatchObject({ ok: false, reason: "blocked_domain", message: "Please use your work email address." });
        expect(await count("demo_prospects", "work_email = $1", [String(input.email)])).toBe(0);
      }
    } finally {
      await openDemo(people.superAdmin, { blockedEmailDomains: [] });
    }
  });

  it("keeps one prospect per mailbox however it is spelled (case, a plus tag, dots in a Gmail address)", async () => {
    const tag = Math.random().toString(36).slice(2, 8);
    const spellings = [`Jo.Smith${tag}@gmail.com`, `josmith${tag}+offers@gmail.com`, `JOSMITH${tag}@GOOGLEMAIL.COM`];
    for (const s of spellings) expect(await registerProspect(formInput({ email: s }), { ip: ipFor() }), s).toMatchObject({ ok: true });
    const stored = await rows<{ email_normalized: string; work_email: string }>("select email_normalized, work_email from demo_prospects where email_normalized = $1", [`josmith${tag}@gmail.com`]);
    expect(stored).toHaveLength(1);
    // The link went to the first spelling, never to a variant a second request made up.
    expect(await linkTokenFor(`jo.smith${tag}@gmail.com`)).toBeTruthy();
    expect(await count("email_outbox", "template = 'demo_link' and to_email <> $1 and to_email like $2", [`jo.smith${tag}@gmail.com`, `%${tag}@%`])).toBe(0);
  });

  it("answers every request that passed the checks the same way, so the form cannot be used to find out who asked", async () => {
    // Four kinds of address: new, waiting for its link, mid-window, window over (plus a blocked one): the answer has the same shape each time.
    const waiting = formInput();
    const midWindow = await startDemo({}, T0);
    const ended = await startDemo({}, hours(-30));
    const blocked = await startDemo({}, T0);
    await blockProspect(people.superAdmin, blocked.prospectId, "Seen abusing the demo", T0);
    await registerProspect(waiting, { ip: ipFor(), now: T0 });
    const shapes = [
      await registerProspect(formInput(), { ip: ipFor(), now: T0 }),
      await registerProspect(waiting, { ip: ipFor(), now: T0 }),
      await registerProspect(formInput({ email: midWindow.email }), { ip: ipFor(), now: hours(1) }),
      await registerProspect(formInput({ email: ended.email }), { ip: ipFor(), now: T0 }),
      await registerProspect(formInput({ email: blocked.email }), { ip: ipFor(), now: T0 }),
    ];
    for (const r of shapes) expect(r, JSON.stringify(r)).toMatchObject({ ok: true, maskedEmail: expect.stringMatching(/^.\*\*\*@prospect\.test$/) });
    expect(Object.keys(shapes[0]).sort()).toEqual(Object.keys(shapes[4]).sort());
    // The wording the form shows does not depend on the address either.
    expect(LINK_SENT_COPY).toContain("If this address");
    // What differs is only whether a link left: nothing for the finished window and the blocked address.
    const sentTo = async (email: string) => count("email_outbox", "template = 'demo_link' and to_email = $1", [email]);
    expect(await sentTo(ended.email)).toBe(1); // its own start; the second request sent nothing more
    expect(await sentTo(blocked.email)).toBe(1);
    expect(await sentTo(midWindow.email)).toBe(2); // the start and the way back
  });

  it("never resets the window or the message count when someone registers again", async () => {
    const s = await startDemo({}, T0);
    await say(s, "What do you do?", { at: hours(1) });
    await say(s, "And pricing?", { at: hours(2) });
    const before = await prospectRow(s.prospectId);
    expect(before).toMatchObject({ messages_used: 2, status: "active" });
    const variant = s.email.replace("@", "+again@");
    const again = await registerProspect(formInput({ email: variant, name: "Someone Else", business: "Other Co" }), { ip: ipFor(), now: hours(3) });
    expect(again).toMatchObject({ ok: true });
    const after = await prospectRow(s.prospectId);
    for (const key of ["verified_at", "window_ends_at", "messages_used", "message_limit", "extra_messages", "extended_hours", "name", "business_name", "work_email", "status"]) {
      expect(after[key], key).toEqual(before[key]);
    }
    expect(await count("demo_prospects", "email_normalized = $1", [before.email_normalized])).toBe(1);
    // They are sent a way back to the address they started with, which works once and gives the same window.
    const back = await linkTokenFor(s.email);
    expect(back).not.toBe(s.token);
    expect(await count("email_outbox", "template = 'demo_link' and to_email = $1", [variant])).toBe(0);
    const confirmed = await confirmVerification(back as string, { ip: ipFor(), now: hours(4) });
    expect(confirmed).toMatchObject({ ok: true, purpose: "return", firstTime: false });
    expect(await prospectRow(s.prospectId)).toMatchObject({ messages_used: 2, window_ends_at: before.window_ends_at });
  });

  it("does not reopen a finished window: registering after it sends nothing and the room stays closed", async () => {
    const s = await startDemo({}, T0);
    const sent = await count("email_outbox", "template = 'demo_link' and to_email = $1", [s.email]);
    expect(await registerProspect(formInput({ email: s.email }), { ip: ipFor(), now: hours(25) })).toMatchObject({ ok: true });
    expect(await count("email_outbox", "template = 'demo_link' and to_email = $1", [s.email])).toBe(sent);
    expect((await prospectRow(s.prospectId)).window_ends_at).toEqual(hours(24));
    const room = await getRoom(s.ctx({ now: hours(25) }));
    expect(room).toMatchObject({ ok: true, room: { access: "ended", status: "expired" } });
  });

  it("replaces the details and the link of someone who has not confirmed yet, so a typo is fixed and only the newest link works", async () => {
    const input = formInput({ name: "Typo Name" });
    await registerProspect(input, { ip: ipFor(), now: T0 });
    const first = await linkTokenFor(String(input.email));
    await registerProspect({ ...input, name: "Fixed Name", business: "Fixed Co" }, { ip: ipFor(), now: hours(1) });
    const second = await linkTokenFor(String(input.email));
    expect(second).not.toBe(first);
    expect(await count("demo_prospects", "work_email = $1", [String(input.email)])).toBe(1);
    expect((await rows<{ name: string; business_name: string }>("select name, business_name from demo_prospects where work_email = $1", [String(input.email)]))[0]).toEqual({ name: "Fixed Name", business_name: "Fixed Co" });
    expect(await confirmVerification(first as string, { ip: ipFor(), now: hours(2) })).toMatchObject({ ok: false, reason: "link_invalid" });
    expect(await confirmVerification(second as string, { ip: ipFor(), now: hours(2) })).toMatchObject({ ok: true });
  });

  it("makes one prospect and one 'asked' line when the same address asks three times at once, and only the newest link works", async () => {
    const email = emailFor("race");
    const answers = await Promise.all([1, 2, 3].map(() => registerProspect(formInput({ email }), { ip: ipFor(), now: T0 })));
    expect(answers.every((a) => a.ok)).toBe(true);
    expect(await count("demo_prospects", "work_email = $1", [email])).toBe(1);
    const id = (await rows<{ id: string }>("select id from demo_prospects where work_email = $1", [email]))[0].id;
    expect(await count("demo_events", "prospect_id = $1 and kind = 'registered'", [id])).toBe(1);
    expect(await count("demo_verifications", "prospect_id = $1 and consumed_at is null", [id])).toBe(1);
    expect(await count("email_outbox", "template = 'demo_link' and to_email = $1", [email])).toBe(3);
    const newest = (await linkTokenFor(email)) as string;
    expect(await confirmVerification(newest, { ip: ipFor(), now: hours(1) })).toMatchObject({ ok: true });
  });

  it("holds each address to six requests an hour and each mailbox to three, with a retry time", async () => {
    const ip = ipFor();
    const results = [];
    for (let i = 0; i < 7; i += 1) results.push(await registerProspect(formInput(), { ip, now: T0 }));
    expect(results.slice(0, 6).every((r) => r.ok)).toBe(true);
    expect(results[6]).toMatchObject({ ok: false, reason: "rate_limited", retryAfterSeconds: expect.any(Number) });
    const email = emailFor("box");
    const tries = [];
    for (let i = 0; i < 4; i += 1) tries.push(await registerProspect(formInput({ email }), { ip: ipFor(), now: T0 }));
    expect(tries.slice(0, 3).every((r) => r.ok)).toBe(true);
    expect(tries[3]).toMatchObject({ ok: false, reason: "rate_limited" });
  });

  it("stops new demos for the day when the day's places are used up, and says so honestly", async () => {
    // A day of its own, so the starts the other tests made today do not count.
    const day = new Date("2027-03-01T09:00:00Z");
    await openDemo(people.superAdmin, { dailyStartCap: 1 });
    try {
      const first = await startDemo({}, day);
      expect(first.prospectId).toBeTruthy();
      const more = formInput();
      expect(await registerProspect(more, { ip: ipFor(), now: day })).toMatchObject({ ok: false, reason: "daily_cap", message: "Today's demo places are taken. Please try again tomorrow." });
      expect(await count("demo_prospects", "work_email = $1", [String(more.email)])).toBe(0);
      expect(await count("email_outbox", "to_email = $1", [String(more.email)])).toBe(0);
    } finally {
      await openDemo(people.superAdmin, { dailyStartCap: 1000 });
    }
  });
});

describe("the link in the email", () => {
  it("is not used up by opening its page: a GET changes nothing, and only the button (a POST) opens the demo, once", async () => {
    const input = formInput();
    await registerProspect(input, { ip: ipFor(), now: T0 });
    const token = (await linkTokenFor(String(input.email))) as string;
    const prospect = (await rows<{ id: string }>("select id from demo_prospects where work_email = $1", [String(input.email)]))[0].id;
    const events = await count("demo_events", "prospect_id = $1", [prospect]);
    // A mail scanner opening the page twice, and a person opening it too.
    for (let i = 0; i < 3; i += 1) expect(await peekVerification(token, { ip: ipFor(), now: hours(1) })).toMatchObject({ ok: true, purpose: "verify" });
    expect(await rows("select consumed_at from demo_verifications where prospect_id = $1", [prospect])).toEqual([{ consumed_at: null }]);
    expect(await prospectRow(prospect)).toMatchObject({ status: "unverified", verified_at: null, window_ends_at: null });
    expect(await count("demo_sessions", "prospect_id = $1", [prospect])).toBe(0);
    expect(await count("demo_events", "prospect_id = $1", [prospect])).toBe(events);
    // The button.
    const confirmed = await confirmVerification(token, { ip: ipFor(), now: hours(1), userAgent: "Mozilla/5.0 (test)" });
    expect(confirmed).toMatchObject({ ok: true, purpose: "verify", firstTime: true, sessionToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    expect(await prospectRow(prospect)).toMatchObject({ status: "active" });
    // Spent: neither the page nor the button works again.
    expect(await peekVerification(token, { ip: ipFor(), now: hours(2) })).toMatchObject({ ok: false, reason: "link_used" });
    expect(await confirmVerification(token, { ip: ipFor(), now: hours(2) })).toMatchObject({ ok: false, reason: "link_used" });
    expect(await count("demo_sessions", "prospect_id = $1", [prospect])).toBe(1);
  });

  it("opens the window when the address is confirmed and copies the settings to the prospect, so changing them later moves nobody", async () => {
    await openDemo(people.superAdmin, { windowHours: 24, messageLimit: 10 });
    const s = await startDemo({}, T0);
    expect(await prospectRow(s.prospectId)).toMatchObject({ message_limit: 10, extra_messages: 0, messages_used: 0, extended_count: 0 });
    expect((await prospectRow(s.prospectId)).verified_at).toEqual(T0);
    expect((await prospectRow(s.prospectId)).window_ends_at).toEqual(hours(24));
    await openDemo(people.superAdmin, { windowHours: 48, messageLimit: 3 });
    try {
      expect(await prospectRow(s.prospectId)).toMatchObject({ message_limit: 10 });
      expect((await prospectRow(s.prospectId)).window_ends_at).toEqual(hours(24));
      const later = await startDemo({}, hours(1));
      expect(await prospectRow(later.prospectId)).toMatchObject({ message_limit: 3 });
      expect((await prospectRow(later.prospectId)).window_ends_at).toEqual(hours(49));
    } finally {
      await openDemo(people.superAdmin, { windowHours: 24, messageLimit: 10 });
    }
  });

  it("stops working after 48 hours, for the page and the button alike, and changes nothing", async () => {
    const input = formInput();
    await registerProspect(input, { ip: ipFor(), now: T0 });
    const token = (await linkTokenFor(String(input.email))) as string;
    expect(await peekVerification(token, { ip: ipFor(), now: hours(47.9) })).toMatchObject({ ok: true });
    expect(await peekVerification(token, { ip: ipFor(), now: hours(48) })).toMatchObject({ ok: false, reason: "link_expired" });
    expect(await confirmVerification(token, { ip: ipFor(), now: hours(48) })).toMatchObject({ ok: false, reason: "link_expired" });
    expect(await rows("select status from demo_prospects where work_email = $1", [String(input.email)])).toEqual([{ status: "unverified" }]);
  });

  it("refuses a value that is not a link without reading the database for it", async () => {
    for (const bad of [undefined, null, 5, "", "short", "A".repeat(42), "A".repeat(44), `${"A".repeat(42)}!`, { token: "x" }]) {
      expect(await peekVerification(bad, { ip: ipFor() })).toMatchObject({ ok: false, reason: "link_invalid" });
      expect(await confirmVerification(bad, { ip: ipFor() })).toMatchObject({ ok: false, reason: "link_invalid" });
    }
    expect(await peekVerification("A".repeat(43), { ip: ipFor() })).toMatchObject({ ok: false, reason: "link_invalid" });
  });

  it("lets only one of two simultaneous presses of the button through", async () => {
    const input = formInput();
    await registerProspect(input, { ip: ipFor(), now: T0 });
    const token = (await linkTokenFor(String(input.email))) as string;
    const prospect = (await rows<{ id: string }>("select id from demo_prospects where work_email = $1", [String(input.email)]))[0].id;
    const answers = await Promise.all([1, 2, 3, 4].map(() => confirmVerification(token, { ip: ipFor(), now: hours(1) })));
    expect(answers.filter((a) => a.ok)).toHaveLength(1);
    expect(answers.filter((a) => !a.ok).every((a) => !a.ok && a.reason === "link_used")).toBe(true);
    expect(await count("demo_sessions", "prospect_id = $1", [prospect])).toBe(1);
    expect(await count("demo_events", "prospect_id = $1 and kind = 'verified'", [prospect])).toBe(1);
  });

  it("is refused, with the link left alone, when today's places are gone; it still works tomorrow within its 48 hours", async () => {
    const input = formInput();
    await registerProspect(input, { ip: ipFor(), now: T0 });
    const token = (await linkTokenFor(String(input.email))) as string;
    await openDemo(people.superAdmin, { dailyStartCap: 0 });
    try {
      expect(await confirmVerification(token, { ip: ipFor(), now: hours(1) })).toMatchObject({ ok: false, reason: "daily_cap" });
      expect(await rows("select consumed_at from demo_verifications where token_hash = $1", [hashOf(token)])).toEqual([{ consumed_at: null }]);
    } finally {
      await openDemo(people.superAdmin, { dailyStartCap: 1000 });
    }
    expect(await confirmVerification(token, { ip: ipFor(), now: hours(30) })).toMatchObject({ ok: true });
  });

  it("is refused for a blocked prospect, and a block takes their open link and session away", async () => {
    const s = await startDemo({}, T0);
    const back = await requestReturnLink(s.email, { ip: ipFor(), now: hours(1) });
    expect(back).toMatchObject({ ok: true });
    const link = (await linkTokenFor(s.email)) as string;
    await blockProspect(people.superAdmin, s.prospectId, "Abusing the demo chat", hours(2));
    expect(await confirmVerification(link, { ip: ipFor(), now: hours(3) })).toMatchObject({ ok: false });
    expect(await getRoom(s.ctx({ now: hours(3) }))).toMatchObject({ ok: false, reason: "no_session" });
  });

  it("creates no user, workspace, membership, invitation or sign-in for anyone: registering, confirming, chatting and asking for a consultation", async () => {
    const before = await counts();
    const s = await startDemo({}, T0);
    await say(s, "Hello there", { at: hours(1) });
    await recordCta("consultation", s.ctx({ now: hours(2) }));
    await recordCta("buy", s.ctx({ now: hours(2) }));
    await requestReturnLink(s.email, { ip: ipFor(), now: hours(3) });
    expect(await counts()).toEqual(before);
    // And nothing the demo tables point at is a user, except the team members who follow a prospect up.
    const links = await rows<{ t: string; ref: string }>(
      `select c.conrelid::regclass::text as t, c.confrelid::regclass::text as ref from pg_constraint c
       where c.contype = 'f' and c.conrelid::regclass::text like 'demo\\_%' order by 1, 2`,
    );
    expect(links.filter((l) => l.ref === "organizations" || l.ref === "organization_memberships" || l.ref === "invitations").map((l) => `${l.t}->${l.ref}`)).toEqual(["demo_prospects->organizations"]);
  });
});

describe("the room", () => {
  it("shows a prospect their own window and conversation, and nothing else", async () => {
    const s = await startDemo({ name: "Quinn Ortiz" }, T0);
    await say(s, "Tell me about the Lead Hunter", { at: hours(1), employeeRole: "lead_hunter" });
    const r = await getRoom(s.ctx({ now: hours(2) }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.room).toMatchObject({
      firstName: "Quinn", business: "Pat's Roofing", industryLabel: "Home services", status: "active", access: "open", messagesLeft: 9, messageAllowance: 10,
      chat: { aiEnabled: true, canSend: true, refusal: null }, pricing: { setupFeeUsd: 1499, monthlyPlanUsd: 299, monthlyPlanOptional: true },
    });
    expect(r.room.transcript.map((l) => [l.role, l.employeeRole, l.state])).toEqual([["user", "lead_hunter", "answered"], ["assistant", "lead_hunter", null]]);
    const serialized = JSON.stringify(r.room);
    expect(serialized).not.toContain(s.email);
    expect(serialized).not.toContain(s.prospectId);
  });

  it("needs a session of the prospect's own: no cookie, a made-up one, an expired one and an ended one all read as no session", async () => {
    const s = await startDemo({}, T0);
    for (const sessionToken of [undefined, null, "", "A".repeat(43), s.token]) {
      expect(await getRoom({ ip: ipFor(), sessionToken: sessionToken as string, now: hours(1) }), String(sessionToken)).toMatchObject({ ok: false, reason: "no_session" });
    }
    expect(await getRoom(s.ctx({ now: hours(24 * 7 + 1) }))).toMatchObject({ ok: false, reason: "no_session" });
    await endSession(s.ctx());
    expect(await getRoom(s.ctx({ now: hours(1) }))).toMatchObject({ ok: false, reason: "no_session" });
  });

  it("keeps the conversation readable after the window ends, and says the chat is closed", async () => {
    const s = await startDemo({}, T0);
    await say(s, "One question", { at: hours(1) });
    const r = await getRoom(s.ctx({ now: hours(30) }));
    expect(r).toMatchObject({ ok: true, room: { access: "ended", status: "expired", chat: { canSend: false, refusal: "window_ended", refusalMessage: REFUSAL_COPY.window_ended } } });
    if (r.ok) expect(r.room.transcript).toHaveLength(2);
  });

  it("says the AI chat is not available when the Super Admin's switch for it is off, and the window and counts are untouched", async () => {
    await openDemo(people.superAdmin, { aiEnabled: false });
    try {
      const s = await startDemo({}, T0);
      const r = await getRoom(s.ctx({ now: hours(1) }));
      expect(r).toMatchObject({ ok: true, room: { chat: { aiEnabled: false, canSend: false, refusal: "ai_off", refusalMessage: REFUSAL_COPY.ai_off }, messagesLeft: 10 } });
    } finally {
      await openDemo(people.superAdmin, { aiEnabled: true });
    }
  });
});

describe("asking for a consultation or pressing Buy now", () => {
  it("records each once, keeps the latest as the status, and tells the team once without a name or address", async () => {
    const s = await startDemo({ name: "Casey Name", business: "Casey Plumbing" }, T0);
    const first = await recordCta("consultation", s.ctx({ now: hours(1) }));
    expect(first).toMatchObject({ ok: true, alreadyRecorded: false });
    expect(await recordCta("consultation", s.ctx({ now: hours(2) }))).toMatchObject({ ok: true, alreadyRecorded: true });
    expect(await prospectRow(s.prospectId)).toMatchObject({ status: "consultation_requested" });
    expect(await count("demo_events", "prospect_id = $1 and kind = 'cta_consultation'", [s.prospectId])).toBe(1);
    expect(await recordCta("buy", s.ctx({ now: hours(3) }))).toMatchObject({ ok: true, alreadyRecorded: false });
    expect(await prospectRow(s.prospectId)).toMatchObject({ status: "purchase_started" });
    expect(await count("demo_events", "prospect_id = $1 and kind = 'cta_buy'", [s.prospectId])).toBe(1);
    // The managers and Super Admins were told, once each; the staff member who cannot see prospects was not.
    const notes = await rows<{ user_id: string; kind: string; title: string; body: string | null; link: string | null }>(
      "select user_id, kind, title, body, link from notifications where link = $1 and kind in ('demo_consultation_requested', 'demo_purchase_started', 'demo_prospect_verified')", [`/admin/prospects/${s.prospectId}`],
    );
    expect(notes.filter((n) => n.kind === "demo_consultation_requested" && n.user_id === people.manager.id)).toHaveLength(1);
    expect(notes.filter((n) => n.kind === "demo_consultation_requested" && n.user_id === people.superAdmin.id)).toHaveLength(1);
    expect(notes.filter((n) => n.kind === "demo_purchase_started" && n.user_id === people.superAdmin.id)).toHaveLength(1);
    expect(notes.filter((n) => n.user_id === people.staff.id)).toHaveLength(0);
    expect(JSON.stringify(notes)).not.toMatch(/Casey|Plumbing|prospect\.test/);
  });

  it("still works after the window ended: a prospect with nothing left to try is offered a person", async () => {
    const s = await startDemo({}, T0);
    expect(await recordCta("consultation", s.ctx({ now: hours(30) }))).toMatchObject({ ok: true });
    expect(await prospectRow(s.prospectId)).toMatchObject({ status: "consultation_requested" });
  });

  it("needs a session, and is held to a pace", async () => {
    expect(await recordCta("consultation", { ip: ipFor() })).toMatchObject({ ok: false, reason: "no_session" });
    expect(await recordCta("consultation", { ip: ipFor(), sessionToken: "A".repeat(43) })).toMatchObject({ ok: false, reason: "no_session" });
    const s = await startDemo({}, T0);
    let refused = 0;
    for (let i = 0; i < 25; i += 1) if (!(await recordCta("consultation", s.ctx({ now: hours(1) }))).ok) refused += 1;
    expect(refused).toBe(5);
  });
});

describe("what the team is told when a demo starts", () => {
  it("is a notice to everyone who may see prospects, with no personal details, and none to a team member who may not", async () => {
    const s = await startDemo({ name: "Jordan Lee", business: "Lee Landscaping" }, T0);
    const notes = await rows<{ user_id: string; title: string; body: string | null; severity: string }>(
      "select user_id, title, body, severity from notifications where kind = 'demo_prospect_verified' and link = $1", [`/admin/prospects/${s.prospectId}`],
    );
    expect(notes.map((n) => n.user_id).sort()).toEqual(expect.arrayContaining([people.manager.id, people.superAdmin.id]));
    expect(notes.some((n) => n.user_id === people.staff.id)).toBe(false);
    expect(JSON.stringify(notes)).not.toMatch(/Jordan|Landscaping|prospect\.test/);
  });
});
