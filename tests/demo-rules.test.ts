// The pure rules of the demo funnel: when a window is open, how many messages are left, what an extension may do, which state can follow which, when details are due to be
// removed, and what text from a stranger is accepted. No database, clock or network: every edge is walked with a date written in the test.
import { describe, expect, it } from "vitest";
import {
  accessOf, canTransition, chatRefusalFor, cleanLine, cleanMessage, cleanUtm, effectiveStatus, isClientMessageId, isDemoToken, messageAllowance, messagesLeft, PROSPECT_STATUSES,
  planExtension, REFUSAL_COPY, reopenTarget, retentionAction, retentionAnchor, transitionsFrom, windowIsOpen, UNVERIFIED_RETENTION_DAYS, type ExtensionFacts, type ProspectFacts,
  type ProspectStatus,
} from "@/lib/demo/rules";
import { emailDomain, firstNameOf, isBlockedDomain, isDomainName, looksLikeEmail, normalizeProspectEmail, typedEmail } from "@/lib/demo/email";
import { checkSettingsPatch, DEMO_DEFAULTS, DEMO_RANGES, isConsultationUrl } from "@/lib/demo/settings";
import { DEMO_EVENT_KINDS, DEMO_EVENT_LABELS, DEMO_NOTIFICATION_KINDS } from "@/lib/demo/events";
import { DEMO_INDUSTRIES, demoIndustryLabel, isDemoIndustry } from "@/lib/demo/industries";
import { demoNotice, NOTICE_VERSION } from "@/lib/demo/notice";

const T = new Date("2026-11-10T12:00:00.000Z");
const ms = (n: number) => new Date(T.getTime() + n);
const H = 3_600_000;
const D = 86_400_000;

const facts = (over: Partial<ProspectFacts> = {}): ProspectFacts => ({
  status: "active", verifiedAt: T, windowEndsAt: ms(24 * H), messageLimit: 10, extraMessages: 0, messagesUsed: 0, erasedAt: null, ...over,
});

describe("the window", () => {
  it("is open strictly before it ends: the last millisecond is inside, the very moment is outside", () => {
    const end = ms(24 * H);
    expect(windowIsOpen(end, ms(24 * H - 1))).toBe(true);
    expect(windowIsOpen(end, end)).toBe(false);
    expect(windowIsOpen(end, ms(24 * H + 1))).toBe(false);
    expect(windowIsOpen(end, ms(0))).toBe(true);
    expect(windowIsOpen(null, ms(0))).toBe(false);
  });

  it("reads a prospect from the facts and the clock", () => {
    expect(accessOf(facts(), ms(1))).toBe("open");
    expect(accessOf(facts(), ms(24 * H))).toBe("ended");
    expect(accessOf(facts({ status: "unverified", verifiedAt: null, windowEndsAt: null }), ms(1))).toBe("unverified");
    expect(accessOf(facts({ status: "active", verifiedAt: null }), ms(1))).toBe("unverified");
    expect(accessOf(facts({ status: "blocked" }), ms(1))).toBe("blocked");
    expect(accessOf(facts({ status: "declined" }), ms(1))).toBe("blocked");
    expect(accessOf(facts({ status: "converted" }), ms(1))).toBe("converted");
    expect(accessOf(facts({ erasedAt: ms(5) }), ms(1))).toBe("erased");
    // Erased wins over everything, converted over the clock.
    expect(accessOf(facts({ status: "blocked", erasedAt: ms(5) }), ms(1))).toBe("erased");
    expect(accessOf(facts({ status: "converted" }), ms(48 * H))).toBe("converted");
  });

  it("shows a window that ended as expired before the job says so, and keeps what a prospect asked for", () => {
    expect(effectiveStatus(facts(), ms(1))).toBe("active");
    expect(effectiveStatus(facts(), ms(24 * H))).toBe("expired");
    expect(effectiveStatus(facts({ status: "consultation_requested" }), ms(48 * H))).toBe("consultation_requested");
    expect(effectiveStatus(facts({ status: "purchase_started" }), ms(48 * H))).toBe("purchase_started");
    expect(effectiveStatus(facts({ status: "blocked" }), ms(48 * H))).toBe("blocked");
  });
});

describe("the message allowance", () => {
  it("is the limit plus what was added, less what was used, and never negative", () => {
    expect(messageAllowance({ messageLimit: 10, extraMessages: 5 })).toBe(15);
    expect(messagesLeft({ messageLimit: 10, extraMessages: 0, messagesUsed: 0 })).toBe(10);
    expect(messagesLeft({ messageLimit: 10, extraMessages: 0, messagesUsed: 9 })).toBe(1);
    expect(messagesLeft({ messageLimit: 10, extraMessages: 0, messagesUsed: 10 })).toBe(0);
    expect(messagesLeft({ messageLimit: 10, extraMessages: 0, messagesUsed: 12 })).toBe(0);
    expect(messagesLeft({ messageLimit: 10, extraMessages: 5, messagesUsed: 10 })).toBe(5);
  });

  it("explains a refusal in the order the reasons are tried: the final one wins", () => {
    const cases: Array<[Partial<ProspectFacts>, Date, ReturnType<typeof chatRefusalFor>]> = [
      [{}, ms(1), null],
      [{ messagesUsed: 10 }, ms(1), "limit_reached"],
      [{ messagesUsed: 10 }, ms(24 * H), "window_ended"],
      [{ messagesUsed: 9 }, ms(24 * H - 1), null],
      [{ status: "unverified", verifiedAt: null, windowEndsAt: null }, ms(1), "not_verified"],
      [{ status: "blocked", messagesUsed: 10 }, ms(48 * H), "blocked"],
      [{ status: "converted" }, ms(1), "closed"],
      [{ erasedAt: ms(0), status: "converted" }, ms(1), "blocked"],
    ];
    for (const [over, now, expected] of cases) expect(chatRefusalFor(facts(over), now), JSON.stringify(over)).toBe(expected);
    for (const r of ["closed", "blocked", "not_verified", "window_ended", "limit_reached", "ai_off", "daily_cap", "rate_limited", "unavailable", "invalid"] as const) expect(REFUSAL_COPY[r].length).toBeGreaterThan(10);
  });
});

describe("the state machine", () => {
  const ALL = [...PROSPECT_STATUSES];

  it("has a fixed table that agrees with itself for every pair", () => {
    for (const from of ALL) for (const to of ALL) expect(canTransition(from, to), `${from} -> ${to}`).toBe(transitionsFrom(from).includes(to));
  });

  it("never moves a state to itself, and ends at a client", () => {
    for (const s of ALL) expect(canTransition(s, s), s).toBe(false);
    expect(transitionsFrom("converted")).toEqual([]);
    for (const s of ALL.filter((x) => x !== "converted")) expect(ALL.some((to) => canTransition(s, to)), `${s} has a way on`).toBe(true);
  });

  it("makes the first step only the confirmation, and a client only from someone who started", () => {
    expect(transitionsFrom("unverified")).toEqual(["active", "declined", "blocked"]);
    for (const from of ALL) {
      if (from === "unverified" || from === "blocked" || from === "declined" || from === "converted") expect(canTransition(from, "converted"), from).toBe(false);
      else expect(canTransition(from, "converted"), from).toBe(true);
    }
    // Nobody who did not confirm can be expired, asked to consult, or buying.
    for (const to of ["expired", "consultation_requested", "purchase_started"] as const) expect(canTransition("unverified", to), to).toBe(false);
  });

  it("reaches every state from the start by some path, and no path leaves a client", () => {
    const seen = new Set<ProspectStatus>(["unverified"]);
    const queue: ProspectStatus[] = ["unverified"];
    while (queue.length) {
      const s = queue.shift() as ProspectStatus;
      for (const to of transitionsFrom(s)) {
        if (seen.has(to)) continue;
        seen.add(to);
        queue.push(to);
      }
    }
    expect([...seen].sort()).toEqual([...ALL].sort());
  });

  it("keeps the invariants through ten thousand random moves: access follows the clock, never a status alone", () => {
    // A small deterministic generator, so a failure repeats.
    let seed = 20261110;
    const next = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
    let status: ProspectStatus = "unverified";
    let verifiedAt: Date | null = null;
    let windowEndsAt: Date | null = null;
    for (let i = 0; i < 10_000; i += 1) {
      const to = ALL[Math.floor(next() * ALL.length)];
      if (canTransition(status, to)) {
        status = to;
        if (to === "active" && !verifiedAt) {
          verifiedAt = ms(i);
          windowEndsAt = ms(i + 24 * H);
        }
      }
      const now = ms(Math.floor(next() * 72 * H));
      const f = facts({ status, verifiedAt, windowEndsAt });
      const access = accessOf(f, now);
      if (status === "converted") expect(access).toBe("converted");
      if (status === "blocked" || status === "declined") expect(chatRefusalFor(f, now)).toBe("blocked");
      if (!verifiedAt) expect(access === "unverified" || access === "blocked" || access === "converted").toBe(true);
      if (access === "open") expect(windowIsOpen(windowEndsAt, now)).toBe(true);
      if (chatRefusalFor(f, now) === null) expect(access).toBe("open");
    }
  });
});

describe("extending a demo", () => {
  const CAPS = { maxExtensionHours: 72, maxExtraMessages: 20 };
  const base = (over: Partial<ExtensionFacts> = {}): ExtensionFacts => ({
    status: "active", verifiedAt: T, windowEndsAt: ms(24 * H), extendedHours: 0, extendedCount: 0, extraMessages: 0, erasedAt: null, ...over,
  });
  const ask = (over: Partial<{ hours: unknown; extraMessages: unknown; reason: unknown }> = {}) => ({ hours: 6, extraMessages: 0, reason: "Asked on a call", ...over });
  const plan = (p: ExtensionFacts, r: ReturnType<typeof ask>, now = ms(H)) => planExtension(p, r, CAPS, now);

  it("adds hours to the end of an open window and messages to the count, and counts the extension", () => {
    const r = plan(base(), ask({ hours: 12, extraMessages: 5 }));
    expect(r).toEqual({ ok: true, plan: { windowEndsAt: ms(36 * H), extendedHours: 12, extendedCount: 1, extraMessages: 5, reactivates: false, reason: "Asked on a call" } });
    const again = plan(base({ extendedHours: 12, extendedCount: 1, extraMessages: 5, windowEndsAt: ms(36 * H) }), ask({ hours: 1, extraMessages: 1 }));
    expect(again).toMatchObject({ ok: true, plan: { windowEndsAt: ms(37 * H), extendedHours: 13, extendedCount: 2, extraMessages: 6 } });
  });

  it("opens an ended window again from now, not from its old end, and makes an expired prospect active", () => {
    const now = ms(100 * H);
    const r = plan(base({ status: "expired" }), ask({ hours: 24 }), now);
    expect(r).toMatchObject({ ok: true, plan: { windowEndsAt: ms(124 * H), reactivates: true } });
    // A prospect whose status still says active but whose window is over is reopened from now too, without a status change.
    expect(plan(base(), ask({ hours: 24 }), now)).toMatchObject({ ok: true, plan: { windowEndsAt: ms(124 * H), reactivates: false } });
    // Messages alone cannot reopen an ended window.
    expect(plan(base({ status: "expired" }), ask({ hours: 0, extraMessages: 5 }), now)).toMatchObject({ ok: false, message: "The window has ended. Add hours to open it again." });
    // Messages alone on an open window leave its end exactly where it was.
    expect(plan(base(), ask({ hours: 0, extraMessages: 5 }))).toMatchObject({ ok: true, plan: { windowEndsAt: ms(24 * H), extraMessages: 5 } });
  });

  it("holds the totals, over the prospect's whole life, at the caps: the cap itself is allowed and one more is not", () => {
    expect(plan(base(), ask({ hours: 72, extraMessages: 20 }))).toMatchObject({ ok: true });
    expect(plan(base(), ask({ hours: 73 }))).toMatchObject({ ok: false, message: "You can add at most 72 more hours to this demo." });
    expect(plan(base(), ask({ hours: 0, extraMessages: 21 }))).toMatchObject({ ok: false, message: "You can add at most 20 more messages to this demo." });
    const used = base({ extendedHours: 70, extraMessages: 19 });
    expect(plan(used, ask({ hours: 2, extraMessages: 1 }))).toMatchObject({ ok: true });
    expect(plan(used, ask({ hours: 3 }))).toMatchObject({ ok: false, message: "You can add at most 2 more hours to this demo." });
    expect(plan(used, ask({ hours: 1, extraMessages: 2 }))).toMatchObject({ ok: false, message: "You can add at most 1 more message to this demo." });
    expect(plan(base({ extendedHours: 72 }), ask({ hours: 1 }))).toMatchObject({ ok: false, message: "This demo has already had the most extra hours it can have." });
    expect(plan(base({ extraMessages: 20 }), ask({ hours: 0, extraMessages: 1 }))).toMatchObject({ ok: false, message: "This demo has already had the most extra messages it can have." });
    expect(planExtension(base(), ask({ hours: 1 }), { maxExtensionHours: 0, maxExtraMessages: 0 }, ms(H))).toMatchObject({ ok: false });
  });

  it("needs a reason of a few words, kept to one line, and whole numbers", () => {
    for (const reason of [undefined, null, 5, "", "   ", "no", "\n\t ok \n"]) expect(plan(base(), ask({ reason })), String(reason)).toMatchObject({ ok: false });
    expect(plan(base(), ask({ reason: "x".repeat(501) }))).toMatchObject({ ok: false, message: "The reason can be up to 500 characters." });
    expect(plan(base(), ask({ reason: "  two   spaces\nand a line  " }))).toMatchObject({ ok: true, plan: { reason: "two spaces and a line" } });
    for (const hours of [1.5, -1, "3", NaN, Infinity, null, undefined, Number.MAX_SAFE_INTEGER + 2]) expect(plan(base(), ask({ hours })), String(hours)).toMatchObject({ ok: false });
    expect(plan(base(), ask({ hours: 0, extraMessages: 0 }))).toMatchObject({ ok: false, message: "Add some hours, some messages, or both." });
  });

  it("refuses a prospect who has not started, is blocked, is a client or was erased, saying which", () => {
    expect(plan(base({ status: "unverified", verifiedAt: null, windowEndsAt: null }), ask())).toMatchObject({ ok: false, message: expect.stringContaining("has not confirmed") });
    expect(plan(base({ status: "blocked" }), ask())).toMatchObject({ ok: false, message: expect.stringContaining("blocked or declined") });
    expect(plan(base({ status: "declined" }), ask())).toMatchObject({ ok: false, message: expect.stringContaining("blocked or declined") });
    expect(plan(base({ status: "converted" }), ask())).toMatchObject({ ok: false, message: "This prospect is already a client." });
    expect(plan(base({ erasedAt: ms(1) }), ask())).toMatchObject({ ok: false, message: expect.stringContaining("erased") });
    for (const status of ["consultation_requested", "purchase_started", "expired"] as const) expect(plan(base({ status }), ask()), status).toMatchObject({ ok: true });
  });
});

describe("reopening", () => {
  it("returns a prospect to what they had reached, or to what their window says", () => {
    const f = (over: Partial<ProspectFacts>) => facts({ status: "blocked", ...over });
    expect(reopenTarget(f({ verifiedAt: null, windowEndsAt: null }), ms(1))).toBe("unverified");
    expect(reopenTarget(f({}), ms(1))).toBe("active");
    expect(reopenTarget(f({}), ms(24 * H))).toBe("expired");
    expect(reopenTarget(f({ consultationRequestedAt: ms(5) }), ms(48 * H))).toBe("consultation_requested");
    expect(reopenTarget(f({ consultationRequestedAt: ms(5), purchaseStartedAt: ms(9) }), ms(1))).toBe("purchase_started");
  });
});

describe("retention", () => {
  const person = (over: Partial<Parameters<typeof retentionAction>[0]> = {}) => ({
    status: "active" as ProspectStatus, verifiedAt: T as Date | null, windowEndsAt: ms(24 * H) as Date | null, lastSeenAt: null as Date | null, createdAt: T, erasedAt: null as Date | null, ...over,
  });

  it("deletes someone who never confirmed at seven days exactly", () => {
    expect(UNVERIFIED_RETENTION_DAYS).toBe(7);
    const u = person({ status: "unverified", verifiedAt: null, windowEndsAt: null });
    expect(retentionAction(u, ms(7 * D - 1), 90)).toBeNull();
    expect(retentionAction(u, ms(7 * D), 90)).toBe("delete");
    expect(retentionAction(u, ms(400 * D), 90)).toBe("delete");
  });

  it("erases a prospect when the period has passed since the latest of the window's end, the last visit and the day they asked, to the millisecond", () => {
    const end = 24 * H;
    expect(retentionAction(person(), ms(end + 90 * D - 1), 90)).toBeNull();
    expect(retentionAction(person(), ms(end + 90 * D), 90)).toBe("erase");
    // A later visit moves the clock; an earlier one does not.
    const visited = person({ lastSeenAt: ms(10 * D) });
    expect(retentionAction(visited, ms(100 * D - 1), 90)).toBeNull();
    expect(retentionAction(visited, ms(100 * D), 90)).toBe("erase");
    expect(retentionAnchor(person({ lastSeenAt: ms(H) }))).toEqual(ms(end));
    expect(retentionAnchor(person({ windowEndsAt: null, lastSeenAt: null }))).toEqual(T);
    // The period is whatever the settings say.
    expect(retentionAction(person(), ms(end + 7 * D), 7)).toBe("erase");
    expect(retentionAction(person(), ms(end + 7 * D - 1), 7)).toBeNull();
  });

  it("leaves a client, a blocked prospect and an erased one alone, whatever their age", () => {
    for (const status of ["converted", "blocked"] as const) expect(retentionAction(person({ status }), ms(1000 * D), 90), status).toBeNull();
    expect(retentionAction(person({ erasedAt: ms(5) }), ms(1000 * D), 90)).toBeNull();
    for (const status of ["active", "expired", "consultation_requested", "purchase_started", "declined"] as const) expect(retentionAction(person({ status }), ms(1000 * D), 90), status).toBe("erase");
  });
});

describe("text from a stranger", () => {
  const RLO = String.fromCharCode(0x202e);
  const ZWSP = String.fromCharCode(0x200b);
  const BOM = String.fromCharCode(0xfeff);
  const NUL = String.fromCharCode(0);

  it("loses control characters, zero-width characters and direction overrides from a one-line field and keeps ordinary text", () => {
    expect(cleanLine(`Ann${RLO}e${ZWSP}${BOM}${NUL}  Lee `, 120)).toBe("Anne Lee");
    expect(cleanLine("line one\nline two\ttabbed", 120)).toBe("line one line two tabbed");
    expect(cleanLine("Zoë Müller-Ñuñez 李雷 🙂", 120)).toBe("Zoë Müller-Ñuñez 李雷 🙂");
    expect(cleanLine(42, 10)).toBe("");
    expect(cleanLine(null, 10)).toBe("");
  });

  it("keeps the lines of a chat message, shortens runs of blank lines, and strips the same characters", () => {
    expect(cleanMessage(`a${RLO}b\r\nc\n\n\n\n\nd${ZWSP}`)).toBe("ab\nc\n\nd");
    expect(cleanMessage("  hello  ")).toBe("hello");
    expect(cleanMessage({})).toBe("");
  });

  it("takes only the campaign tags it knows, short, and nothing else", () => {
    expect(cleanUtm({ utm_source: "newsletter", utm_medium: "email", evil: "x", utm_campaign: 5, ref: "y".repeat(500) })).toEqual({ utm_source: "newsletter", utm_medium: "email", ref: "y".repeat(100) });
    expect(cleanUtm("nope")).toEqual({});
    expect(cleanUtm(null)).toEqual({});
  });

  it("accepts only the keys and tokens the server hands out", () => {
    expect(isClientMessageId("abcdefgh")).toBe(true);
    expect(isClientMessageId("a".repeat(64))).toBe(true);
    for (const bad of ["abcdefg", "a".repeat(65), "has space ok", "semi;colon1", 12345678, null, undefined]) expect(isClientMessageId(bad), String(bad)).toBe(false);
    expect(isDemoToken("A".repeat(43))).toBe(true);
    for (const bad of ["A".repeat(42), "A".repeat(44), `${"A".repeat(42)}+`, "", null, 5]) expect(isDemoToken(bad), String(bad)).toBe(false);
  });

  it("never takes long to clean, however much and however hostile: twenty thousand characters of every kind", () => {
    const hostile = [
      "a".repeat(20_000), " ".repeat(20_000), "\n".repeat(20_000), `${"a ".repeat(10_000)}`, `${"a".repeat(10_000)}${ZWSP.repeat(10_000)}`, `${" ".repeat(19_999)}x`, `${"\n \n".repeat(7_000)}`,
    ];
    const started = Date.now();
    for (const text of hostile) {
      cleanLine(text, 120);
      cleanMessage(text);
      cleanUtm({ utm_source: text });
      typedEmail(text);
      looksLikeEmail(`${text}@${text}.com`);
      normalizeProspectEmail(`${text}+${text}@gmail.com`);
      isBlockedDomain(`a@${text}`, [text, "example.com"]);
      isDomainName(text);
      firstNameOf(text);
      planExtension({ status: "active", verifiedAt: T, windowEndsAt: ms(H), extendedHours: 0, extendedCount: 0, extraMessages: 0, erasedAt: null }, { hours: 1, extraMessages: 0, reason: text }, { maxExtensionHours: 72, maxExtraMessages: 20 }, ms(0));
    }
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe("email addresses", () => {
  it("recognises the shape of an address and refuses what cannot be one", () => {
    for (const ok of ["a@b.co", "first.last@example.com", "x+tag@sub.domain.example.org", "o'brien@example.ie", "UPPER@EXAMPLE.COM", "  padded@example.com  ", "a_b-c@my-domain.com"]) expect(looksLikeEmail(ok), ok).toBe(true);
    for (const bad of ["", "plain", "@example.com", "a@", "a@b", "a@b.", "a@.com", "a@@b.com", "a b@example.com", "a..b@example.com", ".a@example.com", "a.@example.com", "a@-b.com", "a@b-.com", "a@b.c", "a@b.12", "a@exa mple.com",`${"x".repeat(65)}@example.com`, `a@${"x".repeat(64)}.com`, `${"x".repeat(250)}@e.com`, 5, null, undefined, {}]) {
      expect(looksLikeEmail(bad), String(bad)).toBe(false);
    }
  });

  it("makes one key of every spelling of a mailbox: case, a plus tag, dots and googlemail for Gmail", () => {
    const same = ["jo.smith@gmail.com", "JoSmith@gmail.com", "josmith+offers@gmail.com", "j.o.s.m.i.t.h+a+b@GMAIL.com", "josmith@googlemail.com", " Jo.Smith@GoogleMail.com "];
    for (const e of same) expect(normalizeProspectEmail(e), e).toBe("josmith@gmail.com");
    // Dots matter at every other provider; a plus tag does not.
    expect(normalizeProspectEmail("jo.smith@corp.example")).toBe("jo.smith@corp.example");
    expect(normalizeProspectEmail("jo.smith+x@corp.example")).toBe("jo.smith@corp.example");
    expect(normalizeProspectEmail("josmith@corp.example")).not.toBe(normalizeProspectEmail("jo.smith@corp.example"));
    // A plus at the very start is part of the name, not a tag.
    expect(normalizeProspectEmail("+x@corp.example")).toBe("+x@corp.example");
    expect(normalizeProspectEmail("not an address")).toBe("not an address");
  });

  it("matches a blocked domain and its subdomains, not a domain that merely ends the same way", () => {
    expect(isBlockedDomain("a@free-mail.test", ["free-mail.test"])).toBe(true);
    expect(isBlockedDomain("a@mx.free-mail.test", ["free-mail.test"])).toBe(true);
    expect(isBlockedDomain("a@notfree-mail.test", ["free-mail.test"])).toBe(false);
    expect(isBlockedDomain("a@free-mail.test.evil.com", ["free-mail.test"])).toBe(false);
    expect(isBlockedDomain("a@FREE-MAIL.TEST", ["@Free-Mail.Test"])).toBe(true);
    expect(isBlockedDomain("a@example.com", [])).toBe(false);
    expect(isBlockedDomain("a@example.com", [" ", ""])).toBe(false);
    expect(emailDomain("A@Sub.Example.COM")).toBe("sub.example.com");
    expect(firstNameOf("  Dana  Reyes ")).toBe("Dana");
    expect(firstNameOf(null)).toBe("");
  });
});

describe("the settings", () => {
  it("start with everything off and the proposals the audit made", () => {
    expect(DEMO_DEFAULTS).toMatchObject({ enabled: false, aiEnabled: false, windowHours: 24, messageLimit: 10, maxExtensionHours: 72, maxExtraMessages: 20, consultationUrl: null, blockedEmailDomains: [] });
  });

  it("accept a value at each end of its range and refuse one step outside, naming the field", () => {
    for (const [key, [min, max]] of Object.entries(DEMO_RANGES)) {
      expect(checkSettingsPatch({ [key]: min }), `${key} min`).toEqual({ ok: true, value: { [key]: min } });
      expect(checkSettingsPatch({ [key]: max }), `${key} max`).toEqual({ ok: true, value: { [key]: max } });
      for (const bad of [min - 1, max + 1, 1.5, "7", null]) {
        const r = checkSettingsPatch({ [key]: bad });
        expect(r.ok, `${key} ${String(bad)}`).toBe(false);
        if (!r.ok) expect(Object.keys(r.problems)).toEqual([key]);
      }
    }
  });

  it("takes the consultation address only as https, and cleans the list of blocked domains", () => {
    for (const ok of ["https://example.com/book", "https://cal.example.com/me?x=1", "HTTPS://EXAMPLE.COM"]) expect(isConsultationUrl(ok), ok).toBe(true);
    for (const bad of ["http://example.com", "ftp://example.com", "//example.com", "javascript:alert(1)", "https://", "https://localhost", "https://user:pass@example.com", "https://exa mple.com", `https://example.com/${"x".repeat(500)}`]) expect(isConsultationUrl(bad), bad).toBe(false);
    expect(checkSettingsPatch({ consultationUrl: "   " })).toEqual({ ok: true, value: { consultationUrl: null } });
    expect(checkSettingsPatch({ consultationUrl: null })).toEqual({ ok: true, value: { consultationUrl: null } });
    expect(checkSettingsPatch({ blockedEmailDomains: [" @Gmail.com ", "gmail.com", "Yahoo.com"] })).toEqual({ ok: true, value: { blockedEmailDomains: ["gmail.com", "yahoo.com"] } });
    expect(checkSettingsPatch({ blockedEmailDomains: Array.from({ length: 501 }, (_, i) => `d${i}.com`) }).ok).toBe(false);
    expect(checkSettingsPatch({ blockedEmailDomains: ["fine.com", 5] }).ok).toBe(false);
    expect(checkSettingsPatch({ enabled: "true" }).ok).toBe(false);
    expect(checkSettingsPatch({ nonsense: 5 })).toEqual({ ok: true, value: {} });
    expect(checkSettingsPatch(null)).toEqual({ ok: true, value: {} });
  });
});

describe("the words", () => {
  it("name every kind of timeline entry and every notification, and the industries are the questionnaire's own", () => {
    for (const k of DEMO_EVENT_KINDS) expect(DEMO_EVENT_LABELS[k].length, k).toBeGreaterThan(5);
    expect(Object.keys(DEMO_EVENT_LABELS).sort()).toEqual([...DEMO_EVENT_KINDS].sort());
    expect(new Set(DEMO_EVENT_KINDS).size).toBe(DEMO_EVENT_KINDS.length);
    expect(DEMO_NOTIFICATION_KINDS).toEqual(["demo_prospect_verified", "demo_consultation_requested", "demo_purchase_started", "demo_budget_reached"]);
    expect(DEMO_INDUSTRIES.length).toBeGreaterThanOrEqual(9);
    expect(isDemoIndustry("home_services")).toBe(true);
    expect(isDemoIndustry("pirate_radio")).toBe(false);
    expect(isDemoIndustry(null)).toBe(false);
    expect(demoIndustryLabel("home_services")).toBe("Home services");
    expect(demoIndustryLabel("nonsense")).toBeNull();
  });

  it("states what is kept and for how long, with the version that is recorded with each request", () => {
    const n = demoNotice(90);
    expect(n.version).toBe(NOTICE_VERSION);
    expect(n.details.join(" ")).toContain("90 days");
    expect(n.details.join(" ")).toContain("erase");
    expect(n.consent).toContain("agree");
    expect(n.marketing).toContain("optional");
  });
});
