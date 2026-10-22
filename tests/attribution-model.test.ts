import { describe, expect, it } from "vitest";
import { classifyTouch, costPerLead, missingInputs, normalizeSourceName, returnOnSpend, sourceFromReferrer, sourceLabel, UNKNOWN_SOURCE } from "@/lib/attribution/model";

describe("reading where a touch came from", () => {
  it("takes explicit campaign tags as known, exactly as they arrived", () => {
    const t = classifyTouch({ kind: "website_form", attribution: { utm_source: "Google Ads", utm_medium: "CPC", utm_campaign: "Spring Roofing", utm_term: "roof repair", utm_content: "ad-a", landing_page: "/quote" } });
    expect(t).toMatchObject({ source: "google-ads", medium: "cpc", campaign: "Spring Roofing", term: "roof repair", content: "ad-a", landingPath: "/quote", confidence: "known", evidence: "utm" });
  });

  it("treats a paid click id as a known platform but never invents a campaign", () => {
    expect(classifyTouch({ kind: "website_chat", attribution: { gclid: "abc" } })).toMatchObject({ source: "google", medium: "cpc", campaign: null, confidence: "known", evidence: "click_id", clickIds: { gclid: "abc" } });
    expect(classifyTouch({ kind: "website_chat", attribution: { msclkid: "m" } })).toMatchObject({ source: "bing", medium: "cpc", confidence: "known" });
    expect(classifyTouch({ kind: "website_chat", attribution: { fbclid: "f" } })).toMatchObject({ source: "facebook", medium: null, confidence: "known" });
  });

  it("lets explicit tags beat a click id, and a click id beat the referrer", () => {
    expect(classifyTouch({ kind: "website_form", attribution: { utm_source: "newsletter", gclid: "g", referrer: "https://www.google.com/" } }).source).toBe("newsletter");
    expect(classifyTouch({ kind: "website_form", attribution: { gclid: "g", referrer: "https://www.facebook.com/" } }).source).toBe("google");
  });

  it("infers from the referring site and says it is an inference", () => {
    expect(classifyTouch({ kind: "website_form", attribution: { referrer: "https://www.google.com/search" } })).toMatchObject({ source: "google", medium: "organic", confidence: "inferred", evidence: "referrer" });
    expect(classifyTouch({ kind: "website_form", attribution: { referrer: "https://l.facebook.com/l.php" } })).toMatchObject({ source: "facebook", medium: "social", confidence: "inferred" });
    expect(classifyTouch({ kind: "website_form", attribution: { referrer: "https://blog.partner.example/post" } })).toMatchObject({ source: "blog.partner.example", medium: "referral", confidence: "inferred" });
    expect(sourceFromReferrer("not a url")).toBeNull();
    expect(sourceFromReferrer(null)).toBeNull();
  });

  it("says a phone call was a phone call, and says nothing more", () => {
    expect(classifyTouch({ kind: "call" })).toMatchObject({ source: "phone", medium: "call", campaign: null, confidence: "inferred", evidence: "channel" });
  });

  it("reports unknown when the touch carried nothing, never 'direct'", () => {
    const t = classifyTouch({ kind: "website_chat", attribution: { landing_page: "/" } });
    expect(t).toMatchObject({ source: UNKNOWN_SOURCE, confidence: "unknown", evidence: "none", landingPath: "/" });
    expect(sourceLabel(t.source)).toBe("Not recorded");
    expect(JSON.stringify(t)).not.toMatch(/direct/i);
  });

  it("takes a person's own choice as known and attributed to them", () => {
    expect(classifyTouch({ kind: "manual", manual: { source: "Trade Show", medium: "Event", campaign: "Expo 2026" } })).toMatchObject({ source: "trade-show", medium: "event", campaign: "Expo 2026", confidence: "known", evidence: "manual" });
    // An empty choice falls through to what the touch carried.
    expect(classifyTouch({ kind: "manual", manual: { source: "   " }, attribution: { utm_source: "x" } }).evidence).toBe("utm");
  });

  it("cleans names and bounds lengths", () => {
    expect(normalizeSourceName("  Facebook / Instagram!! ")).toBe("facebook-/-instagram");
    expect(normalizeSourceName("a".repeat(200)).length).toBe(60);
    expect(normalizeSourceName(42)).toBe("");
    expect(normalizeSourceName("\u0000\u0007")).toBe("");
    expect(sourceLabel("my-custom")).toBe("My custom"); // other names: first letter raised, hyphens read as spaces
    expect(sourceLabel("trade-show")).toBe("Trade show");
    expect(normalizeSourceName(sourceLabel("trade-show"))).toBe("trade-show"); // a label typed back stores the same name
  });
});

describe("money the report may show", () => {
  it("computes cost per lead only from an entered cost and at least one lead", () => {
    expect(costPerLead(300, 12)).toBe(25);
    expect(costPerLead(100, 3)).toBe(33.33);
    expect(costPerLead(null, 12)).toBeNull();
    expect(costPerLead(300, 0)).toBeNull();
    expect(costPerLead(-5, 3)).toBeNull();
  });

  it("computes return on spend only from verified revenue AND an entered cost above zero", () => {
    expect(returnOnSpend({ verifiedRevenue: 1500, cost: 500 })).toBe(2);
    expect(returnOnSpend({ verifiedRevenue: 0, cost: 500 })).toBe(-1);
    expect(returnOnSpend({ verifiedRevenue: null, cost: 500 })).toBeNull();
    expect(returnOnSpend({ verifiedRevenue: 1500, cost: null })).toBeNull();
    expect(returnOnSpend({ verifiedRevenue: 1500, cost: 0 })).toBeNull();
  });

  it("says in words what is missing instead of showing a number", () => {
    expect(missingInputs({ verifiedRevenue: null, cost: null })).toBe("Needs an entered campaign cost and verified payments.");
    expect(missingInputs({ verifiedRevenue: null, cost: 10 })).toBe("Needs verified payments.");
    expect(missingInputs({ verifiedRevenue: 5, cost: null })).toBe("Needs an entered campaign cost.");
    expect(missingInputs({ verifiedRevenue: 5, cost: 10 })).toBeNull();
  });
});
