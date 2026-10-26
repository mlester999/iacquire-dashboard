// The staff workload rules that need no database: the numbers in code, how overrides are read and refused, the points an item adds, what time off and a profile accept, who may
// see what, and the words of the two notices. Pure: nothing here touches a clock, a network or a table.
import { describe, expect, it } from "vitest";
import {
  COUNTS_ONLY_NOTE, DEFAULT_RULES, NOT_A_SCORE_NOTE, PROJECT_WEIGHT_STATUSES, RULE_FIELDS, RULE_STATEMENTS, changedPaths, describeRules, formatPoints, getRule, itemPointsCenti,
  normalizeRules, overridesOf, type WorkloadRules,
} from "@/lib/staff-workload/rules";
import { ASSIGN_PERMISSIONS, READ_PERMISSIONS, SKILLS, WORK_SOURCES, hasDueDate, isDay, isOverdue, skillFor, type WorkItem } from "@/lib/staff-workload/sources";
import { MAX_NOTE_CHARS, checkProfile, checkTimeOff, cleanNote } from "@/lib/staff-workload/time-off";
import { CAP_PERMISSIONS, NO_CAPS, canEditProfile, canEditTimeOff, canSeeAway, canSeeItem, canSeeLabelOf, canSeeProfileOf, canSeeTimeOffDetail, capsFrom, splitVisible, type Viewer } from "@/lib/staff-workload/visibility";
import { managerAlertNotice, overdueNotice } from "@/lib/staff-workload/notices";
import { ESCALATION_KINDS, sortEscalations, type EscalationEntry } from "@/lib/staff-workload/escalations";
import { computeWorkload, resolveCapacity } from "@/lib/staff-workload/labels";
import { workItem as item } from "./support/staff-workload-pure";

describe("the numbers in code are the audit's proposals", () => {
  it("has the weights, thresholds, floors and horizon the audit proposed, and no team default capacity", () => {
    expect(DEFAULT_RULES.weights.support).toEqual({ urgent: 5, high: 3, normal: 2, low: 1 });
    expect(DEFAULT_RULES.weights.supportWaitingPercent).toBe(25);
    expect(DEFAULT_RULES.weights.supportEscalatedExtra).toBe(2);
    expect(DEFAULT_RULES.weights.setupRequired).toBe(2);
    expect(DEFAULT_RULES.weights.setupOptional).toBe(1);
    expect(DEFAULT_RULES.weights.setupBlockedPercent).toBe(50);
    expect(DEFAULT_RULES.weights.setupWaitingPercent).toBe(25);
    expect(DEFAULT_RULES.weights.project).toEqual({
      submitted: 2, under_review: 2, discovery_needed: 2, quote_preparing: 3, quote_sent: 1, awaiting_approval: 1, approved: 2, in_development: 5, testing: 3, ready_for_review: 2, on_hold: 0.5,
    });
    expect(DEFAULT_RULES.weights.maintenance).toBe(2);
    expect(DEFAULT_RULES.weights.maintenanceWaitingPercent).toBe(25);
    expect(DEFAULT_RULES.thresholds).toEqual({ balancedFrom: 50, busyFrom: 85, overloadedFrom: 100, criticalFrom: 125 });
    expect(DEFAULT_RULES.floors).toEqual({ busyAtOverdue: 1, overloadedAtOverdue: 3, criticalAtOverdue: 5 });
    expect(DEFAULT_RULES.horizonDays).toBe(5);
    // The audit gives no number for it, so none is invented: until a Super Admin sets one, people with no capacity of their own get no label.
    expect(DEFAULT_RULES.defaultCapacityPoints).toBeNull();
  });

  it("lists every number as an editable field, and every field points at a number that exists", () => {
    const leaves: string[] = [];
    const walk = (value: unknown, prefix: string) => {
      if (typeof value === "object" && value !== null) for (const [k, v] of Object.entries(value)) walk(v, prefix ? `${prefix}.${k}` : k);
      else leaves.push(prefix);
    };
    walk(DEFAULT_RULES, "");
    expect(RULE_FIELDS.map((f) => f.path).sort()).toEqual(leaves.sort());
    for (const f of RULE_FIELDS) expect(f.min).toBeLessThan(f.max);
    expect(new Set(RULE_FIELDS.map((f) => f.path)).size).toBe(RULE_FIELDS.length);
  });

  it("says on the Rules panel what is counted and that a label is not a score", () => {
    expect(COUNTS_ONLY_NOTE).toMatch(/only work recorded in iAcquire/);
    expect(NOT_A_SCORE_NOTE).toMatch(/not a score of anyone's performance/);
    expect(RULE_STATEMENTS).toContain(COUNTS_ONLY_NOTE);
    expect(RULE_STATEMENTS).toContain(NOT_A_SCORE_NOTE);
    expect(RULE_STATEMENTS.join(" ")).toMatch(/no due date/);
    expect(RULE_STATEMENTS.join(" ")).toMatch(/Capacity is a number of points over the planning horizon/);
  });
});

describe("the points an item adds", () => {
  const points = (over: Partial<WorkItem>, rules: WorkloadRules = DEFAULT_RULES) => itemPointsCenti(item(over), rules);

  it("counts a support request by priority, a quarter of it while waiting for the client, and two more when escalated", () => {
    expect(points({ priority: "urgent" })).toBe(500);
    expect(points({ priority: "high" })).toBe(300);
    expect(points({ priority: "normal" })).toBe(200);
    expect(points({ priority: "low" })).toBe(100);
    expect(points({ priority: "high", status: "waiting_for_client" })).toBe(75);
    expect(points({ priority: "normal", waitingOnClient: true })).toBe(50);
    expect(points({ priority: "urgent", escalated: true })).toBe(700);
    expect(points({ priority: "low", status: "waiting_for_client", escalated: true })).toBe(225);
    // An unknown priority adds nothing rather than a guess.
    expect(points({ priority: "whenever" })).toBe(0);
    expect(points({ priority: null })).toBe(0);
  });

  it("counts a setup step by whether it is required, half while blocked and a quarter while waiting for the client", () => {
    expect(points({ source: "setup_task", status: "pending", priority: null })).toBe(200);
    expect(points({ source: "setup_task", status: "pending", optional: true })).toBe(100);
    expect(points({ source: "setup_task", status: "blocked", blocked: true })).toBe(100);
    expect(points({ source: "setup_task", status: "blocked", optional: true })).toBe(50);
    expect(points({ source: "setup_task", status: "waiting_for_client" })).toBe(50);
    expect(points({ source: "setup_task", waitingOnClient: true, optional: true })).toBe(25);
  });

  it("counts a custom project by its status and nothing for the review tasks it carries", () => {
    const by = (status: string) => points({ source: "project", status, openReviewTasks: 4 });
    expect(PROJECT_WEIGHT_STATUSES.map((s) => by(s))).toEqual([200, 200, 200, 300, 100, 100, 200, 500, 300, 200, 50]);
    expect(by("completed")).toBe(0);
    expect(by("cancelled")).toBe(0);
  });

  it("counts a maintenance request, a quarter of it while waiting for the client", () => {
    expect(points({ source: "maintenance", status: "open" })).toBe(200);
    expect(points({ source: "maintenance", status: "waiting_for_client" })).toBe(50);
    expect(points({ source: "maintenance", waitingOnClient: true })).toBe(50);
  });

  it("rounds a share half up in hundredths, so no boundary depends on floating point", () => {
    const rules = normalizeRules({ weights: { support: { normal: 3 }, supportWaitingPercent: 33 } });
    expect(rules.ok).toBe(true);
    if (rules.ok) expect(points({ priority: "normal", status: "waiting_for_client" }, rules.rules)).toBe(99);
    const half = normalizeRules({ weights: { support: { low: 1.25 }, supportWaitingPercent: 10 } });
    if (half.ok) expect(points({ priority: "low", status: "waiting_for_client" }, half.rules)).toBe(13); // 12.5 rounds up
  });

  it("formats points without a long tail", () => {
    expect(formatPoints(0)).toBe("0");
    expect(formatPoints(200)).toBe("2");
    expect(formatPoints(75)).toBe("0.75");
    expect(formatPoints(1250)).toBe("12.5");
    expect(formatPoints(1)).toBe("0.01");
  });
});

describe("reading and refusing rule overrides", () => {
  it("returns the defaults for nothing, and lays a partial change over them", () => {
    for (const input of [undefined, null, {}]) {
      const r = normalizeRules(input);
      expect(r.ok && r.rules).toEqual(DEFAULT_RULES);
    }
    const r = normalizeRules({ weights: { support: { urgent: 6 } }, defaultCapacityPoints: 30, horizonDays: 10 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rules.weights.support).toEqual({ urgent: 6, high: 3, normal: 2, low: 1 });
      expect(r.rules.defaultCapacityPoints).toBe(30);
      expect(r.rules.horizonDays).toBe(10);
      expect(r.rules.thresholds).toEqual(DEFAULT_RULES.thresholds);
    }
    // The defaults are not changed by reading a change.
    expect(DEFAULT_RULES.weights.support.urgent).toBe(5);
    expect(DEFAULT_RULES.defaultCapacityPoints).toBeNull();
  });

  it("refuses everything when anything is wrong, with a plain message, and applies nothing", () => {
    const messages = (input: unknown) => {
      const r = normalizeRules(input);
      return r.ok ? [] : r.errors.map((e) => e.message);
    };
    expect(messages("nope")).toEqual(["The rules must be an object of numbers."]);
    expect(messages([1, 2])).toEqual(["The rules must be an object of numbers."]);
    expect(messages({ nothing: 1 })).toEqual(['"nothing" is not a rule.']);
    expect(messages({ weights: { support: { urgent: -1 } } })[0]).toMatch(/Urgent request must be from 0 to 50 points/);
    expect(messages({ weights: { support: { urgent: 5.1 } } })[0]).toMatch(/multiple of 0.25/);
    expect(messages({ thresholds: { busyFrom: 50.5 } })[0]).toMatch(/whole number/);
    expect(messages({ horizonDays: 0 })[0]).toMatch(/Planning horizon must be from 1 to 20 days/);
    expect(messages({ horizonDays: "5" })[0]).toMatch(/needs a number/);
    expect(messages({ horizonDays: NaN })[0]).toMatch(/needs a number/);
    expect(messages({ horizonDays: Infinity })[0]).toMatch(/needs a number/);
    expect(messages({ horizonDays: null })[0]).toMatch(/needs a number/);
    expect(messages({ defaultCapacityPoints: 0 })[0]).toMatch(/from 1 to 200/);
    expect(messages({ defaultCapacityPoints: null })).toEqual([]);
    // Several wrong values report each, and the good ones next to them are not applied.
    expect(messages({ horizonDays: 99, weights: { maintenance: 3 }, nothing: true }).length).toBe(2);
  });

  it("refuses labels and floors that are out of order", () => {
    const labels = normalizeRules({ thresholds: { busyFrom: 40 } });
    expect(!labels.ok && labels.errors[0].message).toMatch(/must begin in order/);
    const equal = normalizeRules({ thresholds: { overloadedFrom: 85 } });
    expect(equal.ok).toBe(false);
    const floors = normalizeRules({ floors: { busyAtOverdue: 3 } });
    expect(!floors.ok && floors.errors[0].message).toMatch(/must rise/);
    expect(normalizeRules({ thresholds: { balancedFrom: 40, busyFrom: 70, overloadedFrom: 90, criticalFrom: 110 } }).ok).toBe(true);
  });

  it("treats inherited and prototype keys as unknown rules, never as settings", () => {
    const json = JSON.parse('{"__proto__": {"horizonDays": 9}, "constructor": 1}');
    const r = normalizeRules(json);
    expect(r.ok).toBe(false);
    expect(({} as Record<string, unknown>).horizonDays).toBeUndefined();
    expect(DEFAULT_RULES.horizonDays).toBe(5);
  });

  it("keeps only what differs from the defaults, nested as the rules are, and round-trips", () => {
    expect(overridesOf(DEFAULT_RULES)).toEqual({});
    const r = normalizeRules({ weights: { support: { urgent: 6 }, project: { testing: 4 } }, defaultCapacityPoints: 25 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const overrides = overridesOf(r.rules);
    expect(overrides).toEqual({ weights: { support: { urgent: 6 }, project: { testing: 4 } }, defaultCapacityPoints: 25 });
    const again = normalizeRules(overrides);
    expect(again.ok && again.rules).toEqual(r.rules);
    expect(changedPaths(DEFAULT_RULES, r.rules).sort()).toEqual(["defaultCapacityPoints", "weights.project.testing", "weights.support.urgent"]);
    expect(getRule(r.rules, "weights.support.urgent")).toBe(6);
    expect(getRule(r.rules, "weights.support")).toBeNull();
    expect(getRule(r.rules, "nothing.here")).toBeNull();
  });

  it("groups the Rules panel and marks what a Super Admin changed", () => {
    const r = normalizeRules({ weights: { maintenance: 3 }, defaultCapacityPoints: 20 });
    if (!r.ok) throw new Error("rules");
    const groups = describeRules(r.rules);
    expect(groups.map((g) => g.group)).toEqual(["Support requests", "Setup steps", "Custom projects", "Maintenance requests", "Labels", "Floors from real facts", "Capacity", "Project health"]);
    const rows = groups.flatMap((g) => g.rows);
    expect(rows.find((x) => x.path === "weights.maintenance")).toMatchObject({ value: "3 points", changed: true });
    expect(rows.find((x) => x.path === "weights.support.urgent")).toMatchObject({ value: "5 points", changed: false });
    expect(rows.find((x) => x.path === "defaultCapacityPoints")).toMatchObject({ value: "20 points", changed: true });
    expect(describeRules(DEFAULT_RULES).flatMap((g) => g.rows).find((x) => x.path === "defaultCapacityPoints")).toMatchObject({ value: "Not set", changed: false });
    expect(rows.find((x) => x.path === "horizonDays")?.value).toBe("5 working days");
    expect(rows.find((x) => x.path === "thresholds.busyFrom")?.value).toBe("85%");
  });

  it("is fast on very long unknown rule names and very deep input", () => {
    const started = Date.now();
    const long = "x".repeat(20_000);
    const r = normalizeRules({ [long]: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].message.length).toBeLessThan(200);
    let deep: Record<string, unknown> = { horizonDays: 5 };
    for (let i = 0; i < 2000; i += 1) deep = { a: deep };
    expect(normalizeRules(deep).ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("what counts as work, a day and overdue", () => {
  it("recognises a real calendar day and nothing else", () => {
    expect(isDay("2026-10-24")).toBe(true);
    expect(isDay("2028-02-29")).toBe(true);
    expect(isDay("2027-02-29")).toBe(false);
    expect(isDay("2026-13-01")).toBe(false);
    expect(isDay("2026-10-24T00:00:00Z")).toBe(false);
    expect(isDay("24/10/2026")).toBe(false);
    for (const bad of [null, undefined, 20261024, {}, ""]) expect(isDay(bad)).toBe(false);
  });

  it("is overdue only past a date somebody set: a moment is compared as a moment, a day as a day", () => {
    const now = new Date("2026-10-24T10:00:00.000Z");
    const today = "2026-10-24";
    expect(isOverdue({ dueAt: null, dueOn: null }, now, today)).toBe(false);
    expect(isOverdue({ dueAt: "2026-10-24T09:59:59.000Z", dueOn: null }, now, today)).toBe(true);
    expect(isOverdue({ dueAt: "2026-10-24T10:00:00.000Z", dueOn: null }, now, today)).toBe(false);
    expect(isOverdue({ dueAt: "2026-10-24T10:00:01.000Z", dueOn: null }, now, today)).toBe(false);
    expect(isOverdue({ dueAt: null, dueOn: "2026-10-23" }, now, today)).toBe(true);
    expect(isOverdue({ dueAt: null, dueOn: "2026-10-24" }, now, today)).toBe(false);
    expect(isOverdue({ dueAt: null, dueOn: "not a day" }, now, today)).toBe(false);
    expect(isOverdue({ dueAt: "garbage", dueOn: null }, now, today)).toBe(false);
    expect(hasDueDate({ dueAt: null, dueOn: null })).toBe(false);
    expect(hasDueDate({ dueAt: null, dueOn: "2026-10-30" })).toBe(true);
  });

  it("picks the skill that fits from the category or service it already carries, never from its text", () => {
    expect(skillFor({ source: "support", hint: "billing" })).toBe("billing");
    expect(skillFor({ source: "support", hint: "ai_employees" })).toBe("ai_employees");
    expect(skillFor({ source: "support", hint: "onboarding" })).toBe("setup");
    expect(skillFor({ source: "support", hint: "feature_not_working" })).toBe("support");
    expect(skillFor({ source: "support", hint: null })).toBe("support");
    expect(skillFor({ source: "setup_task", hint: "automations" })).toBe("crm");
    expect(skillFor({ source: "setup_task", hint: "calendar" })).toBe("integrations");
    expect(skillFor({ source: "setup_task", hint: null })).toBe("setup");
    expect(skillFor({ source: "project", hint: "billing" })).toBe("projects");
    expect(skillFor({ source: "maintenance", hint: "core_defect" })).toBe("maintenance");
    for (const source of WORK_SOURCES) for (const hint of [null, "x", "billing"]) expect(SKILLS).toContain(skillFor({ source, hint }));
  });

  it("names the permissions each kind of work needs, and the assign list is never shorter than the read list", () => {
    for (const source of WORK_SOURCES) {
      expect(ASSIGN_PERMISSIONS[source].length).toBeGreaterThan(0);
      expect(ASSIGN_PERMISSIONS[source]).toEqual(expect.arrayContaining([...READ_PERMISSIONS[source]]));
    }
    expect(ASSIGN_PERMISSIONS.support).toEqual(["agency.support.view", "agency.support.manage"]);
    expect(ASSIGN_PERMISSIONS.project).toEqual(["projects.view", "projects.manage"]);
  });
});

describe("what time off and a profile accept", () => {
  const today = "2026-10-24";
  const ok = (over: Record<string, unknown>) => checkTimeOff({ startsOn: "2026-10-26", endsOn: "2026-10-28", ...over }, today);

  it("accepts a normal entry and tidies the note", () => {
    const r = ok({ kind: "sick", note: "  flu \t\n  again  " });
    expect(r).toEqual({ ok: true, value: { startsOn: "2026-10-26", endsOn: "2026-10-28", partDay: false, kind: "sick", note: "flu again" } });
    expect(ok({})).toMatchObject({ ok: true, value: { kind: "leave", note: null, partDay: false } });
    expect(ok({ startsOn: "2026-10-26", endsOn: "2026-10-26", partDay: true })).toMatchObject({ ok: true, value: { partDay: true } });
  });

  it("refuses what makes no sense, in plain words", () => {
    const why = (over: Record<string, unknown>) => {
      const r = ok(over);
      return r.ok ? null : r.message;
    };
    expect(why({ startsOn: "tomorrow" })).toMatch(/first and the last day/);
    expect(why({ endsOn: undefined })).toMatch(/first and the last day/);
    expect(why({ startsOn: "2026-10-29" })).toMatch(/cannot be before/);
    expect(why({ endsOn: "2028-01-01" })).toMatch(/at most 366 days/);
    expect(why({ startsOn: "2026-08-01", endsOn: "2026-09-01" })).toMatch(/more than 31 days ago/);
    expect(why({ startsOn: "2029-01-01", endsOn: "2029-01-02" })).toMatch(/two years ahead/);
    expect(why({ partDay: true })).toMatch(/only be one day/);
    expect(why({ kind: "vacation" })).toMatch(/what kind/);
    expect(why({ kind: 3 })).toMatch(/what kind/);
    expect(why({ note: 5 })).toMatch(/must be text/);
    // Yesterday's sick day is allowed; one 31 days ago ends exactly at the edge.
    expect(ok({ startsOn: "2026-10-23", endsOn: "2026-10-23" }).ok).toBe(true);
    expect(ok({ startsOn: "2026-09-23", endsOn: "2026-09-23" }).ok).toBe(true);
    expect(ok({ startsOn: "2026-09-22", endsOn: "2026-09-22" }).ok).toBe(false);
  });

  it("cleans a note in one linear pass: control characters, runs of spaces, the limit, and 20,000 characters", () => {
    expect(cleanNote(null)).toBeNull();
    expect(cleanNote(5)).toBeNull();
    expect(cleanNote("   ")).toBeNull();
    const control = (code: number) => String.fromCharCode(code);
    expect(cleanNote(`a${control(0)}b${control(7)}c`)).toBe("a b c");
    expect(cleanNote(`a${control(160)}b`)).toBe("a b");
    expect(cleanNote("a  b   c")).toBe("a b c");
    expect(cleanNote("x".repeat(500))).toHaveLength(MAX_NOTE_CHARS);
    const started = Date.now();
    expect(cleanNote(" ".repeat(1000) + "a" + " ".repeat(1000))).toBe("a");
    expect(cleanNote(" ".repeat(20_000))).toBeNull();
    expect(cleanNote("a ".repeat(20_000))?.length).toBeLessThanOrEqual(MAX_NOTE_CHARS);
    expect(cleanNote(control(1).repeat(20_000))).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("accepts a profile change field by field and refuses the rest", () => {
    expect(checkProfile({ capacityPoints: 25 })).toEqual({ ok: true, value: { capacityPoints: 25 } });
    expect(checkProfile({ capacityPoints: null })).toEqual({ ok: true, value: { capacityPoints: null } });
    expect(checkProfile({ workingDays: [4, 1, 2] })).toEqual({ ok: true, value: { workingDays: [1, 2, 4] } });
    expect(checkProfile({ skills: { support: 3, crm: 1, billing: null, website: 0 } })).toEqual({ ok: true, value: { skills: { support: 3, crm: 1 } } });
    const bad = (input: Record<string, unknown>) => {
      const r = checkProfile(input);
      return r.ok ? null : r.message;
    };
    expect(bad({})).toBe("Nothing to change.");
    expect(bad({ capacityPoints: 0 })).toMatch(/1 to 200/);
    expect(bad({ capacityPoints: 201 })).toMatch(/1 to 200/);
    expect(bad({ capacityPoints: 10.5 })).toMatch(/whole number/);
    expect(bad({ capacityPoints: "10" })).toMatch(/whole number/);
    expect(bad({ workingDays: [] })).toMatch(/at least one/);
    expect(bad({ workingDays: [1, 1] })).toMatch(/at least one/);
    expect(bad({ workingDays: [0] })).toMatch(/at least one/);
    expect(bad({ workingDays: [8] })).toMatch(/at least one/);
    expect(bad({ workingDays: "1,2" })).toMatch(/at least one/);
    expect(bad({ skills: [] })).toMatch(/list of skills/);
    expect(bad({ skills: { juggling: 2 } })).toMatch(/not a skill/);
    expect(bad({ skills: { support: 4 } })).toMatch(/1, 2 or 3/);
    expect(bad({ skills: { support: 1.5 } })).toMatch(/1, 2 or 3/);
    expect(bad({ skills: { ["x".repeat(20_000)]: 1 } })?.length).toBeLessThan(200);
  });
});

describe("who sees what", () => {
  const self: Viewer = { userId: "u-self", caps: capsFrom((p) => p === CAP_PERMISSIONS.view) };
  const lead: Viewer = { userId: "u-lead", caps: capsFrom((p) => p === CAP_PERMISSIONS.view || p === CAP_PERMISSIONS.team) };
  const hr: Viewer = { userId: "u-hr", caps: capsFrom((p) => p === CAP_PERMISSIONS.view || p === CAP_PERMISSIONS.manage) };
  const nobody: Viewer = { userId: "u-none", caps: NO_CAPS };

  it("shows a label to the person and to the team permission, never to a peer or to someone without the view permission", () => {
    expect(canSeeLabelOf(self, "u-self")).toBe(true);
    expect(canSeeLabelOf(self, "u-other")).toBe(false);
    expect(canSeeLabelOf(lead, "u-self")).toBe(true);
    expect(canSeeLabelOf(lead, "u-lead")).toBe(true);
    expect(canSeeLabelOf(hr, "u-self")).toBe(false);
    expect(canSeeLabelOf(nobody, "u-none")).toBe(false);
    expect(canSeeLabelOf({ userId: "u-lead", caps: { ...lead.caps, view: false } }, "u-lead")).toBe(false);
  });

  it("shows the kind and the note of time off only to the person and to the manage permission; the team permission learns only that someone is away", () => {
    expect(canSeeTimeOffDetail(self, "u-self")).toBe(true);
    expect(canSeeTimeOffDetail(lead, "u-self")).toBe(false);
    expect(canSeeTimeOffDetail(hr, "u-self")).toBe(true);
    expect(canSeeTimeOffDetail(self, "u-other")).toBe(false);
    expect(canSeeAway(lead, "u-self")).toBe(true);
    expect(canSeeAway(hr, "u-self")).toBe(true);
    expect(canSeeAway(self, "u-other")).toBe(false);
    expect(canSeeAway(nobody, "u-none")).toBe(false);
  });

  it("shows capacity and skills to the person and the team permission, lets only the manage permission change them, and lets a person change only their own time off", () => {
    expect(canSeeProfileOf(self, "u-self")).toBe(true);
    expect(canSeeProfileOf(self, "u-other")).toBe(false);
    expect(canSeeProfileOf(lead, "u-self")).toBe(true);
    expect(canSeeProfileOf(hr, "u-self")).toBe(false);
    expect(canEditProfile(self)).toBe(false);
    expect(canEditProfile(lead)).toBe(false);
    expect(canEditProfile(hr)).toBe(true);
    expect(canEditProfile(nobody)).toBe(false);
    expect(canEditTimeOff(self, "u-self")).toBe(true);
    expect(canEditTimeOff(self, "u-other")).toBe(false);
    expect(canEditTimeOff(lead, "u-self")).toBe(false);
    expect(canEditTimeOff(hr, "u-self")).toBe(true);
  });

  const access = (orgs: string[], permissions: string[], userId = "u-lead") => ({ userId, accessibleOrgs: new Set(orgs), permissions: new Set(permissions) });
  it("shows an item's details only for a client the viewer can open and with the permission to read that kind of work", () => {
    const ticket = { source: "support" as const, orgId: "o-1", assigneeId: "u-x" };
    expect(canSeeItem(access(["o-1"], ["agency.support.view", "agency.support.queue"]), ticket)).toBe(true);
    expect(canSeeItem(access(["o-2"], ["agency.support.view", "agency.support.queue"]), ticket)).toBe(false);
    expect(canSeeItem(access(["o-1"], []), ticket)).toBe(false);
    // Like Support itself: without the queue permission only the requests assigned to the viewer.
    expect(canSeeItem(access(["o-1"], ["agency.support.view"]), ticket)).toBe(false);
    expect(canSeeItem(access(["o-1"], ["agency.support.view"], "u-x"), ticket)).toBe(true);
    expect(canSeeItem(access(["o-1"], ["projects.view"]), { source: "project", orgId: "o-1", assigneeId: null })).toBe(true);
    expect(canSeeItem(access(["o-1"], ["projects.manage"]), { source: "project", orgId: "o-1", assigneeId: null })).toBe(false);
    expect(canSeeItem(access(["o-1"], ["setup.manage"]), { source: "setup_task", orgId: "o-1", assigneeId: null })).toBe(true);
    expect(canSeeItem(access(["o-1"], ["maintenance.manage"]), { source: "maintenance", orgId: "o-1", assigneeId: null })).toBe(true);
  });

  it("counts what it hides instead of dropping it", () => {
    const items = [
      { source: "setup_task" as const, orgId: "o-1", assigneeId: null },
      { source: "setup_task" as const, orgId: "o-2", assigneeId: null },
      { source: "project" as const, orgId: "o-1", assigneeId: null },
    ];
    const r = splitVisible(items, access(["o-1"], ["setup.manage"]));
    expect(r.visible).toHaveLength(1);
    expect(r.hidden).toBe(2);
  });
});

describe("the notices", () => {
  const rules = DEFAULT_RULES;
  const now = new Date("2026-10-24T12:00:00.000Z");
  const result = (items: WorkItem[], capacity = 10) =>
    computeWorkload({ items, capacity: resolveCapacity(capacity, rules, 10), rules: { ...rules, defaultCapacityPoints: capacity }, now, today: "2026-10-24", supportTargetsEnabled: true });

  it("tells a manager the counts and how long, and names no client and no item", () => {
    const items = Array.from({ length: 8 }, (_, i) => item({ itemId: `i-${i}`, orgName: "Secret Client Ltd", title: "Secret title", priority: "urgent", dueAt: "2026-10-24T08:00:00.000Z" }));
    const r = result(items);
    const n = managerAlertNotice({ userId: "22222222-2222-4222-8222-222222222222", name: "Maya Lopez", label: "critical", result: r, since: "2026-10-24T05:00:00.000Z", criticalSince: "2026-10-24T07:00:00.000Z", now });
    expect(n.title).toBe("Maya Lopez is Critical");
    expect(n.body).toContain("40 points of open work against 10 points of capacity over the next 5 working days");
    expect(n.body).toContain("8 items are overdue");
    expect(n.body).toContain("Critical for 5 hours");
    expect(n.body).toContain("Counts only work recorded in iAcquire");
    expect(`${n.title} ${n.body}`).not.toMatch(/Secret/);
    expect(n.link).toBe("/admin/workload/people/22222222-2222-4222-8222-222222222222");
    expect(n.link).toMatch(/^\/[A-Za-z0-9/_?=&%.-]*$/);
  });

  it("says Overloaded for how long, and mentions an escalation or an absence when that is the reason", () => {
    const n = managerAlertNotice({ userId: "u", name: "Sam", label: "overloaded", result: result([item({ escalated: true })], 1), since: "2026-10-22T08:00:00.000Z", criticalSince: null, now });
    expect(n.title).toBe("Sam is Overloaded");
    expect(n.body).toContain("Overloaded for 2 days");
    expect(n.body).toContain("1 request is escalated");
    const away = computeWorkload({ items: [item()], capacity: { capacityPoints: 10, source: "person", availableHalfDays: 0, horizonDays: 5 }, rules, now, today: "2026-10-24", supportTargetsEnabled: true });
    expect(managerAlertNotice({ userId: "u", name: "Sam", label: "critical", result: away, since: now.toISOString(), criticalSince: now.toISOString(), now }).body).toContain("Away for the whole planning period with 2 points of work open");
  });

  it("tells a person how many of each kind are past their time", () => {
    expect(overdueNotice({ support: 2, setup_task: 1 })).toEqual({
      title: "You have 3 overdue items",
      body: "2 support requests, 1 setup step assigned to you are past their due time. Open your workload to see which.",
      link: "/admin/workload/me",
    });
    expect(overdueNotice({ project: 1 }).title).toBe("You have 1 overdue item");
    expect(overdueNotice({ project: 1 }).body).toBe("1 custom project assigned to you is past its due time. Open your workload to see which.");
  });
});

describe("the escalation list", () => {
  const entry = (over: Partial<EscalationEntry>): EscalationEntry => ({
    kind: "support_escalated", id: "a", orgId: null, orgName: null, title: "t", since: "2026-10-20T00:00:00.000Z", critical: false, assigneeId: null, note: null, link: "/x", ...over,
  });

  it("puts a critical one first, then the longest running, then kind and id, the same way every time", () => {
    const list = [
      entry({ id: "1", since: "2026-10-23T00:00:00.000Z" }),
      entry({ id: "2", since: "2026-10-21T00:00:00.000Z" }),
      entry({ id: "3", since: "2026-10-23T00:00:00.000Z", critical: true }),
      entry({ id: "4", since: "2026-10-23T00:00:00.000Z", kind: "workload" }),
      entry({ id: "0", since: "2026-10-23T00:00:00.000Z" }),
    ];
    const sorted = sortEscalations(list).map((e) => e.id);
    expect(sorted).toEqual(["3", "2", "0", "1", "4"]);
    expect(sortEscalations([...list].reverse()).map((e) => e.id)).toEqual(sorted);
    expect(list.map((e) => e.id)).toEqual(["1", "2", "3", "4", "0"]);
    expect(ESCALATION_KINDS).toEqual(["support_escalated", "support_overdue", "incident", "workload"]);
  });
});
