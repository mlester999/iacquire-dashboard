// @vitest-environment jsdom
// The exact widget script an owner installs, run in a browser-like environment against the REAL server code: its fetch calls are answered by handleWebChat
// (embedded Postgres, real conversations, real escalation and consent code); only the language model is a stub. This proves the script and the API agree and
// that the widget behaves (what it shows, what it stores, what it refuses to render as markup). It does not prove rendering in a real browser: that is
// recorded separately in the browser QA notes.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { WIDGET_SCRIPT } from "@/lib/webchat/widget-script";
import { handleWebChat } from "@/server/webchat/http";
import type { ReplyGenerator } from "@/server/messaging/responder";
import { chatOrg, ORIGIN, type ChatOrg } from "./support/webchat";

const PORTAL = "https://portal.test";
let c: ChatOrg;
let generate: ReplyGenerator = async () => ({ kind: "reply", text: "Hello from the assistant." });
let seenRequests: Array<{ url: string; method: string; headers: Record<string, string> }> = [];

/** Answers the widget's fetch calls with the real chat API, as the browser on ORIGIN would reach it. */
function installFetch() {
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    seenRequests.push({ url: input, method: init.method ?? "GET", headers });
    const auth = headers.authorization;
    const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
    const res = await handleWebChat({
      action: url.pathname.split("/").pop() ?? "", method: init.method ?? "GET", surface: { kind: "embed", key: url.searchParams.get("k") ?? "", origin: ORIGIN },
      token: auth?.startsWith("Bearer ") ? auth.slice(7) : null, address: "203.0.113.9", query: url.searchParams, body, generate, replyTimeoutMs: 15_000,
    });
    return new Response(res.body === null ? null : JSON.stringify(res.body), { status: res.status, headers: { "Content-Type": "application/json" } });
  });
}

function mount(key: string) {
  const script = document.createElement("script");
  script.setAttribute("data-key", key);
  Object.defineProperty(script, "src", { value: `${PORTAL}/widget/chat.js`, configurable: true });
  Object.defineProperty(document, "currentScript", { value: script, configurable: true });
  (0, eval)(WIDGET_SCRIPT);
  Object.defineProperty(document, "currentScript", { value: null, configurable: true });
}

const hostEl = () => document.querySelector("[data-iacquire-chat]") as HTMLElement | null;
const shadow = () => hostEl()!.shadowRoot!;
const q = <T extends Element = HTMLElement>(sel: string) => shadow().querySelector(sel) as T;
const qa = (sel: string) => [...shadow().querySelectorAll(sel)] as HTMLElement[];

async function until(check: () => boolean, label: string, ms = 8000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const type = (el: HTMLTextAreaElement | HTMLInputElement, value: string) => {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
};
const messages = () => qa(".log .msg:not(.intro)").map((m) => ({ cls: m.className.replace("msg ", ""), text: m.textContent ?? "" }));

beforeAll(async () => {
  c = await chatOrg({ welcomeMessage: "Welcome! Ask us anything.", title: "Talk to Harbor", launcherLabel: "Chat" });
});

afterEach(() => {
  document.body.innerHTML = "";
  window.localStorage.clear();
  delete (window as unknown as { __iacquireChat?: boolean }).__iacquireChat;
  seenRequests = [];
  generate = async () => ({ kind: "reply", text: "Hello from the assistant." });
});

describe("the installed widget", () => {
  it("is a script that parses, carries no secret, and opens nothing before the visitor acts", async () => {
    expect(() => new Function(WIDGET_SCRIPT)).not.toThrow();
    expect(WIDGET_SCRIPT).not.toMatch(/secret|password|api[_-]?key|sk_|token=/i);
    installFetch();
    mount(c.widget.publicKey);
    await until(() => hostEl() !== null, "the widget to appear");
    // Loading the page asked only for the public settings: no session, no storage, nothing about the visitor.
    expect(seenRequests.map((r) => `${r.method} ${new URL(r.url).pathname.split("/").pop()}`)).toEqual(["GET config"]);
    expect(seenRequests[0].headers.authorization).toBeUndefined();
    expect(window.localStorage.length).toBe(0);
    expect(await withSystem((db) => db.query("select 1 from web_chat_sessions where org_id = $1", [c.m.org.id]))).toMatchObject({ rows: [] });
    // The launcher is a labelled button; the panel is a closed dialog.
    const launcher = q<HTMLButtonElement>(".launcher");
    expect(launcher.tagName).toBe("BUTTON");
    expect(launcher.getAttribute("aria-expanded")).toBe("false");
    expect(launcher.getAttribute("aria-haspopup")).toBe("dialog");
    expect(q(".panel").hasAttribute("hidden")).toBe(true);
    expect(q(".panel").getAttribute("role")).toBe("dialog");
  });

  it("does nothing, and says nothing to the page, when the key is wrong or the site is not allowed", async () => {
    installFetch();
    mount("wk_" + "q".repeat(24));
    await new Promise((r) => setTimeout(r, 300));
    expect(hostEl()).toBeNull();
    window.localStorage.clear();
    delete (window as unknown as { __iacquireChat?: boolean }).__iacquireChat;
    // A script tag with no key (a half-pasted snippet) does nothing either.
    const script = document.createElement("script");
    Object.defineProperty(script, "src", { value: `${PORTAL}/widget/chat.js`, configurable: true });
    Object.defineProperty(document, "currentScript", { value: script, configurable: true });
    (0, eval)(WIDGET_SCRIPT);
    Object.defineProperty(document, "currentScript", { value: null, configurable: true });
    await new Promise((r) => setTimeout(r, 100));
    expect(hostEl()).toBeNull();
  });

  it("opens with the welcome message, starts the session only when the visitor sends, and shows the AI's answer", async () => {
    installFetch();
    mount(c.widget.publicKey);
    await until(() => hostEl() !== null, "widget");
    q<HTMLButtonElement>(".launcher").click();
    expect(q<HTMLButtonElement>(".launcher").getAttribute("aria-expanded")).toBe("true");
    expect(q(".panel").hasAttribute("hidden")).toBe(false);
    expect(q(".log .intro").textContent).toBe("Welcome! Ask us anything.");
    expect(q("h2").textContent).toBe("Talk to Harbor");
    expect(seenRequests.filter((r) => r.url.includes("/session"))).toHaveLength(0);

    const input = q<HTMLTextAreaElement>("textarea");
    type(input, "Do you fix roofs?");
    q<HTMLButtonElement>(".btn.primary").click();
    await until(() => messages().length === 2, "the reply");
    expect(messages()).toEqual([
      { cls: "v", text: "You: Do you fix roofs?" },
      { cls: "a", text: expect.stringMatching(/^Assistant: I'm an AI assistant for .+\. Hello from the assistant\.$/) },
    ]);
    // The visitor's token is kept in the browser only now, and sent as a bearer header, never in the address.
    expect(window.localStorage.length).toBe(1);
    const sends = seenRequests.filter((r) => r.url.includes("/send"));
    expect(sends).toHaveLength(1);
    expect(sends[0].headers.authorization).toMatch(/^Bearer [A-Za-z0-9_-]{43}$/);
    expect(sends[0].url).not.toMatch(/[A-Za-z0-9_-]{43}/);
    expect(input.value).toBe(""); // cleared after sending
    // The server really holds this conversation.
    const conv = await withSystem((db) => db.query("select 1 from conversations where org_id = $1 and channel = 'web_chat'", [c.m.org.id]));
    expect(conv.rows.length).toBeGreaterThan(0);
  });

  it("shows what people type as plain text, never as markup", async () => {
    installFetch();
    generate = async () => ({ kind: "reply", text: "<img src=x onerror=alert(1)> **bold** <b>hi</b>" });
    mount(c.widget.publicKey);
    await until(() => hostEl() !== null, "widget");
    q<HTMLButtonElement>(".launcher").click();
    type(q<HTMLTextAreaElement>("textarea"), "<script>alert('x')</script><svg onload=alert(1)>");
    q<HTMLButtonElement>(".btn.primary").click();
    await until(() => messages().length === 2, "the reply");
    expect(qa(".log img, .log script, .log svg, .log b")).toHaveLength(0);
    expect(messages()[0].text).toContain("<script>alert('x')</script>");
    expect(messages()[1].text).toContain("<img src=x onerror=alert(1)>");
  });

  it("sends with Enter, keeps a new line with Shift+Enter, and closes with Escape returning focus to the launcher", async () => {
    installFetch();
    mount(c.widget.publicKey);
    await until(() => hostEl() !== null, "widget");
    q<HTMLButtonElement>(".launcher").click();
    const input = q<HTMLTextAreaElement>("textarea");
    type(input, "line one");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 50));
    expect(seenRequests.filter((r) => r.url.includes("/send"))).toHaveLength(0); // Shift+Enter did not send
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await until(() => messages().length === 2, "reply after Enter");
    q(".panel").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(q(".panel").hasAttribute("hidden")).toBe(true);
    expect(q<HTMLButtonElement>(".launcher").getAttribute("aria-expanded")).toBe("false");
  });

  it("resumes the same conversation when the visitor comes back, and starts over when the server no longer knows the token", async () => {
    installFetch();
    mount(c.widget.publicKey);
    await until(() => hostEl() !== null, "widget");
    q<HTMLButtonElement>(".launcher").click();
    type(q<HTMLTextAreaElement>("textarea"), "First visit");
    q<HTMLButtonElement>(".btn.primary").click();
    await until(() => messages().length === 2, "first reply");
    const stored = window.localStorage.getItem(window.localStorage.key(0) as string) as string;
    // A new page load with the stored token shows the earlier conversation.
    document.body.innerHTML = "";
    delete (window as unknown as { __iacquireChat?: boolean }).__iacquireChat;
    mount(c.widget.publicKey);
    await until(() => hostEl() !== null, "widget again");
    q<HTMLButtonElement>(".launcher").click();
    await until(() => messages().length === 2, "history to load");
    expect(messages()[0].text).toBe("You: First visit");
    // A token the server does not know (expired, rotated, purged) is dropped and the visitor is told to start again.
    document.body.innerHTML = "";
    delete (window as unknown as { __iacquireChat?: boolean }).__iacquireChat;
    window.localStorage.setItem(window.localStorage.key(0) as string, JSON.stringify({ t: "A".repeat(43) }));
    void stored;
    mount(c.widget.publicKey);
    await until(() => hostEl() !== null, "widget third time");
    q<HTMLButtonElement>(".launcher").click();
    await until(() => window.localStorage.length === 0, "the stale token to be dropped");
  });

  it("takes the details form, needs the privacy confirmation, and creates the lead on the server", async () => {
    installFetch();
    mount(c.widget.publicKey);
    await until(() => hostEl() !== null, "widget");
    q<HTMLButtonElement>(".launcher").click();
    const leave = qa(".tools .btn").find((b) => /Leave your details/.test(b.textContent ?? ""))!;
    expect(leave).toBeDefined();
    leave.click();
    await until(() => shadow().getElementById("iaq-email") !== null, "the form");
    type(shadow().getElementById("iaq-name") as HTMLInputElement, "Dana Lee");
    type(shadow().getElementById("iaq-email") as HTMLInputElement, "dana.widget@example.com");
    const submit = qa(".form .btn.primary")[0];
    submit.click();
    expect(shadow().getElementById("iaq-form-err")!.textContent).toMatch(/confirm the privacy notice/i); // refused before anything is sent
    expect(seenRequests.filter((r) => r.url.includes("/lead"))).toHaveLength(0);
    (shadow().getElementById("iaq-ack") as HTMLInputElement).checked = true;
    submit.click();
    await until(() => seenRequests.some((r) => r.url.includes("/lead")), "the lead request");
    await until(() => messages().some((m) => /team has your details/.test(m.text)), "the thanks");
    const row = await withSystem((db) => db.query<{ email: string }>("select c.email::text as email from contacts c where c.org_id = $1 and c.created_via = 'website_chat' and c.email = 'dana.widget@example.com'", [c.m.org.id]));
    expect(row.rows).toHaveLength(1);
    // The form is gone and the button to open it is gone: it was done.
    expect(qa(".tools .btn").some((b) => /Leave your details/.test(b.textContent ?? "") && b.style.display !== "none")).toBe(false);
  });

  it("offers a person, and tells the visitor plainly that one was asked", async () => {
    installFetch();
    mount(c.widget.publicKey);
    await until(() => hostEl() !== null, "widget");
    q<HTMLButtonElement>(".launcher").click();
    type(q<HTMLTextAreaElement>("textarea"), "Hello");
    q<HTMLButtonElement>(".btn.primary").click();
    await until(() => messages().length === 2, "reply");
    const person = qa(".tools .btn").find((b) => /Talk to a person/.test(b.textContent ?? ""))!;
    person.click();
    await until(() => messages().some((m) => m.cls === "s" && /asked a team member/.test(m.text)), "the handoff notice");
    expect((person as HTMLButtonElement).disabled).toBe(true);
    expect(person.textContent).toMatch(/was asked to join/);
  });

  it("shows a clear message and keeps the visitor's words when the chat cannot be reached", async () => {
    installFetch();
    mount(c.widget.publicKey);
    await until(() => hostEl() !== null, "widget");
    q<HTMLButtonElement>(".launcher").click();
    vi.stubGlobal("fetch", async () => { throw new TypeError("network down"); });
    const input = q<HTMLTextAreaElement>("textarea");
    type(input, "Is anyone there?");
    q<HTMLButtonElement>(".btn.primary").click();
    await until(() => /not sent/i.test(q(".note[role=alert]").textContent ?? ""), "the error");
    expect(input.value).toBe("Is anyone there?"); // not lost
    expect(messages()).toEqual([]); // and not shown as if it had been delivered
    expect(q<HTMLButtonElement>(".btn.primary").disabled).toBe(false);
  });
});

describe("what the widget exposes to a screen reader and a keyboard", () => {
  it("labels every control, announces new messages politely, and marks who said what", async () => {
    installFetch();
    mount(c.widget.publicKey);
    await until(() => hostEl() !== null, "widget");
    q<HTMLButtonElement>(".launcher").click();
    type(q<HTMLTextAreaElement>("textarea"), "Hello");
    q<HTMLButtonElement>(".btn.primary").click();
    await until(() => messages().length === 2, "reply");
    const log = q(".log");
    expect(log.getAttribute("role")).toBe("log");
    expect(log.getAttribute("aria-live")).toBe("polite");
    expect(log.getAttribute("tabindex")).toBe("0"); // a scrollable region a keyboard visitor can reach
    expect(q(".launcher").getAttribute("aria-label")).toBeNull(); // named by its own content, so the visible words are the announced words
    expect(q("textarea").getAttribute("aria-label")).toBe("Your message");
    expect(q(".close").getAttribute("aria-label")).toBe("Close chat");
    expect(q(".panel").getAttribute("aria-labelledby")).toBe("iaq-title");
    expect(shadow().getElementById("iaq-title")?.textContent).toBe("Talk to Harbor");
    // Each message begins with a visually hidden speaker label, so the sender is spoken.
    expect(qa(".msg .who").map((w) => w.textContent)).toEqual(["You: ", "Assistant: "]);
    // Every form field has a real label.
    qa(".tools .btn").find((b) => /Leave your details/.test(b.textContent ?? ""))?.click();
    await until(() => shadow().getElementById("iaq-email") !== null, "form");
    for (const input of qa(".form input[type=text], .form input[type=email], .form input[type=tel]")) {
      expect(shadow().querySelector(`label[for="${input.id}"]`), input.id).not.toBeNull();
    }
  });
});
