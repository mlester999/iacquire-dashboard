import { describe, expect, it } from "vitest";
import { isSameSite, sameSiteRequest } from "@/server/security/same-site";
import { sameSite as proposalSameSite } from "@/server/proposals/public-http";
import { sameSite as invoiceSameSite } from "@/server/invoices/public-http";

// A form submitted from a page served with Referrer-Policy: no-referrer (the customer proposal and invoice pages) carries Origin: null in real browsers, so a check that
// only reads Origin refused every customer's "Email me a code" and "Accept" click. Sec-Fetch-Site says where the request really came from.

const HOST = "app.example.test";
const facts = (origin: string | null, secFetchSite: string | null, host: string | null = HOST) => ({ origin, host, secFetchSite });

describe("which requests count as coming from this site", () => {
  it.each([
    ["the same origin", facts(`https://${HOST}`, "same-origin"), true],
    ["the same origin, no Sec-Fetch-Site (an older browser)", facts(`https://${HOST}`, null), true],
    ["the same origin in another letter case", facts("https://APP.example.test", null), true],
    ["another site's origin", facts("https://evil.example", "cross-site"), false],
    ["another site's origin that claims same-origin", facts("https://evil.example", "same-origin"), false],
    ["another port on the same name", facts("https://app.example.test:8443", null), false],
    ["Origin: null from a same-origin form (no-referrer page)", facts("null", "same-origin"), true],
    ["Origin: null from another site", facts("null", "cross-site"), false],
    ["Origin: null from a sandboxed frame or a redirect chain (same-site, not same-origin)", facts("null", "same-site"), false],
    ["Origin: null and no Sec-Fetch-Site", facts("null", null), false],
    ["a request typed into the address bar", facts(null, "none"), true],
    ["no Origin but cross-site", facts(null, "cross-site"), false],
    ["no Origin and no Sec-Fetch-Site (a script or a test)", facts(null, null), true],
    ["an origin that is not a URL", facts("not a url", "same-origin"), false],
    ["an origin but no host to compare it with", facts(`https://${HOST}`, "same-origin", null), false],
  ])("%s", (_name, f, expected) => expect(isSameSite(f)).toBe(expected));

  it("reads the forwarded host before the host, like the rest of the app", () => {
    const req = new Request(`https://internal.example/x`, { method: "POST", headers: { origin: `https://${HOST}`, host: "internal.example", "x-forwarded-host": HOST } });
    expect(sameSiteRequest(req)).toBe(true);
  });

  it("is what the proposal and the invoice routes use", () => {
    const form = new Request(`https://${HOST}/api/public/proposals/t/code`, { method: "POST", headers: { origin: "null", "sec-fetch-site": "same-origin", host: HOST } });
    const foreign = new Request(`https://${HOST}/api/public/proposals/t/code`, { method: "POST", headers: { origin: "null", "sec-fetch-site": "cross-site", host: HOST } });
    expect(proposalSameSite(form)).toBe(true);
    expect(invoiceSameSite(form)).toBe(true);
    expect(proposalSameSite(foreign)).toBe(false);
    expect(invoiceSameSite(foreign)).toBe(false);
  });
});
