import { describe, expect, it } from "vitest";
import {
  cleanQualificationAnswers, embedSnippet, hostFromOrigin, installState, isClientMessageId, isHostAllowed, isSessionToken, isWidgetKey, normalizeAllowedHost, normalizeAllowedHosts,
  qualificationComplete, readLandingVisit, readVisitorDetails, validateQualificationQuestions, visitorText,
} from "@/lib/webchat/rules";

describe("which sites may run the widget", () => {
  it("reduces what an owner typed to a lower-case host", () => {
    expect(normalizeAllowedHost("https://WWW.Example.com/contact?x=1")).toEqual({ ok: true, host: "www.example.com" });
    expect(normalizeAllowedHost("example.com")).toEqual({ ok: true, host: "example.com" });
    expect(normalizeAllowedHost("Example.com:8443/path")).toEqual({ ok: true, host: "example.com" });
    expect(normalizeAllowedHost("*.example.com")).toEqual({ ok: true, host: "*.example.com" });
    expect(normalizeAllowedHost("shop.example.co.uk.")).toEqual({ ok: true, host: "shop.example.co.uk" });
  });

  it("refuses addresses that are not a public website name", () => {
    for (const bad of ["", "   ", "http://192.168.0.1", "10.0.0.1", "[::1]", "ftp://example.com", "javascript:alert(1)", "example", "-bad-.example.com", "exa mple.com", "*.com", "*", "*.*.example.com", "a".repeat(260) + ".com"]) {
      expect(normalizeAllowedHost(bad), bad).toMatchObject({ ok: false });
    }
    // localhost is allowed so an owner can test on their own machine.
    expect(normalizeAllowedHost("localhost:3000")).toEqual({ ok: true, host: "localhost" });
  });

  it("keeps a list unique and bounded, and names the entry that is wrong", () => {
    expect(normalizeAllowedHosts(["a.com", "A.com", "https://b.com", ""])).toEqual({ ok: true, hosts: ["a.com", "b.com"] });
    const bad = normalizeAllowedHosts(["a.com", "10.0.0.1"]);
    expect(bad).toMatchObject({ ok: false });
    if (!bad.ok) expect(bad.error).toMatch(/10\.0\.0\.1/);
    expect(normalizeAllowedHosts(Array.from({ length: 21 }, (_, i) => `site${i}.com`))).toMatchObject({ ok: false });
  });

  it("reads the Origin header, and refuses anything that is not an http(s) origin", () => {
    expect(hostFromOrigin("https://www.Example.com")).toBe("www.example.com");
    expect(hostFromOrigin("http://localhost:3000")).toBe("localhost");
    for (const bad of [null, undefined, "", "null", "file:///x", "chrome-extension://abc", "not a url"]) expect(hostFromOrigin(bad as string | null), String(bad)).toBeNull();
  });

  it("allows exact hosts, one-level wildcards and the workspace's own sites, and nothing else", () => {
    const allowed = ["www.example.com", "*.shop.example.com"];
    expect(isHostAllowed("www.example.com", allowed)).toBe(true);
    expect(isHostAllowed("WWW.EXAMPLE.COM", allowed)).toBe(true);
    expect(isHostAllowed("example.com", allowed)).toBe(false); // the apex is not www
    expect(isHostAllowed("evil.com", allowed)).toBe(false);
    expect(isHostAllowed("www.example.com.evil.com", allowed)).toBe(false);
    expect(isHostAllowed("evilwww.example.com", allowed)).toBe(false);
    expect(isHostAllowed("a.shop.example.com", allowed)).toBe(true);
    expect(isHostAllowed("a.b.shop.example.com", allowed)).toBe(false); // one level only
    expect(isHostAllowed("shop.example.com", allowed)).toBe(false); // the wildcard does not cover its own apex
    expect(isHostAllowed(".shop.example.com", allowed)).toBe(false);
    expect(isHostAllowed(null, allowed)).toBe(false);
    expect(isHostAllowed("mysite.iacquire.site", [], ["mysite.iacquire.site"])).toBe(true);
    expect(isHostAllowed("other.iacquire.site", [], ["mysite.iacquire.site"])).toBe(false);
  });
});

describe("what a visitor sends", () => {
  it("keeps the words and drops control and direction-override characters", () => {
    expect(visitorText("  Hello\u0000 there‮!  ")).toBe("Hello there!");
    expect(visitorText("a\r\n\r\n\r\n\r\nb")).toBe("a\n\nb");
    expect(visitorText("​\u0007 ")).toBeNull();
    expect(visitorText(42)).toBeNull();
    expect(visitorText("x".repeat(5000))?.length).toBe(1000);
    // Markup is kept as typed: nothing downstream renders it as HTML.
    expect(visitorText("<script>alert(1)</script>")).toBe("<script>alert(1)</script>");
  });

  it("normalizes the lead form and asks for a usable way to reach the person", () => {
    expect(readVisitorDetails({ name: " Dana  Lee ", email: " Dana@Example.COM ", phone: "" })).toEqual({ ok: true, details: { name: "Dana Lee", email: "dana@example.com", phone: null } });
    expect(readVisitorDetails({ phone: "+63 917 123 4567" })).toMatchObject({ ok: true, details: { phone: "+639171234567", email: null } });
    expect(readVisitorDetails({ name: "Dana" })).toMatchObject({ ok: false });
    expect(readVisitorDetails({ email: "not-an-email" })).toMatchObject({ ok: false });
    // No country code and no default: refused instead of guessed.
    expect(readVisitorDetails({ phone: "0917 123 4567" })).toMatchObject({ ok: false });
  });

  it("reads the visit: path, known marketing parameters and the referrer's host and path, and nothing else", () => {
    const v = readLandingVisit("/pricing?utm_source=Google&utm_medium=cpc&secret=abc&gclid=XYZ", "https://www.facebook.com/page?token=1", "shop.example.com");
    expect(v.landingPath).toBe("/pricing");
    expect(v.attribution).toEqual({ landing_page: "/pricing", utm_source: "Google", utm_medium: "cpc", gclid: "XYZ", referrer: "https://www.facebook.com/page" });
    expect(JSON.stringify(v)).not.toMatch(/secret|token/);
    // A referrer on the site itself is a reload, not a source; a protocol-relative or absolute landing is not a path.
    expect(readLandingVisit("/", "https://shop.example.com/x", "shop.example.com").referrer).toBeNull();
    expect(readLandingVisit("//evil.com/x", null, null).landingPath).toBeNull();
    expect(readLandingVisit("https://evil.com/x", "javascript:alert(1)", null)).toEqual({ landingPath: null, referrer: null, attribution: {} });
  });
});

describe("the qualification questions", () => {
  it("accepts text and choice questions with keys it makes itself, and refuses anything malformed", () => {
    const ok = validateQualificationQuestions([
      { label: "What do you need help with?", kind: "text", required: true },
      { label: "How soon?", kind: "choice", choices: ["This week", "This month", "Just looking", "This week"], required: false },
    ]);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.questions[0]).toMatchObject({ key: "what_do_you_need_help_with", kind: "text", required: true });
      expect(ok.questions[1].choices).toEqual(["This week", "This month", "Just looking"]);
    }
    expect(validateQualificationQuestions("nope")).toMatchObject({ ok: false });
    expect(validateQualificationQuestions([{ label: "x" }])).toMatchObject({ ok: false });
    expect(validateQualificationQuestions([{ label: "How soon?", kind: "choice", choices: ["only one"] }])).toMatchObject({ ok: false });
    expect(validateQualificationQuestions(Array.from({ length: 4 }, (_, i) => ({ label: `Question ${i}` })))).toMatchObject({ ok: false });
    expect(validateQualificationQuestions([{ label: "Same thing", key: "same_key" }, { label: "Same other", key: "same_key" }])).toMatchObject({ ok: false });
  });

  it("keeps only answers to real questions, checks choices, and completes only when every required one is answered", () => {
    const parsed = validateQualificationQuestions([
      { label: "Need", kind: "text", required: true },
      { label: "Timing", kind: "choice", choices: ["Soon", "Later"], required: true },
      { label: "Notes", kind: "text", required: false },
    ]);
    if (!parsed.ok) throw new Error("setup");
    const qs = parsed.questions;
    const answers = cleanQualificationAnswers(qs, { need: " Roof repair ", timing: "Yesterday", notes: "", sneaky: "x" });
    expect(answers).toEqual({ need: "Roof repair" }); // a choice that is not on the list and an unknown key are dropped
    expect(qualificationComplete(qs, answers)).toBe(false);
    expect(qualificationComplete(qs, { ...answers, timing: "Soon" })).toBe(true);
    expect(qualificationComplete([], {})).toBe(false); // nothing to complete
  });
});

describe("identifiers and installation", () => {
  it("recognizes the shapes of the public key, the session token and a client message id", () => {
    expect(isWidgetKey("wk_" + "a".repeat(24))).toBe(true);
    expect(isWidgetKey("wk_short")).toBe(false);
    expect(isWidgetKey("sk_" + "a".repeat(24))).toBe(false);
    expect(isSessionToken("A".repeat(43))).toBe(true);
    expect(isSessionToken("A".repeat(42))).toBe(false);
    expect(isSessionToken("../".repeat(15))).toBe(false);
    expect(isClientMessageId("abcDEF123456")).toBe(true);
    expect(isClientMessageId("short")).toBe(false);
    expect(isClientMessageId("has space in it")).toBe(false);
  });

  it("builds a snippet that carries the public key and nothing else", () => {
    const s = embedSnippet({ appOrigin: "https://www.iacquire.online/", key: "wk_" + "x".repeat(24) });
    expect(s).toBe(`<script src="https://www.iacquire.online/widget/chat.js" data-key="wk_${"x".repeat(24)}" async></script>`);
    expect(s).not.toMatch(/secret|token|password/i);
  });

  it("reports installation from evidence only", () => {
    const seen = new Date();
    expect(installState({ enabled: false, allowedHostCount: 1, autoInstalledSites: 0, lastSeenAt: seen })).toBe("disabled");
    expect(installState({ enabled: true, allowedHostCount: 0, autoInstalledSites: 0, lastSeenAt: null })).toBe("no_sites");
    expect(installState({ enabled: true, allowedHostCount: 1, autoInstalledSites: 0, lastSeenAt: null })).toBe("waiting");
    expect(installState({ enabled: true, allowedHostCount: 0, autoInstalledSites: 1, lastSeenAt: seen })).toBe("installed");
  });
});
