// The platform-wide emergency switch for the public website chat (WEBCHAT_PUBLIC_DISABLED): what the public API answers while it is on, that it touches nothing
// while on, and that everything is back when it is cleared. The route is exercised with real Request objects, as the Next.js handler receives them.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { env, resetEnvCache } from "@/server/env";
import { withSystem } from "@/server/db";
import { chatRoute } from "@/server/webchat/route";
import { handleWebChat } from "@/server/webchat/http";
import { webchatPublicDisabled } from "@/server/webchat/switch";
import { chatHealth } from "@/server/webchat/analytics";
import { CRM_QA_ENV } from "../scripts/crm-qa-env.mjs";
import { answer, chatOrg, clientId, ORIGIN, start, viewOf, embedCall, type ChatOrg } from "./support/webchat";

const saved = process.env.WEBCHAT_PUBLIC_DISABLED;
const setSwitch = (value: string | undefined) => {
  if (value === undefined) delete process.env.WEBCHAT_PUBLIC_DISABLED;
  else process.env.WEBCHAT_PUBLIC_DISABLED = value;
  resetEnvCache();
};
afterEach(() => setSwitch(saved));

let c: ChatOrg;
beforeAll(async () => {
  c = await chatOrg();
});

const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;
const request = (action: string, init: { method?: string; body?: unknown; token?: string | null } = {}) => {
  const method = init.method ?? (action === "config" || action === "messages" ? "GET" : "POST");
  const url = `https://portal.test/api/public/webchat/${action}?k=${c.widget.publicKey}`;
  const headers: Record<string, string> = { origin: ORIGIN, "x-forwarded-for": "203.0.113.77" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  return new Request(url, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
};
const call = (action: string, init?: Parameters<typeof request>[1]) => chatRoute(request(action, init), { kind: "embed", key: c.widget.publicKey, origin: ORIGIN }, action);

describe("WEBCHAT_PUBLIC_DISABLED", () => {
  it("is off unless set to true or 1, and a value that is not a boolean is refused by name", () => {
    for (const [value, expected] of [[undefined, false], ["", false], ["false", false], ["0", false], ["true", true], ["1", true]] as const) {
      setSwitch(value);
      expect(webchatPublicDisabled(), String(value)).toBe(expected);
    }
    setSwitch("yes please");
    expect(() => env()).toThrow(/WEBCHAT_PUBLIC_DISABLED/);
  });

  it("works normally while it is off", async () => {
    setSwitch("false");
    const res = await call("config");
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  it("answers every action with the same clear 'unavailable' state while on, readable from any website so the widget can leave the page alone", async () => {
    setSwitch("true");
    for (const [action, init] of [
      ["config", {}], ["session", { body: {} }], ["messages", {}], ["send", { body: { text: "hi", clientMessageId: clientId() }, token: "A".repeat(43) }],
      ["lead", { body: { details: { email: "a@example.test" }, privacyAck: true }, token: "A".repeat(43) }], ["handoff", { body: {}, token: "A".repeat(43) }],
    ] as const) {
      const res = await call(action, init);
      expect(res.status, action).toBe(503);
      expect(res.headers.get("access-control-allow-origin"), action).toBe("*");
      expect(res.headers.get("retry-after"), action).toBe("300");
      expect(res.headers.get("cache-control"), action).toBe("no-store");
      expect(await res.json(), action).toEqual({ ok: false, error: { code: "unavailable", message: "Chat is temporarily unavailable." } });
    }
    const preflight = await call("send", { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-headers")).toMatch(/authorization/);
  });

  it("says the same to an unknown key, a forbidden origin and a real one: it reveals nothing about any workspace", async () => {
    setSwitch("true");
    const bodies = new Set<string>();
    for (const [key, origin] of [["wk_unknownunknownunknownunkn", ORIGIN], [c.widget.publicKey, "https://evil.example"], [c.widget.publicKey, ORIGIN]] as const) {
      const res = await chatRoute(new Request(`https://portal.test/api/public/webchat/config?k=${key}`, { headers: { origin } }), { kind: "embed", key, origin }, "config");
      expect(res.status).toBe(503);
      bodies.add(await res.text());
    }
    expect(bodies.size).toBe(1);
  });

  it("touches nothing while on: no widget is marked as seen, no chat session is opened", async () => {
    const fresh = await chatOrg(); // never loaded by a visitor, so "seen" would show if anything reached it
    const via = (action: string, body?: unknown) =>
      chatRoute(
        new Request(`https://portal.test/api/public/webchat/${action}?k=${fresh.widget.publicKey}`, { method: body === undefined ? "GET" : "POST", headers: { origin: ORIGIN, "x-forwarded-for": "203.0.113.78", ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) }),
        { kind: "embed", key: fresh.widget.publicKey, origin: ORIGIN },
        action,
      );
    setSwitch("true");
    expect((await via("config")).status).toBe(503);
    expect((await via("session", { landing: "/", referrer: "", timezone: "UTC" })).status).toBe(503);
    expect((await rows<{ last_seen_at: Date | null }>("select last_seen_at from web_chat_widgets where org_id = $1", [fresh.m.org.id]))[0].last_seen_at).toBeNull();
    expect(await rows("select 1 from web_chat_sessions where org_id = $1", [fresh.m.org.id])).toHaveLength(0);
    // The same requests do reach it once the switch is cleared.
    setSwitch("false");
    expect((await via("config")).status).toBe(200);
    expect((await rows<{ last_seen_at: Date | null }>("select last_seen_at from web_chat_widgets where org_id = $1", [fresh.m.org.id]))[0].last_seen_at).not.toBeNull();
    expect((await via("session", { landing: "/", referrer: "", timezone: "UTC" })).status).toBe(200);
    expect(await rows("select 1 from web_chat_sessions where org_id = $1", [fresh.m.org.id])).toHaveLength(1);
  });

  it("keeps the adapter closed too, for any other caller of it", async () => {
    setSwitch("true");
    const res = await handleWebChat({ action: "config", method: "GET", surface: { kind: "embed", key: c.widget.publicKey, origin: ORIGIN }, token: null, address: "203.0.113.5", query: new URLSearchParams(), body: {} });
    expect(res).toMatchObject({ status: 503, retryAfterSeconds: 300, body: { ok: false, error: { code: "unavailable" } } });
  });

  it("leaves chats already stored alone, and everything works again as soon as it is cleared", async () => {
    setSwitch("false");
    const token = await start(c);
    await embedCall(c, { action: "send", token, body: { text: "I need a quote", clientMessageId: clientId() }, generate: answer("Happy to help.").generate });
    const stored = (await rows("select 1 from conversation_messages m join conversations cv on cv.id = m.conversation_id where cv.org_id = $1 and cv.channel = 'web_chat'", [c.m.org.id])).length;
    setSwitch("true");
    expect((await call("messages", { token })).status).toBe(503);
    expect((await rows("select 1 from conversation_messages m join conversations cv on cv.id = m.conversation_id where cv.org_id = $1 and cv.channel = 'web_chat'", [c.m.org.id])).length).toBe(stored);
    setSwitch("false");
    const back = await call("messages", { token });
    expect(back.status).toBe(200);
    const view = ((await back.json()) as { view: ReturnType<typeof viewOf> }).view;
    expect(view.messages.map((m) => m.role)).toEqual(["visitor", "assistant"]);
  });

  it("is shown to the owner in the chat's own checks, as the reason a switched-on chat shows nothing", async () => {
    setSwitch("false");
    expect((await chatHealth(c.m.ctx("owner"))).map((h) => h.key)).not.toContain("platform");
    setSwitch("true");
    const platform = (await chatHealth(c.m.ctx("owner"))).find((h) => h.key === "platform");
    expect(platform).toMatchObject({ state: "attention", label: "The chat is paused for every workspace" });
  });

  it("still refuses a method it never served, switched or not", async () => {
    setSwitch("true");
    expect((await call("config", { method: "PUT" })).status).toBe(405);
  });
});

describe("where the two chat variables are documented and pinned", () => {
  const root = process.cwd();
  const text = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
  const valueOf = (file: string, name: string) => new RegExp(`^${name}=(.*?)\\r?$`, "m").exec(text(file))?.[1];

  it("lists both in .env.example and .env.staging.example with values the schema accepts", () => {
    for (const file of [".env.example", ".env.staging.example"]) {
      expect(valueOf(file, "WEBCHAT_PUBLIC_DISABLED"), file).toBe("false");
      expect(valueOf(file, "WEBCHAT_DAILY_AI_REPLIES"), file).toBe("500");
    }
  });

  it("pins both in the browser QA environment, so a stray value in the shell cannot change what a run looks at", () => {
    expect(CRM_QA_ENV.WEBCHAT_PUBLIC_DISABLED).toBe("false");
    expect(CRM_QA_ENV.WEBCHAT_DAILY_AI_REPLIES).toBe("");
    expect({ WEBCHAT_PUBLIC_DISABLED: "true", ...CRM_QA_ENV }.WEBCHAT_PUBLIC_DISABLED).toBe("false");
  });
});
