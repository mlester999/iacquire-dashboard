// The purchase invitation email as the buyer receives it: its words, its mobile-friendly branded HTML and the plain-text alternative, and what the outbox is allowed to keep. Pure:
// no database and no provider. The rules about WHEN it is sent, retried and recorded are in purchase-invitation-delivery.test.ts.
import { describe, expect, it } from "vitest";
import { buildInvitationEmail, formatExpiry, LINK_NOT_STORED, maskPurchaseLinks, type InvitationEmailInput } from "@/lib/purchase-intents/delivery";
import { renderEmail } from "@/server/email-render";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde".slice(0, 43);
const BASE = "https://www.iacquire.online";
const LINK = `${BASE}/purchase/${TOKEN}`;
const input = (over: Partial<InvitationEmailInput> = {}): InvitationEmailInput => ({
  kind: "invitation", buyerName: "Bailey Buyer", company: "Harborview Realty Group", reference: "PUR-ABCD2345EF", setupFeeCents: 149900, maintenanceSelected: true, maintenanceMonthlyCents: 29900,
  expiresAt: "2026-11-16T12:00:00.000Z", timezone: "America/Chicago", link: LINK, ...over,
});
const render = (over: Partial<InvitationEmailInput> = {}, base = BASE) => {
  const built = buildInvitationEmail(input(over));
  return { built, ...renderEmail({ to: "bailey@example.test", template: "purchase_invitation", subject: built.subject, text: built.text }, { baseUrl: base }) };
};

describe("what the email says", () => {
  it("greets the buyer by first name and carries the company, price, optional plan, reference, expiry and link", () => {
    const { text, subject } = buildInvitationEmail(input());
    expect(subject).toBe("Your iAcquireOS purchase invitation for Harborview Realty Group");
    expect(text).toContain("Hi Bailey,");
    expect(text).toContain("Company: Harborview Realty Group");
    expect(text).toContain("One-time setup: $1,499");
    expect(text).toContain("Maintenance plan: $299/month, selected. It is billed separately: nothing is charged for it now.");
    expect(text).toContain("Reference: PUR-ABCD2345EF");
    expect(text).toContain("Link expires: November 16, 2026 at 6:00 AM CST");
    expect(text).toContain(`Review your purchase: ${LINK}`);
    expect(text).toContain("Nothing is charged until you choose to pay");
    expect(text).toContain("Please do not forward it.");
  });

  it("describes the optional plan as optional and not selected when it was not chosen", () => {
    const { text } = buildInvitationEmail(input({ maintenanceSelected: false }));
    expect(text).toContain("Maintenance plan: Optional, $299/month. Not selected.");
  });

  it("tells a buyer who is sent a new link that it replaces the earlier one", () => {
    const { text, subject } = buildInvitationEmail(input({ kind: "resend" }));
    expect(subject).toBe("Your new iAcquireOS purchase link for Harborview Realty Group");
    expect(text).toContain("replaces the link we emailed earlier, which no longer works");
  });

  it("writes the expiry in the buyer's zone and falls back to UTC for a zone it does not know", () => {
    expect(formatExpiry("2026-11-16T12:00:00.000Z", "Asia/Manila")).toMatch(/November 16, 2026 at 8:00 PM/);
    expect(formatExpiry("2026-11-16T12:00:00.000Z", "Not/AZone")).toBe("November 16, 2026 (UTC)");
  });

  it("strips control and direction-override characters from names so a hostile company cannot reorder the email", () => {
    const { text } = buildInvitationEmail(input({ company: "Acme‮ Co\u0000\n\nLink expires: tomorrow", buyerName: "‮Evil\nPerson" }));
    expect(text).not.toMatch(/[‮\u0000]/);
    expect(text.split("\n").filter((l) => l.startsWith("Company:"))).toHaveLength(1);
    expect(text.split("\n").filter((l) => l.startsWith("Link expires:"))).toHaveLength(1);
  });
});

describe("what the outbox may keep", () => {
  it("keeps the same words with the link cut out, whatever the token or the address", () => {
    const built = buildInvitationEmail(input());
    expect(built.text).toContain(TOKEN);
    expect(built.storedText).not.toContain(TOKEN);
    expect(built.storedText).toContain(`Review your purchase: ${BASE}/purchase/${LINK_NOT_STORED}`);
    expect(built.storedText).toContain("Company: Harborview Realty Group");
    const odd = buildInvitationEmail(input({ link: "https://example.test/purchase/not-a-real-looking-token-but-still-secret" }));
    expect(odd.storedText).not.toContain("not-a-real-looking-token-but-still-secret");
  });

  it("masks any purchase link in a text, in both shapes", () => {
    expect(maskPurchaseLinks(`see ${LINK} and /purchase/${TOKEN}.`)).not.toContain(TOKEN);
    expect(maskPurchaseLinks("nothing to mask here")).toBe("nothing to mask here");
  });
});

describe("the branded HTML", () => {
  it("is a mobile-responsive, dark-mode-aware email with one button to the buyer's link and the plain text as its alternative", () => {
    const { html, text, built } = render();
    expect(text).toBe(built.text);
    expect(html).toContain('<meta name="viewport" content="width=device-width,initial-scale=1">');
    expect(html).toContain("@media only screen and (max-width:620px)");
    expect(html).toContain("@media (prefers-color-scheme:dark)");
    expect(html).toContain('class="em-btn"');
    expect(html).toContain(`href="${LINK}"`);
    expect(html).toContain("Review your purchase");
    // The offer, as cards and rows, readable at 320px (a single column of table cells, no fixed widths over 560).
    for (const word of ["Harborview Realty Group", "PUR-ABCD2345EF", "One-time setup", "$1,499", "Maintenance plan", "$299/month", "Link expires", "November 16, 2026"]) expect(html).toContain(word);
    expect(html).toContain("max-width:560px");
    expect(html).not.toMatch(/width="(56[1-9]|5[7-9]\d|[6-9]\d\d)"/);
    // A link to paste when the button is blocked, and the fine print.
    expect(html).toContain("Or paste this link into your browser");
    expect(html).toContain("Please do not forward it.");
  });

  it("links only to the site's own address", () => {
    const { html } = render();
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(1);
    for (const href of hrefs) expect(new URL(href).origin, href).toBe(BASE);
  });

  it("escapes a hostile company or buyer name instead of rendering it", () => {
    const { html } = render({ company: '<img src=x onerror="alert(1)">Co', buyerName: "<script>alert(1)</script> Bob" });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain('<img src=x onerror="alert(1)">');
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;Co");
  });

  it("draws no remote images for a local or insecure address, so it works with images blocked", () => {
    const { html } = render({}, "http://localhost:3000");
    expect(html).not.toContain("<img");
    expect(html).toContain("Review your purchase");
  });
});
