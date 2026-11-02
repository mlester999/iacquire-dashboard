// "Check email setup" for purchase invitations, with the email provider replaced by a stand-in fetch that answers only reads. Proved: it asks the provider (never sends), reports each
// finding item by item, says "could not be checked" for a key that can only send, says what is missing without any network call when email is off, is a Super Admin's action with a
// rate limit, writes an audit row, and never returns, logs or stores the key.
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/server/env";
import { checkEmailSetup } from "@/server/purchase-intents/email-check";
import { resendWebhookUrl } from "@/server/messaging/transports/resend";
import { agencyUser } from "./support/fixtures";
import { agencyOrgId, rows, staffPerson } from "./support/staff-messages";

const KEY = "re_test_not_a_real_key_123";
const SECRET = `whsec_${crypto.randomBytes(24).toString("base64")}`;
const READY = { EMAIL_PROVIDER: "resend", RESEND_API_KEY: KEY, EMAIL_FROM: "iAcquire <no-reply@iacquire.online>", APP_URL: "https://www.iacquire.online", RESEND_WEBHOOK_SECRET: SECRET } as const;
const SAVED: Record<string, string | undefined> = {};
const setEnv = (over: Record<string, string | undefined>) => {
  for (const [name, value] of Object.entries(over)) {
    if (!(name in SAVED)) SAVED[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetEnvCache();
};

const DOMAIN_ID = "4dd369bc-aa82-4ff3-97de-514ae3000ee0";
const HOOK_ID = "479e3145-dd38-476b-932c-529ceb705947";
const domain = (over: Record<string, unknown> = {}) => ({
  object: "domain", id: DOMAIN_ID, name: "iacquire.online", status: "verified", created_at: "2026-10-01 10:00:00.000000+00", region: "us-east-1", capabilities: { sending: "enabled", receiving: "disabled" },
  records: [
    { record: "SPF", name: "send", type: "TXT", ttl: "Auto", status: "verified", value: "\"v=spf1 include:amazonses.com ~all\"" },
    { record: "DKIM", name: "resend._domainkey", type: "TXT", ttl: "Auto", status: "verified", value: "p=MIGf..." },
  ],
  ...over,
});
const hook = (over: Record<string, unknown> = {}) => ({ id: HOOK_ID, endpoint: resendWebhookUrl(), events: ["email.sent", "email.delivered", "email.bounced", "email.complained"], status: "enabled", ...over });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Seen { method: string; url: URL; auth: string | null }
/** A stand-in for Resend that answers reads only, and records every request it was asked. */
function stubResend(answer: (path: string) => Response | null = () => null) {
  const seen: Seen[] = [];
  const doFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    seen.push({ method: init?.method ?? "GET", url: u, auth: new Headers(init?.headers).get("authorization") });
    const custom = answer(u.pathname);
    if (custom) return custom;
    if (u.pathname === "/domains") return json({ object: "list", has_more: false, data: [domain()] });
    if (u.pathname.startsWith("/domains/")) return json(domain());
    if (u.pathname === "/webhooks") return json({ object: "list", has_more: false, data: [hook()] });
    if (u.pathname.startsWith("/webhooks/")) return json({ object: "webhook", ...hook(), signing_secret: SECRET });
    return json({ name: "not_found", message: "Not found" }, 404);
  });
  return { seen, doFetch: doFetch as unknown as typeof fetch };
}

async function superAdmin() {
  await agencyOrgId();
  return agencyUser(await staffPerson("agency_super_admin"), "agency_super_admin");
}

beforeEach(() => setEnv({ ...READY }));
afterEach(() => {
  vi.unstubAllGlobals();
  for (const [name, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetEnvCache();
});

describe("what it asks, and what it never does", () => {
  it("reads the sender's domain and the webhook with the key, item by item, and sends nothing", async () => {
    const me = await superAdmin();
    const { seen, doFetch } = stubResend();
    const result = await checkEmailSetup(me, { fetch: doFetch });
    expect(result.ok).toBe(true);
    expect(result.sender).toBe("iAcquire <no-reply@iacquire.online>");
    expect(result.headline).toBe("Email can be sent from iAcquire <no-reply@iacquire.online>, and the provider's delivery notices will be accepted.");
    expect(result.checks.map((c) => [c.label, c.ok])).toEqual([["Configuration", true], ["API key", true], ["Domain", true], ["Sending", true], ["Webhooks", true]]);
    expect(result.checks.find((c) => c.label === "Sending")?.detail).toContain("iacquire.online is verified for sending");
    // Reads only, only to the provider, and never a message.
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen.map((s) => s.method))).toEqual(new Set(["GET"]));
    expect(new Set(seen.map((s) => s.url.host))).toEqual(new Set(["api.resend.com"]));
    expect(seen.some((s) => s.url.pathname.startsWith("/emails"))).toBe(false);
    expect(seen.every((s) => s.auth === `Bearer ${KEY}`)).toBe(true);
    // The answer holds no key and no signing secret.
    const text = JSON.stringify(result);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("whsec_");
  });

  it("leaves out the Inbox's reply checks, which a purchase invitation does not use", async () => {
    const me = await superAdmin();
    const { doFetch } = stubResend();
    const result = await checkEmailSetup(me, { fetch: doFetch });
    expect(result.checks.some((c) => c.label === "Replies")).toBe(false);
  });

  it("makes no network call when email is off, and names the settings to change", async () => {
    setEnv({ EMAIL_PROVIDER: "capture", RESEND_API_KEY: undefined });
    const me = await superAdmin();
    const { seen, doFetch } = stubResend();
    const result = await checkEmailSetup(me, { fetch: doFetch });
    expect(seen).toHaveLength(0);
    expect(result.ok).toBe(false);
    expect(result.headline).toMatch(/not set up in this environment/);
    expect(result.checks.every((c) => !c.ok && c.label === "Configuration")).toBe(true);
    expect(result.checks.map((c) => c.detail).join(" ")).toMatch(/EMAIL_PROVIDER[\s\S]*RESEND_API_KEY/);
  });

  it("treats a placeholder sender as not set up, again without asking the provider", async () => {
    setEnv({ EMAIL_FROM: "iAcquire <no-reply@iacquire.local>" });
    const me = await superAdmin();
    const { seen, doFetch } = stubResend();
    const result = await checkEmailSetup(me, { fetch: doFetch });
    expect(seen).toHaveLength(0);
    expect(result).toMatchObject({ ok: false });
    expect(result.checks[0].detail).toMatch(/EMAIL_FROM/);
  });
});

describe("what it will not claim", () => {
  it("says the domain is not verified when the provider says so, and is not ok", async () => {
    const me = await superAdmin();
    const pending = domain({ status: "pending", capabilities: { sending: "disabled", receiving: "disabled" }, records: [{ record: "DKIM", name: "resend._domainkey", type: "TXT", ttl: "Auto", status: "pending", value: "p=MIGf..." }] });
    const { doFetch } = stubResend((p) => (p === "/domains" ? json({ object: "list", has_more: false, data: [pending] }) : p.startsWith("/domains/") ? json(pending) : null));
    const result = await checkEmailSetup(me, { fetch: doFetch });
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.label === "Sending")).toMatchObject({ ok: false });
    expect(result.headline).toMatch(/could not be confirmed as ready/);
  });

  it("says the sender's domain is not in the account at all", async () => {
    const me = await superAdmin();
    const { doFetch } = stubResend((p) => (p === "/domains" ? json({ object: "list", has_more: false, data: [domain({ name: "someone-else.example" })] }) : null));
    const result = await checkEmailSetup(me, { fetch: doFetch });
    expect(result.ok).toBe(false);
    expect(result.checks.at(-1)).toMatchObject({ label: "Domain", ok: false, detail: expect.stringContaining("isn't added") });
  });

  it("reports a key that can only send as not checkable, never as ready", async () => {
    const me = await superAdmin();
    const { doFetch } = stubResend((p) => (p.startsWith("/domains") ? json({ name: "restricted_api_key", message: "This API key is restricted to only send emails" }, 401) : null));
    const result = await checkEmailSetup(me, { fetch: doFetch });
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => !c.ok)?.detail).toMatch(/can only send/);
    expect(result.checks.find((c) => c.label === "Sending")).toBeUndefined();
  });

  it("reports an unreachable provider as a failure with no verdict on the domain", async () => {
    const me = await superAdmin();
    const down = vi.fn(async () => { throw new Error("connect ECONNREFUSED 203.0.113.9:443"); }) as unknown as typeof fetch;
    const result = await checkEmailSetup(me, { fetch: down });
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => !c.ok)?.detail).toMatch(/couldn't be reached/);
    expect(JSON.stringify(result)).not.toContain("ECONNREFUSED");
  });

  it("can send but not confirm delivery notices when the signing secret is not set: the headline says invitations stay at Sent", async () => {
    setEnv({ RESEND_WEBHOOK_SECRET: undefined });
    const me = await superAdmin();
    const { doFetch } = stubResend();
    const result = await checkEmailSetup(me, { fetch: doFetch });
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.label === "Webhooks")).toMatchObject({ ok: false, detail: expect.stringContaining("RESEND_WEBHOOK_SECRET") });
    expect(result.checks.filter((c) => !c.ok).map((c) => c.label)).toEqual(["Webhooks"]);
    expect(result.headline).toMatch(/Email can be sent, but delivery notices are not confirmed/);
    expect(result.headline).toContain("Sent to the email provider");
  });

  it("flags a webhook signed with a different secret", async () => {
    const me = await superAdmin();
    const { doFetch } = stubResend((p) => (p.startsWith("/webhooks/") ? json({ object: "webhook", ...hook(), signing_secret: `whsec_${crypto.randomBytes(24).toString("base64")}` }) : null));
    const result = await checkEmailSetup(me, { fetch: doFetch });
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.label === "Webhooks")?.detail).toMatch(/different secret/);
  });
});

describe("who may run it, and what it leaves behind", () => {
  it("is for a Super Admin: a manager and a member of staff are refused, before any call to the provider", async () => {
    await agencyOrgId();
    const { seen, doFetch } = stubResend();
    const manager = agencyUser(await staffPerson("agency_manager"), "agency_manager");
    const staff = agencyUser(await staffPerson("agency_staff"), "agency_staff");
    await expect(checkEmailSetup(manager, { fetch: doFetch })).rejects.toThrow(/Super Admin|does not allow/);
    await expect(checkEmailSetup(staff, { fetch: doFetch })).rejects.toThrow(/Super Admin|does not allow/);
    expect(seen).toHaveLength(0);
  });

  it("allows twelve checks an hour for one person and then says when to try again", async () => {
    setEnv({ EMAIL_PROVIDER: "capture", RESEND_API_KEY: undefined });
    const me = await superAdmin();
    for (let i = 0; i < 12; i++) await checkEmailSetup(me);
    await expect(checkEmailSetup(me)).rejects.toThrow(/checked several times already/);
  });

  it("writes one audit row per check naming what failed, and no key", async () => {
    const me = await superAdmin();
    const { doFetch } = stubResend((p) => (p.startsWith("/webhooks") ? json({ data: [] , has_more: false }) : null));
    await checkEmailSetup(me, { fetch: doFetch });
    const audit = await rows<{ result: string; metadata: { ok: boolean; failed: string[]; sender: string }; actor_kind: string }>("select result, metadata, actor_kind from audit_logs where action = 'email_setup.checked' and actor_user_id = $1", [me.id]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ result: "failure", actor_kind: "agency", metadata: { ok: false, failed: ["Webhooks"], sender: "iAcquire <no-reply@iacquire.online>" } });
    expect(JSON.stringify(audit)).not.toContain(KEY);
  });
});
