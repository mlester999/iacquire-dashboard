// Journey 2, the edges: lead acquisition through the website chat, asked what journey 2 does not.
//   * denied access: a website that is not on the list, another workspace's key, and a switched-off widget are each refused, and a refusal creates no session, contact or touch;
//   * tenant isolation: the lead, its touch and its consent record are invisible to a member of another workspace (row-level security, as the application role), and the other
//     workspace's Lead Sources report does not count it;
//   * duplicates and replays: the same chat message and the same details form sent twice make one message, one lead, one touch and one pair of consent records;
//   * audit: the consent record names the wording the visitor saw, the settings change is in the audit log with who made it, and neither holds the visitor's session token;
//   * what the visitor is told: the refusal for a missing privacy confirmation, and the unchanged page for a switched-off widget (the same for an unknown key).
// The language model is the stub in tests/support/webchat.ts and nothing is sent to the visitor: the widget's own handler is called directly.
import { describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { memberActor } from "@/server/crm/actor";
import { attributionReport } from "@/server/attribution/report";
import { answer, bodyOf, chatOrg, clientId, embedCall, hashOf, reconfigure, start, viewOf } from "../support/webchat";
import { uniqueEmail } from "../support/unverified";
import { phone } from "../support/messaging";

const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;
const count = async (sql: string, params: unknown[] = []) => (await rows(sql, params)).length;
const window = () => ({ startsAt: new Date(Date.now() - 3_600_000), endsAt: new Date(Date.now() + 3_600_000) });

describe("journey 2: who is refused, who cannot see the lead, and what a repeat does", () => {
  it("refuses a website that is not allowed, another workspace's key and a switched-off widget, and each refusal creates nothing", async () => {
    const a = await chatOrg();
    const OTHER_SITE = "https://www.other-site.test";
    const b = await chatOrg({ allowedOrigins: [OTHER_SITE] });
    const sessionsBefore = await count("select 1 from web_chat_sessions where org_id = $1", [a.m.org.id]);

    const strangerSite = await embedCall(a, { action: "session", origin: "https://not-the-clients-site.test", body: { landing: "/", referrer: "", timezone: "Asia/Manila" } });
    expect(strangerSite.status).toBe(403);
    expect(bodyOf(strangerSite).error?.code).toBe("origin_not_allowed");
    // B's key on A's allowed website, and A's key on B's: both refused, so a site cannot borrow another workspace's widget.
    expect((await embedCall(a, { action: "session", key: b.widget.publicKey, body: { landing: "/", referrer: "", timezone: "Asia/Manila" } })).status).toBe(403);
    expect((await embedCall(b, { action: "session", key: a.widget.publicKey, origin: OTHER_SITE, body: { landing: "/", referrer: "", timezone: "Asia/Manila" } })).status).toBe(403);
    expect(await count("select 1 from web_chat_sessions where org_id = $1", [a.m.org.id])).toBe(sessionsBefore);

    // A switched-off widget looks exactly like an unknown key from outside, and starts nothing.
    await reconfigure(a, { enabled: false });
    const off = await embedCall(a, { action: "session", body: { landing: "/", referrer: "", timezone: "Asia/Manila" } });
    const unknown = await embedCall(a, { action: "session", key: "wk_" + "z".repeat(24), body: { landing: "/", referrer: "", timezone: "Asia/Manila" } });
    expect(off.status).toBe(404);
    expect(JSON.stringify(off.body)).toBe(JSON.stringify(unknown.body));
    expect(await count("select 1 from web_chat_sessions where org_id = $1", [a.m.org.id])).toBe(sessionsBefore);
    await reconfigure(a, { enabled: true });
  });

  it("keeps the lead, its touch and its consent away from another workspace and its report", async () => {
    const a = await chatOrg();
    const b = await chatOrg();
    const token = await start(a, { landing: "/pricing?utm_source=google&utm_medium=cpc&utm_campaign=edge-journey" });
    expect((await embedCall(a, { action: "send", token, body: { text: "I need a quote", clientMessageId: clientId() }, generate: answer("What is the address?").generate })).status).toBe(200);
    const typedEmail = uniqueEmail();
    const lead = await embedCall(a, { action: "lead", token, body: { details: { name: "Edge Lee", email: typedEmail, phone: phone() }, privacyAck: true, marketingOptIn: false } });
    expect(lead.status).toBe(200);
    expect(viewOf(lead).leadCaptured).toBe(true);

    // B's session token does not open A's chat, and A's token does not open B's.
    const bToken = await start(b);
    expect((await embedCall(a, { action: "messages", token: bToken })).status).toBeGreaterThanOrEqual(400);
    expect((await embedCall(b, { action: "messages", token })).status).toBeGreaterThanOrEqual(400);

    const [session] = await rows<{ contact_id: string }>("select contact_id from web_chat_sessions where org_id = $1 and token_hash = $2", [a.m.org.id, hashOf(token)]);
    const outsider = b.m.people.owner;
    const seen = (table: string) => withUser(outsider.id, async (db) => (await db.query(`select 1 from ${table} where org_id = $1`, [a.m.org.id])).rows.length);
    for (const table of ["web_chat_sessions", "contacts", "lead_touches", "contact_consent_events", "contact_identities"]) {
      expect(await count(`select 1 from ${table} where org_id = $1`, [a.m.org.id]), `${table} exists`).toBeGreaterThan(0);
      expect(await seen(table), `${table} seen by another workspace's owner`).toBe(0);
    }
    // The other workspace's own Lead Sources report does not count it.
    const own = await attributionReport(memberActor(a.m.ctx("owner")), window());
    const theirs = await attributionReport(memberActor(b.m.ctx("owner")), window());
    expect(own.totals.leads).toBe(1);
    expect(theirs.totals.leads).toBe(0);
    expect(session.contact_id).toBeTruthy();
  });

  it("makes one message, one lead, one touch and one pair of consent records when the same message and the same form arrive twice", async () => {
    const a = await chatOrg();
    const token = await start(a, { landing: "/offer?utm_source=newsletter&utm_medium=email&utm_campaign=edge-repeat" });
    const mid = clientId();
    const reply = answer("Thanks, what is the address?");
    for (let i = 0; i < 2; i += 1) {
      expect((await embedCall(a, { action: "send", token, body: { text: "Do you fix gutters?", clientMessageId: mid }, generate: reply.generate })).status).toBe(200);
    }
    expect(reply.calls).toHaveLength(1);
    const [session] = await rows<{ contact_id: string; conversation_id: string }>("select contact_id, conversation_id from web_chat_sessions where org_id = $1 and token_hash = $2", [a.m.org.id, hashOf(token)]);
    expect(await count("select 1 from conversation_messages where org_id = $1 and conversation_id = $2 and direction = 'inbound'", [a.m.org.id, session.conversation_id])).toBe(1);

    const details = { name: "Repeat Lee", email: uniqueEmail(), phone: phone() };
    for (let i = 0; i < 2; i += 1) {
      expect((await embedCall(a, { action: "lead", token, body: { details, privacyAck: true, marketingOptIn: false } })).status).toBe(200);
    }
    expect(await count("select 1 from lead_touches where org_id = $1 and contact_id = $2", [a.m.org.id, session.contact_id])).toBe(1);
    expect(await count("select 1 from contact_consent_events where org_id = $1 and contact_id = $2", [a.m.org.id, session.contact_id])).toBe(2);
    expect(await count("select 1 from contacts where org_id = $1 and id = $2", [a.m.org.id, session.contact_id])).toBe(1);
    const report = await attributionReport(memberActor(a.m.ctx("owner")), window());
    expect(report.totals.leads).toBe(1);
  });

  it("records what the visitor agreed to and who changed the widget, and keeps the visitor's token out of both", async () => {
    const a = await chatOrg();
    const token = await start(a);
    expect((await embedCall(a, { action: "send", token, body: { text: "Hello", clientMessageId: clientId() }, generate: answer("Hi!").generate })).status).toBe(200);
    expect((await embedCall(a, { action: "lead", token, body: { details: { name: "Audit Lee", email: uniqueEmail() }, privacyAck: true, marketingOptIn: false } })).status).toBe(200);
    const consent = await rows<{ source: string; status: string; evidence: string; created_at: Date }>("select source, status, evidence, created_at from contact_consent_events where org_id = $1", [a.m.org.id]);
    expect(consent.length).toBeGreaterThan(0);
    for (const e of consent) {
      expect(e.status).toBe("granted");
      expect(e.evidence).toMatch(/Typed by the visitor in the website chat, unverified\./);
    }
    // The widget was configured by the owner, and that is in the audit log under the owner's name; the visitor's session token is in neither place.
    const audit = await rows<{ action: string; actor_user_id: string | null; metadata: unknown }>("select action, actor_user_id, metadata from audit_logs where org_id = $1 and action like 'webchat.%'", [a.m.org.id]);
    expect(audit.some((r) => r.action === "webchat.settings_saved" && r.actor_user_id === a.m.people.owner.id)).toBe(true);
    expect(JSON.stringify(audit) + JSON.stringify(consent)).not.toContain(token);
  });

  it("tells a visitor who did not confirm the privacy notice exactly why nothing was saved, and saves nothing", async () => {
    const a = await chatOrg();
    const token = await start(a);
    const email = uniqueEmail();
    const refused = await embedCall(a, { action: "lead", token, body: { details: { email }, privacyAck: false } });
    expect(refused.status).toBe(400);
    expect(bodyOf(refused).error?.message).toMatch(/privacy notice/i);
    expect(await count("select 1 from contacts where org_id = $1 and email = $2", [a.m.org.id, email])).toBe(0);
    expect(await count("select 1 from contact_consent_events where org_id = $1", [a.m.org.id])).toBe(0);
  });
});
