// How the agency's Prospects screens read a prospect: which buttons a person may see, how the list's filters travel in an address, and how a moment or a timeline line is put into
// words. Pure (no database). The buttons are a convenience: the server decides every action again (tests/demo-admin.test.ts).
import { describe, expect, it } from "vitest";
import {
  availableActions, describeEvent, inviteOutcome, listHref, parseListQuery, spanWords, STATUS_FILTERS, STATUS_LABEL, STATUS_TONE, visitorsSee, windowWords, type ActionFacts, type ActionSet,
} from "@/lib/demo/admin-view";
import { DEMO_EVENT_KINDS, DEMO_EVENT_LABELS } from "@/lib/demo/events";
import { canTransition, PROSPECT_STATUSES, type AccessState, type ProspectStatus } from "@/lib/demo/rules";

const ID = "3f2c9a4e-0b1d-4c7a-9e55-6a1b2c3d4e5f";
const ACCESS: AccessState[] = ["unverified", "open", "ended", "blocked", "converted", "erased"];

const facts = (over: Partial<ActionFacts> = {}): ActionFacts => ({
  status: "active", access: "open", erased: false, verified: true, messageCount: 4, consultationRequested: false, consultationDone: false, conversionInProgress: false, converted: false,
  extension: { hoursLeft: 48, messagesLeft: 10 }, ...over,
});
const MANAGE = { view: true, manage: true };
const VIEW = { view: true, manage: false };
const NOTHING = { view: false, manage: false };
const on = (a: ActionSet) => Object.entries(a).filter(([, v]) => v).map(([k]) => k).sort();

describe("words for each state", () => {
  it("has a label and a tone for every status, and a filter for each", () => {
    for (const s of PROSPECT_STATUSES) {
      expect(STATUS_LABEL[s], s).toBeTruthy();
      expect(STATUS_TONE[s], s).toBeTruthy();
    }
    expect([...STATUS_FILTERS]).toEqual(["all", ...PROSPECT_STATUSES]);
    expect(new Set(Object.values(STATUS_LABEL)).size).toBe(PROSPECT_STATUSES.length);
  });

  it("says what visitors get right now from the switches, in the order the server checks them", () => {
    const base = { environment: true, emergencyStop: false, enabled: true, aiEnabled: false };
    expect(visitorsSee({ ...base, emergencyStop: true, environment: false, enabled: false })).toMatchObject({ tone: "danger" });
    expect(visitorsSee({ ...base, environment: false })).toMatchObject({ tone: "warning", text: expect.stringContaining("DEMO_ENABLED") });
    expect(visitorsSee({ ...base, enabled: false })).toMatchObject({ tone: "warning", text: expect.stringContaining("demo settings") });
    expect(visitorsSee(base)).toMatchObject({ tone: "success", text: expect.stringContaining("AI chat is switched off") });
    const ai = visitorsSee({ ...base, aiEnabled: true });
    expect(ai.tone).toBe("success");
    expect(ai.text).toMatch(/still needs a connected language model/);
  });

  it("says whether a language model is really connected when the page looked, instead of always saying the chat still needs one", () => {
    const on = { environment: true, emergencyStop: false, enabled: true, aiEnabled: true };
    expect(visitorsSee({ ...on, modelReady: true })).toEqual({ tone: "success", text: "The demo is open. The AI chat is on and a language model is connected." });
    expect(visitorsSee({ ...on, modelReady: false })).toMatchObject({ tone: "warning", text: expect.stringContaining("no language model is connected") });
    // With the chat switched off the model does not matter.
    expect(visitorsSee({ ...on, aiEnabled: false, modelReady: false }).text).toMatch(/AI chat is switched off/);
  });
});

describe("the list's filters in an address", () => {
  it("uses the defaults for anything it does not understand", () => {
    expect(parseListQuery({})).toEqual({ status: "all", owner: "", search: "", after: null });
    expect(parseListQuery({ status: "nonsense", owner: "someone", q: ["a", "b"], at: "yesterday", id: "x" })).toEqual({ status: "all", owner: "", search: "", after: null });
  });

  it("accepts a status, 'nobody', an owner id and a paging position that is complete and well-formed", () => {
    expect(parseListQuery({ status: "blocked" }).status).toBe("blocked");
    expect(parseListQuery({ owner: "none" }).owner).toBe("none");
    expect(parseListQuery({ owner: ID }).owner).toBe(ID);
    expect(parseListQuery({ at: "2026-11-02T09:00:00.123Z", id: ID }).after).toEqual({ createdAt: "2026-11-02T09:00:00.123Z", id: ID });
    expect(parseListQuery({ at: "2026-11-02T09:00:00.123Z" }).after).toBeNull();
    expect(parseListQuery({ id: ID }).after).toBeNull();
    expect(parseListQuery({ at: "2026-11-02 09:00:00", id: ID }).after).toBeNull();
  });

  it("tidies a search: one space between words, cut at a hundred characters", () => {
    expect(parseListQuery({ q: "  pat \n\t  roofing  " }).search).toBe("pat roofing");
    expect(parseListQuery({ q: "x".repeat(500) }).search).toHaveLength(100);
  });

  it("keeps SQL and markup in a search as plain text (the service binds it), and a status injection out", () => {
    expect(parseListQuery({ q: "' or 1=1 --" }).search).toBe("' or 1=1 --");
    expect(parseListQuery({ status: "all'; drop table demo_prospects;--" }).status).toBe("all");
  });

  it("leaves the defaults out of an address and round-trips everything else", () => {
    expect(listHref({})).toBe("/admin/prospects");
    expect(listHref({ status: "all", owner: "", search: "" })).toBe("/admin/prospects");
    const query = { status: "active" as const, owner: ID, search: "pat's & co", after: { createdAt: "2026-11-02T09:00:00.123Z", id: ID } };
    const href = listHref(query);
    const params = Object.fromEntries(new URL(`http://x${href}`).searchParams);
    expect(parseListQuery(params)).toEqual(query);
    expect(href).not.toContain(" ");
  });
});

describe("which buttons", () => {
  it("shows a person who may only view nothing but reading the conversation, and a person who may do neither nothing at all", () => {
    for (const status of PROSPECT_STATUSES) for (const access of ACCESS) {
      expect(on(availableActions(facts({ status, access }), VIEW)).filter((k) => k !== "readTranscript"), `${status} ${access}`).toEqual([]);
      expect(on(availableActions(facts({ status, access }), NOTHING)), `${status} ${access}`).toEqual([]);
    }
    expect(availableActions(facts(), VIEW).readTranscript).toBe(true);
    expect(availableActions(facts({ messageCount: 0 }), VIEW).readTranscript).toBe(false);
  });

  it("offers an open demo everything a Super Admin may do", () => {
    expect(on(availableActions(facts(), MANAGE))).toEqual(["assign", "block", "convert", "decline", "erase", "expireNow", "exportData", "extend", "note", "readTranscript"]);
  });

  it("offers nothing on an erased prospect: there is nothing left to act on", () => {
    for (const status of PROSPECT_STATUSES) expect(on(availableActions(facts({ status, erased: true, access: "erased" }), MANAGE)), status).toEqual([]);
  });

  it("offers a client only what leaves the record alone: no block, decline, convert, extend or end", () => {
    const a = availableActions(facts({ status: "converted", access: "converted", converted: true }), MANAGE);
    expect(on(a)).toEqual(["assign", "erase", "exportData", "note", "readTranscript"]);
  });

  it("offers reopening to a blocked or declined prospect and to nobody else", () => {
    for (const status of PROSPECT_STATUSES) {
      const a = availableActions(facts({ status, access: status === "blocked" || status === "declined" ? "blocked" : "open", converted: status === "converted" }), MANAGE);
      expect(a.reopen, status).toBe(status === "blocked" || status === "declined");
    }
    const blocked = availableActions(facts({ status: "blocked", access: "blocked" }), MANAGE);
    expect(blocked.block).toBe(false);
    expect(blocked.convert).toBe(false);
    expect(blocked.extend).toBe(false);
  });

  it("offers each change only when the rules allow the move, so a button never leads to a refusal the screen could have known", () => {
    for (const status of PROSPECT_STATUSES) {
      const a = availableActions(facts({ status, access: "open", converted: status === "converted" }), MANAGE);
      if (status !== "converted") {
        expect(a.block, status).toBe(canTransition(status, "blocked"));
        expect(a.decline, status).toBe(canTransition(status, "declined"));
      } else {
        expect(a.block || a.decline).toBe(false);
      }
    }
  });

  it("offers an extension only to a prospect who has started, who is not closed, and who still has room under the limits", () => {
    expect(availableActions(facts({ verified: false, status: "unverified", access: "unverified" }), MANAGE).extend).toBe(false);
    expect(availableActions(facts({ status: "expired", access: "ended" }), MANAGE).extend).toBe(true);
    expect(availableActions(facts({ extension: { hoursLeft: 0, messagesLeft: 5 } }), MANAGE).extend).toBe(true);
    expect(availableActions(facts({ extension: { hoursLeft: 5, messagesLeft: 0 } }), MANAGE).extend).toBe(true);
    expect(availableActions(facts({ extension: { hoursLeft: 0, messagesLeft: 0 } }), MANAGE).extend).toBe(false);
    expect(availableActions(facts({ status: "blocked", access: "blocked" }), MANAGE).extend).toBe(false);
  });

  it("offers 'end now' only while the window is open, and 'consultation held' only once it was asked for and not yet held", () => {
    for (const access of ACCESS) expect(availableActions(facts({ access }), MANAGE).expireNow, access).toBe(access === "open");
    expect(availableActions(facts({ consultationRequested: false }), MANAGE).consultationDone).toBe(false);
    expect(availableActions(facts({ consultationRequested: true }), MANAGE).consultationDone).toBe(true);
    expect(availableActions(facts({ consultationRequested: true, consultationDone: true }), MANAGE).consultationDone).toBe(false);
  });

  it("offers 'make a client' only to a confirmed prospect who is not blocked, not already a client and not being made one right now", () => {
    expect(availableActions(facts(), MANAGE).convert).toBe(true);
    expect(availableActions(facts({ conversionInProgress: true }), MANAGE).convert).toBe(false);
    expect(availableActions(facts({ verified: false, status: "unverified", access: "unverified" }), MANAGE).convert).toBe(false);
    for (const status of ["blocked", "declined", "converted"] as ProspectStatus[]) expect(availableActions(facts({ status, converted: status === "converted" }), MANAGE).convert, status).toBe(false);
    expect(availableActions(facts({ status: "consultation_requested" }), MANAGE).convert).toBe(true);
    expect(availableActions(facts({ status: "purchase_started" }), MANAGE).convert).toBe(true);
  });

  it("offers reading a conversation only when there is one", () => {
    expect(availableActions(facts({ messageCount: 0 }), MANAGE).readTranscript).toBe(false);
    expect(availableActions(facts({ messageCount: 1 }), MANAGE).readTranscript).toBe(true);
  });
});

describe("what the browser is told about the owner's invitation", () => {
  it("hands over the link only when the email did not really leave", () => {
    expect(inviteOutcome({ status: "sent" }, "https://x.test/invite/abc")).toEqual({ emailStatus: "sent", emailError: null, inviteLink: null });
    expect(inviteOutcome({ status: "failed", error: "mailbox full" }, "https://x.test/invite/abc")).toEqual({ emailStatus: "failed", emailError: "mailbox full", inviteLink: "https://x.test/invite/abc" });
    expect(inviteOutcome({ status: "captured" }, "https://x.test/invite/abc").inviteLink).toBe("https://x.test/invite/abc");
    expect(inviteOutcome({ status: "queued" }, "https://x.test/invite/abc").inviteLink).toBe("https://x.test/invite/abc");
  });
});

describe("a moment in words", () => {
  const M = 60_000;
  const H = 60 * M;
  const D = 24 * H;

  it("uses the largest whole unit and agrees in number", () => {
    const cases: Array<[number, string]> = [[0, "1 minute"], [M - 1, "1 minute"], [M, "1 minute"], [2 * M, "2 minutes"], [59 * M, "59 minutes"], [H - 1, "59 minutes"], [H, "1 hour"], [23 * H + 59 * M, "23 hours"], [D, "1 day"], [3 * D + 5 * H, "3 days"], [-2 * H, "2 hours"]];
    for (const [ms, words] of cases) expect(spanWords(ms), String(ms)).toBe(words);
  });

  const now = new Date("2026-11-03T12:00:00Z");
  const p = (over: Partial<Parameters<typeof windowWords>[0]> = {}) => ({ verifiedAt: "2026-11-03T09:00:00Z", windowEndsAt: "2026-11-04T09:00:00Z", access: "open" as AccessState, ...over });

  it("says where a window stands from the clock", () => {
    expect(windowWords(p(), now)).toBe("Open, 21 hours left");
    expect(windowWords(p({ windowEndsAt: "2026-11-03T12:00:01Z" }), now)).toBe("Open, 1 minute left");
    expect(windowWords(p({ windowEndsAt: "2026-11-03T12:00:00Z" }), now)).toBe("Ended 1 minute ago");
    expect(windowWords(p({ access: "ended", windowEndsAt: "2026-11-01T12:00:00Z" }), now)).toBe("Ended 2 days ago");
    expect(windowWords(p({ verifiedAt: null, windowEndsAt: null, access: "unverified" }), now)).toBe("Not started");
    expect(windowWords(p({ access: "erased" }), now)).toBe("Details erased");
    expect(windowWords(p({ access: "converted" }), now)).toBe("Became a client");
    expect(windowWords(p({ access: "blocked" }), now)).toBe("Stopped by the team");
  });
});

describe("the timeline", () => {
  it("has a label for every kind of line, and falls back to the kind itself for one it does not know", () => {
    for (const kind of DEMO_EVENT_KINDS) expect(describeEvent(kind, {}).label, kind).toBe(DEMO_EVENT_LABELS[kind]);
    expect(describeEvent("mystery" as never, {})).toEqual({ label: "mystery", lines: [] });
  });

  it("puts the details of the lines that have some into words", () => {
    expect(describeEvent("extended", { hours: 24, extraMessages: 5, reason: "Asked nicely" }).lines).toEqual(["Added 24 hours and 5 messages.", "Reason: Asked nicely"]);
    expect(describeEvent("extended", { hours: 1, extraMessages: 1 }).lines).toEqual(["Added 1 hour and 1 message."]);
    expect(describeEvent("expired", { early: true, reason: "Duplicate request" }).lines).toEqual(["Ended early by the team.", "Reason: Duplicate request"]);
    expect(describeEvent("expired", {}).lines).toEqual([]);
    expect(describeEvent("blocked", { reason: "Spam" }).lines).toEqual(["Reason: Spam"]);
    expect(describeEvent("declined", { reason: "Not a fit" }).lines).toEqual(["Reason: Not a fit"]);
    expect(describeEvent("reopened", { to: "active" }).lines).toEqual(["Back to Demo open."]);
    expect(describeEvent("reopened", { to: "weird" }).lines).toEqual(["Back to weird."]);
    expect(describeEvent("note", { note: "Called back" }).lines).toEqual(["Called back"]);
    expect(describeEvent("assigned", { ownerUserId: ID }).lines).toEqual(["Assigned to a team member."]);
    expect(describeEvent("assigned", { ownerUserId: null }).lines).toEqual(["No longer assigned to anyone."]);
    expect(describeEvent("transcript_viewed", { lines: 1 }).lines).toEqual(["1 line read."]);
    expect(describeEvent("transcript_viewed", { lines: 12 }).lines).toEqual(["12 lines read."]);
    expect(describeEvent("limit_reached", { messagesUsed: 10 }).lines).toEqual(["10 messages used."]);
    expect(describeEvent("verified", { windowHours: 24, messageLimit: 10 }).lines).toEqual(["24-hour window, 10 messages."]);
    expect(describeEvent("erased", { why: "retention" }).lines).toEqual(["Erased when the retention period ended."]);
    expect(describeEvent("erased", { why: "request" }).lines).toEqual(["Erased because the person asked."]);
    expect(describeEvent("message_released", { reason: "provider_failed" }).lines).toEqual(["Not counted: the AI provider did not answer."]);
    expect(describeEvent("message_blocked", { reason: "reply_blocked" }).lines).toEqual(["Not counted: the answer failed a safety check."]);
    expect(describeEvent("message_blocked", { reason: "input_blocked" }).lines[0]).toMatch(/change the assistant's rules/);
    expect(describeEvent("message_released", { reason: "anything else" }).lines).toEqual(["Not counted: the message was given back."]);
  });

  it("copes with a detail of the wrong shape: missing fields, wrong types, huge text", () => {
    for (const kind of DEMO_EVENT_KINDS) {
      for (const detail of [{}, { reason: 5, note: {}, hours: "many", extraMessages: null, lines: "x", messagesUsed: NaN, windowHours: Infinity, why: [], to: 3, early: "yes" }, { reason: "r".repeat(100_000), note: "n".repeat(100_000) }]) {
        const w = describeEvent(kind, detail as Record<string, unknown>);
        expect(w.label).toBeTruthy();
        for (const line of w.lines) expect(line.length, kind).toBeLessThan(700);
      }
    }
  });

  it("shows a note or a reason a team member typed as text, cut to a bound, and never anything a prospect typed", () => {
    expect(describeEvent("note", { note: "x".repeat(5000) }).lines[0]).toHaveLength(600);
    // A prospect's words are never in a detail; if a key that is not one of the known ones arrives it is simply not shown.
    expect(describeEvent("registered", { name: "Pat Prospect", email: "pat@prospect.test", text: "hello" })).toEqual({ label: DEMO_EVENT_LABELS.registered, lines: [] });
    expect(describeEvent("accessed", { message: "secret words" }).lines).toEqual([]);
  });
});
