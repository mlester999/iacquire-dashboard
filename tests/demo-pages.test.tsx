// The demo's pages, rendered through the real page functions against embedded Postgres: what a prospect is shown at /demo, /demo/verify and /demo/room, and what the agency is shown at
// /admin/prospects. Nothing is hand-written: each page reads the real services, so a page can never say a state the database does not hold. Static markup only (the browser
// behaviours, and the layout at 375 and 1280 px, are for the lead's pass). The language model is a switch the test flips; nothing is asked.
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/server/auth/service";

const state = vi.hoisted(() => ({ cookie: null as string | null, ip: "10.99.0.1", user: null as null | SessionUser, model: { ready: false } as { ready: boolean } }));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "iaq_demo" && state.cookie ? { name, value: state.cookie } : undefined) }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  useRouter: () => ({ push: () => undefined, refresh: () => undefined, back: () => undefined }),
  usePathname: () => "/admin/prospects",
}));
vi.mock("next/link", async () => {
  const React = await import("react");
  const Link = React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }>(function Link({ href, ...props }, ref) {
    return <a {...props} href={href} ref={ref} />;
  });
  return { default: Link };
});
vi.mock("sonner", () => ({ toast: { success: () => undefined, error: () => undefined } }));
vi.mock("@/app/actions/demo-admin", () => new Proxy({}, { get: () => async () => ({ ok: true, data: true }) }));
vi.mock("@/server/auth/session", async (original) => ({ ...(await original<typeof import("@/server/auth/session")>()), requestMeta: async () => ({ ip: state.ip, userAgent: "vitest" }) }));
vi.mock("@/server/demo/generator", async (original) => ({ ...(await original<typeof import("@/server/demo/generator")>()), demoModelState: async () => state.model }));
vi.mock("@/server/tenancy/context", async (original) => {
  const actual = await original<typeof import("@/server/tenancy/context")>();
  return {
    ...actual,
    requireAgency: async () => {
      if (!state.user || state.user.platformRole === "none") throw new Error("REDIRECT:/overview");
      return state.user;
    },
  };
});

import DemoPage from "@/app/demo/page";
import VerifyPage from "@/app/demo/verify/page";
import DemoRoomPage from "@/app/demo/room/page";
import ProspectsPage from "@/app/(admin)/admin/prospects/page";
import ProspectPage from "@/app/(admin)/admin/prospects/[id]/page";
import DemoSettingsPage from "@/app/(admin)/admin/prospects/settings/page";
import { MAINTENANCE_MONTHLY_USD, SETUP_FEE_USD } from "@/lib/billing";
import { CTA_COPY, HOLD_COPY, PRIVACY_EMAIL, ROOM_COPY } from "@/lib/demo/outcomes";
import { FIELD_COPY, LINK_SENT_COPY, PUBLIC_COPY } from "@/lib/demo/copy";
import { REFUSAL_COPY } from "@/lib/demo/rules";
import { demoNotice } from "@/lib/demo/notice";
import { AGENT_ROLES } from "@/lib/agents";
import { JOURNEY, VIEWS, VIEW_IDS } from "@/lib/demo/showroom/content";
import { addNote, assignOwner, blockProspect, eraseProspect, extendDemo } from "@/server/demo/admin";
import { recordCta, registerProspect } from "@/server/demo/public";
import { count, demoEnv, formInput, hashOf, ipFor, linkTokenFor, messagePace, openDemo, rows, say, startDemo, team, type Team } from "./support/demo";

const BAD = /undefined|NaN|\[object Object\]|>null<|\bnull\b/;
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ");
const q = (o: Record<string, string> = {}) => Promise.resolve(o);
const forms = (markup: string) => [...markup.matchAll(/<form\b[^>]*>/g)].map((m) => m[0]);
/** The opening tags of one kind of element that carry an attribute with this value. React writes attributes in no order a test should rely on. */
const withAttr = (markup: string, name: string, attr: string, value: string) =>
  [...markup.matchAll(new RegExp(`<${name}\\b[^>]*>`, "g"))].map((m) => m[0]).filter((tag) => new RegExp(`\\s${attr}="${value}"`).test(tag));
const buttons = (markup: string) => [...markup.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) => text(m[1]).trim());
const actionsOf = (markup: string) => forms(markup).map((f) => /action="([^"]*)"/.exec(f)?.[1] ?? "");
const NOW = () => new Date();

let people: Team;
const CONSULT = "https://cal.example.test/iacquire-intro";

async function demoPage(query: Record<string, string> = {}) {
  state.ip = ipFor();
  return html(await DemoPage({ searchParams: q(query) }));
}
async function roomPage(query: Record<string, string> = {}) {
  state.ip = ipFor();
  return html(await DemoRoomPage({ searchParams: q(query) }));
}
async function verifyPage(query: Record<string, string> = {}) {
  state.ip = ipFor();
  return html(await VerifyPage({ searchParams: q(query) }));
}
const redirectOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (e) {
    return (e as Error).message;
  }
  return null;
};

beforeAll(async () => {
  demoEnv();
  messagePace("relaxed");
  people = await team();
  await openDemo(people.superAdmin, { aiEnabled: true, messageLimit: 10, windowHours: 24, dailyStartCap: 10_000, dailyMessageCap: 10_000, consultationUrl: CONSULT });
});
afterEach(() => {
  demoEnv();
  state.cookie = null;
  state.user = null;
  state.model = { ready: false };
});
afterAll(() => messagePace("real"));

// ---------------------------------------------------------------------------
// /demo
// ---------------------------------------------------------------------------

describe("/demo, where a prospect asks", () => {
  it("shows the form for what the settings say, with every field labelled and nothing that tells who has asked before", async () => {
    state.model = { ready: true };
    const markup = await demoPage({ utm_source: "spring-newsletter", utm_campaign: "x".repeat(300), unknown: "ignored" });
    const t = text(markup);
    expect(t).not.toMatch(BAD);
    expect((markup.match(/<h1\b/g) ?? []).length).toBe(1);
    expect(t).toContain("See your AI team at work");
    expect(t).toContain("Up to 10 questions to ask the AI team");
    expect(t).toContain("stays open for 24 hours");
    // The form, native and scriptless: a post to the demo API.
    expect(markup).toMatch(/<form[^>]*method="post"[^>]*action="\/api\/public\/demo\/start"|<form[^>]*action="\/api\/public\/demo\/start"[^>]*method="post"/);
    for (const [id, label] of [["demo-name", "Your name"], ["demo-email", "Work email"], ["demo-business", "Business name"], ["demo-industry", "Industry"]]) {
      expect(markup, id).toMatch(new RegExp(`<label[^>]*for="${id}"[^>]*>${label}</label>`));
    }
    expect(withAttr(markup, "input", "id", "demo-email")[0]).toContain('type="email"');
    expect(withAttr(markup, "input", "id", "demo-email")[0]).toContain('autoComplete="email"');
    // The consent box is required and the marketing box is never pre-ticked.
    const notice = demoNotice(90);
    expect(t).toContain(notice.consent);
    expect(withAttr(markup, "input", "name", "consent")[0]).toContain("required");
    expect(withAttr(markup, "input", "name", "consent")[0]).toContain('type="checkbox"');
    expect(withAttr(markup, "input", "name", "marketingOptIn")[0]).not.toContain("checked");
    expect(withAttr(markup, "input", "name", "marketingOptIn")[0]).not.toContain("required");
    for (const line of notice.details) expect(t).toContain(line);
    // Campaign tags are carried as hidden fields (cleaned), and nothing else from the address is.
    expect(markup).toContain('name="utm_source"');
    expect(markup).toContain('value="spring-newsletter"');
    expect(markup).not.toContain('name="unknown"');
    expect(markup).not.toContain("x".repeat(300));
    // The trap field is hidden from people and from assistive technology.
    expect(markup).toMatch(/<div[^>]*aria-hidden="true"[^>]*><label>Company website<input/);
    expect(withAttr(markup, "input", "name", "company_website")[0]).toContain('tabindex="-1"');
    expect(withAttr(markup, "input", "name", "company_website")[0]).toContain('autoComplete="off"');
    // The way back for someone who already started.
    expect(markup).toContain('action="/api/public/demo/return-link"');
    expect(markup).toMatch(/<label[^>]*for="return-email"/);
  });

  it("offers every industry the questionnaire offers, and no other", async () => {
    const markup = await demoPage();
    const { INDUSTRY_OPTIONS } = await import("@/lib/onboarding/definitions");
    const offered = [...markup.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]).filter(Boolean);
    expect(offered).toEqual(INDUSTRY_OPTIONS.map((o) => o.value));
  });

  it("says the AI chat is not open, and what is offered instead, when no model is connected", async () => {
    state.model = { ready: false };
    const t = text(await demoPage());
    expect(t).toContain("The AI chat is not open right now, so the guided tour is what you will see.");
    expect(t).not.toContain("questions to ask the AI team");
  });

  it("says the AI chat is not open when the Super Admin has it switched off, even if a model is connected", async () => {
    state.model = { ready: true };
    await openDemo(people.superAdmin, { aiEnabled: false });
    try {
      expect(text(await demoPage())).toContain("The AI chat is not open right now");
    } finally {
      await openDemo(people.superAdmin, { aiEnabled: true });
    }
  });

  it("shows today's places are taken, and no request form, when the day is full", async () => {
    await openDemo(people.superAdmin, { dailyStartCap: 0 });
    try {
      const markup = await demoPage();
      expect(text(markup)).toContain(PUBLIC_COPY.daily_cap);
      expect(actionsOf(markup)).toEqual(["/api/public/demo/return-link"]);
      expect(markup).not.toContain('name="consent"');
    } finally {
      await openDemo(people.superAdmin, { dailyStartCap: 10_000 });
    }
  });

  it("shows no form and says so when the deployment does not allow the demo, when the Super Admin has it off, and under the emergency stop", async () => {
    demoEnv({ DEMO_ENABLED: "false" });
    let markup = await demoPage();
    expect(text(markup)).toContain("The demo is not open");
    expect(forms(markup)).toEqual([]);
    demoEnv({ DEMO_PUBLIC_DISABLED: "true" });
    markup = await demoPage();
    expect(text(markup)).toContain(PUBLIC_COPY.unavailable);
    expect(forms(markup)).toEqual([]);
    demoEnv();
    await openDemo(people.superAdmin, { enabled: false });
    try {
      markup = await demoPage();
      expect(text(markup)).toContain("The demo is not open");
      expect(forms(markup)).toEqual([]);
    } finally {
      await openDemo(people.superAdmin, { enabled: true });
    }
  });

  it("shows how the last form went from one word, only for words it knows, and the failed fields beside their inputs", async () => {
    expect(text(await demoPage({ r: "sent" }))).toContain(LINK_SENT_COPY);
    expect(text(await demoPage({ r: "<script>alert(1)</script>" }))).not.toContain("alert(1)");
    expect(text(await demoPage({ r: "constructor" }))).not.toMatch(/function Object/);
    const bad = await demoPage({ r: "invalid", f: "name.email.consent.__proto__" });
    expect(bad).toContain('role="alert"');
    for (const f of [FIELD_COPY.name, FIELD_COPY.email, FIELD_COPY.consent]) expect(text(bad)).toContain(f);
    expect(text(bad)).not.toContain(FIELD_COPY.business);
    expect(withAttr(bad, "input", "id", "demo-name")[0]).toContain('aria-invalid="true"');
    expect(withAttr(bad, "input", "id", "demo-business")[0]).not.toContain("aria-invalid");
    expect(text(await demoPage({ r: "left" }))).toContain("You have left the demo on this device");
  });

  it("does not claim the session ended unless this browser really has no session, and offers a way back only if it has one", async () => {
    expect(text(await demoPage({ r: "no_session" }))).toContain(PUBLIC_COPY.no_session);
    const s = await startDemo();
    state.cookie = s.sessionToken;
    const markup = await demoPage({ r: "no_session" });
    expect(text(markup)).not.toContain(PUBLIC_COPY.no_session);
    expect(text(markup)).toContain("You already have a demo open in this browser");
    expect(markup).toContain('href="/demo/room"');
    state.cookie = "z".repeat(43);
    expect(text(await demoPage())).not.toContain("You already have a demo open");
  });
});

// ---------------------------------------------------------------------------
// /demo/verify
// ---------------------------------------------------------------------------

describe("/demo/verify, the page an emailed link opens", () => {
  async function linkFor(over = {}) {
    const input = formInput(over);
    const r = await registerProspect(input, { ip: ipFor() });
    expect(r.ok).toBe(true);
    return { token: (await linkTokenFor(String(input.email).trim().toLowerCase())) as string, email: String(input.email).trim().toLowerCase() };
  }

  it("shows a button and changes nothing, however often it is opened, so a mail scanner cannot use the link up", async () => {
    const { token, email } = await linkFor();
    const consumed = () => count("demo_verifications", "token_hash = $1 and consumed_at is not null", [hashOf(token)]);
    const before = { sessions: await count("demo_sessions"), prospect: (await rows("select status, verified_at from demo_prospects where email_normalized = $1", [email]))[0] };
    for (let i = 0; i < 3; i += 1) {
      const markup = await verifyPage({ token });
      expect(text(markup)).toContain("Press the button to confirm your email address and open your demo");
      expect(text(markup)).toContain("Your demo window starts when you press it");
    }
    expect(await consumed()).toBe(0);
    expect(await count("demo_sessions")).toBe(before.sessions);
    expect((await rows("select status, verified_at from demo_prospects where email_normalized = $1", [email]))[0]).toEqual(before.prospect);
  });

  it("puts the link in a hidden field of a post, nowhere else on the page: not in an address, a link or a visible word", async () => {
    const { token } = await linkFor();
    const markup = await verifyPage({ token });
    expect(forms(markup)).toHaveLength(1);
    expect(markup).toMatch(/<form[^>]*method="post"[^>]*action="\/api\/public\/demo\/verify"|<form[^>]*action="\/api\/public\/demo\/verify"[^>]*method="post"/);
    expect(markup).toMatch(new RegExp(`<input type="hidden" name="token" value="${token}"`));
    expect(markup.split(token)).toHaveLength(2);
    expect(text(markup)).not.toContain(token);
    expect(markup).not.toMatch(/href="[^"]*token/);
    expect((markup.match(/<h1\b/g) ?? []).length).toBe(1);
  });

  it("welcomes someone coming back with their words, not the first-time words", async () => {
    const s = await startDemo();
    await registerProspect({ ...formInput(), email: s.email, name: "Pat Prospect" }, { ip: ipFor() });
    const back = (await linkTokenFor(s.email)) as string;
    const markup = await verifyPage({ token: back });
    expect(text(markup)).toContain("Welcome back");
    expect(text(markup)).toContain("Your conversation and your remaining messages are kept");
    expect(text(markup)).toContain("Continue my demo");
  });

  it("says why a link cannot be used, shows no button, and prints none of the link", async () => {
    const used = await startDemo();
    for (const [token, sentence] of [[used.token, PUBLIC_COPY.link_used], ["A".repeat(43), PUBLIC_COPY.link_invalid]] as const) {
      const markup = await verifyPage({ token });
      expect(text(markup), token.slice(0, 6)).toContain(sentence);
      expect(forms(markup)).toEqual([]);
      expect(markup.includes(token)).toBe(false);
      expect(markup).toContain('href="/demo"');
    }
    const expired = await linkFor();
    await rows("update demo_verifications set expires_at = now() - interval '1 minute' where token_hash = $1", [hashOf(expired.token)]);
    expect(text(await verifyPage({ token: expired.token }))).toContain(PUBLIC_COPY.link_expired);
  });

  it("treats a missing or wrongly shaped link as not valid without looking anything up", async () => {
    const before = await count("demo_verifications");
    const queries: Record<string, string>[] = [{}, { token: "short" }, { token: "<script>" }, { token: "x".repeat(5000) }];
    for (const q2 of queries) {
      const markup = await verifyPage(q2);
      expect(text(markup)).toContain("That link is not valid");
      expect(forms(markup)).toEqual([]);
    }
    expect(await count("demo_verifications")).toBe(before);
  });

  it("after a press that failed, says why from a known word and tells the person whether the same link still works", async () => {
    const full = text(await verifyPage({ e: "daily_cap" }));
    expect(full).toContain(PUBLIC_COPY.daily_cap);
    expect(full).toContain("Your link has not been used up. Open it from your email again to try once more.");
    const used = text(await verifyPage({ e: "link_used" }));
    expect(used).toContain(PUBLIC_COPY.link_used);
    expect(used).not.toContain("has not been used up");
    expect(text(await verifyPage({ e: "<img src=x>" }))).not.toContain("<img");
  });
});

// ---------------------------------------------------------------------------
// /demo/room
// ---------------------------------------------------------------------------

describe("/demo/room, the prospect's own demo", () => {
  it("sends a browser with no session, a wrong one, or an ended one to the request page", async () => {
    expect(await redirectOf(() => roomPage())).toBe("REDIRECT:/demo?r=no_session");
    state.cookie = "q".repeat(43);
    expect(await redirectOf(() => roomPage())).toBe("REDIRECT:/demo?r=no_session");
    const s = await startDemo();
    state.cookie = s.sessionToken;
    expect(await redirectOf(() => roomPage())).toBeNull();
    await rows("update demo_sessions set revoked_at = now() where token_hash = $1", [hashOf(s.sessionToken)]);
    expect(await redirectOf(() => roomPage())).toBe("REDIRECT:/demo?r=no_session");
  });

  it("opens on a headline about the prospect's own business, with the window, the messages, the six employees, the four steps and the two requests, and the AI guide when a model is connected", async () => {
    state.model = { ready: true };
    const s = await startDemo({ name: "Rosalind Roomy", business: "Roomy Rentals", industry: "home_services" });
    state.cookie = s.sessionToken;
    const markup = await roomPage();
    const t = text(markup);
    expect(t).not.toMatch(BAD);
    expect((markup.match(/<h1\b/g) ?? []).length).toBe(1);
    expect(t).toContain("Welcome, Rosalind");
    expect(t).toMatch(/Meet the AI team that could help run Roomy Rentals ?\./);
    expect(t).toContain(ROOM_COPY.sampleBanner);
    expect(t).toMatch(/Your demo is open until .* UTC ?\./);
    expect(t).toContain("You have 10 of 10 messages left.");
    expect(t).toContain("Explore your AI team");
    expect(t).toContain("Explore freely");
    // The six employees, the four steps of the tour, and every area a visitor can open.
    for (const role of AGENT_ROLES) expect(t, role.shortName).toContain(role.shortName);
    expect((markup.match(/aria-label="Open [A-Za-z ]+"/g) ?? []).length).toBe(6);
    for (const j of JOURNEY) expect(t, j.title).toContain(j.title);
    for (const v of VIEWS) expect(t, v.label).toContain(v.label);
    // The AI guide.
    expect(t).toContain("Your AI guide");
    expect(t).toContain(ROOM_COPY.chatIntro);
    expect(markup).toMatch(/<label[^>]*for="demo-message"/);
    expect(markup).toMatch(/<label[^>]*for="demo-employee"/);
    expect(markup).toContain('role="log"');
    expect(markup).toMatch(/aria-label="Conversation"/);
    // The two requests say what they do before they are pressed.
    expect(t).toContain(ROOM_COPY.consultationButton);
    expect(t).toContain(ROOM_COPY.consultationNote);
    expect(t).toContain(ROOM_COPY.buyButton);
    expect(t).toContain(ROOM_COPY.buyNote);
    expect(t).toContain(ROOM_COPY.erasure);
    expect(t).toContain(PRIVACY_EMAIL);
  });

  it("states the published prices and the plan on the pricing view, from the one place they live, with the monthly plan optional", async () => {
    state.model = { ready: true };
    const s = await startDemo();
    state.cookie = s.sessionToken;
    const markup = await roomPage({ view: "pricing" });
    const t = text(markup);
    expect(t).not.toMatch(BAD);
    expect((markup.match(/<h1\b/g) ?? []).length).toBe(1);
    expect(t).toContain(`$${SETUP_FEE_USD.toLocaleString("en-US")}`);
    expect(t).toContain(`$${MAINTENANCE_MONTHLY_USD}`);
    expect(t).toContain("Starting at");
    expect(t).toContain("paid once");
    expect(t).toContain("a month, only if you choose it");
    expect(t).toContain(ROOM_COPY.planNote);
    expect(t).toContain("No mandatory subscription");
    expect(t).toContain("Core + Managed Maintenance");
    expect(t).toContain("Automation Studio");
    expect(t).toContain("Usage-based costs");
  });

  it("opens each view named in the address, falls back to the overview for any other word, and keeps every view free of the prospect's address, ids and credentials", async () => {
    state.model = { ready: true };
    const s = await startDemo({ name: "Rosalind Roomy", business: "Roomy Rentals" });
    state.cookie = s.sessionToken;
    const id = (await rows<{ id: string }>("select id from demo_prospects where email_normalized = $1", [s.email]))[0].id;
    for (const view of VIEW_IDS) {
      const markup = await roomPage({ view });
      expect((markup.match(/<h1\b/g) ?? []).length, view).toBe(1);
      expect(text(markup), view).not.toMatch(BAD);
      for (const secret of [s.email, id, s.sessionToken, s.token, s.ip]) expect(markup, `${view} ${secret.slice(0, 8)}`).not.toContain(secret);
    }
    expect(text(await roomPage({ view: "workforce" }))).toContain("Six AI Employees. One job each.");
    expect(text(await roomPage({ view: "nonsense" }))).toMatch(/Meet the AI team that could help run Roomy Rentals ?\./);
    expect(text(await roomPage({ view: "<script>" }))).not.toContain("<script>");
  });

  it("posts only to the demo's own endpoints, each form with a method, and carries no address, id or credential of the prospect", async () => {
    state.model = { ready: true };
    const s = await startDemo({ name: "Rosalind Roomy" });
    state.cookie = s.sessionToken;
    const markup = await roomPage();
    expect([...new Set(actionsOf(markup))].sort()).toEqual(["/api/public/demo/cta", "/api/public/demo/leave", "/api/public/demo/message"]);
    for (const f of forms(markup)) expect(f).toMatch(/method="post"/);
    // The only thing a request form carries is which request it is.
    const kinds = [...markup.matchAll(/<input[^>]*name="kind"[^>]*>/g)].map((m) => /value="([^"]*)"/.exec(m[0])?.[1]);
    expect(kinds.length).toBeGreaterThan(0);
    for (const k of kinds) expect(["consultation", "buy"]).toContain(k);
    const id = (await rows<{ id: string }>("select id from demo_prospects where email_normalized = $1", [s.email]))[0].id;
    for (const secret of [s.email, id, s.sessionToken, s.token, s.ip]) expect(markup, secret.slice(0, 8)).not.toContain(secret);
    // The idempotency key of a form without scripts is already in it.
    expect(markup).toMatch(/name="clientMessageId" value="[0-9a-f-]{36}"/);
  });

  it("says the AI chat is not open when there is no model, keeps the tour, and has no chat form", async () => {
    state.model = { ready: false };
    const s = await startDemo();
    state.cookie = s.sessionToken;
    const markup = await roomPage();
    const t = text(markup);
    expect(t).toContain(ROOM_COPY.chatOffHeading);
    expect(t).toContain(REFUSAL_COPY.ai_off);
    expect(markup).not.toContain('name="clientMessageId"');
    expect(markup).not.toContain("demo-message");
    expect((markup.match(/aria-label="Open [A-Za-z ]+"/g) ?? []).length).toBe(6);
    expect(t).toContain("Explore your AI team");
    expect(t).not.toContain("messages left");
    expect(actionsOf(markup)).not.toContain("/api/public/demo/message");
    // Without the chat, the page still offers a person.
    expect(t).toContain(ROOM_COPY.consultationButton);
  });

  it("says the AI chat is not open when the Super Admin switched it off, whatever the model", async () => {
    state.model = { ready: true };
    const s = await startDemo();
    state.cookie = s.sessionToken;
    await openDemo(people.superAdmin, { aiEnabled: false });
    try {
      const markup = await roomPage();
      expect(text(markup)).toContain(ROOM_COPY.chatOffHeading);
      expect(markup).not.toContain("demo-message");
    } finally {
      await openDemo(people.superAdmin, { aiEnabled: true });
    }
  });

  it("keeps the conversation readable after the window ended, says it ended, offers no way to send, and keeps the sales views open", async () => {
    state.model = { ready: true };
    const longAgo = new Date(Date.now() - 25 * 3_600_000);
    const s = await startDemo({}, longAgo);
    await say(s, "What does the Lead Hunter do?", { at: new Date(longAgo.getTime() + 60_000) });
    state.cookie = s.sessionToken;
    const markup = await roomPage();
    const t = text(markup);
    expect(t).toContain("Interactive window ended");
    expect(t).toContain(REFUSAL_COPY.window_ended);
    expect(t).toMatch(/Ended .* UTC/);
    expect(t).toContain("What does the Lead Hunter do?");
    expect(t).toContain("Answer to: What does the Lead Hunter do?");
    expect(markup).not.toContain("demo-message");
    expect(t).not.toContain("Your demo is open until");
    // Asking to talk to a person is still offered, and the pricing and the case for iAcquireOS are still there to read.
    expect(t).toContain(ROOM_COPY.consultationButton);
    expect(text(await roomPage({ view: "pricing" }))).toContain(`$${SETUP_FEE_USD.toLocaleString("en-US")}`);
    expect(text(await roomPage({ view: "why" }))).toContain("Why iAcquireOS?");
  });

  it("says all the messages are used, and offers a consultation, when none are left", async () => {
    state.model = { ready: true };
    const s = await startDemo({}, NOW());
    for (let i = 0; i < 10; i += 1) await say(s, `Question ${i + 1}`);
    state.cookie = s.sessionToken;
    const markup = await roomPage();
    const t = text(markup);
    expect(t).toContain(REFUSAL_COPY.limit_reached);
    expect(t).toContain("You have 0 of 10 messages left.");
    expect(markup).not.toContain("demo-message");
    expect(t).toContain(ROOM_COPY.consultationButton);
  });

  it("shows a prospect's own words as text, never as markup", async () => {
    state.model = { ready: true };
    const s = await startDemo({ name: "<b>Bold</b> Bob", business: '<img src=x onerror="alert(1)"> Roofing' });
    await say(s, "<script>alert('hi')</script> & <b>what</b> does it do?");
    state.cookie = s.sessionToken;
    const markup = await roomPage();
    expect(markup).not.toContain("<script>alert");
    expect(markup).not.toContain("<img src=x");
    expect(markup).not.toContain("<b>Bold");
    expect(markup).not.toContain("<b>what");
    expect(markup).toContain("&lt;");
    // Shown as typed (text() turns the escaped characters back), not as a tag.
    expect(text(markup)).toContain("<b>what</b> does it do?");
  });

  it("shows a word in the address only where the record agrees: a stranger's link cannot make the room claim a state", async () => {
    state.model = { ready: true };
    const s = await startDemo();
    state.cookie = s.sessionToken;
    for (const [query, sentence] of [[{ m: "limit_reached" }, REFUSAL_COPY.limit_reached], [{ m: "window_ended" }, REFUSAL_COPY.window_ended], [{ m: "ai_off" }, REFUSAL_COPY.ai_off], [{ c: "buy" }, CTA_COPY.buy], [{ c: "consultation" }, CTA_COPY.consultation]] as const) {
      expect(text(await roomPage({ ...query })), JSON.stringify(query)).not.toContain(sentence);
    }
    // A word about a message that was given back names no state and is shown as it is.
    expect(text(await roomPage({ m: "held_reply_blocked" }))).toContain(HOLD_COPY.reply_blocked);
    expect(text(await roomPage({ m: "<script>" }))).not.toContain("<script>");
    // The same words, once the record says so.
    await recordCta("buy", { sessionToken: s.sessionToken, ip: ipFor() });
    expect(text(await roomPage({ c: "buy" }))).toContain(CTA_COPY.buy);
  });

  it("shows what was asked for after a call to action, with the scheduling link only for a real https address, and says plainly when there is none", async () => {
    state.model = { ready: true };
    const s = await startDemo();
    state.cookie = s.sessionToken;
    await recordCta("consultation", { sessionToken: s.sessionToken, ip: ipFor() });
    const markup = await roomPage({ c: "consultation" });
    expect(text(markup)).toContain(CTA_COPY.consultation);
    expect(markup).toMatch(new RegExp(`<a[^>]*href="${CONSULT.replace(/[.]/g, "\\.")}"[^>]*rel="noopener noreferrer"|<a[^>]*rel="noopener noreferrer"[^>]*href="${CONSULT.replace(/[.]/g, "\\.")}"`));
    expect(markup).toContain('target="_blank"');
    // The consultation button is gone once it was pressed, and the buy button is still there.
    expect(actionsOf(markup).filter((a) => a === "/api/public/demo/cta")).toHaveLength(1);
    await openDemo(people.superAdmin, { consultationUrl: null });
    try {
      expect(text(await roomPage())).toContain(ROOM_COPY.consultationNoLink);
    } finally {
      await openDemo(people.superAdmin, { consultationUrl: CONSULT });
    }
  });

  it("says plainly that nothing is charged and no checkout exists after Buy now was pressed", async () => {
    const s = await startDemo();
    state.cookie = s.sessionToken;
    await recordCta("buy", { sessionToken: s.sessionToken, ip: ipFor() });
    const t = text(await roomPage({ c: "buy" }));
    expect(t).toContain("Online checkout is not open yet, so nothing was charged.");
    expect(t).not.toMatch(/order confirmed|payment received|thank you for your purchase|your workspace is ready/i);
  });

  it("does not show a blocked prospect their room, and does not say why", async () => {
    const s = await startDemo();
    state.cookie = s.sessionToken;
    await blockProspect(people.superAdmin, s.prospectId, "Abusive messages");
    expect(await redirectOf(() => roomPage())).toBe("REDIRECT:/demo?r=no_session");
  });

  it("shows a stopped demo as stopped, not as a missing session", async () => {
    const s = await startDemo();
    state.cookie = s.sessionToken;
    demoEnv({ DEMO_PUBLIC_DISABLED: "true" });
    const markup = await roomPage();
    expect(text(markup)).toContain("The demo is not available");
    expect(text(markup)).toContain(PUBLIC_COPY.unavailable);
    expect(forms(markup)).toEqual([]);
  });

  it("marks an extended demo as extended", async () => {
    state.model = { ready: true };
    const s = await startDemo();
    state.cookie = s.sessionToken;
    await extendDemo(people.superAdmin, s.prospectId, { hours: 2, extraMessages: 3, reason: "Asked for more time" });
    const t = text(await roomPage());
    expect(t).toContain("Extended");
    expect(t).toContain("of 13 messages");
  });
});

// ---------------------------------------------------------------------------
// /admin/prospects
// ---------------------------------------------------------------------------

describe("/admin/prospects, the team's list", () => {
  it("sends anyone who may not see prospects away, and shows managers and Super Admins the list", async () => {
    for (const [who, expected] of [[people.staff, "REDIRECT:/admin"], [people.manager, null], [people.superAdmin, null]] as const) {
      state.user = who;
      expect(await redirectOf(() => ProspectsPage({ searchParams: q() })), who.platformRole).toBe(expected);
    }
    state.user = null;
    expect(await redirectOf(() => ProspectsPage({ searchParams: q() }))).toBe("REDIRECT:/overview");
  });

  it("shows who asked, where each demo stands and what the switches mean, and never a conversation", async () => {
    const open = await startDemo({ name: "Opal Open", business: "Opal Optics" });
    await say(open, "A question nobody on the team has read yet");
    const waiting = formInput({ name: "Wanda Waiting", business: "Waiting Works" });
    await registerProspect(waiting, { ip: ipFor() });
    const blocked = await startDemo({ name: "Basil Blocked", business: "Blocked Bakery" });
    await blockProspect(people.superAdmin, blocked.prospectId, "Spam sender");
    const erased = await startDemo({ name: "Edith Erased", business: "Erased Estates" });
    await eraseProspect(people.superAdmin, erased.prospectId, "Asked to be removed");
    await assignOwner(people.superAdmin, open.prospectId, people.manager.id);
    state.user = people.manager;
    const markup = html(await ProspectsPage({ searchParams: q() }));
    const t = text(markup);
    expect(t).not.toMatch(BAD);
    expect((markup.match(/<h1\b/g) ?? []).length).toBe(1);
    expect(t).toContain("Demo prospects");
    expect(t).toContain("Opal Open");
    expect(t).toContain("Opal Optics");
    expect(t).toContain(open.email);
    expect(t).toContain("Wanda Waiting");
    expect(t).toContain("Waiting to confirm");
    expect(t).toContain("Basil Blocked");
    expect(t).toContain("Blocked");
    expect(t).toContain("Followed by Mia Manager");
    // The erased person is a row with no details.
    expect(t).toContain("Details erased");
    expect(t).not.toContain("Edith Erased");
    expect(t).not.toContain("Erased Estates");
    expect(t).not.toContain(erased.email);
    // The conversation is never on the list.
    expect(t).not.toContain("A question nobody on the team has read yet");
    expect(t).not.toContain("Answer to:");
    // The switches, in the words the server uses.
    expect(markup).toMatch(/role="status"[^>]*>[^<]*The demo is open/);
    // Every row opens the prospect by id.
    expect(markup).toContain(`href="/admin/prospects/${open.prospectId}"`);
    // A manager may read the settings, not change them.
    expect(t).toContain("View settings");
    expect(t).not.toContain("Demo settings");
  });

  it("offers the settings to a Super Admin by that name", async () => {
    state.user = people.superAdmin;
    expect(text(html(await ProspectsPage({ searchParams: q() })))).toContain("Demo settings");
  });

  it("filters by status, owner and search from the address, and says when nothing matches", async () => {
    const a = await startDemo({ name: "Filtered Fiona", business: "Fiona Floors" });
    const b = await startDemo({ name: "Filtered Felix", business: "Felix Fences" });
    await blockProspect(people.superAdmin, b.prospectId, "Not a fit here");
    await assignOwner(people.superAdmin, a.prospectId, people.superAdmin.id);
    state.user = people.superAdmin;
    const show = async (query: Record<string, string>) => text(html(await ProspectsPage({ searchParams: q(query) })));
    let t = await show({ q: "filtered" });
    expect(t).toContain("Filtered Fiona");
    expect(t).toContain("Filtered Felix");
    t = await show({ q: "filtered", status: "blocked" });
    expect(t).not.toContain("Filtered Fiona");
    expect(t).toContain("Filtered Felix");
    t = await show({ q: "FELIX FENCES" });
    expect(t).toContain("Filtered Felix");
    expect(t).not.toContain("Filtered Fiona");
    t = await show({ q: "filtered", owner: people.superAdmin.id });
    expect(t).toContain("Filtered Fiona");
    expect(t).not.toContain("Filtered Felix");
    t = await show({ q: "filtered", owner: "none" });
    expect(t).toContain("Filtered Felix");
    expect(t).not.toContain("Filtered Fiona");
    t = await show({ q: "no such person anywhere" });
    expect(t).toContain("No prospect matches that filter.");
    // A search that is SQL stays text; a status that is not one is ignored.
    t = await show({ q: "' or 1=1 --", status: "x'; drop table demo_prospects;--" });
    expect(t).toContain("No prospect matches that filter.");
    expect(await count("demo_prospects")).toBeGreaterThan(0);
  });

  it("labels the filter fields and keeps what was asked for in them", async () => {
    state.user = people.manager;
    const markup = html(await ProspectsPage({ searchParams: q({ q: "pat", status: "active" }) }));
    for (const id of ["prospect-search", "prospect-status", "prospect-owner"]) expect(markup, id).toMatch(new RegExp(`<label[^>]*for="${id}"`));
    expect(markup).toMatch(/id="prospect-search"[^>]*value="pat"|value="pat"[^>]*id="prospect-search"/);
    expect(withAttr(markup, "option", "value", "active")[0]).toContain("selected");
    expect(withAttr(markup, "option", "value", "all")[0]).not.toContain("selected");
  });
});

describe("/admin/prospects/[id], one prospect", () => {
  it("shows who they are, where the demo stands and the timeline, and keeps the conversation behind a recorded button", async () => {
    const s = await startDemo({ name: "Detail Dana", business: "Dana Drains" });
    await say(s, "My private question about pricing");
    await addNote(people.superAdmin, s.prospectId, "Followed up by phone on Tuesday");
    await recordCta("consultation", { sessionToken: s.sessionToken, ip: ipFor() });
    state.user = people.superAdmin;
    const markup = html(await ProspectPage({ params: Promise.resolve({ id: s.prospectId }) }));
    const t = text(markup);
    expect(t).not.toMatch(BAD);
    expect((markup.match(/<h1\b/g) ?? []).length).toBe(1);
    expect(t).toContain("Detail Dana");
    expect(t).toContain("Dana Drains");
    expect(t).toContain(s.email);
    expect(t).toContain("Asked for a consultation");
    expect(t).toContain("Agreed to the notice");
    expect(t).toContain("version draft-2026-10");
    // The timeline, newest first, with who did each thing.
    expect(t).toContain("Timeline");
    expect(t).toContain("Followed up by phone on Tuesday");
    expect(t).toContain("Asked for a demo");
    expect(t).toContain("the prospect");
    expect(t).toContain("Sam Super");
    // The conversation is not on the page.
    expect(t).not.toContain("My private question about pricing");
    expect(t).not.toContain("Answer to:");
    expect(t).toContain("Read the conversation");
    // The ways to act, for a Super Admin.
    expect(buttons(markup)).toEqual(["Read the conversation", "Extend", "End now", "Consultation held", "Make a client", "Not a fit", "Block", "Export their data", "Erase", "Save", "Add the note"]);
    expect(markup).toMatch(/<label[^>]*for="prospect-assign"/);
    expect(markup).toMatch(/<label[^>]*for="prospect-note"/);
  });

  it("shows a manager the details and the right to read the conversation, and no button that changes anything", async () => {
    const s = await startDemo({ name: "Manager Mona" });
    await say(s, "hello");
    state.user = people.manager;
    const markup = html(await ProspectPage({ params: Promise.resolve({ id: s.prospectId }) }));
    expect(text(markup)).toContain("Manager Mona");
    expect(buttons(markup)).toEqual(["Read the conversation"]);
    expect(markup).not.toContain("prospect-assign");
    expect(markup).not.toContain("prospect-note");
  });

  it("shows an erased prospect as erased, with only dates and counts, and nothing to act on", async () => {
    const s = await startDemo({ name: "Erased Erin", business: "Erin Engines" });
    await say(s, "something about Erin Engines");
    await eraseProspect(people.superAdmin, s.prospectId, "Asked to be removed");
    state.user = people.superAdmin;
    const markup = html(await ProspectPage({ params: Promise.resolve({ id: s.prospectId }) }));
    const t = text(markup);
    expect(t).toContain("Details erased");
    expect(t).toContain("Their details and conversation were erased on");
    for (const gone of ["Erased Erin", "Erin Engines", s.email, "something about", "Asked to be removed"]) expect(t, gone).not.toContain(gone);
    expect(t).not.toContain("Read the conversation");
    expect(t).not.toContain("Make a client");
    expect(t).toContain("Their details were erased");
  });

  it("answers not-found for an id that is not a prospect, is not an id, or belongs to nothing, and sends people without the permission away", async () => {
    state.user = people.superAdmin;
    for (const id of ["00000000-0000-4000-8000-000000000000", "not-an-id", "' or 1=1 --", "../admin"]) expect(await redirectOf(() => ProspectPage({ params: Promise.resolve({ id }) })), id).toBe("NOT_FOUND");
    const s = await startDemo();
    state.user = people.staff;
    expect(await redirectOf(() => ProspectPage({ params: Promise.resolve({ id: s.prospectId }) }))).toBe("REDIRECT:/admin");
  });

  it("states what the team already did when a workspace is being made, and links the finished one", async () => {
    const s = await startDemo();
    await rows("update demo_prospects set conversion_claimed_at = now() where id = $1", [s.prospectId]);
    state.user = people.superAdmin;
    let t = text(html(await ProspectPage({ params: Promise.resolve({ id: s.prospectId }) })));
    expect(t).toContain("A workspace is being made for this prospect right now.");
    expect(t).not.toContain("Make a client");
    await rows("update demo_prospects set conversion_claimed_at = null where id = $1", [s.prospectId]);
    t = text(html(await ProspectPage({ params: Promise.resolve({ id: s.prospectId }) })));
    expect(t).not.toContain("is being made");
  });
});

describe("/admin/prospects/settings", () => {
  it("shows a Super Admin the settings as saved, with the limits as input limits, and the switches' real state", async () => {
    state.user = people.superAdmin;
    const markup = html(await DemoSettingsPage());
    const t = text(markup);
    expect(t).not.toMatch(BAD);
    expect((markup.match(/<h1\b/g) ?? []).length).toBe(1);
    expect(t).toContain("DEMO_ENABLED in this deployment: on");
    expect(t).toContain("Emergency stop (DEMO_PUBLIC_DISABLED): off");
    expect(t).toContain("the founder has not confirmed yet");
    expect(markup).toMatch(/id="s-windowHours"[^>]*value="24"|value="24"[^>]*id="s-windowHours"/);
    expect(markup).toMatch(/id="s-messageLimit"[^>]*max="100"|max="100"[^>]*id="s-messageLimit"/);
    expect(markup).toMatch(/id="s-retentionDays"[^>]*min="7"|min="7"[^>]*id="s-retentionDays"/);
    expect(markup).toContain(`value="${CONSULT}"`);
    expect(markup).toContain('type="url"');
    for (const id of ["s-windowHours", "s-messageLimit", "s-maxExtensionHours", "s-maxExtraMessages", "s-dailyStartCap", "s-dailyMessageCap", "s-retentionDays", "s-consultation", "s-blocked"]) {
      expect(markup, id).toMatch(new RegExp(`<label[^>]*for="${id}"`));
    }
    expect(t).toContain("Save the settings");
    const fields = ["input", "textarea"].flatMap((name) => [...markup.matchAll(new RegExp(`<${name}\\b[^>]*>`, "g"))].map((m) => m[0]));
    expect(fields.filter((f) => f.includes('disabled=""'))).toEqual([]);
    expect(withAttr(markup, "input", "type", "number")).toHaveLength(7);
  });

  it("shows a manager the same settings read-only, with no way to save", async () => {
    state.user = people.manager;
    const markup = html(await DemoSettingsPage());
    expect(text(markup)).toContain("Only a Super Admin can change these settings. You can read them.");
    expect(text(markup)).not.toContain("Save the settings");
    expect(withAttr(markup, "input", "type", "number").filter((f) => f.includes('disabled=""'))).toHaveLength(7);
    expect(withAttr(markup, "input", "type", "checkbox").filter((f) => f.includes('disabled=""'))).toHaveLength(2);
    expect(buttons(markup)).toEqual([]);
  });

  it("sends the team's staff away", async () => {
    state.user = people.staff;
    expect(await redirectOf(() => DemoSettingsPage())).toBe("REDIRECT:/admin");
  });

  it("says what the emergency stop and the deployment switch are doing", async () => {
    state.user = people.superAdmin;
    demoEnv({ DEMO_PUBLIC_DISABLED: "true", DEMO_ENABLED: "false" });
    const t = text(html(await DemoSettingsPage()));
    expect(t).toContain("DEMO_ENABLED in this deployment: off");
    expect(t).toContain("Emergency stop (DEMO_PUBLIC_DISABLED): ON, the public demo is stopped");
    expect(t).toContain("The emergency stop is on");
  });
});

describe("a prospect is never a user", () => {
  it("creates no user, workspace, membership or invitation from a whole visit: asking, confirming, chatting, and every page", async () => {
    const tables = ["users", "organizations", "organization_memberships", "invitations"];
    const snapshot = async () => Object.fromEntries(await Promise.all(tables.map(async (t) => [t, await count(t)])));
    const before = await snapshot();
    const s = await startDemo();
    await say(s, "hello");
    state.cookie = s.sessionToken;
    state.model = { ready: true };
    await roomPage();
    await demoPage();
    await verifyPage({ token: s.token });
    expect(await snapshot()).toEqual(before);
  });
});
