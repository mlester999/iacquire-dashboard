import { afterEach, describe, expect, it, vi } from "vitest";
import { renderEmail } from "@/server/email-render";
import { sendEmail, type EmailTemplate, type OutgoingEmail } from "@/server/email";
import { resetEnvCache } from "@/server/env";

const BASE = "https://app.iacquire.example";
const TOKEN = "tok_abcDEF123_-xyz";

const invitation: OutgoingEmail = {
  to: "priya@sunrise.example",
  template: "invitation",
  subject: "You're invited to Sunrise Clinic on iAcquire",
  text: `You've been invited to join Sunrise Clinic's iAcquire workspace.\n\nInvited by: Maria Lopez\nRole: Manager\n\nAccept your invitation: ${BASE}/invite/${TOKEN}\n\nThis invitation expires in 7 days.`,
};

const render = (e: OutgoingEmail, opts: { baseUrl?: string; images?: "auto" | "always" } = {}) => renderEmail(e, { baseUrl: BASE, ...opts });
const html = (e: OutgoingEmail) => render(e).html;

describe("branded email rendering", () => {
  it("renders the invitation with the organisation, who invited you, the role, a button and the expiry", () => {
    const out = html(invitation);
    expect(out).toContain("<!doctype html>");
    expect(out).toContain("Join Sunrise Clinic on ");
    expect(out).toContain("Joining as Manager");
    expect(out).toContain("Invited by Maria Lopez");
    expect(out).toContain("Maria Lopez invited you to join Sunrise Clinic on iAcquire.");
    expect(out).toContain(`href="${BASE}/invite/${TOKEN}"`);
    expect(out).toContain("Accept invitation");
    expect(out).toContain("expires in 7 days");
    expect(out).toContain(`${BASE}/brand/iacquire-mark.png`);
    expect(out).toContain("prefers-color-scheme:dark");
  });

  it("keeps a very long organisation name out of the headline and in the workspace card", () => {
    const org = "Northwind Mid-Atlantic Orthodontic & Pediatric Dentistry Partners, LLP";
    const out = html({ ...invitation, subject: `You're invited to ${org} on iAcquire`, text: `You've been invited to join ${org}'s iAcquire workspace.\n\nAccept your invitation: ${BASE}/invite/${TOKEN}\n\nThis invitation expires in 7 days.` });
    expect(out).toContain("You're invited to ");
    expect(out).not.toContain("Join Northwind");
    expect(out).toContain(">Northwind Mid-Atlantic Orthodontic &amp; Pediatric Dentistry Partners, LLP</div>");
  });

  it("keeps the original plain text and subject untouched as the fallback part", () => {
    const out = render(invitation);
    expect(out.text).toBe(invitation.text);
    expect(out.subject).toBe(invitation.subject);
  });

  it("states the password-reset expiry once, in plain words, with a lock tile and the reassurance", () => {
    const out = html({
      to: "daniel@harbor.example",
      template: "password_reset",
      subject: "Reset your iAcquire password",
      text: `We received a request to reset your iAcquire password.\n\nReset it here: ${BASE}/reset-password?token=${TOKEN}\n\nThis link expires in 60 minutes and can be used once. If you didn't ask for this, you can ignore this email — your password stays the same.`,
    });
    expect(out).toContain("The link expires in 60 minutes and works once.");
    expect(out).not.toContain("once and works once");
    expect(out).toContain("Reset password");
    expect(out).toContain(`${BASE}/brand/email/lock.png`);
    expect(out).toContain("Didn't ask for this?");
  });

  it("treats a one-line title that contains a colon as a headline, not a detail row", () => {
    const out = html({ to: "a@b.example", template: "notification", subject: "Approval needed: send follow-up to 3 leads", text: `Approval needed: send follow-up to 3 leads\n\nYour assistant is waiting.\n\nOpen in iAcquire: ${BASE}/approvals\n\nYou can change which notifications are emailed in Settings.` });
    expect(out).toContain(">Approval needed: send follow-up to 3 leads</h1>");
    expect(out).toContain("Open in iAcquire");
    expect(out.indexOf("Your assistant is waiting.")).toBeLessThan(out.indexOf(`href="${BASE}/approvals"`));
    expect(out).toContain("/settings/notifications");
  });

  it("shows an urgent escalation with a priority strip and a red-tinted header, and puts the closing note under the button", () => {
    const out = html({ to: "t@a.example", template: "escalation_alert", subject: "[Urgent] Complaint: customer needs a person", tone: "critical", tag: "Urgent", text: `Open the conversation to take it. The first person to accept it owns it.\n\nPriority: Urgent\nType: Complaint\nOpen it: ${BASE}/inbox?c=1\n\nSign in to see the conversation.` });
    expect(out).toContain("Urgent</td>");
    expect(out).toContain("#4a1620");
    expect(out).toContain(">Priority</div>");
    expect(out).toContain(">Complaint</div>");
    expect(out).toContain(">Complaint: customer needs a person</h1>");
    expect(out.indexOf(`href="${BASE}/inbox?c=1"`)).toBeLessThan(out.indexOf("Sign in to see the conversation."));
  });

  it("does not paint a routine or FYI escalation as urgent", () => {
    const fyi = html({ to: "t@a.example", template: "escalation_alert", subject: "FYI: Complaint: a teammate has first priority", tone: "info", text: `Another teammate has first priority.\n\nPriority: Normal\nType: Complaint\nOpen it: ${BASE}/inbox?c=1` });
    expect(fyi).toContain("For your information");
    expect(fyi).not.toContain("#4a1620");
    expect(fyi).toContain(">Complaint: a teammate has first priority</h1>");
  });

  it("only lets a link on our own domain become the button, and the last one wins, so customer text can never hijack the action", () => {
    const out = html({ to: "x@a.example", template: "notification", subject: "New lead", text: `New lead: Alex\n\nAlex wrote: look at https://evil.example/phish\nVisit: https://evil.example/login\n\nOpen in iAcquire: ${BASE}/leads/42\n\nYou can change which notifications are emailed in Settings.` });
    const button = /<a href="([^"]+)" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:15px 30px/.exec(out);
    expect(button?.[1]).toBe(`${BASE}/leads/42`);
    // No external link may be offered as the paste-in fallback either.
    expect(out).toContain(`${BASE}/leads/42</a>`);
    // With no first-party link at all, nothing becomes a button.
    const none = html({ to: "x@a.example", template: "notification", subject: "Hi", text: "Hi\n\nSee https://evil.example/x" });
    expect(none).not.toContain("display:inline-block;padding:15px 30px");
  });

  it("escapes anything a sender or a user could put in the text, and never links a non-http URL", () => {
    const out = html({ to: "x@a.example", template: "notification", subject: "<script>alert(1)</script>", text: `<img src=x onerror=alert(1)>\n\nHello <b>bold</b> & "quotes"\n\nOpen in iAcquire: javascript:alert(1)` });
    expect(out).not.toContain("<script>alert(1)</script>");
    expect(out).not.toContain("<img src=x");
    expect(out).not.toContain("<b>bold</b>");
    expect(out).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(out).not.toMatch(/href="javascript:/i);
  });

  it("keeps the invite link on the button when the inviter's name is itself a link, and shows that name as inert text", () => {
    const out = html({ ...invitation, text: `x\n\nInvited by: https://evil.example/verify\nRole: Manager\n\nAccept your invitation: ${BASE}/invite/${TOKEN}\n\nThis invitation expires in 7 days.` });
    expect(out).toContain(`href="${BASE}/invite/${TOKEN}"`);
    expect(out).not.toMatch(/href="https:\/\/evil/);
  });

  it("anchors only our own links in body text and keeps trailing punctuation out of the href", () => {
    const out = html({ to: "a@b.example", template: "setup_update", subject: "Hi", text: `Hi\n\nRead https://docs.example/crm, then (see ${BASE}/help).\n\nOpen your Setup Center: ${BASE}/setup` });
    expect(out).not.toMatch(/href="https:\/\/docs\.example/);
    expect(out).toContain(`href="${BASE}/help"`);
    expect(out).not.toContain(`href="${BASE}/help)`);
    expect(out).toContain(`href="${BASE}/setup"`);
  });

  it("rejects look-alike origins as the button: userinfo, sub-domain suffix, scheme downgrade and a different port", () => {
    for (const bad of ["https://app.iacquire.example@evil.example/x", "https://app.iacquire.example.evil.example/x", "http://app.iacquire.example/x", "https://app.iacquire.example:8443/x"]) {
      const out = html({ to: "a@b.example", template: "notification", subject: "T", text: `T\n\nOpen in iAcquire: ${bad}` });
      expect(out).not.toContain("display:inline-block;padding:15px 30px");
    }
  });

  it("removes control and bidi-override characters from displayed names", () => {
    const out = html({ ...invitation, subject: "You're invited to Acme\u202Eevil\u0007 on iAcquire" });
    expect(out).not.toMatch(/[\u202A-\u202E\u2066-\u2069\u0007]/);
  });

  it("handles pathological whitespace in linear time", () => {
    const started = Date.now();
    html({ to: "a@b.example", template: "notification", subject: "T", text: `T\n\n${" ".repeat(20000)}x${" ".repeat(20000)}: ${BASE}/a` });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("never puts body text in the preheader", () => {
    const out = html({ to: "a@b.example", template: "notification", subject: "Payment failed", text: `Payment failed\n\nYour verification code is 482913.\n\nOpen in iAcquire: ${BASE}/billing` });
    expect(out.slice(0, out.indexOf("</head>"))).not.toContain("482913");
    const hidden = /display:none;max-height:0[^>]*>([^<]*)</.exec(out)?.[1] ?? "";
    expect(hidden).not.toContain("482913");
  });

  it("escapes organisation names and inviter names in the invitation", () => {
    const out = html({ ...invitation, subject: `You're invited to <i>Evil</i> & Co on iAcquire`, text: `x\n\nInvited by: <b>Mallory</b>\nRole: Manager\n\nAccept your invitation: ${BASE}/invite/${TOKEN}` });
    expect(out).not.toContain("<b>Mallory</b>");
    expect(out).not.toContain("<i>Evil</i>");
    expect(out).toContain("&lt;b&gt;Mallory&lt;/b&gt;");
  });

  it("gives classic Outlook a VML button and every client a padded link, with no external font or tracker requests", () => {
    const out = html(invitation);
    expect(out).toContain("<v:roundrect");
    expect(out).toContain("<!--[if mso]>");
    expect(out).toContain("display:inline-block;padding:15px 30px");
    expect(out).not.toMatch(/fonts\.googleapis|fonts\.gstatic/);
    expect(out.match(/<img /g)?.length).toBe(1); // only the logo
  });

  it("shows images only from a public https origin, and keeps a lettermark when it can't", () => {
    const local = renderEmail({ ...invitation, text: invitation.text.replaceAll(BASE, "http://localhost:3000") }, { baseUrl: "http://localhost:3000" }).html;
    expect(local).not.toContain("<img ");
    expect(local).toContain(">A</div>");
    const forced = renderEmail({ ...invitation, text: invitation.text.replaceAll(BASE, "http://localhost:3000") }, { baseUrl: "http://localhost:3000", images: "always" }).html;
    expect(forced).toContain("<img ");
    expect(html(invitation)).toContain("<img ");
  });

  it("never leaves light-mode text colours that dark mode cannot override", () => {
    const samples: OutgoingEmail[] = [
      invitation,
      { to: "a@b.example", template: "password_reset", subject: "Reset", text: `Hi\n\nReset it here: ${BASE}/r?t=1\n\nThis link expires in 60 minutes and can be used once.` },
      { to: "a@b.example", template: "escalation_alert", subject: "[Urgent] X: customer needs a person", text: `Go.\n\nPriority: Urgent\nType: X\nOpen it: ${BASE}/i\n\nSign in.` },
      { to: "a@b.example", template: "notification", subject: "T", tone: "warning", text: `T\n\nBody\n\nKey: value\nOther: thing\n\nOpen in iAcquire: ${BASE}/n\n\nYou can change which notifications are emailed in Settings.` },
    ];
    const needs: Array<[string, RegExp]> = [
      ["color:#353d4e", /em-ink2/],
      ["color:#646d80", /em-muted/],
      ["color:#0a0d14", /em-ink|em-urgent/],
    ];
    for (const e of samples) {
      for (const tag of html(e).match(/<(?:td|p|span|div|strong|a)\b[^>]*>/g) ?? []) {
        for (const [colour, cls] of needs) {
          if (tag.includes(colour)) expect(tag, `${e.template}: ${tag.slice(0, 120)}`).toMatch(cls);
        }
        if (/^<a\b/.test(tag) && tag.includes("color:#2c5bff")) expect(tag).toMatch(/em-link/);
      }
    }
  });

  it("renders every template to a complete document, with or without a link", () => {
    const templates: EmailTemplate[] = ["invitation", "staff_invitation", "verify_email", "password_reset", "support_reply", "setup_update", "escalation_alert", "notification"];
    for (const template of templates) {
      for (const text of [`Hello there\n\nOpen it: ${BASE}/x`, "Just a sentence with no link."]) {
        const out = html({ to: "a@b.example", template, subject: "Subject line", text });
        expect(out.startsWith("<!doctype html>")).toBe(true);
        expect(out.trimEnd().endsWith("</html>")).toBe(true);
        expect(out).toContain("iAcquire");
        expect((out.match(/<table/g) ?? []).length).toBe((out.match(/<\/table>/g) ?? []).length);
      }
    }
  });
});

describe("email delivery sends the design", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.EMAIL_PROVIDER;
    delete process.env.RESEND_API_KEY;
    delete process.env.APP_URL;
    resetEnvCache();
  });

  it("posts both an HTML body and the plain-text fallback to the provider", async () => {
    let body: { html?: string; text?: string; subject?: string } = {};
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      body = JSON.parse(init.body);
      return new Response("{}", { status: 200 });
    });
    process.env.EMAIL_PROVIDER = "resend";
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.APP_URL = BASE;
    resetEnvCache();
    const res = await sendEmail(invitation, undefined, { wait: true });
    expect(res.status).toBe("sent");
    expect(body.text).toBe(invitation.text);
    expect(body.subject).toBe(invitation.subject);
    expect(body.html).toContain("Join Sunrise Clinic on ");
    expect(body.html).toContain(`${BASE}/invite/${TOKEN}`);
  });
});
