// What the public demo pages say about something that just happened. A plain form is sent back to its page with ONE word in the address; the page turns the word into a fixed
// sentence, ignores any word it does not know, and shows a word that names a state only where the record agrees. Pure (no database).
import { describe, expect, it } from "vitest";
import {
  agrees, CTA_COPY, ctaNotice, fieldWords, FORM_FIELDS, HOLD_COPY, HOLD_REASONS, holdWord, LEFT_COPY, linkStillGood, MESSAGE_REFUSALS, MESSAGE_WORDS, messageNotice, parseFieldWords,
  PRIVACY_EMAIL, ROOM_COPY, START_REFUSALS, START_WORDS, startNotice, VERIFY_REFUSALS, verifyNotice, type RoomFacts,
} from "@/lib/demo/outcomes";
import { FIELD_COPY, LINK_SENT_COPY, PUBLIC_COPY } from "@/lib/demo/copy";
import { REFUSAL_COPY } from "@/lib/demo/rules";
import { RELEASE_REASONS } from "@/server/demo/chat";

const HOSTILE = ["<script>alert(1)</script>", "constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "SENT", "sent ", " sent", "sent\n", "", "../admin", "javascript:alert(1)", "a".repeat(5000)];

const room = (over: Partial<RoomFacts> = {}): RoomFacts => ({ access: "open", messagesLeft: 5, chatRefusal: null, consultationRequested: false, purchaseStarted: false, ...over });

/** Every sentence these pages can ever show for a word. A notice that is not one of these came from somewhere it should not. */
const FIXED = new Set<string>([...Object.values(PUBLIC_COPY), ...Object.values(REFUSAL_COPY), ...Object.values(HOLD_COPY), ...Object.values(CTA_COPY), LINK_SENT_COPY, LEFT_COPY]);

describe("the request page", () => {
  it("turns a known word into its fixed sentence", () => {
    expect(startNotice("sent", { hasSession: false })).toEqual({ tone: "ok", text: LINK_SENT_COPY });
    expect(startNotice("left", { hasSession: false })).toEqual({ tone: "ok", text: LEFT_COPY });
    for (const word of START_REFUSALS) {
      if (word === "no_session") continue;
      expect(startNotice(word, { hasSession: false }), word).toEqual({ tone: "error", text: PUBLIC_COPY[word] });
    }
  });

  it("knows exactly the words its form can meet and the two good ones", () => {
    expect([...START_WORDS].sort()).toEqual(["sent", "left", ...START_REFUSALS].sort());
    expect(START_WORDS).not.toContain("link_invalid");
  });

  it("shows nothing for any word it does not know, however it is spelled", () => {
    for (const word of HOSTILE) {
      expect(startNotice(word, { hasSession: false }), word.slice(0, 20)).toBeNull();
      expect(verifyNotice(word), word.slice(0, 20)).toBeNull();
      expect(messageNotice(word, room()), word.slice(0, 20)).toBeNull();
      expect(ctaNotice(word, { consultationRequested: true, purchaseStarted: true }), word.slice(0, 20)).toBeNull();
    }
    expect(startNotice(undefined, { hasSession: false })).toBeNull();
  });

  it("says the session ended only to a browser that really has no session", () => {
    expect(startNotice("no_session", { hasSession: false })).toEqual({ tone: "error", text: PUBLIC_COPY.no_session });
    expect(startNotice("no_session", { hasSession: true })).toBeNull();
  });

  it("carries field names only, from a fixed list, once each", () => {
    expect(parseFieldWords("name.email.consent")).toEqual(["name", "email", "consent"]);
    expect(parseFieldWords("name.name.email")).toEqual(["name", "email"]);
    expect(parseFieldWords("name.<img>.__proto__.constructor.email")).toEqual(["name", "email"]);
    expect(parseFieldWords(undefined)).toEqual([]);
    expect(parseFieldWords("")).toEqual([]);
    expect(fieldWords(["name", "email", "company_website", "token"])).toBe("name.email");
    expect(parseFieldWords(fieldWords([...FORM_FIELDS]))).toEqual([...FORM_FIELDS]);
    for (const f of FORM_FIELDS) expect(FIELD_COPY[f], f).toBeTruthy();
  });

  it("parses twenty thousand characters of field words quickly", () => {
    const t0 = Date.now();
    expect(parseFieldWords("name.".repeat(4000))).toEqual(["name"]);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe("the link's page", () => {
  it("knows the refusals a button press can meet, and shows each as its fixed sentence", () => {
    for (const word of VERIFY_REFUSALS) expect(verifyNotice(word), word).toEqual({ tone: "error", text: PUBLIC_COPY[word] });
    expect(verifyNotice("invalid")).toBeNull();
    expect(verifyNotice("sent")).toBeNull();
  });

  it("says the same emailed link works again only after a refusal that did not use it up", () => {
    for (const word of ["daily_cap", "rate_limited", "unavailable", "not_available"]) expect(linkStillGood(word), word).toBe(true);
    for (const word of ["link_used", "link_expired", "link_invalid", "invalid", "", undefined, "constructor"]) expect(linkStillGood(word), String(word)).toBe(false);
  });
});

describe("the room", () => {
  it("keeps the words for a given-back message in step with the reasons the service can give", () => {
    expect([...HOLD_REASONS].sort()).toEqual([...RELEASE_REASONS].sort());
    for (const reason of HOLD_REASONS) {
      expect(HOLD_COPY[reason], reason).toMatch(/not counted|not available/i);
      expect(MESSAGE_WORDS).toContain(holdWord(reason));
    }
    expect(holdWord("reply_blocked")).toBe("held_reply_blocked");
  });

  it("knows the refusals a message can meet and each given-back word, and only those", () => {
    expect([...MESSAGE_WORDS].sort()).toEqual([...MESSAGE_REFUSALS, ...HOLD_REASONS.map(holdWord)].sort());
    for (const word of MESSAGE_REFUSALS) expect(Object.hasOwn(REFUSAL_COPY, word), word).toBe(true);
  });

  it("shows a given-back message as a warning in its own words wherever the record is, since it names no state", () => {
    for (const reason of HOLD_REASONS) {
      for (const access of ["open", "ended", "blocked"] as const) expect(messageNotice(holdWord(reason), room({ access })), `${reason} ${access}`).toEqual({ tone: "error", text: HOLD_COPY[reason] });
    }
    expect(messageNotice("held_nothing", room())).toBeNull();
    expect(messageNotice("held_", room())).toBeNull();
  });

  it("shows a word that names a state only where the record says the same", () => {
    // The address is not a record: a stranger's link cannot make the page claim a state.
    expect(messageNotice("limit_reached", room({ messagesLeft: 5 }))).toBeNull();
    expect(messageNotice("limit_reached", room({ messagesLeft: 0 }))).toEqual({ tone: "error", text: REFUSAL_COPY.limit_reached });
    expect(messageNotice("limit_reached", room({ messagesLeft: 0, access: "ended" }))).toBeNull();
    expect(messageNotice("window_ended", room({ access: "open" }))).toBeNull();
    expect(messageNotice("window_ended", room({ access: "ended" }))).toEqual({ tone: "error", text: REFUSAL_COPY.window_ended });
    expect(messageNotice("ai_off", room({ chatRefusal: null }))).toBeNull();
    expect(messageNotice("ai_off", room({ chatRefusal: "ai_off" }))).toEqual({ tone: "error", text: REFUSAL_COPY.ai_off });
    // Whoever was in these states has no room to see.
    for (const word of ["closed", "blocked", "not_verified"]) for (const access of ["open", "ended", "blocked", "converted"] as const) expect(agrees(word, room({ access })), `${word} ${access}`).toBe(false);
  });

  it("shows a busy-moment word as it is, since it names no state", () => {
    for (const word of ["daily_cap", "rate_limited", "unavailable", "invalid"]) {
      expect(agrees(word, room())).toBe(true);
      expect(messageNotice(word, room())).toEqual({ tone: "error", text: REFUSAL_COPY[word as keyof typeof REFUSAL_COPY] });
    }
  });

  it("says a call to action worked only when the record shows the prospect really asked", () => {
    expect(ctaNotice("consultation", { consultationRequested: false, purchaseStarted: true })).toBeNull();
    expect(ctaNotice("consultation", { consultationRequested: true, purchaseStarted: false })).toEqual({ tone: "ok", text: CTA_COPY.consultation });
    expect(ctaNotice("buy", { consultationRequested: true, purchaseStarted: false })).toBeNull();
    expect(ctaNotice("buy", { consultationRequested: false, purchaseStarted: true })).toEqual({ tone: "ok", text: CTA_COPY.buy });
  });

  it("never claims a checkout, a charge or a created workspace for the Buy button", () => {
    expect(CTA_COPY.buy).toMatch(/not open yet/i);
    expect(CTA_COPY.buy).toMatch(/nothing was charged/i);
    expect(ROOM_COPY.buyNote).toMatch(/nothing is charged/i);
    expect(ROOM_COPY.buyNote).toMatch(/no workspace is created/i);
  });
});

describe("everything these pages can say", () => {
  it("is a fixed sentence: no word, hostile or not, ever produces text from outside the fixed lists", () => {
    const words = [...HOSTILE, ...START_WORDS, ...VERIFY_REFUSALS, ...MESSAGE_WORDS, "consultation", "buy", "no_session"];
    const facts = room({ access: "ended", messagesLeft: 0, chatRefusal: "ai_off", consultationRequested: true, purchaseStarted: true });
    for (const word of words) {
      for (const notice of [startNotice(word, { hasSession: false }), verifyNotice(word), messageNotice(word, facts), ctaNotice(word, facts)]) {
        if (notice) expect(FIXED.has(notice.text), `${word.slice(0, 20)} -> ${notice.text.slice(0, 40)}`).toBe(true);
      }
    }
  });

  it("states no price, percentage or amount in the room's own words (the prices come from the one place they live)", () => {
    for (const [key, text] of Object.entries(ROOM_COPY)) {
      expect(text, key).not.toMatch(/[$€£₱¥%]/);
      expect(text, key).not.toMatch(/\d/);
    }
    for (const text of FIXED) expect(text, text.slice(0, 40)).not.toMatch(/[$€£₱¥%]/);
  });

  it("says the data is sample data and nothing is sent, booked or created, in the banner and the tour's introduction", () => {
    expect(ROOM_COPY.sampleBanner).toMatch(/sample data/i);
    expect(ROOM_COPY.sampleBanner).toMatch(/nothing .* is sent/i);
    expect(ROOM_COPY.sampleBanner).toMatch(/booked/i);
    expect(ROOM_COPY.tourIntro).toMatch(/invented/i);
    expect(ROOM_COPY.tourIntro).toMatch(/not a promise/i);
    expect(ROOM_COPY.chatIntro).toMatch(/sample data/i);
  });

  it("tells a person how to have their details erased, at the company's own address", () => {
    expect(ROOM_COPY.erasure).toContain(PRIVACY_EMAIL);
    expect(PRIVACY_EMAIL).toMatch(/^[a-z]+@iacquire\.ai$/);
  });
});
