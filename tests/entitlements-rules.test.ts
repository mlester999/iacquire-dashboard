// What a workspace is entitled to, decided by pure rules (src/lib/entitlements.ts): the optional plan and what hangs on it (Automation Studio, managed media storage), and whether
// the one-time setup fee is cleared. The shell, every server gate and the media policy read the same rules, so these tests are the whole of the decision. No database.
import { describe, expect, it } from "vitest";
import { entitlementFor, OPEN_PLAN_STATUSES, type PlanStatus } from "@/lib/automation-studio/plan";
import { currentPlanOf, entitlementsFrom, studioEntitlementOf, type PlanFacts } from "@/lib/entitlements";

const DAY = 86_400_000;
const NOW = new Date("2026-10-21T12:00:00Z");
const TODAY = "2026-10-21";
const day = (offset: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + offset * DAY).toISOString().slice(0, 10);
const STATUSES: PlanStatus[] = ["requested", "active", "past_due", "cancel_requested", "cancelled", "declined", "expired"];
const plan = (status: PlanStatus, over: Partial<PlanFacts> = {}): PlanFacts => ({ id: `plan-${status}`, status, graceEndsAt: null, paidThroughOn: null, createdAt: "2026-09-01T00:00:00Z", ...over });
const ent = (p: PlanFacts | null, over: { setupCleared?: boolean; now?: Date; today?: string } = {}) => entitlementsFrom({ plan: p, setupCleared: over.setupCleared ?? true, now: over.now ?? NOW, today: over.today ?? TODAY });

describe("one rule for the plan, however it is asked", () => {
  it("is Automation Studio's own rule, so the shell, the gates and the engine cannot disagree", () => {
    for (const status of STATUSES) {
      for (const graceEndsAt of [null, new Date(NOW.getTime() - 1).toISOString(), new Date(NOW.getTime() + DAY).toISOString()]) {
        const p = plan(status, { graceEndsAt, paidThroughOn: day(-3) });
        expect(studioEntitlementOf(p, NOW), `${status} ${graceEndsAt}`).toEqual(entitlementFor({ id: p.id, status, graceEndsAt, paidThroughOn: p.paidThroughOn }, NOW));
        expect(ent(p).studio).toEqual(studioEntitlementOf(p, NOW));
      }
    }
    expect(studioEntitlementOf(null, NOW)).toEqual(entitlementFor(null, NOW));
  });

  it("gives managed media storage exactly the answer Automation Studio gets, for every status and every moment around the end of a grace period", () => {
    const grace = new Date(NOW.getTime() + 2 * DAY);
    for (const status of STATUSES) {
      for (const offset of [-DAY, -1, 0, 1, DAY]) {
        const now = new Date(grace.getTime() + offset);
        const e = ent(plan(status, { graceEndsAt: grace }), { now });
        expect(e.managedStorage, `${status} ${offset}`).toBe(e.studio.entitled);
      }
    }
    expect(ent(null).managedStorage).toBe(false);
  });

  it("entitles exactly the plans that are active, about to be cancelled, or past due and inside their grace period", () => {
    const entitled = (status: PlanStatus, graceOffsetMs: number | null) => ent(plan(status, { graceEndsAt: graceOffsetMs === null ? null : new Date(NOW.getTime() + graceOffsetMs) })).studio.entitled;
    expect(entitled("active", null)).toBe(true);
    expect(entitled("cancel_requested", null)).toBe(true);
    expect(entitled("past_due", DAY)).toBe(true);
    expect(entitled("past_due", 1)).toBe(true);
    expect(entitled("past_due", 0)).toBe(false);
    expect(entitled("past_due", -1)).toBe(false);
    expect(entitled("past_due", null)).toBe(false);
    for (const status of ["requested", "cancelled", "declined", "expired"] as const) expect(entitled(status, DAY), status).toBe(false);
    expect(ent(null).studio).toMatchObject({ entitled: false, state: "none" });
  });

  it("reports the plan's state beside the entitlement, with nothing invented for a workspace that never had a plan", () => {
    expect(ent(null).maintenance).toEqual({ status: null, state: "none", paidThroughOn: null, paidPeriodEnded: false, daysLeft: null });
    expect(ent(plan("active", { paidThroughOn: day(12) })).maintenance).toEqual({ status: "active", state: "active", paidThroughOn: day(12), paidPeriodEnded: false, daysLeft: 12 });
    expect(ent(plan("cancel_requested", { paidThroughOn: day(4) })).maintenance).toMatchObject({ state: "cancelling", daysLeft: null, paidPeriodEnded: false });
  });
});

describe("the setup fee is a separate question", () => {
  it("never changes what the plan entitles, and the plan never changes the fee's answer", () => {
    for (const status of STATUSES) {
      const p = plan(status, { graceEndsAt: new Date(NOW.getTime() + DAY), paidThroughOn: day(5) });
      const paid = ent(p, { setupCleared: true });
      const unpaid = ent(p, { setupCleared: false });
      expect(unpaid.studio, status).toEqual(paid.studio);
      expect(unpaid.managedStorage, status).toBe(paid.managedStorage);
      expect(unpaid.maintenance, status).toEqual(paid.maintenance);
      expect(paid.setupCleared).toBe(true);
      expect(unpaid.setupCleared).toBe(false);
    }
    expect(ent(null, { setupCleared: true }).setupCleared).toBe(true);
    expect(ent(null, { setupCleared: false }).setupCleared).toBe(false);
  });
});

describe("a paid period that ended is information, not a lapse", () => {
  it("keeps an active plan entitled after its paid-through day, and says so, until a person or the automatic switch moves it", () => {
    const ended = ent(plan("active", { paidThroughOn: day(-5) }));
    expect(ended.studio.entitled).toBe(true);
    expect(ended.managedStorage).toBe(true);
    expect(ended.maintenance).toMatchObject({ paidPeriodEnded: true, daysLeft: -5 });
  });

  it("counts the day in the agency's time zone: the same instant is a different day for a different `today`", () => {
    const p = plan("active", { paidThroughOn: day(0) });
    expect(ent(p, { today: day(0) }).maintenance).toMatchObject({ paidPeriodEnded: false, daysLeft: 0 });
    expect(ent(p, { today: day(1) }).maintenance).toMatchObject({ paidPeriodEnded: true, daysLeft: -1 });
    expect(ent(p, { today: day(-1) }).maintenance).toMatchObject({ paidPeriodEnded: false, daysLeft: 1 });
  });

  it("calls a period ended only for a plan that is running or about to be cancelled, and only with a real paid-through day", () => {
    for (const status of STATUSES) {
      const running = status === "active" || status === "cancel_requested";
      expect(ent(plan(status, { paidThroughOn: day(-2) })).maintenance.paidPeriodEnded, status).toBe(running);
      expect(ent(plan(status, { paidThroughOn: null })).maintenance.paidPeriodEnded, `${status} without a day`).toBe(false);
    }
    for (const bad of ["", "yesterday", "2026-13-40", "2026-10-2", "20261021", "2026-10-21T00:00:00Z"]) {
      expect(ent(plan("active", { paidThroughOn: bad })).maintenance, bad).toMatchObject({ paidPeriodEnded: false, daysLeft: null });
    }
  });

  it("does not slow down on a 20,000-character paid-through value", () => {
    const started = Date.now();
    expect(ent(plan("active", { paidThroughOn: "2".repeat(20_000) })).maintenance.daysLeft).toBeNull();
    expect(Date.now() - started).toBeLessThan(200);
  });
});

describe("which plan a workspace is judged by", () => {
  it("prefers its open plan over a newer closed one, and the newest of the open ones", () => {
    const oldOpen = plan("active", { id: "old-open", createdAt: "2026-01-01T00:00:00Z" });
    const newClosed = plan("expired", { id: "new-closed", createdAt: "2026-09-01T00:00:00Z" });
    expect(currentPlanOf([newClosed, oldOpen])?.id).toBe("old-open");
    expect(currentPlanOf([oldOpen, newClosed])?.id).toBe("old-open");
    const newerOpen = plan("past_due", { id: "newer-open", createdAt: "2026-05-01T00:00:00Z" });
    expect(currentPlanOf([oldOpen, newerOpen, newClosed])?.id).toBe("newer-open");
  });

  it("falls back to the most recent closed plan, and to nothing for a workspace with no plan", () => {
    const a = plan("cancelled", { id: "a", createdAt: "2026-01-01T00:00:00Z" });
    const b = plan("expired", { id: "b", createdAt: "2026-06-01T00:00:00Z" });
    expect(currentPlanOf([a, b])?.id).toBe("b");
    expect(currentPlanOf([])).toBeNull();
    expect(ent(currentPlanOf([])).studio.entitled).toBe(false);
  });

  it("treats exactly the open statuses as open", () => {
    for (const status of STATUSES) {
      const open = OPEN_PLAN_STATUSES.includes(status);
      const closedNewer = plan("expired", { id: "closed", createdAt: "2026-10-01T00:00:00Z" });
      const subject = plan(status, { id: "subject", createdAt: "2026-01-01T00:00:00Z" });
      expect(currentPlanOf([closedNewer, subject])?.id, status).toBe(open ? "subject" : "closed");
    }
  });
});
