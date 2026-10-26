// The demo's public API over HTTP, with plain Request objects against embedded Postgres: /api/public/demo/<action>. What a browser can see and send: the emergency stop that answers
// before anything is read, the same-site check (including the Origin: null a no-referrer page sends), the bounds on a body, the session cookie, and the two ways every action answers
// (JSON for a script, a redirect carrying one short word for a plain form). The services behind it are covered in demo-register / demo-chat / demo-generator; no language model, no
// email provider and no network is involved.
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DEMO_ACTIONS, handleDemo } from "@/server/demo/http";
import { DEMO_COOKIE } from "@/server/demo/tokens";
import { createOrg } from "./support/fixtures";
import { count, demoEnv, emailFor, hashOf, ipFor, linkTokenFor, messagePace, openDemo, rows, stubModel, team, type Team } from "./support/demo";

const BASE = "http://localhost/api/public/demo";
const SAFE = "The Appointment Setter turns interest into booked meetings. In this demo it books nothing.";

let people: Team;
let agency: { id: string };
beforeAll(async () => {
  demoEnv();
  messagePace("relaxed");
  people = await team();
  agency = await createOrg({ name: "iAcquire (agency)", kind: "agency" });
  await openDemo(people.superAdmin, { aiEnabled: true, messageLimit: 10, windowHours: 24, dailyStartCap: 10_000, dailyMessageCap: 10_000 });
});
afterEach(() => demoEnv());
afterAll(() => messagePace("real"));

interface Opts {
  ip?: string;
  cookie?: string | null;
  headers?: Record<string, string>;
}

/** What a page served with Referrer-Policy: no-referrer posts: Origin is the literal "null", and Sec-Fetch-Site says it is the same site. */
const SAME_SITE_FORM = { origin: "null", "sec-fetch-site": "same-origin" };

function form(action: string, fields: Record<string, string>, o: Opts = {}) {
  return new Request(`${BASE}/${action}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-forwarded-for": o.ip ?? ipFor(),
      "x-forwarded-host": "localhost",
      ...SAME_SITE_FORM,
      ...(o.cookie ? { cookie: `${DEMO_COOKIE}=${o.cookie}` } : {}),
      ...o.headers,
    },
    body: new URLSearchParams(fields).toString(),
  });
}

function json(action: string, body: unknown, o: Opts = {}) {
  return new Request(`${BASE}/${action}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "x-forwarded-for": o.ip ?? ipFor(),
      "x-forwarded-host": "localhost",
      origin: "http://localhost",
      "sec-fetch-site": "same-origin",
      ...(o.cookie ? { cookie: `${DEMO_COOKIE}=${o.cookie}` } : {}),
      ...o.headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const get = (action: string, o: Opts = {}) =>
  new Request(`${BASE}/${action}`, { method: "GET", headers: { accept: "application/json", "x-forwarded-for": o.ip ?? ipFor(), "x-forwarded-host": "localhost", ...(o.cookie ? { cookie: `${DEMO_COOKIE}=${o.cookie}` } : {}), ...o.headers } });

const location = (r: Response) => r.headers.get("location") ?? "";
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic JSON envelopes vary per endpoint; the assertions below read them directly.
const body = async (r: Response) => (await r.clone().json()) as Record<string, any>;

const input = (over: Record<string, string> = {}) => ({ name: "Pat Prospect", email: emailFor("http"), business: "Pat's Roofing", industry: "home_services", consent: "on", ...over });

/** Asks for a demo, reads the emailed link and presses its button: the way a browser gets a session. */
async function signIn(over: Record<string, string> = {}) {
  const fields = input(over);
  const ip = ipFor();
  const asked = await handleDemo(form("start", fields, { ip }), "start");
  expect(asked.status).toBe(303);
  const token = await linkTokenFor(fields.email.toLowerCase());
  if (!token) throw new Error("no link was emailed");
  const opened = await handleDemo(form("verify", { token }, { ip }), "verify");
  const cookie = /(?:^|,\s*)iaq_demo=([^;]+)/.exec(opened.headers.get("set-cookie") ?? "")?.[1];
  if (!cookie) throw new Error(`no session cookie: ${opened.status} ${location(opened)}`);
  return { email: fields.email.toLowerCase(), token, cookie, ip, opened };
}

describe("the door", () => {
  it("answers an unknown action with a plain not-found and every known action with only the method it takes", async () => {
    expect((await handleDemo(get("nothing"), "nothing")).status).toBe(404);
    expect((await handleDemo(get("../start"), "../start")).status).toBe(404);
    for (const action of DEMO_ACTIONS) {
      const takes = action === "history" ? "GET" : "POST";
      const wrong = action === "history" ? "POST" : "GET";
      const res = await handleDemo(new Request(`${BASE}/${action}`, { method: wrong, headers: { "x-forwarded-host": "localhost" } }), action);
      expect(res.status, `${wrong} ${action}`).toBe(405);
      expect(res.headers.get("allow"), action).toBe(takes);
    }
  });

  it("refuses a preflight and never sends a CORS header: no other site can read an answer", async () => {
    for (const action of DEMO_ACTIONS) {
      const pre = await handleDemo(new Request(`${BASE}/${action}`, { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } }), action);
      expect(pre.status).toBe(405);
      expect([...pre.headers.keys()].filter((h) => h.startsWith("access-control-"))).toEqual([]);
    }
    const s = await signIn();
    for (const res of [await handleDemo(get("history", { cookie: s.cookie, headers: { origin: "https://evil.example" } }), "history"), await handleDemo(json("start", {}, { headers: { origin: "https://evil.example" } }), "start")]) {
      expect([...res.headers.keys()].filter((h) => h.startsWith("access-control-"))).toEqual([]);
    }
  });

  it("never caches, indexes or passes on an address, on success, on refusal and on a redirect", async () => {
    const s = await signIn();
    const answers = [
      await handleDemo(json("start", input()), "start"),
      await handleDemo(json("start", { name: "" }), "start"),
      await handleDemo(form("start", {}), "start"),
      await handleDemo(get("history", { cookie: s.cookie }), "history"),
      await handleDemo(get("history"), "history"),
      await handleDemo(form("cta", { kind: "nope" }, { cookie: s.cookie }), "cta"),
      await handleDemo(json("start", {}, { headers: { origin: "https://evil.example" } }), "start"),
      await handleDemo(get("unknown"), "unknown"),
    ];
    for (const res of answers) {
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });
});

describe("the emergency stop and the deployment switch", () => {
  it("answers 'temporarily unavailable' before the body is read or the database is touched, with a waiting time", async () => {
    demoEnv({ DEMO_PUBLIC_DISABLED: "true" });
    const before = await count("demo_prospects");
    const huge = json("start", input(), { headers: { "content-length": "9999999" } });
    const asJson = await handleDemo(huge, "start");
    expect(asJson.status).toBe(503);
    expect(asJson.headers.get("retry-after")).toBe("300");
    expect((await body(asJson)).error.code).toBe("unavailable");
    const asForm = await handleDemo(form("start", input()), "start");
    expect(asForm.status).toBe(303);
    expect(location(asForm)).toBe("/demo?r=unavailable");
    expect((await handleDemo(get("history"), "history")).status).toBe(503);
    for (const action of ["verify", "message", "cta", "leave", "return-link"]) expect((await handleDemo(form(action, {}), action)).status, action).toBe(303);
    expect(await count("demo_prospects")).toBe(before);
  });

  it("says the demo is not open when this deployment does not allow it, and registers nobody", async () => {
    demoEnv({ DEMO_ENABLED: "false" });
    const before = await count("demo_prospects");
    const res = await handleDemo(json("start", input()), "start");
    expect(res.status).toBe(404);
    expect((await body(res)).error.code).toBe("not_available");
    expect(await count("demo_prospects")).toBe(before);
  });
});

describe("the same-site check", () => {
  it("refuses a post from another site before reading it, for both a script and a form", async () => {
    const before = await count("demo_prospects");
    const cross = { origin: "https://evil.example", "sec-fetch-site": "cross-site" };
    expect((await handleDemo(json("start", input(), { headers: cross }), "start")).status).toBe(403);
    expect((await handleDemo(form("start", input(), { headers: cross }), "start")).status).toBe(403);
    // Cross-site even with a forged Origin that matches the host is told apart by Sec-Fetch-Site only when Origin is "null".
    expect((await handleDemo(form("start", input(), { headers: { origin: "null", "sec-fetch-site": "cross-site" } }), "start")).status).toBe(403);
    expect((await handleDemo(form("start", input(), { headers: { origin: "https://localhost.evil.example", "sec-fetch-site": "same-site" } }), "start")).status).toBe(403);
    expect(await count("demo_prospects")).toBe(before);
  });

  it("accepts the Origin: null a page served with no referrer sends, a same-origin script, and a plain script with neither header", async () => {
    expect((await handleDemo(form("start", input()), "start")).status).toBe(303);
    expect((await handleDemo(json("start", input()), "start")).status).toBe(200);
    const bare = new Request(`${BASE}/start`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ipFor(), "x-forwarded-host": "localhost" }, body: JSON.stringify(input()) });
    expect((await handleDemo(bare, "start")).status).toBe(200);
  });

  it("refuses a link's button, a message, a call to action and leaving from another site, and keeps the session", async () => {
    const s = await signIn();
    const cross = { origin: "https://evil.example", "sec-fetch-site": "cross-site" };
    for (const [action, fields] of [["verify", { token: s.token }], ["message", { text: "hi", clientMessageId: "x".repeat(20) }], ["cta", { kind: "buy" }], ["leave", {}]] as const) {
      expect((await handleDemo(form(action, { ...fields }, { cookie: s.cookie, headers: cross }), action)).status, action).toBe(403);
    }
    expect(await count("demo_sessions", "token_hash = $1 and revoked_at is null", [hashOf(s.cookie)])).toBe(1);
    expect(await count("demo_prospects", "email_normalized = $1 and purchase_started_at is not null", [s.email])).toBe(0);
  });
});

describe("what a body may be", () => {
  const start = (r: Request) => handleDemo(r, "start");

  it("refuses a body that says it is too large, without reading it", async () => {
    const res = await start(json("start", input(), { headers: { "content-length": "16385" } }));
    expect(res.status).toBe(413);
  });

  it("stops reading a body that has no length when it grows past the bound, and lets go of the stream", async () => {
    let sent = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        controller.enqueue(new TextEncoder().encode("a".repeat(1024)));
        if (sent > 200) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const req = new Request(`${BASE}/start`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ipFor(), "x-forwarded-host": "localhost", origin: "http://localhost" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const res = await start(req);
    expect(res.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(sent).toBeLessThan(40);
  });

  it("refuses a body of a type nothing here takes: a file upload, plain text, an unknown type", async () => {
    for (const type of ["multipart/form-data; boundary=x", "text/plain", "application/xml"]) {
      const res = await start(new Request(`${BASE}/start`, { method: "POST", headers: { "content-type": type, "x-forwarded-for": ipFor(), "x-forwarded-host": "localhost", origin: "http://localhost" }, body: "x" }));
      expect(res.status, type).toBe(415);
    }
  });

  it("refuses JSON that is broken, or is not an object", async () => {
    expect((await start(json("start", "{not json"))).status).toBe(400);
    expect((await start(json("start", "[1,2]"))).status).toBe(400);
    expect((await start(json("start", "null"))).status).toBe(400);
    expect((await start(json("start", '"text"'))).status).toBe(400);
  });

  it("copes with a key meant to reach the prototype, and with values that are not text", async () => {
    const hostile = '{"__proto__":{"polluted":true},"constructor":{"x":1},"name":{"a":1},"email":["x"],"business":5,"industry":null,"consent":"yes"}';
    const res = await start(json("start", hostile));
    expect(res.status).toBe(400);
    expect((await body(res)).error.code).toBe("invalid");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("answers a fifteen thousand character name quickly, as a field problem, and stores nothing", async () => {
    const before = await count("demo_prospects");
    const t0 = Date.now();
    const res = await start(json("start", { ...input(), name: "A ".repeat(7_400) }));
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(res.status).toBe(400);
    expect((await body(res)).fields).toHaveProperty("name");
    expect(await count("demo_prospects")).toBe(before);
  });

  it("keeps only the first of a repeated form field and cuts every field to a bound", async () => {
    const e = emailFor("dup");
    const res = await handleDemo(new Request(`${BASE}/start`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ipFor(), "x-forwarded-host": "localhost", ...SAME_SITE_FORM },
      body: `name=First&name=Second&email=${encodeURIComponent(e)}&business=Biz&industry=home_services&consent=on`,
    }), "start");
    expect(res.status).toBe(303);
    expect((await rows<{ name: string }>("select name from demo_prospects where email_normalized = $1", [e.toLowerCase()]))[0].name).toBe("First");
  });
});

describe("asking for a demo", () => {
  it("tells a script it worked in words that are the same whether or not the address is known", async () => {
    const fields = input();
    const a = await handleDemo(json("start", fields), "start");
    const again = await handleDemo(json("start", fields), "start");
    const stranger = await handleDemo(json("start", input()), "start");
    expect(a.status).toBe(200);
    expect(await body(again)).toEqual(await body(a));
    expect(await body(stranger)).toEqual(await body(a));
    expect(JSON.stringify(await body(a))).not.toContain(fields.email);
  });

  it("sends a plain form back to the page with one word, and never puts anything typed in the address", async () => {
    const fields = input({ name: "Quentin Quiet", business: "Quiet Quarry Ltd" });
    const ok = await handleDemo(form("start", fields), "start");
    expect(ok.status).toBe(303);
    expect(location(ok)).toBe("/demo?r=sent");
    const bad = await handleDemo(form("start", { ...fields, email: "not-an-address", name: "", consent: "" }), "start");
    expect(location(bad)).toMatch(/^\/demo\?r=invalid&f=[a-z.]+$/);
    for (const typed of ["Quentin", "Quiet", "Quarry", "not-an-address", fields.email]) {
      expect(location(ok)).not.toContain(typed);
      expect(location(bad)).not.toContain(typed);
    }
    expect(location(bad)).toContain("name");
    expect(location(bad)).toContain("email");
    expect(location(bad)).toContain("consent");
  });

  it("names the fields that failed for a script, as plain sentences", async () => {
    const res = await handleDemo(json("start", { ...input(), email: "nope", industry: "not-an-industry" }), "start");
    expect(res.status).toBe(400);
    const b = await body(res);
    expect(b.error.code).toBe("invalid");
    expect(Object.keys(b.fields).sort()).toEqual(["email", "industry"]);
  });

  it("tells a bot that filled the hidden field that it worked, and stores nothing", async () => {
    const before = await count("demo_prospects");
    const res = await handleDemo(json("start", { ...input(), company_website: "https://spam.example" }), "start");
    expect(res.status).toBe(200);
    expect(await count("demo_prospects")).toBe(before);
  });

  it("holds an address to six requests an hour, with a waiting time, for a script and for a form", async () => {
    const ip = ipFor();
    const results: number[] = [];
    for (let i = 0; i < 7; i += 1) results.push((await handleDemo(json("start", input(), { ip }), "start")).status);
    expect(results.slice(0, 6).every((s) => s === 200)).toBe(true);
    expect(results[6]).toBe(429);
    const limited = await handleDemo(json("start", input(), { ip }), "start");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    const page = await handleDemo(form("start", input(), { ip }), "start");
    expect(location(page)).toBe("/demo?r=rate_limited");
    expect(Number(page.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("asks for a new link the same way, and answers alike for an address that never started", async () => {
    const s = await signIn();
    const known = await handleDemo(json("return-link", { email: s.email }), "return-link");
    const unknown = await handleDemo(json("return-link", { email: emailFor("nobody") }), "return-link");
    expect(known.status).toBe(200);
    expect(await body(known)).toEqual(await body(unknown));
    expect(location(await handleDemo(form("return-link", { email: s.email }), "return-link"))).toBe("/demo?r=sent");
  });
});

describe("the link's button and the session", () => {
  it("opens the demo with a cookie the page cannot read, that no other site can send, and hands a plain form to the room", async () => {
    const s = await signIn();
    expect(s.opened.status).toBe(303);
    expect(location(s.opened)).toBe("/demo/room");
    const header = s.opened.headers.get("set-cookie") ?? "";
    expect(header).toMatch(/^iaq_demo=[A-Za-z0-9_-]{43};/);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/");
    expect(header).toMatch(/Expires=[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4}/);
    // Expires in about seven days.
    const days = (new Date(/Expires=([^;]+)/.exec(header)![1]).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });

  it("keeps only a hash of the cookie and of the link in the database, and neither value in any answer's address", async () => {
    const s = await signIn();
    expect(await count("demo_sessions", "token_hash = $1", [hashOf(s.cookie)])).toBe(1);
    expect(await count("demo_sessions", "token_hash = $1", [s.cookie])).toBe(0);
    expect(await count("demo_verifications", "token_hash = $1", [s.token])).toBe(0);
    expect(location(s.opened)).not.toContain(s.cookie);
    expect(location(s.opened)).not.toContain(s.token);
  });

  it("tells a script where to go, with the cookie, and marks the first time", async () => {
    const fields = input();
    await handleDemo(json("start", fields), "start");
    const token = (await linkTokenFor(fields.email.toLowerCase())) as string;
    const res = await handleDemo(json("verify", { token }), "verify");
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ ok: true, redirect: "/demo/room", firstTime: true });
    expect(res.headers.get("set-cookie")).toMatch(/^iaq_demo=/);
  });

  it("uses the link up on the first press only, and sends a second press back to the link's page with a word and no link", async () => {
    const s = await signIn();
    const again = await handleDemo(form("verify", { token: s.token }), "verify");
    expect(again.status).toBe(303);
    expect(location(again)).toBe("/demo/verify?e=link_used");
    expect(location(again)).not.toContain(s.token);
    expect(again.headers.get("set-cookie")).toBeNull();
    const asJson = await handleDemo(json("verify", { token: s.token }), "verify");
    expect(asJson.status).toBe(410);
    expect((await body(asJson)).error.code).toBe("link_used");
  });

  it("does not use a link up when it is only looked at: the endpoint takes no GET, and a wrong token reveals nothing", async () => {
    const fields = input();
    await handleDemo(json("start", fields), "start");
    const token = (await linkTokenFor(fields.email.toLowerCase())) as string;
    const looked = await handleDemo(new Request(`${BASE}/verify?token=${token}`, { method: "GET", headers: { "x-forwarded-host": "localhost" } }), "verify");
    expect(looked.status).toBe(405);
    expect(await count("demo_verifications", "token_hash = $1 and consumed_at is null", [hashOf(token)])).toBe(1);
    for (const wrong of ["short", "x".repeat(43), "", "../../etc/passwd"]) {
      const res = await handleDemo(form("verify", { token: wrong }), "verify");
      expect(location(res), wrong).toBe("/demo/verify?e=link_invalid");
    }
  });

  it("ignores a cookie of the wrong shape or the wrong name, and a cookie that is not a session", async () => {
    for (const cookie of ["short", "x".repeat(43), "a".repeat(44)]) {
      const res = await handleDemo(get("history", { cookie }), "history");
      expect(res.status, cookie).toBe(401);
    }
    const s = await signIn();
    const wrongName = new Request(`${BASE}/history`, { method: "GET", headers: { cookie: `other=${s.cookie}`, "x-forwarded-host": "localhost", "x-forwarded-for": ipFor() } });
    expect((await handleDemo(wrongName, "history")).status).toBe(401);
    const twice = new Request(`${BASE}/history`, { method: "GET", headers: { cookie: `a=b; ${DEMO_COOKIE}=${s.cookie}; c=d`, "x-forwarded-host": "localhost", "x-forwarded-for": ipFor() } });
    expect((await handleDemo(twice, "history")).status).toBe(200);
  });
});

describe("the room over HTTP", () => {
  it("gives back the prospect's own room with no address, no id and no other prospect, only for the cookie it was sent", async () => {
    const s = await signIn({ name: "Ramona Roomy", business: "Roomy Rentals" });
    const other = await signIn({ name: "Olga Other", business: "Other Outfitters" });
    const res = await handleDemo(get("history", { cookie: s.cookie }), "history");
    expect(res.status).toBe(200);
    const text = JSON.stringify(await body(res));
    expect(text).toContain("Ramona");
    expect(text).toContain("Roomy Rentals");
    const id = (await rows<{ id: string }>("select id from demo_prospects where email_normalized = $1", [s.email]))[0].id;
    for (const secret of [s.email, other.email, "Olga", "Other Outfitters", s.cookie, s.token, id]) expect(text, secret).not.toContain(secret);
  });

  it("needs a session for history, messages and calls to action: a script is told so, a form is sent to the request page", async () => {
    expect((await body(await handleDemo(get("history"), "history"))).error.code).toBe("no_session");
    const noSession = await handleDemo(json("message", { text: "hi", clientMessageId: "a".repeat(20) }), "message", { model: stubModel(agency.id, SAFE).deps });
    expect(noSession.status).toBe(401);
    const page = await handleDemo(form("message", { text: "hi", clientMessageId: "a".repeat(20) }), "message", { model: stubModel(agency.id, SAFE).deps });
    expect(location(page)).toBe("/demo?r=no_session");
    expect(location(await handleDemo(form("cta", { kind: "buy" }), "cta"))).toBe("/demo?r=no_session");
  });

  it("answers a question with the model's checked answer and the room as the record has it", async () => {
    const s = await signIn();
    const model = stubModel(agency.id, SAFE);
    const res = await handleDemo(json("message", { text: "What does the Appointment Setter do?", clientMessageId: "id-".padEnd(24, "1"), employeeRole: "appointment_setter" }, { cookie: s.cookie }), "message", { model: model.deps });
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(b).toMatchObject({ ok: true, kind: "answered" });
    expect(b.room.messagesLeft).toBe(9);
    expect(b.room.transcript.map((l: { role: string; state: string | null }) => [l.role, l.state])).toEqual([["user", "answered"], ["assistant", null]]);
    expect(b.room.transcript[1].body).toBe(SAFE);
    expect(model.calls).toHaveLength(1);
  });

  it("answers the same message sent again with the stored answer and does not ask the model or count it twice", async () => {
    const s = await signIn();
    const model = stubModel(agency.id, SAFE);
    const msg = { text: "A question sent twice", clientMessageId: "twice-".padEnd(24, "2") };
    await handleDemo(json("message", msg, { cookie: s.cookie }), "message", { model: model.deps });
    const again = await handleDemo(json("message", msg, { cookie: s.cookie }), "message", { model: model.deps });
    expect(again.status).toBe(200);
    expect((await body(again)).kind).toBe("duplicate");
    expect((await body(again)).room.messagesLeft).toBe(9);
    expect(model.calls).toHaveLength(1);
  });

  it("tells a script a message was given back, with the reason and the room, and a form which word to show", async () => {
    const s = await signIn();
    const bad = stubModel(agency.id, "The setup costs $5.");
    const j = await handleDemo(json("message", { text: "How much?", clientMessageId: "held-".padEnd(24, "3") }, { cookie: s.cookie }), "message", { model: bad.deps });
    expect(j.status).toBe(200);
    expect(await body(j)).toMatchObject({ ok: true, kind: "held", why: "reply_blocked", room: { messagesLeft: 10 } });
    expect((await body(j)).message).toMatch(/held back by a safety check/);
    const f = await handleDemo(form("message", { text: "How much again?", clientMessageId: "held-".padEnd(24, "4") }, { cookie: s.cookie }), "message", { model: bad.deps });
    expect(f.status).toBe(303);
    expect(location(f)).toBe("/demo/room?m=held_reply_blocked#chat");
    const ok = await handleDemo(form("message", { text: "What does the Lead Hunter do?", clientMessageId: "good-".padEnd(24, "5") }, { cookie: s.cookie }), "message", { model: stubModel(agency.id, SAFE).deps });
    expect(location(ok)).toBe("/demo/room#chat");
  });

  it("refuses a message when the AI chat has no model, the limit is used up, or the input is wrong, with a status a script can use", async () => {
    const s = await signIn();
    const none = { ...stubModel(agency.id, SAFE).deps, config: async () => null };
    const off = await handleDemo(json("message", { text: "hello", clientMessageId: "off-".padEnd(24, "6") }, { cookie: s.cookie }), "message", { model: none });
    expect(off.status).toBe(409);
    expect((await body(off)).error.code).toBe("ai_off");
    const model = stubModel(agency.id, SAFE).deps;
    for (const bad of [{ text: "", clientMessageId: "a".repeat(20) }, { text: "hi", clientMessageId: "short" }, { text: "hi", clientMessageId: "a".repeat(20), employeeRole: "seventh_employee" }, { text: "x".repeat(2001), clientMessageId: "b".repeat(20) }]) {
      const res = await handleDemo(json("message", bad, { cookie: s.cookie }), "message", { model });
      expect(res.status, JSON.stringify(bad).slice(0, 60)).toBe(400);
      expect((await body(res)).error.code).toBe("invalid");
    }
    expect(await count("demo_messages", "prospect_id = (select id from demo_prospects where email_normalized = $1)", [s.email])).toBe(0);
  });

  it("records a call to action once, tells a script the consultation link, and sends a form back to the actions", async () => {
    const s = await signIn();
    const ask = await handleDemo(json("cta", { kind: "consultation" }, { cookie: s.cookie }), "cta");
    expect(await body(ask)).toEqual({ ok: true, consultationUrl: null, alreadyRecorded: false });
    expect(await body(await handleDemo(json("cta", { kind: "consultation" }, { cookie: s.cookie }), "cta"))).toMatchObject({ alreadyRecorded: true });
    const buy = await handleDemo(form("cta", { kind: "buy" }, { cookie: s.cookie }), "cta");
    expect(location(buy)).toBe("/demo/room?c=buy#actions");
    const bad = await handleDemo(json("cta", { kind: "purchase" }, { cookie: s.cookie }), "cta");
    expect(bad.status).toBe(400);
    expect(await count("demo_events", "kind = 'cta_consultation' and prospect_id = (select id from demo_prospects where email_normalized = $1)", [s.email])).toBe(1);
  });

  it("leaves the demo on this device: the cookie is cleared, the session ends, and the conversation stays for a new link", async () => {
    const s = await signIn();
    const res = await handleDemo(form("leave", {}, { cookie: s.cookie }), "leave");
    expect(location(res)).toBe("/demo?r=left");
    const cleared = res.headers.get("set-cookie") ?? "";
    expect(cleared).toMatch(/^iaq_demo=;/);
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("HttpOnly");
    expect((await handleDemo(get("history", { cookie: s.cookie }), "history")).status).toBe(401);
    expect(await count("demo_prospects", "email_normalized = $1", [s.email])).toBe(1);
    const asJson = await handleDemo(json("leave", {}), "leave");
    expect(asJson.status).toBe(200);
  });
});

describe("the proxy", () => {
  it("serves the demo's pages and API without a sign-in, and never lets the link's page or the room be cached, indexed or passed on", async () => {
    const { proxy } = await import("@/proxy");
    for (const path of ["/demo", "/demo/verify?token=abc", "/demo/room", "/api/public/demo/start"]) {
      const res = await proxy(new NextRequest(`http://localhost${path}`));
      expect(res.status, path).toBe(200);
      expect(res.headers.get("location"), path).toBeNull();
      expect(res.headers.get("content-security-policy"), path).toContain("frame-ancestors");
    }
    for (const path of ["/demo/verify?token=abc", "/demo/room", "/api/public/demo/history"]) {
      const res = await proxy(new NextRequest(`http://localhost${path}`));
      expect(res.headers.get("cache-control"), path).toBe("no-store");
      expect(res.headers.get("x-robots-tag"), path).toBe("noindex, nofollow");
      expect(res.headers.get("referrer-policy"), path).toBe("no-referrer");
    }
  });

  it("still asks for a sign-in for the team's own screens", async () => {
    const { proxy } = await import("@/proxy");
    for (const path of ["/admin/prospects", "/admin/prospects/settings", "/demonstration", "/demos"]) {
      const res = await proxy(new NextRequest(`http://localhost${path}`));
      expect(res.status, path).toBe(307);
      expect(res.headers.get("location"), path).toContain("/login");
    }
  });
});
