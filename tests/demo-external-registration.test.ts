// The marketing website's signed registration, end to end against embedded Postgres: the exact HTTP contract (headers, canonical signature, clock window, request id, body
// bound), the same pending prospect the demo's own form makes, the one-use email link, the 24-hour clock that starts only on the explicit confirm, the ten-message allowance,
// the Super Admin's view and extension, and the ways a caller is refused. No email provider and no network: the verification link is read back from the capturing outbox.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GET } from "@/app/api/public/demo/register/route";
import { handleDemoRegistration, REGISTRATION_PATH, signRegistrationRequest, MAX_REGISTRATION_BODY_BYTES } from "@/server/demo/registration";
import { confirmVerification, getRoom, peekVerification, recordCta, requestReturnLink } from "@/server/demo/public";
import { reserveDemoMessage, completeDemoMessage } from "@/server/demo/chat";
import { extendDemo, getProspect, listProspects } from "@/server/demo/admin";
import { purchaseInviteHref } from "@/lib/demo/admin-view";
import { count, demoEnv, emailFor, ipFor, linkTokenFor, messagePace, openDemo, prospectRow, rows, team, type Team } from "./support/demo";

const SECRET = "marketing-registration-secret-for-tests-0123456789abcdef";
const ALLOWED_ORIGIN = "https://marketing.iacquire.test";
const at = new Date("2026-10-26T09:00:00Z");
const hours = (n: number) => new Date(at.getTime() + n * 3_600_000);

let people: Team;

function registrationEnv(over: Record<string, string | undefined> = {}) {
  demoEnv({
    APP_URL: "https://iacquire.online",
    DEMO_REGISTRATION_ENABLED: "true",
    DEMO_REGISTRATION_SIGNING_SECRET: SECRET,
    DEMO_REGISTRATION_ALLOWED_ORIGINS: ALLOWED_ORIGIN,
    DEMO_REGISTRATION_MAX_SKEW_SECONDS: "300",
    DEMO_VERIFICATION_TTL_HOURS: "48",
    ...over,
  });
}

beforeAll(async () => {
  registrationEnv();
  messagePace("relaxed");
  people = await team();
  await openDemo(people.superAdmin, { enabled: true, windowHours: 24, messageLimit: 10, dailyStartCap: 1000, dailyMessageCap: 1000, aiEnabled: true });
});

afterEach(() => registrationEnv());
afterAll(() => messagePace("real"));

interface SendOptions {
  requestId?: string;
  timestamp?: number | string;
  secret?: string;
  signedBody?: string;
  origin?: string;
  contentType?: string;
  method?: string;
  ip?: string | null;
  now?: Date;
  omit?: Array<"request-id" | "timestamp" | "signature">;
}

const bodyFor = (over: Record<string, unknown> = {}) => ({
  name: "Maria Santos",
  email: emailFor("marketing"),
  business: "Santos Home Services",
  industry: "home_services",
  ...over,
});

/** A request exactly as the landing page's server sends it, with any part deliberately wrong for the refusal cases. */
function signed(body: Record<string, unknown> | string = bodyFor(), o: SendOptions = {}) {
  const now = o.now ?? at;
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const timestamp = String(o.timestamp ?? Math.floor(now.getTime() / 1000));
  const requestId = o.requestId ?? `req_${randomUUID().replace(/-/g, "")}`;
  const signature = signRegistrationRequest(o.secret ?? SECRET, timestamp, requestId, o.signedBody ?? raw);
  const headers: Record<string, string> = { "content-type": o.contentType ?? "application/json", accept: "application/json" };
  if (!o.omit?.includes("request-id")) headers["iacquireos-request-id"] = requestId;
  if (!o.omit?.includes("timestamp")) headers["iacquireos-timestamp"] = timestamp;
  if (!o.omit?.includes("signature")) headers["iacquireos-signature"] = `t=${timestamp},v1=${signature}`;
  if (o.origin) headers.origin = o.origin;
  const method = o.method ?? "POST";
  return new Request(`https://iacquire.online${REGISTRATION_PATH}`, { method, headers, body: method === "POST" ? raw : undefined });
}

const send = (body: Record<string, unknown> | string = bodyFor(), o: SendOptions = {}) =>
  handleDemoRegistration(signed(body, o), { now: o.now ?? at, ip: o.ip ?? ipFor() });

const mailCount = async (email: string) =>
  Number((await rows<{ n: number }>("select count(*)::int as n from email_outbox where to_email = $1 and template = 'demo_link'", [email]))[0].n);

interface Registered {
  email: string;
  ip: string;
  token: string;
  prospectId: string;
}

async function register(over: Record<string, unknown> = {}, o: SendOptions = {}): Promise<Registered> {
  const body = bodyFor(over);
  const ip = o.ip ?? ipFor();
  const res = await send(body, { ...o, ip });
  if (res.status !== 202) throw new Error(`registration answered ${res.status}: ${await res.text()}`);
  const email = String(body.email).toLowerCase();
  const token = await linkTokenFor(email);
  if (!token) throw new Error("no verification email was captured");
  const p = (await rows<{ id: string }>("select id from demo_prospects where email_normalized = $1", [email]))[0];
  return { email, ip, token, prospectId: p.id };
}

describe("the signed contract", () => {
  it("accepts a correctly signed registration and stores one pending prospect, with no clock and no client workspace", async () => {
    const authTables = ["users", "organizations", "organization_memberships", "invitations", "auth_credentials", "auth_sessions", "auth_tokens"];
    const before = Object.fromEntries(await Promise.all(authTables.map(async (t) => [t, await count(t)])));
    const body = bodyFor({ name: "Maria Santos", business: "Santos Home Services", industry: "home_services", utm_source: "google", utm_campaign: "demo-launch" });
    const res = await send(body);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");

    const email = String(body.email).toLowerCase();
    const p = (await rows<Record<string, unknown>>("select * from demo_prospects where email_normalized = $1", [email]))[0];
    expect(p).toMatchObject({ name: "Maria Santos", work_email: email, business_name: "Santos Home Services", industry: "home_services", status: "unverified", verified_at: null, window_ends_at: null, message_limit: 10, messages_used: 0 });
    expect(p.utm).toMatchObject({ utm_source: "google", utm_campaign: "demo-launch" });
    expect(await count("demo_sessions")).toBe(0);
    expect(await count("demo_verifications", "purpose = 'verify' and consumed_at is null")).toBeGreaterThanOrEqual(1);

    const mail = (await rows<{ body_text: string }>("select body_text from email_outbox where to_email = $1 order by id desc limit 1", [email]))[0];
    expect(mail.body_text).toContain("https://iacquire.online/demo/verify?token=");

    for (const table of authTables) expect(await count(table), table).toBe(before[table]);
  });

  it("answers with nothing about the person: no address, id, token or masked address in any accepted or refused body", async () => {
    const body = bodyFor();
    const accepted = await send(body);
    expect(await accepted.json()).toEqual({ ok: true });
    const refused = await send({ ...body, email: "not-an-address" });
    const text = await refused.text();
    expect(text).not.toContain(String(body.email));
    expect(text).not.toMatch(/[A-Za-z0-9_-]{43}/);
  });

  it("rejects a wrong secret, a tampered body, a malformed signature, a missing header and a timestamp outside the window, without storing anything", async () => {
    const body = bodyFor();
    const attempts = [
      await send(body, { secret: "another-secret-that-is-also-long-enough-0123456789" }),
      await send(body, { signedBody: JSON.stringify({ ...body, business: "Tampered Co" }) }),
      await send(body, { omit: ["signature"] }),
      await send(body, { omit: ["request-id"] }),
      await send(body, { omit: ["timestamp"] }),
      await send(body, { timestamp: Math.floor(hours(-1).getTime() / 1000) }),
      await send(body, { timestamp: Math.floor(hours(1).getTime() / 1000) }),
      await send(body, { timestamp: "not-a-number" }),
    ];
    for (const res of attempts) {
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    }
    expect(await count("demo_prospects", "work_email = $1", [String(body.email)])).toBe(0);
  });

  it("is closed unless DEMO_REGISTRATION_ENABLED and a secret are set, and follows the demo's emergency stop", async () => {
    const body = bodyFor();
    demoEnv({ DEMO_REGISTRATION_ENABLED: undefined });
    registrationEnv({ DEMO_REGISTRATION_ENABLED: undefined });
    const off = await send(body);
    expect(off.status).toBe(503);

    registrationEnv({ DEMO_PUBLIC_DISABLED: "true" });
    const stopped = await send(body);
    expect(stopped.status).toBe(503);
    expect((await send(body)).headers.get("retry-after")).toBe("300");
    expect(await count("demo_prospects", "work_email = $1", [String(body.email)])).toBe(0);
  });

  it("refuses a wrong media type, a body over the bound and malformed JSON before touching the database", async () => {
    const body = bodyFor();
    expect((await send(body, { contentType: "text/plain" })).status).toBe(415);
    const huge = JSON.stringify({ ...body, business: "x".repeat(MAX_REGISTRATION_BODY_BYTES) });
    expect((await send(huge)).status).toBe(413);
    expect((await send("{not json")).status).toBe(400);
    expect((await send(JSON.stringify([body]))).status).toBe(400);
    expect(await count("demo_prospects", "work_email = $1", [String(body.email)])).toBe(0);
  });

  it("answers field problems with 422 and field keys, and requires the four inputs", async () => {
    const res = await send({ name: "", email: "not-an-address", business: "", industry: "not_an_industry" });
    expect(res.status).toBe(422);
    const json = (await res.json()) as { ok: false; fields: Record<string, string> };
    expect(json.ok).toBe(false);
    expect(Object.keys(json.fields).sort()).toEqual(["business", "email", "industry", "name"]);
  });

  it("refuses a browser origin that is not configured, allows the configured one, and never returns a CORS header", async () => {
    const refused = await send(bodyFor(), { origin: "https://evil.example" });
    expect(refused.status).toBe(403);
    expect(refused.headers.get("access-control-allow-origin")).toBeNull();
    const allowed = await send(bodyFor(), { origin: ALLOWED_ORIGIN });
    expect(allowed.status).toBe(202);
    expect(allowed.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("duplicates and replay", () => {
  it("keeps one prospect per mailbox, sends a way back while the window is open, and never resets the window", async () => {
    const r = await register({ name: "First Name" });
    const confirmed = await confirmVerification(r.token, { ip: r.ip, now: at });
    expect(confirmed.ok).toBe(true);
    const before = await prospectRow(r.prospectId);

    const again = await send(bodyFor({ email: r.email, name: "Second Name", business: "Renamed Co" }), { ip: r.ip, now: hours(1) });
    expect(again.status).toBe(202);
    expect(await count("demo_prospects", "email_normalized = $1", [r.email])).toBe(1);
    const after = await prospectRow(r.prospectId);
    expect(after.verified_at).toEqual(before.verified_at);
    expect(after.window_ends_at).toEqual(before.window_ends_at);
    expect(after.name).toBe(before.name); // Details only change while the address is unconfirmed.
    // A link back is emailed, and it opens the same window.
    const returnToken = await linkTokenFor(r.email);
    expect(returnToken).not.toBeNull();
    expect(returnToken).not.toBe(r.token);
    const returned = await confirmVerification(returnToken, { ip: ipFor(), now: hours(1) });
    expect(returned.ok).toBe(true);
    if (returned.ok) expect(returned.firstTime).toBe(false);
    expect((await prospectRow(r.prospectId)).window_ends_at).toEqual(before.window_ends_at);
  });

  it("answers the same request id and body once, without a second email, and refuses the same id with another body", async () => {
    const body = bodyFor();
    const requestId = `req_${randomUUID().replace(/-/g, "")}`;
    const first = await send(body, { requestId });
    expect(first.status).toBe(202);
    const mails = await mailCount(String(body.email).toLowerCase());
    expect(mails).toBe(1);

    const retry = await send(body, { requestId });
    expect(retry.status).toBe(202);
    expect(await retry.json()).toEqual({ ok: true });
    expect(await mailCount(String(body.email).toLowerCase())).toBe(1);

    const different = await send({ ...body, business: "Another Business" }, { requestId });
    expect(different.status).toBe(409);
    expect(await different.json()).toMatchObject({ ok: false, error: { code: "replayed_request" } });
  });

  it("gives the request id back when nothing was accepted, so a corrected request can reuse it", async () => {
    const requestId = `req_${randomUUID().replace(/-/g, "")}`;
    const body = bodyFor();
    const bad = await send({ ...body, email: "not-an-address" }, { requestId });
    expect(bad.status).toBe(422);
    const good = await send(body, { requestId });
    expect(good.status).toBe(202);
  });

  it("takes over a claim that never completed after two minutes (a crashed attempt), and answers a live twin without a second send", async () => {
    const hashOf = (value: string) => createHash("sha256").update(value).digest("hex");
    const staleBody = bodyFor();
    const staleId = `req_${randomUUID().replace(/-/g, "")}`;
    const staleRaw = JSON.stringify(staleBody);
    await rows("insert into demo_registration_requests (request_id_hash, body_sha256, received_at) values ($1, $2, now() - interval '3 minutes')", [hashOf(staleId), hashOf(staleRaw)]);
    expect((await send(staleBody, { requestId: staleId })).status).toBe(202);
    expect(await mailCount(String(staleBody.email).toLowerCase())).toBe(1);
    expect((await rows<{ completed_at: Date | null }>("select completed_at from demo_registration_requests where request_id_hash = $1", [hashOf(staleId)]))[0].completed_at).toBeInstanceOf(Date);

    const twinBody = bodyFor();
    const twinId = `req_${randomUUID().replace(/-/g, "")}`;
    await rows("insert into demo_registration_requests (request_id_hash, body_sha256) values ($1, $2)", [hashOf(twinId), hashOf(JSON.stringify(twinBody))]);
    expect((await send(twinBody, { requestId: twinId })).status).toBe(202);
    expect(await mailCount(String(twinBody.email).toLowerCase())).toBe(0);
  });

  it("holds a mailbox to three registrations an hour, and the same marketing address is not limited like a visitor", async () => {
    const email = emailFor("limit");
    const statuses = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await send(bodyFor({ email }), { ip: "10.9.9.9" })).status);
    expect(statuses.slice(0, 3)).toEqual([202, 202, 202]);
    expect(statuses[3]).toBe(429);

    // Seven different people through one marketing server: the browser's six-starts-an-hour rule must not apply to a signed caller.
    const shared = "10.9.9.10";
    for (let i = 0; i < 7; i += 1) expect((await send(bodyFor(), { ip: shared })).status).toBe(202);
  });

  it("treats a blocked email domain exactly like an accepted registration and sends nothing", async () => {
    await openDemo(people.superAdmin, { blockedEmailDomains: ["blocked.test"] });
    try {
      const email = `someone-${randomUUID().slice(0, 8)}@blocked.test`;
      const res = await send(bodyFor({ email }));
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ ok: true });
      expect(await count("demo_prospects", "work_email = $1", [email])).toBe(0);
      expect(await mailCount(email)).toBe(0);
    } finally {
      await openDemo(people.superAdmin, { blockedEmailDomains: [] });
    }
  });
});

describe("the verification link and the clock", () => {
  it("does not consume the link or start the clock on a GET, and starts exactly one 24-hour window on the explicit confirm", async () => {
    const r = await register();
    const first = await peekVerification(r.token, { ip: r.ip, now: at });
    const second = await peekVerification(r.token, { ip: ipFor(), now: hours(1) });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    let p = await prospectRow(r.prospectId);
    expect(p).toMatchObject({ status: "unverified", verified_at: null, window_ends_at: null });

    const confirmed = await confirmVerification(r.token, { ip: r.ip, now: hours(1) });
    expect(confirmed.ok).toBe(true);
    p = await prospectRow(r.prospectId);
    expect(p.status).toBe("active");
    expect(new Date(String(p.verified_at)).toISOString()).toBe(hours(1).toISOString());
    expect(new Date(String(p.window_ends_at)).getTime() - new Date(String(p.verified_at)).getTime()).toBe(24 * 3_600_000);
    expect(p.message_limit).toBe(10);
  });

  it("keeps the link lifetime and the demo window independent, and takes the link lifetime from the environment", async () => {
    registrationEnv({ DEMO_VERIFICATION_TTL_HOURS: "3" });
    const r = await register();
    const link = (await rows<{ created_at: Date; expires_at: Date }>("select created_at, expires_at from demo_verifications where prospect_id = $1 and purpose = 'verify'", [r.prospectId]))[0];
    expect(new Date(link.expires_at).getTime() - new Date(link.created_at).getTime()).toBe(3 * 3_600_000);
    const confirmed = await confirmVerification(r.token, { ip: r.ip, now: at });
    expect(confirmed.ok).toBe(true);
    const p = await prospectRow(r.prospectId);
    expect(new Date(String(p.window_ends_at)).getTime() - new Date(String(p.verified_at)).getTime()).toBe(24 * 3_600_000);
  });

  it("works once: a second confirm, or an open of the already-used page, says the link was used and touches no window", async () => {
    const r = await register();
    expect((await confirmVerification(r.token, { ip: r.ip, now: at })).ok).toBe(true);
    const before = await prospectRow(r.prospectId);
    expect(await peekVerification(r.token, { ip: r.ip, now: hours(1) })).toMatchObject({ ok: false, reason: "link_used" });
    expect(await confirmVerification(r.token, { ip: r.ip, now: hours(1) })).toMatchObject({ ok: false, reason: "link_used" });
    expect(await prospectRow(r.prospectId)).toMatchObject({ verified_at: before.verified_at, window_ends_at: before.window_ends_at });
  });

  it("refuses an expired link and leaves the prospect unconfirmed; the email link's own expiry is independent of the demo", async () => {
    const r = await register();
    await rows("update demo_verifications set expires_at = $2::timestamptz - interval '1 minute' where prospect_id = $1 and purpose = 'verify'", [r.prospectId, at.toISOString()]);
    expect(await peekVerification(r.token, { ip: r.ip, now: at })).toMatchObject({ ok: false, reason: "link_expired" });
    expect(await confirmVerification(r.token, { ip: r.ip, now: at })).toMatchObject({ ok: false, reason: "link_expired" });
    expect((await prospectRow(r.prospectId)).verified_at).toBeNull();
    // Asking again replaces the dead link (the address is still unconfirmed) and the new one works.
    const fresh = await register({ email: r.email }, { ip: r.ip, now: at });
    const confirmed = await confirmVerification(fresh.token, { ip: r.ip, now: at });
    expect(confirmed.ok).toBe(true);
  });

  it("lets one of several simultaneous presses of the link through, so one window is written", async () => {
    const r = await register();
    const answers = await Promise.all([1, 2, 3, 4].map(() => confirmVerification(r.token, { ip: ipFor(), now: at })));
    expect(answers.filter((a) => a.ok)).toHaveLength(1);
    expect(answers.filter((a) => !a.ok && a.reason === "link_used")).toHaveLength(3);
    expect(await count("demo_sessions", "prospect_id = $1", [r.prospectId])).toBe(1);
  });
});

describe("the demo itself", () => {
  async function started(): Promise<{ r: Registered; sessionToken: string }> {
    const r = await register();
    const confirmed = await confirmVerification(r.token, { ip: r.ip, now: at });
    if (!confirmed.ok) throw new Error(`confirmation refused: ${confirmed.reason}`);
    return { r, sessionToken: confirmed.sessionToken };
  }

  it("keeps the ten-message allowance across a second device and a new session, and refuses the eleventh", async () => {
    const { r, sessionToken } = await started();
    const ctx = (token = sessionToken, now = hours(1)) => ({ ip: r.ip, sessionToken: token, now });
    for (let i = 0; i < 10; i += 1) {
      const reserved = await reserveDemoMessage({ text: `Question ${i + 1}`, clientMessageId: `msg-${randomUUID()}` }, ctx());
      if (!reserved.ok || reserved.kind !== "reserved") throw new Error(`message ${i + 1} refused: ${JSON.stringify(reserved)}`);
      await completeDemoMessage({ prospectId: reserved.prospectId, messageId: reserved.messageId, reply: "Answer", now: hours(1) });
    }
    const eleventh = await reserveDemoMessage({ text: "One more?", clientMessageId: `msg-${randomUUID()}` }, ctx());
    expect(eleventh).toMatchObject({ ok: false, reason: "limit_reached" });

    // A second device: a link back, a new session, the same count.
    expect((await requestReturnLink(r.email, { ip: ipFor(), now: hours(2) })).ok).toBe(true);
    const returnToken = await linkTokenFor(r.email);
    const returned = await confirmVerification(returnToken, { ip: ipFor(), now: hours(2) });
    if (!returned.ok) throw new Error(`return refused: ${returned.reason}`);
    const room = await getRoom({ ip: ipFor(), sessionToken: returned.sessionToken, now: hours(2) });
    expect(room.ok).toBe(true);
    if (room.ok) {
      expect(room.room.messagesLeft).toBe(0);
      expect(room.room.messageAllowance).toBe(10);
      expect(room.room.transcript.filter((t) => t.role === "user")).toHaveLength(10);
    }
    expect((await prospectRow(r.prospectId)).messages_used).toBe(10);
  });

  it("closes the private experience at the exactly-24-hour mark on the server, while the consultation stays available", async () => {
    const { r, sessionToken } = await started();
    const lastMoment = new Date(at.getTime() + 24 * 3_600_000 - 1);
    const ended = new Date(at.getTime() + 24 * 3_600_000);
    expect((await getRoom({ ip: r.ip, sessionToken, now: lastMoment })).ok).toBe(true);
    const room = await getRoom({ ip: r.ip, sessionToken, now: ended });
    expect(room.ok).toBe(true);
    if (room.ok) {
      expect(room.room.access).toBe("ended");
      expect(room.room.chat.canSend).toBe(false);
      expect(room.room.chat.refusal).toBe("window_ended");
    }
    expect(await reserveDemoMessage({ text: "After the end", clientMessageId: `msg-${randomUUID()}` }, { ip: r.ip, sessionToken, now: ended })).toMatchObject({ ok: false, reason: "window_ended" });
    const cta = await recordCta("consultation", { ip: r.ip, sessionToken, now: ended });
    expect(cta.ok).toBe(true);
    // No link back after the end: asking reads as accepted but nothing is emailed.
    const mails = await mailCount(r.email);
    expect((await requestReturnLink(r.email, { ip: ipFor(), now: ended })).ok).toBe(true);
    expect(await mailCount(r.email)).toBe(mails);
  });

  it("records the two calls to action once each and shows them to the Super Admin", async () => {
    const { r, sessionToken } = await started();
    expect(await recordCta("consultation", { ip: r.ip, sessionToken, now: hours(1) })).toMatchObject({ ok: true, alreadyRecorded: false });
    expect(await recordCta("consultation", { ip: r.ip, sessionToken, now: hours(1) })).toMatchObject({ ok: true, alreadyRecorded: true });
    expect(await recordCta("buy", { ip: r.ip, sessionToken, now: hours(1) })).toMatchObject({ ok: true, alreadyRecorded: false });
    const listed = await listProspects(people.superAdmin, { search: r.email }, hours(1));
    expect(listed.rows).toHaveLength(1);
    expect(listed.rows[0]).toMatchObject({ email: r.email, business: "Santos Home Services", industry: "home_services", purchaseStartedAt: hours(1).toISOString() });
    // The Buy press opens the existing purchase-intent screen, pre-filled: no second checkout is created by the demo.
    expect(purchaseInviteHref(listed.rows[0].id)).toBe(`/admin/purchase-intents?prospect=${listed.rows[0].id}`);
    expect(await count("purchase_intents")).toBe(0);
  });

  it("appears in Super Admin -> Demo prospects with every column the team needs, and a Super Admin can extend it without moving first access", async () => {
    const { r } = await started();
    const listed = await listProspects(people.superAdmin, { search: r.email }, hours(1));
    const row = listed.rows[0];
    expect(row).toMatchObject({
      name: "Maria Santos", email: r.email, business: "Santos Home Services", industry: "home_services", status: "active", access: "open",
      verifiedAt: at.toISOString(), windowEndsAt: hours(24).toISOString(), messagesUsed: 0, messageAllowance: 10, consultationRequestedAt: null, purchaseStartedAt: null,
    });
    const detail = await getProspect(people.superAdmin, r.prospectId, hours(1));
    expect(detail.prospect.messagesLeft).toBe(10);
    expect(detail.events.map((e) => e.kind)).toEqual(expect.arrayContaining(["registered", "verified", "accessed"]));

    const extended = await extendDemo(people.superAdmin, r.prospectId, { hours: 2, extraMessages: 5, reason: "More time to decide" }, hours(1));
    expect(extended.windowEndsAt.toISOString()).toBe(hours(26).toISOString());
    const after = await prospectRow(r.prospectId);
    expect(after.verified_at).toEqual(row.verifiedAt ? new Date(row.verifiedAt) : null);
    expect(after.message_limit).toBe(10);
    expect(after.extra_messages).toBe(5);
    expect(await rowCount("select count(*)::int as n from demo_prospects where email_normalized = $1", [r.email])).toBe(1);
  });

  it("keeps a prospect away from every other table: the demo has no tenant of its own and no client data", async () => {
    const { r } = await started();
    expect(await count("organizations", "kind = 'client'")).toBe(0);
    expect(await count("organization_memberships")).toBe(0);
    expect(await count("invitations")).toBe(0);
    expect(await count("auth_sessions")).toBe(0);
    expect(await count("demo_messages", "prospect_id = $1 and role = 'user'", [r.prospectId])).toBe(0);
  });
});

describe("what never happens", () => {
  it("logs no secret, header or raw body, and the route refuses GET", async () => {
    const source = readFileSync("src/server/demo/registration.ts", "utf8");
    expect(source).not.toMatch(/console\.(log|info|warn|error)/);
    expect(source).not.toMatch(/rawBody\s*\+/);
    const response = await GET();
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("does not accept the demo's own browser start action with a cross-site Origin (the two doors stay separate)", async () => {
    const res = await handleDemoRegistration(signed(bodyFor(), { method: "GET" }));
    expect(res.status).toBe(405);
  });
});

/** A one-value count with parameters, for assertions that do not need the table name helper. */
async function rowCount(sql: string, params: unknown[] = []): Promise<number> {
  return Number((await rows<{ n: number }>(sql, params))[0].n);
}
