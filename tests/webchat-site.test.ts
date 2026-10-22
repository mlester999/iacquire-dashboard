// Website Studio sites and the chat: how a published site learns that the chat is installed, what the site's own policy lets the page do, and the fact that
// the site runtime reaches nothing but one narrow function. The chat itself is served by the portal (see tests/webchat-service.test.ts).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSiteRuntime, withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { saveOnboardingStep } from "@/server/onboarding/service";
import { siteContentSecurityPolicy } from "@/lib/site-routing";
import { chatScriptSrc, clearSiteChatCache, siteChatKey } from "@/server/sites/chat";
import { clearSiteCache } from "@/server/sites/runtime";
import { createWebsite, publishWebsite } from "@/server/websites/service";
import { ensureWidget, saveWidgetSettings } from "@/server/webchat/config";
import { addMember, createOrg, createUser, ctxFor } from "./support/fixtures";

const HOST = "chat-co.sites.test.example";
let org: Awaited<ReturnType<typeof createOrg>>;
let owner: { id: string; email: string };
const as = () => ctxFor(owner, org, "owner");

beforeAll(async () => {
  process.env.SITES_PROBE_ORIGIN = "http://127.0.0.1:9";
  process.env.SITES_BASE_DOMAIN = "sites.test.example";
  resetEnvCache();
  org = await createOrg({ name: "Chat Co" });
  owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  await saveOnboardingStep(as(), {
    answers: {
      "a.business_name": { value: "Chat Co" }, "a.industry": { value: "other" }, "a.description": { value: "We answer questions." }, "a.contact_email": { value: "hi@chat.test" },
      "b.services": { value: "Consulting, Support" },
    },
  });
  await createWebsite(as(), { templateKey: "corp.summit" });
  const live = async () => (await withSystem((db) => db.query<{ id: string }>("select published_publication_id as id from websites where org_id = $1", [org.id]))).rows[0].id;
  await publishWebsite(as(), { acknowledgeClaims: true }, { probe: async () => ({ status: 200, body: `<i data-site-publication="${await live()}"></i>` }) });
  await withSystem((db) => db.query("update website_domains set hostname = $2 where org_id = $1 and kind = 'platform'", [org.id, HOST]));
  clearSiteCache();
  clearSiteChatCache();
});
afterAll(() => {
  delete process.env.SITES_PROBE_ORIGIN;
  delete process.env.SITES_BASE_DOMAIN;
  resetEnvCache();
});

describe("a published site and the chat", () => {
  it("shows no chat until the workspace has switched it on and chosen to install it on its own sites", async () => {
    expect(await siteChatKey(HOST)).toBeNull(); // no widget exists yet
    const w = await withSystem((db) => ensureWidget(db, org.id));
    clearSiteChatCache();
    expect(await siteChatKey(HOST)).toBeNull(); // created off
    const on = await saveWidgetSettings(as(), { enabled: true, autoInstallSites: true }, w.version);
    clearSiteChatCache();
    expect(await siteChatKey(HOST)).toBe(on.publicKey);
    const off = await saveWidgetSettings(as(), { autoInstallSites: false }, on.version);
    clearSiteChatCache();
    expect(await siteChatKey(HOST)).toBeNull(); // the owner may run the chat on other sites only
    const back = await saveWidgetSettings(as(), { autoInstallSites: true, enabled: false }, off.version);
    clearSiteChatCache();
    expect(await siteChatKey(HOST)).toBeNull(); // switched off wins
    await saveWidgetSettings(as(), { enabled: true }, back.version);
    clearSiteChatCache();
    expect(await siteChatKey(HOST)).not.toBeNull();
  });

  it("gives an unknown or unpublished host nothing, and gives the site runtime nothing but the key", async () => {
    clearSiteChatCache();
    expect(await siteChatKey("nobody.sites.test.example")).toBeNull();
    // The runtime role may call the one function and see exactly one column...
    const viaFunction = await withSiteRuntime((db) => db.query<{ public_key: string }>("select * from app.site_chat_widget($1)", [HOST]));
    expect(Object.keys(viaFunction.rows[0])).toEqual(["public_key"]);
    // ...and it cannot read the widget's table or anything about visitors.
    await expect(withSiteRuntime((db) => db.query("select * from web_chat_widgets"))).rejects.toThrow(/permission denied/i);
    await expect(withSiteRuntime((db) => db.query("select * from web_chat_sessions"))).rejects.toThrow(/permission denied/i);
    await expect(withSiteRuntime((db) => db.query("select * from conversations"))).rejects.toThrow(/permission denied/i);
  });

  it("points the script at the portal, and only when the portal's address is known", () => {
    const before = process.env.APP_URL;
    process.env.APP_URL = "https://www.iacquire.online/some/path";
    expect(chatScriptSrc()).toBe("https://www.iacquire.online/widget/chat.js");
    process.env.APP_URL = "not a url";
    expect(chatScriptSrc()).toBeNull();
    delete process.env.APP_URL;
    expect(chatScriptSrc()).toBeNull();
    if (before !== undefined) process.env.APP_URL = before;
  });
});

describe("what a published site's own policy allows", () => {
  const nonce = "abc123";

  it("opens exactly one more address to the page, the portal's, and only for connections", () => {
    const withChat = siteContentSecurityPolicy(nonce, false, "https://www.iacquire.online");
    const without = siteContentSecurityPolicy(nonce, false);
    expect(withChat).toContain("connect-src 'self' https://www.iacquire.online;");
    expect(without).toContain("connect-src 'self';");
    // Nothing else moves: still no third-party scripts, styles or frames, and forms only post back to the site.
    for (const directive of ["default-src 'none'", `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`, "style-src 'self'", "frame-ancestors 'none'", "form-action 'self'", "object-src 'none'", "base-uri 'none'"]) {
      expect(withChat).toContain(directive);
    }
    expect(withChat.replace(" https://www.iacquire.online", "")).toBe(without);
  });

  it("accepts only a plain http(s) origin", () => {
    for (const bad of ["javascript:alert(1)", "https://evil.example/path", "https://a.example; script-src *", "data:text/html,x", "", null, undefined, "ftp://x.example", "https://x.example:99999999"]) {
      expect(siteContentSecurityPolicy(nonce, false, bad as string), String(bad)).toBe(siteContentSecurityPolicy(nonce, false));
    }
    expect(siteContentSecurityPolicy(nonce, true, "http://localhost:3100")).toContain("connect-src 'self' http://localhost:3100 ws: wss:;");
  });
});
