import { describe, expect, it } from "vitest";
import { FULL_REFRESH_MS, MAX_BACKOFF_MS, OVERLAP_MS, POLL_MS, nextPollDelay, planRefresh, sinceFor, type SyncResponse } from "@/components/inbox/use-inbox-sync";

// The decisions the inbox's polling makes, as pure functions: when to ask again, from when, and what to re-read after an answer.

describe("how often the inbox asks", () => {
  it("polls steadily while it works, backs off after failures, never beyond a minute, and recovers on one success", () => {
    expect(nextPollDelay(0)).toBe(POLL_MS);
    expect(nextPollDelay(-3)).toBe(POLL_MS);
    expect([1, 2, 3, 4].map(nextPollDelay)).toEqual([10_000, 20_000, 40_000, MAX_BACKOFF_MS]);
    for (const failures of [5, 6, 7, 100, Number.MAX_SAFE_INTEGER]) expect(nextPollDelay(failures)).toBe(MAX_BACKOFF_MS);
    expect(nextPollDelay(0)).toBe(POLL_MS);
  });
});

describe("from when the next question asks", () => {
  it("asks for everything before the first answer, and otherwise from a little before the last answer so a late commit is still seen", () => {
    expect(sinceFor(null)).toBeNull();
    expect(sinceFor("not a date")).toBeNull();
    const t = "2026-10-22T10:00:30.000Z";
    expect(Date.parse(t) - Date.parse(sinceFor(t)!)).toBe(OVERLAP_MS);
  });
});

describe("what to re-read after an answer", () => {
  const res = (over: Partial<SyncResponse> = {}): SyncResponse => ({ serverTime: "2026-10-22T10:00:00.000Z", full: false, changes: [], ...over });
  const known = new Map([["a", 5], ["b", 2]]);
  const NOW = 1_000_000;

  it("does nothing when nothing changed and nothing is stale", () => {
    expect(planRefresh(res(), known, "a", NOW - 1000, NOW)).toEqual({ refreshList: false, refreshThread: false });
  });

  it("ignores a repeated or late answer: a change counts only if it is newer than what the client holds", () => {
    expect(planRefresh(res({ changes: [{ id: "a", revision: 5 }, { id: "b", revision: 1 }] }), known, "a", NOW - 1000, NOW)).toEqual({ refreshList: false, refreshThread: false });
  });

  it("re-reads the list for a newer change, and the open thread only when it is the one that changed", () => {
    expect(planRefresh(res({ changes: [{ id: "b", revision: 3 }] }), known, "a", NOW - 1000, NOW)).toEqual({ refreshList: true, refreshThread: false });
    expect(planRefresh(res({ changes: [{ id: "a", revision: 6 }] }), known, "a", NOW - 1000, NOW)).toEqual({ refreshList: true, refreshThread: true });
    expect(planRefresh(res({ changes: [{ id: "a", revision: 6 }] }), known, null, NOW - 1000, NOW)).toEqual({ refreshList: true, refreshThread: false });
  });

  it("treats a conversation it has never seen as news: a new message may belong in the list", () => {
    expect(planRefresh(res({ changes: [{ id: "new", revision: 0 }] }), known, "a", NOW - 1000, NOW).refreshList).toBe(true);
  });

  it("re-reads everything when the server says the window was too old to answer incrementally", () => {
    expect(planRefresh(res({ full: true }), known, "a", NOW - 1000, NOW)).toEqual({ refreshList: true, refreshThread: true });
    expect(planRefresh(res({ full: true }), known, null, NOW - 1000, NOW)).toEqual({ refreshList: true, refreshThread: false });
  });

  it("reads the list again now and then even when it sees no change, as a safety net", () => {
    expect(planRefresh(res(), known, null, NOW - FULL_REFRESH_MS, NOW).refreshList).toBe(true);
    expect(planRefresh(res(), known, null, NOW - FULL_REFRESH_MS + 1, NOW).refreshList).toBe(false);
  });
});
