// Signed outbound webhooks: subscriptions, the SSRF guard, queueing per event, delivery with retries, dead letters and auto-disable,
// test sends, redelivery, the workflow webhook step and the n8n workflow action. Every outbound request goes to a mocked fetch and every
// DNS answer comes from a mocked resolver; nothing leaves the machine.
import crypto from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { decryptSecret } from "@/server/security/crypto";
import { hostResolver } from "@/server/calendars/adapters/http";
import { pinnedHttps } from "@/server/security/pinned-https";
import { createContact, updateContact } from "@/server/crm/contacts";
import {
  AUTO_DISABLE_AFTER, MAX_ATTEMPTS, WEBHOOK_API_VERSION, WEBHOOK_EVENTS, checkWebhookUrl, classifyFetchFailure, createWebhookSubscription, deleteWebhookSubscription, deliverDueWebhooks,
  enqueueWebhookDeliveries, enqueueWorkflowWebhook, listWebhookDeliveries, listWebhookSubscriptions, redeliverWebhook, retryDelaySeconds, rotateWebhookSecret, sendTestWebhook,
  setWebhookSubscriptionActive, signWebhookPayload, updateWebhookSubscription, verifyWebhookSignature,
} from "@/server/crm/webhooks";
import { callN8nWorkflow, configureN8nTrigger, getN8nTriggerStatus, removeN8nTrigger } from "@/server/integrations/n8n-actions";
import { agencyPeople, crmOrg, type CrmOrg } from "./support/crm";

// ---------------------------------------------------------------------------
// Network doubles
// ---------------------------------------------------------------------------

const DNS: Record<string, string[]> = {
  "hooks.example.test": ["93.184.216.34"],
  "other.example.test": ["93.184.216.35"],
  "sneaky.example.test": ["10.1.2.3"],
  "mixed.example.test": ["93.184.216.36", "127.0.0.1"],
  "n8n.example.test": ["93.184.216.40"],
};
const originalLookup = hostResolver.lookup;
const originalPost = pinnedHttps.post;

interface Call { url: string; method: string; body: string; headers: Record<string, string> }
let calls: Call[] = [];
let responder: (call: Call) => Promise<Response> | Response = () => new Response("ok", { status: 200 });
const callsTo = (path: string) => calls.filter((c) => new URL(c.url).pathname === path);

beforeAll(() => {
  hostResolver.lookup = async (host: string) => {
    const a = DNS[host];
    if (!a) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return a;
  };
  // Deliveries and n8n calls go out through the pinned HTTPS transport; here it hands each request to the fetch double instead
  // (the transport itself is covered in tests/crm-automation-engine-fixes.test.ts).
  pinnedHttps.post = async (i) => ({ status: (await fetch(i.url, { method: "POST", headers: i.headers, body: i.body })).status });
});
afterAll(() => {
  hostResolver.lookup = originalLookup;
  pinnedHttps.post = originalPost;
});
beforeEach(() => {
  calls = [];
  responder = () => new Response("ok", { status: 200 });
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = { url: String(input), method: init?.method ?? "GET", body: String(init?.body ?? ""), headers: Object.fromEntries(new Headers(init?.headers).entries()) };
    calls.push(call);
    return responder(call);
  }));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  // Keeps each test's deliveries to itself: anything left waiting is closed.
  await withSystem((db) => db.query("update crm_webhook_deliveries set status = 'dead', claimed_at = null where status in ('pending', 'failed', 'delivering')"));
});

const timeout = () => {
  throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
};
const refused = () => {
  throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED 93.184.216.34:443"), { code: "ECONNREFUSED" }) });
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let a: CrmOrg;
let b: CrmOrg;
beforeAll(async () => {
  a = await crmOrg({ name: "Hook Co" });
  b = await crmOrg({ name: "Other Hook Co" });
});

async function subscribe(org: CrmOrg, path: string, events = ["contact.created", "contact.updated"]) {
  const r = await createWebhookSubscription(org.actor("owner"), { name: `Hook ${path}`, url: `https://hooks.example.test${path}`, eventTypes: events });
  return r;
}

async function contactEvent(org: CrmOrg, type = "contact.created", email = `p-${crypto.randomUUID().slice(0, 8)}@example.test`) {
  const c = await createContact(org.actor("owner"), { firstName: "Webhook", lastName: "Person", email });
  const { rows } = await withSystem((db) => db.query<{ id: string }>("select id from crm_events where org_id = $1 and entity_id = $2 and type = $3", [org.org.id, c.id, type]));
  return { contactId: c.id, event: { id: Number(rows[0].id), orgId: org.org.id, type } };
}

const delivery = async (subscriptionId: string) =>
  (await withSystem((db) => db.query<{ id: string; status: string; attempts: number; response_status: number | null; last_error: string | null; secs: number }>(
    "select id, status, attempts, response_status, last_error, extract(epoch from next_attempt_at - now())::int as secs from crm_webhook_deliveries where subscription_id = $1 order by created_at desc limit 1",
    [subscriptionId],
  ))).rows[0];

const makeDue = (subscriptionId: string) => withSystem((db) => db.query("update crm_webhook_deliveries set next_attempt_at = now() - interval '1 second' where subscription_id = $1 and status = 'failed'", [subscriptionId]));

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

describe("signatures", () => {
  it("signs t=<unix>,v1=<hex HMAC of t.body> and verifies only the exact body, secret and a fresh timestamp", () => {
    const secret = "whsec_test_secret";
    const body = JSON.stringify({ id: "evt_1", type: "contact.created" });
    const t = Math.floor(Date.now() / 1000);
    const header = signWebhookPayload(secret, body, t);
    expect(header).toMatch(/^t=\d{10},v1=[0-9a-f]{64}$/);
    expect(header).toBe(`t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`);
    expect(verifyWebhookSignature({ secret, body, header })).toBe(true);
    expect(verifyWebhookSignature({ secret, body: `${body} `, header })).toBe(false);
    expect(verifyWebhookSignature({ secret: "whsec_other", body, header })).toBe(false);
    expect(verifyWebhookSignature({ secret, body, header, now: (t + 301) * 1000 })).toBe(false);
    expect(verifyWebhookSignature({ secret, body, header: null })).toBe(false);
    expect(verifyWebhookSignature({ secret, body, header: `t=${t}` })).toBe(false);
    // A rolled secret can be accepted alongside the old one by listing both signatures.
    expect(verifyWebhookSignature({ secret, body, header: `t=${t},v1=${"0".repeat(64)},v1=${header.split("v1=")[1]}` })).toBe(true);
  });

  it("the Node.js sample in docs/crm-api.md and on the settings screen accepts a real signature and refuses a forged one", () => {
    // Copied from the documented sample.
    function verify(rawBody: string, header: string, secret: string, toleranceSeconds = 300) {
      const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
      const t = Number(parts.t);
      if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
      const expected = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
      const got = Buffer.from(parts.v1 ?? "");
      return got.length === expected.length && crypto.timingSafeEqual(got, Buffer.from(expected));
    }
    const body = '{"id":"evt_9","type":"opportunity.won"}';
    const header = signWebhookPayload("whsec_abc", body, Math.floor(Date.now() / 1000));
    expect(verify(body, header, "whsec_abc")).toBe(true);
    expect(verify(body.replace("won", "lost"), header, "whsec_abc")).toBe(false);
  });

  it("backs off 1 minute, 4, 16, 64 … up to a day", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(retryDelaySeconds)).toEqual([60, 240, 960, 3840, 15360, 61440, 86400, 86400]);
  });

  it("sorts fetch failures: a timeout or a dropped connection is an unknown outcome, a refused connection was never sent", () => {
    expect(classifyFetchFailure(new DOMException("t", "TimeoutError"), 10_000).kind).toBe("unknown");
    expect(classifyFetchFailure(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }), 10_000).kind).toBe("not_sent");
    expect(classifyFetchFailure(Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } }), 10_000).kind).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// Subscriptions and the SSRF guard
// ---------------------------------------------------------------------------

describe("subscriptions", () => {
  it("refuses anything but https to a public address on port 443, at save time", async () => {
    const bad = [
      ["http://hooks.example.test/x", /https/],
      ["https://localhost/x", /private, local or internal/],
      ["https://127.0.0.1/x", /private, local or internal/],
      ["https://10.0.0.8/x", /private, local or internal/],
      ["https://[::ffff:7f00:1]/x", /private, local or internal/],
      ["https://169.254.169.254/latest/meta-data", /private, local or internal/],
      ["https://sneaky.example.test/x", /private, local or internal/],
      ["https://mixed.example.test/x", /private, local or internal/],
      ["https://intranet.corp/x", /private, local or internal/],
      ["https://hooks.example.test:8443/x", /port/],
      ["https://user:pass@hooks.example.test/x", /user name and password/],
      ["https://nowhere.example.test/x", /couldn't be found/],
      ["not a url", /full address/],
    ] as const;
    for (const [url, msg] of bad) await expect(checkWebhookUrl(url), url).rejects.toThrow(msg);
    await expect(checkWebhookUrl("https://hooks.example.test/in?source=iacquire")).resolves.toBe("https://hooks.example.test/in?source=iacquire");
    await expect(createWebhookSubscription(a.actor("owner"), { name: "Local", url: "https://127.0.0.1/hook", eventTypes: ["contact.created"] })).rejects.toThrow(/private/);
    await expect(createWebhookSubscription(a.actor("owner"), { name: "Bad events", url: "https://hooks.example.test/e", eventTypes: ["contact.exploded"] })).rejects.toThrow(/isn't an event/);
    await expect(createWebhookSubscription(a.actor("owner"), { name: "None", url: "https://hooks.example.test/e", eventTypes: [] })).rejects.toThrow(/at least one event/);
  });

  it("generates the secret, shows it once, stores it encrypted where the app role can't read it, and keeps a hint", async () => {
    const org = await crmOrg();
    const created = await subscribe(org, "/secret");
    expect(created.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(created.secretHint).toBe(`…${created.secret.slice(-4)}`);
    const stored = await withSystem((db) => db.query<{ secret_ciphertext: string }>("select secret_ciphertext from crm_webhook_subscriptions where id = $1", [created.id]));
    expect(stored.rows[0].secret_ciphertext).not.toContain(created.secret);
    expect(decryptSecret(stored.rows[0].secret_ciphertext)).toBe(created.secret);
    // The application role (row-level security, column grants) never sees the ciphertext, even for the owner.
    await expect(withUser(org.people.owner.id, (db) => db.query("select secret_ciphertext from crm_webhook_subscriptions"))).rejects.toThrow(/permission denied/);
    await expect(withUser(org.people.owner.id, (db) => db.query("select * from crm_webhook_subscriptions"))).rejects.toThrow(/permission denied/);
    const visible = await withUser(org.people.owner.id, (db) => db.query<{ id: string }>("select id, secret_hint from crm_webhook_subscriptions where org_id = $1", [org.org.id]));
    expect(visible.rows.map((r) => r.id)).toEqual([created.id]);
    // People without crm.api.manage see nothing, even through the database.
    const salesView = await withUser(org.people.sales.id, (db) => db.query("select id from crm_webhook_subscriptions"));
    expect(salesView.rows).toHaveLength(0);
    const listed = await listWebhookSubscriptions(org.actor("manager"));
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(created.secret);
    // Rolling replaces it; the new one is returned once.
    const rolled = await rotateWebhookSecret(org.actor("owner"), created.id);
    expect(rolled.secret).not.toBe(created.secret);
    const after = await withSystem((db) => db.query<{ secret_ciphertext: string }>("select secret_ciphertext from crm_webhook_subscriptions where id = $1", [created.id]));
    expect(decryptSecret(after.rows[0].secret_ciphertext)).toBe(rolled.secret);
  });

  it("needs crm.api.manage and a person in the workspace; another workspace can't touch it", async () => {
    const org = await crmOrg();
    await expect(listWebhookSubscriptions(org.actor("sales"))).rejects.toThrow(/role/);
    await expect(subscribe({ ...org, actor: () => org.actor("viewer") } as CrmOrg, "/viewer")).rejects.toThrow(/role/);
    await expect(createWebhookSubscription(org.system, { name: "Sys", url: "https://hooks.example.test/s", eventTypes: ["contact.created"] })).rejects.toThrow(/Only people/);
    const s = await subscribe(org, "/own");
    await expect(updateWebhookSubscription(b.actor("owner"), s.id, { name: "Stolen", url: "https://hooks.example.test/x", eventTypes: ["contact.created"] })).rejects.toThrow(/not found/);
    await expect(deleteWebhookSubscription(b.actor("owner"), s.id)).rejects.toThrow(/not found/);
    await expect(listWebhookDeliveries(b.actor("owner"), s.id)).rejects.toThrow(/not found/);
    await expect(sendTestWebhook(b.actor("owner"), s.id)).rejects.toThrow(/not found/);
    await updateWebhookSubscription(org.actor("manager"), s.id, { name: "Renamed", url: "https://other.example.test/own", eventTypes: ["opportunity.won", "contact.created"] });
    const [view] = await listWebhookSubscriptions(org.actor("owner"));
    expect(view).toMatchObject({ name: "Renamed", url: "https://other.example.test/own", eventTypes: ["contact.created", "opportunity.won"] });
    const audit = await withSystem((db) => db.query<{ action: string }>("select action from audit_logs where org_id = $1 and action like 'crm.webhook_%' order by id", [org.org.id]));
    expect(audit.rows.map((r) => r.action)).toEqual(["crm.webhook_created", "crm.webhook_updated"]);
  });

  it("only offers events the CRM really emits", () => {
    expect(WEBHOOK_EVENTS.length).toBeGreaterThan(20);
    for (const e of WEBHOOK_EVENTS) expect(e.type).toMatch(/^[a-z_]+\.[a-z_]+$/);
  });
});

// ---------------------------------------------------------------------------
// Queueing
// ---------------------------------------------------------------------------

describe("queueing", () => {
  it("queues one delivery per matching active subscription per event, never twice, never across workspaces", async () => {
    const org = await crmOrg();
    const s1 = await subscribe(org, "/q1", ["contact.created"]);
    const s2 = await subscribe(org, "/q2", ["contact.created", "contact.updated"]);
    const s3 = await subscribe(org, "/q3", ["opportunity.won"]);
    const paused = await subscribe(org, "/q4", ["contact.created"]);
    await setWebhookSubscriptionActive(org.actor("owner"), paused.id, false);
    const foreign = await subscribe(b, "/q5", ["contact.created"]);
    const { event } = await contactEvent(org);
    const first = await withSystem((db) => enqueueWebhookDeliveries(db, event));
    const again = await withSystem((db) => enqueueWebhookDeliveries(db, event));
    expect(first).toBe(2);
    expect(again).toBe(0);
    const { rows } = await withSystem((db) => db.query<{ subscription_id: string }>("select subscription_id from crm_webhook_deliveries where event_id = $1", [event.id]));
    expect(rows.map((r) => r.subscription_id).sort()).toEqual([s1.id, s2.id].sort());
    expect(rows.map((r) => r.subscription_id)).not.toContain(s3.id);
    expect(rows.map((r) => r.subscription_id)).not.toContain(foreign.id);
    // Types outside the catalog (test pings, workflow payloads, internal events) never fan out.
    expect(await withSystem((db) => enqueueWebhookDeliveries(db, { ...event, type: "webhook.ping" }))).toBe(0);
    expect(await withSystem((db) => enqueueWebhookDeliveries(db, { ...event, type: "pipeline.created" }))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

describe("delivery", () => {
  it("POSTs a signed, versioned envelope with the record as it is now and no secrets, outside any transaction", async () => {
    const org = await crmOrg();
    const s = await subscribe(org, "/deliver");
    const { contactId, event } = await contactEvent(org, "contact.created", "dana@example.test");
    await withSystem((db) => enqueueWebhookDeliveries(db, event));
    // Changed after the event: the delivery carries the current record.
    await updateContact(org.actor("owner"), contactId, { firstName: "Dana" });
    const sent = await deliverDueWebhooks();
    expect(sent).toBeGreaterThanOrEqual(1);
    const [call] = callsTo("/deliver");
    expect(call.method).toBe("POST");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.headers["iacquire-event-id"]).toBe(`evt_${event.id}`);
    expect(call.headers["iacquire-event-type"]).toBe("contact.created");
    expect(verifyWebhookSignature({ secret: s.secret, body: call.body, header: call.headers["iacquire-signature"] })).toBe(true);
    const env = JSON.parse(call.body);
    expect(env).toMatchObject({ id: `evt_${event.id}`, type: "contact.created", apiVersion: WEBHOOK_API_VERSION, orgId: org.org.id });
    expect(Date.parse(env.occurredAt)).not.toBeNaN();
    expect(env.data.object).toMatchObject({ type: "contact", id: contactId, firstName: "Dana", email: "dana@example.test", archived: false });
    expect(env.data.context).toMatchObject({ via: "manual" });
    expect(call.body).not.toContain(s.secret);
    expect(call.body).not.toMatch(/ciphertext|password|token/i);
    const d = await delivery(s.id);
    expect(d).toMatchObject({ status: "delivered", attempts: 1, response_status: 200, last_error: null });
    // Delivered once: another run sends nothing.
    await deliverDueWebhooks();
    expect(callsTo("/deliver")).toHaveLength(1);
  });

  it("retries a refused answer with growing delays, then gives up as dead after the last attempt", async () => {
    const org = await crmOrg();
    const s = await subscribe(org, "/retry");
    const { event } = await contactEvent(org);
    await withSystem((db) => enqueueWebhookDeliveries(db, event));
    responder = () => new Response("nope", { status: 500 });
    await deliverDueWebhooks();
    let d = await delivery(s.id);
    expect(d).toMatchObject({ status: "failed", attempts: 1, response_status: 500 });
    expect(d.last_error).toMatch(/HTTP 500/);
    expect(d.secs).toBeGreaterThan(50);
    expect(d.secs).toBeLessThanOrEqual(60);
    // Not due yet: nothing is sent.
    await deliverDueWebhooks();
    expect(callsTo("/retry")).toHaveLength(1);
    await makeDue(s.id);
    await deliverDueWebhooks();
    d = await delivery(s.id);
    expect(d).toMatchObject({ status: "failed", attempts: 2 });
    expect(d.secs).toBeGreaterThan(230);
    for (let i = 3; i <= MAX_ATTEMPTS; i++) {
      await makeDue(s.id);
      await deliverDueWebhooks();
    }
    d = await delivery(s.id);
    expect(d.status).toBe("dead");
    expect(d.attempts).toBe(MAX_ATTEMPTS);
    expect(d.last_error).toMatch(/Gave up after 8 attempts/);
    expect(callsTo("/retry")).toHaveLength(MAX_ATTEMPTS);
    const sub = await withSystem((db) => db.query<{ consecutive_failures: number }>("select consecutive_failures from crm_webhook_subscriptions where id = $1", [s.id]));
    expect(sub.rows[0].consecutive_failures).toBe(MAX_ATTEMPTS);
    // A success resets the run of failures.
    responder = () => new Response(null, { status: 204 });
    await sendTestWebhook(org.actor("owner"), s.id);
    const after = await withSystem((db) => db.query<{ consecutive_failures: number }>("select consecutive_failures from crm_webhook_subscriptions where id = $1", [s.id]));
    expect(after.rows[0].consecutive_failures).toBe(0);
  });

  it("retries a connection that was refused (never sent), and doesn't follow redirects", async () => {
    const org = await crmOrg();
    const s = await subscribe(org, "/refused");
    const { event } = await contactEvent(org);
    await withSystem((db) => enqueueWebhookDeliveries(db, event));
    responder = refused;
    await deliverDueWebhooks();
    expect(await delivery(s.id)).toMatchObject({ status: "failed", attempts: 1, response_status: null });
    responder = () => new Response(null, { status: 302, headers: { location: "https://127.0.0.1/steal" } });
    await makeDue(s.id);
    await deliverDueWebhooks();
    const d = await delivery(s.id);
    expect(d).toMatchObject({ status: "failed", attempts: 2, response_status: 302 });
    expect(d.last_error).toMatch(/Redirects aren't followed/);
    expect(calls.some((c) => c.url.includes("127.0.0.1"))).toBe(false);
  });

  it("never retries an unknown outcome: a timeout or an interrupted send is closed and left for Redeliver", async () => {
    const org = await crmOrg();
    const s = await subscribe(org, "/timeout");
    const { event } = await contactEvent(org);
    await withSystem((db) => enqueueWebhookDeliveries(db, event));
    responder = timeout;
    await deliverDueWebhooks();
    const d = await delivery(s.id);
    expect(d.status).toBe("dead");
    expect(d.last_error).toMatch(/may have received it.*Not retried automatically/);
    await withSystem((db) => db.query("update crm_webhook_deliveries set next_attempt_at = now() - interval '1 hour' where id = $1", [d.id]));
    await deliverDueWebhooks();
    expect(callsTo("/timeout")).toHaveLength(1);

    // A worker that stopped mid-send leaves a lease behind: it is reconciled as unknown, not resent.
    const second = await contactEvent(org);
    await withSystem((db) => enqueueWebhookDeliveries(db, second.event));
    await withSystem((db) => db.query("update crm_webhook_deliveries set status = 'delivering', attempts = 1, claimed_at = now() - interval '10 minutes' where subscription_id = $1 and event_id = $2", [s.id, second.event.id]));
    responder = () => new Response("ok");
    await deliverDueWebhooks();
    const stale = await withSystem((db) => db.query<{ status: string; last_error: string }>("select status, last_error from crm_webhook_deliveries where subscription_id = $1 and event_id = $2", [s.id, second.event.id]));
    expect(stale.rows[0].status).toBe("dead");
    expect(stale.rows[0].last_error).toMatch(/Interrupted/);
    expect(callsTo("/timeout")).toHaveLength(1);

    // Redeliver sends it again on request, with the same event id.
    const out = await redeliverWebhook(org.actor("owner"), d.id);
    expect(out.status).toBe("delivered");
    const calls2 = callsTo("/timeout");
    expect(calls2).toHaveLength(2);
    expect(calls2[1].headers["iacquire-event-id"]).toBe(calls2[0].headers["iacquire-event-id"]);
    await expect(redeliverWebhook(b.actor("owner"), d.id)).rejects.toThrow(/not found/);
  });

  it("checks the address again before every delivery: a host that now resolves privately is never contacted", async () => {
    const org = await crmOrg();
    const s = await createWebhookSubscription(org.actor("owner"), { name: "Rebind", url: "https://other.example.test/rebind", eventTypes: ["contact.created"] });
    const { event } = await contactEvent(org);
    await withSystem((db) => enqueueWebhookDeliveries(db, event));
    DNS["other.example.test"] = ["192.168.1.20"];
    try {
      await deliverDueWebhooks();
    } finally {
      DNS["other.example.test"] = ["93.184.216.35"];
    }
    expect(callsTo("/rebind")).toHaveLength(0);
    const d = await delivery(s.id);
    expect(d.status).toBe("failed");
    expect(d.last_error).toMatch(/private/);
  });

  it("turns a subscription off after too many failures in a row, tells the owner and managers, and holds its deliveries", async () => {
    const org = await crmOrg();
    const s = await subscribe(org, "/disable");
    await withSystem((db) => db.query("update crm_webhook_subscriptions set consecutive_failures = $2 where id = $1", [s.id, AUTO_DISABLE_AFTER - 1]));
    const { event } = await contactEvent(org);
    await withSystem((db) => enqueueWebhookDeliveries(db, event));
    responder = () => new Response("down", { status: 503 });
    await deliverDueWebhooks();
    const [view] = await listWebhookSubscriptions(org.actor("owner"));
    expect(view.active).toBe(false);
    expect(view.disabledReason).toMatch(/Turned off automatically after 25 failed delivery attempts in a row/);
    const notes = await withSystem((db) => db.query<{ user_id: string; severity: string; link: string }>("select user_id, severity, link from notifications where org_id = $1 and kind = 'crm_webhook_failing'", [org.org.id]));
    expect(notes.rows.map((n) => n.user_id).sort()).toEqual([org.people.owner.id, org.people.manager.id].sort());
    expect(notes.rows[0]).toMatchObject({ severity: "warning", link: "/crm/settings/api" });
    // Off: its retry waits and new events aren't queued for it.
    await makeDue(s.id);
    await deliverDueWebhooks();
    expect(callsTo("/disable")).toHaveLength(1);
    const next = await contactEvent(org);
    expect(await withSystem((db) => enqueueWebhookDeliveries(db, next.event))).toBe(0);
    // Resuming clears the count and the scheduled retry goes out.
    responder = () => new Response("ok");
    await setWebhookSubscriptionActive(org.actor("manager"), s.id, true);
    const [resumed] = await listWebhookSubscriptions(org.actor("owner"));
    expect(resumed).toMatchObject({ active: true, consecutiveFailures: 0, disabledReason: null });
    await deliverDueWebhooks();
    expect(callsTo("/disable")).toHaveLength(2);
    expect((await delivery(s.id)).status).toBe("delivered");
  });

  it("holds deliveries while the agency has paused automation or the workspace is suspended", async () => {
    const org = await crmOrg();
    const s = await subscribe(org, "/held");
    const { event } = await contactEvent(org);
    await withSystem((db) => enqueueWebhookDeliveries(db, event));
    await withSystem((db) => db.query("insert into automation_pauses (org_id, scope, active) values ($1, 'agency', true)", [org.org.id]));
    await deliverDueWebhooks();
    expect(callsTo("/held")).toHaveLength(0);
    await withSystem((db) => db.query("update automation_pauses set active = false where org_id = $1", [org.org.id]));
    await withSystem((db) => db.query("update organizations set status = 'suspended' where id = $1", [org.org.id]));
    await deliverDueWebhooks();
    expect(callsTo("/held")).toHaveLength(0);
    await withSystem((db) => db.query("update organizations set status = 'active' where id = $1", [org.org.id]));
    await deliverDueWebhooks();
    expect(callsTo("/held")).toHaveLength(1);
    expect((await delivery(s.id)).status).toBe("delivered");
  });

  it("closes deliveries held back for days instead of sending them late, and Redeliver can still send one", async () => {
    const org = await crmOrg();
    const s = await subscribe(org, "/stale");
    const { event } = await contactEvent(org);
    await withSystem((db) => enqueueWebhookDeliveries(db, event));
    await setWebhookSubscriptionActive(org.actor("owner"), s.id, false);
    await withSystem((db) => db.query("update crm_webhook_deliveries set created_at = now() - interval '4 days' where subscription_id = $1", [s.id]));
    await setWebhookSubscriptionActive(org.actor("owner"), s.id, true);
    await deliverDueWebhooks();
    expect(callsTo("/stale")).toHaveLength(0);
    const d = await delivery(s.id);
    expect(d.status).toBe("dead");
    expect(d.last_error).toMatch(/Not sent within 3 days/);
    // Expiry isn't the endpoint's fault: the failure count is untouched.
    const sub = await withSystem((db) => db.query<{ consecutive_failures: number }>("select consecutive_failures from crm_webhook_subscriptions where id = $1", [s.id]));
    expect(sub.rows[0].consecutive_failures).toBe(0);
    expect(await redeliverWebhook(org.actor("owner"), d.id)).toMatchObject({ status: "delivered" });
    expect(callsTo("/stale")).toHaveLength(1);
  });

  it("sends a test ping on request, reports the answer, and a failed test isn't retried or counted against the webhook", async () => {
    const org = await crmOrg();
    const s = await subscribe(org, "/ping");
    const ok = await sendTestWebhook(org.actor("owner"), s.id);
    expect(ok).toMatchObject({ status: "delivered", responseStatus: 200 });
    const [call] = callsTo("/ping");
    const body = JSON.parse(call.body);
    expect(body).toMatchObject({ type: "webhook.ping", apiVersion: WEBHOOK_API_VERSION, data: { subscriptionId: s.id } });
    expect(verifyWebhookSignature({ secret: s.secret, body: call.body, header: call.headers["iacquire-signature"] })).toBe(true);
    responder = () => new Response("bad", { status: 404 });
    const bad = await sendTestWebhook(org.actor("owner"), s.id);
    expect(bad).toMatchObject({ status: "failed", responseStatus: 404 });
    const sub = await withSystem((db) => db.query<{ consecutive_failures: number }>("select consecutive_failures from crm_webhook_subscriptions where id = $1", [s.id]));
    expect(sub.rows[0].consecutive_failures).toBe(0);
    await withSystem((db) => db.query("update crm_webhook_deliveries set next_attempt_at = now() - interval '1 hour' where subscription_id = $1", [s.id]));
    await deliverDueWebhooks();
    expect(callsTo("/ping")).toHaveLength(2);
    // The ping never reaches the dispatcher: its outbox row is already marked dispatched.
    const pending = await withSystem((db) => db.query("select 1 from crm_events where org_id = $1 and type = 'webhook.ping' and dispatched_at is null", [org.org.id]));
    expect(pending.rows).toHaveLength(0);
    const log = await listWebhookDeliveries(org.actor("owner"), s.id, { filter: "failed" });
    expect(log.items).toHaveLength(1);
    expect(log.items[0]).toMatchObject({ eventType: "webhook.ping", status: "dead", responseStatus: 404 });
    await expect(sendTestWebhook(org.actor("sales"), s.id)).rejects.toThrow(/role/);
  });

  it("pages the delivery log newest first without skipping rows", async () => {
    const org = await crmOrg();
    const s = await subscribe(org, "/log");
    for (let i = 0; i < 5; i++) await sendTestWebhook(org.actor("owner"), s.id);
    const first = await listWebhookDeliveries(org.actor("owner"), s.id, { limit: 2 });
    const second = await listWebhookDeliveries(org.actor("owner"), s.id, { limit: 2, cursor: first.nextCursor });
    const third = await listWebhookDeliveries(org.actor("owner"), s.id, { limit: 2, cursor: second.nextCursor });
    const ids = [...first.items, ...second.items, ...third.items].map((d) => d.id);
    expect(new Set(ids).size).toBe(5);
    expect(third.nextCursor).toBeNull();
    await expect(listWebhookDeliveries(org.actor("owner"), s.id, { cursor: "nonsense" })).rejects.toThrow(/doesn't exist/);
  });
});

// ---------------------------------------------------------------------------
// The workflow engine's webhook step
// ---------------------------------------------------------------------------

describe("workflow webhook step", () => {
  it("queues the step's payload once per idempotency key, delivers it signed, and is blocked by a paused or missing webhook", async () => {
    const org = await crmOrg();
    const s = await subscribe(org, "/workflow", ["opportunity.won"]);
    const payload = { workflow: "Won deal handoff", dealId: crypto.randomUUID(), amount: 1200 };
    const first = await withSystem((db) => enqueueWorkflowWebhook(db, { orgId: org.org.id, subscriptionId: s.id, payload, idempotencyKey: "wf:run-1:step-2" }));
    const again = await withSystem((db) => enqueueWorkflowWebhook(db, { orgId: org.org.id, subscriptionId: s.id, payload, idempotencyKey: "wf:run-1:step-2" }));
    expect(first.status).toBe("queued");
    expect(again).toMatchObject({ status: "duplicate", deliveryId: first.deliveryId });
    const ev = await withSystem((db) => db.query<{ dispatched_at: Date | null; actor_kind: string }>("select e.dispatched_at, e.actor_kind from crm_events e join crm_webhook_deliveries d on d.event_id = e.id where d.id = $1", [first.deliveryId]));
    expect(ev.rows[0].dispatched_at).not.toBeNull();
    expect(ev.rows[0].actor_kind).toBe("workflow");
    await deliverDueWebhooks();
    const [call] = callsTo("/workflow");
    expect(JSON.parse(call.body)).toMatchObject({ type: "workflow.webhook", data: payload });
    expect(verifyWebhookSignature({ secret: s.secret, body: call.body, header: call.headers["iacquire-signature"] })).toBe(true);
    // Another workspace's subscription is "missing" from this one.
    const other = await subscribe(b, "/workflow-b");
    expect(await withSystem((db) => enqueueWorkflowWebhook(db, { orgId: org.org.id, subscriptionId: other.id, payload, idempotencyKey: "wf:run-1:step-3" }))).toMatchObject({ status: "blocked" });
    await setWebhookSubscriptionActive(org.actor("owner"), s.id, false);
    expect(await withSystem((db) => enqueueWorkflowWebhook(db, { orgId: org.org.id, subscriptionId: s.id, payload, idempotencyKey: "wf:run-2:step-2" }))).toMatchObject({ status: "blocked", detail: expect.stringMatching(/paused/) });
    await expect(withSystem((db) => enqueueWorkflowWebhook(db, { orgId: org.org.id, subscriptionId: s.id, payload: { big: "x".repeat(20_000) }, idempotencyKey: "wf:run-3:step-1" }))).rejects.toThrow(/too large/);
    await expect(withSystem((db) => enqueueWorkflowWebhook(db, { orgId: org.org.id, subscriptionId: s.id, payload, idempotencyKey: "short" }))).rejects.toThrow(/idempotency key/);
  });
});

// ---------------------------------------------------------------------------
// n8n workflow action
// ---------------------------------------------------------------------------

describe("n8n workflow action", () => {
  let org: CrmOrg;
  let mappingId: string;
  let superAdminId: string;
  const TOKEN = "n8n-header-auth-token-0123456789abcdef";
  const URL_OK = "https://n8n.example.test/webhook/iacquire-lead-handoff";

  beforeAll(async () => {
    process.env.INTEGRATION_ALLOWED_HOSTS = "n8n.example.test";
    resetEnvCache();
    org = await crmOrg({ name: "n8n Client" });
    const people = await agencyPeople();
    superAdminId = people.superAdmin.id;
    mappingId = await withSystem(async (db) => {
      const conn = await db.query<{ id: string }>(
        `insert into integration_connections (org_id, provider, label, config, status) values (null, 'n8n', 'Agency n8n', $1, 'connected')
         on conflict (coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid), provider) do update set config = excluded.config, status = 'connected' returning id`,
        [JSON.stringify({ baseUrl: "https://n8n.example.test", approvedWorkflowIds: ["wfLead01"] })],
      );
      const m = await db.query<{ id: string }>("insert into automation_template_mappings (org_id, global_connection_id, workflow_id, status, last_verified_at) values ($1, $2, 'wfLead01', 'verified', now()) returning id", [org.org.id, conn.rows[0].id]);
      return m.rows[0].id;
    });
  });
  afterAll(() => {
    delete process.env.INTEGRATION_ALLOWED_HOSTS;
    delete process.env.N8N_ACTIONS_ENABLED;
    resetEnvCache();
  });
  const enable = (on: boolean) => {
    if (on) process.env.N8N_ACTIONS_ENABLED = "true";
    else delete process.env.N8N_ACTIONS_ENABLED;
    resetEnvCache();
  };
  const call = (key: string, payload: Record<string, unknown> = { contactId: "c-1", reason: "won" }) => callN8nWorkflow({ orgId: org.org.id, mappingId, payload, idempotencyKey: key });

  it("is off unless N8N_ACTIONS_ENABLED, and never calls n8n while off", async () => {
    enable(false);
    // Clients read this in run history: plain words, never the setting's name.
    const off = await call("wf:step-off-1");
    expect(off).toMatchObject({ status: "blocked", detail: expect.stringMatching(/switched off by iAcquire/) });
    expect(off.detail).not.toMatch(/N8N_ACTIONS_ENABLED/);
    expect(calls).toHaveLength(0);
  });

  it("only agency super admins store a trigger, only on the approved host, never the test URL", async () => {
    const people = await agencyPeople();
    await expect(configureN8nTrigger(people.staff.id, { orgId: org.org.id, mappingId, url: URL_OK, token: TOKEN })).rejects.toThrow(/super admins/);
    await expect(configureN8nTrigger(org.people.owner.id, { orgId: org.org.id, mappingId, url: URL_OK, token: TOKEN })).rejects.toThrow(/super admins/);
    await expect(configureN8nTrigger(superAdminId, { orgId: org.org.id, mappingId, url: "https://evil.example.test/webhook/x", token: TOKEN })).rejects.toThrow(/agency n8n host/);
    await expect(configureN8nTrigger(superAdminId, { orgId: org.org.id, mappingId, url: "https://n8n.example.test/webhook-test/x", token: TOKEN })).rejects.toThrow(/Production URL/);
    await expect(configureN8nTrigger(superAdminId, { orgId: org.org.id, mappingId, url: "https://n8n.example.test/api/v1/workflows", token: TOKEN })).rejects.toThrow(/Production URL/);
    await expect(configureN8nTrigger(superAdminId, { orgId: org.org.id, mappingId, url: URL_OK, token: "short" })).rejects.toThrow(/32 to 512/);
    await expect(configureN8nTrigger(superAdminId, { orgId: b.org.id, mappingId, url: URL_OK, token: TOKEN })).rejects.toThrow(/isn't mapped/);
    expect((await getN8nTriggerStatus(org.org.id, mappingId)).configured).toBe(false);
  });

  it("is blocked until the trigger is configured, then POSTs once with header auth, a signature and the idempotency key", async () => {
    enable(true);
    expect(await call("wf:step-1")).toMatchObject({ status: "blocked", detail: expect.stringMatching(/webhook trigger/) });
    expect(calls).toHaveLength(0);
    await configureN8nTrigger(superAdminId, { orgId: org.org.id, mappingId, url: URL_OK, token: TOKEN });
    expect((await getN8nTriggerStatus(org.org.id, mappingId)).configured).toBe(true);
    // The token is in the vault reference, not in plain configuration.
    const plain = await withSystem((db) => db.query("select 1 from integration_connections where config::text like $1", [`%${TOKEN}%`]));
    expect(plain.rows).toHaveLength(0);
    responder = () => Response.json({ message: "Workflow was started" });
    const r = await call("wf:step-1");
    expect(r).toMatchObject({ status: "sent", httpStatus: 200 });
    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(c.url).toBe(URL_OK);
    expect(c.method).toBe("POST");
    expect(c.headers["x-iacquire-token"]).toBe(TOKEN);
    expect(c.headers["idempotency-key"]).toBe("wf:step-1");
    expect(verifyWebhookSignature({ secret: TOKEN, body: c.body, header: c.headers["iacquire-signature"] })).toBe(true);
    expect(JSON.parse(c.body)).toMatchObject({ type: "workflow.n8n", orgId: org.org.id, idempotencyKey: "wf:step-1", data: { contactId: "c-1" } });
    // The same key again: the earlier outcome, no second request.
    expect(await call("wf:step-1")).toMatchObject({ status: "sent", duplicate: true });
    expect(calls).toHaveLength(1);
  });

  it("never retries an unknown outcome (timeout or a server error), but may retry when n8n provably didn't run it", async () => {
    enable(true);
    responder = timeout;
    expect(await call("wf:step-timeout")).toMatchObject({ status: "unknown", retryable: false });
    responder = () => Response.json({ ok: true });
    expect(await call("wf:step-timeout")).toMatchObject({ status: "unknown", duplicate: true });
    expect(calls).toHaveLength(1);

    responder = () => new Response("boom", { status: 500 });
    expect(await call("wf:step-500")).toMatchObject({ status: "unknown", httpStatus: 500 });
    expect(await call("wf:step-500")).toMatchObject({ status: "unknown", duplicate: true });
    expect(calls).toHaveLength(2);

    responder = () => Response.json({ code: 404, message: 'The requested webhook "POST iacquire-lead-handoff" is not registered.' }, { status: 404 });
    const inactive = await call("wf:step-404");
    expect(inactive).toMatchObject({ status: "rejected", httpStatus: 404 });
    expect(inactive.detail).toMatch(/never activates/);
    responder = () => new Response(null, { status: 403 });
    expect(await call("wf:step-403")).toMatchObject({ status: "rejected", detail: expect.stringMatching(/token/) });
    responder = refused;
    expect(await call("wf:step-refused")).toMatchObject({ status: "not_sent", retryable: true });
    // Rejected or never sent: the same key may be tried again once fixed.
    responder = () => Response.json({ ok: true });
    expect(await call("wf:step-404")).toMatchObject({ status: "sent" });
    expect(await call("wf:step-refused")).toMatchObject({ status: "sent" });
  });

  it("serializes concurrent calls with one key: only one request goes out", async () => {
    enable(true);
    responder = () => Response.json({ ok: true });
    const results = await Promise.all([call("wf:step-concurrent"), call("wf:step-concurrent"), call("wf:step-concurrent")]);
    expect(calls).toHaveLength(1);
    expect(results.filter((r) => r.status === "sent" && !r.duplicate)).toHaveLength(1);
  });

  it("is gated by the mapping's verification, the connection, the workspace's pauses and status at the moment it runs", async () => {
    enable(true);
    responder = () => Response.json({ ok: true });
    await withSystem((db) => db.query("update automation_template_mappings set status = 'needs_attention' where id = $1", [mappingId]));
    expect(await call("wf:gate-1")).toMatchObject({ status: "blocked", detail: expect.stringMatching(/verified/) });
    await withSystem((db) => db.query("update automation_template_mappings set status = 'verified' where id = $1", [mappingId]));
    // Taken off the agency's approved list: never started, even though the mapping is still verified.
    await withSystem((db) => db.query("update integration_connections set config = jsonb_set(config, '{approvedWorkflowIds}', '[]') where org_id is null and provider = 'n8n'"));
    expect(await call("wf:gate-unlisted")).toMatchObject({ status: "blocked", retryable: false, detail: expect.stringMatching(/approved list/) });
    await withSystem((db) => db.query(`update integration_connections set config = jsonb_set(config, '{approvedWorkflowIds}', '["wfLead01"]') where org_id is null and provider = 'n8n'`));
    for (const scope of ["workflows", "outbound", "agency"]) {
      await withSystem((db) => db.query("insert into automation_pauses (org_id, scope, active) values ($1, $2, true) on conflict do nothing", [org.org.id, scope]));
      await withSystem((db) => db.query("update automation_pauses set active = true where org_id = $1 and scope = $2", [org.org.id, scope]));
      expect(await call(`wf:gate-${scope}`)).toMatchObject({ status: "blocked" });
      await withSystem((db) => db.query("update automation_pauses set active = false where org_id = $1", [org.org.id]));
    }
    await withSystem((db) => db.query("update organizations set status = 'suspended' where id = $1", [org.org.id]));
    expect(await call("wf:gate-suspended")).toMatchObject({ status: "blocked", detail: expect.stringMatching(/not active/) });
    await withSystem((db) => db.query("update organizations set status = 'active' where id = $1", [org.org.id]));
    // A mapping from another workspace is never reachable from this one.
    expect(await callN8nWorkflow({ orgId: b.org.id, mappingId, payload: {}, idempotencyKey: "wf:other-org" })).toMatchObject({ status: "blocked", detail: expect.stringMatching(/isn't mapped/) });
    expect(calls).toHaveLength(0);
    // A trigger whose host now resolves to a private address isn't contacted.
    DNS["n8n.example.test"] = ["10.0.0.9"];
    try {
      expect(await call("wf:gate-dns")).toMatchObject({ status: "not_sent" });
    } finally {
      DNS["n8n.example.test"] = ["93.184.216.40"];
    }
    expect(calls).toHaveLength(0);
    await expect(callN8nWorkflow({ orgId: org.org.id, mappingId, payload: [] as unknown as Record<string, unknown>, idempotencyKey: "wf:bad-payload" })).rejects.toThrow(/must be an object/);
    // Removing the trigger blocks the step again.
    expect(await removeN8nTrigger(superAdminId, { orgId: org.org.id, mappingId })).toBe(true);
    expect(await call("wf:gate-removed")).toMatchObject({ status: "blocked", detail: expect.stringMatching(/webhook trigger/) });
  });
});
