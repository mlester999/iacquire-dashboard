import { describe, expect, it } from "vitest";
import { addMonth, anchorDay, formatTime, fromLocalInput, groupByDay, listRange, monthGrid, neighbours, parseView, toLocalInput, weekGrid } from "@/lib/social/calendar";

describe("the month grid", () => {
  it("shows whole weeks, Sunday first, with the neighbours' edges", () => {
    const g = monthGrid("2026-10-15", "UTC");
    expect(g.weeks.every((w) => w.length === 7)).toBe(true);
    expect(g.weeks[0][0]).toBe("2026-09-27"); // October 1, 2026 is a Thursday
    expect(g.firstDay).toBe("2026-09-27");
    expect(g.lastDay).toBe("2026-10-31");
    expect(g.weeks).toHaveLength(5);
    expect(g.inMonth("2026-10-01")).toBe(true);
    expect(g.inMonth("2026-09-30")).toBe(false);
    expect(g.label).toBe("October 2026");
  });

  it("bounds the grid in the client's time zone, not the server's", () => {
    const manila = monthGrid("2026-10-15", "Asia/Manila");
    expect(manila.from.toISOString()).toBe("2026-09-26T16:00:00.000Z"); // midnight in Manila is 16:00 UTC the day before
    expect(manila.to.toISOString()).toBe("2026-10-31T16:00:00.000Z");
    const chicago = monthGrid("2026-10-15", "America/Chicago");
    expect(chicago.from.toISOString()).toBe("2026-09-27T05:00:00.000Z");
  });

  it("handles a six-week month and the year boundary", () => {
    expect(monthGrid("2026-11-10", "UTC").weeks).toHaveLength(5);
    expect(monthGrid("2027-05-10", "UTC").weeks).toHaveLength(6); // May 2027 starts on a Saturday and has 31 days
    expect(addMonth("2026-12-20", 1)).toBe("2027-01-01");
    expect(addMonth("2026-01-31", -1)).toBe("2025-12-01");
    expect(monthGrid("2026-12-15", "UTC").label).toBe("December 2026");
  });
});

describe("the week grid and the agenda", () => {
  it("shows the week that holds the day", () => {
    const g = weekGrid("2026-10-23", "UTC");
    expect(g.weeks).toEqual([["2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24"]]);
    expect(g.label).toBe("October 18–24, 2026");
    expect(weekGrid("2026-10-29", "UTC").label).toBe("October 25–31, 2026");
    expect(weekGrid("2026-09-30", "UTC").label).toBe("Sep 27 – Oct 3, 2026"); // a week that crosses a month
  });

  it("lists exactly the anchor's month", () => {
    const g = listRange("2026-10-23", "UTC");
    expect([g.firstDay, g.lastDay]).toEqual(["2026-10-01", "2026-10-31"]);
    expect(g.from.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(g.to.toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });

  it("steps by a week or a month", () => {
    expect(neighbours("week", "2026-10-23")).toEqual({ prev: "2026-10-16", next: "2026-10-30" });
    expect(neighbours("month", "2026-10-23")).toEqual({ prev: "2026-09-01", next: "2026-11-01" });
  });
});

describe("reading the address", () => {
  it("accepts only real days and views, and defaults to today in the client's zone", () => {
    const now = new Date("2026-10-23T23:30:00Z");
    expect(anchorDay("2026-10-05", now, "UTC")).toBe("2026-10-05");
    expect(anchorDay("2026-13-45", now, "UTC")).toBe("2026-10-23");
    expect(anchorDay(undefined, now, "Asia/Manila")).toBe("2026-10-24"); // 23:30 UTC is already the 24th in Manila
    expect(anchorDay("nope", now, "Not/AZone")).toBe("2026-10-23");
    expect(parseView("week")).toBe("week");
    expect(parseView("<script>")).toBe("month");
  });
});

describe("which day a post sits on", () => {
  it("uses the client's time zone, and the time it was or will be published", () => {
    const posts = [
      { id: "a", scheduledAt: "2026-10-23T23:30:00Z", publishedAt: null, createdAt: "2026-10-01T00:00:00Z" },
      { id: "b", scheduledAt: "2026-10-23T08:00:00Z", publishedAt: "2026-10-23T08:01:00Z", createdAt: "2026-10-01T00:00:00Z" },
      { id: "c", scheduledAt: null, publishedAt: null, createdAt: "2026-10-22T10:00:00Z" },
    ];
    const utc = groupByDay(posts, "UTC");
    expect([...utc.keys()].sort()).toEqual(["2026-10-22", "2026-10-23"]);
    expect(utc.get("2026-10-23")?.map((p) => p.id)).toEqual(["b", "a"]); // in time order
    const manila = groupByDay(posts, "Asia/Manila");
    expect(manila.get("2026-10-24")?.map((p) => p.id)).toEqual(["a"]); // 11:30pm UTC is the next morning in Manila
  });

  it("writes times in the client's zone", () => {
    expect(formatTime("2026-10-23T15:30:00Z", "America/Chicago")).toBe("10:30 AM");
    expect(formatTime("2026-10-23T15:30:00Z", "Asia/Manila")).toBe("11:30 PM");
  });
});

describe("date and time inputs", () => {
  it("round-trips wall-clock time in the client's zone", () => {
    const iso = "2026-10-23T15:30:00.000Z";
    expect(toLocalInput(iso, "America/Chicago")).toBe("2026-10-23T10:30");
    expect(fromLocalInput("2026-10-23T10:30", "America/Chicago")?.toISOString()).toBe(iso);
    expect(fromLocalInput(toLocalInput(iso, "Asia/Manila"), "Asia/Manila")?.toISOString()).toBe(iso);
  });

  it("refuses nonsense", () => {
    expect(fromLocalInput("tomorrow at noon", "UTC")).toBeNull();
    expect(fromLocalInput("2026-02-31T10:00", "UTC")).toBeNull();
    expect(fromLocalInput("2026-10-23T25:00", "UTC")).toBeNull();
    expect(fromLocalInput("2026-10-23T10:00", "Not/AZone")).toBeNull();
  });
});
