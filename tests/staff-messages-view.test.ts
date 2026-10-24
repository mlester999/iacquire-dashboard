import { describe, expect, it } from "vitest";
import {
  attachmentLabel, conversationHref, dayKey, dayLabel, downloadHref, mergeLatest, mergeOlder, railSections, railTitle, timeline, unreadAria, FILE_ROUTE, MESSAGES_HOME,
  type RailEntry,
} from "@/lib/staff-messages/view";
import {
  activeMention, applyMention, budget, compileMentions, composeProblem, displayFromBody, filterMembers, newClientId, type ChosenMention,
} from "@/lib/staff-messages/composer";
import {
  accessLostText, backoffMs, connectionNotice, frameRevision, parseSnapshotQuery, pollDelayMs, snapshotQueryString, POLL_JITTER_MS, POLL_VISIBLE_MS, POLL_WITH_STREAM_MS,
} from "@/lib/staff-messages/live";
import { contentDispositionAttachment } from "@/lib/staff-messages/attachments";
import { MAX_BODY_CHARS } from "@/lib/staff-messages/limits";
import { mentionToken } from "@/lib/staff-messages/mentions";

// The rules behind the Messages screens, without a browser: how the rail is sectioned, how a conversation is laid out by day and by run of one author, how pages join, how a
// mention is written and read back, when to poll, and what a download is called. Pure; the clock and the random source are passed in.

const ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ID_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const entry = (over: Partial<RailEntry> & { id: string }): RailEntry => ({
  kind: "group", visibility: "staff", name: "Group", topic: null, archived: false, lastSeq: 0, lastReadSeq: 0, unread: 0, muted: false, notify: "all", lastMessageAt: null, memberCount: 3, peer: null, ...over,
});

describe("the rail", () => {
  const entries: RailEntry[] = [
    entry({ id: "d1", kind: "direct", name: "Maya Santos", peer: { id: ID_B, name: "Maya Santos", former: false }, unread: 2 }),
    entry({ id: "g1", kind: "group", name: "Launch crew" }),
    entry({ id: "c1", kind: "channel", name: "general", unread: 5 }),
    entry({ id: "c2", kind: "channel", name: "random", archived: true }),
    entry({ id: "d2", kind: "direct", name: "Former team member", peer: { id: ID_C, name: "Former team member", former: true } }),
  ];

  it("sorts conversations into direct messages, groups, channels and archived, in the order the server sent them, and leaves empty sections out", () => {
    const sections = railSections(entries, { filter: "all", query: "" });
    expect(sections.map((s) => [s.key, s.label, s.entries.map((e) => e.id)])).toEqual([
      ["direct", "Direct messages", ["d1", "d2"]],
      ["group", "Groups", ["g1"]],
      ["channel", "Channels", ["c1"]],
      ["archived", "Archived", ["c2"]],
    ]);
    expect(railSections([], { filter: "all", query: "" })).toEqual([]);
    expect(railSections([entry({ id: "only", kind: "channel", name: "x" })], { filter: "all", query: "" }).map((s) => s.key)).toEqual(["channel"]);
  });

  it("filters to what is unread, and by what the person typed (names, with a # in front of a channel)", () => {
    expect(railSections(entries, { filter: "unread", query: "" }).flatMap((s) => s.entries.map((e) => e.id))).toEqual(["d1", "c1"]);
    expect(railSections(entries, { filter: "all", query: "  MAYA " }).flatMap((s) => s.entries.map((e) => e.id))).toEqual(["d1"]);
    expect(railSections(entries, { filter: "all", query: "#gen" }).flatMap((s) => s.entries.map((e) => e.id))).toEqual(["c1"]);
    expect(railSections(entries, { filter: "all", query: "nobody" })).toEqual([]);
    // The filter and the query together.
    expect(railSections(entries, { filter: "unread", query: "gen" }).flatMap((s) => s.entries.map((e) => e.id))).toEqual(["c1"]);
  });

  it("names a channel with a #, everything else as it is called, and an unnamed one honestly", () => {
    expect(railTitle(entry({ id: "x", kind: "channel", name: "general" }))).toBe("#general");
    expect(railTitle(entry({ id: "x", kind: "group", name: "Launch crew" }))).toBe("Launch crew");
    expect(railTitle(entry({ id: "x", kind: "group", name: "" }))).toBe("Unnamed conversation");
  });

  it("reads the unread count aloud in words, with a muted conversation saying so", () => {
    expect(unreadAria(0, false)).toBe("No unread messages");
    expect(unreadAria(1, false)).toBe("1 unread message");
    expect(unreadAria(7, false)).toBe("7 unread messages");
    expect(unreadAria(250, false)).toBe("More than 99 unread messages");
    expect(unreadAria(3, true)).toBe("3 unread messages, muted");
    expect(unreadAria(0, true)).toBe("No unread messages, muted");
  });

  it("filters a very long query without trouble", () => {
    const started = Date.now();
    expect(railSections(entries, { filter: "all", query: "a".repeat(20_000) })).toEqual([]);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("days", () => {
  const NOW = new Date("2026-10-24T03:30:00.000Z");

  it("names the day in the person's own time zone, not in UTC", () => {
    // 03:30 UTC on the 24th is still the 23rd in Chicago (22:30) and already the 24th in Manila (11:30).
    expect(dayKey("2026-10-24T03:30:00.000Z", "America/Chicago")).toBe("2026-10-23");
    expect(dayKey("2026-10-24T03:30:00.000Z", "Asia/Manila")).toBe("2026-10-24");
    expect(dayKey("2026-10-24T03:30:00.000Z", "UTC")).toBe("2026-10-24");
  });

  it("falls back to UTC for a time zone that does not exist, and to nothing for a date that does not", () => {
    expect(dayKey("2026-10-24T03:30:00.000Z", "Not/AZone")).toBe("2026-10-24");
    expect(dayKey("nonsense", "UTC")).toBe("");
  });

  it("says Today and Yesterday relative to now in the person's zone, and a plain date otherwise", () => {
    expect(dayLabel("2026-10-24T01:00:00.000Z", NOW, "America/Chicago")).toBe("Today");
    expect(dayLabel("2026-10-23T01:00:00.000Z", NOW, "America/Chicago")).toBe("Yesterday");
    expect(dayLabel("2026-10-20T15:00:00.000Z", NOW, "America/Chicago")).toBe("Tue, Oct 20");
    // A different year carries the year.
    expect(dayLabel("2025-12-31T15:00:00.000Z", NOW, "UTC")).toBe("Wed, Dec 31, 2025");
    // Across a month boundary, yesterday is still yesterday.
    expect(dayLabel("2026-09-30T12:00:00.000Z", new Date("2026-10-01T12:00:00.000Z"), "UTC")).toBe("Yesterday");
    expect(dayLabel("nonsense", NOW, "UTC")).toBe("");
  });
});

describe("laying a conversation out", () => {
  const msg = (seq: number, authorId: string | null, at: string, extra: Partial<{ deleted: boolean }> = {}) => ({ id: `m${seq}`, seq, authorId, createdAt: at, deleted: extra.deleted ?? false });
  const NOW = new Date("2026-10-24T18:00:00.000Z");
  const run = (messages: ReturnType<typeof msg>[], afterSeq: number | null = null) => timeline(messages, { now: NOW, timeZone: "UTC", afterSeq });
  const shape = (items: ReturnType<typeof run>) => items.map((i) => (i.type === "message" ? `${i.message.id}${i.header ? "*" : ""}` : i.type === "day" ? `day:${i.label}` : "unread"));

  it("puts a day heading before each day and the author line on the first of a run by one person", () => {
    const items = run([
      msg(1, ID_A, "2026-10-23T09:00:00.000Z"),
      msg(2, ID_A, "2026-10-23T09:02:00.000Z"),
      msg(3, ID_B, "2026-10-23T09:03:00.000Z"),
      msg(4, ID_B, "2026-10-24T08:00:00.000Z"),
      msg(5, ID_B, "2026-10-24T08:01:00.000Z"),
    ]);
    expect(shape(items)).toEqual(["day:Yesterday", "m1*", "m2", "m3*", "day:Today", "m4*", "m5"]);
  });

  it("starts a new run after a gap of more than five minutes, a deleted message, or a message with no author", () => {
    expect(shape(run([msg(1, ID_A, "2026-10-24T09:00:00.000Z"), msg(2, ID_A, "2026-10-24T09:05:00.000Z"), msg(3, ID_A, "2026-10-24T09:10:01.000Z")]))).toEqual(["day:Today", "m1*", "m2", "m3*"]);
    expect(shape(run([msg(1, ID_A, "2026-10-24T09:00:00.000Z", { deleted: true }), msg(2, ID_A, "2026-10-24T09:01:00.000Z")]))).toEqual(["day:Today", "m1*", "m2*"]);
    expect(shape(run([msg(1, null, "2026-10-24T09:00:00.000Z"), msg(2, null, "2026-10-24T09:01:00.000Z")]))).toEqual(["day:Today", "m1*", "m2*"]);
  });

  it("marks where the unread messages begin, once, and repeats the author line after it", () => {
    const items = run([msg(1, ID_B, "2026-10-24T09:00:00.000Z"), msg(2, ID_B, "2026-10-24T09:01:00.000Z"), msg(3, ID_B, "2026-10-24T09:02:00.000Z")], 1);
    expect(shape(items)).toEqual(["day:Today", "m1*", "unread", "m2*", "m3"]);
    // Nothing unread, or the person has read to the end: no marker.
    expect(shape(run([msg(1, ID_B, "2026-10-24T09:00:00.000Z")], 1)).includes("unread")).toBe(false);
    expect(shape(run([msg(1, ID_B, "2026-10-24T09:00:00.000Z")], null)).includes("unread")).toBe(false);
    // Everything is unread: the marker sits above the first message, below its day heading.
    expect(shape(run([msg(1, ID_B, "2026-10-24T09:00:00.000Z")], 0))).toEqual(["day:Today", "unread", "m1*"]);
  });

  it("never loses, repeats or reorders a message", () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let round = 0; round < 40; round++) {
      const messages = Array.from({ length: 1 + Math.floor(rand() * 30) }, (_, i) => msg(i + 1, rand() < 0.1 ? null : [ID_A, ID_B, ID_C][Math.floor(rand() * 3)], new Date(Date.UTC(2026, 9, 20) + i * Math.floor(rand() * 4_000_000) + i * 60_000).toISOString(), { deleted: rand() < 0.1 }));
      const items = timeline(messages, { now: NOW, timeZone: "America/Chicago", afterSeq: rand() < 0.5 ? Math.floor(rand() * messages.length) : null });
      const out = items.flatMap((i) => (i.type === "message" ? [i.message.id] : []));
      expect(out).toEqual(messages.map((m) => m.id));
      expect(items.filter((i) => i.type === "unread").length).toBeLessThanOrEqual(1);
      const keys = items.map((i) => i.key);
      expect(new Set(keys).size).toBe(keys.length);
      const first = items.find((i) => i.type === "message");
      expect(first && first.type === "message" && first.header).toBe(true);
    }
    expect(run([])).toEqual([]);
  });
});

describe("joining pages", () => {
  const m = (seq: number, text = "") => ({ id: `m${seq}`, seq, text });

  it("lets the newest page replace the tail it covers and keeps the older messages already loaded", () => {
    const loaded = [m(1), m(2), m(3), m(4)];
    const latest = [m(3, "edited"), m(4), m(5)];
    expect(mergeLatest(loaded, latest).map((x) => x.id + x.text)).toEqual(["m1", "m2", "m3edited", "m4", "m5"]);
  });

  it("drops a message from the tail that the server no longer lists, and keeps nothing when the server lists nothing", () => {
    expect(mergeLatest([m(1), m(2), m(3)], [m(1), m(3)]).map((x) => x.id)).toEqual(["m1", "m3"]);
    expect(mergeLatest([m(1), m(2)], [])).toEqual([]);
    expect(mergeLatest([], [m(1)])).toEqual([m(1)]);
  });

  it("puts an older page above what is loaded, once", () => {
    expect(mergeOlder([m(5), m(6)], [m(2), m(3), m(4)]).map((x) => x.id)).toEqual(["m2", "m3", "m4", "m5", "m6"]);
    // A page that overlaps what is loaded adds only what is older.
    expect(mergeOlder([m(5), m(6)], [m(4), m(5)]).map((x) => x.id)).toEqual(["m4", "m5", "m6"]);
    expect(mergeOlder([], [m(1)])).toEqual([m(1)]);
    expect(mergeOlder([m(5)], [])).toEqual([m(5)]);
  });

  it("stays sorted and free of repeats however pages arrive", () => {
    let seed = 11;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    let loaded = [m(50), m(51)];
    for (let i = 0; i < 60; i++) {
      if (rand() < 0.5) {
        const low = Math.max(1, loaded[0].seq - 1 - Math.floor(rand() * 5));
        loaded = mergeOlder(loaded, Array.from({ length: loaded[0].seq - low }, (_, k) => m(low + k)));
      } else {
        const top = loaded[loaded.length - 1].seq;
        const start = Math.max(loaded[0].seq, top - Math.floor(rand() * 4));
        loaded = mergeLatest(loaded, Array.from({ length: top - start + 1 + Math.floor(rand() * 3) }, (_, k) => m(start + k)));
      }
      const seqs = loaded.map((x) => x.seq);
      expect(seqs).toEqual([...new Set(seqs)].sort((a, b) => a - b));
    }
  });
});

describe("file links", () => {
  it("builds the conversation and download addresses from ids, never from names", () => {
    expect(MESSAGES_HOME).toBe("/admin/messages");
    expect(FILE_ROUTE).toBe("/api/admin/messages/files");
    expect(conversationHref(ID_A)).toBe(`/admin/messages/${ID_A}`);
    expect(downloadHref(ID_B)).toBe(`/api/admin/messages/files/${ID_B}`);
  });

  it("labels a file by name and size", () => {
    expect(attachmentLabel({ filename: "plan.pdf", sizeBytes: 2048 })).toBe("plan.pdf, 2.0 KB");
    expect(attachmentLabel({ filename: "notes.txt", sizeBytes: 12 })).toBe("notes.txt, 12 B");
  });

  it("writes a download header that cannot be split or quoted out of, and carries a non-Latin name", () => {
    const plain = contentDispositionAttachment("report.pdf");
    expect(plain).toBe(`attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`);
    const nasty = contentDispositionAttachment('a"b\r\nSet-Cookie: x=1\\.pdf');
    expect(nasty).not.toMatch(/[\r\n]/);
    expect(nasty.startsWith("attachment; filename=\"")).toBe(true);
    const quoted = /filename="([^"]*)"/.exec(nasty);
    expect(quoted?.[1]).not.toMatch(/["\\]/);
    const accented = contentDispositionAttachment("résumé 日本.pdf");
    expect(accented).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9%20%E6%97%A5%E6%9C%AC.pdf");
    expect(/filename="([^"]*)"/.exec(accented)?.[1]).toMatch(/^[\x20-\x7e]*$/);
    expect(contentDispositionAttachment("")).toContain('filename="download"');
  });
});

describe("writing a mention", () => {
  const members: ChosenMention[] = [
    { id: ID_A, name: "Avery Admin" },
    { id: ID_B, name: "Maya Santos" },
    { id: ID_C, name: "Maya" },
  ];

  it("finds the word being typed after an @, and nothing in an address or a sentence", () => {
    expect(activeMention("hello @ma", 9)).toEqual({ start: 6, query: "ma" });
    expect(activeMention("@", 1)).toEqual({ start: 0, query: "" });
    expect(activeMention("@Maya San", 9)).toEqual({ start: 0, query: "Maya San" });
    expect(activeMention("mail me at a@b.com", 18)).toBeNull();
    expect(activeMention("see @ 5pm", 9)).toBeNull();
    expect(activeMention("hello @ma\nnext line", 19)).toBeNull();
    expect(activeMention("hello", 5)).toBeNull();
    // The caret in the middle of the text only looks left of itself.
    expect(activeMention("hi @ma and more", 6)).toEqual({ start: 3, query: "ma" });
  });

  it("offers members by name, best match first, never the person writing, at most eight", () => {
    expect(filterMembers(members, "may", ID_A).map((m) => m.name)).toEqual(["Maya", "Maya Santos"]);
    // A name that only contains the word comes after the ones that start with it.
    expect(filterMembers([{ id: ID_A, name: "Ana Maya" }, ...members.slice(1)], "may", ID_C).map((m) => m.name)).toEqual(["Maya Santos", "Ana Maya"]);
    // Nothing typed yet: everyone else, alphabetically ("Maya" before "Maya Santos").
    expect(filterMembers(members, "", ID_A).map((m) => m.id)).toEqual([ID_C, ID_B]);
    expect(filterMembers([{ id: ID_A, name: "Zed" }, { id: ID_B, name: "Al" }, { id: ID_C, name: "Bartholomew" }], "", "00000000-0000-4000-8000-000000000000").map((m) => m.name)).toEqual(["Al", "Bartholomew", "Zed"]);
    expect(filterMembers(members, "avery", ID_A)).toEqual([]);
    expect(filterMembers(members, "AVERY", ID_B).map((m) => m.id)).toEqual([ID_A]);
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `${i}`.padStart(8, "0") + ID_A.slice(8), name: `Person ${i}` }));
    expect(filterMembers(many, "person", ID_A)).toHaveLength(8);
    expect(filterMembers(members, "x".repeat(20_000), ID_A)).toEqual([]);
  });

  it("puts the chosen name in the text and moves the caret past it", () => {
    const out = applyMention("hello @ma and more", 6, 9, { id: ID_B, name: "Maya Santos" });
    expect(out).toEqual({ text: "hello @Maya Santos  and more", caret: 19 });
    expect(applyMention("@", 0, 1, { id: ID_A, name: "Avery Admin" })).toEqual({ text: "@Avery Admin ", caret: 13 });
  });

  it("turns the names the person chose back into the ids the server expects, and only those", () => {
    const chosen = [{ id: ID_B, name: "Maya Santos" }, { id: ID_C, name: "Maya" }];
    expect(compileMentions("hi @Maya Santos and @Maya!", chosen)).toBe(`hi ${mentionToken(ID_B)} and ${mentionToken(ID_C)}!`);
    // A name that was typed by hand, without choosing it, stays plain text; so does a longer word that merely starts with a chosen name.
    expect(compileMentions("hi @Avery", chosen)).toBe("hi @Avery");
    expect(compileMentions("hi @Mayakovsky", chosen)).toBe("hi @Mayakovsky");
    // A chosen name that was edited away is not sent.
    expect(compileMentions("hi @Maya Sant", [{ id: ID_B, name: "Maya Santos" }])).toBe("hi @Maya Sant");
    // Not after a word (an email address).
    expect(compileMentions("write to x@Maya now", chosen)).toBe("write to x@Maya now");
    expect(compileMentions("", chosen)).toBe("");
    expect(compileMentions("plain", [])).toBe("plain");
  });

  it("reads a stored message back into names for editing, and back again to the same text", () => {
    const body = `Thanks ${mentionToken(ID_B)}, and ${mentionToken(ID_C)}. Also ${mentionToken(ID_A)}`;
    const names = new Map([[ID_B, "Maya Santos"], [ID_C, "Maya"]]);
    const shown = displayFromBody(body, (id) => names.get(id) ?? null);
    expect(shown.text).toBe("Thanks @Maya Santos, and @Maya. Also @someone");
    expect(shown.chosen.map((c) => c.id).sort()).toEqual([ID_B, ID_C].sort());
    expect(compileMentions(shown.text, shown.chosen)).toBe(`Thanks ${mentionToken(ID_B)}, and ${mentionToken(ID_C)}. Also @someone`);
  });

  it("round-trips any mix of names", () => {
    let seed = 3;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const pool: ChosenMention[] = [{ id: ID_A, name: "Avery Admin" }, { id: ID_B, name: "Maya Santos" }, { id: ID_C, name: "Maya" }];
    for (let i = 0; i < 100; i++) {
      const parts: string[] = [];
      const used: ChosenMention[] = [];
      for (let k = 0; k < 1 + Math.floor(rand() * 6); k++) {
        if (rand() < 0.5) {
          const who = pool[Math.floor(rand() * pool.length)];
          parts.push(`@${who.name}`);
          used.push(who);
        } else parts.push(["hello", "see", "and", "ok"][Math.floor(rand() * 4)]);
      }
      const text = parts.join(" ");
      const tokens = compileMentions(text, pool);
      const back = displayFromBody(tokens, (id) => pool.find((p) => p.id === id)?.name ?? null);
      expect(back.text).toBe(text);
    }
  });

  it("handles a pasted wall of text in linear time", () => {
    const started = Date.now();
    const wall = "@".repeat(20_000);
    expect(activeMention(wall, wall.length)).toBeNull();
    expect(compileMentions(wall, members)).toBe(wall);
    expect(compileMentions("@Maya ".repeat(3_000), members).length).toBeGreaterThan(0);
    expect(displayFromBody("<@".repeat(10_000), () => null).text).toBe("<@".repeat(10_000));
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe("what the composer will send", () => {
  it("counts characters the way the server does and warns before the limit", () => {
    expect(budget("")).toMatchObject({ chars: 0, over: false, near: false });
    expect(budget("a".repeat(MAX_BODY_CHARS))).toMatchObject({ chars: MAX_BODY_CHARS, over: false, near: true, remaining: 0 });
    expect(budget("a".repeat(MAX_BODY_CHARS + 1))).toMatchObject({ over: true, remaining: -1 });
    expect(budget("a".repeat(MAX_BODY_CHARS * 0.85)).near).toBe(false);
    // A pair of characters outside the basic plane is one character.
    expect(budget(String.fromCodePoint(0x1f600)).chars).toBe(1);
  });

  it("says why a message cannot be sent, in the server's words, and nothing when it can", () => {
    expect(composeProblem("   ", [])).toBe("Write something before you send.");
    expect(composeProblem("a".repeat(MAX_BODY_CHARS + 1), [])).toBe(`A message can be up to ${MAX_BODY_CHARS.toLocaleString("en-US")} characters.`);
    expect(composeProblem("Hello", [])).toBeNull();
    expect(composeProblem("Hi @Maya", [{ id: ID_C, name: "Maya" }])).toBeNull();
  });

  it("makes a version 4 id from any source of random bytes, the same shape every time", () => {
    const zeros = newClientId((n) => new Uint8Array(n));
    expect(zeros).toBe("00000000-0000-4000-8000-000000000000");
    const ones = newClientId((n) => new Uint8Array(n).fill(255));
    expect(ones).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    // A small linear congruential generator: different bytes every call, the same on every run.
    let state = 12345;
    const nextByte = () => {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0;
      return (state >>> 16) & 255;
    };
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) seen.add(newClientId((n) => Uint8Array.from({ length: n }, nextByte)));
    expect(seen.size).toBe(50);
    for (const id of seen) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("keeping a page in step", () => {
  it("polls a visible tab every fifteen to twenty seconds, slowly while a stream is open, and not at all while hidden", () => {
    expect(POLL_VISIBLE_MS).toBe(15_000);
    expect(POLL_JITTER_MS).toBe(5_000);
    expect(pollDelayMs({ connection: "polling", visible: true, jitter: 0 })).toBe(15_000);
    expect(pollDelayMs({ connection: "polling", visible: true, jitter: 1 })).toBe(20_000);
    expect(pollDelayMs({ connection: "reconnecting", visible: true, jitter: 0.5 })).toBe(17_500);
    expect(pollDelayMs({ connection: "live", visible: true, jitter: 0 })).toBe(POLL_WITH_STREAM_MS);
    expect(pollDelayMs({ connection: "live", visible: false, jitter: 0 })).toBeNull();
    expect(pollDelayMs({ connection: "polling", visible: false, jitter: 0 })).toBeNull();
    // Out-of-range jitter is clamped, never produces a negative or huge wait.
    expect(pollDelayMs({ connection: "polling", visible: true, jitter: -4 })).toBe(15_000);
    expect(pollDelayMs({ connection: "polling", visible: true, jitter: 9 })).toBe(20_000);
  });

  it("backs a failed stream off to thirty seconds and no further", () => {
    expect([0, 1, 2, 3, 4, 5, 20].map(backoffMs)).toEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    expect(backoffMs(-3)).toBe(2000);
  });

  it("reads the revision out of a stream frame and ignores anything else", () => {
    expect(frameRevision('{"revision":12}')).toBe(12);
    expect(frameRevision('{"revision":0}')).toBe(0);
    expect(frameRevision('{"revision":-1}')).toBeNull();
    expect(frameRevision('{"revision":1.5}')).toBeNull();
    expect(frameRevision('{"revision":"7"}')).toBeNull();
    expect(frameRevision("not json")).toBeNull();
    expect(frameRevision("null")).toBeNull();
    expect(frameRevision("{}")).toBeNull();
  });

  it("tells the person only what is true about the connection", () => {
    expect(connectionNotice("live", false)).toBeNull();
    expect(connectionNotice("polling", false)).toBeNull();
    expect(connectionNotice("reconnecting", false)).toBeNull();
    expect(connectionNotice("polling", true)).toMatch(/offline/i);
    expect(connectionNotice("live", true)).toMatch(/offline/i);
  });

  it("explains a lost access in plain words", () => {
    expect(accessLostText("not_enabled")).toMatch(/switched off/i);
    expect(accessLostText("forbidden")).toMatch(/no longer/i);
    expect(accessLostText("signed_out")).toMatch(/sign in/i);
  });

  it("reads the snapshot query strictly and builds it back the same", () => {
    const ok = (qs: string) => parseSnapshotQuery(new URLSearchParams(qs));
    expect(ok("")).toEqual({ ok: true, q: { since: null, conversationId: null, threadRootId: null, beforeSeq: null, aroundSeq: null, badgeOnly: false } });
    expect(ok(`since=12&conversation=${ID_A}&thread=${ID_B}`)).toEqual({ ok: true, q: { since: 12, conversationId: ID_A, threadRootId: ID_B, beforeSeq: null, aroundSeq: null, badgeOnly: false } });
    expect(ok(`conversation=${ID_A}&before=40`)).toEqual({ ok: true, q: { since: null, conversationId: ID_A, threadRootId: null, beforeSeq: 40, aroundSeq: null, badgeOnly: false } });
    expect(ok(`conversation=${ID_A}&around=120`)).toEqual({ ok: true, q: { since: null, conversationId: ID_A, threadRootId: null, beforeSeq: null, aroundSeq: 120, badgeOnly: false } });
    expect(ok("badge=1")).toEqual({ ok: true, q: { since: null, conversationId: null, threadRootId: null, beforeSeq: null, aroundSeq: null, badgeOnly: true } });
    for (const bad of ["since=-1", "since=1.5", "since=abc", "conversation=nope", `thread=${ID_B}`, `conversation=${ID_A}&thread=nope`, `before=5`, `conversation=${ID_A}&before=0`, `conversation=${ID_A}&before=x`, `around=5`, `conversation=${ID_A}&around=0`, `conversation=${ID_A}&around=-3`, `since=${"9".repeat(30)}`]) {
      expect(ok(bad), bad).toMatchObject({ ok: false });
    }
    const q = { since: 3, conversationId: ID_A, threadRootId: ID_B, beforeSeq: null, aroundSeq: null, badgeOnly: false };
    expect(snapshotQueryString(q)).toBe(`since=3&conversation=${ID_A}&thread=${ID_B}`);
    expect(ok(snapshotQueryString(q))).toEqual({ ok: true, q });
    expect(snapshotQueryString({ since: null, conversationId: null, threadRootId: null, beforeSeq: null, aroundSeq: null, badgeOnly: true })).toBe("badge=1");
    const around = { since: null, conversationId: ID_A, threadRootId: null, beforeSeq: null, aroundSeq: 77, badgeOnly: false };
    expect(ok(snapshotQueryString(around))).toEqual({ ok: true, q: around });
  });
});
