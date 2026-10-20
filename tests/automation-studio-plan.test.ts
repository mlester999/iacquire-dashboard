// Automation Studio foundation, part 1: the pure plan rules (who is entitled when, the fair-use limits, the premium-feature derivation),
// migration 0069's schema guarantees, and the server-side entitlement decision. Nothing contacts a provider.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import {
  LIMIT_METRIC, OPEN_PLAN_STATUSES, PAYMENT_GRACE_DAYS, STUDIO_DEFAULT_LIMITS, STUDIO_LAPSE_POLICY, STUDIO_METRICS, STUDIO_PLAN_MONTHLY_USD, STUDIO_SETUP_FEE_USD,
  canTransition, currentPlan, entitlementFor, periodMonth, quotaStatus, type PlanStatus,
} from "@/lib/automation-studio/plan";
import { PREMIUM_FEATURES, STEP_KINDS, derivePremiumFeatures, type WorkflowDefinition } from "@/lib/crm/workflow/spec";
import { assertStudioEntitled, needsStudioPlan, studioEntitlement } from "@/server/automation-studio/entitlement";
import { createOrg, createUser, addMember, uid } from "./support/fixtures";

const NOW = new Date("2026-10-21T12:00:00Z");
const plan = (status: PlanStatus, extra: Partial<{ graceEndsAt: string | null; paidThroughOn: string | null }> = {}) => ({ id: "p1", status, graceEndsAt: null, paidThroughOn: null, ...extra });

describe("the plan's prices and defaults", () => {
  it("quotes the approved commercial terms from one place", () => {
    expect(STUDIO_PLAN_MONTHLY_USD).toBe(299);
    expect(STUDIO_SETUP_FEE_USD).toBe(1499);
    expect(PAYMENT_GRACE_DAYS).toBe(7);
  });

  it("has a finite default for every limit and a counter for every monthly one: there is no unlimited allowance", () => {
    for (const [key, value] of Object.entries(STUDIO_DEFAULT_LIMITS)) {
      expect(Number.isInteger(value) && value > 0, key).toBe(true);
    }
    for (const [limit, metric] of Object.entries(LIMIT_METRIC)) expect(STUDIO_METRICS, limit).toContain(metric);
  });
});

describe("entitlementFor", () => {
  it("is not entitled without a plan, and says why in words", () => {
    const e = entitlementFor(null, NOW);
    expect(e).toMatchObject({ entitled: false, state: "none", subscriptionId: null });
    expect(e.reason).toMatch(/optional Managed Maintenance \+ Automation Studio plan/);
  });

  it.each([
    ["active", true, "active"],
    ["cancel_requested", true, "cancelling"],
    ["requested", false, "pending"],
    ["cancelled", false, "cancelled"],
    ["declined", false, "declined"],
    ["expired", false, "expired"],
  ] as const)("a plan that is %s is entitled=%s (%s)", (status, entitled, state) => {
    expect(entitlementFor(plan(status), NOW)).toMatchObject({ entitled, state });
  });

  it("keeps a past-due plan entitled until its grace period ends, to the instant, with no help from the sweeper", () => {
    const grace = new Date(NOW.getTime() + 3 * 86_400_000);
    const p = plan("past_due", { graceEndsAt: grace.toISOString() });
    expect(entitlementFor(p, NOW)).toMatchObject({ entitled: true, state: "past_due", graceEndsAt: grace.toISOString() });
    expect(entitlementFor(p, new Date(grace.getTime() - 1))).toMatchObject({ entitled: true });
    expect(entitlementFor(p, grace)).toMatchObject({ entitled: false, state: "past_due" });
    expect(entitlementFor(p, new Date(grace.getTime() + 86_400_000)).reason).toMatch(/grace period has ended/);
  });

  it("treats a past-due plan without a recorded grace period as lapsed, never as open-ended", () => {
    expect(entitlementFor(plan("past_due"), NOW).entitled).toBe(false);
  });

  it("describes a lapse without promising anything the engine doesn't do", () => {
    const text = Object.values(STUDIO_LAPSE_POLICY).join(" ");
    expect(text).toMatch(/paused/);
    expect(text).toMatch(/AI employees/);
    expect(text).not.toMatch(/deleted after|removed after|permanently/i);
  });
});

describe("currentPlan", () => {
  const row = (id: string, status: PlanStatus, createdAt: string) => ({ id, status, graceEndsAt: null, createdAt });
  it("prefers the open plan over a newer finished one, and the newest among the rest", () => {
    expect(currentPlan([row("old", "active", "2026-01-01"), row("new", "cancelled", "2026-06-01")])?.id).toBe("old");
    expect(currentPlan([row("a", "cancelled", "2026-01-01"), row("b", "expired", "2026-06-01")])?.id).toBe("b");
    expect(currentPlan([])).toBeNull();
  });
  it("lists the statuses the database allows one of per workspace", () => {
    expect([...OPEN_PLAN_STATUSES].sort()).toEqual(["active", "cancel_requested", "past_due", "requested"]);
  });
});

describe("lifecycle transitions", () => {
  it("allows only the moves an agency member can verify", () => {
    expect(canTransition("active", "payment_failed")).toBe(true);
    expect(canTransition("past_due", "payment_failed")).toBe(false);
    expect(canTransition("requested", "payment_failed")).toBe(false);
    expect(canTransition("expired", "payment_verified")).toBe(true);
    expect(canTransition("cancelled", "payment_verified")).toBe(false);
    expect(canTransition("declined", "expire")).toBe(false);
    expect(canTransition("past_due", "expire")).toBe(true);
  });
});

describe("quotaStatus and periodMonth", () => {
  it("warns at the threshold and is exceeded at the limit", () => {
    expect(quotaStatus(0, 100, 80)).toMatchObject({ state: "ok", percent: 0, remaining: 100 });
    expect(quotaStatus(79, 100, 80).state).toBe("ok");
    expect(quotaStatus(80, 100, 80)).toMatchObject({ state: "warning", percent: 80 });
    expect(quotaStatus(100, 100, 80)).toMatchObject({ state: "exceeded", remaining: 0 });
    expect(quotaStatus(250, 100, 80)).toMatchObject({ state: "exceeded", percent: 100 });
  });
  it("treats a zero limit as already reached", () => {
    expect(quotaStatus(0, 0).state).toBe("exceeded");
  });
  it("keys a month by its first day in UTC", () => {
    expect(periodMonth(new Date("2026-10-31T23:59:59Z"))).toBe("2026-10-01");
    expect(periodMonth(new Date("2026-11-01T00:00:00Z"))).toBe("2026-11-01");
  });
});

describe("derivePremiumFeatures", () => {
  const def = (kinds: string[]): Pick<WorkflowDefinition, "steps"> => ({ steps: kinds.map((kind, i) => ({ key: `s${i}`, kind, config: {}, next: null })) as WorkflowDefinition["steps"] });

  it("needs no plan for anything built in the CRM screens, whatever its steps", () => {
    expect(derivePremiumFeatures(def(Object.keys(STEP_KINDS)), "crm")).toEqual([]);
    expect(derivePremiumFeatures(def([]), "crm")).toEqual([]);
  });

  it("marks a workflow built in Automation Studio", () => {
    expect(derivePremiumFeatures(def(["add_tag"]), "studio")).toEqual(["studio_workflow"]);
  });

  it("picks up a step kind that only the plan includes, in a fixed order, once", () => {
    const specs = { ...STEP_KINDS, add_tag: { ...STEP_KINDS.add_tag, premium: "studio_workflow" as const } };
    expect(derivePremiumFeatures(def(["wait", "add_tag", "add_tag"]), "crm", specs)).toEqual(["studio_workflow"]);
    expect(derivePremiumFeatures(def(["wait"]), "crm", specs)).toEqual([]);
    expect(PREMIUM_FEATURES).toContain("studio_workflow");
  });

  it("copes with a draft that is half-finished", () => {
    expect(derivePremiumFeatures({ steps: undefined as never }, "crm")).toEqual([]);
    expect(needsStudioPlan(["studio_workflow"])).toBe(true);
    expect(needsStudioPlan([])).toBe(false);
    expect(needsStudioPlan(null)).toBe(false);
  });
});

async function orgWithPlan(status: PlanStatus | null, extra: { graceEndsAt?: Date; paidThroughOn?: string } = {}) {
  const org = await createOrg({ name: `Plan ${uid()}` });
  const owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  if (status) {
    await withSystem((db) =>
      db.query(
        `insert into maintenance_subscriptions (org_id, status, monthly_price_cents, monthly_request_allowance, terms_version, accepted_by, activated_at, billing_start_on, past_due_since, grace_ends_at, expired_at, paid_through_on)
         values ($1, $2, 29900, 4, 'test', $3, $4, $5, $6, $7, $8, $9)`,
        [
          org.id, status, owner.id, ["requested", "declined"].includes(status) ? null : "2026-09-01T00:00:00Z", ["requested", "declined"].includes(status) ? null : "2026-09-01",
          status === "past_due" ? "2026-10-20T00:00:00Z" : null, status === "past_due" ? (extra.graceEndsAt ?? new Date(NOW.getTime() + 86_400_000)).toISOString() : null,
          status === "expired" ? "2026-10-01T00:00:00Z" : null, extra.paidThroughOn ?? null,
        ],
      ),
    );
  }
  return org;
}

describe("migration 0069: the schema guarantees", () => {
  it("accepts the new plan states and refuses anything else", async () => {
    const org = await orgWithPlan("active");
    const owner = (await withSystem((db) => db.query<{ id: string }>("select user_id as id from organization_memberships where org_id = $1", [org.id]))).rows[0].id;
    await expect(withSystem((db) => db.query("update maintenance_subscriptions set status = 'paused' where org_id = $1", [org.id]))).rejects.toThrow(/status_check|violates check/);
    // past_due must say when it started and when its grace ends.
    await expect(withSystem((db) => db.query("update maintenance_subscriptions set status = 'past_due' where org_id = $1", [org.id]))).rejects.toThrow(/grace_check|violates check/);
    // A plan that was never activated can't be past due or expired.
    const fresh = await createOrg({ name: `x ${uid()}` });
    await expect(
      withSystem((db) =>
        db.query("insert into maintenance_subscriptions (org_id, status, monthly_price_cents, monthly_request_allowance, terms_version, accepted_by) values ($1, 'expired', 29900, 4, 't', $2)", [fresh.id, owner]),
      ),
    ).rejects.toThrow(/lifecycle_check|violates check/);
  });

  it("still allows only one open plan per workspace, past due included", async () => {
    const org = await orgWithPlan("past_due");
    const owner = (await withSystem((db) => db.query<{ id: string }>("select user_id as id from organization_memberships where org_id = $1", [org.id]))).rows[0].id;
    await expect(
      withSystem((db) => db.query("insert into maintenance_subscriptions (org_id, status, monthly_price_cents, monthly_request_allowance, terms_version, accepted_by) values ($1, 'requested', 29900, 4, 't', $2)", [org.id, owner])),
    ).rejects.toThrow(/maintenance_one_open_plan|duplicate key/);
  });

  it("gives every workflow an origin of crm, so nothing that already existed becomes premium", async () => {
    const org = await createOrg({ name: `Origin ${uid()}` });
    const { rows } = await withSystem((db) =>
      db.query<{ origin: string; entitlement_paused_at: Date | null }>(
        "insert into crm_workflows (org_id, key, name, draft) values ($1, $2, 'Old workflow', '{}'::jsonb) returning origin, entitlement_paused_at",
        [org.id, `old-${uid()}`],
      ),
    );
    expect(rows[0]).toMatchObject({ origin: "crm", entitlement_paused_at: null });
    await expect(withSystem((db) => db.query("update crm_workflows set origin = 'elsewhere' where org_id = $1", [org.id]))).rejects.toThrow(/origin_check|violates check/);
    // The plan-pause marker only makes sense on a paused workflow.
    await expect(withSystem((db) => db.query("update crm_workflows set entitlement_paused_at = now() where org_id = $1", [org.id]))).rejects.toThrow(/entitlement_pause_check|violates check/);
  });

  it("freezes a version's premium features with the version", async () => {
    const org = await createOrg({ name: `Frozen ${uid()}` });
    const w = (await withSystem((db) => db.query<{ id: string }>("insert into crm_workflows (org_id, key, name, draft) values ($1, $2, 'W', '{}'::jsonb) returning id", [org.id, `w-${uid()}`]))).rows[0].id;
    const hash = "a".repeat(64);
    const v = (await withSystem((db) =>
      db.query<{ id: string; premium_features: string[] }>(
        "insert into crm_workflow_versions (org_id, workflow_id, version, trigger_config, steps, content_hash, premium_features) values ($1, $2, 1, '{\"type\":\"contact.created\"}', '[]', $3, '{studio_workflow}') returning id, premium_features",
        [org.id, w, hash],
      ),
    )).rows[0];
    expect(v.premium_features).toEqual(["studio_workflow"]);
    await expect(withSystem((db) => db.query("update crm_workflow_versions set premium_features = '{}' where id = $1", [v.id]))).rejects.toThrow();
  });

  it("keeps usage private to people who can see the workspace's automations", async () => {
    const { rows } = await withSystem((db) =>
      db.query<{ tablename: string; rowsecurity: boolean }>("select c.relname as tablename, c.relrowsecurity as rowsecurity from pg_class c where c.relname in ('automation_studio_usage', 'automation_studio_limits') order by 1"),
    );
    expect(rows).toEqual([{ tablename: "automation_studio_limits", rowsecurity: true }, { tablename: "automation_studio_usage", rowsecurity: true }]);
  });
});

describe("studioEntitlement (server)", () => {
  it("reads the workspace's own plan, and no other", async () => {
    const withPlan = await orgWithPlan("active");
    const without = await orgWithPlan(null);
    expect((await withSystem((db) => studioEntitlement(db, withPlan.id))).entitled).toBe(true);
    expect((await withSystem((db) => studioEntitlement(db, without.id)))).toMatchObject({ entitled: false, state: "none" });
  });

  it("follows each state of the plan, including the end of a grace period", async () => {
    const grace = new Date(Date.now() + 86_400_000);
    const pastDue = await orgWithPlan("past_due", { graceEndsAt: grace });
    expect((await withSystem((db) => studioEntitlement(db, pastDue.id, new Date())))).toMatchObject({ entitled: true, state: "past_due" });
    expect((await withSystem((db) => studioEntitlement(db, pastDue.id, new Date(grace.getTime() + 1000))))).toMatchObject({ entitled: false });
    for (const [status, entitled] of [["cancel_requested", true], ["requested", false], ["expired", false], ["cancelled", false]] as const) {
      const o = await orgWithPlan(status);
      expect((await withSystem((db) => studioEntitlement(db, o.id))).entitled, status).toBe(entitled);
    }
  });

  it("uses the open plan when a finished one exists too", async () => {
    const org = await orgWithPlan("cancelled");
    const owner = (await withSystem((db) => db.query<{ id: string }>("select user_id as id from organization_memberships where org_id = $1", [org.id]))).rows[0].id;
    await withSystem((db) => db.query("insert into maintenance_subscriptions (org_id, status, monthly_price_cents, monthly_request_allowance, terms_version, accepted_by, activated_at, billing_start_on) values ($1, 'active', 29900, 4, 't', $2, now(), current_date)", [org.id, owner]));
    expect((await withSystem((db) => studioEntitlement(db, org.id))).entitled).toBe(true);
  });

  it("refuses with the plan_required code and a sentence the interface can show", async () => {
    const org = await orgWithPlan(null);
    const err = await withSystem((db) => assertStudioEntitled(db, org.id, "Building in Automation Studio")).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: "plan_required", status: 403 });
    expect(err.message).toMatch(/^Building in Automation Studio needs the Managed Maintenance \+ Automation Studio plan\./);
    const ok = await orgWithPlan("active");
    await expect(withSystem((db) => assertStudioEntitled(db, ok.id))).resolves.toMatchObject({ entitled: true });
  });
});
