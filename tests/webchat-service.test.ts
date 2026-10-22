// The website chat on real internal services (embedded Postgres, the real conversation and escalation code, the real calendar rules). Only the
// language model and the calendar provider are stubs, and every test that depends on one says so.
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { ensureWidget, readWidgetView, rotatePublicKey, saveWidgetSettings } from "@/server/webchat/config";
import { getConversationDetail, sendHumanReply } from "@/server/messaging/inbox";
import { getInboxCrmContext } from "@/server/messaging/inbox-context";
import { inboxViewCounts, listConversationsPage } from "@/server/messaging/inbox-list";
import { addSiteHost, answer, answering, bodyOf, chatOrg, embedCall, hashOf, ipFor, ORIGIN, reconfigure, reload, start, viewOf, clientId, type ChatOrg } from "./support/webchat";
import { messagingOrg } from "./support/messaging";

let c: ChatOrg;
let other: ChatOrg;

beforeAll(async () => {
  c = await chatOrg();
  other = await chatOrg({ allowedOrigins: ["https://www.other-site.test"] });
});

const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;

describe("the widget's configuration", () => {
  it("is created off, with nowhere to run, and cannot be switched on until it has somewhere", async () => {
    const fresh = await messagingOrg();
    const created = await withSystem((db) => ensureWidget(db, fresh.org.id));
    expect(created).toMatchObject({ enabled: false, allowedOrigins: [], aiEnabled: true, allowBooking: true, leadForm: "offer", offlineBehavior: "ai_answers", version: 1 });
    expect(created.publicKey).toMatch(/^wk_[A-Za-z0-9]{24}$/);
    expect(created.knowledgeSections).not.toContain("approved_pricing");
    await expect(saveWidgetSettings(fresh.ctx("owner"), { enabled: true }, created.version)).rejects.toThrow(/website the chat will run on/i);
    const on = await saveWidgetSettings(fresh.ctx("owner"), { enabled: true, allowedOrigins: ["https://Shop.Example.com/page"] }, created.version);
    expect(on).toMatchObject({ enabled: true, allowedOrigins: ["shop.example.com"], version: 2 });
  });

  it("is changed only by people who can edit the website, from the version they saw, with checked values", async () => {
    const w = await reload(c.m.org.id);
    await expect(saveWidgetSettings(c.m.ctx("viewer"), { title: "Hi" }, w.version)).rejects.toThrow(/can't change/i);
    await expect(saveWidgetSettings(c.m.ctx("owner"), { title: "Hi" }, w.version - 1)).rejects.toThrow(/someone else/i);
    await expect(saveWidgetSettings(c.m.ctx("owner"), { allowedOrigins: ["10.0.0.1"] }, w.version)).rejects.toThrow(/IP address/i);
    await expect(saveWidgetSettings(c.m.ctx("owner"), { brandColor: "blue" }, w.version)).rejects.toThrow(/colour/i);
    await expect(saveWidgetSettings(c.m.ctx("owner"), { privacyUrl: "http://insecure.example.com" }, w.version)).rejects.toThrow(/https/i);
    await expect(saveWidgetSettings(c.m.ctx("owner"), { qualificationQuestions: [{ label: "x" }] }, w.version)).rejects.toThrow(/label/i);
    const saved = await saveWidgetSettings(c.m.ctx("owner"), { title: "  Talk to  us  ", welcomeMessage: "Hello!\u0000", brandColor: "#112233", knowledgeSections: ["faq", "faq", "approved_pricing"] }, w.version);
    expect(saved).toMatchObject({ title: "Talk to us", welcomeMessage: "Hello!", brandColor: "#112233" });
    expect(saved.knowledgeSections.sort()).toEqual(["approved_pricing", "faq"]);
    await reconfigure(c, { title: "Chat with us", welcomeMessage: "Hi! How can we help today?", knowledgeSections: ["business_description", "products_services", "faq", "business_hours", "policies", "brand_voice"] });
    const audited = await rows("select action from audit_logs where org_id = $1 and action = 'webchat.settings_saved'", [c.m.org.id]);
    expect(audited.length).toBeGreaterThan(0);
  });

  it("shows the owner the key, the installation state and where it has really been seen, and shows a viewer nothing it created", async () => {
    const view = await readWidgetView(c.m.ctx("owner"));
    expect(view.settings.publicKey).toBe(c.widget.publicKey);
    expect(view.install.state).toBe("waiting"); // nothing has loaded it yet: no invented "connected"
    await embedCall(c, { action: "config" });
    const seen = await readWidgetView(c.m.ctx("owner"));
    expect(seen.install.state).toBe("installed");
    expect(seen.settings.lastSeenOrigin).toBe("www.client-site.test");
    await expect(readWidgetView(c.m.ctx("viewer"))).resolves.toMatchObject({ canEdit: false });
    const never = await messagingOrg();
    await expect(readWidgetView(never.ctx("viewer"))).rejects.toThrow(/not been set up/i);
  });

  it("replaces the key on request, and the old key stops working at once", async () => {
    const mine = await chatOrg();
    const old = mine.widget.publicKey;
    expect((await embedCall(mine, { action: "config" })).status).toBe(200);
    const next = await rotatePublicKey(mine.m.ctx("owner"));
    expect(next.publicKey).not.toBe(old);
    expect((await embedCall(mine, { action: "config", key: old })).status).toBe(404);
    expect((await embedCall(mine, { action: "config", key: next.publicKey })).status).toBe(200);
    await expect(rotatePublicKey(mine.m.ctx("viewer"))).rejects.toThrow(/can't change/i);
  });
});

describe("who can use a widget", () => {
  it("serves the public settings to an allowed website, and nothing private", async () => {
    const r = await embedCall(c, { action: "config" });
    expect(r.status).toBe(200);
    expect(r.corsOrigin).toBe(ORIGIN);
    const cfg = (bodyOf<{ config: Record<string, unknown> }>(r)).config;
    expect(cfg).toMatchObject({ title: "Chat with us", aiAvailable: true, open: true, leadForm: "offer" });
    const text = JSON.stringify(r.body);
    expect(text).not.toMatch(new RegExp(`${c.m.org.id}|${c.widget.orgId}|allowedOrigins|publicKey|knowledge|aiRole`));
  });

  it("refuses a website that is not on the list, without echoing it back for cross-origin use", async () => {
    const r = await embedCall(c, { action: "config", origin: "https://evil.test" });
    expect(r.status).toBe(403);
    expect(r.corsOrigin).toBeUndefined();
    expect(bodyOf(r).error?.code).toBe("origin_not_allowed");
    // A request with no Origin at all (not a browser page) is not allowed either.
    expect((await embedCall(c, { action: "config", origin: null })).status).toBe(403);
    expect((await embedCall(c, { action: "config", origin: "null" })).status).toBe(403);
  });

  it("does not let one workspace's allowed website use another workspace's key", async () => {
    // other's allowed site (www.other-site.test) with c's key, and c's allowed site with other's key.
    expect((await embedCall(c, { action: "config", origin: "https://www.other-site.test" })).status).toBe(403);
    expect((await embedCall(other, { action: "config", key: other.widget.publicKey, origin: ORIGIN })).status).toBe(403);
    expect((await embedCall(other, { action: "config", key: other.widget.publicKey, origin: "https://www.other-site.test" })).status).toBe(200);
  });

  it("answers a browser's preflight only for an allowed website", async () => {
    const ok = await embedCall(c, { action: "send", method: "OPTIONS" });
    expect(ok).toMatchObject({ status: 204, corsOrigin: ORIGIN });
    const bad = await embedCall(c, { action: "send", method: "OPTIONS", origin: "https://evil.test" });
    expect(bad.status).toBe(403);
    expect(bad.corsOrigin).toBeUndefined();
  });

  it("looks the same from outside whether a key is unknown, malformed or switched off", async () => {
    const off = await chatOrg();
    await reconfigure(off, { enabled: false });
    const a = await embedCall(off, { action: "config" });
    const b = await embedCall(off, { action: "config", key: "wk_" + "z".repeat(24) });
    const d = await embedCall(off, { action: "config", key: "not-a-key" });
    for (const r of [a, b, d]) expect(r).toMatchObject({ status: 404 });
    expect(JSON.stringify(a.body)).toBe(JSON.stringify(b.body));
    expect(JSON.stringify(b.body)).toBe(JSON.stringify(d.body));
  });

  it("matches a wildcard to one subdomain level only", async () => {
    const w = await chatOrg({ allowedOrigins: ["*.shop.client.test"] });
    expect((await embedCall(w, { action: "config", origin: "https://a.shop.client.test" })).status).toBe(200);
    expect((await embedCall(w, { action: "config", origin: "https://shop.client.test" })).status).toBe(403);
    expect((await embedCall(w, { action: "config", origin: "https://x.y.shop.client.test" })).status).toBe(403);
  });

  it("allows the workspace's own Website Studio sites automatically, only while it installs the chat there", async () => {
    const site = "demo-co.iacquire.site";
    await addSiteHost(c.m.org.id, site);
    const origin = `https://${site}`;
    const ok = await embedCall(c, { action: "config", origin });
    expect(ok).toMatchObject({ status: 200, corsOrigin: origin });
    await reconfigure(c, { autoInstallSites: false });
    expect((await embedCall(c, { action: "config", origin })).status).toBe(403);
    await reconfigure(c, { autoInstallSites: true });
    // Another workspace's site host is not this workspace's: it is refused.
    await addSiteHost(other.m.org.id, "someone-else.iacquire.site");
    expect((await embedCall(c, { action: "config", origin: "https://someone-else.iacquire.site" })).status).toBe(403);
    // Chats that start there are labelled as coming from the workspace's own site.
    const t = await embedCall(c, { action: "session", origin, body: { landing: "/" } });
    const row = await rows<{ surface: string }>("select surface from web_chat_sessions where token_hash = $1", [hashOf(bodyOf<{ token: string }>(t).token)]);
    expect(row[0].surface).toBe("site");
  });
});

describe("a visitor's chat", () => {
  it("opens a session, stores the visitor's messages, and has the conversation's AI employee answer through the same reply path", async () => {
    const token = await start(c, { landing: "/roofing?utm_source=google&utm_medium=cpc&utm_campaign=spring", referrer: "https://www.google.com/" });
    const reply = answer("We repair and replace roofs. Would you like a free inspection?");
    const sent = await embedCall(c, { action: "send", token, body: { text: "Do you fix roofs?", clientMessageId: clientId() }, generate: reply.generate });
    expect(sent.status).toBe(200);
    const view = viewOf(sent);
    expect(view.messages.map((m) => m.role)).toEqual(["visitor", "assistant"]);
    expect(view.messages[1].text).toMatch(/^I'm an AI assistant for .+\. We repair and replace roofs/); // the AI says so on its first message
    expect(view.mode).toBe("assistant");
    expect(reply.calls).toHaveLength(1);
    expect(reply.calls[0]).toMatchObject({ channel: "web_chat", customerMessage: "Do you fix roofs?", allowBooking: true });

    // The chat is a real conversation of the workspace's Inbox, with its own contact.
    const conv = (await rows<{ id: string; channel: string; owner_kind: string; contact_id: string; thread_key: string }>("select id, channel, owner_kind, contact_id, thread_key from conversations where org_id = $1 and channel = 'web_chat' order by created_at desc", [c.m.org.id]))[0];
    expect(conv).toMatchObject({ channel: "web_chat", owner_kind: "ai" });
    const contact = (await rows<{ display_name: string; created_via: string; source: string }>("select display_name, created_via, source from contacts where id = $1", [conv.contact_id]))[0];
    expect(contact).toMatchObject({ display_name: "Website visitor", created_via: "website_chat", source: "Website chat" });
    // What the visit carried is on the session exactly as it arrived.
    const session = (await rows<{ landing_path: string; referrer: string; attribution: Record<string, string>; timezone: string }>("select landing_path, referrer, attribution, timezone from web_chat_sessions where conversation_id = $1", [conv.id]))[0];
    expect(session).toMatchObject({ landing_path: "/roofing", referrer: "https://www.google.com/", timezone: "Asia/Manila" });
    expect(session.attribution).toMatchObject({ utm_source: "google", utm_medium: "cpc", utm_campaign: "spring" });
  });

  it("keeps the conversation when the visitor comes back with their token, and starts fresh with a new one", async () => {
    const token = await start(c);
    await embedCall(c, { action: "send", token, body: { text: "Hello there", clientMessageId: clientId() }, generate: answer("Hi!").generate });
    const back = await embedCall(c, { action: "session", token, body: {} });
    expect(bodyOf<{ resumed: boolean; token?: string }>(back)).toMatchObject({ resumed: true, token: undefined });
    expect(viewOf(back).messages.map((m) => m.text)).toEqual(["Hello there", expect.stringMatching(/Hi!/)]);
    const fresh = await embedCall(c, { action: "session", body: {} });
    expect(bodyOf<{ resumed: boolean }>(fresh).resumed).toBe(false);
    expect(viewOf(fresh).messages).toEqual([]);
  });

  it("opens no session for a token that belongs to another workspace, and reads nothing with a wrong one", async () => {
    const mine = await start(c);
    await embedCall(c, { action: "send", token: mine, body: { text: "private question", clientMessageId: clientId() }, generate: answer("ok").generate });
    // The same token used against another workspace's widget finds nothing.
    const wrongOrg = await embedCall(other, { action: "messages", token: mine, origin: "https://www.other-site.test", key: other.widget.publicKey });
    expect(wrongOrg.status).toBe(401);
    expect((await embedCall(c, { action: "messages", token: "A".repeat(43) })).status).toBe(401);
    expect((await embedCall(c, { action: "messages", token: null })).status).toBe(401);
    expect((await embedCall(c, { action: "messages", token: "../../etc/passwd" })).status).toBe(401);
    // Starting a new chat with a foreign token does not resume anything: it opens a new session.
    const started = await embedCall(other, { action: "session", token: mine, origin: "https://www.other-site.test", key: other.widget.publicKey, body: {} });
    expect(bodyOf<{ resumed: boolean }>(started).resumed).toBe(false);
  });

  it("is safe to retry: the same client message id is stored and answered once", async () => {
    const token = await start(c);
    const reply = answer("Once only.");
    const id = clientId();
    const first = await embedCall(c, { action: "send", token, body: { text: "Are you open?", clientMessageId: id }, generate: reply.generate });
    const again = await embedCall(c, { action: "send", token, body: { text: "Are you open?", clientMessageId: id }, generate: reply.generate });
    expect(bodyOf<{ duplicate: boolean }>(first).duplicate).toBe(false);
    expect(bodyOf<{ duplicate: boolean }>(again).duplicate).toBe(true);
    expect(viewOf(again).messages.filter((m) => m.role === "visitor")).toHaveLength(1);
    expect(reply.calls).toHaveLength(1);
  });

  it("turns 'sent' into 'delivered' when the widget fetches a reply, and 'read' when it reports the window is open", async () => {
    const token = await start(c);
    await embedCall(c, { action: "send", token, body: { text: "Hi", clientMessageId: clientId() }, generate: answer("Hello!").generate });
    const outbound = async () => (await rows<{ status: string; delivered_at: Date | null }>("select m.status, m.delivered_at from conversation_messages m join conversations c on c.id = m.conversation_id join web_chat_sessions s on s.conversation_id = c.id where s.token_hash = $1 and m.direction = 'outbound'", [hashOf(token)]))[0];
    // The send response already fetched the view once, so the reply was delivered; "read" needs the window to be open.
    expect((await outbound()).status).toBe("delivered");
    await embedCall(c, { action: "messages", token, query: { seen: "1" } });
    expect((await outbound()).status).toBe("read");
  });

  it("never shows the visitor internal notes, drafts, blocked replies or anything staff wrote privately", async () => {
    const token = await start(c);
    await embedCall(c, { action: "send", token, body: { text: "Hello", clientMessageId: clientId() }, generate: answer("Hi!").generate });
    const conv = (await rows<{ id: string }>("select c.id from conversations c join web_chat_sessions s on s.conversation_id = c.id where s.token_hash = $1", [hashOf(token)]))[0].id;
    await withSystem(async (db) => {
      await db.query("insert into conversation_messages (org_id, conversation_id, direction, author_kind, body, status) values ($1, $2, 'internal', 'human', 'INTERNAL: this one is difficult', 'note')", [c.m.org.id, conv]);
      await db.query("insert into conversation_messages (org_id, conversation_id, direction, author_kind, body, status) values ($1, $2, 'outbound', 'ai', 'DRAFT waiting for approval', 'draft')", [c.m.org.id, conv]);
      await db.query("insert into conversation_messages (org_id, conversation_id, direction, author_kind, body, status, blocked_reason) values ($1, $2, 'outbound', 'ai', 'BLOCKED reply', 'blocked', 'credits')", [c.m.org.id, conv]);
    });
    const seen = JSON.stringify(viewOf(await embedCall(c, { action: "messages", token })));
    expect(seen).not.toMatch(/INTERNAL|DRAFT|BLOCKED/);
    expect(seen).toMatch(/Hello/);
  });

  it("limits how fast one session can write, how many messages it can hold and how many chats one address can start", async () => {
    const token = await start(c);
    const quick = answer("ok");
    let limited = 0;
    for (let i = 0; i < 14; i++) {
      const r = await embedCall(c, { action: "send", token, body: { text: `message ${i}`, clientMessageId: clientId() }, generate: quick.generate });
      if (r.status === 429) limited++;
    }
    expect(limited).toBeGreaterThanOrEqual(2); // 12 a minute
    const small = await chatOrg({ sessionMessageLimit: 5 });
    const t = await start(small);
    for (let i = 0; i < 5; i++) await embedCall(small, { action: "send", token: t, body: { text: `m${i}`, clientMessageId: clientId() }, generate: answer("ok").generate });
    const over = await embedCall(small, { action: "send", token: t, body: { text: "one more", clientMessageId: clientId() }, generate: answer("ok").generate });
    expect(over.status).toBe(409);
    expect(bodyOf(over).error?.code).toBe("message_limit");
    const ip = "198.51.100.7";
    let refused = 0;
    for (let i = 0; i < 14; i++) if ((await embedCall(c, { action: "session", address: ip, body: {} })).status === 429) refused++;
    expect(refused).toBeGreaterThanOrEqual(1);
    const daily = await chatOrg({ dailySessionLimit: 2 });
    await start(daily);
    await start(daily);
    const third = await embedCall(daily, { action: "session", body: {} });
    expect(third.status).toBe(503);
  });

  it("rejects empty, oversized and malformed sends without storing anything", async () => {
    const token = await start(c);
    const before = (await rows("select 1 from conversation_messages m join conversations c on c.id = m.conversation_id where c.org_id = $1 and c.channel = 'web_chat'", [c.m.org.id])).length;
    expect((await embedCall(c, { action: "send", token, body: { text: "   ", clientMessageId: clientId() } })).status).toBe(400);
    expect((await embedCall(c, { action: "send", token, body: { text: "hello", clientMessageId: "x" } })).status).toBe(400);
    expect((await embedCall(c, { action: "send", token, body: "not json object" })).status).toBe(400);
    expect((await embedCall(c, { action: "send", method: "GET", token, body: {} })).status).toBe(405);
    expect((await embedCall(c, { action: "unknown", token, body: {} })).status).toBe(404);
    const after = (await rows("select 1 from conversation_messages m join conversations c on c.id = m.conversation_id where c.org_id = $1 and c.channel = 'web_chat'", [c.m.org.id])).length;
    expect(after).toBe(before);
    // 5,000 characters are cut to the 1,000 a message may hold.
    const long = await embedCall(c, { action: "send", token, body: { text: "x".repeat(5000), clientMessageId: clientId() }, generate: answer("ok").generate });
    expect(viewOf(long).messages[0].text).toHaveLength(1000);
  });
});

describe("handing the chat to a person", () => {
  it("asks a person to join when the visitor plainly asks for one, and the AI does not answer over that", async () => {
    const token = await start(c);
    const ai = answer("should not be sent");
    const r = await embedCall(c, { action: "send", token, body: { text: "I want to talk to a real person please", clientMessageId: clientId() }, generate: ai.generate });
    expect(ai.calls).toHaveLength(0);
    const view = viewOf(r);
    expect(view.mode).toBe("waiting");
    expect(view.messages.at(-1)).toMatchObject({ role: "system" });
    expect(view.messages.at(-1)?.text).toMatch(/asked a team member to join/);
    const esc = await rows<{ category: string; status: string }>("select e.category, e.status from human_escalations e join conversations c on c.id = e.conversation_id where c.org_id = $1 and c.channel = 'web_chat' order by e.created_at desc limit 1", [c.m.org.id]);
    expect(esc[0]).toMatchObject({ category: "human_requested" });
  });

  it("lets the visitor ask for a person with the button, once", async () => {
    const token = await start(c);
    await embedCall(c, { action: "send", token, body: { text: "Hello", clientMessageId: clientId() }, generate: answer("Hi!").generate });
    const one = await embedCall(c, { action: "handoff", token });
    const two = await embedCall(c, { action: "handoff", token });
    expect(viewOf(one).mode).toBe("waiting");
    expect(viewOf(two).messages.filter((m) => m.role === "system")).toHaveLength(1);
    const noChat = await start(c);
    const early = await embedCall(c, { action: "handoff", token: noChat });
    expect(early.status).toBe(400); // nothing to hand over yet
  });

  it("shows a person's reply as the team's, stops the AI, and returns to the AI only when someone hands it back", async () => {
    const token = await start(c);
    await embedCall(c, { action: "send", token, body: { text: "Hello", clientMessageId: clientId() }, generate: answer("Hi, I'm the assistant.").generate });
    const conv = (await rows<{ id: string }>("select c.id from conversations c join web_chat_sessions s on s.conversation_id = c.id where s.token_hash = $1", [hashOf(token)]))[0].id;
    // A teammate answers from the Inbox: the conversation becomes theirs.
    const sent = await sendHumanReply(c.m.ctx("manager"), conv, "This is Mia from the team. How can I help?");
    expect(sent.status).toBe("queued");
    const ai = answer("The AI must not speak now.");
    const r = await embedCall(c, { action: "send", token, body: { text: "Great, I need a quote", clientMessageId: clientId() }, generate: ai.generate });
    expect(ai.calls).toHaveLength(0);
    const view = viewOf(r);
    expect(view.mode).toBe("team");
    expect(view.messages.map((m) => `${m.role}:${m.text}`)).toEqual([
      "visitor:Hello", expect.stringMatching(/^assistant:/), "team:This is Mia from the team. How can I help?", "visitor:Great, I need a quote",
    ]);
    expect(await rows("select 1 from conversations where id = $1 and owner_kind = 'human'", [conv])).toHaveLength(1);
  });

  it("tells the visitor plainly, and asks a person to look, when the AI cannot answer", async () => {
    const token = await start(c);
    const broken = answering(() => ({ kind: "unavailable", reason: "The AI language model is not connected." }));
    const r = await embedCall(c, { action: "send", token, body: { text: "What are your hours?", clientMessageId: clientId() }, generate: broken.generate });
    const view = viewOf(r);
    expect(view.messages.map((m) => m.role)).toEqual(["visitor", "system"]);
    expect(view.messages[1].text).toMatch(/asked a team member to follow up/);
    expect(view.messages[1].text).not.toMatch(/language model|not connected/i); // the visitor is not shown internal reasons
    const open = await rows("select e.id from human_escalations e join conversations c on c.id = e.conversation_id join web_chat_sessions s on s.conversation_id = c.id where s.token_hash = $1 and e.status in ('awaiting_owner', 'open')", [hashOf(token)]);
    expect(open).toHaveLength(1);
  });

  it("does not answer at all when the workspace has switched the website assistant off, and says a person will reply", async () => {
    const quiet = await chatOrg({ aiEnabled: false });
    const token = await start(quiet);
    const ai = answer("never");
    const r = await embedCall(quiet, { action: "send", token, body: { text: "Hello?", clientMessageId: clientId() }, generate: ai.generate });
    expect(ai.calls).toHaveLength(0);
    expect(viewOf(r).mode).toBe("waiting");
    const conv = (await rows<{ owner_kind: string }>("select owner_kind from conversations where org_id = $1 and channel = 'web_chat'", [quiet.m.org.id]))[0];
    expect(conv.owner_kind).toBe("unassigned");
    const cfg = bodyOf<{ config: { aiAvailable: boolean } }>(await embedCall(quiet, { action: "config" }));
    expect(cfg.config.aiAvailable).toBe(false);
  });
});

describe("the Inbox", () => {
  it("lists a website chat as a conversation of the workspace, and only that workspace's", async () => {
    const token = await start(c);
    await embedCall(c, { action: "send", token, body: { text: "Inbox check", clientMessageId: clientId() }, generate: answer("Seen.").generate });
    const page = await listConversationsPage(c.m.ctx("owner"), {});
    const item = page.items.find((i) => i.channel === ("web_chat" as never));
    expect(item).toBeDefined();
    expect(item).toMatchObject({ ownerKind: "ai" });
    const foreign = await listConversationsPage(other.m.ctx("owner"), {});
    expect(foreign.items.some((i) => i.id === item?.id)).toBe(false);
  });

  it("opens the thread and the CRM panel for a website chat, counts it, and filters by it", async () => {
    const token = await start(c);
    await embedCall(c, { action: "send", token, body: { text: "Thread check", clientMessageId: clientId() }, generate: answer("Answer.").generate });
    const id = (await rows<{ id: string }>("select c.id from conversations c join web_chat_sessions s on s.conversation_id = c.id where s.token_hash = $1", [hashOf(token)]))[0].id;
    const detail = await getConversationDetail(c.m.ctx("owner"), id);
    expect(detail.conversation.channel).toBe("web_chat");
    expect(detail.messages.map((m) => m.direction)).toEqual(["inbound", "outbound"]);
    const crm = await getInboxCrmContext(c.m.ctx("owner"), id);
    expect(crm.contact).toMatchObject({ name: "Website visitor", createdVia: "website_chat", source: "Website chat" });
    const counts = await inboxViewCounts(c.m.ctx("owner"));
    expect(counts.all).toBeGreaterThan(0);
    const onlyChat = await listConversationsPage(c.m.ctx("owner"), { channel: "web_chat" });
    expect(onlyChat.items.length).toBeGreaterThan(0);
    expect(onlyChat.items.every((i) => (i.channel as string) === "web_chat")).toBe(true);
    const onlySms = await listConversationsPage(c.m.ctx("owner"), { channel: "sms" });
    expect(onlySms.items.some((i) => i.id === id)).toBe(false);
  });
});

describe("a conversation on another channel is untouched", () => {
  it("still refuses to send a website chat reply as a provider message", async () => {
    const token = await start(c);
    await embedCall(c, { action: "send", token, body: { text: "Hello", clientMessageId: clientId() }, generate: answer("Hi!").generate });
    const conv = (await rows<{ id: string }>("select c.id from conversations c join web_chat_sessions s on s.conversation_id = c.id where s.token_hash = $1", [hashOf(token)]))[0].id;
    const { evaluateSend } = await import("@/server/messaging/send");
    const decision = await withSystem((db) => evaluateSend(db, { orgId: c.m.org.id, conversationId: conv, scope: "reply", actor: { kind: "system", userId: null }, body: "x" }));
    expect(decision).toMatchObject({ allow: false, reason: "channel_not_ready" });
    void ipFor;
  });
});
