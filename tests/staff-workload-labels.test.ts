// The labels and the rules around them, with no database: the five labels at every boundary, the floors that only raise, capacity that is zero or unknown, time off and part
// days, the calendar and its time zone, project health, suggestions, alerts and the history rule. Plus seeded property tests that check the label against an independent
// calculation in exact integer arithmetic. Nothing here reads a clock: "now" and "today" are arguments.
import { describe, expect, it } from "vitest";
import {
  LABELS, LABEL_TEXT, computeWorkload, floorFor, labelForRatio, labelRank, resolveCapacity, type CapacityFacts, type WorkloadLabel,
} from "@/lib/staff-workload/labels";
import { DEFAULT_RULES, itemPointsCenti, normalizeRules, type WorkloadRules } from "@/lib/staff-workload/rules";
import {
  availableHalfDays, buildCalendar, dayOf, dueDay, horizonDates, isoWeekday, todayIn, type CalendarMilestone, type TimeOffSpan,
} from "@/lib/staff-workload/calendar";
import { projectHealth, type HealthFacts } from "@/lib/staff-workload/health";
import { MAX_SUGGESTIONS, suggestAssignees, type SuggestionCandidate } from "@/lib/staff-workload/suggest";
import { decideAlert, durationText, managerNoticeKey, overdueNoticeKey, snapshotKind } from "@/lib/staff-workload/alerts";
import type { WorkItem } from "@/lib/staff-workload/sources";
import { workItem as item } from "./support/staff-workload-pure";

const NOW = new Date("2026-10-26T09:00:00.000Z"); // a Monday
const TODAY = "2026-10-26";
const rulesWith = (over: unknown = {}): WorkloadRules => {
  const r = normalizeRules(over);
  if (!r.ok) throw new Error(r.errors.map((e) => e.message).join(" "));
  return r.rules;
};
const full = (capacityPoints: number | null, rules: WorkloadRules = DEFAULT_RULES): CapacityFacts => resolveCapacity(capacityPoints, rules, 10);
const rate = (items: WorkItem[], capacity: CapacityFacts, rules: WorkloadRules = DEFAULT_RULES, targets = true) =>
  computeWorkload({ items, capacity, rules, now: NOW, today: TODAY, supportTargetsEnabled: targets });
/** n items worth 2 points each, none overdue. */
const twoEach = (n: number) => Array.from({ length: n }, () => item({ source: "maintenance", status: "open", priority: null }));

describe("the five labels at every boundary", () => {
  // Capacity 20 points over five full days: 50% is 10 points, 85% is 17, 100% is 20, 125% is 25. Points are checked in hundredths so the boundary is exact.
  const cap = full(20);
  const at = (pointsCenti: number) => labelForRatio(pointsCenti, cap, DEFAULT_RULES);

  it.each([
    [0, "available"], [1, "available"], [999, "available"],
    [1000, "balanced"], [1001, "balanced"], [1699, "balanced"],
    [1700, "busy"], [1701, "busy"], [1999, "busy"],
    [2000, "overloaded"], [2001, "overloaded"], [2499, "overloaded"],
    [2500, "critical"], [2501, "critical"], [100000, "critical"],
  ] as Array<[number, WorkloadLabel]>)("%i hundredths of a point against 20 points of capacity is %s", (pointsCenti, label) => {
    expect(at(pointsCenti)).toBe(label);
  });

  it("follows thresholds a Super Admin changed", () => {
    const strict = rulesWith({ thresholds: { balancedFrom: 20, busyFrom: 40, overloadedFrom: 60, criticalFrom: 80 } });
    const c = full(20, strict);
    // 20% of 20 points is 4, 40% is 8, 60% is 12, 80% is 16.
    expect([399, 400, 799, 800, 1199, 1200, 1599, 1600].map((p) => labelForRatio(p, c, strict))).toEqual([
      "available", "balanced", "balanced", "busy", "busy", "overloaded", "overloaded", "critical",
    ]);
  });

  it("scales capacity by the days that can be worked: three of five days leave 12 of 20 points", () => {
    const three: CapacityFacts = { capacityPoints: 20, source: "person", availableHalfDays: 6, horizonDays: 5 };
    // 12 points is the whole of it: 50% is 6 points, 85% is 10.2, 100% is 12, 125% is 15.
    expect([599, 600, 1019, 1020, 1199, 1200, 1499, 1500].map((p) => labelForRatio(p, three, DEFAULT_RULES))).toEqual([
      "available", "balanced", "balanced", "busy", "busy", "overloaded", "overloaded", "critical",
    ]);
    const half: CapacityFacts = { capacityPoints: 20, source: "person", availableHalfDays: 1, horizonDays: 5 };
    // Half a day of five leaves 2 points: 1 point is 50%.
    expect([99, 100, 169, 170].map((p) => labelForRatio(p, half, DEFAULT_RULES))).toEqual(["available", "balanced", "balanced", "busy"]);
  });

  it("gives the same label to a person exactly on a boundary every time", () => {
    for (let i = 0; i < 20; i += 1) expect(at(1700)).toBe("busy");
  });

  it("has a text for each label and ranks them in order", () => {
    expect(LABELS.map((l) => LABEL_TEXT[l])).toEqual(["Available", "Balanced", "Busy", "Overloaded", "Critical"]);
    expect(LABELS.map((l) => labelRank(l))).toEqual([0, 1, 2, 3, 4]);
    expect(labelRank(null)).toBe(5);
  });
});

describe("computing a person's workload", () => {
  it("reports points, capacity, the share, counts and the reasons in words", () => {
    const r = rate(twoEach(5), full(20));
    expect(r).toMatchObject({ label: "balanced", points: 10, pointsCenti: 1000, capacity: 20, ratioPercent: 50, items: 5, overdue: 0, escalated: 0, away: false, capacitySource: "person", availableDays: 5, horizonDays: 5 });
    expect(r.reasons).toEqual(["10 points of open work against 20 points of capacity over the next 5 working days (50%)."]);
  });

  it("shows no label, and says why, when capacity is not set; the counts are still there", () => {
    const r = rate([...twoEach(3), item({ dueAt: "2026-10-26T08:00:00.000Z" })], full(null));
    expect(r.label).toBeNull();
    expect(r.capacity).toBeNull();
    expect(r.ratioPercent).toBeNull();
    expect(r).toMatchObject({ points: 8, items: 4, overdue: 1, capacitySource: "none" });
    expect(r.reasons[0]).toMatch(/^Capacity not set, so no label is shown\./);
    // Not even a floor can invent the other half of the ratio, but the overdue item is still told.
    expect(r.reasons.join(" ")).toMatch(/An item is overdue\./);
  });

  it("uses the team default when a person has no capacity of their own, and says so", () => {
    const rules = rulesWith({ defaultCapacityPoints: 30 });
    const r = rate(twoEach(5), resolveCapacity(null, rules, 10), rules);
    expect(r).toMatchObject({ label: "available", capacityPoints: 30, capacitySource: "default" });
    expect(r.quality.capacityFromDefault).toBe(true);
    expect(r.reasons.join(" ")).toMatch(/team default of 30 points, not a number set for this person/);
    // A person's own number wins over the default.
    expect(resolveCapacity(12, rules, 10)).toMatchObject({ capacityPoints: 12, source: "person" });
  });

  it("treats a person with time off for the whole horizon and open work as Critical, away, and says so", () => {
    const away: CapacityFacts = { capacityPoints: 20, source: "person", availableHalfDays: 0, horizonDays: 5 };
    const r = rate(twoEach(1), away);
    expect(r).toMatchObject({ label: "critical", away: true, ratioPercent: null, capacity: 0 });
    expect(r.reasons[0]).toMatch(/Away for the whole of the next 5 working days .*nothing can be done on it, so the label is Critical/);
    // Away with nothing open is Available, not an alarm.
    const idle = rate([], away);
    expect(idle).toMatchObject({ label: "available", away: true });
    expect(idle.reasons[0]).toMatch(/with no work open/);
  });

  it("is still null when capacity is unknown and the person is away", () => {
    const r = rate(twoEach(2), { capacityPoints: null, source: "none", availableHalfDays: 0, horizonDays: 5 });
    expect(r.label).toBeNull();
    expect(r.away).toBe(true);
  });

  it("explains reduced capacity when part of the horizon cannot be worked", () => {
    const r = rate(twoEach(3), { capacityPoints: 20, source: "person", availableHalfDays: 6, horizonDays: 5 });
    expect(r.capacity).toBe(12);
    expect(r.reasons.join(" ")).toMatch(/3 of the 5 working days can be worked/);
  });

  it("counts an unknown-priority support request as an item with no points rather than a guess", () => {
    const r = rate([item({ priority: "someday" })], full(20));
    expect(r).toMatchObject({ points: 0, items: 1, label: "available" });
  });

  it("flags the data gaps that could mislead: no due date, support targets off, maintenance without a date", () => {
    const r = rate([item({ source: "support" }), item({ source: "maintenance", priority: null }), item({ source: "setup_task", priority: null, dueOn: "2026-11-01" })], full(20), DEFAULT_RULES, false);
    expect(r.quality).toEqual({ capacityFromDefault: false, itemsWithoutDueDate: 2, supportOverdueUnknown: 1, maintenanceWithoutDueDate: 1 });
    expect(rate([item()], full(20), DEFAULT_RULES, true).quality.supportOverdueUnknown).toBe(0);
  });

  it("never calls an item with no due date overdue, however old", () => {
    const r = rate([item({ createdAt: "2020-01-01T00:00:00.000Z" })], full(20));
    expect(r.overdue).toBe(0);
  });
});

describe("floors from real facts", () => {
  const overdue = (n: number) => Array.from({ length: n }, () => item({ source: "setup_task", priority: null, optional: true, dueOn: "2026-10-01" }));
  // One point each against a huge capacity, so the points alone say Available.
  const big = full(200);

  it.each([
    [0, "available"], [1, "busy"], [2, "busy"], [3, "overloaded"], [4, "overloaded"], [5, "critical"], [9, "critical"],
  ] as Array<[number, WorkloadLabel]>)("%i overdue items raise the label to at least %s", (n, label) => {
    expect(rate(overdue(n), big).label).toBe(label);
  });

  it("raises a label for an escalated request to at least Overloaded, whatever the points say", () => {
    const r = rate([item({ escalated: true, priority: "low" })], big);
    expect(r.label).toBe("overloaded");
    expect(r.escalated).toBe(1);
    expect(r.reasons.join(" ")).toMatch(/An escalated request is open, so the label is at least Overloaded/);
  });

  it("never lowers a label: points that already say Critical stay Critical with one overdue item", () => {
    const heavy = [...twoEach(15), item({ source: "maintenance", priority: null, dueOn: "2026-10-01" })];
    expect(rate(heavy, full(20)).label).toBe("critical");
    // The floor said nothing new, so it is not listed as a reason.
    expect(rate(heavy, full(20)).reasons.join(" ")).not.toMatch(/at least Busy/);
  });

  it("explains a floor only when it changed the answer", () => {
    const raised = rate(overdue(1), big);
    expect(raised.label).toBe("busy");
    expect(raised.reasons.join(" ")).toMatch(/An item is overdue, so the label is at least Busy\./);
    expect(rate(overdue(5), big).reasons.join(" ")).toMatch(/5 items are overdue, so the label is Critical\./);
  });

  it("uses the floors a Super Admin set", () => {
    const rules = rulesWith({ floors: { busyAtOverdue: 2, overloadedAtOverdue: 4, criticalAtOverdue: 6 } });
    const c = full(200, rules);
    expect([1, 2, 3, 4, 5, 6].map((n) => rate(overdue(n), c, rules).label)).toEqual(["available", "busy", "busy", "overloaded", "overloaded", "critical"]);
  });

  it("floors alone: floorFor returns nothing below the first threshold", () => {
    expect(floorFor(0, 0, DEFAULT_RULES)).toEqual({ label: null, why: null });
    expect(floorFor(0, 2, DEFAULT_RULES).label).toBe("overloaded");
    expect(floorFor(5, 2, DEFAULT_RULES).label).toBe("critical");
  });
});

describe("property tests: the label agrees with an independent exact calculation", () => {
  // A small seeded generator, so a failure can be replayed.
  const prng = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const SOURCES = ["support", "setup_task", "project", "maintenance"] as const;
  const STATUSES = ["open", "in_progress", "waiting_for_client", "blocked", "in_development", "testing", "on_hold", "quote_sent"];
  const PRIORITIES = ["low", "normal", "high", "urgent", null];

  function randomItems(rand: () => number, n: number): WorkItem[] {
    return Array.from({ length: n }, () =>
      item({
        source: SOURCES[Math.floor(rand() * 4)], status: STATUSES[Math.floor(rand() * STATUSES.length)], priority: PRIORITIES[Math.floor(rand() * PRIORITIES.length)],
        escalated: rand() < 0.1, optional: rand() < 0.3, blocked: rand() < 0.1, waitingOnClient: rand() < 0.2,
        dueAt: rand() < 0.2 ? "2026-10-20T00:00:00.000Z" : null, dueOn: rand() < 0.2 ? (rand() < 0.5 ? "2026-10-20" : "2026-11-20") : null,
      }),
    );
  }

  /** The label by the definition, with BigInt rationals: points / (capacity * halfDays / (2 * horizon)) compared with each percent. */
  function reference(pointsCenti: number, capacityPoints: number, halfDays: number, horizon: number, t = DEFAULT_RULES.thresholds): WorkloadLabel {
    if (halfDays <= 0) return pointsCenti > 0 ? "critical" : "available";
    const lhs = (_percent: number) => BigInt(pointsCenti) * 2n * BigInt(horizon);
    const rhs = (percent: number) => BigInt(percent) * BigInt(capacityPoints) * BigInt(halfDays);
    if (lhs(t.criticalFrom) >= rhs(t.criticalFrom)) return "critical";
    if (lhs(t.overloadedFrom) >= rhs(t.overloadedFrom)) return "overloaded";
    if (lhs(t.busyFrom) >= rhs(t.busyFrom)) return "busy";
    if (lhs(t.balancedFrom) >= rhs(t.balancedFrom)) return "balanced";
    return "available";
  }

  it("matches the reference for 3,000 random combinations of points, capacity and time off", () => {
    const rand = prng(20261024);
    for (let i = 0; i < 3000; i += 1) {
      const capacityPoints = 1 + Math.floor(rand() * 200);
      const halfDays = Math.floor(rand() * 11);
      const horizon = 1 + Math.floor(rand() * 20);
      const pointsCenti = Math.floor(rand() * 60000);
      const cap: CapacityFacts = { capacityPoints, source: "person", availableHalfDays: halfDays, horizonDays: horizon };
      expect(labelForRatio(pointsCenti, cap, DEFAULT_RULES), JSON.stringify({ capacityPoints, halfDays, horizon, pointsCenti })).toBe(reference(pointsCenti, capacityPoints, halfDays, horizon));
    }
  });

  it("holds the invariants for 1,500 random people: a floor never lowers, more work never lowers the label, no capacity means no label, and the same input gives the same output", () => {
    const rand = prng(1);
    for (let i = 0; i < 1500; i += 1) {
      const items = randomItems(rand, Math.floor(rand() * 14));
      const capacity = rand() < 0.15 ? null : 1 + Math.floor(rand() * 60);
      const halfDays = Math.floor(rand() * 11);
      const cap: CapacityFacts = { capacityPoints: capacity, source: capacity === null ? "none" : "person", availableHalfDays: halfDays, horizonDays: 5 };
      const r = rate(items, cap);
      // Deterministic.
      expect(rate(items, cap)).toEqual(r);
      expect(rate([...items].reverse(), cap).label).toBe(r.label);
      // No capacity, no label; otherwise a label.
      expect(r.label === null).toBe(capacity === null);
      if (r.label !== null) {
        // The label is never below what the points alone say, nor below the floor.
        const byPoints = labelForRatio(r.pointsCenti, cap, DEFAULT_RULES) as WorkloadLabel;
        expect(labelRank(r.label)).toBeGreaterThanOrEqual(labelRank(byPoints));
        const floor = floorFor(r.overdue, r.escalated, DEFAULT_RULES).label;
        if (floor) expect(labelRank(r.label)).toBeGreaterThanOrEqual(labelRank(floor));
        // And it is exactly the higher of the two.
        expect(r.label).toBe(floor && labelRank(floor) > labelRank(byPoints) ? floor : byPoints);
        // More work never lowers it.
        const more = rate([...items, item({ source: "maintenance", priority: null })], cap);
        expect(labelRank(more.label)).toBeGreaterThanOrEqual(labelRank(r.label));
      }
      // Points are the sum of the items' points, in hundredths.
      expect(r.pointsCenti).toBe(items.reduce((n, it) => n + itemPointsCenti(it, DEFAULT_RULES), 0));
      expect(r.items).toBe(items.length);
    }
  });

  it("gives a person with more capacity a label no higher than one with less, for the same work", () => {
    const rand = prng(7);
    for (let i = 0; i < 500; i += 1) {
      const items = randomItems(rand, Math.floor(rand() * 12));
      const small = 1 + Math.floor(rand() * 30);
      const big = small + 1 + Math.floor(rand() * 30);
      const a = rate(items, { capacityPoints: small, source: "person", availableHalfDays: 10, horizonDays: 5 });
      const b = rate(items, { capacityPoints: big, source: "person", availableHalfDays: 10, horizonDays: 5 });
      expect(labelRank(b.label)).toBeLessThanOrEqual(labelRank(a.label));
    }
  });

  it("never takes more than a few milliseconds for a thousand items", () => {
    const rand = prng(3);
    const items = randomItems(rand, 1000);
    const started = Date.now();
    rate(items, full(100));
    expect(Date.now() - started).toBeLessThan(200);
  });
});

describe("days, time off and the calendar", () => {
  it("numbers the weekdays Monday 1 to Sunday 7", () => {
    expect(["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"].map(isoWeekday)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("takes today in the agency's time zone, not the server's", () => {
    // 20:00 UTC on the 24th is already the 25th in Manila and still the 24th in New York.
    const at = new Date("2026-10-24T20:00:00.000Z");
    expect(todayIn(at, "UTC")).toBe("2026-10-24");
    expect(todayIn(at, "Asia/Manila")).toBe("2026-10-25");
    expect(todayIn(at, "America/New_York")).toBe("2026-10-24");
    expect(todayIn(at, "Not/AZone")).toBe("2026-10-24");
    expect(dayOf("2026-10-24T20:00:00.000Z", "Asia/Manila")).toBe("2026-10-25");
    expect(dayOf("garbage", "UTC")).toBeNull();
  });

  it("makes the horizon the next working days, starting on Monday when today is a weekend day", () => {
    expect(horizonDates("2026-10-26", 5)).toEqual(["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"]);
    expect(horizonDates("2026-10-29", 5)).toEqual(["2026-10-29", "2026-10-30", "2026-11-02", "2026-11-03", "2026-11-04"]);
    expect(horizonDates("2026-10-31", 3)).toEqual(["2026-11-02", "2026-11-03", "2026-11-04"]);
    expect(horizonDates("2026-10-26", 1)).toEqual(["2026-10-26"]);
    expect(horizonDates("2026-10-26", 20)).toHaveLength(20);
  });

  const week = horizonDates(TODAY, 5);
  const off = (startsOn: string, endsOn: string, partDay = false): TimeOffSpan => ({ startsOn, endsOn, partDay });

  it("counts the half days a person can work: working days only, time off taken away, a half day counts half", () => {
    const mon_fri = [1, 2, 3, 4, 5];
    expect(availableHalfDays(week, mon_fri, [])).toBe(10);
    expect(availableHalfDays(week, [1, 2, 3, 4], [])).toBe(8);
    expect(availableHalfDays(week, [6, 7], [])).toBe(0);
    expect(availableHalfDays(week, mon_fri, [off("2026-10-27", "2026-10-28")])).toBe(6);
    expect(availableHalfDays(week, mon_fri, [off("2026-10-27", "2026-10-27", true)])).toBe(9);
    // Two half days on one day make a day off; the same entry twice is one entry; time off on a day not worked takes nothing.
    expect(availableHalfDays(week, mon_fri, [off("2026-10-27", "2026-10-27", true), off("2026-10-27", "2026-10-27", true)])).toBe(8);
    expect(availableHalfDays(week, mon_fri, [off("2026-10-27", "2026-10-27"), off("2026-10-27", "2026-10-27")])).toBe(8);
    expect(availableHalfDays(week, [1, 2, 3, 4], [off("2026-10-30", "2026-10-30")])).toBe(8);
    // A whole horizon off, with the time off starting before and ending after it.
    expect(availableHalfDays(week, mon_fri, [off("2026-10-20", "2026-11-10")])).toBe(0);
    // A span that ends the day before, or starts the day after, takes nothing.
    expect(availableHalfDays(week, mon_fri, [off("2026-10-20", "2026-10-25"), off("2026-10-31", "2026-11-05")])).toBe(10);
  });

  it("takes the earliest of a due moment and a due day, in the agency's zone", () => {
    expect(dueDay({ dueAt: null, dueOn: null }, "UTC")).toBeNull();
    expect(dueDay({ dueAt: "2026-10-24T20:00:00.000Z", dueOn: null }, "Asia/Manila")).toBe("2026-10-25");
    expect(dueDay({ dueAt: "2026-10-24T20:00:00.000Z", dueOn: "2026-10-30" }, "Asia/Manila")).toBe("2026-10-25");
    expect(dueDay({ dueAt: "2026-10-28T20:00:00.000Z", dueOn: "2026-10-27" }, "UTC")).toBe("2026-10-27");
    expect(dueDay({ dueAt: null, dueOn: "not a day" }, "UTC")).toBeNull();
  });

  it("places items and milestones on the days they are due, lists the rest as having no date, and puts what is already late first", () => {
    const items = [
      item({ itemId: "a", title: "B item", dueOn: "2026-10-27" }),
      item({ itemId: "b", title: "A item", dueOn: "2026-10-27" }),
      item({ itemId: "c", title: "No date" }),
      item({ itemId: "d", title: "Late", dueAt: "2026-10-20T00:00:00.000Z" }),
      item({ itemId: "e", title: "Far", dueOn: "2026-12-25" }),
    ];
    const milestones: CalendarMilestone[] = [
      { id: "m1", requestId: "r", orgId: "o", assigneeId: null, title: "Done", dueOn: "2026-10-27", status: "completed" },
      { id: "m2", requestId: "r", orgId: "o", assigneeId: null, title: "Launch", dueOn: "2026-10-28", status: "pending" },
      { id: "m3", requestId: "r", orgId: "o", assigneeId: null, title: "No date", dueOn: null, status: "pending" },
      { id: "m4", requestId: "r", orgId: "o", assigneeId: null, title: "Behind", dueOn: "2026-10-01", status: "blocked" },
    ];
    const cal = buildCalendar(items, milestones, { from: "2026-10-26", to: "2026-10-30" }, NOW, "UTC");
    expect(cal.days.map((d) => d.day)).toEqual(["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"]);
    expect(cal.days[1].entries.map((e) => e.title)).toEqual(["A item", "B item"]);
    expect(cal.days[2].entries.map((e) => [e.kind, e.title])).toEqual([["milestone", "Launch"]]);
    expect(cal.overdue.map((e) => e.title)).toEqual(["Behind", "Late"]);
    expect(cal.overdue.every((e) => e.overdue)).toBe(true);
    expect(cal.undated.map((i) => i.itemId)).toEqual(["c"]);
    // A far-off item is neither in the range nor listed as undated: it has a date.
    expect(cal.days.flatMap((d) => d.entries).some((e) => e.id === "e")).toBe(false);
  });
});

describe("project health", () => {
  const rules = DEFAULT_RULES;
  const base: HealthFacts = { status: "in_development", expectedCompletionOn: null, milestones: [], openReviewTaskDueAts: [], lastActivityAt: "2026-10-25T00:00:00.000Z" };
  const health = (over: Partial<HealthFacts>) => projectHealth({ ...base, ...over }, rules, NOW, TODAY);

  it("is on track only with something to measure against and nothing wrong", () => {
    expect(health({ milestones: [{ status: "in_progress", dueOn: "2026-11-05" }, { status: "completed", dueOn: "2026-10-10" }] })).toMatchObject({ state: "on_track", progress: { done: 1, total: 2 } });
    expect(health({ expectedCompletionOn: "2026-12-01" }).state).toBe("on_track");
    expect(health({ openReviewTaskDueAts: ["2026-10-27T00:00:00.000Z"] }).state).toBe("on_track");
  });

  it("says not enough data rather than on track when nothing is recorded", () => {
    const h = health({});
    expect(h.state).toBe("not_enough_data");
    expect(h.reasons.join(" ")).toMatch(/nothing to measure it against/);
    expect(h.progress).toBeNull();
    expect(health({ openReviewTaskDueAts: [null] }).state).toBe("not_enough_data");
  });

  it("is at risk for a milestone past its day, a blocked one, an overdue review task or no activity for the stale days", () => {
    expect(health({ milestones: [{ status: "pending", dueOn: "2026-10-25" }] })).toMatchObject({ state: "at_risk", overdueMilestones: 1 });
    expect(health({ milestones: [{ status: "pending", dueOn: "2026-10-26" }] }).state).toBe("on_track"); // due today is not late
    expect(health({ milestones: [{ status: "blocked", dueOn: null }] })).toMatchObject({ state: "at_risk", blockedMilestones: 1 });
    expect(health({ openReviewTaskDueAts: ["2026-10-26T08:00:00.000Z"] })).toMatchObject({ state: "at_risk", overdueReviewTasks: 1 });
    expect(health({ expectedCompletionOn: "2026-12-01", lastActivityAt: "2026-10-12T09:00:00.000Z" })).toMatchObject({ state: "at_risk", daysSinceActivity: 14 });
    expect(health({ expectedCompletionOn: "2026-12-01", lastActivityAt: "2026-10-12T09:00:01.000Z" }).state).toBe("on_track"); // 13 days and a second
  });

  it("is off track when the expected day passed or enough milestones are late", () => {
    expect(health({ expectedCompletionOn: "2026-10-25" }).state).toBe("off_track");
    expect(health({ expectedCompletionOn: "2026-10-26" }).state).toBe("on_track");
    expect(health({ milestones: [{ status: "pending", dueOn: "2026-10-01" }, { status: "in_progress", dueOn: "2026-10-02" }] })).toMatchObject({ state: "off_track", overdueMilestones: 2 });
    const strict = projectHealth({ ...base, milestones: [{ status: "pending", dueOn: "2026-10-01" }, { status: "pending", dueOn: "2026-10-02" }] }, rulesWith({ health: { offTrackOverdueMilestones: 3 } }), NOW, TODAY);
    expect(strict.state).toBe("at_risk");
  });

  it("does not blame the team for the client's silence", () => {
    const waiting = health({ status: "quote_sent", lastActivityAt: "2026-08-01T00:00:00.000Z", expectedCompletionOn: "2026-12-01" });
    expect(waiting).toMatchObject({ state: "on_track", waiting: "client" });
    expect(waiting.reasons[0]).toMatch(/Waiting for the client/);
    // A milestone waiting for the client's approval is not late, and is said to be waiting.
    const m = health({ milestones: [{ status: "awaiting_approval", dueOn: "2026-10-01" }] });
    expect(m).toMatchObject({ state: "on_track", overdueMilestones: 0 });
    expect(m.reasons.join(" ")).toMatch(/waiting for the client's approval/);
    // But a review task the team owes is still the team's.
    expect(health({ status: "awaiting_approval", openReviewTaskDueAts: ["2026-10-01T00:00:00.000Z"] }).state).toBe("at_risk");
    expect(health({ status: "discovery_needed" }).waiting).toBe("client");
  });

  it("measures no schedule for a project on hold", () => {
    const h = health({ status: "on_hold", expectedCompletionOn: "2026-01-01", milestones: [{ status: "pending", dueOn: "2026-01-01" }] });
    expect(h).toMatchObject({ state: "not_enough_data", waiting: "hold" });
  });
});

describe("suggestions", () => {
  const candidate = (id: string, over: Partial<SuggestionCandidate> = {}): SuggestionCandidate => ({
    userId: id, name: `Person ${id}`, skills: {}, personCapacity: 20, availableHalfDays: 10, items: [], lastAssignedAt: null, ...over,
  });
  const target = item({ source: "support", itemId: "target", orgId: "client-1", assigneeId: null, hint: "billing", priority: "normal" });
  const suggest = (people: SuggestionCandidate[], rules: WorkloadRules = DEFAULT_RULES, what: WorkItem = target) => suggestAssignees(what, people, rules, NOW, TODAY, true);
  const load = (n: number, orgId = "other") => Array.from({ length: n }, () => item({ source: "maintenance", priority: null, orgId }));

  it("ranks the least loaded first and explains each", () => {
    const list = suggest([candidate("c", { items: load(9) }), candidate("a", { items: load(1) }), candidate("b", { items: load(5) })]);
    expect(list.suggestions.map((s) => s.userId)).toEqual(["a", "b", "c"]);
    expect(list.suggestions.map((s) => s.rank)).toEqual([1, 2, 3]);
    expect(list.suggestions[0].current).toMatchObject({ label: "available", points: 2 });
    expect(list.suggestions[0].after.points).toBe(4);
    expect(list.suggestions[0].reasons.join(" ")).toMatch(/Now: Available/);
    expect(list.considered).toBe(3);
    expect(list.suggestions[2].after.label).toBe("overloaded");
  });

  it("offers at most three and never offers someone who is away for the whole horizon", () => {
    const people = ["a", "b", "c", "d", "e"].map((id) => candidate(id));
    expect(suggest(people).suggestions).toHaveLength(MAX_SUGGESTIONS);
    const withAway = suggest([candidate("a", { availableHalfDays: 0 }), candidate("b")]);
    expect(withAway.suggestions.map((s) => s.userId)).toEqual(["b"]);
    expect(withAway.away).toBe(1);
    expect(withAway.notes.join(" ")).toMatch(/1 person is away for the whole planning period and is not offered/);
    expect(suggest([]).notes.join(" ")).toMatch(/Nobody who can open this client/);
    expect(suggest([]).suggestions).toEqual([]);
  });

  it("ranks on skills only when a manager recorded the needed skill for someone", () => {
    const noSkills = suggest([candidate("a"), candidate("b")]);
    expect(noSkills.skillsUsed).toBe(false);
    expect(noSkills.skill).toBe("billing");
    expect(noSkills.notes.join(" ")).toMatch(/No billing skill is recorded for anyone, so people are not ranked on skills/);
    const skilled = suggest([candidate("a", { items: load(1) }), candidate("b", { skills: { billing: 3 }, items: load(8) }), candidate("c", { skills: { billing: 1 } })]);
    expect(skilled.skillsUsed).toBe(true);
    expect(skilled.suggestions.map((s) => s.userId)).toEqual(["b", "c", "a"]);
    expect(skilled.suggestions[0].skillLevel).toBe(3);
    expect(skilled.suggestions[0].reasons[0]).toBe("Billing: Expert (recorded by a manager).");
    expect(skilled.suggestions[2].reasons[0]).toMatch(/No billing skill is recorded for this person/);
    // A skill for some other kind of work does not count.
    expect(suggest([candidate("a", { skills: { crm: 3 } }), candidate("b")]).skillsUsed).toBe(false);
  });

  it("breaks ties by the share of capacity after the item, then continuity with the client, then who was given work least recently, then the id", () => {
    // Same label now (available); the one with the larger capacity ends up with the lower share.
    const byShare = suggest([candidate("a", { personCapacity: 10 }), candidate("b", { personCapacity: 40 })]);
    expect(byShare.suggestions.map((s) => s.userId)).toEqual(["b", "a"]);
    // Same load and capacity: the one who already holds items for this client.
    const sameClient = (n: number) => Array.from({ length: n }, () => item({ source: "maintenance", priority: null, orgId: "client-1" }));
    const byClient = suggest([candidate("a", { items: load(2) }), candidate("b", { items: sameClient(2) })]);
    expect(byClient.suggestions.map((s) => s.userId)).toEqual(["b", "a"]);
    expect(byClient.suggestions[0].reasons.join(" ")).toMatch(/Already has 2 open items for this client/);
    // Same everything: whoever the board gave work to longest ago, and a person it never gave any to comes first.
    const byRecency = suggest([candidate("a", { lastAssignedAt: "2026-10-25T00:00:00.000Z" }), candidate("b", { lastAssignedAt: "2026-10-20T00:00:00.000Z" }), candidate("c")]);
    expect(byRecency.suggestions.map((s) => s.userId)).toEqual(["c", "b", "a"]);
    expect(byRecency.suggestions[0].reasons.join(" ")).toMatch(/Has never been given work from the board/);
    // Fully equal: by id, and the order does not depend on the order they were passed in.
    expect(suggest([candidate("z"), candidate("m"), candidate("a")]).suggestions.map((s) => s.userId)).toEqual(["a", "m", "z"]);
    expect(suggest([candidate("a"), candidate("m"), candidate("z")]).suggestions.map((s) => s.userId)).toEqual(["a", "m", "z"]);
  });

  it("puts a person with no capacity set after those with one, and says the effect cannot be shown", () => {
    const noDefault = DEFAULT_RULES;
    const list = suggest([candidate("a", { personCapacity: null }), candidate("b", { items: load(6) })], noDefault);
    expect(list.suggestions.map((s) => s.userId)).toEqual(["b", "a"]);
    expect(list.suggestions[1].current.label).toBeNull();
    expect(list.suggestions[1].reasons.join(" ")).toMatch(/cannot be shown until a capacity is set/);
    // With a team default they are rated like anyone else, and it is said where the number came from.
    const withDefault = rulesWith({ defaultCapacityPoints: 20 });
    const rated = suggest([candidate("a", { personCapacity: null })], withDefault);
    expect(rated.suggestions[0].current.label).toBe("available");
    expect(rated.suggestions[0].reasons.join(" ")).toMatch(/Capacity is the team default/);
  });

  it("counts an overdue item toward the person's floor when projecting, so a late item is not free", () => {
    const late = item({ source: "support", itemId: "late", orgId: "client-1", assigneeId: null, priority: "low", dueAt: "2026-10-01T00:00:00.000Z" });
    const list = suggest([candidate("a", { personCapacity: 200 })], DEFAULT_RULES, late);
    expect(list.suggestions[0].current.label).toBe("available");
    expect(list.suggestions[0].after.label).toBe("busy");
  });

  it("is a pure function: the inputs are not changed", () => {
    const people = [candidate("a", { items: load(2) })];
    const copy = JSON.parse(JSON.stringify(people));
    suggest(people);
    expect(people).toEqual(copy);
    expect(target.assigneeId).toBeNull();
  });
});

describe("alerts and history", () => {
  const now = new Date("2026-10-26T12:00:00.000Z");
  it("opens an alert at Overloaded or Critical, follows the label between them and ends it at anything else", () => {
    expect(decideAlert(null, "overloaded", now)).toEqual({ action: "open", label: "overloaded", since: now.toISOString(), criticalSince: null });
    expect(decideAlert(null, "critical", now)).toEqual({ action: "open", label: "critical", since: now.toISOString(), criticalSince: now.toISOString() });
    for (const l of ["available", "balanced", "busy", null] as const) expect(decideAlert(null, l, now)).toEqual({ action: "none" });
    const open = { label: "overloaded" as const, since: "2026-10-26T01:00:00.000Z", criticalSince: null };
    expect(decideAlert(open, "overloaded", now)).toEqual({ action: "none" });
    expect(decideAlert(open, "critical", now)).toEqual({ action: "change", label: "critical", criticalSince: now.toISOString() });
    const crit = { label: "critical" as const, since: "2026-10-26T01:00:00.000Z", criticalSince: "2026-10-26T05:00:00.000Z" };
    expect(decideAlert(crit, "critical", now)).toEqual({ action: "none" });
    expect(decideAlert(crit, "overloaded", now)).toEqual({ action: "change", label: "overloaded", criticalSince: null });
    for (const l of ["available", "balanced", "busy", null] as const) {
      expect(decideAlert(open, l, now)).toEqual({ action: "resolve" });
      expect(decideAlert(crit, l, now)).toEqual({ action: "resolve" });
    }
  });

  it("writes history once a day, and again only when the label or the points differ from the latest row", () => {
    const row = { label: "busy" as WorkloadLabel | null, pointsCenti: 1800 };
    expect(snapshotKind(null, row, false)).toBe("daily");
    expect(snapshotKind(row, row, false)).toBe("daily");
    expect(snapshotKind(row, row, true)).toBeNull();
    expect(snapshotKind(row, { ...row, pointsCenti: 1801 }, true)).toBe("change");
    expect(snapshotKind(row, { label: "overloaded", pointsCenti: 1800 }, true)).toBe("change");
    expect(snapshotKind(row, { label: null, pointsCenti: 1800 }, true)).toBe("change");
    expect(snapshotKind(null, row, true)).toBe("change");
  });

  it("words how long something has lasted", () => {
    const at = (h: number) => new Date(now.getTime() - h * 3_600_000 - 1000).toISOString();
    expect(durationText(at(0), now)).toBe("under an hour");
    expect(durationText(new Date(now.getTime() - 59 * 60_000).toISOString(), now)).toBe("under an hour");
    expect(durationText(new Date(now.getTime() - 3_600_000).toISOString(), now)).toBe("1 hour");
    expect(durationText(at(5), now)).toBe("5 hours");
    expect(durationText(at(47), now)).toBe("47 hours");
    expect(durationText(at(48), now)).toBe("2 days");
    expect(durationText(at(24 * 10), now)).toBe("10 days");
    expect(durationText("garbage", now)).toBe("under an hour");
  });

  it("keys the notices once per person, label and day, and once per person and day", () => {
    expect(managerNoticeKey("u", "overloaded", "2026-10-26")).toBe("workload:u:overloaded:2026-10-26");
    expect(managerNoticeKey("u", "critical", "2026-10-26")).not.toBe(managerNoticeKey("u", "overloaded", "2026-10-26"));
    expect(managerNoticeKey("u", "critical", "2026-10-27")).not.toBe(managerNoticeKey("u", "critical", "2026-10-26"));
    expect(overdueNoticeKey("u", "2026-10-26")).toBe("overdue:u:2026-10-26");
  });
});
