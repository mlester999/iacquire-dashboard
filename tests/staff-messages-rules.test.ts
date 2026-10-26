import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { directKey, isUserId, parseDirectKey, peerOf } from "@/lib/staff-messages/direct";
import { BODY_MESSAGES, normaliseBody } from "@/lib/staff-messages/body";
import { findMentionTokens, mentionToken, plainMentions, resolveMentions, splitMentions } from "@/lib/staff-messages/mentions";
import { REACTIONS, isReaction, tallyReactions } from "@/lib/staff-messages/reactions";
import { advanceCursor, badgeText, badgeTotal, firstUnreadSeq, seqOf, unreadCount } from "@/lib/staff-messages/unread";
import { summariseThread, threadRootFor } from "@/lib/staff-messages/threads";
import {
  NO_CAPS, canArchive, canCreate, canDeleteMessage, canEditMessage, canJoin, canLeave, canManageMembers, canPost, canRead, canReact, canRename, normaliseName, normaliseTopic,
  type Caps, type ConversationFacts, type Standing,
} from "@/lib/staff-messages/conversations";
import { attachmentIds, attachmentProblem } from "@/lib/staff-messages/attachments";
import { escapeLike, likePattern, normaliseQuery, snippetOf } from "@/lib/staff-messages/search";
import { noticeLink, noticeWords, planMessageNotices } from "@/lib/staff-messages/notices";
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, MAX_BODY_CHARS, MAX_MENTIONS } from "@/lib/staff-messages/limits";
import { STAFF_MESSAGES_NOTICE_LINES, STAFF_MESSAGES_NOTICE_STATUS, STAFF_MESSAGES_NOTICE_VERSION } from "@/lib/staff-messages/notice";

// The pure rules of staff Messages (migration 0096): the key of a direct message, what a message may contain, mentions, reactions, unread arithmetic, threads, who may do what
// in a conversation, names, attachments, search words and who is told about a message. No database. A small seeded generator stands in for a property-testing library.

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
const int = (r: () => number, n: number) => Math.floor(r() * n);
const uuidFrom = (r: () => number) => {
  const hex = Array.from({ length: 32 }, () => "0123456789abcdef"[int(r, 16)]).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const A = "1111111a-1111-4111-8111-11111111111a";
const B = "2222222b-2222-4222-8222-22222222222b";
const C = "3333333c-3333-4333-8333-33333333333c";
const char = (code: number) => String.fromCharCode(code);

describe("the key of a direct message", () => {
  it("is the same whoever opens the conversation, lower case, and holds the smaller id first", () => {
    expect(directKey(A, B)).toBe(`${A}:${B}`);
    expect(directKey(B, A)).toBe(`${A}:${B}`);
    expect(directKey(A.toUpperCase(), B)).toBe(`${A}:${B}`);
  });

  it("refuses a person talking to themselves and anything that is not an id", () => {
    expect(() => directKey(A, A)).toThrow(/two different people/);
    expect(() => directKey(A, A.toUpperCase())).toThrow(/two different people/);
    expect(() => directKey(A, "not-an-id")).toThrow(/valid person ids/);
    expect(() => directKey("", B)).toThrow();
    expect(isUserId(A)).toBe(true);
    expect(isUserId(`${A} `)).toBe(false);
    expect(isUserId(42)).toBe(false);
  });

  it("reads back the two people, and names the other one", () => {
    const key = directKey(B, A);
    expect(parseDirectKey(key)).toEqual([A, B]);
    expect(peerOf(key, A)).toBe(B);
    expect(peerOf(key, B.toUpperCase())).toBe(A);
    expect(peerOf(key, C)).toBeNull();
    // A key that was not made here: wrong order, an upper-case id, an extra part.
    expect(parseDirectKey(`${B}:${A}`)).toBeNull();
    expect(parseDirectKey(`${A.toUpperCase()}:${B}`)).toBeNull();
    expect(parseDirectKey(`${A}:${B}:${C}`)).toBeNull();
    expect(parseDirectKey(`${A}:${A}`)).toBeNull();
  });

  it("is symmetric and round-trips for any pair (a thousand random pairs)", () => {
    const r = rng(7);
    for (let i = 0; i < 1000; i++) {
      const [x, y] = [uuidFrom(r), uuidFrom(r)];
      if (x === y) continue;
      const key = directKey(x, y);
      expect(directKey(y, x)).toBe(key);
      expect(parseDirectKey(key)).toEqual([x, y].sort());
      expect(peerOf(key, x)).toBe(y);
    }
  });
});

describe("what a message may contain", () => {
  const ok = (raw: string) => {
    const r = normaliseBody(raw);
    if (!r.ok) throw new Error(`expected a body, got ${r.reason}`);
    return r.body;
  };

  it("keeps ordinary text, new lines and tabs, and puts it in one tidy form", () => {
    expect(ok("  Hello team  ")).toBe("Hello team");
    expect(ok("one\r\ntwo\rthree\nfour")).toBe("one\ntwo\nthree\nfour");
    expect(ok("a   \nb\t\nc")).toBe("a\nb\nc");
    expect(ok("a\n\n\n\n\n\nb")).toBe("a\n\n\nb");
    expect(ok("a\tb")).toBe("a\tb");
    expect(ok("line one" + char(0x2028) + "line two")).toBe("line one\nline two");
  });

  it("drops control codes and the characters that make text read in a different order, and keeps the joiners emoji need", () => {
    expect(ok("a" + char(0) + char(7) + char(27) + char(127) + char(0x85) + "b")).toBe("ab");
    expect(ok("pay" + char(0x202e) + "dlrow" + char(0x202c))).toBe("paydlrow");
    expect(ok("x" + char(0x2066) + "y" + char(0x2069))).toBe("xy");
    expect(ok("a" + char(0x200b) + char(0xfeff) + char(0x2060) + "b")).toBe("ab");
    const family = "\u{1F468}" + char(0x200d) + "\u{1F469}" + char(0x200d) + "\u{1F467}";
    expect(ok(`hi ${family}`)).toBe(`hi ${family}`);
    expect(ok("caf" + "e" + char(0x301))).toBe("caf" + char(0xe9));
    // A mark that only meets its letter after a dropped character is still joined to it, so tidying twice never gives a different text.
    expect(ok("e" + char(0) + char(0x301))).toBe(char(0xe9));
  });

  it("refuses nothing, whitespace only and text that is not text, in words", () => {
    for (const raw of ["", "   ", "\n\n\t", char(0) + char(0x200b)]) {
      expect(normaliseBody(raw)).toEqual({ ok: false, reason: "empty", message: BODY_MESSAGES.empty });
    }
    for (const raw of [undefined, null, 5, {}, ["a"]]) {
      expect(normaliseBody(raw)).toMatchObject({ ok: false, reason: "not_text" });
    }
  });

  it("counts characters the way the database does: a picture outside the basic plane is one", () => {
    expect(normaliseBody("a".repeat(MAX_BODY_CHARS))).toMatchObject({ ok: true, chars: MAX_BODY_CHARS });
    expect(normaliseBody("a".repeat(MAX_BODY_CHARS + 1))).toMatchObject({ ok: false, reason: "too_long" });
    expect(normaliseBody("\u{1F600}".repeat(MAX_BODY_CHARS))).toMatchObject({ ok: true, chars: MAX_BODY_CHARS });
    expect(normaliseBody("\u{1F600}".repeat(MAX_BODY_CHARS + 1))).toMatchObject({ ok: false, reason: "too_long" });
    // Trailing blank space does not count against the limit.
    expect(normaliseBody("a".repeat(MAX_BODY_CHARS) + "   \n  ")).toMatchObject({ ok: true, chars: MAX_BODY_CHARS });
  });

  it("is quick on 20,000 characters of anything awkward", () => {
    const awkward = [
      "a".repeat(20_000),
      " ".repeat(20_000) + "x",
      "x" + " ".repeat(20_000) + "y",
      "\n".repeat(20_000),
      ("a " + char(0)).repeat(7_000),
      char(0x202e).repeat(20_000) + "a",
      "<@".repeat(10_000),
      "\r".repeat(20_000) + "z",
    ];
    const started = Date.now();
    for (const raw of awkward) normaliseBody(raw);
    expect(Date.now() - started).toBeLessThan(1500);
    // Far past the limit is refused without being worked through.
    expect(normaliseBody("a".repeat(500_000))).toMatchObject({ ok: false, reason: "too_long" });
  });

  it("is idempotent: tidying a tidy message changes nothing (a thousand random messages)", () => {
    const r = rng(11);
    const pieces = ["a", "b", " ", "  ", "\n", "\r\n", "\t", char(0), char(0x202e), "\u{1F600}", "<@", "x y", char(0x200d), "e", char(0x301), char(0x2028)];
    for (let i = 0; i < 1000; i++) {
      const raw = Array.from({ length: 1 + int(r, 40) }, () => pieces[int(r, pieces.length)]).join("");
      const first = normaliseBody(raw);
      if (!first.ok) continue;
      expect(normaliseBody(first.body)).toEqual(first);
      expect(first.body).toBe(first.body.trim());
      expect(first.body).not.toMatch(/\n\n\n\n/);
    }
  });
});

describe("mentions", () => {
  const tokenOf = (id: string) => `<@${id}>`;

  it("finds each well-formed token with its place, and nothing else", () => {
    const body = `hi ${tokenOf(A)} and ${tokenOf(B.toUpperCase())}, not <@nope> or <@${A.slice(0, 35)}> or ${tokenOf(A).slice(0, -1)}`;
    const found = findMentionTokens(body);
    expect(found.map((t) => t.id)).toEqual([A, B]);
    for (const t of found) expect(body.slice(t.start, t.end).toLowerCase()).toBe(tokenOf(t.id));
    expect(findMentionTokens(`${tokenOf(A)}${tokenOf(B)}`).map((t) => t.id)).toEqual([A, B]);
    expect(mentionToken(A.toUpperCase())).toBe(tokenOf(A));
  });

  it("accepts mentions of members, once each, in the order they appear, and ignores the case of the member list", () => {
    const body = `${tokenOf(B)} ${tokenOf(A)} ${tokenOf(B)}`;
    expect(resolveMentions(body, [A.toUpperCase(), B, C])).toEqual({ ok: true, ids: [B, A] });
    expect(resolveMentions("nobody named", [A])).toEqual({ ok: true, ids: [] });
  });

  it("refuses a mention of someone who is not in the conversation, and more than twenty", () => {
    expect(resolveMentions(tokenOf(C), [A, B])).toMatchObject({ ok: false, reason: "not_a_member" });
    const r = rng(3);
    const many = Array.from({ length: MAX_MENTIONS + 1 }, () => uuidFrom(r));
    expect(resolveMentions(many.map(tokenOf).join(" "), many)).toMatchObject({ ok: false, reason: "too_many" });
    expect(resolveMentions(many.slice(0, MAX_MENTIONS).map(tokenOf).join(" "), many)).toMatchObject({ ok: true });
  });

  it("splits text into runs and mentions that join back to the original, and shows names for a notification", () => {
    const body = `hello ${tokenOf(A)}, meet ${tokenOf(B)}`;
    const parts = splitMentions(body);
    expect(parts).toEqual([{ type: "text", text: "hello " }, { type: "mention", id: A }, { type: "text", text: ", meet " }, { type: "mention", id: B }]);
    expect(parts.map((p) => (p.type === "text" ? p.text : tokenOf(p.id))).join("")).toBe(body);
    expect(plainMentions(body, (id) => (id === A ? "Maya" : null))).toBe("hello @Maya, meet @someone");
    expect(splitMentions("")).toEqual([]);
  });

  it("is quick on 20,000 characters of nearly-tokens", () => {
    const started = Date.now();
    findMentionTokens("<@".repeat(10_000));
    findMentionTokens(("<@" + A.slice(0, 35)).repeat(500));
    splitMentions(tokenOf(A).repeat(500));
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("reactions", () => {
  it("are exactly the names the database accepts", () => {
    const sql = readFileSync("supabase/migrations/0096_staff_messages.sql", "utf8");
    const check = /reaction text not null check \(reaction in \(([^)]*)\)\)/.exec(sql);
    expect(check).not.toBeNull();
    const names = [...(check as RegExpExecArray)[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(REACTIONS.map((r) => r.key)).toEqual(names);
  });

  it("accept only those names", () => {
    expect(isReaction("thumbs_up")).toBe(true);
    for (const bad of ["", "THUMBS_UP", "thumbs_up ", "smile", "<script>", null, undefined, 3, "constructor", "__proto__"]) expect(isReaction(bad)).toBe(false);
  });

  it("are counted in the order of the list, with whether the viewer gave each", () => {
    const rows = [
      { reaction: "heart", userId: A }, { reaction: "thumbs_up", userId: B }, { reaction: "heart", userId: B }, { reaction: "thumbs_up", userId: A }, { reaction: "heart", userId: C },
    ];
    expect(tallyReactions(rows, A)).toEqual([{ reaction: "thumbs_up", count: 2, mine: true }, { reaction: "heart", count: 3, mine: true }]);
    expect(tallyReactions(rows, C)).toEqual([{ reaction: "thumbs_up", count: 2, mine: false }, { reaction: "heart", count: 3, mine: true }]);
    expect(tallyReactions([], A)).toEqual([]);
  });
});

describe("unread arithmetic", () => {
  it("is the newest message minus the newest read one, never below zero and never more than the conversation holds", () => {
    const rows: Array<[number, number, number]> = [[0, 0, 0], [5, 0, 5], [5, 5, 0], [5, 3, 2], [5, 9, 0], [0, 4, 0], [10, -2, 10], [3.9, 1.2, 2], [Number.NaN, 2, 0], [4, Number.NaN, 4]];
    for (const [last, read, want] of rows) expect(unreadCount(last, read), `${last}/${read}`).toBe(want);
  });

  it("moves the cursor forward only, and never past the newest message", () => {
    const rows: Array<[number, number, number, number]> = [[0, 5, 10, 5], [5, 3, 10, 5], [5, 5, 10, 5], [5, 99, 10, 10], [5, 7, 6, 6], [8, 3, 6, 8], [0, -1, 10, 0], [2, Number.NaN, 10, 2]];
    for (const [current, requested, last, want] of rows) expect(advanceCursor(current, requested, last), `${current},${requested},${last}`).toBe(want);
    expect(firstUnreadSeq(0)).toBe(1);
    expect(firstUnreadSeq(41)).toBe(42);
  });

  it("holds under any order and any number of repeats of read requests (a thousand random histories)", () => {
    const r = rng(19);
    for (let i = 0; i < 1000; i++) {
      const last = int(r, 60);
      const requests = Array.from({ length: 1 + int(r, 12) }, () => int(r, 80) - 5);
      let cursor = int(r, last + 1);
      const start = cursor;
      for (const q of requests) {
        const next = advanceCursor(cursor, q, last);
        expect(next).toBeGreaterThanOrEqual(cursor);
        expect(next).toBeLessThanOrEqual(Math.max(last, start));
        // Asking again changes nothing.
        expect(advanceCursor(next, q, last)).toBe(next);
        cursor = next;
      }
      // The order of the requests does not matter: the result is the largest sensible request.
      const shuffled = [...requests].sort(() => r() - 0.5);
      let other = start;
      for (const q of shuffled) other = advanceCursor(other, q, last);
      expect(other).toBe(cursor);
      expect(unreadCount(last, cursor)).toBe(last - cursor);
    }
  });

  it("counts a badge from conversations that are neither muted nor archived, and writes it short", () => {
    const rows = [
      { lastSeq: 10, lastReadSeq: 4, muted: false }, { lastSeq: 7, lastReadSeq: 7, muted: false }, { lastSeq: 9, lastReadSeq: 0, muted: true }, { lastSeq: 5, lastReadSeq: 0, muted: false, archived: true },
      { lastSeq: 3, lastReadSeq: 2, muted: false },
    ];
    expect(badgeTotal(rows)).toBe(7);
    expect(badgeTotal([])).toBe(0);
    expect([0, 1, 99, 100, 5000, -3, Number.NaN].map(badgeText)).toEqual([null, "1", "99", "99+", "99+", null, null]);
  });

  it("reads a bigint from either driver, and refuses what cannot be counted exactly", () => {
    expect(seqOf(12)).toBe(12);
    expect(seqOf("12")).toBe(12);
    expect(seqOf("0")).toBe(0);
    expect(() => seqOf("-1")).toThrow();
    expect(() => seqOf("9007199254740993")).toThrow();
    expect(() => seqOf("x")).toThrow();
    expect(() => seqOf(1.5)).toThrow();
  });
});

describe("threads", () => {
  it("attach a reply to the message that started the thread, one level deep", () => {
    expect(threadRootFor({ id: "m1", threadRootId: null })).toBe("m1");
    expect(threadRootFor({ id: "m2", threadRootId: "m1" })).toBe("m1");
  });

  it("are summarised from the replies that still stand", () => {
    const at = (m: number) => new Date(Date.UTC(2026, 9, 24, 10, m)).toISOString();
    const s = summariseThread([
      { authorId: B, seq: 4, createdAt: at(4) }, { authorId: A, seq: 2, createdAt: at(2) }, { authorId: C, seq: 5, createdAt: at(5), deleted: true }, { authorId: A, seq: 3, createdAt: at(3) }, { authorId: null, seq: 6, createdAt: at(6) },
    ]);
    expect(s).toEqual({ replies: 4, lastReplyAt: at(6), participants: [A, B] });
    expect(summariseThread([])).toEqual({ replies: 0, lastReplyAt: null, participants: [] });
  });
});

describe("who may do what in a conversation", () => {
  const caps = (over: Partial<Caps> = {}): Caps => ({ ...NO_CAPS, use: true, ...over });
  const staffCaps = caps();
  const managerCaps = caps({ channels: true });
  const superCaps = caps({ channels: true, moderate: true });
  const direct: ConversationFacts = { kind: "direct", visibility: "private", archived: false };
  const group: ConversationFacts = { kind: "group", visibility: "private", archived: false };
  const open: ConversationFacts = { kind: "channel", visibility: "staff", archived: false };
  const priv: ConversationFacts = { kind: "channel", visibility: "private", archived: false };
  const archived = (c: ConversationFacts): ConversationFacts => ({ ...c, archived: true });
  const as = (c: Caps, memberRole: Standing["memberRole"]): Standing => ({ caps: c, memberRole });

  it("lets anyone who may use Messages write directly and start a private group, and channels only to those with the channels permission", () => {
    expect(canCreate("direct", staffCaps)).toBe(true);
    expect(canCreate("group", staffCaps)).toBe(true);
    expect(canCreate("channel", staffCaps)).toBe(false);
    expect(canCreate("channel", managerCaps)).toBe(true);
    expect(canCreate("channel", superCaps)).toBe(true);
    for (const kind of ["direct", "group", "channel"] as const) expect(canCreate(kind, NO_CAPS), kind).toBe(false);
    // The channels permission without the permission to use Messages gives nothing.
    expect(canCreate("channel", { use: false, channels: true, moderate: false })).toBe(false);
  });

  it("gives a person who may not use Messages nothing, whatever their membership says", () => {
    const denied = as({ use: false, channels: true, moderate: true }, "owner");
    for (const c of [direct, group, open, priv]) {
      expect(canRead(c, denied)).toBe(false);
      expect(canPost(c, denied)).toBe(false);
      expect(canManageMembers(c, denied)).toBe(false);
      expect(canArchive(c, denied)).toBe(false);
      expect(canJoin(c, as({ use: false, channels: false, moderate: false }, null))).toBe(false);
    }
  });

  it("reads and posts for members only, and not in an archived conversation", () => {
    for (const c of [direct, group, open, priv]) {
      expect(canRead(c, as(staffCaps, "member"))).toBe(true);
      expect(canPost(c, as(staffCaps, "member"))).toBe(true);
      expect(canRead(c, as(staffCaps, null))).toBe(false);
      expect(canPost(c, as(staffCaps, null))).toBe(false);
      expect(canRead(archived(c), as(staffCaps, "member"))).toBe(true);
      expect(canPost(archived(c), as(staffCaps, "member"))).toBe(false);
    }
    // No role reads a conversation it is not in: not a manager, not the Super Admin with moderation.
    for (const c of [direct, group, open, priv]) {
      expect(canRead(c, as(managerCaps, null)), "manager").toBe(false);
      expect(canRead(c, as(superCaps, null)), "super admin").toBe(false);
    }
  });

  it("lets a person join an open channel and nothing else", () => {
    expect(canJoin(open, as(staffCaps, null))).toBe(true);
    expect(canJoin(open, as(staffCaps, "member"))).toBe(false);
    expect(canJoin(archived(open), as(staffCaps, null))).toBe(false);
    for (const c of [direct, group, priv]) expect(canJoin(c, as(superCaps, null)), c.kind + c.visibility).toBe(false);
  });

  it("lets everyone but a direct message leave", () => {
    expect(canLeave(direct, as(staffCaps, "member"))).toBe(false);
    for (const c of [group, open, priv]) {
      expect(canLeave(c, as(staffCaps, "member"))).toBe(true);
      expect(canLeave(c, as(staffCaps, "owner"))).toBe(true);
      expect(canLeave(c, as(staffCaps, null))).toBe(false);
    }
  });

  it("lets an owner run their conversation, and the channels permission run the open channels only", () => {
    for (const c of [group, open, priv]) {
      expect(canManageMembers(c, as(staffCaps, "owner")), c.kind + c.visibility).toBe(true);
      expect(canRename(c, as(staffCaps, "owner"))).toBe(true);
      expect(canManageMembers(c, as(staffCaps, "member"))).toBe(false);
      expect(canManageMembers(archived(c), as(staffCaps, "owner"))).toBe(false);
    }
    expect(canManageMembers(open, as(managerCaps, "member"))).toBe(true);
    expect(canManageMembers(open, as(managerCaps, null))).toBe(true);
    // A private channel and a group are not run by a role: only by the people who own them.
    expect(canManageMembers(priv, as(managerCaps, "member"))).toBe(false);
    expect(canManageMembers(priv, as(superCaps, null))).toBe(false);
    expect(canManageMembers(group, as(managerCaps, "member"))).toBe(false);
    expect(canManageMembers(direct, as(superCaps, "owner"))).toBe(false);
  });

  it("lets owners, the channels permission and moderators archive a channel, and refuses a direct message", () => {
    expect(canArchive(group, as(staffCaps, "owner"))).toBe(true);
    expect(canArchive(group, as(staffCaps, "member"))).toBe(false);
    expect(canArchive(group, as(managerCaps, "member"))).toBe(false);
    expect(canArchive(open, as(managerCaps, null))).toBe(true);
    expect(canArchive(priv, as(managerCaps, null))).toBe(true);
    expect(canArchive(priv, as(caps({ moderate: true }), null))).toBe(true);
    expect(canArchive(open, as(staffCaps, "member"))).toBe(false);
    expect(canArchive(direct, as(superCaps, "owner"))).toBe(false);
    expect(canArchive(archived(open), as(managerCaps, null))).toBe(true);
  });

  it("lets the author edit and delete their own message, and a moderator delete one in a channel they belong to", () => {
    const me = "me";
    const mine = { authorId: me, deleted: false };
    const theirs = { authorId: "you", deleted: false };
    const gone = { authorId: me, deleted: true };
    const member = as(staffCaps, "member");
    expect(canEditMessage(group, member, me, mine)).toBe(true);
    expect(canEditMessage(group, member, me, theirs)).toBe(false);
    expect(canEditMessage(group, member, me, gone)).toBe(false);
    expect(canEditMessage(archived(group), member, me, mine)).toBe(false);
    expect(canEditMessage(group, as(staffCaps, null), me, mine)).toBe(false);
    expect(canDeleteMessage(group, member, me, mine)).toBe(true);
    expect(canDeleteMessage(group, member, me, gone)).toBe(false);
    expect(canDeleteMessage(group, member, me, theirs)).toBe(false);
    expect(canDeleteMessage(archived(group), member, me, mine)).toBe(false);
    // A moderator removes what others wrote in a channel; never in a direct message or a group, even as a member.
    const moderator = as(superCaps, "member");
    expect(canDeleteMessage(open, moderator, me, theirs)).toBe(true);
    expect(canDeleteMessage(priv, moderator, me, theirs)).toBe(true);
    expect(canDeleteMessage(open, as(superCaps, null), me, theirs)).toBe(false);
    expect(canDeleteMessage(group, moderator, me, theirs)).toBe(false);
    expect(canDeleteMessage(direct, moderator, me, theirs)).toBe(false);
    expect(canDeleteMessage(open, as(managerCaps, "member"), me, theirs)).toBe(false);
    expect(canDeleteMessage(open, moderator, me, { authorId: null, deleted: false })).toBe(true);
  });

  it("lets a member react to a message that stands, while the conversation is open", () => {
    const m = { authorId: "you", deleted: false };
    expect(canReact(group, as(staffCaps, "member"), m)).toBe(true);
    expect(canReact(group, as(staffCaps, "member"), { ...m, deleted: true })).toBe(false);
    expect(canReact(archived(group), as(staffCaps, "member"), m)).toBe(false);
    expect(canReact(group, as(staffCaps, null), m)).toBe(false);
  });
});

describe("names and topics", () => {
  const name = (kind: "group" | "channel", raw: unknown) => {
    const r = normaliseName(kind, raw);
    return r.ok ? r.value : `refused: ${r.message}`;
  };

  it("keeps a group's name as written, tidied", () => {
    expect(name("group", "  Design   review  ")).toBe("Design review");
    expect(name("group", "Cafe" + char(0x301))).toBe("Caf" + char(0xe9));
    expect(name("group", "a\nb")).toBe("a b");
    expect(name("group", "x" + char(0x202e) + "y")).toBe("x y");
    expect(name("group", "")).toMatch(/refused: Give the group a name/);
    expect(name("group", "   ")).toMatch(/refused: Give the group a name/);
    expect(name("group", "a".repeat(80))).toBe("a".repeat(80));
    expect(name("group", "a".repeat(81))).toMatch(/refused: A name can be up to 80/);
    expect(name("group", 5)).toMatch(/refused/);
  });

  it("writes a channel's name the way people write it after a #", () => {
    expect(name("channel", "#General Chat")).toBe("general-chat");
    expect(name("channel", "  design   reviews ")).toBe("design-reviews");
    expect(name("channel", "Ops_2026")).toBe("ops_2026");
    expect(name("channel", "---a--b---")).toBe("a-b");
    expect(name("channel", "ÜBER-Team")).toBe("über-team");
    expect(name("channel", "no/slash")).toMatch(/refused: A channel name can use letters/);
    expect(name("channel", "no.dot")).toMatch(/refused/);
    expect(name("channel", "<b>")).toMatch(/refused/);
    expect(name("channel", "#")).toMatch(/refused: Give the channel a name/);
    expect(name("channel", "-")).toMatch(/refused: Give the channel a name/);
    expect(name("channel", "a".repeat(81))).toMatch(/refused: A name can be up to 80/);
    // The tidy form is stable: tidying it again changes nothing.
    for (const raw of ["#General Chat", "  a  b  ", "x-_-y", "ÜBER Team"]) {
      const once = normaliseName("channel", raw);
      expect(once.ok).toBe(true);
      if (once.ok) expect(normaliseName("channel", once.value)).toEqual(once);
    }
  });

  it("is quick on a very long name", () => {
    const started = Date.now();
    normaliseName("channel", "-".repeat(20_000));
    normaliseName("group", " ".repeat(20_000) + "x");
    normaliseName("channel", "a-".repeat(10_000));
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("takes an optional topic of up to 250 characters", () => {
    expect(normaliseTopic(undefined)).toEqual({ ok: true, value: "" });
    expect(normaliseTopic(null)).toEqual({ ok: true, value: "" });
    expect(normaliseTopic("  Releases and\nincidents ")).toEqual({ ok: true, value: "Releases and incidents" });
    expect(normaliseTopic("t".repeat(250))).toMatchObject({ ok: true });
    expect(normaliseTopic("t".repeat(251))).toMatchObject({ ok: false });
    expect(normaliseTopic(3)).toMatchObject({ ok: false });
  });
});

describe("attachments", () => {
  it("accept the seven file types, up to 10 MB, and say why not otherwise", () => {
    for (const n of ["a.pdf", "a.PNG", "a.jpg", "a.jpeg", "a.webp", "a.txt", "a.csv", "a.docx"]) expect(attachmentProblem({ name: n, size: 10 }), n).toBeNull();
    for (const n of ["a.exe", "a.svg", "a.html", "a", "a.js", "a.zip", "a.pdf.exe", "a.mp4"]) expect(attachmentProblem({ name: n, size: 10 }), n).toMatch(/Choose a/);
    expect(attachmentProblem({ name: "a.pdf", size: 0 })).toBe("That file is empty.");
    expect(attachmentProblem({ name: "a.pdf", size: Number.NaN })).toBe("That file is empty.");
    expect(attachmentProblem({ name: "a.pdf", size: MAX_ATTACHMENT_BYTES })).toBeNull();
    expect(attachmentProblem({ name: "a.pdf", size: MAX_ATTACHMENT_BYTES + 1 })).toBe("Files can be up to 10 MB.");
  });

  it("allow five files on a message, each once", () => {
    expect(attachmentIds(undefined)).toEqual({ ok: true, ids: [] });
    expect(attachmentIds(["a", "b", "a"])).toEqual({ ok: true, ids: ["a", "b"] });
    expect(attachmentIds(["1", "2", "3", "4", "5"])).toMatchObject({ ok: true });
    expect(attachmentIds(["1", "2", "3", "4", "5", "6"])).toEqual({ ok: false, message: `You can attach up to ${MAX_ATTACHMENTS} files to a message.` });
    expect(attachmentIds("a")).toMatchObject({ ok: false });
    expect(attachmentIds([1])).toMatchObject({ ok: false });
  });

  it("match the file types the database and the bucket accept", () => {
    const sql = readFileSync("supabase/migrations/0096_staff_messages.sql", "utf8");
    const check = /mime_type text not null check \(mime_type in \(([^)]*)\)\)/.exec(sql);
    expect(check).not.toBeNull();
    const mimes = [...(check as RegExpExecArray)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    const bucket = readFileSync("supabase/migrations/0090_document_buckets.sql", "utf8");
    const allowed = /\('staff-messages', 'staff-messages', false, 10485760, array\[([^\]]*)\]\)/.exec(bucket);
    expect(allowed).not.toBeNull();
    expect([...(allowed as RegExpExecArray)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()).toEqual(mimes);
    expect(10485760).toBe(MAX_ATTACHMENT_BYTES);
  });
});

describe("search words", () => {
  it("are tidied and held to 2 to 100 characters", () => {
    expect(normaliseQuery("  launch   plan ")).toEqual({ ok: true, query: "launch plan" });
    expect(normaliseQuery("ab")).toMatchObject({ ok: true });
    expect(normaliseQuery("a")).toMatchObject({ ok: false });
    expect(normaliseQuery("  a  ")).toMatchObject({ ok: false });
    expect(normaliseQuery("")).toMatchObject({ ok: false });
    expect(normaliseQuery("x".repeat(100))).toMatchObject({ ok: true });
    expect(normaliseQuery("x".repeat(101))).toMatchObject({ ok: false });
    expect(normaliseQuery(42)).toMatchObject({ ok: false });
    expect(normaliseQuery("a" + char(0) + "b\nc")).toEqual({ ok: true, query: "a b c" });
  });

  it("are looked for as text: the characters a pattern would read are protected", () => {
    const bs = char(92);
    expect(escapeLike("100%_done" + bs)).toBe("100" + bs + "%" + bs + "_done" + bs + bs);
    expect(likePattern("a%b")).toBe("%a" + bs + "%b%");
    expect(escapeLike("plain text")).toBe("plain text");
  });

  it("show the piece of the message around the match", () => {
    expect(snippetOf("Please review the Launch plan before Friday", "launch")).toEqual({ text: "Please review the Launch plan before Friday", match: { start: 18, end: 24 } });
    const long = `${"x".repeat(200)} needle ${"y".repeat(200)}`;
    const s = snippetOf(long, "needle", 10);
    expect(s.text.startsWith("…")).toBe(true);
    expect(s.text.endsWith("…")).toBe(true);
    expect(s.match && s.text.slice(s.match.start, s.match.end)).toBe("needle");
    expect(snippetOf("nothing here", "zzz")).toEqual({ text: "nothing here", match: null });
    expect(snippetOf("a\n\nb   c", "b")).toMatchObject({ text: "a b c" });
  });

  it("is quick on 20,000 characters of anything awkward", () => {
    const started = Date.now();
    for (const raw of [" ".repeat(20_000), "a ".repeat(10_000), "\n".repeat(20_000) + "x", "x".repeat(20_000)]) {
      snippetOf(raw, "zz");
      snippetOf(raw, "x");
      normaliseQuery(raw);
    }
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("the notice about how messages are kept", () => {
  it("is shown as draft wording for counsel, says nothing it can't back, and never claims encryption or a policy", () => {
    expect(STAFF_MESSAGES_NOTICE_VERSION).toMatch(/^draft-\d{4}-\d{2}-\d{2}$/);
    expect(STAFF_MESSAGES_NOTICE_STATUS).toMatch(/draft/i);
    expect(STAFF_MESSAGES_NOTICE_STATUS).toMatch(/not been approved/i);
    expect(STAFF_MESSAGES_NOTICE_LINES.length).toBeGreaterThanOrEqual(4);
    const text = STAFF_MESSAGES_NOTICE_LINES.join(" ");
    expect(text).toMatch(/not by encryption/);
    expect(text).toMatch(/Super Admin cannot open a direct message/);
    expect(text).not.toMatch(/end-to-end|encrypted|confidential|guarantee|legal(ly)?\b/i);
    for (const line of STAFF_MESSAGES_NOTICE_LINES) expect(line.trim().endsWith("."), line).toBe(true);
  });
});

describe("who is told about a message", () => {
  const msg = { conversationId: "conv", messageId: "m1", authorId: A, mentions: [] as string[] };
  const person = (userId: string, over: Partial<{ notify: "all" | "mentions" | "none"; muted: boolean; lastReadSeq: number }> = {}) => ({ userId, notify: "all" as const, muted: false, lastReadSeq: 4, ...over });

  it("tells everyone who chose everything, except the author, once per unread burst", () => {
    const plan = planMessageNotices(msg, [person(A), person(B), person(C, { lastReadSeq: 9 })]);
    expect(plan).toEqual([
      { userId: B, kind: "staff_message_direct", dedupeKey: "staffmsg:conv:4" },
      { userId: C, kind: "staff_message_direct", dedupeKey: "staffmsg:conv:9" },
    ]);
  });

  it("tells a mentioned person even when the conversation is muted or set to mentions, and nobody who chose nothing", () => {
    const plan = planMessageNotices({ ...msg, mentions: [B.toUpperCase(), C] }, [person(B, { muted: true }), person(C, { notify: "mentions" }), person("d", { notify: "none" }), person("e", { notify: "mentions" }), person("f", { muted: true })]);
    expect(plan).toEqual([
      { userId: B, kind: "staff_message_mention", dedupeKey: "staffmention:m1" },
      { userId: C, kind: "staff_message_mention", dedupeKey: "staffmention:m1" },
    ]);
    expect(planMessageNotices({ ...msg, mentions: ["d"] }, [person("d", { notify: "none" })])).toEqual([]);
    expect(planMessageNotices({ ...msg, mentions: [A] }, [person(A)])).toEqual([]);
  });

  it("does not tell a muted person about an ordinary message, or one who chose mentions only", () => {
    expect(planMessageNotices(msg, [person(B, { muted: true }), person(C, { notify: "mentions" })])).toEqual([]);
  });

  it("writes plain words that carry no message text, and a link into the conversation", () => {
    expect(noticeWords("staff_message_direct", "direct", "Maya", null)).toEqual({ title: "New direct message", body: "From Maya." });
    expect(noticeWords("staff_message_direct", "group", "Maya", "Design")).toEqual({ title: "New message in a group", body: "Maya wrote in Design." });
    expect(noticeWords("staff_message_direct", "channel", "Maya", "general")).toEqual({ title: "New message in a channel", body: "Maya wrote in #general." });
    expect(noticeWords("staff_message_mention", "channel", "Maya", "general")).toEqual({ title: "You were mentioned", body: "Maya mentioned you in #general." });
    expect(noticeWords("staff_message_mention", "direct", "Maya", null).body).toBe("Maya mentioned you in a direct message.");
    expect(noticeWords("staff_message_added", "group", "Maya", "Design")).toEqual({ title: "You were added to a conversation", body: "Maya added you to Design." });
    expect(noticeWords("staff_message_added", "direct", "Maya", null).body).toBe("Maya started a direct message with you.");
    expect(noticeLink(A)).toBe(`/admin/messages/${A}`);
    // The link must pass the notification table's own check for an internal path.
    expect(noticeLink(A)).toMatch(/^\/[A-Za-z0-9/_?=&%.-]*$/);
  });
});
